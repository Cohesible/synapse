import * as path from 'node:path'
import * as vm from 'node:vm'
import * as util from 'node:util'
import { createRequire, isBuiltin } from 'node:module'
import * as terraform from './runtime/modules/terraform'
import { AsyncLocalStorage } from 'node:async_hooks'
import { runTask, getLogger } from './logging'
import { PackageResolver, PackageService } from './pm/packages'
import { BuildTarget, LocalWorkspace, getV8CacheDirectory, getWorkingDir } from './workspaces'


// BUG: ReferenceError: runtime is not defined
// `scopes.ts` cannot handle multiple imports from the same module (?)
import type { ArtifactFs, Scope } from './runtime/modules/core'
import { ReplacementSymbol, TargetsFile } from './compiler/host'
import { SyncFs } from './system'
import { Module, ModuleCreateOptions, SourceMapParser, createGetCredentials, createModuleLinker, createScriptModule, createSyntheticCjsModule, getArtifactOriginalLocation, registerSourceMapParser } from './runtime/loader'
import { Artifact, BuildFsFragment, createArtifactFs, toFs } from './artifacts'
import { Mutable, dedupe, isNonNullable, isWindows, makeRelative, memoize, wrapWithProxy } from './utils'
import { ModuleResolver } from './runtime/resolver'
import { createAuth, getAuth } from './auth'
import { CodeCache, createCodeCache } from './runtime/utils'
import { getFs } from './execution'
import { coerceToPointer, isDataPointer, pointerPrefix, toAbsolute } from './build-fs/pointers'
import { createNpmLikeCommandRunner } from './pm/publish'
import { createUnknown } from './static-solver'

function getReplacementsForTarget(data: TargetsFile[string], target: string): Record<string, ReplacementSymbol> {
    const replacements: Record<string, ReplacementSymbol> = {}
    for (const [k, v] of Object.entries(data)) {
        const binding = v[target]
        if (binding) {
            replacements[k] = binding
        }
    }

    return replacements
}


export interface LoaderOptions {
    deployTarget?: string
    backend?: {
    }
    outDir?: string
    workingDirectory?: string

    generateExports?: boolean
    exportSymbolData?: boolean

    // This will embed a logger into the app
    loggerModule?: string 

    beforeSynth?: terraform.SynthHook[]
}

interface SynthLogger {
    console: typeof console
    stdout: typeof process.stdout
    stderr: typeof process.stderr
}

function createSynthLogger(p: typeof process, c: typeof console): SynthLogger {
    const logEvent = getLogger().emitSynthLogEvent
    const logMethods = {
        log: (...args: any[]) => logEvent({ level: 'info', args }),
        warn: (...args: any[]) => logEvent({ level: 'warn', args }),
        error: (...args: any[]) => logEvent({ level: 'error', args }),
        debug: (...args: any[]) => logEvent({ level: 'debug', args }),
        trace: (...args: any[]) => logEvent({ level: 'trace', args }),
    }
    
    const consoleWrap = wrapWithProxy(c, logMethods)
    // TODO: wrap process

    return { console: consoleWrap, stdout: p.stdout, stderr: p.stderr }
}

