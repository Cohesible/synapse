import { DataRepository, getDataRepository, listCommits, readJsonRaw, Head, CompiledChunk } from '../artifacts'
import { colorize, printLine, print } from '../cli/ui'
import { deserializeBinaryTemplate } from '../deserializer'
import { getBuildTargetOrThrow, getFs, throwIfCancelled } from '../execution'
import { BaseOutputMessage, getLogger, getTypedEventEmitter } from '../logging'
import { arrayEditDistance, getHash, keyedMemoize, levenshteinDistance, throwIfNotFileNotFoundError } from '../utils'
import { diffLines, jsonDiff, renderInsert, renderRemove, showJsonDiff } from '../utils/diffs'
import { toProgramRef } from '../workspaces'
import { toDataPointer } from './pointers'
import { findArtifactByPrefix, getArtifactByPrefix } from './utils'

export interface BuildFsStats {
    readonly objects: Set<string>
    readonly stores: Set<string>
    readonly indices: Set<string>
    readonly commits: Set<string>

    readonly missing?: Set<string>
    readonly corrupted?: Set<string>
}

interface HeadStats extends BuildFsStats {
    readonly type: 'program' | 'process' | 'unknown'
}

type RepoStats = Record<Head['id'], HeadStats>

// Set union
function mergeSets<T, U = T>(a: Set<T>, b: Set<U>): Set<T | U> {
    return new Set([...a, ...b])
}

function mergeMaps<K, V>(a: Map<K, V>, b: Map<K, V>): Map<K, V>
function mergeMaps<K, V, J>(a: Map<K, V>, b: Map<J, V>): Map<K | J, V>
function mergeMaps<K, V, U>(a: Map<K, V>, b: Map<K, U>): Map<K, V | U>
function mergeMaps<K, V, J, U>(a: Map<K, V>, b: Map<J, U>): Map<Exclude<K, K & J>, V> & Map<Exclude<J, K & J>, U> & Map<K & J, V | U>
function mergeMaps(a: Map<any, any>, b: Map<any, any>) {
    return new Map([...a.entries(), ...b.entries()])
}

function mergeStats(a: BuildFsStats, b: BuildFsStats): BuildFsStats {
    return {
        // objects: mergeMaps(a.objects, b.objects),
        objects: mergeSets(a.objects, b.objects),
        stores: mergeSets(a.stores, b.stores),
        indices: mergeSets(a.indices, b.indices),
        commits: mergeSets(a.commits, b.commits),
    }
}

export function mergeRepoStats(stats: Record<string, BuildFsStats>) {
    let merged = initStats()
    for (const [k, v] of Object.entries(stats)) {
        merged = mergeStats(merged, v)
    }
    return merged
}

// Finds values in `a` but not in `b` aka the relative complement `A \ B`
export function diffSets<T>(a: Set<T>, b: Set<T>): Set<T> {
    const c = new Set<T>()
    for (const v of a) {
        if (!b.has(v)) {
            c.add(v)
        }
    }
    return c
}


export function initStats(): BuildFsStats {
    return {
        objects: new Set(),
        stores: new Set(),
        indices: new Set(),
        commits: new Set(),
    }
}

const refTypes = ['head', 'index', 'store', 'commit', 'file', 'object'] as const
type RefType = (typeof refTypes)[number]

function isRefType(s: string): s is RefType {
    return refTypes.includes(s as any)
}

// `file:${indexHash}:${name}`
// File refs resolve to object refs
type FileRef = `file:${string}:${string}`

// `object:${storeHash}:${hash}`
type ObjectRef = `object:${string}:${string}`

// `index:${hash}`
type ContainerRef = `${Exclude<RefType, 'file' | 'object'>}:${string}`

type Ref = 
    | FileRef
    | ObjectRef
    | ContainerRef


