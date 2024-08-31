import ts from 'typescript'
import * as path from 'node:path'
import { Mutable, makeRelative, memoize, resolveRelative, sortRecord, strcmp, tryReadJson } from '../utils'
import { createTranspiler } from '../bundler'
import { createrLoader } from '../loader'
import { ResourceTransformer, generateModuleStub, getFqnComponents } from './transformer'
import { createCapturedSolver } from '../permissions'
import { runTask } from '../logging'
import { CompiledFile, createGraphCompiler, createRuntimeTransformer, createSerializer, getModuleType } from '../static-solver'
import { getOrCreateDeployment, getWorkingDir } from '../workspaces'
import { Fs, JsonFs, createLocalFs } from '../system'
import { PackageService, createPackageService, resolveBareSpecifier, resolveDeferredTargets } from '../pm/packages'
import { SourceMapHost, emitChunk } from '../static-solver/utils'
import { getLogger } from '../logging'
import { createSourceMapParser, getArtifactSourceMap, hydratePointers } from '../runtime/loader'
import { Artifact, CompiledChunk, LocalMetadata, ModuleBindingResult, getArtifactFs, getDataRepository, getProgramFs, getTargets, readInfraMappings, readModuleManifest, setTargets, toFs, writeInfraMappings, writeModuleManifest, } from '../artifacts'
import { ModuleResolver, createModuleResolver } from '../runtime/resolver'
import { SourceMapV3 } from '../runtime/sourceMaps'
import { DeclarationFileHost, createDeclarationFileHost } from './declarations'
import { ResourceTypeChecker } from './resourceGraph'
import { coerceToPointer, isDataPointer, pointerPrefix, toAbsolute } from '../build-fs/pointers'
import { getBuildTargetOrThrow, getCurrentVersion, getFs } from '../execution'
import { resolveValue } from '../runtime/modules/serdes'
import type { TfJson } from '../runtime/modules/terraform'
import { getCurrentPkg, getPackageJson } from '../pm/packageJson'
import { getOutputFilename } from './config'
import { getFileHasher } from './incremental'
import { transformImports } from './esm'
import { createBasicDataRepo } from '../runtime/rootLoader'


interface SynthOptions {
    readonly deployTarget?: string
    // readonly backend?: Backend
    readonly entrypoint?: string
    readonly logSymEval?: boolean

    // For modules
    readonly generateExports?: boolean
}

export interface CompilerOptions extends SynthOptions {
    readonly debug?: boolean
    readonly noInfra?: boolean
    readonly noSynth?: boolean
    readonly sharedLib?: boolean
    readonly workingDirectory?: string
    readonly incremental?: boolean
    readonly includeJs?: boolean
    readonly targetFiles?: string | string[]
    readonly excludeProviderTypes?: boolean
    readonly stripInternal?: boolean // TSC option

    // For compiling native code
    readonly hostTarget?: string

    readonly environmentName?: string
}

export interface ReplacementSymbol {
    readonly moduleSpecifier: string // Always relative to the pkg dir
    readonly symbolName: string
}

export interface TargetsFile {
    [fileName: string]: Record<string, { [target: string]: ReplacementSymbol }>
}

function fixSourcemapSources(sourcemap: string, outFile: string, sourceFile: string) {
    return JSON.stringify({ 
        ...JSON.parse(sourcemap), 
        sources: [path.relative(path.dirname(outFile), sourceFile)] 
    })
}

interface RenderedFile {
    name: string
    runtime: { text: string; sourcemap?: Uint8Array }
    infra: { text: string; sourcemap?: Uint8Array }
    sourceDelta?: { line: number; column: number }
}

export class CompilerHost {
    private readonly rootDir: string
    private readonly infraFiles = new Map<string, string | Promise<string>>()
    private readonly runtimeFiles = new Map<string, string | Promise<string>>()
    private readonly declarationHost: DeclarationFileHost

