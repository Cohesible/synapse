import ts from 'typescript'
import * as path from 'node:path'
import type { TfJson } from 'synapse:terraform'
import { CompilerHost, CompilerOptions, readSources, synth } from './host'
import { JsonFs } from '../system'
import { createTransformer, getModuleBindingId, getTransformDirective } from './transformer'
import { SourceMapHost, getNullTransformationContext } from '../static-solver/utils'
import { createSchemaFactory } from './validation'
import { IncrementalHost, createIncrementalHost, getAllDependencies } from './incremental'
import { ResolvedProgramConfig, getOutputFilename, shouldInvalidateCompiledFiles } from './config'
import { getLogger, runTask } from '../logging'
import { createGraphCompiler, getModuleType } from '../static-solver'
import { ResourceTypeChecker, createResourceGraph } from './resourceGraph'
import { getWorkingDir } from '../workspaces'
import { getArtifactFs, getProgramFs } from '../artifacts'
import { getBuildTargetOrThrow } from '../execution'
import { compileAllZig, getZigCompilationGraph } from '../zig/compile'
import { hasMainFunction } from './entrypoints'
import { isWindows, makeRelative, resolveRelative } from '../utils'

export interface ProgramBuilder {
    emit(program: ts.Program, files?: string[]): Promise<void>
    synth(deployTarget: string): Promise<TfJson>
}

