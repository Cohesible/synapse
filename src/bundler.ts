import ts from 'typescript'
import * as path from 'node:path'
import * as esbuild from 'esbuild'
import { Fs, SyncFs } from './system'
import type { ReflectionOperation, ExternalValue } from './runtime/modules/serdes'
import { createArrayLiteral, createLiteral, createObjectLiteral, createSymbolPropertyName, createVariableStatement, memoize, printNodes, throwIfNotFileNotFoundError } from './utils'
import { topoSort } from './static-solver/scopes'
import { getLogger } from './logging'
import { Artifact, getDataRepository, getDeploymentFs } from './artifacts'
import { PackageService, pruneManifest } from './pm/packages'
import { ModuleResolver } from './runtime/resolver'
import { isBuiltin } from 'node:module'
import { TerraformPackageManifest } from './runtime/modules/terraform'
import { SourceMapV3, toInline } from './runtime/sourceMaps'
import { createModuleResolverForBundling } from './runtime/rootLoader'
import { getWorkingDir } from './workspaces'
import { pointerPrefix, createPointer, isDataPointer, toAbsolute, DataPointer, coerceToPointer, isNullHash, applyPointers } from './build-fs/pointers'
import { getModuleType } from './static-solver'
import { readPathKeySync } from './cli/config'
import { isSelfSea } from './execution'

// Note: `//!` or `/*!` are considered "legal comments"
// Using "linked" or "external" for `legalComments` creates a `.LEGAL.txt` file

export interface BundleOptions extends MemCompileOptions {
    readonly external?: string[]
    readonly bundled?: boolean
    readonly minify?: boolean
    readonly minifyKeepWhitespace?: boolean
    readonly banners?: string[]
    readonly legalComments?: 'inline' | 'external' | 'linked'
    readonly sourcemap?: boolean | 'inline' | 'external' | 'linked'
    readonly sourcesContent?: boolean
    readonly splitting?: boolean // Does nothing without multiple entrypoints

    readonly lazyLoad?: string[]
    readonly extraBuiltins?: string[]
    
    // TODO: maybe implement this
    // Always lazily-load deployed modules
    // This uses a "smart" loader that eagerly loads non-function primitive exports if known ahead of time.
    readonly lazyLoadDeployed?: boolean

    readonly executableType?: 'node-script'
    readonly serializerHost?: SerializerHost
}

export interface MemCompileOptions {
    readonly compilerOptions?: ts.CompilerOptions
    readonly outfile?: string
    readonly outdir?: string
    readonly moduleTarget?: 'cjs' | 'esm'
    readonly platform?: 'browser' | 'node'
    readonly allowOverwrite?: boolean
    readonly nodePaths?: string
    readonly workingDirectory?: string
    readonly writeToDisk?: boolean
}

export function createProgram(
    fs: SyncFs,
    files: string[],
    compilerOptions: ts.CompilerOptions = {}
) {
    const host = createCompilerHost(compilerOptions, fs)
    
    return {
        host,
        program: ts.createProgram(files, compilerOptions, host),
    }
}

export const setupEsbuild = memoize(() => {
    const esbuildPath = readPathKeySync('esbuild.path')
    if (!esbuildPath) {
        if (!process.env.ESBUILD_BINARY_PATH && isSelfSea()) {
            throw new Error(`Missing esbuild binary`)
        }

        getLogger().warn(`No esbuild path found`)

        return
    }

    getLogger().debug(`Using esbuild path`, esbuildPath)

    // Updating the env variable doesn't work for `deploy` (??????????)
    // Feels like it's a very obscure bug with v8 relating to proxies
    // Using a non-enumerable field on `process` works though
    Object.defineProperty(process, 'SYNAPSE_ESBUILD_BINARY_PATH', { 
        value: esbuildPath,
        enumerable: false,
    })

    // Triggers a lazy load

    return esbuild.version
})

function mapTarget(target: ts.ScriptTarget | undefined) {
    if (target === undefined) {
        return
    }

    switch (target) {
        case ts.ScriptTarget.ES2015:
            return 'es2015'
        case ts.ScriptTarget.ES2016:
            return 'es2016'
        case ts.ScriptTarget.ES2017:
            return 'es2017'
        case ts.ScriptTarget.ES2018:
            return 'es2018'
        case ts.ScriptTarget.ES2019:
            return 'es2019'
        case ts.ScriptTarget.ES2020:
            return 'es2020'
        case ts.ScriptTarget.ES2021:
            return 'es2021'
        case ts.ScriptTarget.ES2022:
            return 'es2022'
        case ts.ScriptTarget.ES2023:
            return 'es2023'
        case ts.ScriptTarget.ESNext:
            return 'esnext'
        case ts.ScriptTarget.JSON:
            return 'json'
        case ts.ScriptTarget.Latest:
            return 'latest'
        case ts.ScriptTarget.ES3:
            return 'es3'
        case ts.ScriptTarget.ES5:
            return 'es5'
        default:
            throw new Error(`unknown target: ${target}`)
    }
}

function makeBanner(options: BundleOptions) {
    const lines: string[] = []
    if (options.banners) {
        lines.push(...options.banners)
    }

    if (options.compilerOptions?.alwaysStrict && options.moduleTarget !== 'esm') {
        lines.push('"use strict";')
    }

    // import path from 'node:path'
    // import { fileURLToPath } from 'node:url';
    // const __filename = fileURLToPath(import.meta.url)
    // const __dirname = path.dirname(__filename)

    // XXX: allows `require` to still work in ESM bundles
    if (options.moduleTarget === 'esm' && options.bundled !== false && options.platform !== 'browser') {
        lines.push(
            ...`
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`.trim().split('\n')
        )
    }

    if (lines.length === 0) {
        return undefined
    }

    return {
        'js': lines.join('\n'),
    }
}

interface TranspileOptions {
    readonly oldSourcemap?: SourceMapV3
    readonly sourcemapType?: 'external' | 'linked'
    readonly workingDirectory?: string
    readonly bundleOptions?: BundleOptions
}

