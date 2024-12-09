import * as path from 'node:path'
import * as vm from 'node:vm'
import { createRequire, isBuiltin, SourceMap, SourceOrigin } from 'node:module'
import { SyncFs } from '../system'
import { findSourceMap, SourceMapV3 } from './sourceMaps'
import { getLogger } from '../logging'
import { ArtifactMetadata, getDataRepository, type Artifact } from '../artifacts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ModuleResolver, ModuleTypeHint } from './resolver'
import { Auth, createAuth, StoredCredentials } from '../auth'
import { getHash, isNonNullable, memoize, throwIfNotFileNotFoundError } from '../utils'
import { CodeCache, Context, copyGlobalThis } from './utils'
import type { resolveValue } from './modules/serdes'
import { applyPointers, coerceToPointer, DataPointer, getNullHash, isDataPointer, isNullHash, toAbsolute } from '../build-fs/pointers'
import { getWorkingDir } from '../workspaces'
import { getFs, getSelfPathOrThrow, isSelfSea } from '../execution'
import { BackendClient } from './modules/core'
import { createNpmLikeCommandRunner } from '../pm/publish'
import { waitForPromise } from '../zig/util'

export const pointerPrefix = 'pointer:'
export const synapsePrefix = 'synapse:'
export const providerPrefix = 'synapse-provider:'
const seaAssetPrefix = 'sea-asset:'

export function createContext(
    bt: { deploymentId?: string; programId: string },
    backendClient: BackendClient,
    auth: Auth,
    console?: typeof globalThis.console
) {
    const contextStorage = new AsyncLocalStorage<Record<string, any>>()

    // XXX: need to embed context in all serialized objects...
    // Right now we silently fail if there is no context
    function getContext(type: string) {
        return contextStorage.getStore()?.[type] ?? [{}]
    }

    const ctx = copyGlobalThis()
    const globals = ctx.globals as any
    globals.__getBackendClient = () => backendClient,
    globals.__getArtifactFs = () => {
        const afs = contextStorage.getStore()?.['afs'][0]
        if (!afs) {
            throw new Error(`No artifact fs found`)
        }
        return afs
    }

    globals.__getContext = () => {
        return { get: getContext }
    }

    globals.__getCredentials = createGetCredentials(auth)
    globals.__runCommand = createNpmLikeCommandRunner(getWorkingDir())
    globals.__buildTarget = bt
    globals.__waitForPromise = waitForPromise

    if (console) {
        globals.console = console
        globals.globalThis.console = console
    } else {
        globals.console = globalThis.console
    }

    // XXX: we should only expose symbols that we use instead of the entire registry
    globals.Symbol = globalThis.Symbol

    globals.Error.stackTraceLimit = 25 // TODO: make configurable

    function runWithNamedContexts<T>(namedContexts: Record<string, any>, fn: () => T): T {
        return contextStorage.run(namedContexts, fn)
    }

    function _registerSourceMapParser(parser: SourceMapParser) {
        registerSourceMapParser(parser, globals.Error)
    }

    return {
        ctx,
        getContext,
        runWithNamedContexts,
        registerSourceMapParser: _registerSourceMapParser,
    }
}

export function createGetCredentials(auth: ReturnType<typeof createAuth>) {
    const credentials = new Map<string, StoredCredentials>()

    async function getCredentials(id?: string) {
        const account = id ? await auth.getAccount(id) : await auth.getActiveAccount()
        if (!account) {
            throw new Error('No such account exists')
        }

        if (credentials.has(account.id)) {
            const creds = credentials.get(account.id)!
            if (creds.expiresAt > Date.now()) {
                return creds
            }

            credentials.delete(account.id) 
        }

        const creds = await auth.getCredentials(account)
        if (!creds) {
            throw new Error('No credentials available')
        }

        credentials.set(account.id, creds)

        return creds
    }

    return getCredentials
}

export interface BasicDataRepository {
    getDataSync(hash: string): Uint8Array
    getDataSync(hash: string, encoding: BufferEncoding): string
    getMetadata(hash: string, source: string): ArtifactMetadata | undefined
    getDiskPath?(fileName: string): string
}

interface ModuleLoaderOptions {
    readonly env?: Record<string, string | undefined>
    readonly codeCache?: CodeCache
    readonly useThisContext?: boolean
    readonly sourceMapParser?: Pick<ReturnType<typeof createSourceMapParser>, 'registerFile' | 'registerDeferredMapping' | 'setAlias'>
    readonly workingDirectory?: string
    readonly deserializer?: typeof resolveValue
    readonly typescriptLoader?: (fileName: string, format?: 'cjs' | 'esm') => string
    readonly dataRepository?: BasicDataRepository

    // Only tests are dependent on this
    readonly registerPointerDependencies?: (pointer: DataPointer) => Promise<any> | any
}

function createDefaultDataRepo(fs: Pick<SyncFs, 'readFileSync'>, dataDir: string): BasicDataRepository {
    function getObjectPath(dataDir: string, hash: string) {
        if (hash.startsWith(pointerPrefix)) {
            hash = hash.slice(pointerPrefix.length)
        }

        const prefix = `${hash[0]}${hash[1]}/${hash[2]}${hash[3]}/${hash.slice(4)}`
    
        return path.resolve(dataDir, prefix)
    }
    
    function getDataSync(hash: string): Uint8Array
    function getDataSync(hash: string, encoding: BufferEncoding): string
    function getDataSync(hash: string, encoding?: BufferEncoding) {
        if (encoding) {
            return fs.readFileSync(getObjectPath(dataDir, hash), encoding)
        }
        return fs.readFileSync(getObjectPath(dataDir, hash))
    }

    function getMetadata(hash: string, storeHash: string) {
        const store = JSON.parse(getDataSync(storeHash, 'utf-8'))
        const m = store.type === 'flat' ? store.artifacts[hash] : undefined

        return m
    }

    return { getDataSync, getMetadata }
}

export function hydratePointers(repo: BasicDataRepository, id: DataPointer) {
    const { hash, storeHash } = id.resolve()
    const data = repo.getDataSync(hash, 'utf-8')
    if (storeHash === getNullHash()) {
        return data
    }

    const m = repo.getMetadata(hash, storeHash)
    if (!m?.pointers) {
        return data
    }

    return applyPointers(JSON.parse(data), m.pointers)
}

const esmErrors = [
    "Cannot use import statement outside a module",
    "Unexpected token 'export'",
    "Cannot use 'import.meta' outside a module",
    // This one has to be at the top-level of course
    'await is only valid in async functions and the top level bodies of modules',
]

const esbuildEsmErrors = [
    'Top-level await is currently not supported with the "cjs" output format'
]

declare module "node:vm" {
    interface SourceTextModule {
        createCachedData(): Buffer
    }
}

const tscHelperLengths: Record<string, [number, number?]> = {
    __createBinding: [454],
    __exportStar: [183],
    __generator: [1804],
    __awaiter: [664],
    __spreadArray: [360],
    __read: [476],

}

const useStrict = '"use strict";'
const tscHint = '.defineProperty(exports, "__esModule", { value: true });'