export function createProgramBuilder(
    config: ResolvedProgramConfig, 
    incrementalHost: IncrementalHost = createIncrementalHost(config.tsc.cmd.options),
) {
    const sourcemapHost: SourceMapHost & ts.FormatDiagnosticsHost = {
        getNewLine: () => ts.sys.newLine,
        getCurrentDirectory: () => config.tsc.rootDir,
        getCanonicalFileName: (ts as any).createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames)
    }

    function getFiles() {
        if (!config.csc.targetFiles) {
            return
        }

        const targetFiles = Array.isArray(config.csc.targetFiles) ? config.csc.targetFiles : [config.csc.targetFiles]
        const resolved = targetFiles.map(f => path.resolve(config.csc.workingDirectory!, f))

        return new Set(resolved)
    }
    
    const targetFiles = getFiles()

    const rootDir = config.tsc.rootDir
    const workingDir = getWorkingDir()
    const outDir = config.tsc.cmd.options.outDir

    const shouldReplace = isWindows()
    function normalizeFileName(f: string) {
        return shouldReplace ? f.replaceAll('\\', '/') : f
    }

    async function emit(program?: ts.Program, host?: ts.ModuleResolutionHost, incremental = config.csc.incremental) {
        const afs = await getArtifactFs()

        if (!incremental && !config.csc.noInfra) {
            afs.getCurrentProgramStore().clear('compile')
            afs.getCurrentProgramStore().clear('declarations')
        }

        if (shouldInvalidateCompiledFiles(config.tsc)) {
            incremental = false
        }

        // We probably don't need to load this during `watch`?
        const oldSources = incremental ? await readSources() : undefined
        const oldHashes = oldSources ? Object.fromEntries(
            Object.entries(oldSources).map(([k, v]) => [resolveRelative(workingDir, k), v.hash])
        ) : undefined

        // Disabling the incremental flag just means we won't try to use anything from a 
        // previous compilation. We will always persist the results regardless of `incremental`
        if (incremental && !oldHashes) {
            getLogger().log(`Performing full compile due to lack of previous compilation data`)
            incremental = false
        }

        if (!program) {
            program = await runTask('compile', `init program${incremental ? ' (incremental)' : ''}`, async () => {
                if (incremental) {
                    const res = await incrementalHost.getProgram(config.tsc.cmd.fileNames, oldHashes)

                    return res.program
                }

                return ts.createProgram(config.tsc.cmd.fileNames, config.tsc.cmd.options, await incrementalHost.getTsCompilerHost())
            }, 10)
        }

        // The current overhead is about +60% vs. standard `tsc`

        // `lib.dom.d.ts` is pretty big, excluding it can save ~100ms on program init
        // Removing all node types can save another ~200ms
        // `lib.es5.d.ts` is 214k lines. Could get a decent speedup by replacing it with a minimal file

        // const largeFiles = program.getSourceFiles().map(x => [x.fileName, x.text.length] as const).sort((a, b) => b[1] - a[1]).slice(0, 10)
        // const size = largeFiles.reduce((a, b) => a + b[1], 0)
        // if (size >= 1_000_000) {
        //     getLogger().log(`Total size of top 10 largest files exceeds 1MB`, largeFiles)
        //     getLogger().log(config.tsc.cmd.options.types)
        // }

        // `program.getTypeChecker()` is _not_ free. 
        // The typechecker doesn't do much if `noLib` is enabled, so we don't use it at all
        const getTypeChecker = !config.tsc.cmd.options.noLib 
            ? () => runTask('', 'getTypeChecker', () => program.getTypeChecker(), 1)
            : undefined

        const emitHost = createEmitHost()
        const graphCompiler = createGraphCompiler(sourcemapHost, program.getCompilerOptions())
        const compilation = await runTask('compile', 'graph', () => incrementalHost.getGraph(program!, host), 1)
        const resourceGraph = createResourceGraph(program, compilation, graphCompiler)
        const newFiles = program.getSourceFiles()
            .filter(x => !x.isDeclarationFile && !program.isSourceFileFromExternalLibrary(x))
            .map(x => normalizeFileName(x.fileName))

        const allSourceFiles = new Set(config.tsc.files.filter(x => !!x.match(/\.tsx?$/)).map(normalizeFileName))
        
        // ZIG COMPILATION
        const zigGraph = await runTask('zig', 'graph', () => getZigCompilationGraph([...allSourceFiles], workingDir), 1)
        if (zigGraph?.changed) {
            // TODO: check this earlier or make it not required
            if (!config.tsc.cmd.options.allowArbitraryExtensions) {
                throw new Error('Compiling with Zig modules requires adding "allowArbitraryExtensions" to your tsconfig.json "compilerOptions" section')
            }
            await runTask('zig', 'compile', () => compileAllZig([...zigGraph.changed], config), 100)
        }

        const changed = compilation.changed

        // We should not do any type analysis until installing package deps (if any)
        await runTask('compile', 'types', async () => {
            const changedFiles = !incremental ? newFiles : newFiles.filter(x => changed.has(x))
            await resourceGraph.generateTypes(changedFiles, config.tsc.rootDir, config.tsc.cmd.options, incremental)
        }, 1)

        const infraFiles = new Set<string>()
        const executables = new Set<string>()
        const needsRuntimeTransform = new Set<string>()

        if ((config.csc as any).forcedInfra) {
            (config.csc as any).forcedInfra.forEach((f: string) => {
                getLogger().debug(`Marked ${f} as infra file [forced]`)
                infraFiles.add(path.resolve(workingDir, f))
            })
        }

        const oldEntrypoints = incremental ? await getEntrypointsFile() : undefined

        function isDeclarationFile(fileName: string) {
            if (fileName.endsWith('.d.ts')) {
                return true
            }

            if (!config.tsc.cmd.options.allowArbitraryExtensions) {
                return false
            }

            return !!fileName.match(/\.d\.([^\.]+)\.ts$/)
        }

        function determineCompilationModes(program: ts.Program) {
            for (const f of allSourceFiles) {
                if (isDeclarationFile(f)) continue

                const r = resourceGraph.getFileResourceInstantiations(f).length 
                if (r > 0) {
                    getLogger().debug(`Marked ${f} as infra file`)
                    infraFiles.add(f)
                } else if (resourceGraph.hasCalledCallables(f) || zigGraph?.zigImportingFiles.has(f)) {
                    getLogger().debug(`Marked ${f} for runtime transforms`)
                    needsRuntimeTransform.add(f)
                }

                if (!incremental) {
                    if (hasMainFunction(getSourceFileOrThrow(program, f), getTypeChecker)) {
                        getLogger().debug(`Marked ${f} as an executable`)
                        executables.add(f)
                    }
                } else {
                    const relPath = path.relative(getWorkingDir(), f)
                    if (changed.has(f)) {
                        if (hasMainFunction(getSourceFileOrThrow(program, f), getTypeChecker)) {
                            getLogger().debug(`Marked ${f} as an executable`)
                            executables.add(f)
                        }
                    } else if (oldEntrypoints?.executables?.[relPath]) {
                        executables.add(f)
                    }
                }
            }
        }

        // note: `getTypeChecker` can make this call seem much worse than it really is
        // For large projects, typescript init (like program and typechecker) usually 
        // takes up more than 75% of the total time for small incremental changes.
        runTask('compile', 'mode analysis', () => determineCompilationModes(program), 10)

        const compilerHost = createHost(graphCompiler, resourceGraph, sourcemapHost, program, config.csc)

        const isShared = config.csc.sharedLib
        const allDeps = infraFiles.size > 0 && !isShared
            ? getAllDependencies(compilation.graph, [...infraFiles]) 
            : undefined

        // Entrypoints for synthesis, not package entrypoints
        const entrypoints = allDeps ?  [...allDeps.roots].map(x => path.relative(getWorkingDir(), x)) : []
        const deployables = Object.fromEntries(
            [...infraFiles].map(f => [path.relative(getWorkingDir(), f), getOutputFilename(config.tsc.rootDir, config.tsc.cmd.options, f)])
        )

        const entrypointsFile: EntrypointsFile = {
            entrypoints,
            deployables,
            executables: Object.fromEntries(
                [...executables].map(f => [path.relative(getWorkingDir(), f), getOutputFilename(config.tsc.rootDir, config.tsc.cmd.options, f)])
            )
        }

        emitHost.emitEntrypointsFile(entrypointsFile)

        const compiledFiles = new Set<string>()
        const declaration = config.tsc.cmd.options.declaration

        function getCompiledEntrypointsSet() {
            if (declaration !== undefined || !config.compiledEntrypoints) {
                return
            }

            const resolved = config.compiledEntrypoints.map(x => resolveRelative(getWorkingDir(), x))

            return getAllDependencies(compilation.graph, resolved).deps
        }

        const compiledEntrypointsSet = getCompiledEntrypointsSet()

        function shouldEmitDeclaration(sourceFile: string) {
            if (declaration !== undefined) {
                return declaration
            }

            if (!compiledEntrypointsSet) {
                return false
            }

            return compiledEntrypointsSet.has(sourceFile)
        }

        function doCompile(program: ts.Program) {
            for (const f of allSourceFiles) {
                if (isDeclarationFile(f)) {
                    continue
                }
    
                if (targetFiles && !targetFiles.has(f)) {
                    continue
                }
    
                if (incremental && !changed.has(f)) {
                    getLogger().debug(`Skipped unchanged source file ${f}`)
                    continue
                }
    
                const sf = getSourceFileOrThrow(program, f)
                const writeOpt: WriteCallbackOptions = !isShared
                    ? getWriteCallbackOptions(sf, allDeps?.deps.has(f) ?? false, config.csc.includeJs, shouldEmitDeclaration(f), infraFiles?.has(f), needsRuntimeTransform.has(f))
                    : {
                        applyTransform: true,
                        saveTransform: true,
                        declaration,
                    }
        
                if (config.csc.noInfra) {
                    emitHost.emitNoInfra(program, compilerHost, sf, writeOpt)
                } else {
                    emitHost.emit(program, compilerHost, sf, writeOpt)
                }
    
                compiledFiles.add(f)
            }
        }

        runTask('compile', 'transform', () => doCompile(program), 10)

        function getIncluded() {
            return config.tsc.files.filter(f => !allSourceFiles.has(f) || f.endsWith('.d.ts'))
        }

        // note: `watch` needs to be treated the same as `incremental`
        await runTask('compile', 'emit', async () => {
            await emitHost.complete(compilerHost, rootDir, outDir, getIncluded(), config.csc)
        }, 1)

        return {
            compilation,
            infraFiles,
            compiledFiles,
            entrypointsFile,
        }
    }

    async function _synth(deployTarget: string, entrypointsFile?: EntrypointsFile) {
        if (!entrypointsFile) {
            entrypointsFile = await getEntrypointsFile()
            if (!entrypointsFile || entrypointsFile.entrypoints.length === 0) {
                throw new Error(`No entrypoints`)
            }
        }

        const bt = getBuildTargetOrThrow()

        const sources = await readSources() // double read
        if (!sources) {
            throw new Error(`No compilation artifacts found`)
        }

        const mapped = Object.entries(sources).filter(([_, v]) => !v.isTsArtifact).map(([k, v]) => ({ 
            name: path.resolve(bt.workingDirectory, v.outfile), 
            source: path.resolve(bt.workingDirectory, k) 
        }))

        return synth(entrypointsFile.entrypoints, Object.values(entrypointsFile.deployables), {
            outDir,
            sources: mapped,
            compilerOptions: { ...config.csc, deployTarget },

            esm: getModuleType(config.tsc.cmd.options.module) === 'esm',
        })
    }

    async function printTypes(target?: string) {
        const program = await runTask('compile', 'init program', async () => {
            const host = ts.createCompilerHost(config.tsc.cmd.options, true)

            return ts.createProgram(config.tsc.cmd.fileNames, config.tsc.cmd.options, host)
        }, 100)

        const graphCompiler = createGraphCompiler(sourcemapHost, program.getCompilerOptions())
        const compilation =  await incrementalHost.getGraph(program)
        const resourceGraph = createResourceGraph(program, compilation, graphCompiler)
        const newFiles = program.getSourceFiles().filter(x => !x.isDeclarationFile).map(x => x.fileName)
        await runTask('compile', 'init types', async () => {
            await resourceGraph.generateTypes(newFiles, config.tsc.rootDir, config.tsc.cmd.options, false)
        }, 100)

        for (const f of newFiles) {
            resourceGraph.printTypes(f)
        }
    }

    return { emit, synth: _synth, printTypes }
}