    public constructor(
        public readonly sourceMapHost: SourceMapHost,
        private readonly graphCompiler: ReturnType<typeof createGraphCompiler>,
        private readonly resourceTransformer: ResourceTransformer,
        private readonly resourceTypeChecker: ResourceTypeChecker,
        private readonly compilerOptions: ts.CompilerOptions,
        public readonly opt: CompilerOptions = {},
    ) {
        this.rootDir = this.compilerOptions.rootDir ?? this.opt.workingDirectory!
        this.program = this.createProgram()
        this.declarationHost = createDeclarationFileHost(getProgramFs(), sourceMapHost)
    }

    public getOutputFilename(fileName: string) {
        return getOutputFilename(this.rootDir, this.compilerOptions, fileName)
    }

    private async saveTypes(incremental = false) {
        const programFs = getProgramFs()

        const bt = getBuildTargetOrThrow()
        const getDest = (p: string) => makeRelative(bt.workingDirectory, this.getOutputFilename(`${p}.ts`))
        const targets: TargetsFile = {}

        async function getPackageEntrypoint() {
            const pkgJson = await getCurrentPkg()
            if (!pkgJson) {
                throw new Error(`No package found. Target bindings can only be added from a package.`)
            }

            const resolved = resolveBareSpecifier(pkgJson.data.name, pkgJson.data, 'cjs')

            return path.resolve(pkgJson.directory, resolved.fileName)
        }

        if (this.program.resourceTransformer.bindings.size === 0) {
            return
        }

        const packageEntrypoint = await getPackageEntrypoint()

        for (const [k, v] of this.program.resourceTransformer.bindings.entries()) {
            const { name, module } = getFqnComponents(k)

            const bindings = v.map(x => {
                const bindingFqn = getFqnComponents(x.replacement)
                const relativeModule = makeRelative(
                    path.dirname(packageEntrypoint),
                    path.resolve(bt.workingDirectory, getDest(bindingFqn.module))
                )

                return [x.target, { moduleSpecifier: `./${relativeModule}`, symbolName: bindingFqn.name }] as const
            })

            const isExternalImport = !module.startsWith(bt.workingDirectory)
            const key = isExternalImport ? module : `./${getDest(module)}`
            targets[key] = {
                ...targets[key],
                [name]: Object.fromEntries(bindings),
            }
        }

        const existingTargetsFile = incremental ? await getTargets(programFs) : undefined
        if (!existingTargetsFile) {
            await setTargets(programFs, targets)

            return
        }

        for (const [k, v] of Object.entries(targets)) {
            const existingTargets = existingTargetsFile[k]
            if (!existingTargets) {
                existingTargetsFile[k] = v
                continue
            }
            for (const [name, bindings] of Object.entries(v)) {
                existingTargets[name] = {
                    ... existingTargets[name],
                    ...bindings,
                }            
            }
        }

        await setTargets(programFs, existingTargetsFile)
    }

    private async renderArtifact(path: string, data: string, outfile: string, infra = false, oldSourcemap?: SourceMapV3) {
        // Make sure 'infra' compiles don't collide w/ runtime builds
        if (infra) {
            path = path.replace(/\.([tj]sx?)$/, `.infra.$1`)
            outfile = outfile.replace(/\.([tj]sx?)$/, `.infra.$1`)
        }

        const transpiler = await this.getTranspiler()
        const res = await transpiler.transpile(
            path,
            data,
            outfile,
            {
                oldSourcemap,
                sourcemapType: oldSourcemap ? 'external' : undefined,
            }
        )

        return {
            text: Buffer.from(res.result.contents).toString('base64'),
            sourcemap: res.sourcemap?.contents,
        }
    }