function parseTscHeader(text: string) {
    let pos = 0
    if (text.startsWith(useStrict)) {
        pos += useStrict.length
    }

    // note that the module could be using `tslib` for `__exportStar`
    let hasExportStar = false
    let maybeHasTslib = true
    let preambleStart: number | undefined
    let preambleEnd: number | undefined

    const len = text.length
    while (pos < len) {
        if (text[pos] === 'v' && text[pos+1] === 'a' && text[pos+2] === 'r' && text[pos+3] === ' ') {
            const current = text.slice(pos+4)
            const m = current.match(/^([^\s=]+)(\s*)=/)
            if (!m) break // bad parse

            const name = m[1]
            if (name === '__exportStar') {
                hasExportStar = true
            }

            // no whitespace = probably minified
            const isProbablyMinified = !m[2]

            const offset = tscHelperLengths[name]?.[0]
            if (offset) {
                const ws = isProbablyMinified ? 0 : 1
                const varLen = 4
                pos += varLen + m[0].length + ws + offset
                maybeHasTslib = false
                continue
            }
        }

        if (text[pos] === 'O' && text[pos+1] === 'b' && text[pos+2] === 'j' && text[pos+3] === 'e' && text[pos+4] === 'c' && text[pos+5] === 't') {
            const current = text.slice(pos+6)
            if (current.startsWith(tscHint)) {
                preambleStart = pos+6+tscHint.length
                const maybeEnd = current.slice(tscHint.length).indexOf(';')
                if (maybeEnd === -1) break // bad parse
                preambleEnd = maybeEnd + preambleStart
                pos = preambleEnd + 1
                break
            } 
        }

        pos += 1
    }

    if (!preambleStart || !preambleEnd) {
        return
    }

    const matches = text.slice(preambleStart, preambleEnd).matchAll(/exports\.([^\s\.]+)\s*=\s*/g)
    const exports = [...matches].map(m => m[1])

    if (maybeHasTslib) {
        const rem = text.slice(preambleEnd+2)
        if (rem.startsWith('const tslib_1')) {
            hasExportStar = true
        }
    }

    if (hasExportStar) {
        const rem = text.slice(preambleEnd+1)
        //const end = rem.lastIndexOf('exports.')
        //if (end === -1) return // bad parse

        const reexportsMatches = rem.matchAll(/__exportStar\(require\("(.+)"\),\s*exports\);/g)
        const reexports = [...reexportsMatches].map(m => m[1])

        return { exports, reexports }
    }

    return { exports, reexports: [] }
}

// TODO: handle cases where whitespace is minified
const esbuildHintStart = '0 && (module.exports = {'

function parseCjsExports(text: string) {
    // `tsc` can emit this near the top of the file
    const parsedTscHints = parseTscHeader(text)
    if (parsedTscHints) {
        return parsedTscHints
    }

    // `esbuild` hint annotation at the bottom
    // 0 && (module.exports = { 
    //   foo,
    //   bar
    // });

    const lastSemicolon = text.lastIndexOf(';')
    const secondToLastSemicolon = lastSemicolon !== -1 ? text.slice(0, lastSemicolon).lastIndexOf(';') : undefined
    const lastSemicolonParen = secondToLastSemicolon ? text.slice(secondToLastSemicolon + 1).lastIndexOf('});') + secondToLastSemicolon + 1 : -1

    if (lastSemicolonParen !== -1) {
        const matchingBrace = text.lastIndexOf('{')
        if (matchingBrace !== -1) {
            const s = text.slice(matchingBrace - esbuildHintStart.length + 1, matchingBrace + 1)
            if (s === esbuildHintStart) {
                const lines = text.slice(matchingBrace + 1, lastSemicolonParen).split('\n')
                const exports = lines.map(l => l.trim()).map(l => l.endsWith(',') ? l.slice(0, -1) : l).filter(l => !!l)
                // FIXME: this only handles shorthand assignments
                return {
                    exports,
                    reexports: [],
                }
            }
        }
    }
}

function isPromise<T>(obj: T | Promise<T>): obj is Promise<T> {
    return obj instanceof Promise || (typeof obj === 'object' && !!obj && 'then' in obj)
}

function normalizeNodeSpecifier(spec: string) {
    return spec.startsWith('node:') ? spec : `node:${spec}`
}

export interface CjsModule {
    exports: any
    evaluated?: boolean
    paths?: string[]
    evaluate: () => any
    script?: vm.Script
}

export interface Module {
    // Three identifiers might seem excessive, but it's necessary
    readonly id: string          // Virtual location, identifies the code within a graph
    readonly name: string        // This is what the user sees
    readonly fileName?: string   // Physical location, identifies the code itself

    readonly typeHint?: ModuleTypeHint

    cjs?: CjsModule
    esm?: Promise<vm.Module> | vm.Module
}

interface Loader {
    createCjs: (module: Module, opt?: ModuleCreateOptions) => CjsModule
    createEsm: (module: Module, opt?: ModuleCreateOptions) => Promise<vm.Module> | vm.Module
}

export interface ModuleCreateOptions {
    readonly context?: Context
    readonly initializeImportMeta?: (meta: ImportMeta, vmModule: vm.SourceTextModule) => void
    readonly importModuleDynamically?: (specifier: string, script: vm.Script | vm.Module, importAttributes: ImportAttributes) => Promise<vm.Module> | vm.Module
}