export function createrLoader(
    artifactFs: BuildFsFragment,
    targets: TargetsFile,
    infraFiles: Record<string, string>,
    deployables: Record<string, boolean>,
    infraPointers: Record<string, Record<string, string>>,
    packageResolver: PackageResolver,
    moduleResolver: ModuleResolver,
    buildTarget: BuildTarget,
    deploymentId: string,
    sourcemapParser: SourceMapParser,
    options: LoaderOptions = {}
) {
    const {
        deployTarget, 
        workingDirectory = getWorkingDir(),
        outDir = workingDirectory,
    } = options
    
    const codeCache = createCodeCache(getFs(), getV8CacheDirectory())
    const proxyCache = new Map<any, any>()
    const reverseInfraFiles = Object.fromEntries(Object.entries(infraFiles).map(x => x.reverse())) as Record<string, string>

    let getCredentials: ReturnType<typeof createGetCredentials> | undefined
    function getCredentialsFn() {
        return getCredentials ??= createGetCredentials(getAuth())
    }

    // XXX: certain packages use this to check for a node-compatible runtime
    process.versions.node ??= process.versions.synapse ?? process.versions.node

    function createRuntime(
        sources: { name: string, source: string }[],
        getSource: (fileName: string, id: string, virtualLocation: string) => string,
        solvePerms: (target: any, globals?: Record<string, any>, args?: any[], thisArg?: any) => any,
    ) {
        const capturedSymbolData = new Map<any, Context>()
        const onExitScope = options.exportSymbolData
            ? (context: Context, val: any) => { capturedSymbolData.set(val, context) }
            : undefined

        const context = createContextStorage({ onExitScope }, workingDirectory)

        function createTerraformState(): terraform.State {
            return {
                names: new Set(),
                registered: new Map(),
                backends: new Map(),
                moved: [],
                tables: new Map(),
                serialized: new Map(),
                serializers: new Map(),
                secrets: new Map(),
            }
        }

        function createExportedSymbols(getSymbolId: (symbol: NonNullable<Scope['symbol']>) => number) {
            function getExecutionScopeId(scopes: Scope[]) {
                const symbols = scopes.slice(0, -1)
                    .map(x => x.symbol)
                    .filter(isNonNullable)

                return symbols.map(getSymbolId).join(':')
            }

            const files: Record<string, { [executionScopeId: string]: { symbols: { [symbolId: number]: any }, context: Context } }> = {}
            for (const [k, v] of capturedSymbolData.entries()) {
                const scopes = v.scope2
                const assignmentSymbol = scopes[scopes.length - 1]?.assignmentSymbol
                if (!assignmentSymbol) continue

                const id = getSymbolId(assignmentSymbol)
                const executionScope = getExecutionScopeId(scopes)

                const exports = files[assignmentSymbol.fileName] ??= {}
                const values = exports[executionScope] ??= { symbols: {}, context: v }
                if (id in values.symbols) {
                    // throw new Error(`Found non-empty slot when assigning value to an execution scope`)
                    getLogger().log(`Found non-empty slot when assigning value to an execution scope: ${assignmentSymbol.name}`)
                    continue
                }

                values.symbols[id] = k
            }

            const Export = getExportClass()
    
            for (const [fileName, scopes] of Object.entries(files)) {
                for (const [k, v] of Object.entries(scopes)) {
                    function createExport() {
                        new Export({ symbols: v.symbols }, {
                            id: `__exported-symbol-data`,
                            source: fileName,
                            executionScope: k,
                        } as any)
                    }

                    context.restore(v.context, createExport)
                }
            }
        }

        const terraformState = createTerraformState()
        const tfGlobals =[
            () => terraformState,
            (peek?: boolean) => peek ? context.getId(-1) : context.getId(),
            () => context.getModuleId(),
            () => context.getNamedContexts(),
            () => context.getScopes(),
            options.exportSymbolData ? createExportedSymbols : undefined,
        ] as const

        const runtimeToSourceFile = new Map(sources.map(s => [s.name, s.source]))
        const sourceToRuntimeFile = new Map(sources.map(s => [s.source, s.name]))

        const cache: Record<string, any> = {}
        const ctx = createVmContext()

        function createLinker() {
            function getNodeModule(specifier: string, req = defaultRequire) {
                switch (specifier) {
                    case 'node:path':
                        return wrapPath(tfModule.Fn, tfModule.internalState)
                    case 'node:module':
                        return patchModule(createRequire2)

                    default:
                        return req(specifier)
                }
            }

            function createCjs(m: Module, opt?: ModuleCreateOptions) {
                const specifier = m.name
                if (m.typeHint === 'builtin') {
                    return createSyntheticCjsModule(() => getNodeModule(specifier))
                }
        
                const _ctx = opt?.context ?? ctx
        
                function createScript(text: string, name: string, cacheKey?: string) {
                    const req = createRequire2(m.id)

                    return createScriptModule(
                        _ctx.vm,
                        text,
                        name,
                        req,
                        codeCache,
                        cacheKey,
                        sourcemapParser,
                        process,
                        req,
                        opt?.importModuleDynamically,
                    ) 
                }
        
                if (specifier.startsWith(pointerPrefix)) {
                    const pointer = coerceToPointer(!isDataPointer(specifier) && m.fileName?.startsWith(pointerPrefix) ? m.fileName : specifier)
                    const data = getSource(specifier, m.name, m.id)
                    if (typeof data !== 'string') {
                        createSyntheticCjsModule(() => data)
                    }
    
                    return createScript(data, toAbsolute(pointer), pointer.hash)
                }
        
                const fileName = m.fileName
                if (!fileName) {
                    throw new Error(`No file name: ${m.name} [${m.id}]`)
                }
        
                const extname = path.extname(fileName)
                switch (extname) {
                    case '.mjs':
                        throw new Error(`Not expected: ${m.id}`)
                    case '.json':
                        return createSyntheticCjsModule(() => JSON.parse(getSource(fileName, specifier, m.id)))
                    case '.node':
                        return createSyntheticCjsModule(() => require(fileName))
                }
    
                const data = getSource(fileName, specifier, m.id)
        
                return createScript(data, fileName)
            }

            async function createModuleWithReplacements(m: Module, symbols: Record<string, ReplacementSymbol>, opt?: ModuleCreateOptions) {
                // const data = getSource(m.fileName!, m.name, m.id)
    
                // ES6 modules are always in strict mode so it's unlikely to see "use strict" there
                // const hint = m.typeHint ?? (data.startsWith('"use strict";') ? 'cjs' : undefined)
                // if (hint === 'cjs') {
    
                // }
                const mod = new vm.SyntheticModule(Object.keys(symbols), () => {}, { context: opt?.context?.vm ?? ctx.vm, identifier: m.name })
                await mod.link((() => {}) as any)
                const proxy = wrapNamespace(m.id, mod.namespace)
                const req = createRequire2(m.id, false)
                for (const [k, v] of Object.entries(symbols)) {
                    defineProperty(proxy, k, {
                        enumerable: true,
                        configurable: false,
                        get: () => req(v.moduleSpecifier)[v.symbolName]
                    })
                }

                return mod
            }    
    
            function createEsm(m: Module, opt?: ModuleCreateOptions) {
                const location = m.fileName!
                const source = runtimeToSourceFile.get(location)
                const moduleName = source ? getModuleName(source) : undefined
                if (source) {
                    sourcemapParser.setAlias(infraFiles[location] ?? location, source)
                }

                const replacementsData = targets[location]
                if (replacementsData) {
                    getLogger().log(`Loaded symbol bindings for: ${m.id}`, Object.keys(replacementsData))

                    return createModuleWithReplacements(m, getReplacementsForTarget(replacementsData, deployTarget!), opt)
                }

                const data = getSource(m.fileName!, m.name, m.id)
                if (source) {
                    ;(m as Mutable<Module>).fileName = source // XXX: needed to make `import.meta.filename` align with CJS
                }
                const module =  new vm.SourceTextModule(data, {
                    identifier: location,
                    context: opt?.context?.vm ?? ctx.vm,
                    importModuleDynamically: opt?.importModuleDynamically as any,
                    initializeImportMeta: opt?.initializeImportMeta,
                })

                if (moduleName) {
                    const evaluate = module.evaluate.bind(module)
                    module.evaluate = (opt) => {
                        return context.run({ moduleId: moduleName }, () => evaluate(opt))
                            .then(() => {
                                if (options.generateExports && !!deployables[location]) {
                                    createExportResource(location, moduleName, module.namespace, 'esm')
                                }
                            })
                    }
                }

                return module
            }    
    
            return createModuleLinker(getFs(), moduleResolver, { createCjs, createEsm }, ctx)
        }

        const hostPermissions: any[] = []
        function solveHostPerms(target: any, args?: any[], thisArg?: any) {
            const s = solvePerms(target, undefined, args, thisArg)
            hostPermissions.push(...s)
        }

        function getHostPerms() {
            return dedupe(hostPermissions.flat(100))
        }

        const defaultRequire = createRequire2(workingDirectory)
        const nodeRequire = createRequire(bootstrapPath)
        const tfModule = defaultRequire('synapse:terraform')[unproxy] as typeof terraform
        const constructsModule = tfModule.init(...tfGlobals)
    
        constructsModule.registerBackend('inmem', {})
    
        if (options.beforeSynth) {
            constructsModule.registerBeforeSynthHook(...options.beforeSynth)
        }

        function getExportClass(require = defaultRequire) {
            const { Export } = require('synapse:lib') as typeof import('synapse:lib')

            return Export
        }

        function createAsset(target: string, importer: string) {
            const resolvedImporter = runtimeToSourceFile.get(importer) ?? importer
            const location = path.resolve(path.dirname(resolvedImporter), target)

            const { createFileAsset } = defaultRequire('synapse:lib') as typeof import('synapse:lib')
            const asset = createFileAsset(location)

            return asset.pointer
        }

        // Checks if the file will be deployed 
        function isInfra(fileName: string) {
            const aliased = reverseInfraFiles[fileName]
            if (aliased) {
                return true
            }

            return !!runtimeToSourceFile.has(fileName)
        }

        // Deferred functions are executed after all modules have executed
        const deferred: { ctx: Context, fn: () => void }[] = []
        function executeDeferred() {
            for (const { ctx, fn } of deferred) {
                context.restore(ctx, fn)
            }
        }

        function wrapNamespace(id: string, exports: any) {
            if (isProxy(exports)) {
                return exports
            }

            const cached = proxyCache.get(exports)
            if (cached) {
                return cached
            }

            const proxy = createModuleProxy(context, id, undefined, exports, false, undefined, solveHostPerms, true)
            proxyCache.set(exports, proxy)

            return proxy
        }

        function wrapExports(spec: string, virtualId: string | undefined, exports: any, isInfra: boolean = false, importer?: string) {
            const cached = proxyCache.get(exports)
            if (cached) {
                return cached
            }

            if (isBuiltin(spec) || spec.startsWith('synapse:')) {
                const normalized = isBuiltin(spec) && !spec.startsWith('node:') ? `node:${spec}` : spec
                const proxy = createModuleProxy(context, normalized, undefined, exports, isInfra, undefined, solveHostPerms)
                proxyCache.set(exports, proxy)

                return proxy
            }

            if (spec.startsWith(pointerPrefix)) {
                // Need to do this for `.zig` modules because their binding code isn't instrumented
                if (!importer?.endsWith('.zig.js')) {
                    proxyCache.set(exports, exports)
                    return exports
                }

                const proxy = createModuleProxy(context, spec, undefined, exports, isInfra, undefined, solveHostPerms)
                proxyCache.set(exports, proxy)

                return proxy
            }

            const proxy = createModuleProxy(context, spec, virtualId, exports, isInfra, packageResolver, solveHostPerms)
            proxyCache.set(exports, proxy)

            return proxy
        }

        function createVmContext() {
            const _globalThis = createGlobalProxy(globalThis) as typeof globalThis

            function symEval(obj: any, args: any[]) {
                return solvePerms(obj, undefined, args)
            }

            function getPointer(fileName: string, key: string) {
                fileName = sourceToRuntimeFile.get(fileName) ?? fileName
                const actualFile = infraFiles[fileName] ?? fileName
                const filePointers = infraPointers[actualFile]
                if (!filePointers) {
                    throw new Error(`No pointers found for file: ${fileName}`)
                }

                const p = filePointers[key]
                if (!p) {
                    throw new Error(`No pointer found for key "${key}" in ${fileName}`)
                }

                return p
            }

            const getCommandRunner = memoize(() => createNpmLikeCommandRunner(workingDirectory))

            registerSourceMapParser(sourcemapParser, Error)

            let wrappedJson: typeof JSON
            function getWrappedJson() {
                if (typeof tfModule === 'undefined') {
                    return JSON
                }
                return wrappedJson ??= createGlobalProxy({ JSON: wrapJSON(tfModule.Fn, tfModule.internalState) }).JSON
            }

            const getWrappedIo = memoize(() => createSynthLogger(process, _globalThis.console))
            const ctx = vm.createContext({
                Promise,
                URL,
                Set,
                Blob,
                Map,
                Symbol,
                Buffer,
                Object,
                Uint8Array,
                ArrayBuffer,
                Error,
                setTimeout,
                clearTimeout,
                // Initializing `Response` is fairly slow
                get Response() {
                    return Response
                },
                get URLSearchParams() {
                    return URLSearchParams
                },
                get AbortSignal() {
                    return AbortSignal
                },
                get Event() {
                    return Event
                },
                get EventTarget() {
                    return EventTarget
                },
                get TextDecoder() {
                    return TextDecoder
                },
                get TextEncoder() {
                    return TextEncoder
                },
                get console() {
                    return getWrappedIo().console
                },
                get JSON() {
                    return getWrappedJson()
                },
                RegExp: _globalThis.RegExp,
                global: _globalThis,
                globalThis: _globalThis, // Probably shouldn't do this
                get __getCredentials() {
                    return getCredentialsFn()
                },
                __getContext: () => context,
                __createAsset: createAsset,
                __getBuildDirectory: () => outDir,
                __symEval: symEval,
                __createUnknown: createUnknown,
                __getLogger: getLogger,
                __getArtifactFs: () => artifactFs,
                __defer: (fn: () => void) => {
                    const ctx = context.save()
                    deferred.push({ ctx, fn })
                },
                __cwd: () => workingDirectory,
                __buildTarget: buildTarget,
                __deployTarget: deployTarget,
                get __runCommand() {
                    return getCommandRunner()
                },
                __getCurrentId: () => context.getScope(),
                __getPointer: getPointer,
                __getCallerModuleId: context.getModuleId,
                __requireSecret: (envVar: string, type: string) => constructsModule.registerSecret(envVar, type),
                __scope__: context.run,
                __wrapExports: wrapExports,
                __getDefaultProvider: context.providerContext.getDefaultProvider,
                __registerProvider: context.providerContext.registerProvider,
            })

            const globals = vm.runInContext('this', ctx)
            patchBind(globals.Function, globals.Object)

            return {
                globals: _globalThis,
                vm: ctx,
            }
        }

        function createRequire2(importer: string, addWrap = true) {
            return function require2(spec: string) {
                function addSymbol(exports: any, virtualId?: string, isInfra = false) {
                    if (!addWrap) {
                        return exports
                    }
                    return wrapExports(spec, virtualId, exports, isInfra, importer)
                }
    
                if (isBuiltin(spec)) {
                    if (spec === 'buffer' || spec === 'node:buffer') {
                        // Don't add the proxy here, otherwise we have to deal with `instanceof` not working
                        // correctly for `Buffer` with built-in modules
                        return nodeRequire(spec)
                    }
                    if (spec === 'path' || spec === 'node:path') {
                        return addSymbol(wrapPath(tfModule.Fn, tfModule.internalState))
                    }
                    if (spec === 'module' || spec === 'node:module') {
                        return addSymbol(patchModule(createRequire2))
                    }
                    return addSymbol(nodeRequire(spec))
                }

                const location = moduleResolver.resolveVirtual(spec, importer)
                if (cache[location] !== undefined) {
                    return cache[location].exports
                }

                const locationIsPointer = isDataPointer(location)

                const physicalLocation = locationIsPointer 
                    ? toAbsolute(location) 
                    : moduleResolver.getFilePath(location).toString() // XXX: `toString` to convert pointers to primitives

                const cacheKey = locationIsPointer ? location.hash : undefined
                const extname = path.extname(physicalLocation)
                if (extname === '.node') {
                    cache[location] = { exports: addSymbol(nodeRequire(physicalLocation), location) }
                    return cache[location].exports   
                } else if (extname === '.json') {
                    cache[location] = { exports: JSON.parse(getSource(physicalLocation, spec, location)) }
                    return cache[location].exports   
                }
    
                const text = getSource(physicalLocation, spec, location)

                if (typeof text !== 'string') {
                    cache[location] = { exports: addSymbol(text, location) }
                    return cache[location].exports
                }

                // Without the `synapse:` check then we would serialize things like `core.getArtifactFs` incorrectly
                const isInfraSource = isInfra(physicalLocation) && !spec.startsWith('synapse:')
                const replacementsData = targets[physicalLocation] 
                if (replacementsData) {
                    getLogger().log(`Loaded symbol bindings for: ${physicalLocation} [${location}]`, Object.keys(replacementsData))
                }

                function createModuleStub(val: any) {
                    if (!replacementsData || !deployTarget) {
                        return val
                    }
    
                    const targets = getReplacementsForTarget(replacementsData, deployTarget)
                    const desc = {
                        ...Object.getOwnPropertyDescriptors(val),
                        ...Object.fromEntries(
                            Object.entries(targets).map(([k, v]) => {
                                function getVal() {
                                    const val = require2(v.moduleSpecifier)[v.symbolName]
                                    if (terraform.isProviderClass(val)) {
                                        context.providerContext.registerProvider(val)
                                    }

                                    Object.defineProperty(stub, k, { value: val, enumerable: true, configurable: true })

                                    return val
                                }

                                return [k, { get: getVal, enumerable: true, configurable: true }] as const
                            })
                        )
                    }

                    const stub = Object.create(null, desc)

                    return stub
                }

                const require2 = createRequire2(location)
                let wrapped = addSymbol(createModuleStub({}), location, isInfraSource)
                const module_ = {
                        get exports() {
                            return wrapped
                        },
                        set exports(newVal) {
                            wrapped = addSymbol(createModuleStub(newVal), location, isInfraSource)
                        }
                    }

                cache[location] = module_

                return runText(text, physicalLocation, module_, require2, cacheKey)
            }
        }

        function getModuleName(targetModule: string) {
            const moduleName = path.relative(buildTarget.workingDirectory, targetModule)
            if (moduleName.startsWith('..')) {
                throw new Error(`Module is located outside of the current working directory: ${targetModule}`)
            }
            if (isWindows()) {
                return moduleName.replaceAll('\\', '/')
            }
            return moduleName
        }        

        function runText(
            text: string, 
            location: string, 
            module: { exports: {} }, 
            require2 = createRequire2(location),
            cacheKey?: string
        ) {
            const source = runtimeToSourceFile.get(location)
            const moduleName = source ? getModuleName(source) : undefined
            if (source) {
                sourcemapParser.setAlias(infraFiles[location] ?? location, source)
            }

            try {
                const cjs = createScriptModule(ctx.vm, text, source ?? location, require2, codeCache, cacheKey, sourcemapParser, process, undefined, undefined, module)

                runTask(
                    'require', 
                    path.relative(buildTarget.workingDirectory, location), 
                    () => {
                        if (moduleName) {
                            return context.run({ moduleId: moduleName }, cjs.evaluate)
                        }

                        return cjs.evaluate()
                    }, 
                    25
                )
            } catch (e) {
                getLogger().log('failed running file', location)
                throw e
            }

            if (options.generateExports && !!moduleName && !!deployables[location]) {
                const _exports = (module.exports as any)[unproxy]
                createExportResource(location, moduleName, _exports, 'cjs')
            }

            return module.exports
        }

        function createExportResource(location: string, moduleName: string, exports: any, type: 'cjs' | 'esm') {
            const Export = getExportClass()
            const opt = {
                isModule: true,
                source: moduleName,
                id: makeRelative(buildTarget.workingDirectory, location).replace(/\.js$/, ''), 
                publishName: makeRelative(workingDirectory, location).replace(/\.infra\.js$/, '.js'),
            }

            const exportObj = type === 'esm' || (typeof exports === 'object' && exports?.__esModule)
                ? { __esModule: true, ...exports }
                : exports

            context.run({ moduleId: moduleName }, () => new Export(exportObj, opt))
        }

        function getCore() {
            return defaultRequire('synapse:core') as typeof import('synapse:core')
        }

        function getSrl() {
            return defaultRequire('synapse:srl') as typeof import('synapse:srl')
        }

        return { 
            createRequire2, 
            runText, 
            executeDeferred, 
            constructsModule, 
            getHostPerms, 
            getCore, 
            getSrl, 
            getContext: () => context, 
            createLinker, 
            globals: ctx.globals,
        }
    }

    const bootstrapName = '#bootstrap.js'
    const bootstrapPath = path.resolve(outDir, bootstrapName)
    const providerParams = {
        buildDirectory: path.relative(workingDirectory, buildTarget.buildDir),
        outputDirectory: path.relative(workingDirectory, outDir),
    }

    function handleError(e: unknown): never {
        if (!(e instanceof Error && 'serializeStack' in e)) {
            throw e
        }

        const serializeStack = e.serializeStack as any[]
        const top = serializeStack[0]
        if (!top) {
            throw e
        }

        const capturedSet = new Set(serializeStack)
        const visited = new Set<any>()

        const indent = (s: string, depth: number) => `${'  '.repeat(depth)}${s}`
        function printCapturedObject(o: any, depth = 0): string {
            if (visited.has(o)) {
                return indent(`<circular ref>`, depth) // TODO: use the rendered location
            }

            visited.add(o)

            if (typeof o === 'function' && moveable in o) {
                const desc = o[moveable]()
                const module = desc.module
                const location = module ? getArtifactOriginalLocation(module) : undefined
                if (!module || !location) {
                    return indent(require('node:util').inspect(desc), depth)
                }

                const name = o.name || '<anonymous>'

                return `${indent(`${name} at ${location}`, depth)}`

                // return [
                //     `${indent(`${name} at ${location}`, depth)}`,
                //     ...captured.filter(x => capturedSet.has(x)).map(x => printCapturedObject(x, depth))
                // ].join('\n')
            }

            return indent(require('node:util').inspect(o), depth)
        }

        // const s = m.map(y => typeof y === 'string' ? y : require('node:util').inspect(y))
        const newE = new Error((e as any).message, e.cause ? { cause: e.cause } : undefined)
        newE.stack = [
            `${e.name}: ${e.message}`,
            ...serializeStack.filter(x => typeof x === 'function').reverse().map(x => printCapturedObject(x, 1))
        ].join('\n')

        throw newE
    }

    function synth(
        entrypoints: string[], 
        runtime: ReturnType<typeof createRuntime>
    ) {
        runtime.getContext().providerContext.enter()

        const coreProvider = new (runtime.getCore()).Provider(providerParams as any)
        const targetProvider = new (runtime.getSrl()).Provider('#default')
        const req = runtime.createRequire2(bootstrapPath)

        runTask('run', 'bootstrap', () => {
            runtime.getContext().run({ contexts: [coreProvider, targetProvider] }, () => {
                for (const fileName of entrypoints) {
                    req(fileName)
                }
            })

            runtime.executeDeferred()
        })

        try {
            const terraform = runTask('emit', 'synth', () => runtime.constructsModule.emitTerraformJson(), 1)

            return { terraform, permissions: runtime.getHostPerms() }
        } catch (e) {
            handleError(e)
        }
    }

    // TEMPORARY
    async function synthEsm(
        entrypoints: string[], 
        runtime: ReturnType<typeof createRuntime>
    ) {
        runtime.getContext().providerContext.enter()

        const coreProvider = new (runtime.getCore()).Provider(providerParams as any)
        const targetProvider = new (runtime.getSrl()).Provider('#default')
        const linker = runtime.createLinker()

        await runTask('run', 'bootstrap', async () => {
            await runtime.getContext().run({ contexts: [coreProvider, targetProvider] }, async () => {
                for (const fileName of entrypoints) {
                    const esm = await linker.getEsm(getWorkingDir(), fileName)
                    await linker.evaluateEsm(esm)
                }
            })

            runtime.executeDeferred()
        })

        try {
            const terraform = runTask('emit', 'synth', () => runtime.constructsModule.emitTerraformJson(), 50)

            return { terraform, permissions: runtime.getHostPerms() }
        } catch (e) {
            handleError(e)
        }
    }

    return { synth, createRuntime, synthEsm }
}

