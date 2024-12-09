import ts from 'typescript'
import * as path from 'node:path'
import { createFileHasher, isWindows, keyedMemoize, memoize, throwIfNotFileNotFoundError } from '../utils'
import { Fs } from '../system'
import { getGlobalCacheDirectory } from '../workspaces'
import { getFs, pushDisposable } from '../execution'
import { getProgramFs } from '../artifacts'

interface DependencyEdge {
    readonly kind: 'import' | 'export'
    readonly specifier: string
    readonly isTypeOnly: boolean
    readonly resolved?: ts.ResolvedModuleFull

    // For debugging
    // readonly symbols?: any[]
}

function isTypeOnly(decl: ts.ImportDeclaration | ts.ExportDeclaration) {
    if (ts.isImportDeclaration(decl)) {
        const clause = decl.importClause
        if (!clause) {
            return false
        }

        if (clause.isTypeOnly) {
            return true
        }

        if (clause.name) {
            return false
        }

        const bindings = decl.importClause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
            return bindings.elements.every(item => item.isTypeOnly)
        }

        return false
    }

    if (decl.isTypeOnly) {
        return true
    }

    if (decl.exportClause) {
        if (ts.isNamedExports(decl.exportClause)) {
            return decl.exportClause.elements.every(item => item.isTypeOnly)
        }
    }

    return false
}

function getDependencies(sourceFile: ts.SourceFile, opt: ts.CompilerOptions, host: ts.ModuleResolutionHost = ts.sys) {
    const edges: DependencyEdge[] = []
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
            const spec = (statement.moduleSpecifier as ts.StringLiteral)?.text
            if (!spec) continue

            const { resolvedModule } = ts.resolveModuleName(spec, sourceFile.fileName, opt, host)
            edges.push({
                kind: ts.isImportDeclaration(statement) ? 'import' : 'export',
                resolved: resolvedModule,
                specifier: spec,
                isTypeOnly: isTypeOnly(statement),
            })
        }
    }

    return edges
}

export type CompilationGraph = Awaited<ReturnType<typeof getCompilationGraph>>

function getCompilationGraph(
    rootFileNames: readonly string[],
    getDeps: (fileName: string) => Dependency[] | void // Promise<Dependency[] | void> | Dependency[] | void,
) {
    const visited = new Set<string>()
    const edges: [from: string, to: string][] = []
    const typeEdges = new Set<number>()
    const specifiers = new Map<number, string>()

    function dfs(fileName: string) {
        if (visited.has(fileName)) {
            return
        }

        visited.add(fileName)

        const deps = getDeps(fileName)
        if (!deps) {
            return
        }

        const nextNodes = new Set<string>()
        function addEdge(from: string, to: string, specifier: string, isTypeOnly?: boolean) {
            edges.push([from, to])
            nextNodes.add(to)
            specifiers.set(edges.length - 1, specifier)
            if (isTypeOnly) {
                typeEdges.add(edges.length - 1)
            }
        }

        for (const d of deps) {
            addEdge(fileName, d.fileName, d.specifier, d.isTypeOnly)
        }

        [...nextNodes].forEach(dfs)
    }

    rootFileNames.forEach(dfs)

    return {
        files: [...visited.values()],
        edges,
        typeEdges,
        specifiers,
    }
}

interface Dependency {
    readonly fileName: string
    readonly specifier: string
    readonly isTypeOnly?: boolean
    readonly isExternalLibraryImport?: boolean
}


interface DepGraphCache {
    [file: string]: {
        readonly hash: string
        // readonly programs: string[]
        readonly dependencies?: Dependency[]
    }
}

const incrementalFileName = `[#compile]__incremental__.json`
async function loadCache(fs: Pick<Fs, 'readFile'> = getProgramFs()): Promise<DepGraphCache> {
    try {
        return JSON.parse(await fs.readFile(incrementalFileName, 'utf-8'))
    } catch (e) {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
        return {}
    }
}

async function saveCache(data: DepGraphCache, fs: Pick<Fs, 'writeFile'> = getProgramFs()) {
    await fs.writeFile(incrementalFileName, JSON.stringify(data))
}

function checkDidChange(k: string, cache: DepGraphCache, visited = new Set<string>()) {
    const cached = cache[k]
    if (!cached) {
        return true
    }

    if (!cached.dependencies) {
        return false
    }

    for (const d of cached.dependencies) {
        const f = d.fileName
        if (!visited.has(f)) {
            visited.add(f)
            if (checkDidChange(f, cache, visited)) {
                return true
            }
        }
    }

    return false
}

export type Compilation = { graph: CompilationGraph; changed: Set<string> }

export async function clearIncrementalCache() {
    await getProgramFs().deleteFile(incrementalFileName).catch(throwIfNotFileNotFoundError)
}

export const getFileHasher = memoize(() => {
    const hasher = createFileHasher(getFs(), getGlobalCacheDirectory())

    return pushDisposable(hasher)
})