function _parseRef(ref: Ref) {
    const parts = ref.split(':')
    const type = parts.shift()!
    if (!isRefType(type)) {
        throw new Error(`Not a valid ref type: ${type}`)
    }

    const firstPart = parts.shift()
    if (!firstPart) {
        throw new Error(`Invalid ref: ${ref}`)
    }

    switch (type) {
        case 'file':
        case 'object':
            const hash = parts.shift()
            if (!hash) {
                throw new Error(`Invalid ref: ${ref}`)
            }

            if (type === 'object') {
                return { type, store: firstPart, hash } as const
            }

            return { type, index: firstPart, hash } as const

        case 'head':
            return { type, id: firstPart } as const

        default:
            return { type, hash: firstPart } as const
    }
}

const parseRef = _parseRef

interface RefInfo {
    readonly status: 'ok' | 'missing' | 'corrupted' | 'missing-store' | 'corrupted-store'
    readonly ownSize?: number
}

interface ResolvedRefInfo {
    type: RefType,
    size?: number
    hash?: string
    status: RefInfo['status']
}

async function getAllRefs(walker: RepoWalker, ref: Ref) {
    const refs = new Map<Ref, ResolvedRefInfo>()
    const queue: Ref[] = []

    async function enqueue(ref: Ref) {
        throwIfCancelled()

        const info = await walker.resolveRef(ref)
        refs.set(ref, info)

        if (info.status === 'ok') {
            queue.push(ref)
        }
    }

    await enqueue(ref)

    while (queue.length > 0) {
        throwIfCancelled()

        const r = queue.shift()!
        const deps = await walker.getDependencies(r)
        const p: Promise<void>[] = []
        for (const d of deps) {
            if (!refs.has(d)) {
                p.push(enqueue(d))
            }
        }
        await Promise.all(p)
    }

    return refs
}