function wrapJSON(Fn: typeof terraform['Fn'], internalState: typeof terraform.internalState): typeof JSON {
    const parse: typeof JSON['parse'] = (text, reviver) => {
        if (typeof text !== 'function' || !(internalState in text)) {
            return JSON.parse(text, reviver)
        }

        if (reviver) {
            throw new Error(`Using "reviver" is not implemented when decoding resources`)
        }

        return Fn.jsondecode(text)
    }

    const stringify: typeof JSON['stringify'] = (value, replacer, space) => {
        // TODO: implement this by recursively checking if the value contains a resource
        // If so, we need to call `Fn.jsonencode`

        return JSON.stringify(value, replacer as any, space)
    }

    return { 
        parse, 
        stringify,
        [Symbol.toStringTag]: 'JSON',
    }
}

function wrapPath(Fn: typeof terraform['Fn'], internalState: typeof terraform.internalState) {
    const exports = { ...require('path') as typeof import('path') }

    const originalDirname = exports.dirname
    const originalBasename = exports.basename
    const originalRelative = exports.relative
    const originalResolve = exports.resolve

    exports.dirname = function dirname(path: string) {
        if (typeof path === 'function' && internalState in path) {
            return Fn.dirname(path)
        }

        return originalDirname(path)
    }

    exports.basename = function basename(path: string) {
        if (typeof path === 'function' && internalState in path) {
            return Fn.basename(path)
        }

        if (isDataPointer(path)) {
            return path.hash
        }

        return originalBasename(path)
    }

    exports.relative = function relative(from: string, to: string) {
        if ((typeof from === 'function' && internalState in from) || (typeof to === 'function' && internalState in to) ) {
            return Fn.trimprefix(Fn.replace(to, from, ''), '/')
        }

        return originalRelative(from, to)
    }

    exports.resolve = function resolve(...segments: string[]) {
        if (segments.some(s => typeof s === 'function' && internalState in s)) {
            return getWorkingDir() + '/' + segments[segments.length - 1] // XXX: not correct
        }

        return originalResolve(...segments)
    }


    return exports
}