interface EntrypointsFile {
    entrypoints: string[]

    // The next two fields map relative source file name to abs. output file
    deployables: Record<string, string>
    executables: Record<string, string>
}

function makeEntrypointsRelative(data: EntrypointsFile, workingDir = getWorkingDir()) {
    const relative = { ...data, deployables: { ...data.deployables }, executables: { ...data.executables } }
    for (const [k, v] of Object.entries(relative.deployables)) {
        relative.deployables[k] = makeRelative(workingDir, v)
    }
    for (const [k, v] of Object.entries(relative.executables)) {
        relative.executables[k] = makeRelative(workingDir, v)
    }
    return relative
}

function resolveEntrypointsFile(data: EntrypointsFile, workingDir = getWorkingDir()) {
    for (const [k, v] of Object.entries(data.deployables)) {
        data.deployables[k] = resolveRelative(workingDir, v)
    }
    for (const [k, v] of Object.entries(data.executables)) {
        data.executables[k] = resolveRelative(workingDir, v)
    }
    return data
}

async function setEntrypointsFile(data: EntrypointsFile) {
    const fs = getProgramFs()
    await fs.writeJson(`[#compile]__entrypoints__.json`, makeEntrypointsRelative(data))
}

export async function getEntrypointsFile(fs: Pick<JsonFs, 'readJson'> = getProgramFs()): Promise<EntrypointsFile | undefined> {
    const data = await fs.readJson(`[#compile]__entrypoints__.json`).catch(e => {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
    })

    return data ? resolveEntrypointsFile(data) : undefined
}