    private async emitArtifacts(fileName: string, moduleId?: string) {
        const programFs = getProgramFs()

        const compiled = this.renderedFiles.get(fileName)
        if (!compiled) {
            // These files have no function/class declarations
            getLogger().warn(`Missing artifacts for file: ${fileName}`)

            return {}
        }

        const bt = getBuildTargetOrThrow()
        const source = path.relative(bt.workingDirectory, fileName)
        const key = `[#compile/${source}]`

        const rendered = await Promise.all(compiled)
        
        const artifacts = await Promise.all(rendered.map(async v => {
            const [runtime, infra] = await Promise.all([
                v.runtime.sourcemap ? programFs.writeData(key, v.runtime.sourcemap) : undefined,
                v.infra.sourcemap ? programFs.writeData(key, v.infra.sourcemap) : undefined,
            ])

            const sourcemaps = runtime && infra ? { runtime, infra } : undefined

            const result: CompiledChunk = {
                kind: 'compiled-chunk',
                infra: v.infra.text,
                runtime: v.runtime.text,
            }

            const pointer = await programFs.writeData(
                key,
                Buffer.from(JSON.stringify(result), 'utf-8'),
                { metadata: { name: v.name, sourcemaps, moduleId, sourceDelta: v.sourceDelta } }, // TODO: add support for using pointer as metadata
            )

            return {
                source,
                name: v.name,
                data: result,
                pointer,
            }
        }))

        return Object.fromEntries(artifacts.sort((a, b) => strcmp(a.name, b.name)).map(a => [a.name, a] as const))
    }

    private readonly moduleManifest: Record<string, ModuleBindingResult> = {}
    private readonly infraFileMapping: Record<string, string> = {}
    private readonly sources: Sources = {}
    private readonly pointers: Record<string, Record<string, string>> = {}

    private async writeManifest(incremental?: boolean) {
        const programFs = getProgramFs()
        const oldManifest = incremental ? await readModuleManifest(programFs) : undefined
        await Promise.all(this.sourcePromises.values())

        // XXX: we do this to support incremental builds
        // The declaration emitter needs to know about other bindings to rewrite imports/exports
        for (const [k, v] of Object.entries({ ...oldManifest, ...this.moduleManifest })) {
            const outfile = this.getOutputFilename(
                path.resolve(getWorkingDir(), k)
            ).replace(/\.js$/, '.d.ts')

            this.declarationHost.setBinding(outfile, v.id)
        }

        for (const [k, v] of Object.entries(this.moduleManifest)) {
            const r = this.declarationHost.transformModuleBinding(k, v.id)
            const [text, sourcemap] = await Promise.all([
                programFs.writeData(`[#compile/${k}]`, Buffer.from(r.text, 'utf-8')),
                programFs.writeData(`[#compile/${k}]`, Buffer.from(r.sourcemap, 'utf-8')),
            ])

            this.moduleManifest[k] = {
                ...this.moduleManifest[k],
                types: {
                    name: r.name,
                    text,
                    sourcemap,
                    references: r.references,
                    symbols: this.resourceTypeChecker.getFileSymbols(
                        resolveRelative(getWorkingDir(), k)
                    ),
                },
            }
        }

        const updateManifest = async () => {
            if (incremental && Object.keys(this.moduleManifest).length === 0) {
                return
            }

            const updated = sortRecord({ ...oldManifest, ...this.moduleManifest })
            await writeModuleManifest(programFs, updated)
        }

        const updateMappings = async () => {
            if (incremental && Object.keys(this.infraFileMapping).length === 0) {
                return
            }

            const oldMappings = incremental ? await readInfraMappings(programFs) : undefined
            await writeInfraMappings(programFs, sortRecord({ ...oldMappings, ...this.infraFileMapping }))
        }

        const updateSources = async () => {
            if (incremental && Object.keys(this.sources).length === 0) {
                return
            }

            const oldSources = incremental ? await readSources(programFs) : undefined
            await writeSources(programFs, sortRecord({ ...oldSources, ...this.sources }))
        }

        const updatePointers = async () => {            
            if (incremental && Object.keys(this.pointers).length === 0) {
                return
            }

            const oldPointers = incremental ? await readPointersFile(programFs) : undefined
            await writePointersFile(programFs, sortRecord({ ...oldPointers, ...this.pointers }))
        }

        await Promise.all([
            updateManifest(),
            updateMappings(),
            updateSources(),
            updatePointers(),
        ])
    }

    public async finish(incremental?: boolean) {
        await Promise.all([
            this.saveTypes(incremental),
            ...(this.runtimeFiles.values()),
            ...(this.infraFiles.values()),
        ])

        return this.writeManifest(incremental)
    }

    private readonly program: Program