function patchModule(createRequire2: (origin: string) => (id: string) => any): typeof import('node:module') {
    const exports = require('node:module') as typeof import('node:module')
    
    return new Proxy(exports, {
        get: (_, prop) => {
            if (prop === 'createRequire') {
                return function createRequire(origin: string) {
                    const req = exports.createRequire(origin)

                    return Object.assign(createRequire2(origin), {
                        resolve: (id: string) => req.resolve(id)
                    })
                }
            }

            return exports[prop as keyof typeof exports]
        }
    })
}


function isObjectOrNullPrototype(proto: any) {
    return proto === Object.prototype || proto === null || proto.constructor?.name === 'Object'
}

function shouldTrap(value: any): boolean {
    if (typeof value === 'function') {
        // PERF: this hurts perf by ~10%
        // But it's needed to make sure resources aren't instantiated outside of their context
        if (moveable in value) { 
            return false
        }

        return true
    }
    if (Reflect.getOwnPropertyDescriptor(value, moveable2)) {
        return false
    }
    // value instanceof stream.Readable
    if (value instanceof Buffer || value.constructor === Uint8Array || value.constructor === ArrayBuffer) {
        return false
    }
    // if (value.constructor === Promise || value instanceof Error) {
    //     return false
    // }

    // If the value is directly serializable then we do not need to trap it
    const proto = Object.getPrototypeOf(value)
    if (!isObjectOrNullPrototype(proto)) {
        return true
    }

    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const desc of Object.values(descriptors)) {
        if (desc.get || desc.set || _shouldTrap(desc.value)) {
            return true
        }
    }

    return false
}

