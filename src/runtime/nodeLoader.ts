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
import { DataRepository, getDataRepository } from '../artifacts'
import { getFs, setContext } from '../execution'
import { isNullHash } from '../build-fs/pointers'

async function findImportMap(dir: string): Promise<ImportMap | undefined> {
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

async function getImportMap(targetPath: string): Promise<ImportMap | undefined> {
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

function findDataRepoSync(dir: string): { dataDir: string; repo: BasicDataRepository; root: DataRepository } | undefined {
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
                if (isNullHash(storeHash)) {
                    return undefined
                }

                const store = JSON.parse(getDataSync(storeHash, 'utf-8'))
                const m = store.type === 'flat' ? store.artifacts[hash] : undefined
        
                return m
            }

            return {
                dataDir: path.resolve(dir, '.synapse', 'data'),
                repo: { getDataSync, getMetadata },
                root: repo,
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
    const found = findDataRepoSync(targetDir)

    const vfsMappings = new Map<string, string>()

    async function _loadIndex(hash: string) {
        try {
            return JSON.parse(found!.repo.getDataSync(hash, 'utf-8'))
        } catch (err) {
            if ((err as any).code !== 'ENOENT') {
                throw err
            }

            const res = await found!.root.getBuildFs(hash)
            return res.index
        }
    }

    async function loadIndex(root: string, hash: string) {
        if (!found) return

        const index = await _loadIndex(hash)
        for (const [k, v] of Object.entries(index.files)) {
            vfsMappings.set(path.join(root, k), (v as any).hash)
        }
    }

    function readFileSync(fileName: string, encoding?: BufferEncoding) {
        const m = vfsMappings.get(fileName)
        if (m === undefined) {
            return fs.readFileSync(fileName, encoding)
        }

        return found!.repo.getDataSync(m, encoding as any) as any
    }

    function fileExistsSync(fileName: string) {
        try {
            fs.accessSync(fileName)
            return true
        } catch(err) {
            if ((err as any).code !== 'ENOENT') {
                return false
            }

            return vfsMappings.has(fileName)
        }
    }

    const resolver = createModuleResolver({
        readFileSync,
        fileExistsSync,
    }, workingDirectory)

    if (importMap) {
        resolver.registerMapping(importMap)

        // XXX: the import map doesn't associate globals with pointers
        const globals: Record<string, string> = {}
        for (const [k, v] of Object.entries(importMap)) {
            if (k.startsWith('synapse:')) {
                globals[k] = v.location
            }
            if (v.source?.type === 'package' && v.source.data.resolved?.isSynapsePackage && v.source.data.resolved.integrity) {
                await loadIndex(v.location, v.source.data.resolved.integrity).catch(err => {
                    throw new Error(`Failed to load index: ${k}`, { cause: err })
                })
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

    const dataDir = found?.dataDir ?? (await findDataDir(targetDir) ?? await findDataDir(workingDirectory) ?? workingDirectory)
    const loader = createModuleLoader({ readFileSync }, dataDir, resolver, { 
        codeCache,
        deserializer: resolveValue,
        dataRepository: found?.repo,
        useThisContext: true,
    })

    return loader()(resolvedPath)
}