export async function getExecutables() {
    const f = await getEntrypointsFile()

    return f?.executables
}

export async function getDeployables() {
    const f = await getEntrypointsFile()

    return f?.deployables
}

interface WriteCallbackOptions {
    readonly moduleId?: string
    readonly includeJs?: boolean
    readonly needsDeploy?: boolean
    readonly declaration?: boolean
    readonly saveTransform?: boolean
    readonly applyTransform?: boolean
    readonly applyRuntimeTransform?: boolean
    readonly internalModule?: boolean
}

function isInternal(sourceFile: ts.SourceFile) {
    return sourceFile.getFullText().startsWith('//@internal')
}

function getWriteCallbackOptions(sourceFile: ts.SourceFile, isInfra: boolean, includeJs?: boolean, declaration?: boolean, needsDeploy?: boolean, applyRuntimeTransform?: boolean): WriteCallbackOptions {
    const moduleId = getModuleBindingId(sourceFile)
    const isBoundModule = moduleId !== undefined
    const shouldPersist = getTransformDirective(sourceFile) === 'persist'
    const shouldTransform = shouldPersist || (!isBoundModule && isInfra)
    const shouldIncludeJs = (!needsDeploy && includeJs) || isBoundModule

    return {
        moduleId,
        needsDeploy,
        declaration,
        applyRuntimeTransform,
        // Missing package entry: dist/src/zig/util.zig [resolving ./util.zig from dist/src/zig/util.js]
        // applyRuntimeTransform: applyRuntimeTransform && !isInfra,
        applyTransform: shouldTransform,
        saveTransform: shouldPersist,
        includeJs: shouldIncludeJs,
        internalModule: !!moduleId && isInternal(sourceFile),
    }
}