function createFakeModule(id: string, ctx: ContextStorage) {
    let trappedProto = false

    function createProxy(operations: any[] = [], parent?: any): any {
        const getOps = () => {
            return {
                valueType: 'reflection',
                operations: [
                    { type: 'import', module: id },
                    ...operations
                ],
            }
        }

        const cache = new Map<PropertyKey, any>()

        const inner = function() {}
        const p: any = new Proxy(inner, {
            get: (_, prop) => {
                if (prop === unproxy) {
                    return inner
                } else if (prop === unproxyParent) {
                    return parent
                } else if (prop === moveable2) {
                    return getOps
                }

                if (typeof prop === 'symbol') {
                    return (inner as any)[prop]
                }

                if (cache.has(prop)) {
                    return cache.get(prop)
                }

                const v = createProxy([...operations, { type: 'get', property: prop }], p)
                cache.set(prop, v)

                return v
            },
            apply: () => {
                throw new Error(`Cannot use module "${id}" in this runtime`)
            },
            construct: (target, args, newTarget) => {
                const _target = unwrapProxy(target)
                const _newTarget = unwrapProxy(newTarget)

                const result = createProxy(
                    [...operations, {
                        type: 'construct',
                        args,
                    }],
                    p,
                )

                // XXX: bind context to the instance if `permissions` exists
                const ctor = _newTarget ?? _target
                if (Symbol.for('synapse.permissions') in ctor) {
                    const contexts = Object.fromEntries(Object.entries(ctx.getNamedContexts()).map(([k, v]) => [k, v[0]]))
                    Object.assign(result, { [boundContext]: contexts })
                }

                return result
            },
            has: (target, prop) => {
                if (prop === moveable2 || prop === unproxy || prop === unproxyParent) {
                    return true
                }
    
                return Reflect.has(target, prop)
            },
            // ownKeys: (target) => {
            //     const keys = Reflect.ownKeys(target)
            //     if (!keys.includes(moveable2)) {
            //         return [moveable2, ...keys]
            //     }
            //     return keys
            // },
            getPrototypeOf: () => !trappedProto ? (trappedProto = true, createProxy(operations)) : null,
            getOwnPropertyDescriptor: (target, prop) => {
                if (prop === moveable2) {
                    return { configurable: true, value: getOps }
                }

                return Reflect.getOwnPropertyDescriptor(target, prop)
            },
        })

        return p
    }

    return createProxy()
}

