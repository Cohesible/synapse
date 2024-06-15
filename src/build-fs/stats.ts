import { DataRepository, getDataRepository, listCommits, readJsonRaw, Head } from '../artifacts'
import { colorize, printLine, print } from '../cli/ui'
import { getBuildTargetOrThrow, getFs, throwIfCancelled } from '../execution'
import { BaseOutputMessage, getLogger, getTypedEventEmitter } from '../logging'
import { arrayEditDistance, getHash, keyedMemoize, levenshteinDistance, throwIfNotFileNotFoundError } from '../utils'
import { DataPointer, maybeConvertToPointer, isDataPointer, toDataPointer, isNullHash, pointerPrefix, getNullHash } from './pointers'
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
function createRepoWalker(repo: DataRepository, maxCommits?: number) {
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

        if (index.dependencies) {
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

export async function collectStats(repo: DataRepository, maxCommits?: number) {
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

function decode(buf: Uint8Array, encoding: BufferEncoding = 'utf-8') {
    if (Buffer.isBuffer(buf)) {
        return buf.toString(encoding)
    }

    return Buffer.from(buf).toString(encoding)
}

function renderKey(key: PropertyKey) {
    if (typeof key === 'string') {
        return `${key}:`
    } else if (typeof key === 'number') {
        return `<${key}>`
    }

    if (key.description) {
        return `[@@${key.description}]:`
    }

    return `[unique symbol]:`
}

const renderHashWidth = 12
function renderHash(h: string) {
    return h.slice(0, renderHashWidth)
}

function showJsonDiff(diff: JsonDiff, depth = 0, key?: PropertyKey): void {
    const printWithIndent = (s: string, showKey = true, d = depth) => {
        const withKey = key && showKey ? `${renderKey(key)} ${s}` : s
        printLine(`${'  '.repeat(d)}${withKey}`)
    }

    switch (diff.kind) {
        case 'none':
        case 'reference':
            if (depth === 0) {
                printLine('No differences')
            } else if (diff.kind === 'reference') {
                // printWithIndent('[ref]')
            } else {
                printWithIndent('[none]')
            }
            return

        case 'type':
            printWithIndent(`[type] ${colorize('red', diff.left)} ${colorize('green', diff.right)}`)
            return
        
        case 'value':
            switch (diff.type) {
                case 'string':
                    printWithIndent(`${colorize('red', diff.left)} ${colorize('green', diff.right)}`)
                    return

                case 'pointer':
                    if (diff.metadata.kind !== 'none') {
                        const metadataDiff = `[metadata: ${colorize('red', renderHash(diff.metadata.left))} ${colorize('green', renderHash(diff.metadata.right))}]`
                        if (diff.left.hash === diff.right.hash) {
                            printWithIndent(metadataDiff)
                        } else {
                            printWithIndent(`${metadataDiff} ${colorize('red', renderHash(diff.left.hash))} ${colorize('green', renderHash(diff.right.hash))}`)
                        }
                    } else {
                        printWithIndent(`${colorize('red', renderHash(diff.left.hash))} ${colorize('green', renderHash(diff.right.hash))}`)
                    }
                    return    

                case 'symbol':
                case 'bigint':
                case 'number':
                case 'boolean':
                case 'function':
                    printWithIndent(`${colorize('red', String(diff.left))} ${colorize('green', String(diff.right))}`)
                    return

                case 'array':
                    printWithIndent('[')
                    for (let i = 0; i < diff.diff.length; i++) {
                        const d = diff.diff[i]
                        if (d.kind === 'none') continue

                        if (d.kind === 'type') {
                            if (d.left === 'undefined' && diff.length.kind === 'value' && diff.length.left < diff.length.right) {
                                printWithIndent(renderInsert(`<${i}> ${d.right}`),  false, depth + 1)
                            } else if (d.right === 'undefined' && diff.length.kind === 'value' && diff.length.right < diff.length.left) {
                                printWithIndent(renderRemove(`<${i}> ${d.left}`), false, depth + 1)
                            } else {
                                showJsonDiff(d, depth + 1, i)
                            }
                        } else {
                            showJsonDiff(d, depth + 1, i)
                        }
                    }
                    printWithIndent(']', false)
                    return

                case 'object': {
                    printWithIndent('{')
                    let inserts = 0
                    let deletions = 0
                    for (const d of diff.diff) {
                        if (d[0].kind === 'arrangment') {
                            if (d[0].order.left === -1) { // added
                                if (d[0].value.kind !== 'none') {
                                    throw new Error(`Key diff not implemented: ${d[0].value.kind}`)
                                }
                                inserts += 1
                                printWithIndent(renderInsert(`<${d[0].order.right}> ${d[0].value.value}:`), false, depth + 1)
                            } else if (d[0].order.right === -1) { // removed
                                if (d[0].value.kind !== 'none') {
                                    throw new Error(`Key diff not implemented: ${d[0].value.kind}`)
                                }
                                deletions += 1
                                printWithIndent(renderRemove(`<${d[0].order.left}> ${d[0].value.value}:`), false, depth + 1)
                            } else {
                                if (d[0].value.kind !== 'none') {
                                    throw new Error(`Key diff not implemented: ${d[0].value.kind}`)
                                }

                                // Don't show the order diff if it's accounted for by inserts/deletions
                                if (d[0].order.left + inserts === d[0].order.right - deletions) {
                                    showJsonDiff(d[1], depth + 1, `${d[0].value.value}`)
                                } else {
                                    const orderDiff = `<${colorize('red', String(d[0].order.left))} -> ${colorize('green', String(d[0].order.right))}>`
                                    if (d[1].kind === 'none' || d[1].kind === 'reference') {
                                        printWithIndent(`${orderDiff} ${d[0].value.value}: [same value]`, false, depth + 1)
                                    } else {
                                        showJsonDiff(d[1], depth + 1, `${orderDiff} ${d[0].value.value}`)
                                    }
                                }
                            }

                            continue
                        }

                        if (d[0].kind !== 'none') {
                            throw new Error(`Key diff not implemented: ${d[0].kind}`)
                        }

                        if (d[1].kind === 'none') continue

                        showJsonDiff(d[1], depth + 1, d[0].value)
                    }
                    printWithIndent('}', false)
                }
            }
    }
}

function diffJson(a: any, b: any) {
    const diff = jsonDiff(a, b)
    showJsonDiff(diff)
}

function diffLines(a: string, b: string) {
    const l1 = a.split('\n')
    const l2 = b.split('\n')

    const r = arrayEditDistance(l1, l2, {
        insert: a => a.length,
        remove: b => b.length,
        update: (a, b) => a.length + b.length, //(a, b) => levenshteinDistance(a, b),
    })

    for (const op of r.ops) {
        switch (op[0]) {
            case 'insert':
                printLine(renderInsert(op[1]))
                break
            case 'remove':
                printLine(renderRemove(op[1]))
                break
            case 'update':
                const r2 = arrayEditDistance(op[1].split(''), op[2].split(''), {
                    update: (a, b) => 2,
                })

                for (const op2 of r2.ops) {
                    switch (op2[0]) {
                        case 'insert':
                            print(colorize('green', op2[1]))
                        case 'remove':
                            print(colorize('red', op2[1]))
                            break
                        case 'noop':
                            print(op2[1])
                            break
                        case 'update':
                            throw new Error(`Shouldn't happen`)
                    }
                }

                printLine()
            
                break
        }
    }
}

type PrimitiveType = 'object' | 'symbol' | 'number' | 'string' | 'undefined' | 'bigint' | 'function' | 'boolean'
type ExtendedType = PrimitiveType | 'array' | 'null' | 'pointer'

interface JsonNoDiff {
    readonly kind: 'none'
    readonly value: any
}

interface JsonReferenceDiff {
    readonly kind: 'reference'
    readonly type: 'object' | 'array' // or function
    readonly left: any
    readonly right: any
}

interface JsonTypeDiff {
    readonly kind: 'type'
    readonly left: ExtendedType
    readonly right: ExtendedType
    readonly leftValue: any
    readonly rightValue: any
}

interface JsonPrimitiveValueDiff<T = any> {
    readonly kind: 'value'
    readonly type: Exclude<ExtendedType, 'null' | 'undefined' | 'object' | 'array'>
    readonly left: T
    readonly right: T
}

interface JsonStructuredValueDiff<T = any> {
    readonly kind: 'value'
    readonly diff: T
}

interface JsonArrangementDiff {
    readonly kind: 'arrangment'
    readonly order: JsonNumberDiff
    readonly value: Exclude<JsonDiff, JsonTypeDiff>
}

type JsonKeyDiff = JsonNoDiff | JsonStringDiff | JsonNumberDiff | JsonSymbolDiff | JsonTypeDiff | JsonArrangementDiff

interface JsonObjectDiff extends JsonStructuredValueDiff<[key: JsonKeyDiff, value: JsonDiff][]> {
    readonly type: 'object'
}

interface JsonArrayDiff extends JsonStructuredValueDiff<JsonDiff[]> {
    readonly type: 'array'
    readonly length: JsonNoDiff | JsonNumberDiff
}

interface JsonStringDiff extends JsonPrimitiveValueDiff<string> {
    readonly type: 'string'
}

interface JsonNumberDiff extends JsonPrimitiveValueDiff<number> {
    readonly type: 'number'
}

interface JsonBigintDiff extends JsonPrimitiveValueDiff<bigint> {
    readonly type: 'bigint'
}

interface JsonBooleanDiff extends JsonPrimitiveValueDiff<boolean> {
    readonly type: 'boolean'
}

interface JsonSymbolDiff extends JsonPrimitiveValueDiff<symbol> {
    readonly type: 'symbol'
}

interface JsonFunctionDiff extends JsonPrimitiveValueDiff<Function> {
    readonly type: 'function'
}

interface JsonPointerDiff extends JsonPrimitiveValueDiff<DataPointer> {
    readonly type: 'pointer'
    readonly metadata: JsonNoDiff | JsonStringDiff
}

type JsonDiff = 
    | JsonNoDiff
    | JsonReferenceDiff
    | JsonPointerDiff
    | JsonTypeDiff 
    | JsonObjectDiff
    | JsonArrayDiff
    | JsonStringDiff
    | JsonNumberDiff
    | JsonBigintDiff
    | JsonBooleanDiff
    | JsonSymbolDiff
    | JsonFunctionDiff

function getExtendedType(o: any): ExtendedType {
    if (o === null) {
        return 'null'
    } else if (Array.isArray(o)) {
        return 'array'
    } else if (isDataPointer(o)) {
        return 'pointer'
    }

    return typeof o
}

function jsonObjectDiff(a: any, b: any): JsonObjectDiff | JsonReferenceDiff {
    const diff: [key: JsonKeyDiff, value: JsonDiff][] = []
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    const orderA = Object.fromEntries(keysA.map((k, i) => [k, i]))
    const orderB = Object.fromEntries(keysB.map((k, i) => [k, i]))
    // A new key in A that appears last should not come before a new key in B that appears first
    // Not sure if this works as intended
    const getSortOrder = (k: string) => orderB[k] ?? orderA[k]
    const keys = new Set([...keysA, ...keysB].sort((a, b) => getSortOrder(a) - getSortOrder(b)))
    for (const k of keys) {
        const x = orderA[k] ?? -1
        const y = orderB[k] ?? -1
        const orderDiff = jsonDiff(x, y)
        const kDiff: JsonKeyDiff = orderDiff.kind !== 'none'
            ? { kind: 'arrangment', order: orderDiff as JsonNumberDiff, value: { kind: 'none', value: k } }
            : { kind: 'none', value: k}

        diff.push([kDiff, jsonDiff(a[k], b[k])])
    }

    if (diff.every(d => d[0].kind === 'none' && (d[1].kind === 'none' || d[1].kind === 'reference'))) {
        return { kind: 'reference', type: 'object', left: a, right: b }
    }

    return {
        kind: 'value',
        type: 'object',
        diff,
    }
}

function jsonArrayDiff(a: any[], b: any[]): JsonArrayDiff | JsonReferenceDiff {
    const maxLength = Math.max(a.length, b.length)
    const diff: JsonDiff[] = Array(maxLength)
    const length = jsonDiff(a.length, b.length) as JsonArrayDiff['length']
    for (let i = 0; i < maxLength; i++) {    
        diff[i] = jsonDiff(a[i], b[i])
    }

    if (diff.every(d => d.kind === 'none' || d.kind === 'reference') && length.kind === 'none') {
        return { kind: 'reference', type: 'array', left: a, right: b }
    }

    return {
        kind: 'value',
        type: 'array',
        diff,
        length,
    }
}

function jsonPointerDiff(a: DataPointer, b: DataPointer): JsonPointerDiff | JsonNoDiff {
    if (a.isResolved() && b.isResolved()) {
        const l = a.resolve()
        const r = b.resolve()
        if (l.hash === r.hash) {
            if (l.storeHash !== r.storeHash) {
                return {
                    kind: 'value',
                    type: 'pointer',
                    left: a,
                    right: b,
                    metadata: jsonDiff(l.storeHash, r.storeHash) as JsonStringDiff,
                }
            }
            return { kind: 'none', value: l }
        }
    }

    return {
        kind: 'value',
        type: 'pointer',
        left: a,
        right: b,
        metadata: { kind: 'none', value: '' }, // wrong
    }
}


function jsonDiff(a: any, b: any): JsonDiff {
    if (a === b) {
        return { kind: 'none', value: a }
    }

    // We only do this because reading "raw" objects won't deserialize pointers
    a = maybeConvertToPointer(a)
    b = maybeConvertToPointer(b)

    const left = getExtendedType(a)
    const right = getExtendedType(b)

    if (left !== right) {
        return {
            kind: 'type',
            left,
            right,
            leftValue: a,
            rightValue: b,
        }
    }

    switch (left) {
        case 'symbol':
        case 'bigint':
        case 'number':
        case 'string':
        case 'boolean':
        case 'function':
            return { kind: 'value', type: left, left: a, right: b }

        case 'pointer':
            return jsonPointerDiff(a, b)

        case 'array':
            return jsonArrayDiff(a, b)

        case 'object':
            return jsonObjectDiff(a, b)

        case 'null':
        case 'undefined':
            throw new Error(`Primitive types possibly from different realms: ${a} !== ${b}`)
    }
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

export async function diffObjects(repo: DataRepository, a: string, b: string) {
    const resolved = await Promise.all([getArtifactByPrefix(repo, a), getArtifactByPrefix(repo, b)])
    const datum = await Promise.all([repo.readData(resolved[0]), repo.readData(resolved[1])])
    const strA = decode(datum[0])
    const strB = decode(datum[1])
    if (!strA.startsWith('{')) {
        return diffLines(strA, strB)
    }

    return diffJson(JSON.parse(strA), JSON.parse(strB))
}

function renderInsert(s: string) {
    return colorize('green', `+ ${s}`)
}

function renderRemove(s: string) {
    return colorize('red', `- ${s}`)
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

    const currentFile = currentFileHash ? JSON.parse(Buffer.from(await repo.readData(currentFileHash)).toString('utf-8')) : undefined
    const previousFile = previousFileHash ? JSON.parse(Buffer.from(await repo.readData(previousFileHash)).toString('utf-8')) : undefined
    if (currentFile === previousFile) {
        printLine(colorize('brightRed', 'File does not exist'))
    } else {
        diffJson(previousFile, currentFile)
    }
}

export async function diffFileInLatestCommit(fileName: string, opt?: { commitsBack?: number }) {
    const repo = getDataRepository()
    const commits = await listCommits(getBuildTargetOrThrow().programId)
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
