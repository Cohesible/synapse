import * as fs from 'node:fs'
import * as path from 'node:path'
import { createModuleResolver } from './resolver'
import { BasicDataRepository, createModuleLoader } from './loader'
import { createCodeCache } from './utils'
import { getV8CacheDirectory } from '../workspaces'
import { resolveValue } from './modules/serdes'
import { ImportMap, SourceInfo } from './importMaps'
import { throwIfNotFileNotFoundError } from '../utils'
import { openBlock } from '../build-fs/block'
import { homedir } from 'node:os'
import { getDataRepository } from '../artifacts'
import { getFs, setContext } from '../execution'

async function findImportMap(dir: string): Promise<ImportMap<SourceInfo> | undefined> {
    const fileName = path.resolve(dir, 'import-map.json')

    try {
        return JSON.parse(await fs.promises.readFile(fileName, 'utf-8'))
    } catch (e) {
        throwIfNotFileNotFoundError(e)

        const next = path.dirname(dir)
        if (next !== dir) {
            return findImportMap(next)
        }
    }
}

async function findDataDir(dir: string): Promise<string | undefined> {
    const dataDir = path.resolve(dir, '.synapse', 'build', 'data')
    if (await fs.promises.access(dataDir, fs.constants.F_OK).then(() => true, () => false)) {
        return dataDir       
    }

    const next = path.dirname(dir)
    if (next !== dir) {
        return findDataDir(next)
    }
}

async function getImportMap(targetPath: string): Promise<ImportMap<SourceInfo> | undefined> {
    const importMapFilePath = process.env['JS_IMPORT_MAP_FILEPATH']
    if (!importMapFilePath) {
        return findImportMap(path.dirname(targetPath))
    }

    return JSON.parse(await fs.promises.readFile(importMapFilePath, 'utf-8'))
}

function tryReadFile(fileName: string) {
    try {
        return fs.readFileSync(fileName)
    } catch (e) {
        throwIfNotFileNotFoundError(e)
    }
}

const getSynapseInstallDir = () => process.env['SYNAPSE_INSTALL'] || path.resolve(homedir(), '.synapse')
const getGlobalBuildDir = () => path.resolve(getSynapseInstallDir(), 'build')

function findDataRepoSync(dir: string): { dataDir: string; repo: BasicDataRepository } | undefined {
    const fileName = path.resolve(dir, '.synapse', 'snapshot.json')
    const d = tryReadFile(fileName)?.toString('utf-8')
    if (d) {
        const hash = JSON.parse(d).storeHash as string
        const blockFile = path.resolve(dir, '.synapse', 'blocks', hash)
        const b = tryReadFile(blockFile)
        if (b) {
            const block = openBlock(b)

            // XXX: these lines + `_getDataSync` only exist to support loading deployed package deps
            const fs2 = getFs()
            setContext({ id: 'dev', fs: fs2 })
            const repo = getDataRepository(fs2, getGlobalBuildDir())

            function _getDataSync(hash: string) {
                try {
                    return block.readObject(hash)
                } catch (e) {
                    if (!(e as any).message?.includes('Object not found')) {
                        throw e
                    }
                   
                    return Buffer.from(repo.readDataSync(hash))
                }
            }

            function getDataSync(hash: string): Buffer
            function getDataSync(hash: string, encoding: BufferEncoding): string
            function getDataSync(hash: string, encoding?: BufferEncoding) {
                if (!encoding) {
                    return _getDataSync(hash)
                }
                return _getDataSync(hash).toString(encoding)
            }

            function getMetadata(hash: string, storeHash: string) {
                const store = JSON.parse(getDataSync(storeHash, 'utf-8'))
                const m = store.type === 'flat' ? store.artifacts[hash] : undefined
        
                return m
            }

            return {
                dataDir: path.resolve(dir, '.synapse', 'data'),
                repo: { getDataSync, getMetadata },
            }
        } 
    }

    const next = path.dirname(dir)
    if (next !== dir) {
        return findDataRepoSync(next)
    }
}

export async function devLoader(target: string) {
    const workingDirectory = process.cwd()
    const resolvedPath = await fs.promises.realpath(path.resolve(workingDirectory, target))
    const targetDir = path.dirname(resolvedPath)
    const importMap = await getImportMap(targetDir)

    const resolver = createModuleResolver({
        readFileSync: fs.readFileSync,
        fileExistsSync: (fileName: string) => {
            try {
                fs.accessSync(fileName)
                return true
            } catch {
                return false
            }
        }
    }, workingDirectory)

    if (importMap) {
        resolver.registerMapping(importMap)

        // XXX: the import map doesn't associate globals with pointers
        const globals: Record<string, string> = {}
        for (const [k, v] of Object.entries(importMap)) {
            if (k.startsWith('synapse:')) {
                globals[k] = v.location
            }
        }

        resolver.registerGlobals(globals)
    }

    const codeCachePath = getV8CacheDirectory()
    const codeCache = createCodeCache({ 
        readFileSync: fs.readFileSync,
        deleteFileSync: (p) => fs.rmSync(p),
        writeFileSync: (p, data) => {
            try {
                fs.writeFileSync(p, data)
            } catch (e) {
                throwIfNotFileNotFoundError(e)
                fs.mkdirSync(codeCachePath, { recursive: true })
                fs.writeFileSync(p, data)
            }
        },
    }, codeCachePath)

    const found = findDataRepoSync(targetDir)
    const dataDir = found?.dataDir ?? (await findDataDir(targetDir) ?? await findDataDir(workingDirectory) ?? workingDirectory)
    const loader = createModuleLoader(fs, dataDir, resolver, { 
        codeCache,
        deserializer: resolveValue,
        dataRepository: found?.repo,
        useThisContext: true,
    })

    return loader()(resolvedPath)
}

