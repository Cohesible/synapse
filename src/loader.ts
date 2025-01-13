import * as path from 'node:path'
import * as vm from 'node:vm'
import { createRequire, isBuiltin } from 'node:module'
import * as terraform from './runtime/modules/terraform'
import { AsyncLocalStorage } from 'node:async_hooks'
import { runTask, getLogger, LogLevel } from './logging'
import { PackageResolver, PackageService } from './pm/packages'
import { BuildTarget, LocalWorkspace, getV8CacheDirectory, getWorkingDir } from './workspaces'
import type { Scope } from './runtime/modules/core'
import { ReplacementSymbol, TargetsFile } from './compiler/host'
import { Module, ModuleCreateOptions, SourceMapParser, createGetCredentials, createModuleLinker, createScriptModule, createSyntheticCjsModule, getArtifactOriginalLocation, registerSourceMapParser } from './runtime/loader'
import { BuildFsFragment } from './artifacts'
import { Mutable, dedupe, getHash, isNonNullable, isWindows, makeRelative, memoize, wrapWithProxy } from './utils'
import { ModuleResolver } from './runtime/resolver'
import { createAuth, getAuth } from './auth'
import { CodeCache, createCodeCache } from './runtime/utils'
import { getFs } from './execution'
import { coerceToPointer, isDataPointer, pointerPrefix, toAbsolute } from './build-fs/pointers'
import { createNpmLikeCommandRunner } from './pm/publish'
import { createUnknown, isUnknown } from './static-solver'
import { diffLines } from './utils/diffs'

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
        log: (...args: any[]) => logEvent({ level: LogLevel.Info, args }),
        warn: (...args: any[]) => logEvent({ level: LogLevel.Warn, args }),
        error: (...args: any[]) => logEvent({ level: LogLevel.Error, args }),
        debug: (...args: any[]) => logEvent({ level: LogLevel.Debug, args }),
        trace: (...args: any[]) => logEvent({ level: LogLevel.Trace, args }),
    }
    
    const consoleWrap = wrapWithProxy(c, logMethods)
    // TODO: wrap process

    return { console: consoleWrap, stdout: p.stdout, stderr: p.stderr }
}