export type ModuleLinker = ReturnType<typeof createModuleLinker>
export function createModuleLinker(fs: Pick<SyncFs, 'readFileSync'>, resolver: ModuleResolver, loader: Loader, ctx?: Context) {
    const modules: Record<string, Module> = {}
    const invertedMap = new Map<vm.Module | vm.Script, Module>()

    const linkedModules: Record<string, vm.Module | Promise<vm.Module>> = {}
    const evaluatingModules = new Map<vm.Module, Promise<vm.Module>>()
    const moduleDeps = new Map<vm.Module, vm.Module[]>()

    const parseCache = new Map<string, Set<string>>()

    const isSea = isSelfSea()

    function resolveExports(fileName: string, virtualId: string): Iterable<string> {
        if (parseCache.has(virtualId)) {
            return parseCache.get(virtualId)!
        }

        const keys = new Set<string>([])
        parseCache.set(virtualId, keys)

        const text = fs.readFileSync(fileName, 'utf-8')
        const parsed = parseCjsExports(text)
        if (!parsed) {
            return keys
        }

        for (const name of parsed.exports) {
            keys.add(name)
        }

        for (const spec of parsed.reexports) {
            const virtualSpecifier = resolver.resolveVirtual(spec, virtualId)
            const fileName = resolver.getFilePath(virtualSpecifier)
            const resolved = resolveExports(fileName, virtualSpecifier)
            for (const n of resolved) {
                keys.add(n)
            }
        }

        return keys
    }

    function moduleLinker(spec: string, referencingModule: vm.Module, extra: { attributes: Partial<ImportAttributes> }) {
        const importer = getModuleFromVmObject(referencingModule)
        const module = getModule(importer.id, spec)
        const m = getEsmFromModule(module, extra.attributes)

        let arr = moduleDeps.get(referencingModule)
        if (!arr) {
            arr = []
            moduleDeps.set(referencingModule, arr)
        }

        if (isPromise(m)) {
            m.then(m => { arr.push(m) })
        } else {
            arr.push(m)
        }

        return m 
    }

    function linkModule(module: vm.Module) {
        if (module.status !== 'unlinked') {
            if (module.status === 'linking') {
                return linkedModules[module.identifier]
            }
            return module
        }

        return linkedModules[module.identifier] = module.link(moduleLinker).then(() => module)
    }

    function evaluateLinked(m: vm.Module) {
        if (evaluatingModules.has(m)) {
            return evaluatingModules.get(m)!
        }

        // We have to pre-emptively call `evaluate` on all SourceTextModule deps
        const promises: Promise<vm.Module>[] = []
        const deps = moduleDeps.get(m)
        if (deps) {
            for (const d of deps) {
                if (!(d instanceof vm.SourceTextModule)) continue
                const p = evaluateModule(d)
                if (isPromise(p)) {
                    promises.push(p)
                }
            }
        }

        if (promises.length > 0) {
            const p = Promise.all(promises)
                .then(() => evaluateModule(m))
                .finally(() => evaluatingModules.delete(m))
            evaluatingModules.set(m, p)

            return p
        }

        const p = evaluateModule(m)
        if (isPromise(p)) {
            const p2 = p.finally(() => evaluatingModules.delete(m))
            evaluatingModules.set(m, p2)

            return p2
        }

        return p
    }

    function evaluateEsm(m: vm.Module): Promise<vm.Module> | vm.Module {
        const linked = linkModule(m)
        if (isPromise(linked)) {
            return linked.then(evaluateLinked)
        }

        return evaluateLinked(linked)
    }

    function esmToCjs(esm: vm.Module | Promise<vm.Module>) {
        let didSetExports = false
        const cjs: CjsModule = {
            exports: {},
            paths: [],
            evaluate: () => {
                if (cjs.evaluated) {
                    return cjs.exports
                }

                cjs.evaluated = true
                const linked = waitForPromise(isPromise(esm) ? esm.then(linkModule) : linkModule(esm))
                setExports(linked)
                waitForPromise(evaluateLinked(linked))

                return cjs.exports
            },
        }

        function setExports(esm: vm.Module) {
            if (didSetExports) return

            didSetExports = true

            const names = Object.getOwnPropertyNames(esm.namespace)
            for (const k of names) {
                Object.defineProperty(cjs.exports, k, {
                    get: () => (esm.namespace as any)[k],
                    enumerable: true,         
                })
            }
            
            if (!names.includes('__esModule')) {
                Object.defineProperty(cjs.exports, '__esModule', {
                    value: true,
                    enumerable: true,
                })
            }    
        }

        if (!isPromise(esm) && (esm.status === 'linked' || esm.status === 'evaluated' || esm.status === 'evaluating')) {
            setExports(esm)
        }

        return cjs
    }

    // cjs to esm is slow because you need to know named bindings prior
    // to execution (i.e. linking). If the module is guaranteed not to
    // depend on any es modules then it's safe to simply execute it
    // and inspect the exports to determine named bindings (if any).
    // Otherwise, we have to determine the bindings via parsing.

    function cjsToEsm(module: Module, cjs: CjsModule) {
        if (module.typeHint === 'builtin') {
            const exports = cjs.evaluate()

            return new vm.SyntheticModule([...Object.keys(exports), 'default'], function () {
                this.setExport('default', exports.default ?? exports)
                for (const [k, v] of Object.entries(exports)) {
                    this.setExport(k, v)
                }
            }, { identifier: module.name, context: ctx?.vm })
        }

        const fileName = module.fileName
        if (!fileName) {
            throw new Error(`Module is missing filename: ${module.id}`)
        }

        const keys = [...resolveExports(fileName, module.id)]
        const useDefault = keys.length === 0
        const hasDefault = !useDefault && keys.includes('default')
        if (!hasDefault) {
            keys.push('default')
        }

        const m = new vm.SyntheticModule(keys, function () {
            const exports = cjs.evaluate()
            if (useDefault) {
                return this.setExport('default', exports)
            }
    
            const isObject = typeof exports === 'object' && !!exports
            if (!isObject) {
                throw new Error(`CJS module "${fileName}" did not export an object`)
            }

            for (const k of keys) {
                if (k !== 'default') {
                    this.setExport(k, exports[k])
                    continue
                }

                if (k in exports) {
                    this.setExport(k, exports[k])
                } else {
                    this.setExport(k, exports)
                }
            }
        }, { identifier: fileName, context: ctx?.vm })

        return m
    }

    function getTypeHint(spec: string, fileName: string): ModuleTypeHint | undefined {
        if (isDataPointer(fileName)) {
            return 'pointer'
        }

        switch (path.extname(fileName)) {
            case '.mjs':
            case '.mts':
                return 'esm'
            case '.cjs':
            case '.cts':
                return 'cjs'
            case '.json':
                return 'json'
            case '.node':
                return 'native'
            case '.wasm':
                return 'wasm'
        }

        if (spec.startsWith(pointerPrefix)) {
            return 'pointer'
        }
    }

    function getModule(importer: string, spec: string): Module {
        if (isBuiltin(spec)) {
            spec = normalizeNodeSpecifier(spec)
            if (modules[spec]) {
                return modules[spec]
            }

            return modules[spec] = {
                id: spec,
                name: spec,
                typeHint: 'builtin',
            }
        }

        if (isSea && spec.startsWith(seaAssetPrefix)) {
            if (modules[spec]) {
                return modules[spec]
            }

            return modules[spec] = {
                id: spec,
                name: spec,
                typeHint: 'sea-asset',
            }
        }

        const resolved = resolver.resolveVirtualWithHint(spec, importer)
        const hasTypeHint = typeof resolved !== 'string'
        const id = hasTypeHint ? resolved[0] : resolved
        const fileName = resolver.getFilePath(id)
        if (modules[id]) {
            return modules[id]
        }

        const typeHint = !hasTypeHint ? getTypeHint(spec, fileName) : resolved[1]

        return modules[id] = {
            id,
            name: spec, // XXX: spec as name is not right
            fileName,
            typeHint,
        }
    }

    function createCjs(module: Module) {
        const cjs = loader.createCjs(module, {
            context: ctx,
            importModuleDynamically,
        })

        if (cjs.script) {
            invertedMap.set(cjs.script, module)
        }

        return cjs
    }

    function createEsm(module: Module) {
        const esm = loader.createEsm(module, {
            context: ctx,
            initializeImportMeta,
            importModuleDynamically,
        })

        if (isPromise(esm)) {
            return esm.then(m => {
                invertedMap.set(m, module)
                return m
            })
        }

        invertedMap.set(esm, module)
        return esm
    }

    function getCjsFromModule(module: Module) {
        if (module.cjs) {
            return module.cjs
        }

        if (module.typeHint === 'esm' && !module.esm) {
            module.esm = createEsm(module)
        }

        if (module.esm) {
            return module.cjs = esmToCjs(module.esm)
        }

        try {
            return module.cjs = createCjs(module)
        } catch (e) {
            if (!(e instanceof ESMError)) {
                throw e
            }

            module.esm = createEsm(module)
            return module.cjs = esmToCjs(module.esm)
        }
    }

    function getCjs(importer: string, spec: string) {
        const module = getModule(importer, spec)

        return getCjsFromModule(module)
    }

    function getEsm(importer: string, spec: string, attr?: Record<string, string | undefined>) {
        const module = getModule(importer, spec)

        return getEsmFromModule(module, attr)
    }

    function createEsmFromModule(module: Module): Promise<vm.Module> | vm.Module {
        if (module.typeHint === 'builtin') {
            module.cjs = createCjs(module)
            const exports = module.cjs.evaluate()

            return new vm.SyntheticModule([...Object.keys(exports), 'default'], function () {
                this.setExport('default', exports.default ?? exports)
                for (const [k, v] of Object.entries(exports)) {
                    this.setExport(k, v)
                }
            }, { identifier: module.name, context: ctx?.vm })
        }

        if (module.typeHint === 'pointer') {
            return createEsm(module)
        }

        if (!module.fileName) {
            throw new Error(`Only built-in modules can be missing a filename`)
        }

        const fileName = module.fileName
        const extname = path.extname(fileName)
        switch (extname) {
            case '.json':
            case '.node':
            case '.cjs': {
                module.cjs = createCjs(module)

                return cjsToEsm(module, module.cjs)
            }
        }

        return createEsm(module)
    }

    function getEsmFromModule(module: Module, attr?: Record<string, string | undefined>): Promise<vm.Module> | vm.Module {
        if (module.esm) {
            return module.esm
        }

        if (module.typeHint === 'cjs' && !module.cjs) {
            // XXX: FIXME: we shouldn't need to do this
            // it'd be more efficient to determine the module type via the importing pkg
            try {
                module.cjs = createCjs(module)
            } catch (e) {
                if (!(e instanceof ESMError)) {
                    throw e
                }
            }
        }

        if (module.cjs) {
            if (module.cjs.evaluated && !parseCache.has(module.id)) {
                // We can skip parsing by inspecting the exports directly
                const keys = typeof module.cjs.exports === 'object' && !!module.cjs.exports // && cjsModule.exports['__esModule']
                    ? Object.getOwnPropertyNames(module.cjs.exports)
                    : []

                parseCache.set(module.id, new Set(keys))
            }

            return module.esm = cjsToEsm(module, module.cjs)
        }

        return module.esm = createEsmFromModule(module)
    }

    function importModule(importer: string, spec: string, attr?: Record<string, string | undefined>): Promise<vm.Module> | vm.Module {
        const module = getModule(importer, spec)
        const esm = isPromise(module) ? module.then(m => getEsmFromModule(m, attr)) : getEsmFromModule(module, attr)
        const linked = isPromise(esm) ? esm.then(m => linkModule(m)) : linkModule(esm)

        return isPromise(linked) ? linked.then(evaluateEsm) : evaluateEsm(linked)
    }

    function importModuleDynamically(spec: string, referrer: vm.Script | vm.Module, attr: Partial<ImportAttributes>): Promise<vm.Module> | vm.Module {
        const module = getModuleFromVmObject(referrer)

        return importModule(module.id, spec, attr)
    }  
    
    function getModuleFromVmObject(obj: vm.Module | vm.Script) {
        const m = invertedMap.get(obj)
        if (!m) {
            const ident = obj instanceof vm.Module ? obj.identifier : `[Script]`
            throw new Error(`Missing module: ${ident}`)
        }
        return m
    }

    function initializeImportMeta(meta: ImportMeta, vmModule: vm.SourceTextModule): void {
        const module = getModuleFromVmObject(vmModule)
        const fileName = module.fileName!
        meta.filename = fileName
        meta.dirname = path.dirname(fileName)
        meta.url = `file://${fileName}` // probably not valid on Windows
        meta.resolve = (spec) => `file://${resolver.resolve(spec, module.id)}`

        // https://github.com/oven-sh/bun/issues/4667
        ;(meta as any).env = process.env

        // Needed for synthesis
        ;(meta as any).__virtualId = module.id
    }

    function deleteCacheEntry(importer: string, spec: string) {
        if (isBuiltin(spec)) {
            return
        }

        const resolved = resolver.resolveVirtual(spec, importer)
        const fileName = resolver.getFilePath(resolved)

        return delete modules[fileName]
    }

    function getModuleFromLocation(location: string) {
        return modules[location]
    }

    return {
        getModuleFromLocation,
        deleteCacheEntry,
        getModule,
        getEsm,
        getCjs,
        linkModule,

        evaluateEsm,
    }
}