// Any module that we have not compiled is considered "external"
export const moveable = Symbol.for('__moveable__')
function createModuleProxy(ctx: ContextStorage, spec: string, virtualId: string | undefined, value: any, isInfra: boolean, resolver?: PackageResolver, solvePerms?: (target: any, args?: any[]) => any, isNamespace?: boolean) {
    return createSerializationProxy(value, [{
        type: 'import',
        module: spec,
        virtualId,
    }], undefined, isInfra, undefined, ctx, resolver, solvePerms, isNamespace)
}

function createGlobalProxy(value: any) {
    return createSerializationProxy(value, [{ type: 'global' }])
}

export function isProxy(o: any, checkPrototype = false) {
    // TODO: see how much this `try/catch` block hurts perf
    // Simple tests don't show a noticeable change
    // 
    // We only need it because some modules bind JS builtins which we end up trapping.
    // Many of those builtin functions accept primitives as receivers.
    // Not a fan of this "intrinsic" pattern. It only makes things more confusing...

    try {
        return !!o && ((checkPrototype && unproxy in o) || !!Reflect.getOwnPropertyDescriptor(o, moveable2))
    } catch(e) {
        if (typeof o !== 'object' && typeof o !== 'function') {
            return false
        }

        throw e
    }
}

export function unwrapProxy(o: any, checkPrototype = false): any {
    if (isProxy(o, checkPrototype)) {
       return unwrapProxy(o[unproxy])
    }

    return o
}

const c = new WeakMap<any, boolean>()
function _shouldTrap(target: any) {
    if (target === null || (typeof target !== 'function' && typeof target !== 'object')) {
        return false
    }

    const f = c.get(target)
    if (f !== undefined) {
        return f
    }

    const v = shouldTrap(target)
    c.set(target, v)

    return v
}

// `isInfra` can probably be removed

const unproxy = Symbol.for('unproxy')
const moveable2 = Symbol.for('__moveable__2')
const unproxyParent = Symbol.for('unproxyParent')
const boundContext = Symbol.for('synapse.boundContext')
const reflectionType = Symbol.for('reflectionType')

// This is an issue with React when capturing JSX elements:
// TypeError: 'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible
//
// Not really a problem because you're technically not supposed to extract out raw fragments


// Need to do this indirectly because we cannot always trap `defineProperty`
const allDescriptors = new Map<any, Map<PropertyKey, any>>()
function defineProperty(proxy: any, key: PropertyKey, descriptor: PropertyDescriptor) {
    const descriptors = allDescriptors.get(proxy)
    if (!descriptors) {
        return false
    }

    descriptors.set(key, descriptor)
    return true
}

function createSerializationProxy(
    value: any, 
    operations: any[],
    parent?: any, 
    isInfra = false, 
    isProto = false,
    ctx?: ContextStorage,
    resolver?: PackageResolver,
    solvePerms?: (target: any, args?: any[], thisArg?: any) => any,
    isModuleNamespace = false,
): any {
    const cache = new Map<PropertyKey, any>()
    const descriptors = isModuleNamespace ? new Map<PropertyKey, PropertyDescriptor>() : undefined

    const extraHandlers = parent === undefined ? {
        getPrototypeOf: (target: any) => {
            // Only trap modules once
            if (operations.length > 1 || isProto) {
                return Reflect.getPrototypeOf(target)
            }

            return createSerializationProxy(value, operations, parent, isInfra, true, ctx, resolver, solvePerms)
        },
    } : undefined

    let expanded: any
    function expand() {
        return expanded ??= {
            valueType: 'object',
            properties: { ...value },
        }
    }

    function resolveReflection(moduleIdOverride?: string) {
        const op = operations[0]
        if (op.type !== 'import') {
            return {
                valueType: 'reflection',
                operations,
            }
        }

        if (moduleIdOverride) {
            return {
                valueType: 'reflection',
                operations: [
                    { 
                        type: 'import', 
                        ...op,
                        module: moduleIdOverride,
                        location: undefined,
                    },
                    ...operations.slice(1)
                ],
            }
        }

        if (!resolver) {
            return {
                valueType: 'reflection',
                operations,
            }
        }

        const { module } = resolver.reverseLookup(op.module, op.location, op.virtualId)

        return {
            valueType: 'reflection',
            operations: [
                {
                    type: 'import', 
                    module,
                },
                ...operations.slice(1)
            ],
        }
    }

    function getMoveableDescFn() {
        // This is currently used for the generated Terraform classes
        const moduleOverride = parent?.[Symbol.for('moduleIdOverride')] ?? value?.[Symbol.for('moduleIdOverride')]
        // TODO: is this still needed (yes it is)
        // Runtime failures happen without it, e.g. `throw __scope__("Error", () => new Error("No target set!"));` 
        if (isInfra && !moduleOverride) {
            cache.set(moveable2, expand)
            cache.set(reflectionType, undefined)
            return expand
        }

        const fn = () => resolveReflection(moduleOverride)
        cache.set(moveable2, fn)
        cache.set(reflectionType, operations[0].type)

        return fn
    }

    const moveableDesc = { 
        configurable: true, 
        get: getMoveableDescFn,
    }

    const p: any = new Proxy(value, {
        ...extraHandlers,
        get: (target, prop, recv) => {
            if (cache.has(prop)) {
                return cache.get(prop)!
            }

            if (prop === unproxy) {
                return value
            } else if (prop === unproxyParent) {
                return parent
            } else if (prop === reflectionType) {
                const moduleOverride = parent?.[Symbol.for('moduleIdOverride')] ?? value?.[Symbol.for('moduleIdOverride')]
                if (isInfra && !moduleOverride) {
                    cache.set(moveable2, expand)
                    cache.set(reflectionType, undefined)
                    return undefined
                }

                const fn = () => resolveReflection(moduleOverride)
                cache.set(moveable2, fn)
                cache.set(reflectionType, operations[0].type)

                return operations[0].type
            } else if (prop === moveable2) {
                return getMoveableDescFn()
            } else if (descriptors?.has(prop)) {
                const desc = descriptors.get(prop)!
                const result = desc.get ? desc.get() : desc.value
                if (!_shouldTrap(result)) {
                    return result
                }

                const sub = createSerializationProxy(
                    result,
                    [...operations, {
                        type: 'get',
                        property: prop,
                    }],
                    p,
                    isInfra,
                    isProto,
                    ctx,
                    resolver,
                    solvePerms,
                )
                cache.set(prop, sub)
    
                return sub
            }

            const result = target[prop]
            // Needed to avoid an infinite loop from the AWS SDK
            if (prop === 'valueOf') {
                return result
            }

            // Only capture bind if we're referencing `bind` on `Function`
            // if (prop === 'bind' && result === functionBind) {
            //     const bind: typeof functionBind<any, any[], any[], any> = function bind(thisArg, ...args) {

            //     }
            //     cache.set(prop, bind)

            //     return bind
            // }

            // Checking the descriptor is needed otherwise an error is thrown on non-proxyable descriptors
            const desc = Reflect.getOwnPropertyDescriptor(target, prop)
            if (typeof prop === 'symbol' || (desc?.configurable === false && desc.writable === false) || !_shouldTrap(result)) {
                return result
            }

            const sub = createSerializationProxy(
                result,
                [...operations, {
                    type: 'get',
                    property: prop,
                }],
                p,
                isInfra,
                isProto,
                ctx,
                resolver,
                solvePerms,
            )
            cache.set(prop, sub)

            return sub
        },
        apply: (target, thisArg, args) => {
            const result = Reflect.apply(target, unwrapProxy(thisArg, true), args)
            if (!_shouldTrap(result)) {
                return result
            }

            return createSerializationProxy(
                result,
                [...operations, {
                    type: 'apply',
                    args,
                    thisArg,
                }],
                p,
                isInfra,
                isProto,
                ctx,
                resolver,
                solvePerms,
            )
        },
        construct: (target, args, newTarget) => {
            // Assumption: `target` === `newTarget`
            const _target = unwrapProxy(target)
            const _newTarget = unwrapProxy(newTarget)

            const result = Reflect.construct(_target, args, _newTarget)

            // XXX: bind context to the instance if `permissions` exists
            const ctor = _newTarget ?? _target
            if (result && typeof result === 'object' && Symbol.for('synapse.permissions') in ctor) {
                const contexts = Object.fromEntries(Object.entries(ctx?.getNamedContexts() ?? {}).map(([k, v]) => [k, v[0]]))
                Object.assign(result, { [boundContext]: contexts })

                const cm = ctor[Symbol.for('synapse.permissions')].$constructor
                if (cm !== undefined) {
                    solvePerms?.(ctor, args, result)
                }
            }

            // if (!shouldTrap(result)) {
            //     return result
            // }

            return createSerializationProxy(
                result,
                [...operations, {
                    type: 'construct',
                    args,
                }],
                p,
                isInfra,
                isProto,
                ctx,
                resolver,
                solvePerms,
            )
        },
        has: (target, prop) => {
            if (prop === moveable2 || prop === unproxy || prop === unproxyParent) {
                return true
            }

            return Reflect.has(target, prop)
        },
        set: (target, prop, newValue, recv) => {
            cache.delete(prop)

            return Reflect.set(target, prop, newValue, recv)
        },
        getOwnPropertyDescriptor: (target, prop) => {
            if (prop === moveable2) {
                return moveableDesc
            }

            return Reflect.getOwnPropertyDescriptor(target, prop)
        },
        // TODO: deleteProperty
    })

    if (descriptors) {
        allDescriptors.set(p, descriptors)
    }

    return p
}