export function createTranspiler(fs: Fs & SyncFs, resolver?: ModuleResolver, compilerOptions?: ts.CompilerOptions) {
    const moduleTarget = getModuleType(compilerOptions?.module)

    async function transpile(path: string, data: string | Uint8Array, outfile: string, options?: TranspileOptions) {
        const workingDirectory = options?.workingDirectory ?? compilerOptions?.rootDir ?? getWorkingDir()
        const withSourcemap = options?.oldSourcemap ? `${data}\n\n${toInline(options?.oldSourcemap)}` : data
        await fs.writeFile(path, withSourcemap, { fsKey: '#mem' })
        const res = await build(
            fs,
            resolver ?? createModuleResolverForBundling(fs, workingDirectory),
            [path],
            {
                outfile,
                bundled: false,
                workingDirectory,
                allowOverwrite: true,
                compilerOptions,
                writeToDisk: false,
                sourcemap: options?.sourcemapType,
                sourcesContent: false,
                moduleTarget,
                ...options?.bundleOptions,
            }
        )

        // TODO: this is needed for `watch` but it causes flaky synths (?)
        // await fs.deleteFile(path, { fsKey: '#mem' }).catch(throwIfNotFileNotFoundError)

        const result = res.outputFiles.find(x => x.path.endsWith(outfile))
        if (result === undefined) {
            throw new Error(`Unable to find build artifact: ${outfile}`)
        }

        const sourcemap = res.outputFiles.find(x => x.path.endsWith(`${outfile}.map`))
        if (options?.sourcemapType !== undefined && sourcemap === undefined) {
            throw new Error(`Unable to find sourcemap: ${outfile}.map`)
        }

        return {
            result,
            sourcemap,
        }
    }

    return { transpile, moduleTarget }
}

async function build(fs: Fs & SyncFs, resolver: ModuleResolver, files: string[], options: BundleOptions) {
    setupEsbuild()

    const jsx = options.compilerOptions?.jsx
    const result = await esbuild.build({
        entryPoints: files,
        absWorkingDir: options.workingDirectory,
        bundle: options.bundled !== false,
        format: options.moduleTarget ?? 'cjs',
        platform: options.platform ?? 'node',
        target: mapTarget(options.compilerOptions?.target),
        outfile: options.outfile,
        outdir: options.outdir,
        treeShaking: true,
        minify: options.minify,
        plugins: [createFsPlugin(fs, resolver, options)],
        external: options.external,
        minifyIdentifiers: options.minifyKeepWhitespace,
        minifySyntax: options.minifyKeepWhitespace,
        mainFields: (options.moduleTarget === 'esm' && options.platform !== 'browser') 
            ? ['module', 'main'] 
            : undefined,
        loader: {
            '.ttf': 'file',
        },
        // Can't be used w/ outfile
        // outdir: options.compilerOptions?.outDir,
        jsx: (jsx === ts.JsxEmit.ReactJSX || jsx === ts.JsxEmit.ReactJSXDev) ? 'automatic' : undefined,
        jsxImportSource: options.compilerOptions?.jsxImportSource,
        banner: makeBanner(options),
        allowOverwrite: options.allowOverwrite,
        inject: [],
        write: false,
        sourcesContent: options.sourcesContent,
        sourcemap: options.sourcemap,
        splitting: options.splitting,
        // TODO: determine if using `silence` still returns errors/warnings
        logLevel: 'silent',
        legalComments: options.legalComments,
    })

    if (options.writeToDisk !== false) {
        await Promise.all(result.outputFiles.map(f => fs.writeFile(f.path, f.contents)))
    }

    for (const warn of result.warnings) {
        getLogger().warn(`[esbuild]: ${await esbuild.formatMessages([warn], { kind: 'warning' })}`)
    }

    for (const err of result.errors) {
        getLogger().error(`[err]: ${await esbuild.formatMessages([err], { kind: 'error' })}`)
    }

    if (result.errors.length > 0) {
        throw new Error(`Failed to compile file: ${files[0]}`)
    }

    return result
}

export function createPointerMapper() {
    const mapping = new Map<string, string>()
    const unmapping = new Map<string, string>()
    function getMappedPointer(p: string) {
        if (unmapping.has(p)) {
            return p
        }

        if (mapping.has(p)) {
            return mapping.get(p)!
        }

        const id = `${pointerPrefix}${mapping.size}`
        mapping.set(p, id)
        unmapping.set(id, p)

        return id
    }

    return {
        getMappedPointer,
        getUnmappedPointer: (p: string) => unmapping.get(p) ?? p,
    }
}

export const seaAssetPrefix = `sea-asset:`
export const rawSeaAssetPrefix = `raw-sea-asset:`
export const backendBundlePrefix = `file:./_assets/`

export type Optimizer = (table: Record<string | number, ExternalValue | any[]>, captured: any) => { table: Record<string | number, ExternalValue | any[]>, captured: any }

export function createSerializerHost(fs: { writeDataSync: (data: Uint8Array) => DataPointer }, packagingMode: 'sea' | 'backend-bundle' = 'sea', optimizer?: Optimizer) {
    const assets = new Map<DataPointer, string>()

    function getUrl(p: DataPointer) {
        switch (packagingMode) {
            case 'sea':
                return `${seaAssetPrefix}${p.hash}`
            case 'backend-bundle':
                return `${backendBundlePrefix}${p.hash}`

            default:
                throw new Error(`Unknown packaging mode: ${packagingMode}`)
        }
    }

    function addAsset(p: DataPointer): string {
        if (assets.has(p)) {
            return assets.get(p)!
        }

        const url = getUrl(p)
        assets.set(p, url)

        return url
    }

    function addRawAsset(data: ArrayBuffer): DataPointer {
        const pointer = fs.writeDataSync(new Uint8Array(data))
        addAsset(pointer)

        return pointer
    }

    function getAssets() {
        return Object.fromEntries(
            [...assets.entries()].map(([k, v]) => [v, k] as const)
        )
    }

    return {
        addAsset,
        addRawAsset,
        getAssets,
        optimize: optimizer,
        ...createPointerMapper(),
    }
}

