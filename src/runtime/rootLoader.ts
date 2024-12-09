import * as esbuild from 'esbuild'
import { readFileSync, existsSync } from 'node:fs'
import { DataRepository, getDataRepository } from '../artifacts'
import { getBuildTarget, getFs } from '../execution'
import { Fs, SyncFs } from '../system'
import { getV8CacheDirectory } from '../workspaces'
import { createModuleLoader, BasicDataRepository } from './loader'
import { ModuleResolver, createModuleResolver } from './resolver'
import { createCodeCache } from './utils'
import { setupEsbuild } from '../bundler'

function toBuffer(arr: Uint8Array): Buffer {
    return Buffer.isBuffer(arr) ? arr : Buffer.from(arr)
}

export function createBasicDataRepo(repo: DataRepository): BasicDataRepository {
    function getDataSync(hash: string): Buffer
    function getDataSync(hash: string, encoding: BufferEncoding): string
    function getDataSync(hash: string, encoding?: BufferEncoding) {
        const data = toBuffer(repo.readDataSync(hash))

        return encoding ? data.toString(encoding) : data
    }

    return { getDataSync, getMetadata: repo.getMetadata }
}

export function createModuleResolverForBundling(fs: Fs & SyncFs, workingDirectory: string): ModuleResolver {
    const resolver = createModuleResolver(fs, workingDirectory)

    // Need to patch this file because it's not compatible w/ bundling to ESM
    resolver.registerPatch({
        name: '@aws-crypto/util',
        // version: 3.0.0
        files: {
            'build/convertToBuffer.js': contents => contents.replace('require("@aws-sdk/util-utf8-browser")', '{}')
        }
    })

    return resolver
}

function loadEsbuildWithWorkersDisabled() {
    process.env['ESBUILD_WORKER_THREADS'] = '0'
    setupEsbuild()
    delete process.env['ESBUILD_WORKER_THREADS']
}

function createTypescriptLoader() {
    return (fileName: string, format: 'cjs' | 'esm' = 'cjs') => {
        loadEsbuildWithWorkersDisabled()

        // TODO: add option to configure sourcemap
        // TODO: add transform cache to avoid calls to `esbuild`
        const contents = readFileSync(fileName)
        const res = esbuild.transformSync(contents, { format, loader: 'ts', sourcemap: 'inline' })

        return res.code
    }
}

export function createMinimalLoader(useTsLoader = false) {
    const bt = getBuildTarget()
    const workingDirectory = bt?.workingDirectory ?? process.cwd()
    const codeCache = createCodeCache(getFs(), getV8CacheDirectory())
    const typescriptLoader = useTsLoader ? createTypescriptLoader() : undefined

    const loader = createModuleLoader(
        { readFileSync }, 
        workingDirectory,
        createModuleResolver({ readFileSync, fileExistsSync: existsSync }, workingDirectory, useTsLoader),
        {
            codeCache,
            workingDirectory,
            typescriptLoader,
            dataRepository: bt ? createBasicDataRepo(getDataRepository(getFs(), bt.buildDir)) : undefined,
            useThisContext: true,
        }
    )

    function loadModule(id: string, origin?: string) {
        if (id.endsWith('.mjs')) {
            return loader.loadEsm(id, origin)
        } 

        return loader.loadCjs(id, origin)
    }

    return { loadModule }
}