function createLazyEvalModule(fn: () => any) {
    let val: any = undefined
    let didInit = false
    const state: any = {}
    const init = () => {
        didInit = true
        val = fn()

        // Note: we are not preserving the order of operations here
        // this could potentially cause issues
        Object.setPrototypeOf(val, Object.getPrototypeOf(state))
        Object.defineProperties(val, Object.getOwnPropertyDescriptors(state))

        return val
    }

    return new Proxy(state, {
        get: (_, prop) => {
            if (didInit) {
                return val[prop]
            }

            if (prop in state) {
                return state[prop]
            }

            return init()[prop]
        },
        has: (_, prop) => {
            if (didInit) {
                return prop in val
            }

            if (prop in state) {
                return true
            }

            return prop in init()
        },
        ownKeys: () => {
            if (didInit) {
                return Reflect.ownKeys(val)
            }

            return Reflect.ownKeys(init())
        },
        getOwnPropertyDescriptor: (_, prop) => {
            if (didInit) {
                return Object.getOwnPropertyDescriptor(val, prop)
            }

            if (Object.hasOwn(state, prop)) {
                return Object.getOwnPropertyDescriptor(state, prop)
            }

            return Object.getOwnPropertyDescriptor(init(), prop)
        },
        setPrototypeOf: (_, v) => {
            if (didInit) {
                return Object.setPrototypeOf(val, v)
            }
            
            return Object.setPrototypeOf(state, v)
        },
        apply: (_, thisArg, args) => {
            if (didInit) {
                return Reflect.apply(val, thisArg, args)
            }

            return Reflect.apply(fn(), thisArg, args)
        },

    })
}

function patchBind(FunctionCtor: typeof Function, ObjectCtor: typeof Object) {
    const original = FunctionCtor.prototype.bind
    FunctionCtor.prototype.bind = function (thisArg, ...args) {
        const m = ObjectCtor.getOwnPropertyDescriptor(this, moveable)?.value
        const bound = original.apply(this, arguments as any)
        if (!m) {
            return bound
        }

        bound[moveable] = () => {
            const desc = m()
            if (desc.valueType === 'function') {
                return {
                    valueType: 'bound-function',
                    boundTarget: this,
                    boundArgs: args,
                    boundThisArg: thisArg,
                }
            }

            return {
                valueType: 'bound-function',
                boundTarget: desc.boundTarget,
                boundArgs: [...desc.boundArgs, ...args],
                boundThisArg: desc.boundThisArg,
            }
        }

        return bound
    }

    return { dispose: () => void (FunctionCtor.prototype.bind = original) }
}

interface Context {
    readonly moduleId?: string
    readonly scope: string[]
    readonly symbols: terraform.Symbol[]
    readonly scope2: Scope[]
    readonly namedContexts: Record<string, any[]>
}

const contextSym = Symbol.for('synapse.context')
const contextTypeSym = Symbol.for('synapse.contextType')

function getContextType(o: any, visited = new Set<any>()): string | undefined {
    if (!o || (typeof o !== 'object' && typeof o !== 'function') || visited.has(o)) {
        return
    }

    // FIXME
    if (visited.size > 10) {
        return
    }

    const unproxied = unwrapProxy(o)
    visited.add(unproxied)

    return o[contextTypeSym] ?? getContextType(unproxied.constructor, visited)
}

interface ContextHooks {
    onExitScope?: (context: Context, result: any) => void
}