function createFsPlugin(fs: Fs & SyncFs, resolver: ModuleResolver, opt: BundleOptions): esbuild.Plugin {
    const serializerHost = opt?.serializerHost
    const lazyImporters = new Map<string, string>()

    async function resolveJsFile(args: esbuild.OnResolveArgs) {
        const resolved = resolver.getFilePath(args.path)
        const patchFn = resolver.getPatchFn(resolved)

        if (patchFn) {
            return {
                path: resolved,
                namespace: 'patched',
                pluginData: patchFn,
            }
        }

        if (opt.bundled !== false && args.path.endsWith('.js')) {
            const resolvedDeployed = resolved.replace(/\.js$/, '.resolved.js')
            if (await fs.fileExists(resolvedDeployed)) {
                getLogger().log('Using resolved path for bundling:', resolvedDeployed)
                return {
                    path: resolvedDeployed,
                }
            }
        }

        return {
            path: args.path,
            // TODO: this is needed for tree-shaking ESM
            // sideEffects: false,
        }
    }

    return {
        name: 'mem',
        setup(build) {
            build.onResolve({ filter: /^pointer:.*/ }, async args => {
                const importer = args.pluginData?.virtualId ?? args.importer
                const mapped = serializerHost?.getMappedPointer?.(args.path) ?? args.path

                return {
                    namespace: 'pointer',
                    path: mapped.slice(pointerPrefix.length),
                    pluginData: { virtualId: resolver.resolveVirtual(serializerHost?.getUnmappedPointer?.(args.path) ?? args.path, importer) }
                }
            })

            build.onResolve({ filter: /^raw-sea-asset:.*/ }, async args => {
                const importer = args.pluginData?.virtualId ?? args.importer

                return {
                    namespace: rawSeaAssetPrefix.slice(0, -1),
                    path: resolver.resolve(args.path.slice(rawSeaAssetPrefix.length), importer),
                }
            })

            build.onResolve({ filter: /^synapse:.*/ }, async args => {
                return {
                    path: resolver.resolve(args.path),
                }
            })

            build.onResolve({ filter: /^lazy-load:.*/ }, async args => {
                const mode: 'esm' | 'cjs' = args.kind === 'import-statement' ? 'esm'
                    : args.kind === 'require-call' ? 'cjs'
                    : opt.moduleTarget ?? 'cjs'

                try {
                    const p = args.path.slice('lazy-load:'.length)
                    const importer = lazyImporters.get(p)
                    if (!importer) {
                        throw new Error(`No importer found for path: ${p}`)
                    }

                    const filePath = resolver.resolveVirtual(p, importer, mode)

                    if (filePath.match(/\.(js|ts|tsx)$/)) {
                        return resolveJsFile({ ...args, path: filePath })
                    }

                    return { path: resolver.resolve(filePath) }
                } catch (e) {
                    getLogger().warn(`Deferring to esbuild for unresolved module "${args.path}"`, e)
                }
            })

            function matchPattern(spec: string, pattern: string) {
                if (isBuiltin(spec) && !spec.startsWith('node:')) {
                    spec = `node:${spec}`
                }

                if (pattern.endsWith('*')) {
                    return spec.startsWith(pattern.slice(0, -1))
                }

                return spec.startsWith(pattern)
            }

            build.onResolve({ filter: /.*/ }, async (args) => {
                if (opt.bundled === false) {
                    return { path: args.path }
                }

                if (opt.lazyLoad?.some(x => matchPattern(args.path, x))) {
                    lazyImporters.set(args.path, args.importer)
                    return { namespace: 'lazy', path: args.path }
                }

                if (isBuiltin(args.path)) {
                    return
                }

                if (opt.external?.some(x => args.path.startsWith(x))) {
                    return
                }

                const mode: 'esm' | 'cjs' = args.kind === 'import-statement' ? 'esm'
                    : args.kind === 'require-call' ? 'cjs'
                    : opt.moduleTarget ?? 'cjs'

                const importer = args.pluginData?.virtualId ?? args.importer
                try {
                    const filePath = resolver.resolveVirtual(args.path, importer, mode)
                    if (filePath.match(/\.(js|ts|tsx)$/)) {
                        return resolveJsFile({ ...args, path: filePath })
                    }

                    if (filePath.endsWith('.wasm')) {
                        return { external: true }
                    }

                    return { path: resolver.resolve(filePath) }
                } catch (e) {
                    getLogger().warn(`Deferring to esbuild for unresolved module "${args.path}" `, e)
                }
            })

            build.onLoad({ namespace: 'lazy', filter: /.*/ }, async args => {
                if (isBuiltin(args.path) || opt.extraBuiltins?.includes(args.path)) {
                    return {
                        loader: 'js',
                        contents: generateLazyModule(args.path),
                    }
                }

                return {
                    loader: 'js',
                    contents: generateLazyModule(`lazy-load:${args.path}`, false, true),
                }
            })

            build.onLoad({ namespace: rawSeaAssetPrefix.slice(0, -1), filter: /.*/ }, async args => {
                const asset = serializerHost?.addRawAsset?.(await fs.readFile(args.path))
                if (!asset) { 
                    return {
                        loader: 'js',
                        contents: ``,
                    } 
                }

                return {
                    loader: 'js',
                    contents: generateRawSeaAsset(asset.hash),
                }
            })

            async function readPointer(p: string) {
                if (p.length < 100) {
                    return JSON.parse(await fs.readFile(p, 'utf-8')) as Artifact
                }

                const pointer = coerceToPointer(p)
                const data = JSON.parse(await fs.readFile(pointer.ref, 'utf-8')) as Artifact
                const { storeHash } = pointer.resolve()
                if (isNullHash(storeHash)) {
                    return data
                }

                const store = JSON.parse(await fs.readFile(`${pointerPrefix}${storeHash}`, 'utf-8'))
                const m = store.type === 'flat' ? store.artifacts[pointer.hash] : undefined
                if (!m?.pointers) {
                    return data
                }
            
                return applyPointers(data, m.pointers) as Artifact
            }

            async function loadPointer(args: esbuild.OnLoadArgs): Promise<esbuild.OnLoadResult> {
                // XXX: we add the prefix back here to make the `esbuild` comments look nicer
                const p = `${pointerPrefix}${args.path}`
                const unmapped = serializerHost?.getUnmappedPointer?.(p) ?? p
                const data = await readPointer(unmapped)

                switch (data.kind) {
                    case 'compiled-chunk':
                        return {
                            loader: 'js',
                            contents: Buffer.from(data.runtime, 'base64'),
                        }
                    case 'deployed':
                        return {
                            loader: 'ts',
                            contents: renderFile(deserializePointers(data), opt.platform, undefined, undefined, false, undefined, serializerHost),
                            resolveDir: opt.workingDirectory,
                            pluginData: { virtualId: args.pluginData?.virtualId }
                        }
                    case 'native-module':
                        const compiler = serializerHost?.nativeCompiler
                        if (!compiler) {
                            return {
                                loader: 'js',
                                contents: Buffer.from(data.binding, 'base64'),
                            }
                        }

                        if (!serializerHost.addRawAsset) {
                            throw new Error(`Missing ability to add raw asset: ${data.sourceName}`)
                        }

                        const resolved = path.resolve(getWorkingDir(), data.sourceName)
                        const compiled = await compiler(resolved)
                        const asset = serializerHost.addRawAsset(compiled.compiled)
                        const relPath = serializerHost.addAsset!(asset).slice('file:'.length)
                        const contents = compiled.stub.replace(`'${path.basename(resolved).replace(/\.zig$/, '.node')}'`, `'${relPath}'`)

                        return {
                            loader: 'js',
                            contents,
                        }
                    default:
                        throw new Error(`Unknown object kind: ${(data as any).kind}`)
                }
            }

            build.onLoad({ namespace: 'pointer', filter: /.*/ }, loadPointer)

            build.onLoad({ namespace: 'patched', filter: /.*/ }, async (args) => {
                const patchFn = args.pluginData as (contents: string) => string
                const contents = await fs.readFile(args.path, 'utf-8')
                getLogger().log(`Patching module: ${args.path}`)

                return {
                    loader: 'js',
                    contents: patchFn(contents),
                }
            })

            build.onLoad({ filter: /\.js$/ }, async (args) => {
                const resolved = resolver.getFilePath(args.path)

                return {
                    loader: 'js',
                    contents: await fs.readFile(resolved),
                }
            })

            build.onLoad({ filter: /\.ts$/ }, async (args) => {
                const resolved = resolver.getFilePath(args.path)

                return {
                    loader: 'ts',
                    contents: await fs.readFile(resolved),
                }
            })

            build.onLoad({ filter: /\.tsx$/ }, async (args) => {
                const resolved = resolver.getFilePath(args.path)

                return {
                    loader: 'tsx',
                    contents: await fs.readFile(resolved),
                }
            })
        }
    }
}