    private readonly renderedFiles = new Map<string, Promise<RenderedFile>[]>()
    private createProgram(): Program {
        const resourceTransformer = this.resourceTransformer
        const outDir = this.compilerOptions.outDir ?? this.rootDir
        const render = async (f: CompiledFile) => {
            const relPath = this.getOutputFilename(f.source)
            const virtualOutfile = relPath.replace(/\.(?:t|j)(sx?)$/, `-${f.name.slice(0, 48)}.js`)
            // Looks weird. Need to do this because TypeScript source maps assume it was emitted in the outdir
            const inputPath = path.resolve(outDir, path.relative(this.rootDir, f.path))

            const [runtime, infra] = await Promise.all([
                this.renderArtifact(inputPath, f.data, virtualOutfile, false, f.sourcesmaps?.runtime),
                this.renderArtifact(inputPath, f.infraData, virtualOutfile, true, f.sourcesmaps?.infra),
            ])

            return { 
                name: f.name, 
                runtime, 
                infra, 
                sourceDelta: resourceTransformer.getDeltas(f.sourceNode),
            }
        }

        this.graphCompiler.onEmitFile(f => {
            const arr = this.renderedFiles.get(f.source) ?? []
            arr.push(render(f))
            this.renderedFiles.set(f.source, arr)
        })

        return {
            graphCompiler: this.graphCompiler,
            resourceTransformer,
        }
    }

    private readonly sourcePromises = new Map<string, Promise<void>>()
    public addSource(name: string, outfile: string, isTsArtifact?: boolean) {
        const p = getFileHasher().getHash(resolveRelative(this.rootDir, name)).then(hash => {
            this.sources[name] = { outfile, hash, isTsArtifact }
        })
        this.sourcePromises.set(name, p)
    }

    public async saveTscFile(sourceFile: ts.SourceFile, fileName: string, text: string, moduleId?: string, internal?: boolean) {
        const bt = getBuildTargetOrThrow()
        const programFs = getProgramFs()
        const source = makeRelative(bt.workingDirectory, sourceFile.fileName)
        const dest = makeRelative(bt.workingDirectory, fileName)

        if (moduleId) {
            this.addSource(source, dest)
            this.moduleManifest[source] = { id: moduleId, path: dest, internal }
        }

        if (fileName.endsWith('.d.ts')) {
            this.declarationHost.addDeclaration(source, dest, text)
        } else if (fileName.endsWith('.d.ts.map')) {
            this.declarationHost.addSourcemap(dest.replace(/\.map$/, ''), text)
        }

        await programFs.writeFile(`[#compile/${source}]${dest}`, text)
    }

    private readonly getTranspiler = memoize(async () => {
        return createTranspiler(
            getFs(),
            undefined,
            this.compilerOptions,
        )
    })

    public async emitNoInfra(sourceFile: ts.SourceFile, needsDeploy?: boolean) {
        if (needsDeploy) {
            sourceFile = generateModuleStub(this.rootDir, this.graphCompiler, ts.getOriginalNode(sourceFile) as ts.SourceFile)
        }

        const { text } = emitChunk(this.sourceMapHost, sourceFile, undefined, { emitSourceMap: false, removeComments: true })
        const outfile = this.getOutputFilename(sourceFile.fileName)
        const transpiler = await this.getTranspiler()
        const res = await transpiler.transpile(
            sourceFile.fileName,
            text,
            outfile,
        )

        const fs = getFs()
        await fs.writeFile(outfile, res.result.contents)
    }