type ContextStorage = ReturnType<typeof createContextStorage>
function createContextStorage(
    hooks: ContextHooks = {},
    workingDir: string
) {
    const storage = new AsyncLocalStorage<Context>()
    const providerContext = createProviderContextStorage()

    const getNamedContexts = () => storage.getStore()?.namedContexts ?? {}

    function mergeContexts(left: any, right: any) {
        for (const [k, v] of Object.entries(right)) {
            // This is reversed so we pick the newest context first
            left[k] = [v, ...(left[k] ?? [])]
        }
    }

    function getNewNamedContexts(scope: Pick<Scope, 'contexts'>, oldContexts: Context['namedContexts']) {
        if (!scope.contexts) {
            return oldContexts
        }

        const namedContexts = { ...oldContexts }
        for (const ctx of scope.contexts) {
            const contextType = getContextType(ctx)
            const contextContribution = ctx[contextSym]
            if (!contextType && !contextContribution) {
                throw new Error(`Object does not contribute a context: ${ctx}`)
            }

            if (contextType) {
                mergeContexts(namedContexts, { [contextType]: ctx })
            }
            if (contextContribution) {
                for (const ctx2 of contextContribution) {
                    const contextType = getContextType(ctx2)
                    if (!contextType) {
                        throw new Error(`Object does not contribute a context: ${ctx2}`)
                    }
                    mergeContexts(namedContexts, { [contextType]: ctx2 })
                }
            }
        }

        return namedContexts
    }

    function run<T extends any[], U>(scope: Scope, fn: (...args: T) => U, ...args: T): U {
        const oldStore = storage.getStore()

        const namedContexts = getNewNamedContexts(scope, oldStore?.namedContexts ?? {})

        const symbols = oldStore?.symbols ?? []
        const scope2 = [...(oldStore?.scope2 ?? []), scope]
        const context: Context = {
            scope2,
            namedContexts,
            moduleId: scope.moduleId ?? oldStore?.moduleId,
            symbols: scope.symbol ? [...symbols, scope.symbol] : symbols,
            scope: [...(oldStore?.scope ?? []), scope.name ?? ''],
        }

        const result = storage.run(context, fn, ...args)

        if (hooks.onExitScope) {
            const handler = hooks.onExitScope
            if (util.types.isPromise(result)) {
                result.then(v => handler(context, v))
            } else {
                handler(context, result)
            }
        }

        return result
    }

    function getScope() {
        const id = getId()
        if (!id) {
            throw new Error('Not within a scope')
        }

        return id
    }

    function getId(pos?: number) {
        const scope = storage.getStore()?.scope.filter(x => !!x)
        const sliced = pos && scope ? scope.slice(0, pos) : scope
        if (!sliced || sliced.length === 0) {
            return ''
        }

        const id = sliced.join('--')
        const moduleId = getModuleId()

        return moduleId ? `${moduleId.replace(/\//g, '--').replace(/\.(.*)$/, '')}_${id}` : id
    }

    // TODO: this should ideally be apart of `scope`
    function getModuleId() {
        return storage.getStore()?.moduleId
    }

    function mapSymbol(sym: NonNullable<Scope['symbol']>): NonNullable<Scope['symbol']> {
        return {
            ...sym,
            fileName: path.relative(workingDir, sym.fileName),
        }
    }

    function getScopes() {
        const scopes = storage.getStore()?.scope2
        if (!scopes) {
            return []
        }

        return scopes.map(s => ({ 
            isNewExpression: s.isNewExpression,
            callSite: s.symbol ? mapSymbol(s.symbol) : undefined, 
            assignment: s.assignmentSymbol ? mapSymbol(s.assignmentSymbol) : undefined,
            namespace: s.namespace?.map(mapSymbol),
        }))
    }

    function get(type: keyof Context['namedContexts']) {
        return getNamedContexts()?.[type]
    }

    function save(): Context {
        const ctx = storage.getStore()
        if (!ctx) {
            throw new Error('Not within a context')
        }

        return ctx
    }

    function restore<T>(ctx: Context, fn: () => T): T {
        return storage.run(ctx, fn)
    }

    return {
        save,
        restore,

        run,
        get,
        getId,
        getScope,
        getScopes,
        getModuleId,
        getNamedContexts,

        providerContext,
    }
}

// does `a` subclass `b`?
function isSubclass(a: new (...args: any[]) => any, b: new (...args: any[]) => any, visited = new Set<any>()) {
    if (!a.prototype) {
        return false
    }

    if (visited.has(a)) {
        return false
    }

    visited.add(a)

    const proto = Object.getPrototypeOf(a.prototype)
    if (proto === null) {
        return false
    }
    
    if (proto === b.prototype) {
        return true
    }

    const next = Object.getPrototypeOf(a)
    if (next === null) {
        return false
    }

    return isSubclass(next, b, visited)
}

interface ProviderContext {
    defaultProviders: Map<string, any | undefined>
    registeredProviders: Map<string, new () => any>
    didCopy?: boolean
}

function createProviderContextStorage() {
    const storage = new AsyncLocalStorage<ProviderContext>()

    function doCopy(ctx: ProviderContext) {
        if (ctx.didCopy) {
            return
        }

        ctx.defaultProviders = new Map(ctx.defaultProviders)
        ctx.registeredProviders = new Map(ctx.registeredProviders)
        ctx.didCopy = true
    }

    function registerProvider(cls: new () => any) {
        const ctx = storage.getStore()
        if (!ctx) {
            return false
        }

        const type = getContextType(cls)
        if (!type) {
            throw new Error(`Failed to register provider "${cls.name}": missing context type`)
        }
        
        // TODO: think more about this 
        // if (ctx.registeredProviders.has(type)) {
        //     const existingClass = ctx.registeredProviders.get(type)!
        //     if (cls === existingClass) {
        //         return true
        //     }

        //     if (!isSubclass(cls, existingClass)) {
        //         throw new Error(`Failed to register provider "${cls.name}": a provider for type "${type}" already exists: ${existingClass.name}`)
        //     }
        // }

        doCopy(ctx)
        ctx.registeredProviders.set(type, cls)

        return true
    }

    function getDefaultProvider(type: string) {
        const ctx = storage.getStore()
        if (!ctx) {
            return
        }

        if (ctx.defaultProviders.has(type)) {
            return ctx.defaultProviders.get(type)
        }

        doCopy(ctx)

        const c = ctx.registeredProviders.get(type)
        if (!c) {
            ctx.defaultProviders.set(type, undefined)
            return
        }

        const inst = new c()
        ctx.defaultProviders.set(type, inst)

        return inst
    }

    function enter() {
        const ctx: ProviderContext = {
            defaultProviders: new Map(),
            registeredProviders: new Map(),
        }

        storage.enterWith(ctx)
    }

    return {
        enter,
        registerProvider,
        getDefaultProvider,
    }
}