// TODO: clear cache when updating packages
export type IncrementalHost = ReturnType<typeof createIncrementalHost>
export function createIncrementalHost(opt: ts.CompilerOptions) {
    const fileChecker = getFileHasher()
    const checkFile = keyedMemoize(fileChecker.checkFile)

    const graphs = new WeakMap<ts.Program, Compilation>()

    async function getCachedGraph(oldHashes?: Record<string, string>) {
        const depsCache = await loadCache()
        const invalidated = new Set<string>()
        
        async function check(k: string, v: { hash: string; dependencies?: Dependency[] }) {
            const r = await checkFile(k).catch(e => {
                throwIfNotFileNotFoundError(e)
                invalidated.add(k)
            })

            const h = oldHashes?.[k] ?? v.hash
            if (h !== r?.hash || invalidated.has(k) || v.dependencies?.find(x => invalidated.has(x.fileName))) {
                delete depsCache[k]
            }
        }

        await Promise.all(Object.entries(depsCache).map(([k, v]) => check(k, v)))

        return depsCache
    }

    async function updateCachedGraph(cache: DepGraphCache, graph: CompilationGraph) {
        const updatedCache: DepGraphCache = {}
        const changed = new Set<string>()
        const p: Promise<void>[] = []
        for (const sf of graph.files) {
            if (cache[sf]) {
                continue
            }

            p.push(checkFile(sf).then(r => {
                updatedCache[sf] = { hash: r.hash }
                changed.add(sf)
            }).catch(e => {
                throwIfNotFileNotFoundError(e)
                delete updatedCache[sf]
            }))
        }

        await Promise.all(p)

        for (let i = 0; i < graph.edges.length; i++) {
            const [from, to] = graph.edges[i]
            if (cache[from]) {
                continue
            }

            const o = updatedCache[from]
            if (!o.dependencies) {
                Object.assign(o, { dependencies: [] })
            }
            o.dependencies!.push({ 
                fileName: to,
                specifier: graph.specifiers.get(i)!,
                isTypeOnly: graph.typeEdges.has(i) ? true : undefined 
            })
        }

        await saveCache({ ...cache, ...updatedCache })

        if (isWindows()) {
            return new Set([...changed].map(f => f.replaceAll('\\', '/')))
        }

        return changed
    }

    async function getGraph(program: ts.Program, host?: ts.ModuleResolutionHost, cache?: DepGraphCache, roots = program.getRootFileNames()) {
        if (graphs.has(program)) {
            return graphs.get(program)!
        }

        const opt = program.getCompilerOptions()
        cache ??= await getCachedGraph()

        const getDeps = keyedMemoize(fileName => {
            if (cache![fileName]) {
                return cache![fileName].dependencies
            }

            const sf = program.getSourceFile(fileName)
            if (!sf) {
                if (fileName.endsWith('.d.ts')) {
                    // getLogger().warn(`Missing external lib`, fileName)
                    return
                }

                // This isn't always an error. The user could've deleted the file.
                // Right now this only happens when we fail to evict a dependent file from the cache.
                // throw new Error(`Missing source file: ${fileName}`)
                return
            }

            const deps = getDependencies(sf, opt, host)

            return deps
                // .filter(d => d.resolved && !d.resolved.isExternalLibraryImport)
                .filter(d => d.resolved)
                .map(d => ({ 
                    fileName: d.resolved!.resolvedFileName,
                    specifier: d.specifier,
                    isTypeOnly: d.isTypeOnly,
                    isExternalLibraryImport: d.resolved!.isExternalLibraryImport,
                }))
        })

        const graph = getCompilationGraph(roots, getDeps)
        const changed = await updateCachedGraph(cache, graph)

        graphs.set(program, { graph, changed })

        return { graph, changed }
    }

    async function _getTsCompilerHost() {
        return ts.createCompilerHost(opt, true)
    }

    const getTsCompilerHost = memoize(_getTsCompilerHost)

    async function getProgram(roots: string[], oldHashes?: Record<string, string>) {
        const host = await getTsCompilerHost()
        const cache = await getCachedGraph(oldHashes)
        const pruned = roots.filter(f => checkDidChange(f, cache))
        const program = ts.createProgram(pruned, opt, host) // This takes 99% of the time for `getProgram`
        const { graph, changed } = await getGraph(program, host, cache, roots)

        return { program, graph, changed }
    }

    async function getCachedDependencies(...files: string[]) {
        const depsCache = await loadCache()
        const graph = getCompilationGraph(files, f => depsCache[f]?.dependencies)

        return graph
    }

    async function getCachedHashes() {
        const depsCache = await loadCache()
        const hashes: Record<string, string> = {}
        for (const [k, v] of Object.entries(depsCache)) {
            hashes[k] = v.hash
        }

        return hashes
    }

    return { getProgram, getGraph, getCachedDependencies, getCachedHashes, getTsCompilerHost }
}

export function getAllDependencies(graph: CompilationGraph, files: string[]) {
    const deps = new Set<string>()
    const index: Record<string, string[]> = {}

    for (let i = 0; i < graph.edges.length; i++) {
        const [from, to] = graph.edges[i]
        const arr = index[from] ??= []
        arr.push(to)
    }

    function visit(k: string) {
        if (deps.has(k)) {
            return
        }

        deps.add(k)
        const z = index[k]
        if (z) {
            for (const d of z) {
                visit(d)
            }
        }
    }

    for (const f of files) {
        visit(f)
    }

    // Roots have to be determined by looking at the transitive dependencies
    // of the original set of files rather than the entire graph
    //
    // IMPORTANT: cycles in the graph will be deleted by this method
    // TODO: find the minimum feedback arc set
    const roots = new Set(files)
    for (const f of deps) {
        const z = index[f]
        if (z) {
            for (const d of z) {
                roots.delete(d)
            }
        }
    }

    return { roots, deps }
}


export function getImmediateDependencies(graph: CompilationGraph, file: string) {
    const deps = new Set<string>()

    for (let i = 0; i < graph.edges.length; i++) {
        const [from, to] = graph.edges[i]
        if (from === file) {
            deps.add(to)
        }
    }

    return deps
}