    private async emitSourceFile(sourceFile: ts.SourceFile, isInfra?: boolean, metadata?: LocalMetadata) {
        const bt = getBuildTargetOrThrow()
        const outfile = this.getOutputFilename(sourceFile.fileName)
        const resolvedOutfile = isInfra ? outfile.replace(/\.js$/, '.infra.js') : outfile
        const relSourcefile = makeRelative(bt.workingDirectory, sourceFile.fileName)
        const relOutfile = makeRelative(bt.workingDirectory, resolvedOutfile)

        const emitSourceMap = !!this.compilerOptions.sourceMap
        // XXX: we are always stripping comments here because it's possible for the generated code to render
        // malformed if there are any isolated comments at the end of the source file
        const { text, sourcemap } = emitChunk(this.sourceMapHost, sourceFile, undefined, { emitSourceMap, removeComments: true })

        const transpiler = await this.getTranspiler()
        const res = await transpiler.transpile(
            sourceFile.fileName,
            text,
            resolvedOutfile,
            {
                sourcemapType: emitSourceMap ? 'linked' : undefined,
                oldSourcemap: sourcemap,
            }
        )

        const compiledText = res.result.text
        const fixedSourcemap = res.sourcemap !== undefined
            ? fixSourcemapSources(res.sourcemap.text, resolvedOutfile, sourceFile.fileName)
            : undefined

        const programFs = getProgramFs()

        if (fixedSourcemap) {
            await programFs.writeFile(`[#compile/${relSourcefile}]${relOutfile}.map`, fixedSourcemap)
        }

        if (resolvedOutfile !== outfile) {
            this.infraFileMapping[makeRelative(bt.workingDirectory, outfile)] = relOutfile
        }

        this.addSource(relSourcefile, makeRelative(bt.workingDirectory, outfile)),
        await programFs.writeFile(`[#compile/${relSourcefile}]${relOutfile}`, compiledText, { metadata })

        return { compiledText, relOutfile }
    }

    public compileSourceFileRuntimeOnly(sourceFile: ts.SourceFile) {
        const runtimeTransformer = createRuntimeTransformer(this.program.graphCompiler, this.resourceTypeChecker)
        sourceFile = runtimeTransformer(sourceFile) as ts.SourceFile
        const p = this.emitSourceFile(sourceFile).then(r => r.compiledText)
        this.runtimeFiles.set(sourceFile.fileName, p)

        return p
    }

    public async emitDeployStub(sourceFile: ts.SourceFile) {
        const bt = getBuildTargetOrThrow()
        const relSourcefile = makeRelative(bt.workingDirectory, sourceFile.fileName)
        const emitSourceMap = !!this.compilerOptions.sourceMap
        const transpiler = await this.getTranspiler()
        const programFs = getProgramFs()
        const outfile = this.getOutputFilename(sourceFile.fileName)

        const stub = generateModuleStub(this.rootDir, this.graphCompiler, ts.getOriginalNode(sourceFile) as ts.SourceFile)
        const { text, sourcemap } = emitChunk(this.sourceMapHost, stub, undefined, { emitSourceMap, removeComments: true })
        const res = await transpiler.transpile(
            sourceFile.fileName,
            text,
            outfile,
            {
                sourcemapType: emitSourceMap ? 'linked' : undefined,
                oldSourcemap: sourcemap,
            }
        )

        const relOutfile = makeRelative(bt.workingDirectory, outfile)
        const fixedSourcemap = res.sourcemap !== undefined
            ? fixSourcemapSources(res.sourcemap.text, outfile, sourceFile.fileName)
            : undefined

        await Promise.all([
            fixedSourcemap ? programFs.writeFile(`[#compile/${relSourcefile}]${relOutfile}.map`, fixedSourcemap) : undefined,
            programFs.writeFile(`[#compile/${relSourcefile}]${relOutfile}`, res.result.text)
        ])
    }

    public compileSourceFile(sourceFile: ts.SourceFile, writeToDisk?: boolean, moduleId?: string, internal?: boolean) {
        // Defensive check
        const previous = this.infraFiles.get(sourceFile.fileName)
        if (previous) {
            return previous
        }

        const serializerTransformer = createSerializer(this.program.graphCompiler, this.resourceTypeChecker).createTransformer(
            undefined,
            node => this.program.resourceTransformer.visitAsInfraChunk(node),
        )

        sourceFile = serializerTransformer.visit(sourceFile) as ts.SourceFile
        sourceFile = this.program.resourceTransformer.visitSourceFile(sourceFile) // Possibly do this pass in `serializerTransformer`

        const emit = async () => {
            const bt = getBuildTargetOrThrow()
            const relSourcefile = makeRelative(bt.workingDirectory, sourceFile.fileName)
            const artifacts = await this.emitArtifacts(sourceFile.fileName, moduleId)

            if (getModuleType(this.compilerOptions?.module) === 'esm') {
                sourceFile = transformImports(sourceFile)
            }
        
            const { compiledText, relOutfile } = await this.emitSourceFile(sourceFile, !writeToDisk, { 
                dependencies: Object.values(artifacts).map(v => v.pointer),
            })

            const pointers = Object.entries(artifacts).map(([k, v]) => [k, v.pointer] as const)
            this.pointers[relOutfile] = Object.fromEntries(pointers)            

            if (moduleId) {
                this.moduleManifest[relSourcefile] = { id: moduleId, path: relOutfile, internal }
            }

            return compiledText
        }

        const p = emit()
        this.infraFiles.set(sourceFile.fileName, p)

        return p
    }
}