export function createEmitHost() {
    const filePromises: Promise<unknown>[] = []

    function emitWorker(compilerHost: CompilerHost, fileName: string, text: string, sourceFile: ts.SourceFile, opt: WriteCallbackOptions) {
        if (fileName.endsWith('.js')) {
            if (opt.applyTransform) {
                compilerHost.compileSourceFile(ts.getOriginalNode(sourceFile, ts.isSourceFile))
            }

            return compilerHost.saveTscFile(sourceFile, fileName, text, opt.moduleId, opt.internalModule)
        } else if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.ts.map') || fileName.endsWith('.js.map')) {
            return compilerHost.saveTscFile(sourceFile, fileName, text)
        }

        throw new Error(`Unknown file output "${fileName}"`)
    }

    // Maybe not needed anymore.
    function emitMissingIncluded(outDir: string, rootDir: string, include: string[]) {
        const fs = getProgramFs()
        filePromises.push(...include.map(async f => {
            const outputPath = path.resolve(
                outDir,
                path.relative(rootDir, f)
            )
            return fs.writeFile(`[#compile]${outputPath}`, await fs.readFile(f))
        }))
    }

    function createWriteCallback(compilerHost: CompilerHost, sf: ts.SourceFile, opt: WriteCallbackOptions) {
        function writeCallback(fileName: string, text: string, writeByteOrderMark: boolean, onError?: (message: string) => void) {
            try {
                filePromises.push(emitWorker(compilerHost, fileName, text, sf, opt))
            } catch (e) {
                onError?.((e as any).message)
            }
        }

        return writeCallback
    }

    function emit(program: ts.Program, compilerHost: CompilerHost, sourceFile: ts.SourceFile, opt: WriteCallbackOptions) {
        const writeCallback = createWriteCallback(compilerHost, sourceFile, opt)
        if (opt.includeJs && !opt.saveTransform && !opt.applyRuntimeTransform) {
            const r = program.emit(sourceFile, writeCallback)
            if (r.emitSkipped || r.diagnostics.length > 0) {
                // TODO: fail here?
                getLogger().warn(...r.diagnostics.map(x => ts.formatDiagnostic(x, compilerHost.sourceMapHost as any)))
            } else {
                const bt = getBuildTargetOrThrow()
                compilerHost.addSource(
                    path.relative(bt.workingDirectory, sourceFile.fileName), 
                    compilerHost.getOutputFilename(sourceFile.fileName), 
                    true
                )
            }
        } else {
            if (opt.declaration) {
                const result = program.emit(sourceFile, writeCallback, undefined, true)
                if (result.emitSkipped || result.diagnostics.length > 0) {
                    // TODO: fail here?
                    getLogger().warn(...result.diagnostics.map(x => ts.formatDiagnostic(x, compilerHost.sourceMapHost as any)))
                }
            }

            if (opt.applyRuntimeTransform) {
                compilerHost.compileSourceFileRuntimeOnly(sourceFile)
            } else {
                if (opt.needsDeploy) {
                    filePromises.push(compilerHost.emitDeployStub(sourceFile))
                }
                compilerHost.compileSourceFile(sourceFile, opt.saveTransform, opt.moduleId, opt.internalModule)
            }
        }
    }

    function emitNoInfra(program: ts.Program, compilerHost: CompilerHost, sourceFile: ts.SourceFile, opt: WriteCallbackOptions) {
        filePromises.push(compilerHost.emitNoInfra(sourceFile, opt.needsDeploy))
    }

    function emitEntrypointsFile(data: EntrypointsFile) {
        filePromises.push(setEntrypointsFile(data))
    }

    async function complete(compilerHost: CompilerHost, rootDir: string, outDir?: string, include?: string[], config?: { noInfra?: boolean; incremental?: boolean }) {
        if (outDir && include) {
            emitMissingIncluded(outDir, rootDir, include)
        }

        if (!config?.noInfra) {
            filePromises.push(compilerHost.finish(config?.incremental))
        }

        await Promise.all(filePromises)
        filePromises.length = 0
    }

    return { createWriteCallback, emit, emitNoInfra, emitEntrypointsFile, complete }
}

function getSourceFileOrThrow(program: Pick<ts.Program, 'getSourceFile'>, fileName: string) {
    const sf = program.getSourceFile(fileName)
    if (!sf) {
        throw new Error(`No source file found: ${fileName}`)
    }
    return sf
}

export function createHost(
    graphCompiler: ReturnType<typeof createGraphCompiler>,
    resourceTypeChecker: ResourceTypeChecker,
    sourceMapHost: SourceMapHost,
    program: ts.Program, 
    options?: CompilerOptions
) {
    const schemaFactory = createSchemaFactory(program)
    const tsOptions = program.getCompilerOptions()
    const resourceTransformer = createTransformer(
        getWorkingDir(), 
        getNullTransformationContext(), 
        graphCompiler,
        schemaFactory,
        resourceTypeChecker,
    )

    return new CompilerHost(
        sourceMapHost,
        graphCompiler,
        resourceTransformer,
        resourceTypeChecker,
        tsOptions, 
        options,
    )
}