function wrapProcess(proc: typeof process, workingDir: string) {
    // We'll track values globally for now because synthesis is still global
    const capturedEnv = new Map<string, string | undefined>()

    function capture(key: PropertyKey) {
        const val = proc.env[key as any]
        if (typeof key !== 'string' || (typeof val !== 'string' && typeof val !== 'undefined')) {
            return val
        }

        // Only remember the first value in case it gets mutated
        if (!capturedEnv.has(key)) {
            capturedEnv.set(key, val)
        }

        return val
    }

    const env = new Proxy(proc.env, {
        get: (_, key) => capture(key),
        has: (_, key) => {
            if (typeof key !== 'string') {
                return key in proc.env
            }

            capture(key)

            return key in proc.env
        }
    })

    const cwd = () => workingDir

    return {
        process: wrapWithProxy(proc, { env, cwd }),
        getCapturedEnvVars: () => capturedEnv.size === 0 ? undefined : Object.fromEntries(capturedEnv),
    } 
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
    sourcemapParser: SourceMapParser,
    options: LoaderOptions = {}
) {
    const {
        deployTarget, 
        workingDirectory = getWorkingDir(),
        outDir = workingDirectory,
    } = options
    
    if (!deployTarget) {
        throw new Error(`Missing deploy target`)
    }

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
        sourceMapping: Record<string, { module: string }>
    ) {
        const runtimeToSourceFile = new Map(sources.map(s => [s.name, s.source]))
        const sourceToRuntimeFile = new Map(sources.map(s => [s.source, s.name]))

        const context = createContextStorage(workingDirectory, runtimeToSourceFile, moduleResolver, sourceMapping)

        const wrappedProc = wrapProcess(process, workingDirectory)

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

        function getScopedId(type: string, kind: terraform.TerraformElement['kind'], suffix?: string, peek?: boolean) {
            if (peek) {
                return context.peekName(type, kind, suffix)
            }

            return context.generateName(type, kind, suffix)
        }

        const terraformState = createTerraformState()
        const tfGlobals =[
            () => terraformState,
            getScopedId,
            () => context.getModuleId(),
            () => context.getNamedContexts(),
            () => context.getScopes(),
            unwrapProxy,
        ] as const

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
                const mod = new vm.SyntheticModule(
                    Object.keys(symbols), 
                    () => {}, 
                    { context: opt?.context?.vm ?? ctx.vm, identifier: m.name }
                )

                await mod.link((() => {}) as any)
                const proxy = wrapNamespace(m.id, mod.namespace)
                const req = createRequire2(m.id, false)
                for (const [k, v] of Object.entries(symbols)) {
                    defineProperty(proxy, k, {
                        enumerable: true,
                        configurable: true,
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
                        return context.run({ moduleId: moduleName }, async () => {
                            await evaluate(opt)

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
            solvePerms(target, undefined, args, thisArg)
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
                queueMicrotask,
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
                performance: _globalThis.performance,
                get __getCredentials() {
                    return getCredentialsFn()
                },
                __getContext: () => context,
                __createAsset: createAsset,
                __getBuildDirectory: () => outDir,
                __symEval: symEval,
                __createUnknown: createUnknown,
                __isUnknown: isUnknown,
                __getLogger: getLogger,
                __getArtifactFs: () => artifactFs,
                __defer: (fn: () => void) => {
                    const ctx = context.save()
                    deferred.push({ ctx, fn })
                },
                __buildTarget: buildTarget,
                __deployTarget: deployTarget,
                get __runCommand() {
                    return getCommandRunner()
                },
                __getCurrentId: context.getScope,
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

        function registerLazyProvidersCjs() {
            const providerTarget = targets['synapse:srl']['Provider']
            for (const [k, v] of Object.entries(providerTarget)) {
                if (k === deployTarget) continue
                context.providerContext.registerLazyProvider(k, () => defaultRequire(v.moduleSpecifier)[v.symbolName])
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

                function createStubProps() {
                    if (!replacementsData) {
                        return
                    }
    
                    const targets = getReplacementsForTarget(replacementsData, deployTarget!)

                    return Object.fromEntries(Object.entries(targets).map(([k, v]) => {
                        function getVal(this: any) {
                            const val = require2(v.moduleSpecifier)[v.symbolName]
                            Object.defineProperty(this, k, { value: val, enumerable: true, configurable: true })

                            return val
                        }

                        return [k, { get: getVal, enumerable: true, configurable: true }] as const
                    }))
                }

                const stubProps = createStubProps()

                function createModuleStub(val: any) {
                    if (!stubProps) {
                        return val
                    }
    
                    return Object.defineProperties(val, stubProps)
                }

                const require2 = createRequire2(location)
                let wrapped = addSymbol(createModuleStub({}), location, isInfraSource)
                const module_ = {
                    __virtualId: location,
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
            module: { __virtualId: string; exports: {} }, 
            require2 = createRequire2(location),
            cacheKey?: string
        ) {
            const source = runtimeToSourceFile.get(location)
            const moduleName = source ? getModuleName(source) : undefined
            if (source) {
                sourcemapParser.setAlias(infraFiles[location] ?? location, source)
            }

            try {
                const cjs = createScriptModule(
                    ctx.vm, 
                    text, 
                    source ?? location, 
                    require2,
                    codeCache, 
                    cacheKey, 
                    sourcemapParser, 
                    wrappedProc.process, 
                    undefined, 
                    undefined, 
                    module,
                )

                runTask(
                    'require', 
                    path.relative(buildTarget.workingDirectory, location), 
                    () => {
                        if (moduleName) {
                            return context.run({ moduleId: moduleName }, cjs.evaluate)
                        } else if (sourceMapping[location]) {
                            return context.run({ virtualId: module.__virtualId }, cjs.evaluate)
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

            return context.run({ moduleId: moduleName }, () => new Export(exportObj, opt))
        }

        function getCore() {
            return defaultRequire('synapse:core') as typeof import('synapse:core')
        }

        function getSrl() {
            return defaultRequire('synapse:srl') as typeof import('synapse:srl')
        }

        return { 
            createRequire2, 
            executeDeferred, 
            constructsModule, 
            getHostPerms, 
            getCore, 
            getSrl, 
            getContext: () => context, 
            createLinker, 
            globals: ctx.globals,
            getCapturedEnvVars: wrappedProc.getCapturedEnvVars,
            tfModule,
            registerLazyProvidersCjs,
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
        runtime.registerLazyProvidersCjs()

        const coreProvider = new (runtime.getCore()).Provider(providerParams as any)
        const targetProvider = new (runtime.getSrl()).Provider()
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

            return { 
                terraform, 
                permissions: runtime.getHostPerms(),
                envVars: runtime.getCapturedEnvVars(),
            }
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
        const targetProvider = new (runtime.getSrl()).Provider()
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

            return { 
                terraform, 
                permissions: runtime.getHostPerms(),
                envVars: runtime.getCapturedEnvVars(),
            }
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

function shouldProxy(value: any): boolean {
    if (typeof value === 'function') {
        // PERF: this hurts perf by ~10%
        // But it's needed to make sure resources aren't instantiated outside of their context
        if (Object.hasOwn(value, moveable)) { 
            return false
        }

        return true
    }

    // TODO: doing this check first and removing the recursion in `unwrapProxy` is a bit
    // faster for `--target aws` in many cases. But we break capturing `react` without it
    // because `react` assigns directly to `module.exports` for CJS modules.
    if (proxies.has(value)) {
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
        if (desc.get || desc.set || _shouldProxy(desc.value)) {
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
    if (proxies.has(o)) {
        return true
    }

    if (!checkPrototype) {
        return false
    }

    // TODO: see how much this `try/catch` block hurts perf
    // Simple tests don't show a noticeable change
    // 
    // We only need it because some modules bind JS builtins which we end up proxying.
    // Many of those builtin functions accept primitives as receivers.
    // Not a fan of this "intrinsic" pattern. It only makes things more confusing...

    try {
        return o && unproxy in o
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
function _shouldProxy(target: any) {
    if (target === null || (typeof target !== 'function' && typeof target !== 'object')) {
        return false
    }

    if (c.has(target)) {
        return c.get(target)
    }

    const v = shouldProxy(target)
    c.set(target, v)

    return v
}

// `isInfra` can probably be removed

const unproxy = Symbol.for('unproxy')
const moveable2 = Symbol.for('__moveable__2')
const unproxyParent = Symbol.for('unproxyParent')
const boundContext = Symbol.for('synapse.boundContext')
const reflectionType = Symbol.for('reflectionType')
const moduleIdOverride = Symbol.for('moduleIdOverride')

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

// FIXME: this is an obvious memory leak
const proxies = new Map<any, any>()
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
        const moduleOverride = parent?.[moduleIdOverride] ?? value?.[moduleIdOverride]
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
                const moduleOverride = parent?.[moduleIdOverride] ?? value?.[moduleIdOverride]
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
                if (!_shouldProxy(result)) {
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
            if (typeof prop === 'symbol' || (desc?.configurable === false && desc.writable === false) || !_shouldProxy(result)) {
                cache.set(prop, result)
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
            if (!_shouldProxy(result)) {
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
        // TODO: deleteProperty, defineProperty
    })

    if (descriptors) {
        allDescriptors.set(p, descriptors)
    }

    proxies.set(p, value)

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
    readonly namedContexts: Record<string, any[]>
    readonly scopes?: Scope[]
    readonly moduleId?: string
    readonly virtualId?: string
    readonly declarationScope?: terraform.Symbol[] // Used for singletons
    
    // Inline cache
    cachedScopes?: terraform.ExecutionScope[]
}

const contextSym = Symbol.for('synapse.context')
const contextTypeSym = Symbol.for('synapse.contextType')

function getContextType(o: any, visited = new Set<any>()): string | undefined {
    if (!o || (typeof o !== 'object' && typeof o !== 'function') || visited.has(o)) {
        return
    }

    const unproxied = unwrapProxy(o)
    visited.add(unproxied)

    return unproxied[contextTypeSym] ?? getContextType(unproxied.constructor, visited)
}

// For singletons we want to key the resource using the package identifier + 
// module id of the callsite. This only becomes problematic when multiple 
// versions of a package exist in a module graph _and_ the instantiations 
// are incompatible. But that's a problem for another day.
//
// We can include the package version in the key after having a robust 
// solution for automatically migrating resources, particularly for resource 
// instantiations within packages.
//
// All resource instantiations in the top-level scope of a module are effectively
// singletons because module evaluation is cached and invariant to the caller.
//
// For modules in the "root" package, we handle this case by using `moduleId`.
// But we still need to handle modules loaded in all other packages.


type ContextStorage = ReturnType<typeof createContextStorage>
function createContextStorage(
    workingDir: string,
    runtimeToSourceFile: Map<string, string>,
    resolver: ModuleResolver, // Needed for mapping absolute file paths to relative specifiers
    sourceMapping: Record<string, { module: string }>
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

    function getNewScopes(scope: Scope & { virtualId?: string }, oldScopes?: Scope[]) {
        if (!scope.symbol) {
            return oldScopes
        }

        return oldScopes ? [...oldScopes, scope] : [scope]
    }

    function run<T extends any[], U>(scope: Scope & { virtualId?: string }, fn: (...args: T) => U, ...args: T): U {
        const oldStore = storage.getStore()
        const namedContexts = getNewNamedContexts(scope, oldStore?.namedContexts ?? {})

        // Reset execution scopes when evaluating a module
        if (scope.virtualId || scope.moduleId) {
            const context: Context = {
                namedContexts,
                moduleId: scope.moduleId,
                virtualId: scope.virtualId,
            }
    
            return storage.run(context, fn, ...args)
        }

        const scopes = getNewScopes(scope, oldStore?.scopes)

        const context: Context = {
            scopes,
            namedContexts,
            moduleId: scope.moduleId ?? oldStore?.moduleId,
            virtualId: scope.virtualId ?? oldStore?.virtualId,
            declarationScope: scope.declarationScope ?? oldStore?.declarationScope,
            cachedScopes: scopes === oldStore?.scopes ? oldStore?.cachedScopes : undefined,
        }

        return storage.run(context, fn, ...args)
    }

    function getScope(): string {
        const id = getId()
        if (!id) {
            throw new Error('Not within a scope')
        }

        return id
    }

    function getKeyFromScopes(scopes: Scope[]) {
        if (scopes.length === 0) {
            throw new Error('No scopes provided')
        }
    
        const parts: string[] = []
        for (let i = 0; i < scopes.length; i++) {
            const s = scopes[i]

            if (s.assignmentSymbol) {
                parts.push(s.assignmentSymbol.name)
            }

            if (s.namespace) {
                for (let j = 0; j < s.namespace.length; j++) {
                    parts.push(s.namespace[j].name)
                }
            }

            parts.push(s.symbol!.name)
        }
    
        return parts.join('--')
    }

    // `pos` is assumed to be a negative number
    function getId(pos?: number) {
        const store = storage.getStore()

        if (store?.declarationScope && store.scopes) {
            const index = store.scopes.findIndex(x => x.declarationScope === store.declarationScope)
            const sliced = store.scopes.slice(index + 1, pos ?? store.scopes.length)
            if (!sliced.length) {
                return getSingletonId(store.scopes[index])
            }
            
            return getSingletonId(store.scopes[index], getKeyFromScopes(sliced))
        }
    
        const moduleId = getModuleId2()
        const scopes = store?.scopes
        const sliced = pos && scopes ? scopes.slice(0, pos) : scopes
        if (!sliced?.length) {
            return moduleId
        }

        const id = getKeyFromScopes(sliced)

        return `${moduleId ? `${moduleId}_` : ''}${id}`
    }

    function getSingletonId(scope: Scope, suffix?: string) {
        if (!scope.symbol || !scope.declarationScope) {
            return
        }

        const mapped = mapSymbol(scope.symbol)
        const declPart = scope.declarationScope!.map(s => s.name)
        const firstPart = mapped.packageRef ?? mapped.specifier
        const lastPart = `${mapped.fileName}_${(suffix ? [...declPart, suffix] : declPart).join('--')}`

        return `${firstPart ? `${firstPart}#` : ''}${lastPart}`
    }

    // TODO: this should ideally be apart of `scope`
    function getModuleId() {
        return storage.getStore()?.moduleId
    }

    function getModuleId2() {
        const store = storage.getStore()
        if (!store?.virtualId) {
            return store?.moduleId
        }

        const reversed = resolver.reverseLookup(store.virtualId)
        if (!reversed?.fileName) {
            return reversed?.specifier ?? store?.moduleId
        }

        const info = reversed.source
        const packageRef = info?.type === 'package' && info.data.type !== 'file'
            ? `${info.data.type}:${info.data.name}` 
            : undefined

        let fileName = reversed.fileName
        if (reversed.location) {
            fileName = sourceMapping[path.resolve(reversed.location, reversed.fileName)]?.module ?? fileName
        }

        if (process.platform === 'win32') {
            fileName = fileName.replaceAll('\\', '/')
        }

        return `${packageRef ?? reversed.specifier}#${fileName}`
    }

    const symbolCache = new Map<string, NonNullable<terraform.Symbol>>()
    function mapSymbol(sym: NonNullable<terraform.Symbol>): NonNullable<terraform.Symbol> {
        const key = `${sym.fileName}:${sym.line}:${sym.column}`
        if (symbolCache.has(key)) {
            return symbolCache.get(key)!
        }

        const reversed = resolver.reverseLookup(sym.fileName)
        if (!reversed?.fileName && !reversed?.source) {
            const resolved = runtimeToSourceFile.get(sym.fileName) ?? sym.fileName
            const mapped = {
                ...sym,
                fileName: path.relative(workingDir, resolved),
            }
            symbolCache.set(key, mapped)

            if (process.platform === 'win32') {
                mapped.fileName = mapped.fileName.replaceAll('\\', '/')
            }
    
            return mapped
        }

        const info = reversed.source
        const packageRef = info?.type === 'package' && info.data.type !== 'file'
            // ? `${info.data.type}:${info.data.name}@${info.data.version || '0.0.0'}` 
            ? `${info.data.type}:${info.data.name}` 
            : undefined

        if (reversed.fileName && reversed.location) {
            const fileName = sourceMapping[path.resolve(reversed.location, reversed.fileName)]?.module ?? reversed.fileName
            const mapped = {
                ...sym,
                fileName,
                specifier: reversed?.specifier,
                packageRef,
            }

            if (process.platform === 'win32') {
                mapped.fileName = mapped.fileName.replaceAll('\\', '/')
            }
    
            symbolCache.set(key, mapped)
    
            return mapped
        }

        const mapped = {
            ...sym,
            fileName: !reversed?.fileName ? path.relative(workingDir, sym.fileName) : reversed.fileName,
            specifier: reversed?.specifier,
            packageRef,
        }

        symbolCache.set(key, mapped)

        if (process.platform === 'win32') {
            mapped.fileName = mapped.fileName.replaceAll('\\', '/')
        }

        return mapped
    }

    function mapScope(s: Scope) {
        return {
            isNewExpression: s.isNewExpression,
            callSite: mapSymbol(s.symbol!),
            assignment: s.assignmentSymbol ? mapSymbol(s.assignmentSymbol) : undefined,
            namespace: s.namespace?.map(mapSymbol),
        }
    }

    function getScopes(): terraform.ExecutionScope[] {
        const store = storage.getStore()
        const scopes = store?.scopes
        if (!scopes) {
            return []
        }

        if (store.cachedScopes) {
            return store.cachedScopes
        }

        if (store.declarationScope) {
            const index = store.scopes.findIndex(x => x.declarationScope === store.declarationScope)
            const startIndex = index + 1

            return store.cachedScopes = [
                {
                    ...mapScope(store.scopes[index]),
                    declaration: store.declarationScope.map(mapSymbol),
                },
                ...store.scopes.slice(startIndex).map(mapScope)
            ]
        }

        return store.cachedScopes = scopes.map(mapScope)
    }

    function getDeclScopeKey() {
        const lastScope = storage.getStore()?.scopes?.at(-1)
        if (!lastScope?.declarationScope) {
            return
        }

        return getSingletonId(lastScope)
    }

    const names = new Map<string, number>()
    function addName(name: string) {
        if (!names.has(name)) {
            names.set(name, 1)
        } else {
            names.set(name, names.get(name)! + 1)
        }
    }

    function getUniqueName(type: string, kind: terraform.TerraformElement['kind'], prefix?: string, suffix?: string, shouldAdd = false) {
        const resolvedPrefix = prefix ?? `${kind === 'provider' ? '' : `${kind}-`}${type}`
        const base = `${resolvedPrefix || 'default'}${suffix ? `--${suffix}` : ''}`
        const key = `${kind}.${type}.${base}`
        if (!names.has(key)) {
            if (shouldAdd) {
                addName(key)
            }    

            return base
        }

        const result = `${base}-${names.get(key)!}`
        if (shouldAdd) {
            addName(key)
        }

        return result 
    }

    function nameWithPrefix(name: string, kind: terraform.TerraformElement['kind']) {
        const hashed = getHash(name)

        switch (kind) {
            case 'provider':
                return `p_${hashed}`
            case 'resource':
                return `r_${hashed}`
            case 'data-source':
                return `d_${hashed}`
            case 'local':
                return hashed
        }
    }

    function peekName(type: string, kind: terraform.TerraformElement['kind'], suffix?: string) {
        const name = getUniqueName(type, kind, getId(-1), suffix)

        return nameWithPrefix(name, kind)
    }

    function generateName(type: string, kind: terraform.TerraformElement['kind'], suffix?: string) {
        const name = getUniqueName(type, kind, getId(), suffix, true)
        if (kind === 'provider' && (name === 'default' || name === type)) {
            return name
        }
    
        return nameWithPrefix(name, kind)
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

    function bind<T extends any[], U>(fn: (...args: T) => U): (...args: T) => U {
        const ctx = storage.getStore()

        return (...args) => {
            if (!ctx) {
                return storage.run(storage.getStore() ?? { namedContexts: {} }, fn, ...args)
            }

            // XXX: merge named contexts in order to get providers
            const current = storage.getStore()
            const namedContexts = getNewNamedContexts(ctx.namedContexts, current?.namedContexts ?? {})

            return storage.run({ ...ctx, namedContexts }, fn, ...args)
        }
    }

    return {
        save,
        restore,
        bind,
        run,
        get,
        getId,
        getScope,
        getScopes,
        getDeclScopeKey,
        getModuleId,
        getNamedContexts,

        peekName,
        generateName,

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
    registeredProviders: Map<string, {
        mode: 'eager'
        ctor: new () => any
    } | { 
        mode: 'lazy'
        fn: () => new () => any 
    }>
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

    function registerProvider(ctor: new () => any) {
        const ctx = storage.getStore()
        if (!ctx) {
            return false
        }

        const type = getContextType(ctor)
        if (!type) {
            throw new Error(`Failed to register provider "${ctor.name}": missing context type`)
        }

        if (ctx.registeredProviders.has(type)) {
            return false
        }

        doCopy(ctx)
        ctx.registeredProviders.set(type, { mode: 'eager', ctor })

        return true
    }

    function registerLazyProvider(type: string, fn: () => new () => any) {
        const ctx = storage.getStore()
        if (!ctx) {
            return false
        }

        doCopy(ctx)
        ctx.registeredProviders.set(type, { mode: 'lazy', fn })

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

        const provider = ctx.registeredProviders.get(type)
        if (!provider) {
            ctx.defaultProviders.set(type, undefined)
            return
        }

        if (provider.mode === 'lazy') {
            const inst = new (provider.fn())()
            ctx.defaultProviders.set(type, inst)
    
            return inst
        }

        const inst = new provider.ctor()
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
        registerLazyProvider,
        getDefaultProvider,
    }
}