type CompilationMode = 
    | 'passthrough'
    | 'runtime'
    | 'infra'
    | 'infra-stub'
    | 'no-synth'

type Sources = Record<string, {
    hash: string
    outfile: string
    isTsArtifact?: boolean
}>

const sourcesFileName = `[#compile]__sources__.json`
async function writeSources(fs: Pick<Fs, 'writeFile'>, sources: Sources) {
    await fs.writeFile(sourcesFileName, JSON.stringify(sources))
}

export async function readSources(fs: Pick<Fs, 'readFile'> = getProgramFs()): Promise<Sources | undefined> {
    const s = await tryReadJson<Record<string, string> | Sources>(fs, sourcesFileName.slice('[#compile]'.length))

    return s as Sources | undefined
}

const pointersFileName = '[#compile]__pointers__.json'
async function writePointersFile(fs: Pick<JsonFs, 'writeJson'>, pointers: Record<string, Record<string, string>>): Promise<void> {
    await fs.writeJson(pointersFileName, pointers)
}

export async function readPointersFile(fs: Pick<JsonFs, 'readJson'>): Promise<Record<string, Record<string, string>> | undefined> {
    try {
        return await fs.readJson(pointersFileName)
    } catch (e) {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
    }
}

export interface CompiledSource {
    readonly name: string
    // readonly text: string
    readonly source: string
}

interface SynthOptions {
    readonly esm?: boolean // temporary
    readonly outDir?: string
    readonly sources?: CompiledSource[]
    readonly compilerOptions?: CompilerOptions
}