export class MemFs {
    readonly #memory = new Map<string, string>()

    public writeFile(fileName: string, content: string) {
        this.#memory.set(fileName, content)
    }

    public deleteFile(fileName: string) {
        this.#memory.delete(fileName)
    }

    public fileExists(fileName: string): boolean {
        return this.#memory.has(fileName) || ts.sys.fileExists(fileName)
    }

    public readFile(fileName: string): string | undefined {
        return this.#memory.get(fileName) ?? ts.sys.readFile(fileName)
    }

    public getSourceFile(fileName: string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void): ts.SourceFile | undefined {
        const sourceText = this.readFile(fileName);

        return sourceText !== undefined
            ? ts.createSourceFile(fileName, sourceText, languageVersion)
            : undefined;
    }

    public print(showContents = false) {
        for (const [k, v] of this.#memory.entries()) {
            getLogger().log(`file: ${k}`)
            if (showContents) {
                getLogger().log(v)
            }
        }
    }

    public getFiles() {
        return Array.from(this.#memory.keys())
    }

    public *files() {
        yield* this.#memory.keys()
    }
}

function createCompilerHost(options: ts.CompilerOptions, fs: SyncFs): ts.CompilerHost {
    return {
        readFile,
        fileExists,
        getSourceFile,
        getDefaultLibFileName: () => "lib.d.ts",
        writeFile: (fileName, content) => fs.writeFileSync(fileName, content),
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getDirectories: path => ts.sys.getDirectories(path),
        getCanonicalFileName: fileName => ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
        getNewLine: () => ts.sys.newLine,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    }

    function fileExists(fileName: string): boolean {
        return fs.fileExistsSync(fileName)
    }

    function readFile(fileName: string): string | undefined {
        if (!fileExists(fileName)) {
            return
        }

        return fs.readFileSync(fileName, 'utf-8')
    }

    function getSourceFile(fileName: string, languageVersion: ts.ScriptTarget, onError?: (message: string) => void) {
        const sourceText = readFile(fileName)

        return sourceText !== undefined
            ? ts.createSourceFile(fileName, sourceText, languageVersion)
            : undefined
    }
}

function generateRawSeaAsset(hash: string) {
    return `
const hash = '${hash}'
const buffer = require('node:sea').getRawAsset(hash)

module.exports = { buffer, hash }
`.trim()
}

// The obfuscation is so `esbuild` doesn't try to re-resolve it
function generateLazyModule(spec: string, obfuscate = true, allowDynamicLink = false) {
    function obfuscateSpec() {
        if (!obfuscate) {
            return ts.factory.createStringLiteral(spec)
        }

        return ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('String'),
                'fromCodePoint',
            ),
            undefined,
            [...spec].map(c => c.codePointAt(0)!).map(n => createLiteral(n))
        )
    }

    function createRequire(spec: string | ts.Expression) {
        return ts.factory.createCallExpression(
            ts.factory.createIdentifier('require'),
            undefined,
            [typeof spec === 'string' ? ts.factory.createStringLiteral(spec) : spec]
        )
    }

    function loadModule() {
        if (!allowDynamicLink) {
            return createRequire(obfuscateSpec())
        }

        const req = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
                createRequire('node:module'),
                'createRequire'
            ),
            undefined,
            [ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('process'),
                'execPath'
            )]
        )

        return ts.factory.createImmediatelyInvokedArrowFunction(
            [ts.factory.createTryStatement(
                ts.factory.createBlock([
                    ts.factory.createReturnStatement(
                        ts.factory.createCallExpression(req, undefined, [ts.factory.createStringLiteral(spec.slice('lazy-load:'.length))])
                    )
                ]),
                ts.factory.createCatchClause(undefined, ts.factory.createBlock([
                    ts.factory.createReturnStatement(
                        createRequire(obfuscateSpec())
                    )
                ])),
                undefined,
            )]
        )
    }

    const loader = ts.factory.createFunctionDeclaration(
        undefined,
        undefined,
        'load',
        undefined,
        [ts.factory.createParameterDeclaration(undefined, undefined, 'prop')],
        undefined,
        ts.factory.createBlock([
            ts.factory.createIfStatement(
                ts.factory.createStrictEquality(
                    ts.factory.createIdentifier('prop'),
                    ts.factory.createStringLiteral('__esModule')
                ), 
                ts.factory.createReturnStatement(ts.factory.createTrue())
            ),

            createVariableStatement('mod', loadModule()),

            // FIXME: this doesn't work as intended because `esbuild` assigns `module.exports` to per-module locals
            // Meaning we never remove the proxy. Which is fine, just means worse perf.
            ts.factory.createExpressionStatement(
                ts.factory.createAssignment(
                    ts.factory.createPropertyAccessExpression(
                        ts.factory.createIdentifier('module'),
                        'exports'
                    ),
                    ts.factory.createIdentifier('mod')
                )
            ),

            ts.factory.createIfStatement(
                ts.factory.createStrictEquality(
                    ts.factory.createIdentifier('prop'),
                    ts.factory.createStringLiteral('default')
                ), 
                ts.factory.createReturnStatement(ts.factory.createIdentifier('mod'))
            ),

            ts.factory.createReturnStatement(
                ts.factory.createElementAccessExpression(
                    ts.factory.createIdentifier('mod'),
                    ts.factory.createIdentifier('prop')
                )
            )
        ], true)
    )

    const proxyIdent = ts.factory.createIdentifier('p')
    const p = ts.factory.createNewExpression(
        ts.factory.createIdentifier('Proxy'), 
        undefined, 
        [
            ts.factory.createObjectLiteralExpression(),
            createObjectLiteral({
                get: ts.factory.createArrowFunction(
                    undefined, 
                    undefined, 
                    [
                        ts.factory.createParameterDeclaration(undefined, undefined, '_'),
                        ts.factory.createParameterDeclaration(undefined, undefined, 'prop')
                    ],
                    undefined,
                    undefined,
                    ts.factory.createCallExpression(loader.name!, undefined, [ts.factory.createIdentifier('prop')])
                ),
                getPrototypeOf: ts.factory.createArrowFunction(
                    undefined, 
                    undefined, 
                    [],
                    undefined,
                    undefined,
                    proxyIdent,
                )
            })
        ]
    )

    

    const statements = [
        loader,
        createVariableStatement(proxyIdent, p),
        ts.factory.createExpressionStatement(
            ts.factory.createAssignment(
                ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier('module'),
                    'exports'
                ),
                proxyIdent
            )
        ),
    ]

    return printNodes(statements)
}