function evaluateModule(module: vm.Module) {
    if (module.status === 'evaluated' || module.status === 'evaluating') {
        return module
    } else if (module.status === 'linked') {
        return module.evaluate().then(() => module)
    } else if (module.status === 'errored') {
        throw module.error
    } else {
        throw new Error(`Bad module state: ${module.status}`)
    }
}

function readSeaAsset(hash: string) {
    const sea = require('node:sea') as typeof import('node:sea')
    const data = sea.getRawAsset(hash)
    if (typeof data === 'string') {
        return data
    }

    return Buffer.from(data).toString()
}

export function createModuleLoader(
    fs: Pick<SyncFs, 'readFileSync'>, 
    dataDir: string,
    resolver: ModuleResolver,
    options: ModuleLoaderOptions = {}
) {
    const {
        env,
        codeCache, 
        sourceMapParser,
        deserializer,
        workingDirectory = process.cwd(),
        dataRepository = createDefaultDataRepo(fs, dataDir),
        useThisContext = false,
    } = options

    const getDefaultContext = memoize(() => useThisContext ? undefined : copyGlobalThis())
    const isSea = isSelfSea()

    if (useThisContext && typeof WebAssembly === 'undefined') {
        const ctx = vm.createContext()
        const globals = vm.runInContext('this', ctx)
        globalThis.global.WebAssembly = globals.WebAssembly
    }

    if (useThisContext && sourceMapParser) {
        registerSourceMapParser(sourceMapParser as SourceMapParser, globalThis.Error)
    }

    const getPointerData = (pointer: DataPointer) => {
        const data = hydratePointers(dataRepository, pointer)

        // XXX: pretty hacky, would break on code that starts with a block
        if (typeof data === 'string' && data[0] !== '{') {
            getLogger().debug(`Treating module "${pointer.hash}" as text`)

            return data
        }

        const artifact = (typeof data === 'string' ? JSON.parse(data) : data) as Artifact
        switch (artifact.kind) {
            case 'compiled-chunk':
                return Buffer.from(artifact.runtime, 'base64').toString('utf-8')

            case 'deployed':
                if (artifact.rendered) {
                    return Buffer.from(artifact.rendered, 'base64').toString('utf-8')
                }
    
                return artifact

            case 'native-module':
                return [
                    Buffer.from(artifact.binding, 'base64').toString('utf-8'),
                    path.resolve(workingDirectory, artifact.bindingLocation)
                ] as const
        }

        throw new Error(`Unknown artifact kind: ${(artifact as any).kind}`)
    }

    const loadPointerData = (artifact: any, importer: string, ctx?: Context, linker = getLinker(ctx)) => {
        if (!deserializer) {
            throw new Error(`Missing deserializer`)
        }

        return deserializer(artifact.captured, { 
            loadModule: _createRequire(importer, ctx, linker),
        }, artifact.table, ctx?.globals)
    }

    const nodeCreateRequire = createRequire
    const dummyEntrypoint = path.resolve(workingDirectory, '#bootstrap.js')
    const defaultRequire = nodeCreateRequire(dummyEntrypoint)

    function requireNodeModule(id: string, require: NodeRequire = defaultRequire) {
        switch (id) {
            case 'node:os':
                return wrapOs(require(id))
            case 'node:path':
                return wrapPath(require(id))
            case 'node:fs/promises':
                return wrapFsPromises(require(id), dataRepository)
            case 'node:child_process':
                return wrapChildProcess(require(id))
        }

        return require(id)
    }

    function createEsm(m: Module, opt?: ModuleCreateOptions) {
        let data: string

        const specifier = m.name
        const ctx = opt?.context ?? getDefaultContext()
        if (m.typeHint === 'pointer') {
            const pointer = coerceToPointer(!isDataPointer(specifier) && m.fileName?.startsWith(pointerPrefix) ? m.fileName : specifier)
            const name = toAbsolute(pointer)

            sourceMapParser?.registerDeferredMapping(name, () => {
                const { hash, storeHash } = pointer.resolve()

                return getArtifactSourceMap(dataRepository, hash, storeHash)
            })

            const data = getPointerData(pointer)
            if (typeof data === 'string') {
                return new vm.SourceTextModule(data, {
                    context: ctx?.vm,
                    identifier: name,
                    importModuleDynamically: opt?.importModuleDynamically as any,
                    initializeImportMeta: opt?.initializeImportMeta,
                })
            }

            if (Array.isArray(data) && data.length === 2) {
                return new vm.SourceTextModule(data[0], {
                    context: ctx?.vm,
                    identifier: data[1],
                    importModuleDynamically: opt?.importModuleDynamically as any,
                    initializeImportMeta: opt?.initializeImportMeta,
                })
            }

            return new vm.SyntheticModule(Object.keys((data as any).captured), function () {
                const loaded = loadPointerData(data, m.id, ctx)
                for (const [k, v] of Object.entries(loaded)) {
                    this.setExport(k, v)
                }
            }, { identifier: name, context: ctx?.vm })
        }

        switch (path.extname(m.fileName!)) {
            case '.ts':
            case '.mts':
                // TODO: loader shouldn't load read the file
                if (options.typescriptLoader) {
                    data = options.typescriptLoader(m.fileName!, 'esm')
                    break
                }
            default:
                data = fs.readFileSync(m.fileName!, 'utf-8')
        }  

        return new vm.SourceTextModule(data, {
            identifier: m.fileName!, // this is used for caching. If it changes, make sure to update the caching logic too
            context: opt?.context?.vm ?? getDefaultContext()?.vm,
            importModuleDynamically: opt?.importModuleDynamically as any,
            initializeImportMeta: opt?.initializeImportMeta,
        })
    }

    function createCjs(m: Module, opt?: ModuleCreateOptions) {
        if (m.typeHint === 'builtin') {
            return createSyntheticCjsModule(() => requireNodeModule(m.name))
        } else if (m.typeHint === 'wasm') {
            return createSyntheticCjsModule(() => {
                const source = fs.readFileSync(m.fileName!)
                const typedArray = new Uint8Array(source.buffer)
                const wasmModule = new WebAssembly.Module(typedArray)
                const inst = new WebAssembly.Instance(wasmModule)

                return inst.exports
            })
        }

        const ctx = opt?.context ?? getDefaultContext()

        function createScript(text: string, name: string, cacheKey?: string) {
            const req = _createRequire(m.id, ctx)

            return createScriptModule(
                ctx?.vm,
                text,
                name,
                req,
                codeCache,
                cacheKey,
                sourceMapParser,
                getWrappedProcess(ctx),
                id => {
                    // TODO: frontload this in tests?
                    if (options?.registerPointerDependencies && isDataPointer(id)) {
                        return options.registerPointerDependencies(id).then(() => req(id))
                    }

                    return req(id)
                },
                opt?.importModuleDynamically,
                // m.cjs,
            ) 
        }

        const specifier = m.name
        if (m.typeHint === 'pointer') {
            const pointer = coerceToPointer(!isDataPointer(specifier) && m.fileName?.startsWith(pointerPrefix) ? m.fileName : specifier)
            const name = toAbsolute(pointer)

            sourceMapParser?.registerDeferredMapping(name, () => {
                const { hash, storeHash } = pointer.resolve()

                return getArtifactSourceMap(dataRepository, hash, storeHash)
            })

            const data = getPointerData(pointer)
            if (typeof data === 'string') {
                return createScript(data, name, pointer.hash)
            }

            // Native module
            if (Array.isArray(data) && data.length === 2) {
                return createScript(data[0], data[1], pointer.hash)
            }

            return createSyntheticCjsModule(() => loadPointerData(data, m.id, ctx))
        }

        if (isSea && m.typeHint === 'sea-asset') {
            const hash = m.name.slice(seaAssetPrefix.length)
            const data = readSeaAsset(hash)

            return createScript(data, m.name, hash)
        }

        const fileName = m.fileName
        if (!fileName) {
            throw new Error(`No file name: ${m.name} [${m.id}]`)
        }

        const extname = path.extname(fileName)
        switch (extname) {
            case '.ts':
            case '.cts':
                if (options.typescriptLoader) {                    
                    try {
                        return createScript(options.typescriptLoader(fileName, 'cjs'), fileName)
                    } catch (e) {
                        const m = (e as any).message
                        if (extname === '.cts' || !esbuildEsmErrors.find(x => m.includes(x))) {
                            throw e
                        }

                        throw new ESMError(m)
                    }
                }
            case '.mjs':
                throw new Error(`Not expected: ${m.id}`)
            case '.json':
                return createSyntheticCjsModule(() => JSON.parse(fs.readFileSync(fileName, 'utf-8')))
            case '.node':
                return createSyntheticCjsModule(module => {
                    getWrappedProcess(ctx).dlopen(module, fileName)

                    return module.exports
                })
        }

        const contents = fs.readFileSync(fileName, 'utf-8')
        const patchFn = resolver.getPatchFn(fileName)
        const data = patchFn?.(contents) ?? contents

        return createScript(data, fileName)
    }

    // `undefined` = this context
    // not great, I know
    const linkers = new Map<Context | undefined, ReturnType<typeof createModuleLinker>>()
    function getLinker(ctx: Context | undefined) {
        if (linkers.has(ctx)) {
            return linkers.get(ctx)!
        }

        const linker = createModuleLinker(fs, resolver, { createCjs, createEsm }, ctx)
        linkers.set(ctx, linker)

        return linker
    }

    function createRequireCacheProxy(importer: string, linker: ReturnType<typeof getLinker>) {
        return new Proxy({}, {
            get: (_, spec) => {
                if (typeof spec === 'symbol') {
                    return
                }

                const module = linker.getModule(importer, spec)
                if (module.cjs && module.cjs.evaluated) {
                    return module.cjs.exports
                }
            },
            deleteProperty: (_, spec) => {
                if (typeof spec === 'symbol') {
                    return false
                }

                return linker.deleteCacheEntry(importer, spec) ?? false
            }
        })
    }

    // Used to make sure `cwd()` works as expected.
    // Probably doesn't work with the working dir in `path.resolve`
    const wrappedProcesses = new Map<Context | undefined, NodeJS.Process>()
    function getWrappedProcess(ctx: Context | undefined) {
        const p = wrappedProcesses.get(ctx)
        if (p) {
            return p
        }

        const np = wrapProcess(process, workingDirectory, dataRepository, env, ctx)
        wrappedProcesses.set(ctx, np)

        return np
    }

    function _createRequire(location = dummyEntrypoint, ctx: Context | undefined = getDefaultContext(), linker = getLinker(ctx)) {
        const isVirtualImporter = location.startsWith(pointerPrefix)
        const resolveLocation = isVirtualImporter ? dummyEntrypoint : path.resolve(workingDirectory, location)
        const nodeRequire = nodeCreateRequire(resolveLocation)
        const cacheProxy = createRequireCacheProxy(location, linker)

        // cjs to esm is slow because you need to know named bindings prior
        // to execution (i.e. linking). If the module is guaranteed not to
        // depend on any es modules then it's safe to simply execute it
        // and inspect the exports to determine named bindings (if any).
        // Otherwise, we have to determine the bindings via parsing.

        function require(id: string): any {
            const cjs = linker.getCjs(isVirtualImporter ? location : resolveLocation, id)

            return cjs.evaluate() 
        }

        function resolve(id: string, opt?: { paths?: string[] }) {
            if (opt?.paths) {
                return nodeRequire.resolve(id, opt)
            }

            return resolver.resolve(id, location)
        }

        return Object.assign(require, { 
            resolve,
            cache: cacheProxy,
            main: requireMain,
        })
    }

    let requireMain: CjsModule | undefined
    function loadCjs(id: string, location = dummyEntrypoint) {
        const isVirtualImporter = location.startsWith(pointerPrefix)
        const resolveLocation = isVirtualImporter ? dummyEntrypoint : path.resolve(workingDirectory, location)
        const ctx = getDefaultContext()
        const linker = getLinker(ctx)
        const cjs = linker.getCjs(isVirtualImporter ? location : resolveLocation, id)
        requireMain = cjs

        return cjs.evaluate() 
    }

    async function loadEsm(id: string, location = dummyEntrypoint) {
        const ctx = getDefaultContext()
        const linker = getLinker(ctx)
        const importer = location.startsWith(pointerPrefix) ? location : path.resolve(workingDirectory, location)
        const esm = await linker.getEsm(importer, id)
        await linker.linkModule(esm)

        return esm.evaluate() 
    } 

    // XXX: too lazy to update dependencies
    return Object.assign(_createRequire, {
        loadEsm,
        loadCjs,
    })
}