type RepoWalker = ReturnType<typeof createRepoWalker>
function createRepoWalker(repo: DataRepository, maxCommits?: number, skipIndexDependencies = false) {
    const visited = new Set<Ref>()
    const fromRefs = new Map<string, Set<Ref>>()
    // const toRefs = new Map<string, Set<Ref>>()
    const commitTtl = new Map<string, number>()

    const getStats = keyedMemoize(repo.statData)

    function addRef(from: Ref, to: Ref) {
        const s1 = fromRefs.get(from) ?? new Set()
        //const s2 = toRefs.get(to) ?? new Set()
        s1.add(to)
        // s2.add(from)
        fromRefs.set(from, s1)
        // toRefs.set(to, s2)
    }

    async function getHashStatus(hash: string): Promise<'ok' | 'missing' | 'corrupted'> {
        const stats = await getStats(hash)

        return stats.missing ? 'missing' : stats.corrupted ? 'corrupted' : 'ok'
    }

    async function getRefInfo(parsed: ReturnType<typeof parseRef>): Promise<RefInfo> {
        switch (parsed.type) {
            case 'head':
                const head = await repo.getHead(parsed.id)
                const status = head === undefined ? 'missing' : 'ok'

                return {
                    status,
                    ownSize: 0,
                }
            case 'object':
                const storeStatus = await getHashStatus(parsed.store)
                if (storeStatus !== 'ok') {
                    return { status: `${storeStatus}-store` }
                }
            // Fallsthrough
            case 'commit':
            case 'index':
            case 'store': 
                const hashStats = await getStats(parsed.hash)
                if (hashStats.missing) {
                    return { status: 'missing' }
                }

                return { status: hashStats.corrupted ? 'corrupted' : 'ok', ownSize: hashStats.size }

            default:
                throw new Error(`Not implemented: ${parsed.type}`)
        }
    }

    async function visitObject(hash: string, storeHash: string) {
        const refs = new Set<Ref>()
        const m = repo.getMetadata(hash, storeHash)
        if (m.sourcemaps) {
            for (const [k, v] of Object.entries(m.sourcemaps)) {
                // legacy
                if (typeof v !== 'string' || !v.startsWith('pointer:')) {
                    continue
                }

                const d = toDataPointer(v)
                const { hash, storeHash } = d.resolve()
                refs.add(`object:${storeHash}:${hash}` as Ref)
            }
        }

        if (!m.dependencies) {
            return refs
        }
    
        for (const [source, arr] of Object.entries(m.dependencies)) {
            for (const d of arr) {
                refs.add(`object:${source}:${d}` as Ref)
            }
        }

        return refs
    }

    async function visitStore(hash: string) {
        const refs = new Set<Ref>()
        const store = await repo.getStore(hash)
        for (const [k, v] of Object.entries(await store.listArtifacts())) {
            for (const [k2, v2] of Object.entries(v)) {
                refs.add(`object:${k}:${k2}` as Ref)
            }
        }

        return refs
    }

    const getFsIndex = keyedMemoize(repo.getBuildFs)

    async function visitIndex(hash: string) {
        const refs = new Set<Ref>()
        const { index } = await getFsIndex(hash)
        for (const [name, file] of Object.entries(index.files)) {
            const storeHash = file.storeHash ?? index.stores[file.store].hash
            const key = `${storeHash}:${file.hash}`
            refs.add(`object:${key}` as Ref)
            refs.add(`store:${storeHash}` as Ref)
        }

        for (const [key, store] of Object.entries(index.stores)) {
            refs.add(`store:${store.hash}` as Ref)
        }

        if (index.dependencies && !skipIndexDependencies) {
            for (const [k, v] of Object.entries(index.dependencies)) {
                refs.add(`index:${v}` as Ref)
            }
        }

        return refs
    }

    function getCommitRefs(commit: Head, ttl?: number) {
        const refs = new Set<Ref>()
        refs.add(`index:${commit.storeHash}` as Ref)

        if (commit.programHash) {
            refs.add(`index:${commit.programHash}` as Ref)
        }

        if (commit.previousCommit) {
            const prevRef = `commit:${commit.previousCommit}` as Ref
            refs.add(prevRef)

            if (ttl) {
                commitTtl.set(commit.previousCommit, ttl)
            }
        }

        return refs
    }

    async function visitCommit(hash: string) {
        const ttl = commitTtl.get(hash)
        if (ttl === 1) {
            return new Set<Ref>()
        }

        const commit = await readJsonRaw<Head>(repo, hash)
        if (ttl === undefined) {
            return getCommitRefs(commit)
        }

        return getCommitRefs(commit, ttl - 1)
    }

    async function visitHead(id: string) {
        const h = await repo.getHead(id)
        if (!h) {
            throw new Error(`No head found: ${id}`)
        }

        return getCommitRefs(h, maxCommits)
    }

    async function _getDependencies(parsed: ReturnType<typeof parseRef>) {
        switch (parsed.type) {
            case 'head':
                return visitHead(parsed.id)
            case 'commit':
                return visitCommit(parsed.hash)
            case 'index':
                return visitIndex(parsed.hash)
            case 'store':
                return visitStore(parsed.hash)
            case 'object':
                return visitObject(parsed.hash, parsed.store)
            default:
                throw new Error(`Not implemented: ${parsed.type}`)
        }
    }

    async function getDependencies(ref: Ref) {
        if (fromRefs.has(ref) && visited.has(ref)) {
            return fromRefs.get(ref)!
        }

        visited.add(ref)
        const parsed = parseRef(ref)
        const info = await getRefInfo(parsed)
        if (info.status !== 'ok') {
            throw new Error(`Ref is in an invalid state: ${info.status}`)
        }

        const refs = await _getDependencies(parsed)

        for (const to of refs) {
            addRef(ref, to)
        }

        return refs
    }

    // function getDependents(ref: Ref) {
    //     const refs = toRefs.get(ref)
    //     if (!refs) {
    //         throw new Error(`Ref not found: ${ref}`)
    //     }

    //     return refs
    // }

    async function resolveRef(ref: Ref) {
        const parsed = parseRef(ref)
        const info = await getRefInfo(parsed)

        return {
            type: parsed.type,
            size: info.ownSize,
            status: info.status,
            hash: parsed.hash,
        }
    }

    return { getDependencies, resolveRef }
}