export function getModuleDeps(table: Record<string | number, ExternalValue>) {
    const keys = new Set<string>()
    for (const v of Object.values(table)) {
        if (v.valueType === 'reflection' && v.operations) {
            const op = resolveVal(table, v.operations, 0)
            if (op.type !== 'import') continue

            keys.add(op.module)
        }
    }

    return keys
}

export function getNpmDeps(table: Record<string | number, ExternalValue>, manfiest: TerraformPackageManifest) {
    return pruneManifest(manfiest, getModuleDeps(table))
}

function resolveVal<T extends object>(table: Record<string | number, ExternalValue | any[]>, val: T): T
function resolveVal<T extends object>(table: Record<string | number, ExternalValue | any[]>, val: T[], index: number): T
function resolveVal<T extends object>(table: Record<string | number, ExternalValue | any[]>, val: T, index?: number): T {
    if (!(moveableStr in val)) {
        if (index !== undefined && Array.isArray(val)) {
            return resolveVal(table, val[index])
        }
        return val
    }

    const id = (val as any)[moveableStr].id
    const obj = table[id]
    if (Array.isArray(obj)) {
        if (index !== undefined) {
            return resolveVal(table, obj[index])
        }
        return obj.map(el => resolveVal(table, el)) as T
    }

    if (obj.valueType !== 'object') {
        throw new Error(`Invalid value type: ${obj.valueType}. Expected type "object".`)
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries((obj as any).properties)) {
        if (typeof v === 'object' && !!v) {
            res[k] = resolveVal(table, v as any)
        } else {
            res[k] = v
        }
    }
    return res as T
}

// FIXME: `esm` not implemented
function createLoader(
    table: Record<string | number, ExternalValue | any[]>,
    isBundled: boolean,
    type: 'cjs' | 'esm' = 'cjs',
    platform: 'node' | 'browser' = 'node',
    factory = ts.factory
) {
    const name = factory.createIdentifier('loadModule')
    const targetIdent = factory.createIdentifier('target')
    const originIdent = factory.createIdentifier('origin')

    if (!isBundled) {
        const targetParameter = factory.createParameterDeclaration(undefined, undefined, targetIdent, undefined, undefined, undefined)
        const returnRequire = factory.createReturnStatement(
            factory.createCallExpression(
                factory.createIdentifier('require'),
                undefined,
                [targetIdent]
            )
        )

        const body = factory.createBlock([returnRequire], true)

        return factory.createFunctionDeclaration(undefined, undefined, name, undefined, [targetParameter], undefined, body)
    }

    const defaultClause = factory.createDefaultClause([
        factory.createThrowStatement(
            factory.createNewExpression(
                factory.createIdentifier('Error'),
                undefined,
                [factory.createTemplateExpression(
                    factory.createTemplateHead('No module found for target: '),
                    [
                        factory.createTemplateSpan(
                            targetIdent,
                            factory.createTemplateMiddle(' (')
                        ),
                        factory.createTemplateSpan(
                            originIdent,
                            factory.createTemplateTail(')')
                        )
                    ]
                )]
            )
        )
    ])

    const defaultCases: Record<string, ts.CaseClause> = {}
    const originCases: Record<string, { clauses: ts.CaseClause[] }> = {}
    for (const entry of Object.values(table)) {
        if (Array.isArray(entry)) continue

        switch (entry?.valueType) {
            case 'function': {
                const spec = isDataPointer(entry.module) 
                    ? entry.module.ref 
                    : entry.module.startsWith(pointerPrefix) ? entry.module : entry.module

                const resolved = factory.createStringLiteral(spec)
                const clause = factory.createCaseClause(
                    factory.createStringLiteral(spec),
                    [factory.createReturnStatement(
                        factory.createCallExpression(
                            factory.createIdentifier('require'),
                            undefined,
                            [resolved]
                        )
                    )]
                )

                defaultCases[spec] = clause
            
                break
            }
            case 'reflection': {
                const firstOp = resolveVal(table, entry.operations![0])

                if (firstOp.type !== 'import') continue

                // const packageName = (entry as any).packageName
                // const resolved = !isBuiltin(firstOp.module) && packageName
                //     ? createRequire(require.resolve(packageName)).resolve(firstOp.module)
                //     : firstOp.module

                const clause = factory.createCaseClause(
                    factory.createStringLiteral(firstOp.module),
                    [factory.createReturnStatement(
                        factory.createCallExpression(
                            factory.createIdentifier('require'),
                            undefined,
                            [factory.createStringLiteral(firstOp.module)]
                        )
                    )]
                )
            
                //if (!packageName) {
                defaultCases[firstOp.module] = clause
                // } else {
                //     originCases[v.origin] ??= { clauses: [] }
                //     originCases[v.origin].clauses.push(clause)
                // }

                break
            }
        }
    }

    const outerCases: ts.CaseClause[] = []
    for (const [k, v] of Object.entries(originCases)) {
        const caseBlock = factory.createCaseBlock([...v.clauses, defaultClause])
        const switchStatement = factory.createSwitchStatement(targetIdent, caseBlock)

        const clause = factory.createCaseClause(
            factory.createStringLiteral(k),
            [switchStatement]
        )
        outerCases.push(clause)
    }

    const defaultOriginBlock = factory.createCaseBlock([...Object.values(defaultCases), defaultClause])
    const defaultOriginClause = factory.createDefaultClause([
        factory.createSwitchStatement(targetIdent, defaultOriginBlock)
    ])

    const caseBlock = factory.createCaseBlock([...outerCases, defaultOriginClause])
    const switchStatement = factory.createSwitchStatement(originIdent, caseBlock)
    const targetParameter = factory.createParameterDeclaration(undefined, undefined, targetIdent, undefined, undefined, undefined)
    const originParameter = factory.createParameterDeclaration(undefined, undefined, originIdent, undefined, undefined, undefined)

    const body = factory.createBlock([switchStatement], true)

    return factory.createFunctionDeclaration(undefined, undefined, name, undefined, [targetParameter, originParameter], undefined, body)
}