export async function synth(entrypoints: string[], deployables: string[], opt: SynthOptions = {}) {
    const {
        sources = [], 
    } = opt

    const afs = await getArtifactFs()
    const deploymentId = await getOrCreateDeployment()
    const bt = getBuildTargetOrThrow()
    ;(bt as Mutable<typeof bt>).deploymentId = deploymentId
    process.env.SYNAPSE_ENV = bt.environmentName // XXX: not clean
    process.env.SYNAPSE_TARGET = opt.deployTarget ?? opt.compilerOptions?.deployTarget ?? 'local'

    const store = await afs.getCurrentProgramStore().getSynthStore()
    const vfs = toFs(bt.workingDirectory, store.afs, getFs())
    const repo = getDataRepository(getFs())
    const dataRepo = createBasicDataRepo(repo)

    const moduleResolver = createModuleResolver(vfs, bt.workingDirectory)
    const { deferredTargets, infraFiles, resolver, pointers } = await runTask('init', 'resolver', async () => {
        const pkgService = await createPackageService(moduleResolver)
        const { stores, deferredTargets, infraFiles, pkgResolver, pointers } = await pkgService.loadIndex()
        store.setDeps(stores)

        return { stores, deferredTargets, infraFiles, resolver: pkgResolver, pointers }
    }, 1)

    // We do this after loading the index to account for any compiled `package.json`
    const targets = resolveDeferredTargets(moduleResolver, deferredTargets) // This could become expensive with enough symbols
    const sourcemapParser = createSourceMapParser(vfs, moduleResolver, bt.workingDirectory)

    const getSource = (fileName: string, spec: string, virtualLocation: string, type: 'runtime' | 'infra' = 'runtime') => {
        if (!spec.startsWith(pointerPrefix)) {
            if (type === 'infra' && infraFiles[fileName]) {
                return vfs.readFileSync(infraFiles[fileName], 'utf-8')
            }
            return vfs.readFileSync(fileName, 'utf-8')
        }
    
        const pointer = coerceToPointer(!isDataPointer(spec) && fileName.startsWith(pointerPrefix) ? fileName : spec)
        const name = toAbsolute(pointer)

        sourcemapParser?.registerDeferredMapping(name, () => {
            const { hash, storeHash } = pointer.resolve()

            return getArtifactSourceMap(dataRepo, hash, storeHash)
        })

        const data = hydratePointers(dataRepo, pointer)
        const artifact = typeof data === 'string' ? JSON.parse(data) as Artifact : data as Artifact
        switch (artifact.kind) {
            case 'compiled-chunk':
                const contents = type === 'infra' ? artifact.infra : artifact.runtime

                return Buffer.from(contents, 'base64').toString('utf-8')
            case 'deployed':
                if (artifact.rendered) {
                    return Buffer.from(artifact.rendered, 'base64').toString('utf-8')
                }

                if (type === 'runtime') {
                    throw new Error(`Not implemented: ${fileName}`)
                }

                return resolveValue(
                    artifact.captured, 
                    { loadModule: (spec, importer) => runtime.createRequire2(importer ?? virtualLocation)(spec) }, 
                    artifact.table,
                    runtime.globals
                )
            default:
                throw new Error(`Unknown object kind: ${(artifact as any).kind}`)
        }
    }

    const getSourceFile = (fileName: string) => {
        const sf = ts.createSourceFile(
            fileName,
            getSource(fileName, fileName, fileName), // ???
            ts.ScriptTarget.ES2020,
            true
        )

        return sf
    }

    const solver = createCapturedSolver(getSourceFile)
    let permsCount = 0
    // FIXME: `thisArg` is a hack used for the specific case of checking ctor perms
    // would be cleaner to have a different function handle this case
    const solvePerms = (target: any, globals?: { console?: any }, args?: any[], thisArg?: any) => {
        return runTask('perms', target.name ?? `fn-${permsCount++}`, () => {
            return solver.evaluate(target, globals, args, thisArg)
        }, 10)
    }

    const loader = createrLoader(
        store.afs,
        targets,
        infraFiles,
        Object.fromEntries(deployables.map(x => [x, true])),
        pointers,
        resolver,
        moduleResolver,
        bt,
        deploymentId,
        sourcemapParser,
        { 
            ...opt.compilerOptions,
            backend: {},
            outDir: opt.outDir,
            workingDirectory: bt.workingDirectory,
        }
    )

    const getInfraSource = (fileName: string, id: string, virtualLocation: string) => getSource(fileName, id, virtualLocation, 'infra')
    const runtime = loader.createRuntime(sources, getInfraSource, solvePerms)

    // The target module is always the _source_ file
    const workingDirectory = opt.compilerOptions?.workingDirectory ?? process.cwd()
    const targetModules = entrypoints.map(x => path.resolve(workingDirectory, x)).map(x => {
        const resolved = sources.find(s => s.source === x)?.name
        if (!resolved) {
            throw new Error(`Missing output file for source: ${x}`)
        }

        return resolved
    })

    function addSynapseVersion(template: TfJson) {
        const version = getCurrentVersion()
        const ext = (template as Mutable<TfJson>)['//'] ??= {}
        ext.synapseVersion = `${version.semver}${version.revision ? `-${version.revision}` : ''}`

        return template
    }

    const { terraform, permissions } = opt.esm 
        ? await loader.synthEsm(targetModules, runtime)
        : loader.synth(targetModules, runtime)

    const template = addSynapseVersion(terraform.main)

    // if (permissions.length > 0) {
    //     getLogger().log(`Required permissions:`, permissions)
    // }

    getLogger().emitCompileEvent({
        entrypoint: '',
        template,
    })

    return template
}

interface Program {
    graphCompiler: ReturnType<typeof createGraphCompiler>
    resourceTransformer: ResourceTransformer
}