async function visitHead(walker: RepoWalker, id: string) {
    const stats = initStats()
    const refs = await getAllRefs(walker, `head:${id}`)
    for (const [k, r] of refs) {
        if (!r.hash) continue

        if (r.status !== 'ok') {
            switch (r.status) {
                case 'missing':
                    stats.missing?.add(r.hash)
                    break
                case 'corrupted':
                    stats.corrupted?.add(r.hash)
                    break
                
                default:
                    getLogger().log(`Found valid object with invalid store: ${r.hash} [status: ${r.status}]`)
            }

            continue
        }

        if (r.type === 'commit') {
            stats.commits.add(r.hash)
        }
        if (r.type === 'store') {
            stats.stores.add(r.hash)
        }
        if (r.type === 'index') {
            stats.indices.add(r.hash)
        }
        if (r.type === 'object') {
            stats.objects.add(r.hash)
            stats.stores.add(parseRef(k).store!)
        }
    }

    return stats
}

// interface CachedStats {
//     readonly commitHash: string
//     readonly stats: BuildFsStats
// }

// async function getCachedStats(repo: DataRepository, id: string): Promise<CachedStats | undefined> {
//     const path = require('node:path')
//     const cacheDir = path.resolve(repo.getDataDir(), '..', '_stats_cache')
//     const cached = await getFs().readFile(path.resolve(cacheDir, id), 'utf-8').catch(throwIfNotFileNotFoundError)
//     if (!cached) {
//         return
//     }

//     const d = JSON.parse(cached)

//     return {
//         commitHash: d.commitHash,
//         stats: Object.fromEntries(Object.entries(d.stats).map(([k, v]) => [k, new Set(v as any)])) as any,
//     }
// }

// async function setCachedStats(repo: DataRepository, id: string, data: CachedStats): Promise<void> {
//     const path = require('node:path')
//     const cacheDir = path.resolve(repo.getDataDir(), '..', '_stats_cache')
//     await getFs().writeFile(path.resolve(cacheDir, id), JSON.stringify({
//         commitHash: data.commitHash,
//         stats: Object.fromEntries(Object.entries(data.stats).map(([k, v]) => [k, Array.from(v)])) as any
//     }))
// }

export async function collectAllStats(repo: DataRepository, maxCommits?: number) {
    const results: RepoStats = {}
    const walker = createRepoWalker(repo, maxCommits)

    for (const h of await repo.listHeads()) {
        if (!(h.id in results)) {
            const r = await visitHead(walker, h.id)
            results[h.id] = { ...r, type: 'unknown' }
        }
    }

    return results
}

export async function collectStats(repo: DataRepository, head: string, ignoreIndexDeps = true): Promise<HeadStats> {
    const walker = createRepoWalker(repo, undefined, ignoreIndexDeps)

    if (head.match(/[@:\/]/)) {
        head = getHash(head)
    }

    return {
        ...(await visitHead(walker, head)),
        type: 'unknown',
    }
}

function decode(buf: Uint8Array, encoding: BufferEncoding = 'utf-8') {
    if (Buffer.isBuffer(buf)) {
        return buf.toString(encoding)
    }

    return Buffer.from(buf).toString(encoding)
}

async function _diffObjects(repo: DataRepository, a: Ref, b: Ref) {
    const refA = parseRef(a)
    const refB = parseRef(b)
    if (refA.type !== 'object') {
        throw new Error(`Not an object ref: ${a}`)
    }
    if (refB.type !== 'object') {
        throw new Error(`Not an object ref: ${b}`)
    }

    if (refA.hash === refB.hash) {
        // TODO: diff stores
        return
    }

    const datum = await Promise.all([repo.readData(refA.hash), repo.readData(refB.hash)])
    const strA = decode(datum[0])
    const strB = decode(datum[1])

    // Try diff json
    try {
        return diffJson(JSON.parse(strA), JSON.parse(strB))
    } catch {}

    return diffLines(strA, strB)
}