function createResolver(
    loader: ts.Identifier, 
    dataTable: Record<string | number, ExternalValue> | string, 
    factory = ts.factory
) {
    const req = factory.createCallExpression(
        factory.createIdentifier('require'),
        undefined,
        [factory.createStringLiteral('synapse:serdes')]
    )

    const resolve = factory.createPropertyAccessExpression(
        req,
        'resolveValue'
    )

    const valueIdent = factory.createIdentifier('value')
    const valueParameter = factory.createParameterDeclaration(undefined, undefined, valueIdent, undefined, undefined, undefined)
    const body = factory.createCallExpression(
        resolve,
        undefined,
        [
            valueIdent,
            createObjectLiteral({ loadModule: loader }, factory),
            typeof dataTable === 'object'
                ? createObjectLiteral(dataTable as any, factory)
                : factory.createCallExpression(
                    factory.createPropertyAccessExpression(factory.createIdentifier('JSON'), 'parse'),
                    undefined,
                    [factory.createStringLiteral(dataTable)] // stringified
                )
        ]
    )

    return createVariableStatement(
        'resolveValue',
        factory.createArrowFunction(undefined, undefined, [valueParameter], undefined, undefined, body)
    )
}

export function serializePointers(obj: any): any {
    if (typeof obj !== 'object' || !obj) {
        return obj
    }

    if (Array.isArray(obj)) {
        return obj.map(serializePointers)
    }

    if (isDataPointer(obj)) {
        const { hash, storeHash } = obj.resolve()

        return { [moveableStr]: { valueType: 'data-pointer', hash, storeHash } }
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
        res[k] = serializePointers(v)
    }

    return res
} 

function deserializePointers(obj: any): any {
    if (typeof obj !== 'object' || !obj) {
        return obj
    }

    if (Array.isArray(obj)) {
        return obj.map(deserializePointers)
    }

    if (moveableStr in obj && obj[moveableStr].valueType === 'data-pointer') {
        return createPointer(obj[moveableStr].hash, obj[moveableStr].storeHash)
    }

    if (isDataPointer(obj)) {
        return obj
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
        res[k] = deserializePointers(v)
    }

    return res
}

export interface SerializerHost {
    addAsset?: (p: DataPointer) => string
    addRawAsset?: (data: ArrayBuffer) => DataPointer
    getMappedPointer?: (p: string) => string
    getUnmappedPointer?: (p: string) => string
    optimize?: Optimizer
    nativeCompiler?: (fileName: string) => Promise<{
        compiled: Uint8Array
        stub: string
    }>
}

export function renderFile(
    data: { table: Record<string | number, ExternalValue | any[]>; captured: any },
    platform: 'node' | 'browser' = 'node', 
    isBundled = true,
    immediatelyInvoke = false,
    useExportDefault = isBundled,
    shouldSerializePointers = false,
    host?: Pick<SerializerHost, 'addAsset' | 'getMappedPointer' | 'optimize'>
) {
    if (isBundled) {
        if (host?.optimize) {
            data = host.optimize(data.table, data.captured)
        }
        return printNodes(renderSerializedData(data.table, data.captured, platform, immediatelyInvoke, host)) 
    }

    // Dead code?

    const loader = createLoader(data.table, isBundled, 'cjs', platform)
    const { table, captured } = shouldSerializePointers ? serializePointers(data) : data
    const resolver = createResolver(ts.factory.createIdentifier(loader.name!.text), table)
    const resolved = ts.factory.createCallExpression(
        ts.factory.createIdentifier('resolveValue'),
        undefined,
        [createObjectLiteral(captured, ts.factory)]
    )

    const sourceFile = printNodes([
        loader,
        resolver,
        immediatelyInvoke
            ? ts.factory.createCallExpression(resolved, undefined, [])
            : useExportDefault
                ? ts.factory.createExportDefault(resolved) 
                : ts.factory.createExportAssignment(undefined, true, resolved)
    ])

    return sourceFile
}

const fn = (body: ts.Expression | ts.Block) => ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, body)
let noop: ts.ArrowFunction
let emptyClass: ts.ClassExpression

function tryOptimization(ops: ReflectionOperation[]) {
    if (ops.length < 2 || ops[0].type !== 'import') {
        return
    }

    noop ??= fn(ts.factory.createBlock([]))
    emptyClass ??= ts.factory.createClassExpression(undefined, undefined, undefined, undefined, [])

    if (ops[0].module.startsWith('synapse:')) {
        if (ops.length === 2) {
            if (ops[1].type === 'get' && ops[1].property === 'move') {
                return noop
            }

            if (ops[1].type === 'get' && ops[1].property === 'getContext') {
                return fn(createObjectLiteral({}, ts.factory))
            }

            if (ops[1].type === 'get' && ops[1].property === 'getCurrentId') {
                return noop
            }

            if (ops[1].type === 'get' && ops[1].property === 'generateName2') {
                return noop
            }

            if (ops[1].type === 'get' && ops[1].property === 'generateIdentifier') {
                return noop
            }

            if (ops[1].type === 'get' && ops[1].property === 'requireSecret') {
                return noop
            }

            if (ops[1].type === 'get' && ops[1].property === 'getLogger') {
                return fn(ts.factory.createIdentifier('console'))
            }

            if (ops[1].type === 'get' && ops[1].property === 'Fn') {
                return createObjectLiteral({}, ts.factory)
            }

            if (ops[1].type === 'get' && ops[1].property === 'defineResource') {
                return fn(emptyClass)
            }

            if (ops[1].type === 'get' && ops[1].property === 'Bundle') {
                return emptyClass
            }

            if (ops[1].type === 'get' && ops[1].property === 'Archive') {
                return emptyClass
            }

            if (ops[1].type === 'get' && ops[1].property === 'defer') {
                return ts.factory.createArrowFunction(
                    undefined, 
                    undefined, 
                    [ts.factory.createParameterDeclaration(undefined, undefined, 'fn')],
                    undefined, 
                    undefined, 
                    ts.factory.createCallExpression(ts.factory.createIdentifier('fn'), undefined, [])
                )
            }
        } else if (ops.length === 3) {
            if (ops[1].type === 'get' && ops[1].property === 'defineResource' && ops[2].type === 'apply') {
                return emptyClass
            }

            if (ops[1].type === 'get' && ops[1].property === 'defineDataSource' && ops[2].type === 'apply') {
                return fn(noop)
            }
        }
    }
}