export function createSyntheticCjsModule(evaluate: (module: any) => any) {
    const cjs: CjsModule = {
        exports: {},
        evaluate: () => {
            if (cjs.evaluated) {
                return cjs.exports
            }

            cjs.evaluated = true
            cjs.exports = evaluate(cjs)
            return cjs.exports
        }
    }

    return cjs
}

function wrapCode(text: string, params: string[]) {
    const sanitized = text.startsWith('#!')
        ? text.replace(/^#!.*/, '')
        : text

    return `
(function (${params.join(',')}) {
${sanitized}
})(${params.join(',')})
`.trim()
}

const minScriptLengthForCaching = 1_000

class ESMError extends Error {}

export function createScriptModule(
    ctx: vm.Context | undefined, 
    text: string, 
    location: string, 
    requireFn: (id: string) => any,
    cache?: CodeCache,
    cacheKey?: string,
    sourceMapParser?: Pick<SourceMapParser, 'registerFile' | 'setAlias'>,
    _process?: typeof process,
    dynamicImporter?: (id: string) => Promise<any>,
    moduleImporter?: ModuleCreateOptions['importModuleDynamically'],
    moduleObj?: { exports: any }, 
): CjsModule {
    // v8 validates code cache data using the filename
    // if the names don't match, the data is rejected
    // The version of the embedder and v8 also matters
    const key = text.length >= minScriptLengthForCaching 
        ? cacheKey ?? getHash(text)
        : undefined

    if (key && sourceMapParser) {
        sourceMapParser.setAlias(location, key)
    }

    const cachedData = key ? cache?.getCachedData(key) : undefined

    const dynamicImport = (id: string) => {
        if (!dynamicImporter) {
            throw new Error('No dynamic import callback registered')
        }

        return dynamicImporter(id)
    }

    const produceCachedData = !!cache && !!key && !cachedData

    function evaluate() {
        if (module.evaluated) {
            return module.exports
        }

        module.evaluated = true
        if (!ctx) {
            Object.assign(globalThis.global, ext)
            s.runInThisContext()  
        } else {
            Object.assign(ctx, ext)
            s.runInContext(ctx)    
        }

        if (cachedData && s.cachedDataRejected) {
            getLogger().debug(`Rejected cached data`, location)
            cache!.evictCachedData(key!)
        } else if (produceCachedData) {
            cache!.setCachedData(key, s.createCachedData())
        }

        return module.exports
    }

    if (moduleObj) {
        (moduleObj as any).evaluate = evaluate
    }

    const module: CjsModule = (moduleObj as any) ?? {
        exports: {},
        evaluate,
    }

    const ext = { 
        require: requireFn,
        __filename: location,
        __dirname: path.dirname(location),
        module,
        exports: module.exports,

        process: _process, 
        dynamicImport,

        // XXX: not a good impl.
        eval: (str: string) => {
             // TODO: wrap str?
            const script = new vm.Script(str, {
                importModuleDynamically: moduleImporter as any,
            })

            if (!ctx) {
                Object.assign(globalThis.global, ext)
                return script.runInThisContext()  
            } else {
                Object.assign(ctx, ext)
                return script.runInContext(ctx)    
            }
        },
    }
    
    function compileScript() {
        try {
            return new vm.Script(wrapCode(text, ['require', '__filename', '__dirname', 'module', 'exports']), {
                filename: sourceMapParser && key ? key : location,
                cachedData,
                lineOffset: -1, // The wrapped code has 1 extra line before and after the original code
                produceCachedData,
                importModuleDynamically: moduleImporter as any,
            })
        } catch (e) {
            if (e && (e as any)?.name === 'SyntaxError' && esmErrors.includes((e as any).message)) {
                throw new ESMError((e as any).message) // XXX: why not just compile the script earlier instead of wrapping?
            }
            throw e
        }
    }

    sourceMapParser?.registerFile(location, text)
    const s = compileScript()
    module.script = s

    return module
}

export function isSourceOrigin(o: SourceOrigin | {}): o is SourceOrigin {
    return Object.keys(o).length !== 0
}

export function getArtifactSourceMap(repo: BasicDataRepository, hash: string, storeHash: string) {
    if (isNullHash(storeHash)) {
        return false
    }

    try {
        const manifest = JSON.parse(repo.getDataSync(storeHash, 'utf-8')) as { artifacts: Record<string, ArtifactMetadata> }
        const m = manifest.artifacts[hash]
        if (!m) {
            throw new Error(`Missing metadata`)
        }
    
        const runtimeSourceMap = m?.sourcemaps?.runtime
        if (!runtimeSourceMap) {
            return false // Sourcemaps were intentionally excluded. Hide any traces.
        }
    
        const [prefix, _, mapHash] = runtimeSourceMap.split(':')
        const data = JSON.parse(repo.getDataSync(mapHash, 'utf-8'))

        return data as SourceMapV3
    } catch (e){
        getLogger().warn(`Failed to get sourcemap for object: ${hash}`, e)

        return false
    }
}


export function getArtifactOriginalLocation(pointer: string | DataPointer, type: 'runtime' | 'infra' = 'runtime') {
    if (!isDataPointer(pointer)) {
        return pointer
    }

    const repo = getDataRepository(getFs())
    const { hash, storeHash } = pointer.resolve()
    const metadata = repo.getMetadata(hash, storeHash)
    const m = metadata.sourcemaps?.[type]
    if (!m) {
        return m
    }

    const [_prefix, _storeHash, mapHash] = m.split(':')
    const data = JSON.parse(Buffer.from(repo.readDataSync(mapHash)).toString('utf-8')) as Required<SourceMapV3>
    
    // Guesses the start line by skipping over empty lines
    let line = 0
    while (line < data.mappings.length && data.mappings[line] === ';') { line += 1 }

    return getOriginalLocation(new SourceMap(data), pointer, line)
}

function getOriginalLocation(sourcemap: SourceMap, fileName: string, line = 0, column = 0, workingDirectory = getWorkingDir()) {
    const entry = sourcemap.findEntry(line, column)
    if (!entry.originalSource) {
        return `${fileName}:${line + 1}${column + 1}`        
    }

    const dir = fileName.startsWith(pointerPrefix) ? workingDirectory : path.dirname(fileName)
    const source = path.resolve(dir, entry.originalSource)

    return `${source}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
}

// Needed to prune traces from the SEA build
const selfPath = __filename

export type SourceMapParser = ReturnType<typeof createSourceMapParser>
export function createSourceMapParser(
    fs: SyncFs, 
    resolver?: ModuleResolver, 
    workingDirectory = process.cwd(),
    excludedDirs?: string[] // Excludes any frames from these directories
) {
    const deferredSourceMaps = new Map<string, () => SourceMapV3 | false | undefined>()
    const sourceMaps = new Map<string, SourceMap | undefined | false>()
    const files = new Map<string, string>()
    const isDebugMode = !!process.env['SYNAPSE_DEBUG']
    const aliases = new Map<string, string>()
    const internalModules = new Map<string, string>()

    // TODO: remove "AsyncLocalStorage.run (node:async_hooks" call sites if they appear above an internal module
    // TODO: remove usercode callsites that are from `__scope__`
    // TODO: remove the mapping for the wrapped user module (it's always at the last non-whitespace character)

    function registerMapping(fileName: string, sourcemap: SourceMapV3) {
        if ((sourcemap as any).__internal) {
            internalModules.set(fileName, sourcemap.sources[0])
        }

        // The node types are wrong here
        const mapping = new SourceMap(sourcemap as Required<typeof sourcemap>)
        sourceMaps.set(fileName, mapping)

        return mapping
    }

    function setAlias(original: string, alias: string) {
        aliases.set(alias, original)
    }

    function resolveAlias(fileName: string) {
        if (aliases.has(fileName)) {
            return resolveAlias(aliases.get(fileName)!)
        }
        return fileName
    }

    function registerDeferredMapping(fileName: string, fn: () => SourceMapV3 | false | undefined) {
        deferredSourceMaps.set(fileName, fn)
    }

    function loadFile(fileName: string) {
        if (isBuiltinLike(fileName) || fileName.startsWith(pointerPrefix)) {
            return
        }

        try {
            const data = fs.readFileSync(fileName, 'utf-8')
            files.set(fileName, data)
    
            return data
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            getLogger().debug(`Missing file: ${fileName}`, (e as any).message)
        }
    }

    function isBuiltinLike(fileName: string) {
        return isBuiltin(fileName) || fileName.startsWith('node:internal/')
    }

    const isSea = isSelfSea()

    function tryParseSourcemap(fileName: string, shouldLoadFile = false) {
        fileName = resolveAlias(fileName)

        if (sourceMaps.has(fileName)) {
            return sourceMaps.get(fileName)
        }

        if (deferredSourceMaps.has(fileName)) {
            const data = deferredSourceMaps.get(fileName)!()
            if (!data) {
                sourceMaps.set(fileName, data)
                return data
            }

            return registerMapping(fileName, data)
        }

        const physicalLocation = resolver?.getFilePath(fileName) ?? fileName
        if (physicalLocation === selfPath && isSea) {
            sourceMaps.set(fileName, isDebugMode ? undefined : false)
            return isDebugMode ? undefined : false
        }

        // Dead code?
        const sourceInfoNode = resolver?.getSource(fileName)
        const sourceInfo = sourceInfoNode?.source
        if (sourceInfo?.type === 'artifact') {
            const dataDir = path.dirname(path.dirname(path.dirname(physicalLocation))) // XXX: need to do this better
            const hash = path.relative(dataDir, physicalLocation).split(path.sep).join('')
            const mapping = getArtifactSourceMap(createDefaultDataRepo(fs, dataDir), hash, sourceInfo.data.metadataHash)

            if (!mapping) {
                sourceMaps.set(fileName, mapping)
                return mapping
            }
            
            return registerMapping(fileName, mapping)
        }

        const contents = files.get(physicalLocation) ?? (shouldLoadFile ? loadFile(physicalLocation) : undefined)
        if (!contents) {
            sourceMaps.set(fileName, undefined)
            return
        }

        const sourcemap = findSourceMap(physicalLocation, contents)
        if (!sourcemap) {
            sourceMaps.set(fileName, undefined)
            return
        }

        if (!(sourcemap instanceof URL)) {
            return registerMapping(fileName, sourcemap)
        }

        // TODO: should we always swallow errors from bad sourcemaps?
        try {
            const data = JSON.parse(fs.readFileSync(sourcemap.pathname, 'utf-8'))

            return registerMapping(fileName, data)
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            getLogger().debug(`Missing source map: ${sourcemap.pathname}`)
            sourceMaps.set(fileName, undefined)
        }
    }

    function registerFile(fileName: string, contents: string) {
        files.set(fileName, contents)
    }

    function shouldHideFrame(fileName: string) {
        fileName = resolveAlias(fileName)

        if (isDebugMode) {
            return false
        }

        if (internalModules.has(fileName)) {
            return true
        }

        if (isBuiltinLike(fileName)) {
            return true
        }

        if (excludedDirs && !!excludedDirs.find(d => fileName.startsWith(d))) {
            return true
        }

        return false
    }

    function prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]) {
        const stack: string[] = []
        for (let i = 0; i < stackTraces.length; i++) {
            const trace = stackTraces[i]
            const fileName = trace.getFileName()
            if (!fileName) {
                stack.push(trace.toString())
                continue
            }

            const sourcemap = tryParseSourcemap(fileName, true)
            if (!sourcemap) {
                if (sourcemap !== false && !shouldHideFrame(fileName)) {
                    if (aliases.has(fileName)) {
                        stack.push(trace.toString().replace(fileName, resolveAlias(fileName)))
                    } else {
                        stack.push(trace.toString())
                    }
                }
                continue
            }

            const line = trace.getLineNumber()!
            const column = trace.getColumnNumber()!
            const entry = sourcemap.findEntry(line - 1, column - 1)
            if (entry.originalLine === undefined) {
                stack.push(trace.toString())
                continue
            }


            const dir = deferredSourceMaps.has(resolveAlias(fileName)) ? workingDirectory : path.dirname(resolveAlias(fileName)) // FIXME: `dirname` is probably wrong here
            // const source = path.resolve(dir, entry.fileName)
            // const originalLocation = `${source}:${entry.lineNumber}:${entry.columnNumber}`
            const source = path.resolve(dir, entry.originalSource)
            // Makes the traces more compact if the file is within the current dir
            const relSource = source.startsWith(workingDirectory) ? path.relative(workingDirectory, source) : source

            const originalLocation = `${relSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}`
            const mapped = trace.toString().replace(`${fileName}:${line}:${column}`, originalLocation)
            // TODO: detect duplicate frames and omit them. These are often from inlined help functions e.g. `__scope__`
            stack.push(mapped)
        }

        return [
            `${err.name}: ${err.message}`,
            ...stack.map(l => `    at ${l}`)
        ].join('\n')
    }

    return {
        setAlias,
        registerFile,
        registerMapping,
        tryParseSourcemap,
        registerDeferredMapping,
        prepareStackTrace,
    }
}

export function registerSourceMapParser(parser: SourceMapParser, errorClass: typeof Error): { dispose: () => void } {
    const originalFn = errorClass.prepareStackTrace
    errorClass.prepareStackTrace = parser.prepareStackTrace

    function dispose() {
        if (errorClass.prepareStackTrace === parser.prepareStackTrace) {
            errorClass.prepareStackTrace = originalFn
        }
    }

    return { dispose }
}

function createModuleWrap(mod: any, overrides: Record<string, any>) {
    let trappedProto = false
    const keys = new Set(Object.keys(overrides))
    const p: any = new Proxy(mod, {
        get: (target, prop, recv) => {
            if (typeof prop === 'string' && keys.has(prop)) {
                return overrides[prop as keyof typeof overrides]
            }

            return Reflect.get(target, prop, recv)
        },

        // TODO: we should only trap the prototype if we're being treated as an ES module e.g. `__esModule` was accessed
        getPrototypeOf: () => !trappedProto ? (trappedProto = true, p) : null,
    })

    return p
}

function wrapPath(path: typeof import('node:path')): typeof import('node:path') {
    const overrides = {
        basename: (p: string) => {
            if (isDataPointer(p)) {
                return p.hash
            }
            return path.basename(p)
        }
    }

    return createModuleWrap(path, overrides)
}

function wrapFsPromises(fs: typeof import('node:fs/promises'), repo: BasicDataRepository): typeof import('node:fs/promises') {
    const overrides = {
        readFile: async (fileName: string, opt?: BufferEncoding | any) => {
            if (isDataPointer(fileName)) {
                const encoding = typeof opt === 'string' ? opt : opt?.encoding
                return repo.getDataSync(fileName.hash, encoding as any)
            }
            return fs.readFile(fileName, opt)
        }
    }

    return createModuleWrap(fs, overrides)
}

function wrapChildProcess(child_process: typeof import('node:child_process')): typeof import('node:child_process') {
    const _fork = child_process.fork
    child_process.fork = function fork(modulePath: string, argsOrOpt?: string[] | any, opt?: any) {
        if (isDataPointer(modulePath)) {
            return _fork(toAbsolute(modulePath), argsOrOpt, opt)
        }

        return _fork(modulePath, argsOrOpt, opt)
    }

    return child_process
}

function wrapOs(os: typeof import('node:os')): typeof import('node:os') {
    // Don't wrap if there's no overrides
    if (!process.env['NODE_ARCH']) {
        return os
    }

    const overrides = {
        arch: () => process.env['NODE_ARCH'] || os.arch(),
        platform: () => process.env['NODE_PLATFORM'] || os.platform(),
        endianness: () => process.env['NODE_ENDIANNESS'] || os.endianness(),
    }

    return createModuleWrap(os, overrides)
}

// Doesn't do symbols
function setGlobals(globals: typeof global, props: Record<string, any>) {
    const prev: any[] = []
    const keys = Object.keys(props)
    for (const key of keys) {
        prev.push((globals as any)[key])
        ;(globals as any)[key] = props[key]
    }

    function restore() {
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i]
            ;(globals as any)[key] = prev[i]
        }
    }

    return restore
}

function wrapProcess(
    proc: typeof process, 
    workingDirectory: string,
    dataRepository: BasicDataRepository,
    env?: Record<string, string | undefined>,
    ctx?: Context
): typeof process {
    const mergedEnv = { ...proc.env, ...env }
    const arch = mergedEnv['NODE_ARCH'] || proc.arch
    const platform = mergedEnv['NODE_PLATFORM'] || proc.platform

    function dlopen(module: any, fileName: string) {
        const resolved = dataRepository.getDiskPath
            ? dataRepository.getDiskPath(path.relative(workingDirectory, fileName))
            : fileName

        if (!ctx) {
            return proc.dlopen(module, resolved)
        }

        const restore = setGlobals(ctx.globals, { proc, module })
        vm.runInContext(`proc.dlopen(module, '${resolved}')`, ctx.vm)
        restore()
    }

    return new Proxy(proc, {
        get: (target, prop, recv) => {
            if (prop === 'cwd') {
                return () => workingDirectory
            } else if (prop === 'arch') {
                return arch
            } else if (prop === 'platform') {
                return platform
            } else if (prop === 'env') {
                return mergedEnv
            } else if (prop === 'dlopen') {
                return dlopen // Only used for reading `.node` modules compiled from Zig
            } else if (prop === 'versions') {
                // TODO: the same thing should be done in the synth loader too
                return {
                    ...proc.versions,
                    node: proc.versions.node ?? proc.versions.synapse,
                }
            }

            return Reflect.get(target, prop, recv)
        },
    })
}