function diffJson(a: any, b: any) {
    const diff = jsonDiff(a, b)
    showJsonDiff(diff)
}

function isCompiledChunk(o: any): o is CompiledChunk {
    return typeof o === 'object' && !!o && o.kind === 'compiled-chunk' && typeof o.runtime == 'string' && typeof o.infra === 'string'
}

function diffCompiledChunks(a: CompiledChunk, b: CompiledChunk) {
    function diffEncodedText(a: string, b: string, title: string) {
        const diff = jsonDiff(a, b)
        if (diff.kind === 'value' && diff.type === 'string') {
            printLine(colorize('gray', title))
            diffLines(
                Buffer.from(diff.left, 'base64').toString(),
                Buffer.from(diff.right, 'base64').toString()
            )
        }
    }

    diffEncodedText(a.infra, b.infra, 'infra')
    diffEncodedText(a.runtime, b.runtime, 'runtime')
}

export async function diffObjects(repo: DataRepository, a: string, b: string) {
    const resolved = await Promise.all([getArtifactByPrefix(repo, a), getArtifactByPrefix(repo, b)])
    const datum = await Promise.all([repo.readData(resolved[0]), repo.readData(resolved[1])])
    const strA = decode(datum[0])
    const strB = decode(datum[1])
    if (!strA.startsWith('{')) {
        return diffLines(strA, strB)
    }

    const parsedA = JSON.parse(strA)
    const parsedB = JSON.parse(strB)
    if (isCompiledChunk(parsedA) && isCompiledChunk(parsedB)) {
        return diffCompiledChunks(parsedA, parsedB)
    }

    return diffJson(parsedA, parsedB)
}

// It's always a === before, b === after
export async function diffIndices(repo: DataRepository, a: string, b: string) {
    const walker = createRepoWalker(repo)
    const resolved = await Promise.all([getArtifactByPrefix(repo, a), getArtifactByPrefix(repo, b)])
    // const deps = await Promise.all([
    //     getAllRefs(walker, `index:${resolved[0]}`),
    //     getAllRefs(walker, `index:${resolved[1]}`)
    // ])

    // const s1 = new Set(deps[0].keys())
    // const s2 = new Set(deps[1].keys())
    const deps = await Promise.all([
        walker.getDependencies(`index:${resolved[0]}`),
        walker.getDependencies(`index:${resolved[1]}`),
    ])

    const s1 = deps[0]
    const s2 = deps[1]

    const d1 = diffSets(s1, s2)
    const d2 = diffSets(s2, s1)
    if (d1.size === 0 && d2.size === 0) {
        if (resolved[0] !== resolved[1]) {
            printLine('Data is the same but stored differently')
        } else {
            printLine('No differences')
        }
        return
    }

    for (const r of d1) {
        printLine(renderInsert(r))
    }

    for (const r of d2) {
        printLine(renderRemove(r))
    }
}

export async function diffFileInCommit(repo: DataRepository, fileName: string, commit: Head, previousCommit?: Head) {
    const currentIndex = await repo.getBuildFs(commit.storeHash)
    previousCommit ??= commit.previousCommit
        ? JSON.parse(Buffer.from(await repo.readData(commit.previousCommit)).toString('utf-8')) 
        : undefined

    const previousIndex = previousCommit ? await repo.getBuildFs(previousCommit.storeHash) : undefined
    const currentFileHash = currentIndex.index.files[fileName]?.hash
    const previousFileHash = previousIndex?.index.files[fileName]?.hash

    if (currentFileHash === undefined && currentFileHash === previousFileHash) {
        printLine(colorize('brightRed', 'File does not exist'))
        return
    }

    if (fileName === 'template.bin') {
        const currentData = currentFileHash ? Buffer.from(await repo.readData(currentFileHash)) : undefined
        const previousData = previousFileHash ? Buffer.from(await repo.readData(previousFileHash)) : undefined
    
        const currentFile = currentData ? deserializeBinaryTemplate(currentData) : undefined
        const previousFile = previousData ? deserializeBinaryTemplate(previousData) : undefined
    
        return diffJson(previousFile, currentFile)
    }

    const currentData = currentFileHash ? Buffer.from(await repo.readData(currentFileHash)).toString('utf-8') : undefined
    const previousData = previousFileHash ? Buffer.from(await repo.readData(previousFileHash)).toString('utf-8') : undefined

    if (!currentData?.startsWith('{') || !previousData?.startsWith('{')) {
        return diffLines(previousData ?? '', currentData ?? '')
    }

    const currentFile = currentData ? JSON.parse(currentData) : undefined
    const previousFile = previousData ? JSON.parse(previousData) : undefined

    diffJson(previousFile, currentFile)
}