function renderSerializedData(
    table: Record<string | number, ExternalValue | any[]>, 
    captured: any, 
    platform: 'node' | 'browser' | 'synapse',
    immediatelyInvoke?: boolean,
    host?: SerializerHost
) {
    const addAsset = host?.addAsset
    const getMappedPointer = host?.getMappedPointer

    const imports: ts.Node[] = []
    const required = new Set<number | string>() // All object ids that are needed
    const statements = new Map<number | string, ts.Node>()
    const dependencies = new Map<number | string, (number | string)[]>()
    const extraStatements = new Map<number | string, ts.Node[]>()

    function addExtraStatements(id: number | string, statements: ts.Node[]) {
        if (!extraStatements.has(id)) {
            extraStatements.set(id, [])
        }

        extraStatements.get(id)!.push(...statements)
    }

    function createIdent(id: number | string) {
        if (typeof id === 'string' && id.startsWith('b:')) { // Bound mutable
            const ident = ts.factory.createIdentifier(`nb_${id.slice(2)}`)

            return ident
        }

        return ts.factory.createIdentifier(`n_${id}`)
    }

    const importIdents = new Map<string, ts.Identifier>()
    function createImport(spec: string, isNamespaceImport?: boolean, member?: string) {
        if (spec.startsWith(pointerPrefix) && getMappedPointer) {
            spec = getMappedPointer(spec)
        }

        const key = member ? `${spec}#${member}` : spec
        if (importIdents.has(key)) {
            return importIdents.get(key)!
        }

        const ident = ts.factory.createIdentifier(`import_${importIdents.size}`)
        importIdents.set(key, ident)

        const importClause = member !== undefined
            ? ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
                ts.factory.createImportSpecifier(false, ts.factory.createIdentifier(member), ident)
            ]))
            : isNamespaceImport
                ? ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(ident))
                : ts.factory.createImportClause(false, ident, undefined)

        imports.push(ts.factory.createImportDeclaration(
            undefined,
            importClause,
            ts.factory.createStringLiteral(spec)
        ))

        return ident
    }

    function renderReflection(operations: ReflectionOperation[], id?: number | string) {
        if (moveableStr in operations) {
            operations = table[(operations as any)[moveableStr].id] as any
        }

        // Need to expand ops (this is a sign of brittleness)
        operations = operations.map(o => {
            if (moveableStr in o) {
                return (table[(o as any)[moveableStr].id] as any).properties as ReflectionOperation
            }

            return o
        })

        const optimized = tryOptimization(operations)
        if (optimized) {
            if (id !== undefined) {
                const ident = createIdent(id)
                statements.set(id, createVariableStatement(ident, optimized))
    
                return ident
            }

            return optimized
        }

        let currentNode: ts.Expression
        for (let i = 0; i < operations.length; i++) {
            const op = operations[i]
            switch (op.type) {
                case 'import': {
                    // Handles `import { foo } from 'bar'`
                    // const nextOp = operations[i+1]
                    // if (nextOp?.type === 'get') {
                    //     i += 1
                    //     currentNode = createImport(op.module, undefined, nextOp.property)
                    //     break
                    // }
                    currentNode = createImport(op.module, true)
                    break
                }
                case 'global': {
                    currentNode = ts.factory.createIdentifier('globalThis')
                    break
                }
                case 'get': {
                    currentNode = ts.factory.createElementAccessExpression(
                        currentNode!,
                        ts.factory.createStringLiteral(op.property)
                    )
                    break
                }
                case 'apply': {
                    // TODO: use `apply` and pass in `thisArg` if present?
                    currentNode = ts.factory.createCallExpression(
                        currentNode!,
                        undefined,
                        op.args.map(render)
                    )
                    break
                }
                case 'construct': {
                    currentNode = ts.factory.createNewExpression(
                        currentNode!,
                        undefined,
                        op.args.map(render)
                    )
                    break
                }
            }
        }

        if (id !== undefined) {
            const ident = createIdent(id)
            statements.set(id, createVariableStatement(ident, currentNode!))

            return ident
        }

        return currentNode!
    }

    function renderBoundFunction(id: number | string, boundTarget: any, boundThisArg: any, boundArgs: any[]) {
        const bound = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(render(boundTarget), 'bind'), 
            undefined, 
            [render(boundThisArg), ...boundArgs.map(render)]
        )

        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, bound))

        return ident
    }

    function renderStubFn(id: number | string) {
        const exp = ts.factory.createArrowFunction(undefined, undefined, [], undefined, undefined, ts.factory.createBlock([]))
        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, exp))

        return ident
    }

    function renderFunction(id: number | string, module: string, args: any[]) {
        const spec = isDataPointer(module) 
            ? toAbsolute(module) 
            : module.startsWith(pointerPrefix) ? module : `${pointerPrefix}${module}`

        const fn = createImport(spec)
        const exp = ts.factory.createCallExpression(fn, undefined, args.map(render))
        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, exp))

        return ident
    }

    function renderObject(id: number | string, properties?: Record<string, any>, constructor?: any, descriptors?: any) {
        const proto = constructor !== undefined
            ? ts.factory.createPropertyAccessExpression(render(constructor), 'prototype') 
            : ts.factory.createNull()

        const createExp = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('Object'),
                'create'
            ),
            undefined,
            descriptors ? [proto, render(descriptors)] : [proto]
        )

        const assignExp = ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('Object'),
                'assign'
            ),
            undefined,
            properties && Object.keys(properties).length > 0 
                ? [createExp, render(properties as any)] 
                : [createExp]
        )

        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, assignExp))

        return ident
    }

    function renderLiteral(obj: any): ts.Expression {
        if (typeof obj !== 'object' || obj === null) {
            return createLiteral(obj)
        }

        if (Array.isArray(obj)) {
            return createArrayLiteral(ts.factory, obj.map(render))
        }

        if (moveableStr in obj) {
            const v = obj[moveableStr]
            if ('id' in v && Object.keys(v).length === 1) {
                frame.push(v.id)

                return createIdent(v.id)
            }

            return render(v)
        }

        if (isDataPointer(obj)) {
            if (addAsset) {
                return createLiteral(addAsset(obj))
            }
            return createLiteral(obj.ref)
        }

        const res: Record<string, ts.Expression> = {}
        for (const [k, v] of Object.entries(obj)) {
            res[k] = render(v as any)
        }

        return createObjectLiteral(res, ts.factory)
    }

    function renderRegExp(id: number | string, source: string, flags: string) {
        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, ts.factory.createRegularExpressionLiteral(`/${source}/${flags}`)))

        return ident
    }

    function renderArray(id: number | string, value: any[]) {
        const ident = createIdent(id)
        const exp = ts.factory.createArrayLiteralExpression(value.map(render))
        statements.set(id, createVariableStatement(ident, exp))

        return ident
    }

    function renderResource(id: number | string, value: any) {
        const normalized = normalizeTerraform(value)
        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, renderLiteral(normalized)))

        return ident
    }

    function renderBinding(id: number | string, key: string, value: number | string | { [moveableStr]: { id: number } }) {
        const ident = createIdent(id)
        statements.set(id, createVariableStatement(ident, createObjectLiteral({}, ts.factory)))

        const assignmentId = `${id}_a`
        const valueId = typeof value === 'object' ? value['@@__moveable__']['id'] : value
        const assignment = ts.factory.createAssignment(
            ts.factory.createPropertyAccessExpression(ident, key),
            createIdent(valueId)
        )

        statements.set(assignmentId, assignment)
        required.add(assignmentId)
        dependencies.set(assignmentId, [id, valueId])

        return ident
    }

    function renderDataPointer(hash: string, storeHash: string): ts.Expression {
        throw new Error(`Rendering data pointer is not implemented`)
    }

    // TODO: support rendering things inline instead of only by reference
    function render(obj: ExternalValue): ts.Expression {
        switch (obj?.valueType) {
            case 'reflection':
                return renderReflection(obj.operations!, obj.id)
            case 'function':
                return renderFunction(obj.id!, obj.module, obj.captured!)
            case 'bound-function':
                return renderBoundFunction(obj.id!, obj.boundTarget, obj.boundThisArg, obj.boundArgs!)
            case 'regexp':
                return renderRegExp(obj.id!, (obj as any).source, (obj as any).flags)
            case 'resource':
                return renderResource(obj.id!, (obj as any).value)
            case 'object':
                return renderObject(
                    obj.id!, 
                    (obj as any).properties, 
                    Object.prototype.hasOwnProperty.call(obj, 'constructor') ? (obj as any).constructor : undefined, 
                    (obj as any).descriptors
                )
            case 'binding':
                return renderBinding(obj.id!, obj.key!, obj.value!)
            // case 'data-pointer':
            //     return renderDataPointer(obj.hash!, (obj as any).storeHash)
            default:
                return renderLiteral(obj)
        }
    }

    let frame: (string | number)[]
    function renderEntry(entry: ExternalValue) {
        frame = []
        dependencies.set(entry.id!, frame)

        // This could also be implemented when serializing bundled data
        const stubbed = getSymbol(entry, 'synapse.stubWhenBundled')
        if (stubbed) {
            return renderStubFn(entry.id!)
        }

        const exp = render({ 
            ...entry,
            // Strip out permissions and alt. implementations
            symbols: entry.symbols ? { 
                ...entry.symbols,
                browserImpl: undefined,
                permissions: undefined,
            } : undefined 
        })

        const objectId = getSymbol(entry, 'synapse.objectId')
        if (objectId !== undefined && ts.isIdentifier(exp)) {
            addExtraStatements(entry.id!, [
                ts.factory.createAssignment(
                    ts.factory.createElementAccessExpression(exp, createSymbolPropertyName('synapse.objectId')),
                    renderLiteral(objectId)
                )
            ])
        }
    }

    function getSymbol(val: ExternalValue, name: string) {
        if (!val.symbols) return

        if (moveableStr in val.symbols) {
            const resolved = table[val.symbols[moveableStr].id]
            if (Array.isArray(resolved) || resolved?.valueType !== 'object') {
                return
            }

            return (resolved as any).properties[name]
        }

        return val.symbols[name]
    }

    for (const [id, obj] of Object.entries(table)) {
        if (Array.isArray(obj)) {
            frame = []
            dependencies.set(id, frame)
            renderArray(id, obj)

            continue
        }

        if (obj === null || obj === undefined) continue // Not needed anymore??

        const browserImpl = platform === 'browser' ? getSymbol(obj, 'synapse.browserImpl') : undefined
        if (browserImpl) {
            const resolved = moveableStr in browserImpl ? table[browserImpl[moveableStr].id] : browserImpl
            renderEntry({ ...resolved, id: obj.id })
        } else {
            renderEntry(obj)
        }
    }

    const edges = Array.from(dependencies.entries()).flatMap(([k, v]) => v.map(x => [k, x] as const))
    const sorted = topoSort(edges as [number, number][])

    // Dead code elimination
    function visit(obj: any): void {
        if (typeof obj !== 'object' || obj === null) {
            return
        }

        if (Array.isArray(obj)) {
            return obj.forEach(visit)
        }

        for (const [k, v] of Object.entries(obj)) {
            if (k === moveableStr && 'id' in (v as any)) {
                required.add((v as any).id)
            } else {
                visit(v)
            }
        }
    }

    visit(captured)
    const rootNodes = new Set(required)
    for (const id of sorted) {
        if (required.has(id)) {
            if (!dependencies.has(id)) {
                throw new Error(`Missing entry for ref: ${id} - ${JSON.stringify(table[id])}`)
            }

            dependencies.get(id)!.forEach(x => required.add(x))
        }
    }

    const pruned = sorted.filter(x => required.has(x)).reverse() as (string | number)[]

    // Some root nodes may not be in the topo sort because they have no edges
    const prunedSet = new Set(pruned)
    for (const id of rootNodes) {
        if (!prunedSet.has(id)) {
            pruned.push(id)
            prunedSet.add(id)
        }
    }

    function createEsmExport(obj: any) {
        const specs = Object.entries(obj)
            .filter(x => typeof x[1] === 'object')
            .map(([k, v]) => {
                return ts.factory.createExportSpecifier(
                    false,
                    render(v as any) as ts.Identifier,
                    k
                )
            })

        const namedExports = ts.factory.createNamedExports(specs)

        return ts.factory.createExportDeclaration(undefined, false, namedExports)
    }

    function createExportsDeclaration(obj: any) {
        if (typeof obj !== 'object' || !obj || Array.isArray(obj) || moveableStr in obj) {
            if (moveableStr in obj) {
                const id = obj[moveableStr].id
                if (id !== undefined) {
                    const val = table[id]
                    if (Array.isArray(val) || val.valueType !== 'object') {
                        return ts.factory.createExportDefault(render(obj))
                    }

                    if ((val as any).properties.__esModule) {
                        const bindings = (val as any).properties
                        delete bindings.__esModule
                        return createEsmExport(bindings)
                    }
                }
            }

            return ts.factory.createExportDefault(render(obj))
        }

        return createEsmExport(obj)
    }

    return [
        ...imports,
        ...pruned.flatMap(id => {
            const statement = statements.get(id)!
            const extras = extraStatements.get(id)
            if (!extras) {
                return statement
            }

            return [statement, ...extras]
        }),
        immediatelyInvoke
            ? ts.factory.createCallExpression(
                render(captured),
                undefined,
                []
            )
            : createExportsDeclaration(captured)
    ]
}

const capitalize = (s: string) => s ? s.charAt(0).toUpperCase().concat(s.slice(1)) : s
function normalize(str: string) {
    const [first, ...rest] = str.split('_')

    return [first, ...rest.map(capitalize)].join('')
}

function normalizeTerraform(obj: any): any {
    if (typeof obj !== 'object' || !obj) {
        return obj
    }

    if (Array.isArray(obj)) {
        return obj.map(normalizeTerraform)
    }

    if (isDataPointer(obj)) {
        return obj
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
        // Don't normalize everything
        if (k === moveableStr) {
            res[k] = v
        } else {
            res[normalize(k)] = normalizeTerraform(v)
        }
    }

    return res
}

const moveableStr = '@@__moveable__'