export async function diffFileInLatestCommit(fileName: string, opt?: { commitsBack?: number }) {
    const repo = getDataRepository()
    const commits = await listCommits(toProgramRef(getBuildTargetOrThrow()))
    const latestCommit = commits[0]
    if (!latestCommit) {
        printLine(colorize('brightRed', 'No commit found'))
        return
    }

    if (opt?.commitsBack) {
        const previousCommit = commits[opt.commitsBack]
        if (!previousCommit) {
            throw new Error(`No commit found: ${opt.commitsBack}`)
        }

        return await diffFileInCommit(repo, fileName, latestCommit, previousCommit)
    }


    await diffFileInCommit(repo, fileName, latestCommit)
}

const statData = (hash: string) => getDataRepository().statData(hash)

function printKB(byteCount: number) {
    return `${Math.floor(byteCount / 1024)} kB`
}

async function getTotalSize(hashes: Iterable<string>) {
    const stats = await Promise.all([...hashes].map(statData))

    return stats.reduce((a, b) => a + b.size, 0)
}

export async function printStats(k: string, v: HeadStats) {
    const objectsSize = await getTotalSize(v.objects)
    const storesSize = await getTotalSize(v.stores)
    const indicesSize = await getTotalSize(v.indices)
    const commitsSize = await getTotalSize(v.commits)

    printLine(`ID: ${k} [type: ${v.type}]`)
    printLine('    # of objects', v.objects.size, `(${printKB(objectsSize)})`)
    printLine('    # of stores', v.stores.size, `(${printKB(storesSize)})`)
    printLine('    # of indices', v.indices.size, `(${printKB(indicesSize)})`)
    printLine('    # of commits', v.commits.size, `(${printKB(commitsSize)})`)

    return {
        sizes: {
            objects: objectsSize,
            stores: storesSize,
            indices: indicesSize,
            commits: commitsSize,
        }
    }
}


export async function printTopNLargestObjects(stats: HeadStats, limit = 10) {
    const entries = await Promise.all([...stats.objects].map(async h => [h, await statData(h)] as const))
    const filtered = entries.filter(x => !x[1].missing && !x[1].corrupted).sort((a, b) => b[1].size - a[1].size)

    for (const [k, v] of filtered.slice(0, limit)) {
        printLine(`${k} - ${printKB(v.size)}`)
    }
}

interface GcEvent extends BaseOutputMessage {
    readonly type: 'gc'
    readonly discovered?: number
    readonly deleted?: number
}


interface GcSummaryEvent extends BaseOutputMessage {
    readonly type: 'gc-summary'
    readonly numObjects: number
    readonly numDirs: number
    readonly dryrun?: boolean
}

export function getEventLogger() {
    const emitter = getTypedEventEmitter<GcEvent>('gc')
    const emitter2 = getTypedEventEmitter<GcSummaryEvent>('gc-summary')

    return {
        onGc: emitter.on,
        onGcSummary: emitter2.on,
        emitGcEvent: emitter.fire,
        emitGcSummaryEvent: emitter2.fire,
    }
}
