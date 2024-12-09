import * as path from 'node:path'
import { Duplex, Readable } from 'node:stream'
import { FileHandle, Fs, FsEntity, FsEntityStats, JsonFs, SyncFs, watchForFile } from './system'
import type { ExternalValue, PackageInfo } from './runtime/modules/serdes'
import { getLogger, runTask } from './logging'
import { Mutable, acquireFsLock, createRwMutex, createTrie, deepClone, getHash, isNonNullable, keyedMemoize, memoize, sortRecord, throwIfNotFileNotFoundError, tryReadJson } from './utils'
import type { TerraformPackageManifest, TfJson } from './runtime/modules/terraform'
import { BuildTarget, isRemoteDisabled, getBuildDir, getProgramInfoFromDeployment, getRemoteProjectId, getRootDir, getRootDirectory, getTargetDeploymentIdOrThrow, getWorkingDir, resolveProgramBuildTarget, toProgramRef } from './workspaces'
import {  NpmPackageInfo } from './pm/packages'
import { TargetsFile, readPointersFile } from './compiler/host'
import { TarballFile } from './utils/tar'
import { getBuildTarget, getBuildTargetOrThrow, getExecutionId, getFs, throwIfCancelled } from './execution'
import { TypeInfo, TypesFileData, getTypesFile } from './compiler/resourceGraph'
import { DataPointer, Pointers, applyPointers, createPointer, extractPointers, getEmptyObjectHash, getNullHash, isDataPointer, isNullHash, isNullMetadataPointer, pointerPrefix, toAbsolute, toDataPointer } from './build-fs/pointers'
import { TfState } from './deploy/state'
import { printLine } from './cli/ui'
import { createBlock, getBlockInfo, openBlock } from './build-fs/block'
import { FlatImportMap, SourceInfo } from './runtime/importMaps'
import { RemoteArtifactRepository, createRemoteArtifactRepo } from './build-fs/remote'

export interface GlobalMetadata {
    /** @deprecated */
    readonly multiPart?: {
        readonly parts: string[]
        readonly chunkSize: number
    }
}

export interface LocalMetadata {
    readonly name?: string
    readonly source?: string
    readonly sourcemaps?: Record<string, string>
    readonly publishName?: string
    readonly dependencies?: string[]
    readonly pointers?: Pointers

    readonly packageDependencies?: any

    // This is for things like `synapse:*` which are resolved based on the runtime
    readonly ambientDependencies?: string[]

    readonly sourceDelta?: { line: number; column: number }
    // TODO: use a generic `data` field for everything except dependencies/pointers
}

export interface ArtifactMetadata extends GlobalMetadata, Omit<LocalMetadata, 'dependencies'> {
    readonly dependencies?: Record<string, string[]>
}

export interface Head {
    readonly id: string
    readonly timestamp: string
    readonly storeHash: string
    readonly programHash?: string
    readonly isTest?: boolean
    readonly isRollback?: boolean
    readonly previousCommit?: string
    readonly commitHash?: string
}

export interface SerializedTemplate {
    readonly '//'?: string
    readonly provider: string
    readonly resource: Record<string, string>
    readonly data: Record<string, string>
    readonly terraform: string
    readonly locals: Record<string, string>
    readonly moved?: { from: string; to: string }[]
}

export interface SerializedState {
    readonly serial: number
    readonly version: number
    readonly lineage: string
    readonly resources: Record<string, string>
}


export interface DeployedModule {
    readonly kind: 'deployed'
    readonly table: Record<string | number, ExternalValue | any[]>
    readonly captured: any
    readonly rendered?: string
}

export interface CompiledChunk {
    readonly kind: 'compiled-chunk'
    readonly runtime: string
    readonly infra: string
}

export interface NativeModule {
    readonly kind: 'native-module'
    readonly binding: string // base64
    readonly bindingLocation: string
    readonly sourceName: string
    // TODO: replace `sourceName` with a "source bundle"
}

export type Artifact = 
    | DeployedModule
    | CompiledChunk
    | NativeModule

const isPointer = (fileName: string) => fileName.startsWith(pointerPrefix)
const hasMetadata = (fileName: string) => fileName.length === pointerPrefix.length + 129

function getArtifactName(target: string) {
    if (isDataPointer(target)) {
        return target.hash
    }

    if (!isPointer(target)) {
        throw new Error(`Not an artifact: ${target}`)
    }

    return target.slice(pointerPrefix.length)
}

const chunkSize = 4 * 1024 * 1024 // 4 MB

interface BaseArtifactStore {
    getMetadata(hash: string, source: string): ArtifactMetadata
    readArtifact(hash: string): Promise<Uint8Array>
    readArtifactSync(hash: string): Uint8Array
    listArtifacts(): Promise<Record<string, Record<string, ArtifactMetadata>>>
    listArtifactsSync(): Record<string, Record<string, ArtifactMetadata>>

    // listDependencies(): Promise<Record<string, CommitedArtifactStore>>
    resolveMetadata(metadata: LocalMetadata): ArtifactMetadata
}

export interface ClosedArtifactStore extends BaseArtifactStore {
    readonly state: 'closed'
    readonly hash: string
}

export interface OpenedArtifactStore extends BaseArtifactStore {
    readonly id: string
    readonly state: 'opened'
    setMetadata(hash: string, metadata: ArtifactMetadata): void
    writeArtifact(data: Uint8Array, metadata?: ArtifactMetadata): Promise<string>
    writeArtifactSync(data: Uint8Array, metadata?: ArtifactMetadata): string
    close(): string
}

export type ArtifactStore = OpenedArtifactStore | ClosedArtifactStore

interface DenormalizedStoreManifest {
    readonly type?: 'denormalized'
    readonly artifacts: Record<string, Record<string, ArtifactMetadata>>
}

interface FlatStoreManifest {
    readonly type: 'flat'
    readonly artifacts: Record<string, ArtifactMetadata>
}

type ArtifactStoreManifest = DenormalizedStoreManifest | FlatStoreManifest

interface ArtifactStoreState2 {
    readonly hash?: string
    readonly status: 'opened' | 'closed'
    readonly mode: 'flat'
    readonly workingMetadata: FlatStoreManifest['artifacts']
}

interface ArtifactStoreState3 {
    readonly hash?: string
    readonly status: 'opened' | 'closed'
    readonly mode: 'denormalized'
    readonly workingMetadata: DenormalizedStoreManifest['artifacts']
}


type ArtifactStoreState = ArtifactStoreState2 | ArtifactStoreState3

function initArtifactStoreState(): ArtifactStoreState {
    return {
        status: 'opened',
        mode: 'flat',
        workingMetadata: {},
    }
}

function cow<T extends Record<string, any>>(val: T): T {
    let copied: Partial<T> | undefined
    function getClone() {
        return copied ??= deepClone(val)
    }

    if (val instanceof Map) {
        return new Proxy(val, {
            get: (_, prop, recv) => {
                if (copied) {
                    return Reflect.get(copied, prop, recv)
                }

                if (prop === 'set' || prop === 'delete' || prop === 'clear') {
                    return (...args: any[]) => (Reflect.get(getClone(), prop, recv) as any)(...args)
                }

                return Reflect.get(val, prop, recv)
            },
        })
    }

    if (val instanceof Set || val instanceof Array) {
        throw new Error(`Not implemented`)
    }

    return new Proxy(val, {
        get: (_, prop, recv) => {
            if (copied === undefined) {
                copied = {} as T
            }
            if (prop in copied) {
                return copied[prop as any]
            }

            const v = val[prop as any]

            return (copied as any)[prop] = typeof v !== 'object' || !v ? v : cow(v)
        },
        set: (_, prop, newValue, recv) => {
            if (copied === undefined) {
                copied = {} as T
            }
            (copied as any)[prop] = newValue

            return true
        },
    }) as T
}

// Artifact store 3.0 (call this a "build unit"?)
// * Inputs -> named committed stores
// * Output -> pruned & committed store
// * Attributes (metadata)

interface ResolveArtifactOpts {
    sync?: boolean
    name?: string
    extname?: string
    filePath?: string
    noWrite?: boolean
}

interface RootArtifactStore {
    commitStore(state: ArtifactStoreState): string
    createStore(): OpenedArtifactStore
    getStore(hash: string): Promise<ClosedArtifactStore>
    getStoreSync(hash: string): ClosedArtifactStore

    getBuildFs(hash: string): Promise<ReadonlyBuildFs>

    readData(hash: string): Promise<Uint8Array>
    readDataSync(hash: string): Uint8Array

    writeData(hash: string, data: Uint8Array): Promise<void>
    writeDataSync(hash: string, data: Uint8Array): void

    getMetadata(hash: string): Record<string, ArtifactMetadata> | undefined
    getMetadata(hash: string, source: string): ArtifactMetadata
    getMetadata2(pointer: string): Promise<ArtifactMetadata>
    getMetadata2(hash: string, source: string): Promise<ArtifactMetadata>

    resolveArtifact(hash: string, opt: ResolveArtifactOpts & { sync: true }): string
    resolveArtifact(hash: string, opt?: ResolveArtifactOpts): Promise<string> | string

    deleteData(hash: string): Promise<void>
    deleteDataSync(hash: string): void
}

// function getHash(data: Uint8Array) {
//     const h = createHash('sha256')
//     h.write(data)
//     h.end()

//     return new Promise<string>((resolve, reject) => {
//         h.on('data', (d: Buffer) => {
//             resolve(d.toString('hex'))
//         })
//         h.on('error', reject)
//     })
// }

// function sortArtifacts(artifacts: Record<string, ArtifactMetadata>): Record<string, ArtifactMetadata> {
//     // First sort by content length
//     // Break ties with hash
//     // Then do a topo sort

//     const presort = Object.entries(artifacts).sort((a, b) => {
//         const c = a[1].contentLength! - b[1].contentLength!
//         if (c !== 0) {
//             return c
//         }
//         return a[0].localeCompare(b[0])
//     })

//     // Empty string is the root node
//     const edges: [string, string][] = []
//     for (const [k, v] of presort) {
//         edges.push(['', k])
//         if (v.dependencies) {
//             for (const d of v.dependencies) {
//                 edges.push([k, d])
//             }
//         }
//     }
    
//     const sorted = topoSort(edges).slice(1).reverse()
//     console.log(sorted)

//     return Object.fromEntries(sorted.map(h => [h, artifacts[h]] as const))
// }

function createReverseIndex() {
    const reverseIndex: Record<string, Record<string, ArtifactMetadata>> = {}
    const indexQueue: Record<string, Record<string, ArtifactMetadata>[]> = {}
    const sourceAliases: Record<string, string[]> = {}

    function search(hash: string, source?: string) {
        if (source) {
            const allSources = [source, ...(sourceAliases[source] ?? [])]
            for (const s of allSources) {
                const v = indexQueue[s]
                const m = v ? searchQueue(s, v, hash) : reverseIndex[hash]?.[s]
                if (m) {
                    return m
                }
            }

            return
        }

        for (const [k, v] of Object.entries(indexQueue)) {
            const m = searchQueue(k, v, hash)
            if (m) {
                return m
            }
        }
    }

    function searchQueue(k: string, v: Record<string, ArtifactMetadata>[], hash: string) {
        delete indexQueue[k]

        while (v.length > 0) {
            const n = v.pop()!
            const m = searchAndIndex(k, n, hash)
            if (m) {
                if (v.length > 0) {
                    indexQueue[k] = v
                }

                return m
            }
        }
    }

    function searchAndIndex(source: string, artifacts: Record<string, ArtifactMetadata>, targetHash: string) {
        let found: ArtifactMetadata | undefined
        for (const [k, v] of Object.entries(artifacts)) {
            const o = reverseIndex[k] ??= {}
            if (!o[source]) {
                o[source] = v
            } else {
                // TODO: assert that `v` is equivalent to `o[source]` 
            }

            if (k === targetHash) {
                found = o[source]
            }
        }

        return found
    }

    function index(source: string, artifacts: Record<string, Record<string, ArtifactMetadata>>) {
        if (hasIndex(source)) {
            throw new Error(`Store "${source}" was already indexed`)
        }

        const aliases = sourceAliases[source] = [] as string[]
        for (const [k, v] of Object.entries(artifacts)) {
            if (k === '') {
                throw new Error(`Artifact index is missing source hash: ${source}`)
            }

            const arr = indexQueue[k] ??= []
            arr.push(v)

            if (k !== source) {
                aliases.push(k)
            }
        }
    }

    function get(hash: string): Record<string, ArtifactMetadata> | undefined
    function get(hash: string, source: string): ArtifactMetadata | undefined
    function get(hash: string, source?: string) {
        if (!source) {
            if (!reverseIndex[hash]) {
                return search(hash, source)
            }

            return reverseIndex[hash]
        }

        return reverseIndex[hash]?.[source] ?? search(hash, source)
    }

    function hasIndex(source: string) {
        return !!sourceAliases[source]
    }

    return { get, index, hasIndex }
}

class MetadataConflictError extends Error {
    public constructor(public readonly dataHash: string) {
        super(`Store already has metadata for data: ${dataHash}`)
    }
}

let storeIdCounter = 0
// Stores are strictly additive
// They should not be re-used for the same operation. But they should be re-used for subsequent operations.
function createArtifactStore(root: RootArtifactStore, state = initArtifactStoreState()) {
    const id = `${storeIdCounter++}`

    function close() {
        ;(state as Mutable<typeof state>).status = 'closed'

        return root.commitStore(state)
    }

    function getMetadata(hash: string, source: string): ArtifactMetadata {
        if (state.mode === 'flat') {
            if (source === (state.hash ?? '')) {
                const m = state.workingMetadata[hash]
                if (m) {
                    return m
                }
            }
        } else {
            const m = state.workingMetadata[source]?.[hash]
            if (m) {
                return m
            }
        }

        throw new Error(`No metadata found for ${hash} from ${source}`)
    }

    function setMetadata(hash: string, metadata: ArtifactMetadata): void {
        if (state.status === 'closed') {
            throw new Error(`Cannot write after closed`)
        }

        if (hasMetadata(hash, '')) {
            throw new MetadataConflictError(hash)
        }

        if (state.mode === 'flat') {
            state.workingMetadata[hash] = metadata
        } else {
            const m = state.workingMetadata[''] ??= {}
            m[hash] = metadata
    
            if (metadata.dependencies) {
                ensureDeps(state.workingMetadata, metadata.dependencies, '')
            }
        }
    }

    function ensureDeps(workingMetadata: DenormalizedStoreManifest['artifacts'], deps: Record<string, string[]>, source?: string) {
        for (const [k, v] of Object.entries(deps)) {
            const s = k || source
            if (!s) continue

            for (const d of v) {
                const wm = workingMetadata[s] ??= {}
                if (wm[d]) continue

                const m = root.getMetadata(d, s)

                wm[d] = m
                if (m.dependencies) {
                    ensureDeps(workingMetadata, m.dependencies, s)
                }
            }
        }
    }

    async function splitArtifact(data: Uint8Array) {
        const parts: [string, Buffer][] = []
        for await (const part of createChunkStream(Buffer.from(data))) {
            parts.push([part.hash, part.chunk])
        }

        return { parts, chunkSize }
    }

    async function writeMultipart(hash: string, data: Uint8Array, metadata: ArtifactMetadata) {
        const { parts, chunkSize } = await splitArtifact(data)

        setMetadata(hash, {
            ...metadata,
            multiPart: { parts: parts.map(x => x[0]), chunkSize },
        })

        await root.writeData(hash, data)
        await Promise.all(parts.map(([hash, data]) => write(hash, data)))
    }

    function write(hash: string, data: Uint8Array, metadata: ArtifactMetadata = {}) {
        setMetadata(hash, metadata)

        return root.writeData(hash, data)
    }

    async function writeArtifact(data: Uint8Array, metadata?: ArtifactMetadata): Promise<string> {
        const hash = getHash(data)
        await write(hash, data, metadata)

        return hash
    }

    function writeArtifactSync(data: Uint8Array, metadata?: ArtifactMetadata): string {
        const hash = getHash(data)
        write(hash, data, metadata)

        return hash
    }

    async function readArtifact(name: string): Promise<Uint8Array> {
        return root.readData(name)
    }

    function readArtifactSync(name: string): Uint8Array {
        return root.readDataSync(name)
    }

    function listArtifactsSync() {
        if (state.mode === 'flat') {
            return { [state.hash ?? '']: state.workingMetadata }
        }

        return state.workingMetadata
    }

    async function listArtifacts() {
        return listArtifactsSync()
    }

    function hasMetadata(hash: string, source: string) {
        if (state.mode === 'flat') {
            if (source !== (state.hash ?? '')) {
                return false
            }

            return !!state.workingMetadata[hash]
        }

        return !!state.workingMetadata?.[source]?.[hash]
    }

    function resolveMetadata(metadata: LocalMetadata) {
        const dependencies: Record<string, string[]> = {}
        if (metadata.dependencies) {
            for (const d of metadata.dependencies) {
                if (isDataPointer(d)) {
                    if (d.isResolved() || !d.isContainedBy(id)) {
                        const { hash, storeHash } = d.resolve()
                        const arr = dependencies[storeHash] ??= []
                        arr.push(hash)
                    } else {
                        const arr = dependencies[''] ??= []
                        arr.push(d.hash) 
                    }
                } else if (d.length === 129) { // ${sha256}:${sha256} === 129 characters
                    if (d[64] !== ':') {
                        throw new Error(`Malformed dependency string: ${d}`)
                    }
    
                    const arr = dependencies[d.slice(0, 64)] ??= []
                    arr.push(d.slice(65))
                } else {
                    throw new Error(`Unresolved dependency: ${d}`)
                }
            }
        }

        const sourcemaps: Record<string, string> = {}
        if (metadata.sourcemaps) {
            for (const [k, v] of Object.entries(metadata.sourcemaps)) {
                // This effectively excludes sourcemaps from the dependency graph
                sourcemaps[k] = isDataPointer(v) ? toAbsolute(v) : v
            }
        }
    
        const result = { 
            ...metadata,
            sourcemaps: Object.keys(sourcemaps).length > 0 ? sourcemaps : undefined,
            dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
        }

        const pruned = Object.fromEntries(Object.entries(result).filter(([_, v]) => v !== undefined))

        return pruned
    }

    return {
        id,
        hash: state.hash,
        state: state.status,
        close,
        listArtifacts,
        listArtifactsSync,
        writeArtifact,
        writeArtifactSync,
        readArtifact,
        readArtifactSync,

        getMetadata,
        setMetadata,
        resolveMetadata,
    } as ArtifactStore
}

export function extractPointersFromResponse(resp: any) {
    const [state, pointers] = extractPointers(resp)

    return { state, pointers }
}

export interface ReadonlyBuildFs {
    readonly hash: string
    readonly index: BuildFsIndex
}

interface OpenOptions {
    readonly readOnly?: boolean 
    readonly writeToDisk?: boolean
    readonly clearPrevious?: boolean
}

export interface BuildFsFragment {
    open(key: string, opt?: OpenOptions): BuildFsFragment
    clear(key?: string): void
    mount(path: string, fs: ReadonlyBuildFs): void

    writeFile(fileName: string, data: string | Uint8Array, metadata?: LocalMetadata): Promise<DataPointer>
    writeFileSync(fileName: string, data: string | Uint8Array, metadata?: LocalMetadata): void
    writeData(data: Uint8Array, metadata?: LocalMetadata): Promise<DataPointer>
    writeDataSync(data: Uint8Array, metadata?: LocalMetadata): DataPointer

    readFile(fileName: string): Promise<Uint8Array>
    readFile(fileName: string, encoding: BufferEncoding): Promise<string>

    readFileSync(fileName: string): Uint8Array
    readFileSync(fileName: string, encoding: BufferEncoding): string

    readData(hash: string): Promise<Uint8Array>
    readDataSync(hash: string): Uint8Array

    fileExistsSync(fileName: string): boolean
    dataExistsSync(hash: string): boolean

    getMetadata(fileName: string, dataHash?: string): Promise<ArtifactMetadata>
    getMetadataSync(fileName: string, dataHash?: string): ArtifactMetadata

    listFiles(): Promise<{ name: string; hash: string }[]>

    // BACKWARDS COMPAT
    writeArtifact(data: Uint8Array, metadata?: LocalMetadata): Promise<string>
    writeArtifactSync(data: Uint8Array, metadata?: LocalMetadata): string
    readArtifact(pointer: string): Promise<Uint8Array>
    readArtifactSync(pointer: string): Uint8Array
    resolveArtifact(pointer: string, opt: ResolveArtifactOpts & { sync: true }): string
    resolveArtifact(pointer: string, opt?: ResolveArtifactOpts): Promise<string> | string

    writeData2(data: any, metadata?: LocalMetadata): Promise<DataPointer>
    readData2(pointer: string): Promise<any>
}

interface BuildFsFile {
    readonly hash: string
    readonly store: string
    readonly storeHash?: string
    // readonly mount?: string
}

interface BuildFsStore {
    readonly hash: string
}

export interface BuildFsIndex {
    readonly files: Record<string, BuildFsFile>
    readonly stores: Record<string, BuildFsStore>
    readonly dependencies?: Record<string, string> // Extra FS hashes that should be accounted for during GC
}

interface DumpFsOptions {
    readonly link?: boolean
    readonly clean?: boolean
    readonly prettyPrint?: boolean
    readonly writeIndex?: boolean
}

async function dump(repo: DataRepository, index: BuildFsIndex & { id?: string }, dest: string, opt?: DumpFsOptions) {
    const fs = getFs()

    async function doClean() {
        await fs.deleteFile(dest).catch(throwIfNotFileNotFoundError)
    }

    if (opt?.clean) {
        await doClean()
    }

    const indexPath = path.resolve(dest, '__index__.json')
    const oldIndex = !opt?.clean ? await tryReadJson<typeof index>(fs, indexPath) : undefined

    if (opt?.writeIndex && !opt?.clean && !oldIndex) {
        if (await fs.fileExists(dest)) {
            getLogger().debug(`Removing corrupted linked package`)
            await fs.deleteFile(dest)
        }
    }

    let shouldIgnoreOld = false
    if (oldIndex && oldIndex.id !== index.id) {
        getLogger().debug(`Removing old linked package`)
        await doClean()
        shouldIgnoreOld = true
    }

    async function worker(k: string, v: BuildFsFile) { 
        const oldHash = oldIndex?.files[k]?.hash
        if (!shouldIgnoreOld && oldHash === v.hash) {
            return
        }

        const destPath = path.resolve(dest, k)
        if (oldHash && oldHash !== v.hash) {
            await fs.deleteFile(destPath).catch(throwIfNotFileNotFoundError)
        }

        const fp = await repo.resolveArtifact(v.hash, { noWrite: true })
        if (k.endsWith('.json') && opt?.prettyPrint) {
            const data = JSON.parse(decode(await repo.readData(v.hash), 'utf-8'))
            await fs.writeFile(destPath, JSON.stringify(data, undefined, 4))
        } else if (opt?.link) {
            await fs.link(fp, destPath).catch(async e => {
                if ((e as any).code !== 'EEXIST') {
                    throw e
                }
                await fs.deleteFile(destPath)
                await fs.link(fp, destPath)
            })
        } else {
            await fs.writeFile(destPath, await repo.readData(v.hash))
        }
    }

    await Promise.all(Object.entries(index.files).map(([k, v]) => worker(k, v))) 

    if (oldIndex && !shouldIgnoreOld) {
        for (const [k, v] of Object.entries(oldIndex.files)) {
            if (!(k in index.files)) {
                await fs.deleteFile(path.resolve(dest, k)).catch(throwIfNotFileNotFoundError)
            }
        }
    }

    if (opt?.writeIndex) {
        await fs.writeFile(indexPath, JSON.stringify(index, undefined, 4))
    }
}

export interface WriteFileOptions {
    readonly encoding?: BufferEncoding
    readonly flag?: 'w' | 'wx' // | 'w+' | 'wx+'

    /** Using `#mem` writes a temporary in-memory file */
    readonly fsKey?: '#mem' | string
    readonly metadata?: LocalMetadata
    readonly checkChanged?: boolean
}

// `fsKey` format:
// [ ${fsId}: ]${storeKey}

function parseFsKey(key: string) {
    const splitIndex = key.indexOf(':')
    if (splitIndex === -1) {
        return { storeKey: key }
    }

    const fsId = key.slice(0, splitIndex)
    const storeKey = key.slice(splitIndex + 1)

    return { fsId, storeKey }
}

// [#${fsKey}]${fileName}
function hasBuildFsPrefix(fileName: string) {
    return fileName.startsWith('[#')
}

function parseBuildFsPrefix(fileName: string) {
    const match = fileName.match(/^\[#([^\[#\]]+)\](.*)/)
    if (!match) {
        throw new Error(`Failed to parse prefix from name: ${fileName}`)
    }

    const keyComponents = parseFsKey(match[1])
    const actualFileName = match[2]

    return {
        fileName: actualFileName,
        fsId: keyComponents.fsId,
        storeKey: keyComponents.storeKey,
    }
}

export interface ReadFileOptions {
    readonly encoding?: BufferEncoding
    readonly fsKey?: '#mem' | string
}

function decode(data: Uint8Array, encoding: BufferEncoding) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)

    return buf.toString(encoding)
}

interface OpenedBuildFs {
    key: string
    store: OpenedArtifactStore
    files: Record<string, string>
    pointers: Record<string, DataPointer>
    options?: OpenOptions
    didChange?: boolean
}

function fixWindowsPath(p: string) {
    return p.replaceAll('\\', '/')
}

/** @internal */
export function createBuildFsFragment(repo: DataRepository, index: BuildFsIndex, copier = createCopier(repo)) {
    const opened: Record<string, OpenedBuildFs> = {}
    const mounts: Record<string, ReadonlyBuildFs> = {}
    const dependencies: Record<string, string> = { ...index.dependencies }
    const storeHashes: Record<string, string> = {}
    let didIndexChange = false

    function searchMounts(fileName: string) {
        for (const [k2, v2] of Object.entries(mounts)) {
            if (fileName.startsWith(k2)) {
                const rel = path.posix.relative(k2, fileName)
                const f = v2.index.files[rel]
                if (f) {
                    return { store: k2 + '/' + f.store, fileHash: f.hash, storeHash: f.storeHash ?? v2.index.stores[f.store].hash }
                }
            }
        }
    }

    function findOpenedFile(fileName: string) {
        // TODO: use flat list to track opened files
        for (const [k, v] of Object.entries(opened)) {
            const hash = v.files[fileName]
            if (hash) {
                return { store: k, fileHash: hash }
            }
        }
    }

    function findFile(fileName: string, useMounts = true) {
        const f = index.files[fileName]
        if (f) {
            return { fileHash: f.hash, store: f.store, storeHash: f.storeHash ?? index.stores[f.store].hash }
        }

        return useMounts ? searchMounts(fileName) : undefined
    }

    function getSubstores(key: string) {
        const prefix = key === '/' ? key : `${key}/`

        return Object.keys(index.stores).filter(k => k.startsWith(prefix))
    }

    function getFilesFromStore(key: string) {
        const res: Record<string, string> = {}
        for (const [k, v] of Object.entries(index.files)) {
            if (v.store === key) {
                res[k] = v.hash
            }
        }
        return res
    }

    function renameStore(from: string, to: string) {
        if (from === to) {
            return
        }

        assertOpen()

        const moves: [from: string, to: string][] = []
        function addMove(from: string, to: string) {
            if (opened[from]) {
                throw new Error(`Cannot rename an opened store: ${from}`)
            }
            if (opened[to] || index.stores[to]) {
                throw new Error(`Cannot rename to an existing store: ${to}`)
            }
            if (!index.stores[from]) {
                throw new Error(`No such store exists: ${from}`)
            }
            moves.push([from, to])
        }

        addMove(from, to)
        for (const fromKey of getSubstores(from)) {
            const toKey = `${to}${fromKey.slice(from.length)}`
            addMove(fromKey, toKey)
        }

        for (const [fromKey, toKey] of moves) {
            index.stores[toKey] = index.stores[fromKey]
            for (const [k, v] of Object.entries(getFilesFromStore(fromKey))) {
                index.files[k] = { 
                    hash: v, 
                    store: toKey,
                    storeHash: index.files[k].storeHash,
                }
            }
        }

        didIndexChange = true
    }

    function assertOpen() {
        if (closed) {
            throw new Error(`Build fs already closed`)
        }
    }

    let closed = false
    function flush() {
        assertOpen()
        closed = true
        return _flush()
    }

    function updateIndex(): BuildFsIndex | undefined {
        const pending = Object.keys(opened)
        for (const key of pending) {
            _close(key)
        }

        // This could be more granular by checking if each component changed  
        if (!didIndexChange) {
            return
        }

        return {
            files: sortRecord(index.files),
            stores: sortRecord(index.stores),
            dependencies: sortRecord(dependencies),
        }
    }

    async function _flush() {
        const newIndex = updateIndex()
        if (newIndex === undefined) {
            return
        }

        return await writeJsonRaw(repo, newIndex)
    }

    function _close(key: string) {
        const data = opened[key]
        delete opened[key]
        stores.delete(key)

        if (!data.didChange && !data.options?.clearPrevious) {
            return storeHashes[data.store.id] = index.stores[key]?.hash ?? getNullHash()
        }

        return commit(key, data)
    }

    function commit(key: string, data = getOpenedOrThrow(key)) {
        const hash = data.store.close()
        const oldHash = index.stores[key]?.hash
        if (oldHash === hash) {
            return storeHashes[data.store.id] = hash 
        }

        index.stores[key] = { hash }
        didIndexChange = true

        for (const [k, v] of Object.entries(data.files)) {
            index.files[k] = {
                hash: v,
                store: key,
            }
        }

        for (const [k, v] of Object.entries(index.files)) {
            if (v.store === key && !v.storeHash && !data.options?.clearPrevious && !(k in data.files)) {
                index.files[k] = {
                    ...index.files[k],
                    storeHash: oldHash,
                }
            }
        }

        return storeHashes[data.store.id] = hash 
    }

    function getStoreByKey(key: string) {
        const s = index.stores[key]
        if (!s) {
            throw new Error(`No store found: ${key}`)
        }
        return s
    }

    async function getStore(key: string) {
        return repo.getStore(getStoreByKey(key).hash)
    }

    function getStoreSync(key: string) {
        return repo.getStoreSync(getStoreByKey(key).hash)
    }

    function deleteStore(key: string) {
        const shouldDelete = new Set<string>()

        function checkForRemoval(k: string) {
            if (!!index.stores[k] || !!opened[k]) {
                shouldDelete.add(k)
            }
        }

        checkForRemoval(key)
        for (const k of getSubstores(key)) {
            checkForRemoval(k)
        }

        if (shouldDelete.size === 0) {
            return
        }

        assertOpen()

        for (const [k, v] of Object.entries(index.files)) {
            if (shouldDelete.has(v.store)) {
                delete index.files[k]
            }
        }

        for (const k of shouldDelete) {
            delete index.stores[k]
            delete opened[k]
        }

        didIndexChange = true
    }

    function listStores() {
        return index.stores
    }

    function listFiles(key?: string) {
        const resolvedKey = key && !key.startsWith('/') ? `/${key}` : key
        const allFiles: Record<string, { hash: string; store: { name: string; hash: string; } }> = {}
        for (const [k, v] of Object.entries(index.files)) {
            if (resolvedKey && !v.store.startsWith(resolvedKey)) continue

            allFiles[k] = {
                hash: v.hash,
                store: { name: v.store, hash: v.storeHash ?? index.stores[v.store].hash },
            }
        }

        return allFiles
    }

    function resolveArtifact(pointer: string, opt: ResolveArtifactOpts & { sync: true }): string
    function resolveArtifact(pointer: string, opt?: ResolveArtifactOpts): Promise<string> | string
    function resolveArtifact(pointer: string, opt?: ResolveArtifactOpts) {
        const hash = getArtifactName(pointer)

        return repo.resolveArtifact(hash, opt)
    }

    function mount(path: string, fs: ReadonlyBuildFs) {
        if (process.platform === 'win32') {
            path = fixWindowsPath(path)
        }

        mounts[path] = fs
        if (index.dependencies?.[path] !== fs.hash) {
            assertOpen()
            dependencies[path] = fs.hash
            didIndexChange = true
        }
    }

    function unmount(path: string) {
        if (process.platform === 'win32') {
            path = fixWindowsPath(path)
        }

        if (mounts[path]) {
            assertOpen()
            delete mounts[path]
            if (dependencies[path]) {
                delete dependencies[path]
                didIndexChange = true
            }
        }
    }

    function readDataSync(hash: string, encoding: BufferEncoding) {
        return encoding ? decode(repo.readDataSync(hash), encoding) : repo.readDataSync(hash)
    }

    function _resolveMetadata(target: OpenedBuildFs, metadata?: LocalMetadata): ArtifactMetadata | undefined
    function _resolveMetadata(target: OpenedBuildFs, metadata: LocalMetadata): ArtifactMetadata
    function _resolveMetadata(target: OpenedBuildFs, metadata?: LocalMetadata) {
        return metadata ? target.store.resolveMetadata(metadata) : undefined
    }

    function _write(target: OpenedBuildFs, data: Uint8Array, metadata: LocalMetadata | undefined, isAsync?: false): DataPointer
    function _write(target: OpenedBuildFs, data: Uint8Array, metadata: LocalMetadata | undefined, isAsync: true): Promise<DataPointer>
    function _write(target: OpenedBuildFs, data: Uint8Array, metadata: LocalMetadata | undefined, isAsync?: boolean) {
        target.didChange = true // TODO: would it be faster to check the # of files on close?

        const resolved = _resolveMetadata(target, metadata)
        if (resolved === undefined || Object.keys(resolved).length === 0) {
            // No metadata means we don't need to use a store
            const dataHash = getHash(data)
            const np = createPointer(dataHash, getNullHash())

            if (isAsync) {
                return repo.writeData(dataHash, data).then(() => np)
            }

            repo.writeDataSync(dataHash, data)
            return np
        }

        function onEnd(hash?: string, err?: unknown) {
            if (hash !== undefined) {
                return _getPointer(target, hash)
            }

            if (!(err instanceof MetadataConflictError)) {
                throw err
            }

            // A conflict implies that the same data was (or will be) written
            // So we only need to worry about persisting the metadata
            _close(target.key)
            const newTarget = initStore(target.key)

            // We need to re-resolve metadata
            const resolved = _resolveMetadata(newTarget, metadata)!
            newTarget.store.setMetadata(err.dataHash, resolved)
            opened[target.key].didChange = true

            return _getPointer(newTarget, err.dataHash)
        }

        try {
            if (isAsync) {
                return target.store.writeArtifact(data, resolved)
                    .then(h => onEnd(h))
                    .catch(e => onEnd(undefined, e))
            }

            return onEnd(target.store.writeArtifactSync(data, resolved))
        } catch (e) {
            return onEnd(undefined, e)
        }
    }

    async function _writeFile(target: OpenedBuildFs, fileName: string, data: Uint8Array, metadata?: LocalMetadata) {
        const p = await _write(target, data, metadata, true)

        if (isNullMetadataPointer(p)) {
            index.files[fileName] = {
                hash: p.hash,
                store: target.key,
                storeHash: getNullHash(),
            }
            didIndexChange = true
        } else {
            target.files[fileName] = p.hash
        }

        return p
    }

    function _writeFileSync(target: OpenedBuildFs, fileName: string, data: Uint8Array, metadata?: LocalMetadata) {
        const p = _write(target, data, metadata, false)

        if (isNullMetadataPointer(p)) {
            index.files[fileName] = {
                hash: p.hash,
                store: target.key,
                storeHash: getNullHash(),
            }
            didIndexChange = true
        } else {
            target.files[fileName] = p.hash
        }

        return p
    }

    function _writeData(target: OpenedBuildFs, data: Uint8Array, metadata?: LocalMetadata) {
        return _write(target, data, metadata, true)
    }

    function _writeDataSync(target: OpenedBuildFs, data: Uint8Array, metadata?: LocalMetadata) {
        return _write(target, data, metadata, false)
    }

    function _writeData2(target: OpenedBuildFs, data: any, metadata?: LocalMetadata) {
        if (metadata && 'pointers' in metadata) {
            return _write(target, Buffer.from(JSON.stringify(data), 'utf-8'), metadata, true)
        }

        const [res, pointers] = extractPointers(data)
        const m = { ...metadata, pointers }

        return _write(target, Buffer.from(JSON.stringify(res), 'utf-8'), m, true)
    }

    async function _readData2(pointer: string, from?: OpenedBuildFs) {
        if (isDataPointer(pointer)) {
            const metadata = await repo.getMetadata2(pointer)

            const data = await repo.readData(pointer.hash)
            const parsed = JSON.parse(decode(data, 'utf-8'))
            if (!metadata.pointers) {
                return parsed
            }

            return applyPointers(parsed, metadata.pointers)
        }

        const hash = getArtifactName(pointer)
        const data = await repo.readData(hash)

        return JSON.parse(decode(data, 'utf-8'))
    }

    function _createPointer(target: OpenedBuildFs, dataHash: string) {
        const id = target.store.id

        return createPointer(dataHash, {
            id,
            close: () => storeHashes[id] ??= _close(target.key)
        })
    }

    function _getPointer(target: OpenedBuildFs, dataHash: string) {
        return target.pointers[dataHash] ??= _createPointer(target, dataHash)
    }

    async function _readFile(fileName: string, encoding?: BufferEncoding, from?: OpenedBuildFs) {
        const newFile = findOpenedFile(fileName)
        if (newFile) {
            // if (newFile.store === from?.key) {
            //     const d = await repo.readData(newFile.fileHash)
            //     return encoding ? decode(d, encoding) : d
            // }

            // getLogger().debug(`Committing store "${newFile.store}" early from reading "${fileName}"`)

            // const hash = commit(newFile.store)
            // from?.contexts.add(hash)

            const d = await repo.readData(newFile.fileHash)
            return encoding ? decode(d, encoding) : d
        }

        const oldFile = findFile(fileName)
        if (!oldFile) {
            throw Object.assign(new Error(`No file found: ${fileName}`), { code: 'ENOENT' })
        }

        const d = await repo.readData(oldFile.fileHash)
        return encoding ? decode(d, encoding) : d
    }

    function _readFileSync(fileName: string, encoding?: BufferEncoding, from?: OpenedBuildFs) {
        const newFile = findOpenedFile(fileName)
        if (newFile) {
            const d = repo.readDataSync(newFile.fileHash)
            return encoding ? decode(d, encoding) : d
        }

        const fileHash = from?.files[fileName]
        if (fileHash) {
            return repo.readDataSync(fileHash)
        }

        const oldFile = findFile(fileName)
        if (!oldFile) {
            throw Object.assign(new Error(`No file found: ${fileName}`), { code: 'ENOENT' })
        }

        const d = repo.readDataSync(oldFile.fileHash)
        return encoding ? decode(d, encoding) : d
    }

    async function _copyFile(target: OpenedBuildFs, existingPath: string, newPath: string) {
        const f = findFile(existingPath)
        if (!f) {
            throw Object.assign(new Error(`No file found: ${existingPath}`), { code: 'ENOENT' })
        }

        const oldFile = findFile(newPath)
        if (oldFile && oldFile.store !== target.key) {
            throw new Error(`File "${newPath}" already exists [store: ${oldFile.store} -> ${oldFile.storeHash}]`)
        }

        const p = await copier.copyData(f.fileHash, f.storeHash, (d, m) => {
            return _write(getOrCreateStore(target.key), d, m, true)
        })

        if (isNullMetadataPointer(p)) {
            index.files[newPath] = {
                hash: p.hash,
                store: target.key,
                storeHash: getNullHash(),
            }
            didIndexChange = true
        } else {
            getOpenedOrThrow(target.key).files[newPath] = p.hash
        }   
    }

    function fileExistsSync(fileName: string) {
        return !!findFile(fileName) || !!findOpenedFile(fileName)
    }

    function dataExistsSync(hash: string) {
        return repo.hasDataSync(hash)
    }

    function __getMetadataWorker(fileName: string, dataHash?: string, from?: string) {
        if (isPointer(fileName)) {
            const hash = getArtifactName(fileName)
            
            const storeHash = from ? getStoreByKey(from).hash : undefined
            const m = storeHash ? repo.getMetadata(hash, storeHash) : repo.getMetadata(hash)
            if (!m) {
                throw new Error(`No metadata found for file: ${fileName}${storeHash ? ` [store: ${storeHash}]` : ''}`)
            }

            const entry = (!storeHash ? Object.entries(m).shift()! : [storeHash, m]) as [string, ArtifactMetadata]

            return entry[1]
        }
    
        const f = findFile(fileName)
        if (!f) {
            throw Object.assign(new Error(`No file found: ${fileName}`), { code: 'ENOENT' })
        }

        const objHash = dataHash ?? f.fileHash
        const m = repo.getMetadata(objHash, f.storeHash)
        if (!m) {
            throw new Error(`No metadata found for file: ${fileName} [hash: ${objHash}; store: ${f.storeHash}]`)
        }

        return m
    }

    async function _getMetadata(fileName: string, dataHash?: string, from?: string) {
        return _getMetadataSync(fileName, dataHash, from)
    }

    function _getMetadataSync(fileName: string, dataHash?: string, from?: string) {
        const newFile = findOpenedFile(fileName)
        if (!newFile) {
            return __getMetadataWorker(fileName, dataHash, from)
        }

        const target = opened[newFile.store]
        const s = target.store
        const objHash = dataHash ?? newFile.fileHash
        const m = s.getMetadata(objHash, '')

        return m
    }

    function getPointer(fileName: string) {
        const newFile = findOpenedFile(fileName)
        if (newFile) {
            const target = opened[newFile.store]

            return target.pointers[newFile.fileHash] ?? createPointer(newFile.fileHash, getNullHash())
        }

        const f = findFile(fileName)
        if (!f) {
            throw Object.assign(new Error(`No file found: ${fileName}`), { code: 'ENOENT' })
        }

        return createPointer(f.fileHash, f.storeHash)
    }

    function initStore(key: string, options?: OpenOptions) {
        if (opened[key]) {
            throw new Error(`Store "${key}" already initialized`)
        }

        return opened[key] = {
            key,
            files: {},
            pointers: {},
            store: repo.createStore(),
            options,
        }
    }

    function getOpenedOrThrow(key: string) {
        const data = opened[key]
        if (!data) {
            throw new Error(`No store opened with key: ${key}`)
        }
        return data
    }

    function getOrCreateStore(key: string, opt?: OpenOptions) {
        return opened[key] ?? initStore(key, opt)
    }

    function _clear(key: string) {
        deleteStore(key)
    }

    function joinSubkey(key: string, subkey: string) {
        if (subkey.endsWith('/') && subkey !== '/') {
            throw new Error(`Key cannot end with a slash: ${subkey}`)
        }

        if (!subkey.startsWith('/')) {
            return `${key === '/' ? '' : key}/${subkey}`
        }

        if (!subkey.startsWith(`${key === '/' ? key : `${key}/`}`)) {
            throw new Error(`Cannot open subkey "${subkey}" under "${key}"`)
        }

        return subkey
    }

    function openStore(key: string, opt?: OpenOptions) {
        const isReadOnly = opt?.readOnly
        const getTarget = isReadOnly ? () => getOpenedOrThrow(key) : () => getOrCreateStore(key, opt)
        const maybeGetTarget = isReadOnly ? () => opened[key] as OpenedBuildFs | undefined : () => getOrCreateStore(key, opt)

        async function writeFile(fileName: string, data: Uint8Array | string, metadata?: LocalMetadata) {
            const buffer = typeof data === 'string' ? Buffer.from(data) : data
            return _writeFile(getTarget(), fileName, buffer, metadata)
        }

        function writeFileSync(fileName: string, data: Uint8Array | string, metadata?: LocalMetadata) {
            const buffer = typeof data === 'string' ? Buffer.from(data) : data
            return _writeFileSync(getTarget(), fileName, buffer, metadata)
        }
        
        async function writeData(data: Uint8Array, metadata?: LocalMetadata) {
            return _writeData(getTarget(), data, metadata)
        }

        function writeDataSync(data: Uint8Array, metadata?: LocalMetadata) {
            return _writeDataSync(getTarget(), data, metadata)
        }

        async function readFile(fileName: string): Promise<Uint8Array>
        async function readFile(fileName: string, encoding: BufferEncoding): Promise<string>
        async function readFile(fileName: string, encoding?: BufferEncoding) {
            return _readFile(fileName, encoding, maybeGetTarget())
        }

        function open(subkey: string, opt?: OpenOptions) {
            return _open(joinSubkey(key, subkey), opt)
        }

        function readFileSync(fileName: string): Uint8Array
        function readFileSync(fileName: string, encoding: BufferEncoding): string
        function readFileSync(fileName: string, encoding?: BufferEncoding) {
            return _readFileSync(fileName, encoding, maybeGetTarget())
        }

        async function readData(hash: string) {
            return repo.readData(hash)
        }

        function readDataSync(hash: string) {
            return repo.readDataSync(hash)
        }

        async function getMetadata(fileName: string, dataHash?: string) {
            return _getMetadata(fileName, dataHash, key)
        }

        function getMetadataSync(fileName: string, dataHash?: string) {
            return _getMetadataSync(fileName, dataHash, key)
        }

        async function copyFile(existingPath: string, newPath: string) {
            return _copyFile(getTarget(), existingPath, newPath)
        }

        function clear(subkey?: string) {
            if (isReadOnly) {
                throw new Error(`Cannot clear a store in readonly mode`)
            }

            _clear(subkey ? joinSubkey(key, subkey) : key)
        }

        function close() {
            if (isReadOnly) {
                return
            }

            // Not saving anything is OK
            if (!opened[key]) {
                initStore(key)
            }

            return _close(key)
        }

        return { 
            // setFile, 
            writeFile,
            writeFileSync,
            writeData,
            writeDataSync,
            readFile,
            open,
            clear,
            close,
            fileExistsSync,
            readFileSync,
            readData,
            readDataSync,
            mount,
            unmount,
            dataExistsSync,
            getMetadata,
            getMetadataSync,
            copyFile,
            listFiles: async () => {
                const f = listFiles()

                return Object.entries(f).map(([k, v]) => ({ name: k, hash: v.hash }))
            },

            // BACKWARDS COMPAT
            writeArtifact: (...args: Parameters<typeof writeData>) => writeData(...args),
            writeArtifactSync: (...args: Parameters<typeof writeDataSync>) => writeDataSync(...args),
            readArtifact: (p: string) => readData(getArtifactName(p)),
            readArtifactSync: (p: string) => readDataSync(getArtifactName(p)),
            resolveArtifact,

            writeData2: (data: any, metadata?: LocalMetadata) => _writeData2(getTarget(), data, metadata),
            readData2: (pointer: string) => _readData2(pointer, maybeGetTarget()),
        }
    }

    async function closeIfOpened(subkey: string) {
        const key = joinSubkey('/', subkey)
        if (opened[key]) {
            return _close(key)
        }
    }

    const stores = new Map<string, ReturnType<typeof openStore>>()
    const _open = (key: string, opt?: OpenOptions) => {
        if (closed) {
            throw new Error(`Artifact store has been closed and cannot be written to`)
        }

        if (opt?.readOnly) {
            return openStore(key, opt)
        }

        if (stores.has(key)) {
            return stores.get(key)!
        }

        const s = openStore(key, opt)
        stores.set(key, s)

        return s
    }

    const root = _open('/')

    return {
        root,
        getPointer,
        open: (key: string, opt?: OpenOptions) => !key ? root : root.open(key, opt), 
        clear: root.clear,
        flush, 
        getStore, 
        deleteStore, 
        listStores, 
        listFiles, 
        getFilesFromStore,
        resolveArtifact, 
        readFile: root.readFile, 
        readFileSync: root.readFileSync, 
        readDataSync, 
        findFile, 
        renameStore,
        writeFile: root.writeFile,
        writeFileSync: root.writeFileSync,
        close: () => flush(),
        closeIfOpened,
        writeArtifact: root.writeArtifact,
        writeArtifactSync: root.writeArtifactSync,
        readArtifact: root.readArtifact,
        readArtifactSync: root.readArtifactSync,
    }
}

function createFileIndex(allFiles: { name: string; hash: string }[]) {
    const trie = createTrie<Record<string, { hash: string }>, string[]>()

    for (const f of allFiles) {
        const parts = f.name.split('/')
        const dir = parts.slice(0, -1)
        let obj = trie.get(dir)
        if (!obj) {
            obj = {}
            trie.insert(dir, obj)
        }
        obj[parts.at(-1)!] = f
    }

    function readDir(fileName: string) {
        const key = fileName.split('/').filter(x => !!x)
        const files = trie.get(key)
        if (!files) {
            return
        }

        const res = [
            ...trie.keys(key).map(x => ({ type: 'directory' as const, name: x })),
            ...Object.entries(files).map(([k, v]) => ({ type: 'file' as const, name: k, hash: v.hash })),
        ]

        return new Map<string, FsEntity>(res.map(x => [x.name, x]))
    }

    function statFile(fileName: string) {
        const parts = fileName.split('/')
        const name = parts.at(-1)!

        if (trie.get(parts)) {
            return { type: 'directory' as const, name, size: 0, mtimeMs: 0, ctimeMs: 0 }
        }

        const key = parts.slice(0, -1)
        const files = trie.get(key)
        const stats = files?.[name]
        if (!stats) {
            // throw Object.assign(new Error(`No such file exists: ${fileName}`), { code: 'ENOENT' })
            return
        }

        return { type: 'file' as const, name, hash: stats.hash, size: 0, mtimeMs: 0, ctimeMs: 0 }
    }

    return { readDir, statFile }
}

function resolveFileName(fileName: string, workingDirectory: string) {
    const p = path.resolve(workingDirectory, fileName)
    const relative = path.relative(workingDirectory, p)

    return {
        isInWorkDir: p.startsWith(workingDirectory),
        absolute: p,
        relative: process.platform === 'win32' ? fixWindowsPath(relative) : relative,
    }
}

export async function toFsFromHash(hash: string, workingDirectory = getWorkingDir(), fs = getFs()): Promise<Fs & SyncFs & Pick<JsonFs, 'readJson'>> {
    const { index } = await getDataRepository().getBuildFs(hash)

    return toFsFromIndex(index, workingDirectory, fs)
}

export function toFsFromIndex(buildFsIndex: BuildFsIndex, workingDirectory = getWorkingDir(), fs = getFs()): Fs & SyncFs & Pick<JsonFs, 'readJson'> {
    const fragment = createBuildFsFragment(getDataRepository(), buildFsIndex).root
    const wrapped = toFs(workingDirectory, fragment, fs)

    return {
        ...wrapped,
        readJson: (fileName: string) => wrapped.readFile(fileName.replace(/^\[#([^\[#\]]+)\]/, ''), 'utf-8').then(JSON.parse),
        readFile: (fileName: string, encoding?: BufferEncoding) => wrapped.readFile(fileName.replace(/^\[#([^\[#\]]+)\]/, ''), encoding as any),
    } as any
}

export function toFs(workingDirectory: string, buildFs: BuildFsFragment, fs: Fs & SyncFs): Fs & SyncFs {
    function resolve(fileName: string) {
        return resolveFileName(fileName, workingDirectory)
    }

    async function readFile(fileName: string, encoding?: BufferEncoding) {
        if (isPointer(fileName)) {
            const data = await buildFs.readData(getArtifactName(fileName))

            return encoding ? Buffer.from(data).toString(encoding) : data
        }

        const r = resolve(fileName)
        if (buildFs.fileExistsSync(r.relative)) {
            return encoding ? buildFs.readFile(r.relative, encoding) : buildFs.readFile(r.relative)
        }

        return encoding ? fs.readFile(fileName, encoding) : fs.readFile(fileName)
    }

    function readFileSync(fileName: string, encoding?: BufferEncoding) {
        if (isPointer(fileName)) {
            const data = buildFs.readDataSync(getArtifactName(fileName))

            return encoding ? Buffer.from(data).toString(encoding) : data
        }

        const r = resolve(fileName)
        if (buildFs.fileExistsSync(r.relative)) {
            return encoding ? buildFs.readFileSync(r.relative, encoding) : buildFs.readFileSync(r.relative)
        }

        return encoding ? fs.readFileSync(fileName, encoding) : fs.readFileSync(fileName)
    }

    async function writeFile(fileName: string, data: string | Uint8Array, opt?: BufferEncoding | WriteFileOptions) {
        if (typeof opt !== 'string' && opt?.fsKey === '#mem') {
            return fs.writeFile(fileName, data, opt)
        }

        const r = resolve(fileName)
        if (r.isInWorkDir) {
            const encoding = typeof opt === 'string' ? opt : opt?.encoding
            const b = encoding ? Buffer.from(data as string, encoding) : data
    
            return encoding ? void await buildFs.writeFile(r.relative, b) : void await buildFs.writeFile(r.relative, b)
        }

        return fs.writeFile(fileName, data, opt)
    }

    function writeFileSync(fileName: string, data: string | Uint8Array, encoding?: BufferEncoding) {
        const r = resolve(fileName)
        if (r.isInWorkDir) {
            const b = encoding ? Buffer.from(data as string, encoding) : data
            return encoding ? buildFs.writeFileSync(r.relative, b) : buildFs.writeFileSync(r.relative, b)
        }

        return fs.writeFileSync(fileName, data, encoding)
    }

    async function deleteFile(fileName: string, opt?: { fsKey?: '#mem' }) {
        if (isPointer(fileName)) {
            return // store.deleteArtifact(getArtifactName(fileName))
        }

        return fs.deleteFile(fileName, opt)
    }

    function deleteFileSync(fileName: string) {
        if (isPointer(fileName)) {
            return // store.deleteArtifactSync(getArtifactName(fileName))
        }

        return fs.deleteFileSync(fileName)
    }

    async function fileExists(fileName: string) {
        if (isPointer(fileName)) {
            return buildFs.dataExistsSync(getArtifactName(fileName))
        }

        const r = resolve(fileName)

        return buildFs.fileExistsSync(r.relative) || fs.fileExists(fileName)
    }

    function fileExistsSync(fileName: string) {
        if (isPointer(fileName)) {
            return buildFs.dataExistsSync(getArtifactName(fileName))
        }

        const r = resolve(fileName)

        return buildFs.fileExistsSync(r.relative) || fs.fileExistsSync(fileName)
    }

    const getFileIndex = memoize(async () => {
        const files = await buildFs.listFiles()

        return createFileIndex(files)
    })

    async function readDirectory(fileName: string): Promise<FsEntity[]> {
        const r = resolve(fileName)
        if (!r.isInWorkDir) {
            return fs.readDirectory(fileName)
        }

        const index = await getFileIndex()
        const actual = await fs.readDirectory(fileName).catch(e => {
            throwIfNotFileNotFoundError(e)
            return []
        })

        const res = index.readDir(r.relative)
        if (!res) {
            return actual
        }

        for (const f of actual) {
            if (!res.has(f.name)) {
                res.set(f.name, f)
            }
        }

        return [...res.values()]
    }

    async function stat(fileName: string): Promise<FsEntityStats> {
        const r = resolve(fileName)
        if (!r.isInWorkDir) {
            return fs.stat(fileName)
        }

        const index = await getFileIndex()
        const stats = index.statFile(r.relative)

        return stats ?? fs.stat(fileName)
    }

    return {
        link: fs.link,
        stat,
        readDirectory,
        writeFile,
        writeFileSync,
        deleteFile,
        deleteFileSync,
        fileExists,
        fileExistsSync,
        readFile: readFile as Fs['readFile'],
        readFileSync: readFileSync as SyncFs['readFileSync'],
    }
}

// type JsonArtifactSchema<T extends Record<string, any>> = 'tree' | { 
//     [P in keyof T]+?: T[P] extends Record<string, any> ? JsonArtifactSchema<T[P]> | boolean : boolean 
// }

// interface JsonArtifactMapping {
//     readonly data: any
//     readonly fields?: Record<string, JsonArtifactMapping>
// }

// async function serializeJsonArtifact(store: OpenedArtifactStore, data: any, schema: JsonArtifactSchema<any> | true): Promise<JsonArtifactMapping> {
//     if (schema === true || typeof data !== 'object' || !data || Array.isArray(data)) {
//         return {
//             data: await store.writeArtifact(Buffer.from(JSON.stringify(data), 'utf-8')),
//         }
//     }

//     const serialized: Promise<readonly [string, JsonArtifactMapping]>[] = []
//     if (schema === 'tree') {
//         for (const [k, v] of Object.entries(data)) {
//             serialized.push(serializeJsonArtifact(store, v, true).then(m => [k, m]))
//         }

//         const fields = Object.fromEntries(await Promise.all(serialized))

//         return {
//             data: {},
//             fields,
//         }
//     }

//     const s: Record<string, any> = {}
//     for (const [k, v] of Object.entries(schema)) {
//         const d = data[k]
//         if (d === undefined) continue

//         if (!v) {
//             s[k] = d
//         } else {
//             serialized.push(serializeJsonArtifact(store, d, v).then(m => [k, m]))
//         }
//     }

//     const fields = Object.fromEntries(await Promise.all(serialized))

//     return {
//         data: s,
//         fields,
//     }
// }

// async function writeJsonArtifact<T extends Record<string, any>>(vfs: BuildFs, data: T, schema: JsonArtifactSchema<T> = {}): Promise<JsonArtifactMapping> {
//     const mappings: Promise<readonly [string, string | JsonArtifactMapping]>[] = []
//     const serialized: Record<string, any> = {}
//     for (const [k, v] of Object.entries(schema)) {
//         const d = data[k]
//         if (d === undefined) continue

//         if (v === false) {
//             serialized[k] = d
//         } else if (v === 'tree') {

//         } else if (typeof d === 'object' && !!d && !Array.isArray(d)) {
//             const mapping = writeJsonArtifact(vfs, d, v === true ? undefined : v).then(m => [k, m] as const)
//             mappings.push(mapping)
//         } else {
//             mappings.push(store.writeArtifact(Buffer.from(JSON.stringify(d), 'utf-8')).then(h => [k, h]))
//         }
//     }

//     return Object.fromEntries(await Promise.all(mappings))
// }

interface AsyncObjectBuilder<T extends object, U extends object = {}> {
    addResult<U extends keyof T>(key: U, value: Promise<T[U]> | T[U]): AsyncObjectBuilder<T, U & { [P in U]: typeof value }>
    build(): U extends T ? Promise<U> : never
}

function createAsyncObjectBuilder<T extends object>(): AsyncObjectBuilder<T> {
    const result: (Promise<[keyof T, T[keyof T]]> | [keyof T, T[keyof T]])[] = []
    const builder = { addResult, build } as AsyncObjectBuilder<T>

    function addResult<U extends keyof T>(key: U, value: Promise<T[U]> | T[U]) {
        if (value instanceof Promise) {
            result.push(value.then(v => [key, v]))
        } else {
            result.push([key, value])
        }

        return builder
    }

    async function build() {
        return Object.fromEntries(await Promise.all(result)) as T
    }

    return builder
}

async function mapTree<T, U>(tree: Record<string, T>, fn: (val: T) => Promise<U>): Promise<Record<string, U>> {
    const result: Promise<[string, U]>[]= []
    for (const [k, v] of Object.entries(tree)) {
        result.push(fn(v).then(p => [k, p]))
    }

    return Object.fromEntries(await Promise.all(result))
}

function mapTreeSync<T, U>(tree: Record<string, T>, fn: (val: T) => U): Record<string, U> {
    const result: [string, U][]= []
    for (const [k, v] of Object.entries(tree)) {
        result.push([k, fn(v)])
    }

    return Object.fromEntries(result)
}


function createStructuredArtifactWriter(key: string, writer: Pick<BuildFsV2, 'writeData'>) {
    const dependencies: string[] = []

    async function writeJson(obj: any) {
        const data = Buffer.from(JSON.stringify(obj))
        const hash = await writer.writeData(key, data)
        dependencies.push(hash)

        return hash
    }

    async function writeTree(tree: Record<string, any>) {
        return mapTree(tree, writeJson)
    }

    function createBuilder<T extends object, U extends object>() {
        const builder = createAsyncObjectBuilder<U>()

        function _writeJson<K extends keyof T & keyof U>(key: K, obj: T[K]) {
            builder.addResult(key, writeJson(obj) as any)
        }

        function _writeTree<K extends keyof T & keyof U>(key: K, tree: T[K] & Record<string, any>) {
            builder.addResult(key, writeTree(tree) as any)
        }

        function _writeRaw<K extends keyof T & keyof U>(key: K, obj: T[K]) {
            builder.addResult(key, obj as any)
        }

        return {
            writeRaw: _writeRaw,
            writeJson: _writeJson,
            writeTree: _writeTree,
            build: async () => ({
                result: await builder.build(),
                dependencies,
            }),
        }
    }

    return {
        writeJson,
        writeTree,
        createBuilder,
    }
}



// Artifact dependency chain:
// npm deps (including providers) + source code compilation (per-file per-program) 
// -> template + assets (per-program) 
// -> deployment artifacts + state (per-process) 

// Tool inputs can also be included in this dependency chain
// Same thing for the source code

// Installation:
//  * Packages
//  * Providers
// Compilation:
//  * Files
// Synth:
//  * Template
//  * Assets
// Deploy:
//  * State
//  * Resource-bound artifact store

export interface InstallationAttributes {
    readonly packageLockTimestamp: number
    readonly packages: Record<string, NpmPackageInfo & { isSynapsePackage?: boolean }>
    readonly importMap?: FlatImportMap<SourceInfo>
    readonly mode: 'all' | 'types' | 'none'
}

interface StatsEntry {
    readonly size: number
    readonly mtimeMs: number
    readonly missing?: boolean
    readonly corrupted?: boolean
    readonly lastStatTime?: number
}

export interface DataRepository extends RootArtifactStore {
    commitHead(id: string): Promise<Head | undefined>
    getHead(id: string): Promise<Head | undefined>
    putHead(head: Head): Promise<void>
    deleteHead(id: string): Promise<void>
    statData(hash: string): Promise<StatsEntry>
    hasData(hash: string): Promise<boolean>
    hasDataSync(hash: string): boolean
    listHeads(): Promise<Head[]>
    serializeBuildFs(buildFs: ReadonlyBuildFs): Promise<Record<string, Uint8Array>>
    serializeBuildFs(buildFs: ReadonlyBuildFs, excluded: Iterable<string>): Promise<[objects: Record<string, Uint8Array>, excluded: Set<string>]>

    // commit(head: Head['id'], hash: string): Promise<Head>

    getDataDir: () => string
    getLocksDir: () => string
    getBlocksDir: () => string

    getRootBuildFs(id: string): Promise<ReturnType<typeof createBuildFsFragment>> | ReturnType<typeof createBuildFsFragment>
    getRootBuildFsSync(id: string): ReturnType<typeof createBuildFsFragment>
    copyFrom(repo: DataRepository, buildFs: ReadonlyBuildFs, pack?: boolean | 'both', previous?: ReadonlyBuildFs): Promise<void>
}

function getStoreHashes(index: BuildFsIndex) {
    const hashes = new Set<string>(Object.values(index.stores).map(s => s.hash))
    for (const f of Object.values(index.files)) {
        if (f.storeHash) {
            hashes.add(f.storeHash)
        }
    }

    return hashes
}


function isAmbiguousObjectHash(fileName: string) {
    if (fileName.length === 64 && fileName.match(/^[0-9a-f]+$/)) {
        return true
    }

    return false
} 

type BuildFsV2 = ReturnType<typeof createRootFs>
function createRootFs(fs: Fs & SyncFs, rootDir: string, defaultId: string, opt?: CreateRootFsOptions) {
    const repo = getDataRepository(fs, rootDir)
    const changed = new Map<string, string | undefined>()

    const aliases = opt?.aliases
    const workingDirectory = opt?.workingDirectory ?? rootDir

    if (aliases && defaultId in aliases) {
        defaultId = aliases[defaultId]
    }

    function resolveFsId(parsed: { fsId?: string }) {
        if (!parsed.fsId) {
            return defaultId
        }

        if (!aliases) {
            return parsed.fsId
        }

        return aliases[parsed.fsId] ?? parsed.fsId
    }

    interface BaseResolveResult {
        readonly fsId: string
        readonly storeKey: string
    }

    interface PointerResolveResult extends BaseResolveResult {
        readonly type: 'pointer'
        readonly address: string
    }

    interface BuildFsFileResolveResult extends BaseResolveResult {
        readonly type: 'bfs-file'
        readonly relative: string
        readonly absolute: string
    }

    interface NormalFileResolveResult {
        readonly type: 'file'
        readonly absolute: string
    }

    type ResolveResult = 
        | PointerResolveResult
        | BuildFsFileResolveResult
        | NormalFileResolveResult

    function resolve(fileName: string): ResolveResult {
        let fsId = defaultId
        let storeKey = ''

        if (hasBuildFsPrefix(fileName)) {
            const parsed = parseBuildFsPrefix(fileName)
            fsId = resolveFsId(parsed)
            fileName = parsed.fileName
            storeKey = parsed.storeKey

            // Not 100% sure if this is needed
            if (process.platform === 'win32') {
                storeKey = storeKey.replaceAll('\\', '/')
            }
        }

        if (isPointer(fileName)) {
            return {
                type: 'pointer',
                fsId,
                storeKey,
                address: getArtifactName(fileName)
            }
        }

        if (isAmbiguousObjectHash(fileName)) {
            getLogger().warn(`Found object hash without a scheme: ${fileName}`)

            return {
                type: 'pointer',
                fsId,
                storeKey,
                address: fileName,
            }
        }

        const r = resolveFileName(fileName, workingDirectory)
        if (r.isInWorkDir) {
            return {
                type: 'bfs-file',
                fsId,
                storeKey,
                absolute: r.absolute,
                relative: r.relative,
            }
        }

        return {
            type: 'file',
            absolute: r.absolute,
        }
    }

    async function writeData(fileName: string, data: Uint8Array, options?: Omit<WriteFileOptions, 'encoding'>): Promise<DataPointer> {
        const r = resolve(fileName)
        if (r.type === 'pointer') {
            throw new Error(`Not implemented`)
        }

        if (r.type === 'file') {
            throw new Error(`Not implemented`)
        }

        const fs = await repo.getRootBuildFs(r.fsId)
        const pointer = await fs.open(r.storeKey).writeData(data, options?.metadata)

        return pointer
    }

    function writeDataSync(fileName: string, data: Uint8Array, options?: Omit<WriteFileOptions, 'encoding'>) {
        const r = resolve(fileName)
        if (r.type === 'pointer') {
            throw new Error(`Not implemented`)
        }

        if (r.type === 'file') {
            throw new Error(`Not implemented`)
        }

        if (r.relative !== '') {
            throw new Error(`Not implemented`)
        }

        const fs = repo.getRootBuildFsSync(r.fsId)

        return fs.open(r.storeKey).writeDataSync(data, options?.metadata)
    }

    async function readData(hash: string): Promise<Uint8Array> {
        const bfs = await repo.getRootBuildFs(defaultId)

        return bfs.root.readData(hash)
    }

    async function writeFile(fileName: string, data: Uint8Array, options?: Omit<WriteFileOptions, 'encoding'>): Promise<void>
    async function writeFile(fileName: string, data: string, options?: BufferEncoding | WriteFileOptions): Promise<void>
    async function writeFile(fileName: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void>
    async function writeFile(fileName: string, data: string | Uint8Array, options?: BufferEncoding | WriteFileOptions): Promise<void> {
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.writeFile(r.absolute, data, options)
        }

        if (r.type === 'pointer') {
            throw new Error(`Cannot write to pointer address`)
        }

        const encoding = typeof options === 'string' ? options : options?.encoding
        const buf = typeof data === 'string' ? Buffer.from(data, encoding) : data
        const opt = typeof options === 'string' ? undefined : options

        const root = await repo.getRootBuildFs(r.fsId)

        const buildFs = root.open(r.storeKey)
        const dependencies = opt?.metadata?.dependencies

        await buildFs.writeFile(r.relative, buf, { ...opt?.metadata, dependencies })
    }

    async function readFile(fileName: string, options?: ReadFileOptions & { encoding: undefined }): Promise<Uint8Array>
    async function readFile(fileName: string, options: ReadFileOptions & { encoding: BufferEncoding }): Promise<string>
    async function readFile(fileName: string, options: BufferEncoding): Promise<string>
    async function readFile(fileName: string, options?: BufferEncoding | ReadFileOptions): Promise<string | Uint8Array> {
        const encoding = (typeof options === 'string' ? options : options?.encoding) as BufferEncoding
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.readFile(r.absolute, encoding)
        }

        const buildFs = (await repo.getRootBuildFs(r.fsId)).open(r.storeKey)

        if (r.type === 'pointer') {
            const data = await buildFs.readData(r.address)

            return encoding ? decode(data, encoding) : data
        }

        if (buildFs.fileExistsSync(r.relative)) {
            return buildFs.readFile(r.relative, encoding)
        }

        return fs.readFile(r.absolute, encoding)
    }

    async function deleteFile(fileName: string, opt?: { fsKey?: '#mem' }): Promise<void> {
        const r = resolve(fileName)
        if (r.type == 'file') {
            return fs.deleteFile(r.absolute, opt)
        }

        throw new Error(`Not implemented`)
    }

    function deleteFileSync(fileName: string): void {
        const r = resolve(fileName)
        if (r.type == 'file') {
            return fs.deleteFileSync(r.absolute)
        }

        throw new Error(`Not implemented`)
    }

    function writeFileSync(fileName: string, data: Uint8Array, options?: Omit<WriteFileOptions, 'encoding'>): void
    function writeFileSync(fileName: string, data: string | Uint8Array, options?: WriteFileOptions): void
    function writeFileSync(fileName: string, data: string, options?: BufferEncoding | WriteFileOptions): void
    function writeFileSync(fileName: string, data: string | Uint8Array, options?: BufferEncoding | WriteFileOptions): void {
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.writeFileSync(r.absolute, data, options)
        }

        if (r.type === 'pointer') {
            throw new Error(`Cannot write to pointer address`)
        }

        const encoding = typeof options === 'string' ? options : options?.encoding
        const buf = typeof data === 'string' ? Buffer.from(data, encoding) : data
        const opt = typeof options === 'string' ? undefined : options

        const buildFs = repo.getRootBuildFsSync(r.fsId).open(r.storeKey)
        buildFs.writeFileSync(r.relative, buf, opt?.metadata)
    }

    function readFileSync(fileName: string, options?: ReadFileOptions & { encoding: undefined }): Uint8Array
    function readFileSync(fileName: string, options: ReadFileOptions & { encoding: BufferEncoding }): string
    function readFileSync(fileName: string, options: BufferEncoding): string
    function readFileSync(fileName: string, options?: BufferEncoding | ReadFileOptions): string | Uint8Array {
        const encoding = (typeof options === 'string' ? options : options?.encoding) as BufferEncoding
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.readFileSync(r.absolute, encoding)
        }

        const buildFs = repo.getRootBuildFsSync(r.fsId).open(r.storeKey)

        if (r.type === 'pointer') {
            const data = buildFs.readDataSync(r.address)

            return encoding ? decode(data, encoding) : data
        }

        if (buildFs.fileExistsSync(r.relative)) {
            return buildFs.readFileSync(r.relative, encoding)
        }

        return fs.readFileSync(r.absolute, encoding)
    }

    async function readDirectory(fileName: string): Promise<FsEntity[]> {
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.readDirectory(r.absolute)
        }

        if (r.type === 'pointer') {
            throw new Error(`Not implemented`)
        }

        const index = await getFileIndex(r.fsId)
        const actual = await fs.readDirectory(r.absolute).catch(e => {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
            return []
        })

        const res = index.readDir(r.relative)
        if (!res) {
            return actual
        }

        for (const f of actual) {
            if (!res.has(f.name)) {
                res.set(f.name, f)
            }
        }

        return [...res.values()]
    }

    async function listStores(fileName: string): Promise<{ name: string }[]> {
        const r = resolve(fileName)
        if (r.type === 'file') {
            throw new Error(`Not implemented`)
        }

        if (r.type === 'pointer' || r.relative !== '') {
            throw new Error(`Not implemented`)
        }

        const fs = await repo.getRootBuildFs(r.fsId)

        return Object.keys(fs.listStores()).map(k => ({ name: k }))
    }

    async function rename(currentFileName: string, newFileName: string): Promise<void> {
        const r1 = resolve(currentFileName)
        const r2 = resolve(newFileName)
        if (r1.type === 'file' || r2.type === 'file') {
            throw new Error(`Not implemented`)
        }

        if (r1.type === 'pointer' || r1.relative !== '' || r2.type === 'pointer' || r2.relative === '') {
            throw new Error(`Not implemented`)
        }

        if (r1.fsId !== r2.fsId) {
            throw new Error(`Not implemented: ${r1.fsId} !== ${r2.fsId}`)
        }

        const fs = await repo.getRootBuildFs(r1.fsId)
        fs.renameStore(r1.storeKey, r2.storeKey)
    }

    async function fileExists(fileName: string) {
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.fileExists(r.absolute)
        }

        const buildFs = (await repo.getRootBuildFs(r.fsId)).open(r.storeKey)

        if (r.type === 'pointer') {
            return buildFs.dataExistsSync(r.address)
        }

        return buildFs.fileExistsSync(r.relative) || fs.fileExists(r.absolute)
    }

    function fileExistsSync(fileName: string) {
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.fileExistsSync(r.absolute)
        }

        const buildFs = repo.getRootBuildFsSync(r.fsId).open(r.storeKey)

        if (r.type === 'pointer') {
            return buildFs.dataExistsSync(r.address)
        }

        return buildFs.fileExistsSync(r.relative) || fs.fileExistsSync(r.absolute)
    }

    async function link(existingPath: string, newPath: string) {
        const r1 = resolve(existingPath)
        const r2 = resolve(newPath)
        if (r1.type === 'file' && r2.type === 'file') {
            return fs.link(r1.absolute, r2.absolute)
        }

        // if (r1.type === 'bfs-file' && r2.type === 'bfs-file') {
        //     if (r1.fsId !== r2.fsId) {
        //         const b1 = await getBuildFsIndex(r1.fsId)
        //         const buildFs = (await repo.getRootBuildFs(r2.fsId)).open(r2.storeKey)
        //         buildFs.mount(`/tmp/${r1.fsId}`, { index: b1, hash: '' })
        //         await buildFs.copyFile(`/tmp/${r1.fsId}/${r1.relative}`, r2.relative)
        //         buildFs.unmount(`/tmp/${r1.fsId}`)

        //     }

        //     const buildFs = (await repo.getRootBuildFs(r2.fsId)).open(r2.storeKey)

        //     return buildFs.copyFile(r1.relative, r2.relative)
        // }

        throw new Error(`Not implemented`)
    }

    const getFileIndex = keyedMemoize(async (fsId: string) => {
        const buildFs = await repo.getRootBuildFs(fsId)
        const files = await buildFs.root.listFiles()

        return createFileIndex(files)
    })

    async function stat(fileName: string): Promise<FsEntityStats> {
        const r = resolve(fileName)
        if (r.type === 'file') {
            return fs.stat(r.absolute)
        }
        
        if (r.type === 'pointer') {
            return { type: 'file', size: 0, ctimeMs: 0, mtimeMs: 0 }
        }

        const index = await getFileIndex(r.fsId)
        const stats = index.statFile(r.relative)

        return stats ?? fs.stat(r.absolute)
    }

    async function clear(key?: string) {
        const buildFs = await repo.getRootBuildFs(defaultId)
        buildFs.deleteStore(key ? path.posix.join('/', key) : '/')

        // await flush()
    }

    async function writeJson(fileName: string, data: any) {
        const [res, pointers, summary] = extractPointers(data)
        const dependencies = summary ? Object.entries(summary).flatMap(([k, v]) => v.map(d => `${k}:${d}`)) : undefined

        return writeFile(fileName, JSON.stringify(res), {
            metadata: { pointers, dependencies },
        })
    }

    async function readJson<T = any>(fileName: string): Promise<T> {
        const r = resolve(fileName)
        if (r.type !== 'bfs-file') {
            return readFile(fileName, 'utf-8').then(JSON.parse)
        }

        const buildFs = await repo.getRootBuildFs(r.fsId)
        const pointer = buildFs.getPointer(r.relative)
        const [data, metadata] = await Promise.all([
            repo.readData(pointer.hash),
            repo.getMetadata2(pointer)
        ])

        const parsed = JSON.parse(decode(data, 'utf-8'))
        if (!metadata.pointers) {
            return parsed
        }

        return applyPointers(parsed, metadata.pointers)
    }

    async function getMetadata(fileName: string) {
        const r = resolve(fileName)
        if (r.type ===  'file') {
            throw new Error('Not implemented')
        }

        if (r.type === 'pointer') {
            return repo.getMetadata2(fileName)
        }

        const buildFs = (await repo.getRootBuildFs(r.fsId)).open(r.storeKey)
        const metadata = await buildFs.getMetadata(r.relative)

        return metadata as ArtifactMetadata & { pointer: string }
    }

    function getPointerSync(fileName: string) {
        const r = resolve(fileName)
        if (r.type !== 'bfs-file') {
            throw new Error(`Invalid target type: ${r.type} [fileName: ${fileName}]`)
        }

        return repo.getRootBuildFsSync(r.fsId).getPointer(r.relative)
    }

    const _fs = {
        link,
        stat,
        writeFile, 
        readFile, 
        deleteFile,
        deleteFileSync,
        writeFileSync, 
        readFileSync, 
        readDirectory, 
        fileExists,
        fileExistsSync,
    } satisfies Fs & SyncFs

    return {
        ..._fs,
        clear,
        writeData,
        readData,
        writeDataSync,
        readJson,
        writeJson,
        getMetadata,
        listStores,
        rename,
        getPointerSync,
    }
}

export async function createMountedFs(procId: string, workingDir: string, mounts: Record<string, ReadonlyBuildFs>) {
    const repo = getDataRepository()
    const bfs = await repo.getRootBuildFs(procId)
    for (const [k, v] of Object.entries(mounts)) {
        bfs.root.mount(k, v)
    }

    return toFs(workingDir, bfs.root, getFs())
}

export function createTempMountedFs(
    index: BuildFsIndex, 
    workingDir: string, 
    mounts?: Record<string, ReadonlyBuildFs>
): Fs & SyncFs & { addMounts: (mounts: Record<string, ReadonlyBuildFs>) => void; getDiskPath: (fileName: string) => string } {
    const repo = getDataRepository()
    const bfs = createBuildFsFragment(repo, index)

    function addMounts(mounts: Record<string, ReadonlyBuildFs>) {
        for (const [k, v] of Object.entries(mounts)) {
            bfs.root.mount(k, v)
        }
    }

    function getDiskPath(fileName: string) {
        try {
            const pointer = bfs.getPointer(fileName)
            
            return bfs.resolveArtifact(pointer, { sync: true })
        } catch(e) {
            throwIfNotFileNotFoundError(e)

            return fileName
        }
    }

    if (mounts) {
        addMounts(mounts)
    }

    return {
        ...toFs(workingDir, bfs.root, getFs()),
        addMounts,
        getDiskPath,
    }
}

function sortAndPruneMetadata(manifest: ArtifactStoreManifest) {
    function sortInner(metadata: Record<string, ArtifactMetadata>) {
        for (const [k, v] of Object.entries(metadata)) {
            if (v.dependencies) {
                const sortedDeps = sortRecord(v.dependencies)
                for (const [k2, v2] of Object.entries(sortedDeps)) {
                    // sortedDeps[k2] = v2.sort((a, b) => a.localeCompare(b))
                    sortedDeps[k2] = v2.sort()
                }
                Object.assign(v, { dependencies: sortedDeps })
            }
        }
    
        return sortRecord(metadata)
    }

    if (manifest.type === 'flat') {
        return sortInner(manifest.artifacts)
    }

    const sorted: DenormalizedStoreManifest['artifacts'] = {}
    for (const [k, v] of Object.entries(manifest.artifacts)) {
        sorted[k] = sortInner(v)
    }

    return sortRecord(sorted)
}

function isEOFJsonParseError(err: unknown): boolean {
    if (err instanceof SyntaxError && err.message === 'Unexpected end of JSON input') {
        return true
    }

    return false
}

export async function readJsonRaw<T>(repo: Pick<DataRepository, 'readData' | 'deleteData'>, hash: string): Promise<T> {
    try {
        return JSON.parse(decode(await repo.readData(hash), 'utf-8')) as T
    } catch (e) {
        if (isEOFJsonParseError(e)) {
            getLogger().warn(`Removing corrupted data: ${hash}`)
            await repo.deleteData(hash)
        }

        throw e
    }
}

function readJsonRawSync<T>(repo: Pick<DataRepository, 'readDataSync' | 'deleteDataSync'>, hash: string): T {
    try {
        return JSON.parse(decode(repo.readDataSync(hash), 'utf-8')) as T
    } catch (e) {
        if (isEOFJsonParseError(e)) {
            getLogger().warn(`Removing corrupted data: ${hash}`)
            repo.deleteDataSync(hash)
        }

        throw e
    }
}

async function writeJsonRaw<T>(repo: Pick<DataRepository, 'writeData'>, obj: T): Promise<string> {
    const data = Buffer.from(JSON.stringify(obj), 'utf-8')
    const hash = getHash(data)
    await repo.writeData(hash, data)

    return hash
}

// Merges left to right
// Files from the right indices override files from the left
export function mergeBuilds(builds: BuildFsIndex[]): BuildFsIndex {
    const index: BuildFsIndex = { files: {}, stores: {} }
    for (const b of builds.reverse()) {
        const currentStores = new Set<string>()
        for (const [k, v] of Object.entries(b.files)) {
            if (index.files[k]) continue

            index.files[k] = v
            if (!index.stores[v.store]) {
                index.stores[v.store] = b.stores[v.store]
                currentStores.add(v.store)
            } else if (!v.storeHash && !currentStores.has(v.store)) {
                (v as Mutable<typeof v>).storeHash = b.stores[v.store].hash
            }
        }
    }

    return index
}

// TODO: use this interface
interface PruneBuildParams {
    readonly include?: string[]
    readonly exclude?: string[]
}

export function pruneBuild(build: BuildFsIndex, toRemove: string[]): BuildFsIndex {
    const index: BuildFsIndex = { files: {}, stores: {} }
    const s = new Set(toRemove)
    for (const [k, v] of Object.entries(build.files)) {
        if (s.has(k)) continue

        index.files[k] = v
        index.stores[v.store] ??= build.stores[v.store]
    }

    return index
}

interface CompressedMetadata {
    readonly hashes: string[]
    readonly data: Record<string, Record<string, ArtifactMetadata>>
}

function compressMetadata(metadata: Record<string, Record<string, ArtifactMetadata>>) {
    const hashes = new Map<string, number>()
    function indexHash(hash: string) {
        if (hashes.has(hash)) {
            return hashes.get(hash)!
        }

        const id = hashes.size
        hashes.set(hash, id)

        return id
    }

    const data: Record<string, Record<string, ArtifactMetadata>> = {}
    for (const [k, v] of Object.entries(metadata)) {
        const inner: typeof v = data[indexHash(k)] = {}
        for (const [k2, v2] of Object.entries(v)) {
            const d = inner[indexHash(k2)] = deepClone(v2)
            if (d.dependencies) {
                for (const [k3, arr] of Object.entries(d.dependencies)) {
                    d.dependencies[indexHash(k3)] = arr.map(indexHash) as any as string[]
                }
            }
        }
    }

    return { hashes: [...hashes.keys()], data }
}

interface NormalizedData {
    readonly hash: string
    readonly metadata: ArtifactMetadata
    readonly metadataHash: string
}

interface NormalizerOptions {
    // Removes any non-critical data (e.g. sourcemaps)
    readonly strip?: boolean
}

function createNormalizer(repo: DataRepository, opt?: NormalizerOptions) {
    function normalizeWorker(hash: string, metadata: ArtifactMetadata): NormalizedData {
        let pointers: Pointers | undefined
        const deps: Record<string, Set<string>> = {}

        if (metadata.pointers) {
            function visit(o: any, p: Pointers): Pointers {
                if (typeof p === 'string') {
                    const n = normalize(o, p)
                    const s = deps[n.metadataHash] ??= new Set()
                    s.add(n.hash)

                    return n.metadataHash
                } else if (Array.isArray(p)) {
                    const r: Pointers[] = []
                    for (let i = 0; i < p.length; i++) {
                        r[i] = visit(o[i], p[i])
                    }

                    return r
                } else if (typeof p === 'object' && !!p) {
                    const r: Record<string, Pointers> = {}
                    for (const [k, v] of Object.entries(p)) {
                        r[k] = visit(o[k], v)
                    }

                    return r
                }

                return p
            }

            const data = JSON.parse(decode(repo.readDataSync(hash), 'utf-8'))
            pointers = visit(data, metadata.pointers)
        }

        if (metadata.dependencies) {
            for (const [k, v] of Object.entries(metadata.dependencies)) {
                for (const d of v) {
                    const n = normalize(d, k)
                    const s = deps[n.metadataHash] ??= new Set()
                    s.add(n.hash)
                }
            }
        }

        const dependencies = (metadata.dependencies || metadata.pointers) ? {} as Record<string, string[]> : undefined
        for (const [k, v] of Object.entries(sortRecord(deps))) {
            // dependencies![k] = [...v].sort((a, b) => a.localeCompare(b))
            dependencies![k] = [...v].sort()
        }

        const sourcemaps = opt?.strip ? undefined : metadata.sourcemaps

        const result = sortRecord({
            ...metadata,
            sourcemaps,
            pointers,
            dependencies,
        })

        const metadataHash = getHash(Buffer.from(JSON.stringify(result), 'utf-8'))

        return {
            hash,
            metadata: result,
            metadataHash
        }
    }

    const normalized = new Map<string, NormalizedData>()
    function normalize(hash: string, storeHash: string): NormalizedData {
        const key = `${storeHash}:${hash}`
        if (normalized.has(key)) {
            return normalized.get(key)!
        }

        const m = repo.getMetadata(hash, storeHash)
        const r = normalizeWorker(hash, m)
        normalized.set(key, r)
        normalized.set(`${r.metadataHash}:${r.hash}`, r)

        return r
    }
    
    return { normalize }
}

function createCopier(repo: DataRepository, normalizer = createNormalizer(repo)) {
    const copied = new Map<string, DataPointer>()

    async function copyData(hash: string, storeHash: string, sink: (data: Uint8Array, metadata: LocalMetadata) => Promise<DataPointer>): Promise<DataPointer> {
        if (isNullHash(storeHash)) {
            const k = `${getEmptyObjectHash()}:${hash}`
            const data = await repo.readData(hash)
            const p = await sink(data, {})
            copied.set(k, p)
    
            return p
        }
        
        const n = normalizer.normalize(hash, storeHash)
        const k = `${n.metadataHash}:${n.hash}`
        if (copied.has(k)) {
            return copied.get(k)!
        }

        const data = await repo.readData(hash)

        let pointers: Pointers | undefined
        const deps = new Set<DataPointer>()
        if (n.metadata.pointers) {
            async function visit(o: any, p: Pointers): Promise<Pointers> {
                if (typeof p === 'string') {
                    const n = await copyData(o, p, sink)
                    const { storeHash } = n.resolve()
                    deps.add(n)

                    return storeHash
                } else if (Array.isArray(p)) {
                    const r: Pointers[] = []
                    for (let i = 0; i < p.length; i++) {
                        r[i] = await visit(o[i], p[i])
                    }

                    return r
                } else if (typeof p === 'object' && !!p) {
                    const r: Record<string, Pointers> = {}
                    for (const [k, v] of Object.entries(p)) {
                        r[k] = await visit(o[k], v)
                    }

                    return r
                }

                return p
            }

            pointers = await visit(JSON.parse(decode(data, 'utf-8')), n.metadata.pointers)
        }

        if (n.metadata.dependencies) {
            for (const [k, v] of Object.entries(n.metadata.dependencies)) {
                for (const d of v) {
                    const n = await copyData(d, k, sink)
                    deps.add(n)
                }
            }
        }

        const result = {
            ...n.metadata,
            pointers,
            dependencies: deps.size > 0 ? [...deps] : undefined,
        }

        const p = await sink(data, result)
        copied.set(k, p)

        return p
    }

    function getCopied(p: string) {
        const { hash, storeHash } = toDataPointer(p).resolve()
        if (isNullHash(storeHash)) {
            const k = `${getEmptyObjectHash()}:${hash}`
            const r = copied.get(k)
            
            return r
        }

        const n = normalizer.normalize(hash, storeHash)
        const k = `${n.metadataHash}:${n.hash}`

        return copied.get(k)
    }

    function getCopiedOrThrow(p: string) {
        const copied = getCopied(p)
        if (!copied) {
            throw new Error(`Missing copied pointer: ${p}`)
        }

        return copied
    }

    return { copyData, getCopied, getCopiedOrThrow }
}

export async function consolidateBuild(repo: DataRepository, build: BuildFsIndex, toKeep: string[], opt?: NormalizerOptions) {
    const toKeepSet = new Set(toKeep)
    const index: BuildFsIndex = { files: {}, stores: {} }

    const copier = opt ? createCopier(repo, createNormalizer(repo, opt)) : undefined
    const fragment = createBuildFsFragment(repo, index, copier)
    fragment.root.mount('/tmp', { hash: '', index: build })

    for (const [k, v] of Object.entries(build.files)) {
        if (!toKeepSet.has(k)) continue

        await fragment.root.copyFile(`/tmp/${k}`, k)
    }

    fragment.root.unmount('/tmp')
    fragment.root.close()

    return { copier, index }
}

export function getPrefixedPath(hash: string) {
    return `${hash[0]}${hash[1]}/${hash[2]}${hash[3]}/${hash.slice(4)}`
}

interface CreateRootFsOptions {
    readonly aliases?: Record<string, string>
    readonly workingDirectory?: string
}

interface PerformanceCounts {
    readonly has: Record<string, number>
    readonly read: Record<string, number>
    readonly write: Record<string, number>
}

function getRepository(fs: Fs & SyncFs, buildDir: string) {
    function getDataDir() {
        return path.resolve(buildDir, 'data')
    }

    function getHeadsDir() {
        return path.resolve(buildDir, 'heads')
    }

    function getResolvedDir() {
        return path.resolve(buildDir, 'resolved')
    }

    function getBlocksDir() {
        return path.resolve(buildDir, 'blocks')
    }

    function getLocksDir() {
        return path.resolve(buildDir, 'locks')
    }

    const headDir = getHeadsDir()
    const dataDir = getDataDir()
    const resolvedDir = getResolvedDir() // For files that need a "flat" name

    const _getHeadPath = (id: string) => {
        if (id.match(/[@:\/]/)) {
            return path.resolve(headDir, getHash(id))
        }
        return path.resolve(headDir, id)
    }

    const getHeadPath = keyedMemoize(_getHeadPath)
    const getDataPath = (hash: string) => path.resolve(dataDir, getPrefixedPath(hash))
    const getBlockPath = (hash: string) => path.resolve(getBlocksDir(), hash)

    // PERF

    const printCountsOnFlush = false

    let bytesWritten = 0
    let bytesSaved = 0
    const sizes: Record<string, number> = {}
    const counts: PerformanceCounts = { has: {}, read: {}, write: {} }
    function inc(key: keyof PerformanceCounts, hash: string) {
        counts[key][hash] = (counts[key][hash] ?? 0) + 1
    }

    function printCounts() {
        const totals = Object.fromEntries(
            Object.entries(counts).map(([k, v]) => [k, Object.values(v as Record<string, number>).reduce((a, b) => a + b, 0)])
        ) as { [P in keyof PerformanceCounts]: number }

        getLogger().debug(`Artifact repo perf totals -> ${Object.entries(totals).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
        getLogger().debug(`  Bytes written: ${bytesWritten}`)
        getLogger().debug(`  Bytes saved: ${bytesSaved}`)
        const sortedSizes = Object.entries(sizes).sort((a, b) => b[1] - a[1])
        if (sortedSizes.length > 0) {
            getLogger().debug('  ------- TOP 5 HASHES BY SIZE -------')
            for (let i = 0; i < Math.min(sortedSizes.length, 5); i++) {
                getLogger().debug(`    ${sortedSizes[i][0]}: ${sortedSizes[i][1]}`)
            }
        }

        getLogger().debug('  ------- TOP 5 HASHES PER OP -------')

        for (const [k, v] of Object.entries(counts)) {
            const sorted = Object.entries(v as Record<string, number>).sort((a, b) => b[1] - a[1])
            if (sorted.length === 0) continue
            getLogger().debug(`  [${k}]`)
            for (let i = 0; i < Math.min(sorted.length, 5); i++) {
                getLogger().debug(`    ${sorted[i][0]}: ${sorted[i][1]}`)
            }
        }
    }

    // END PERF

    const pendingHeadWrites = new Map<string, Promise<Head | undefined>>()

    let headsJson: Promise<Record<string, string>> | Record<string, string>
    async function readHeadsJson(): Promise<Record<string, string>> {
        const data = await fs.readFile(path.resolve(buildDir, 'heads.json'), 'utf-8').catch(throwIfNotFileNotFoundError)
        if (!data) {
            return {}
        }

        return JSON.parse(data)
    }

    function getHeadsJson(): typeof headsJson {
        if (headsJson) {
            return headsJson
        }

        return headsJson = readHeadsJson()
    }

    let writeAgain = false
    let pendingHeadsWrite: Promise<void> | undefined
    function writeHeadsJson() {
        if (!headsJson) {
            return
        }

        const doWrite = async () => {
            await fs.writeFile(path.resolve(buildDir, 'heads.json'), JSON.stringify(headsJson))
            if (writeAgain) {
                writeAgain = false
                await doWrite()
            }
        }

        if (!pendingHeadsWrite) {
            return pendingHeadsWrite = doWrite().finally(() => {
                pendingHeadsWrite = undefined
            })
        }

        writeAgain = true
    }

    const cachedHeads = new Map<string, Promise<Head | undefined>>()
    function readHead(id: string): Promise<Head | undefined> {
        if (cachedHeads.has(id)) {
            return cachedHeads.get(id)!
        }

        if (pendingHeadWrites.has(id)) {
            return pendingHeadWrites.get(id)!
        }

        const p = fs.readFile(getHeadPath(id), 'utf-8').then(JSON.parse).catch(throwIfNotFileNotFoundError)
        cachedHeads.set(id, p)

        return p
    }

    function writeHead(id: string, head: Head | undefined): Promise<unknown> {
        if (pendingHeadWrites.has(id)) {
            throw new Error(`Concurrent write to head: ${id}`)
        }

        const writeOrDelete = head !== undefined
            ? fs.writeFile(getHeadPath(id), Buffer.from(JSON.stringify(head), 'utf-8'))
            : fs.deleteFile(getHeadPath(id))

        const promise = writeOrDelete.then(() => head)
            .finally(() => pendingHeadWrites.delete(id))

        cachedHeads.set(id, Promise.resolve(head))
        pendingHeadWrites.set(id, promise)

        return promise
    }

    async function listHeads() {
        const heads: Head[] = []
        for (const f of await fs.readDirectory(headDir)) {
            if (f.type === 'file') {
                const h = await readHead(f.name)
                if (h) heads.push(h)
            }
        }
        return heads
    }

    async function hasBlock(hash: string) {
        printCountsOnFlush && inc('has', hash)

        return fs.fileExists(getBlockPath(hash))
    }

    function _writeBlock(hash: string, data: Uint8Array) {
        const key = `block:${hash}`
        const pending = pendingWrites.get(key)
        if (pending) {
            return pending.promise
        }

        const promise = fs.writeFile(getBlockPath(hash), data)
            .finally(() => pendingWrites.delete(key))

        pendingWrites.set(key, { promise, data })

        return promise
    }

    function writeBlock(hash: string, data: Uint8Array) {
        return _writeBlock(hash, data)
    }

    async function hasData(hash: string) {
        printCountsOnFlush && inc('has', hash)
        if (isNullHash(hash)) {
            return true
        }

        return fs.fileExists(getDataPath(hash))
    }

    function hasDataSync(hash: string) {
        printCountsOnFlush && inc('has', hash)
        if (isNullHash(hash)) {
            return true
        }

        return fs.fileExistsSync(getDataPath(hash))
    }

    function scanBlocks(hash: string, hint?: string) {
        if (hint) {
            const block = loadedBlocks.get(hint)
            if (block?.hasObject(hash)) {
                return block.readObject(hash)
            }
        }

        for (const [k, v] of loadedBlocks) {
            if (k === hint) continue

            if (v.hasObject(hash)) {
                return v.readObject(hash)
            }
        }

        for (const k of deferredBlocks) {
            deferredBlocks.delete(k)

            try {
                _openFsBlock(k, true)
                const block = loadedBlocks.get(k)!
                if (block.hasObject(hash)) {
                    return block.readObject(hash)
                }
            } catch (err) {
                throwIfNotFileNotFoundError(err)
            }
        }
    }

    const getNullData = memoize(() => Buffer.from(JSON.stringify(null)))
    let nullDataPromise: Promise<Buffer> | undefined

    function _readData(hash: string, isAsync?: false): Buffer
    function _readData(hash: string, isAsync: true): Promise<Buffer> 
    function _readData(hash: string, isAsync?: boolean) {
        printCountsOnFlush && inc('read', hash)

        if (isNullHash(hash)) {
            return isAsync ? nullDataPromise ??= Promise.resolve(getNullData()) : getNullData()
        }

        const p = getDataPath(hash)
        const d = pendingWrites.get(p)?.data
        if (d !== undefined) {
            return isAsync ? Promise.resolve(d) : d
        }

        function handleError(e: unknown) {
            throwIfNotFileNotFoundError(e)

            const scanned = scanBlocks(hash)
            if (scanned) {
                writeData(hash, scanned)
                return scanned
            }

            throw e
        }

        if (!isAsync) {
            try {
                return fs.readFileSync(p)
            } catch (e) {
                return handleError(e)
            }
        }

        return fs.readFile(p).catch(handleError)
    }

    function readData(hash: string) {
        return _readData(hash, true)
    }

    function readDataSync(hash: string) {
        return _readData(hash)
    }

    function throwIfNotFileExistsError(err: unknown): never | void {
        if ((err as any).code !== 'EEXIST') {
            throw err
        }
    }

    // Storing the data is needed to support synchronous reads with async writes
    const didWrite = new Set<string>([getNullHash()])
    const pendingWrites = new Map<string, { promise: Promise<void>, data: Uint8Array }>()
    const loadedBlocks = new Map<string, ReturnType<typeof openBlock>>()
    const deferredBlocks = new Set<string>()

    function _writeData(hash: string, data: Uint8Array, isAsync?: false): void
    function _writeData(hash: string, data: Uint8Array, isAsync: true): Promise<void> 
    function _writeData(hash: string, data: Uint8Array, isAsync?: boolean) {
        if (didWrite.has(hash)) {
            return isAsync ? Promise.resolve() : void 0
        }

        printCountsOnFlush && inc('write', hash)

        function end(e?: unknown) {
            didWrite.add(hash)

            if (!e) {
                sizes[hash] = data.length
                bytesWritten += data.length
            } else {
                throwIfNotFileExistsError(e)
                bytesSaved += data.length
            }
        }
        
        const p = getDataPath(hash)
        const pending = pendingWrites.get(p)
        if (pending) {
            if (!isAsync) {
                return
            }

            return pending.promise
        }

        try {
            if (!isAsync) {
                return fs.writeFileSync(p, data, { flag: 'wx' })
            }

            const promise = fs.writeFile(p, data, { flag: 'wx' })
                .then(end, end)
                .finally(() => pendingWrites.delete(p))

            pendingWrites.set(p, { promise, data })

            return promise
        } catch (e) {
            end(e)
        }
    }

    function writeData(hash: string, data: Uint8Array) {
        return _writeData(hash, data, true)
    }

    function writeDataSync(hash: string, data: Uint8Array) {
        return _writeData(hash, data, false)
    }

    async function readManifest(hash: string) {
        return await readJsonRaw<ArtifactStoreManifest>(root, hash)
    }
    
    function readManifestSync(hash: string) {
        return readJsonRawSync<ArtifactStoreManifest>(root, hash)
    }

    async function getBuildFs(hash: string) {
        const index = await _getFsIndex(hash)
        _deferBlocks(index)

        return { hash, index }
    } 

    const buildFileSystems = new Map<string, ReturnType<typeof createBuildFsFragment> | Promise<ReturnType<typeof createBuildFsFragment>>>()
    function getRootBuildFs(id: string) {
        if (buildFileSystems.has(id)) {
            return buildFileSystems.get(id)!
        }

        const s = getBuildFsIndex(id).then(x => {
            const y = buildFileSystems.get(id)
            if (y && !(y instanceof Promise)) {
                return y
            }
            const fs = createBuildFsFragment(root, x)
            buildFileSystems.set(id, fs)
            return fs
        })
        buildFileSystems.set(id, s)

        return s
    }

    function getRootBuildFsSync(id: string) {
        const cached = buildFileSystems.get(id)
        if (cached && !(cached instanceof Promise)) {
            return cached
        }

        const index = getBuildFsIndexSync(id)
        const fs = createBuildFsFragment(root, index)
        buildFileSystems.set(id, fs)

        return fs
    }

    const metadata = createReverseIndex()

    function getMetadata(hash: string): Record<string, ArtifactMetadata> | undefined
    function getMetadata(hash: string, source: string): ArtifactMetadata
    function getMetadata(hash: string, source?: string) {
        if (!source) {
            return metadata.get(hash)
        }

        return _getMetadata(hash, source)
    }

    const pendingLinks = new Map<string, Promise<string>>()
    function doLink(dataPath: string, targetPath: string) {
        if (pendingLinks.has(targetPath)) {
            return pendingLinks.get(targetPath)!
        }

        const p = fs.link(dataPath, targetPath)
            .then(() => targetPath)
            .catch(e => (throwIfNotFileExistsError(e), targetPath))
            .finally(() => pendingLinks.delete(targetPath))

        pendingLinks.set(targetPath, p)

        return p
    }

    function resolveArtifact(hash: string, opt: ResolveArtifactOpts & { sync: true }): string
    function resolveArtifact(hash: string, opt?: ResolveArtifactOpts): Promise<string> | string
    function resolveArtifact(hash: string, opt?: ResolveArtifactOpts) {
        const dest = getDataPath(hash)

        // XXX
        if (opt?.noWrite || opt?.sync) {
            if (opt.extname || opt.filePath) {
                throw new Error(`Cannot use other options with "noWrite"`)
            }
            
            return dest
        }

        if (opt?.name) {
            if (opt.extname || opt.filePath) {
                throw new Error(`Cannot set 'extname' or 'filePath' with 'name'`)
            }
    
            return doLink(dest, path.resolve(resolvedDir, opt.name))
        }

        // XXX: when resolving we place the artifact in a flat space so we always link
        if (!opt?.extname && !opt?.filePath) {
            const linked = path.resolve(resolvedDir, hash)
        
            return doLink(dest, linked)
        }

        if (opt.extname && opt.filePath) {
            throw new Error(`Cannot set both 'extname' and 'filePath'`)
        }
    
        const linked = opt.extname ? path.resolve(resolvedDir, `${hash}${opt.extname}`) : opt.filePath!
    
        return doLink(dest, linked)
    }

    const pendingDeletes = new Map<string, Promise<void>>()
    async function _deleteData(hash: string) {
        const p = getDataPath(hash)
        const stats = await getStatsFile(p)
        delete stats[hash]
        await fs.deleteFile(p)
        pendingDeletes.delete(hash)
    }

    function deleteData(hash: string) {
        const p = _deleteData(hash)
        pendingDeletes.set(hash, p)
        return p
    }

    function deleteDataSync(hash: string) {
        pendingDeletes.set(hash, _deleteData(hash))
    }

    interface StatsFile {
        [hash: string]: StatsEntry
    }

    const openedStatFiles = new Map<string, StatsFile | Promise<StatsFile>>()
    async function saveStats() {
        const entries = [...openedStatFiles.entries()]
        openedStatFiles.clear()

        await Promise.all(entries.map(async ([k, v]) => fs.writeFile(k, JSON.stringify(await v))))
    }

    function getStatsFile(dataPath: string): Promise<StatsFile> | StatsFile {
        const fileName = path.resolve(path.dirname(path.dirname(dataPath)), '.stats.json')
        if (openedStatFiles.has(fileName)) {
            return openedStatFiles.get(fileName)!
        }

        const data = tryReadJson<StatsFile>(fs, fileName).then(val => {
            const f = val ?? {}
            openedStatFiles.set(fileName, f)

            return f
        })
        openedStatFiles.set(fileName, data)

        return data
    }

    async function updateStatsEntry(oldStats: StatsEntry | undefined, hash: string): Promise<StatsEntry> {
        const p = getDataPath(hash)

        try {
            const newStats = await fs.stat(p)
            const isValidStill = oldStats?.corrupted ? false : oldStats?.mtimeMs === newStats.mtimeMs
            const corrupted = isValidStill ? oldStats?.corrupted : isCorrupted(hash, await readData(hash))

            return {
                ...oldStats,
                ...newStats,
                missing: undefined,
                corrupted: corrupted ? true : undefined,
                lastStatTime: Date.now(),
            }
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }

            return {
                size: 0,
                mtimeMs: 0,
                ...oldStats,
                missing: true,
                lastStatTime: Date.now(),
            }
        }
    }

    async function statData(hash: string) {
        if (isNullHash(hash)) {
            return { size: 0, mtimeMs: 0 }
        }

        const p = getDataPath(hash)
        const k = path.basename(p)
        const stats = await getStatsFile(p)
        const lastStatTime = stats[k]?.lastStatTime
        if (!lastStatTime || ((Date.now() - lastStatTime) / 1000 > 300)) {
            stats[k] = await updateStatsEntry(stats[k], hash)
        }

        return stats[k]
    }

    function _getMetadata(hash: string, storeHash: string, isAsync?: false): ArtifactMetadata
    function _getMetadata(hash: string, storeHash: string, isAsync: true): Promise<ArtifactMetadata> | ArtifactMetadata
    function _getMetadata(hash: string, storeHash: string, isAsync?: boolean) {
        if (isNullHash(storeHash)) {
            return {}
        }

        const m = metadata.get(hash, storeHash)
        if (m) {
            return m
        }

        const manifest = manifestBacklog[storeHash]
        if (manifest) {
            delete manifestBacklog[storeHash]
            indexManifest(storeHash, manifest)

            return metadata.get(hash, storeHash)!
        }

        if (isAsync) {
            const p = getStore(storeHash)
            if (p instanceof Promise) {
                return p.then(s => s.getMetadata(hash, storeHash))
            }
            return p.getMetadata(hash, storeHash)
        }

        return getStoreSync(storeHash).getMetadata(hash, storeHash)
    }

    async function getMetadata2(pointer: string): Promise<ArtifactMetadata>
    async function getMetadata2(hash: string, source: string): Promise<ArtifactMetadata>
    async function getMetadata2(pointerOrHash: string, source?: string) {
        if (source) {
            return _getMetadata(pointerOrHash, source, true)
        }

        const pointer = pointerOrHash
        if (!isDataPointer(pointer)) {
            throw new Error('Not implemented')
        }

        if (isNullMetadataPointer(pointer)) {
            return {}
        }

        const { hash, storeHash } = pointer.resolve()

        return _getMetadata(hash, storeHash, true)
    }

    const root: DataRepository = {
        commitStore,
        commitHead: commit,
        listHeads,
        putHead,
        getHead: getHeadData,
        deleteHead,
        readData,
        readDataSync,
        serializeBuildFs,
        getStore: getStore as DataRepository['getStore'],
        getStoreSync: getStoreSync as DataRepository['getStoreSync'],
        createStore: createStore as DataRepository['createStore'],
        getMetadata,
        hasData,
        hasDataSync,
        getBuildFs,
        writeData,
        writeDataSync,
        resolveArtifact,
        deleteData,
        deleteDataSync,
        getDataDir,
        getLocksDir,
        getBlocksDir,
        getMetadata2,
        getRootBuildFs,
        getRootBuildFsSync,
        statData,
        copyFrom,
    }

    async function saveIndex(index: BuildFsIndex): Promise<ReadonlyBuildFs> {
        const hash = await writeJsonRaw(root, index)

        return { hash, index }
    }

    async function _serializeBuildFs(buildFs: ReadonlyBuildFs) {
        const objects: [string, string][] = []
        const result = new Set<string>()
        const visited = new Map<string, Set<string>>()

        function addVisited(storeHash: string, hash: string) {
            result.add(storeHash)
            result.add(hash)
            objects.push([storeHash, hash])
            if (!visited.has(storeHash)) {
                visited.set(storeHash, new Set())
            }
            visited.get(storeHash)!.add(hash)
        }

        for (const f of Object.values(buildFs.index.files)) {
            const storeHash = f.storeHash ?? buildFs.index.stores[f.store].hash
            if (!isNullHash(storeHash)) {
                addVisited(storeHash, f.hash)
            } else {
                result.add(f.hash)
            }
        }

        while (objects.length > 0) {
            const [storeHash, hash] = objects.pop()!
            const store = await getStore(storeHash)
            const metadata = store.getMetadata(hash, storeHash)
            if (metadata.dependencies) {
                for (const [k, v] of Object.entries(metadata.dependencies)) {
                    for (const d of v) {
                        if (isNullHash(k)) {
                            result.add(d)
                            continue
                        }

                        if (!visited.get(k)?.has(d)) {
                            addVisited(k, d)
                        }
                    }
                }
            }
            if (metadata.sourcemaps) {
                for (const h of Object.values(metadata.sourcemaps)) {
                    const d = toDataPointer(h)
                    const { hash, storeHash } = d.resolve()
                    result.add(hash)
                    if (!isNullHash(storeHash)) {
                        result.add(storeHash)
                    }
                }
            }
        }

        return result
    }

    async function serializeBuildFs(buildFs: ReadonlyBuildFs): Promise<Record<string, Uint8Array>>
    async function serializeBuildFs(buildFs: ReadonlyBuildFs, exclude: Iterable<string>): Promise<[objects: Record<string, Uint8Array>, excluded: Set<string>]>
    async function serializeBuildFs(buildFs: ReadonlyBuildFs, exclude?: Iterable<string>) {
        const excludeSet = exclude ? new Set(exclude) : undefined

        if (await hasBlock(buildFs.hash) && !exclude) {
            const data = await fs.readFile(getBlockPath(buildFs.hash))
            const block = openBlock(Buffer.isBuffer(data) ? data : Buffer.from(data))
            const objects = Object.fromEntries(block.listObjects().map(h => [h, block.readObject(h)]))

            return objects
        }

        const stores = getStoreHashes(buildFs.index)
        const artifacts = await _serializeBuildFs(buildFs)
        artifacts.add(buildFs.hash)

        for (const f of Object.values(buildFs.index.files)) {
            const storeHash = f.storeHash || buildFs.index.stores[f.store].hash
            if (isNullHash(storeHash)) {
                artifacts.add(f.hash)
            } else if (!stores.has(storeHash)) { // For debug
                throw new Error(`Store containing "${f.hash}" was never serialized: ${storeHash}`)
            } else if (!artifacts.has(f.hash)) { // For debug
                throw new Error(`Object was never serialized from "${storeHash}": ${f.hash}`)
            }
        }

        const actualExcluded = new Set<string>()
        const promises: Promise<[string, Uint8Array]>[] = []
        for (const hash of artifacts) {
            if (excludeSet?.has(hash)) {
                actualExcluded.add(hash)
                continue
            }
            promises.push(readData(hash).then(d => [hash, d]))
        }

        const objects = Object.fromEntries(await Promise.all(promises))

        return excludeSet ? [objects, actualExcluded] : objects
    }

    async function copyFrom(repo: DataRepository, buildFs: ReadonlyBuildFs, pack?: boolean | 'both', previous?: ReadonlyBuildFs): Promise<void> {
        if (repo.getDataDir() === root.getDataDir()) {
            return
        }

        if ((!pack && await hasData(buildFs.hash)) || (pack && await hasBlock(buildFs.hash))) {
            return
        }

        if (pack && pack !== 'both') {
            const maybeBlockPath = path.resolve(repo.getBlocksDir(), buildFs.hash)
            const blockData = await fs.readFile(maybeBlockPath).catch(throwIfNotFileNotFoundError)
            if (blockData) {
                return fs.writeFile(getBlockPath(buildFs.hash), blockData)
            }
        }

        async function maybeGetPreviousBlock(hash: string) {
            const maybeBlockPath = getBlockPath(hash)
            if (await fs.fileExists(maybeBlockPath)) {
                const data = await fs.readFile(maybeBlockPath)
                
                return openBlock(Buffer.isBuffer(data) ? data : Buffer.from(data))
            }
        }

        async function packBlock(data: Record<string, Uint8Array>) {
            const block = createBlock(Object.entries(data))
            checkBlock(block, buildFs.index, data) // For debugging
    
            await writeBlock(buildFs.hash, block)
        }

        async function dumpObjects(data: Record<string, Uint8Array>) {
            await Promise.all(Object.entries(data).map(([k, v]) => writeData(k, v)))
        }

        const previousBlock = previous ? await maybeGetPreviousBlock(previous.hash) : undefined
        const excluded = previousBlock ? new Set(previousBlock.listObjects()) : undefined
        if (excluded) {
            const data = await runTask('serialize', 'copyFrom', () => repo.serializeBuildFs(buildFs, excluded), 10)
            if (!pack) {
                return dumpObjects(data[0])
            }

            if (previousBlock) {
                for (const k of data[1]) {
                    data[0][k] = previousBlock.readObject(k)
                }
            }

            if (pack === 'both') {
                await dumpObjects(data[0])
            }

            return packBlock(data[0])
        }

        const data = await runTask('serialize', 'copyFrom', () => repo.serializeBuildFs(buildFs), 10)
        if (pack) {
            if (pack === 'both') {
                await dumpObjects(data)
            }

            return packBlock(data)    
        }

        // ~150ms
        await runTask('objects', 'copyFrom', async () => {
            const hasObject = Object.fromEntries(
                await Promise.all(Object.keys(data).map(async k => [k, await hasData(k)] as const))
            )
            
            await Promise.all(Object.entries(hasObject).filter(x => !x[1]).map(([k]) => writeData(k, data[k])))
        }, 10)
    }

    function createStore() {
        return createArtifactStore(root, initArtifactStoreState()) as OpenedArtifactStore
    }

    function _loadFsBlock(hash: string, data: Uint8Array): BuildFsIndex {
        const block = openBlock(Buffer.isBuffer(data) ? data : Buffer.from(data))
        loadedBlocks.set(hash, block)

        return JSON.parse(block.readObject(hash).toString('utf-8'))
    }

    function _openFsBlock(hash: string, sync = false) {
        if (loadedBlocks.has(hash)) {
            const block = loadedBlocks.get(hash)!

            return JSON.parse(block.readObject(hash).toString('utf-8')) as BuildFsIndex
        }

        if (sync) {
            return _loadFsBlock(hash, fs.readFileSync(getBlockPath(hash)))
        }

        return fs.readFile(getBlockPath(hash)).then(data => _loadFsBlock(hash, data))
    }

    function _openFsBlockSync(hash: string) {
        return _openFsBlock(hash, true) as BuildFsIndex
    }

    async function _getFsIndex(hash: string) {
        try {
            return await _openFsBlock(hash)
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            return readJsonRaw<BuildFsIndex>(root, hash)
        }
    }

    function _getFsIndexSync(hash: string) {
        try {
            return _openFsBlockSync(hash)
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            return readJsonRawSync<BuildFsIndex>(root, hash)
        }
    }

    function _deferBlocks(index: BuildFsIndex) {
        if (!index.dependencies) {
            return index
        }

        for (const [k, v] of Object.entries(index.dependencies)) {
            if (!loadedBlocks.has(v)) {
                deferredBlocks.add(v)
            }
        }

        return index
    }

    async function getBuildFsIndex(id: string) {
        const head = await getHeadData(id)
        const index = head ? await _getFsIndex(head.storeHash) : { stores: {}, files: {} }

        return _deferBlocks(index)
    }

    function getBuildFsIndexSync(id: string) {
        const head = getHeadDataSync(id)
        const index = head ? _getFsIndexSync(head.storeHash) : { stores: {}, files: {} }

        return _deferBlocks(index)
    }

    // Store utils
    function getProgramStore(bt: Pick<BuildTarget, 'programId' | 'projectId' | 'branchName' | 'workingDirectory'>) {
        const ref = toProgramRef(bt)

        const openVfs = async (key: string) => {
            const vfs = await getRootBuildFs(ref)

            return vfs.open(key)
        }

        async function getFullStore() {
            const head = await getHeadData(ref)
            if (!head?.storeHash) {
                // throw new Error(`No program store found`)
                return { hash: '', index: { files: {}, stores: {} } }
            }

            return getBuildFs(head.storeHash)
        }

        async function getPackageStore() {
            return getFullStore()
        }

        // Compilation

        // Synth
        async function getSynthStore() {
            const vfs = await openVfs('synth')
    
            async function commitTemplate(template: TfJson) {
                await writeTemplate(template, getProgramFs(bt))
            }

            function setDeps(deps: Record<string, ReadonlyBuildFs>) {
                for (const [k, v] of Object.entries(deps)) {
                    vfs.mount(k, v)
                }
            }

            return { commitTemplate, afs: vfs, setDeps }
        }

        async function clear(key: string) {
            const r = await getRootBuildFs(ref)
            r.clear(key)
        }

        return { clear, getTargets: async () => getTargets(await getRootBuildFs(ref)), getInstallation, getTemplate: async () => getTemplate(await openVfs('synth')), getSynthStore, getFullStore, getVfs: openVfs, getRoot: () => getRootBuildFs(ref), getModuleMappings, getPackageStore }
    }

    //

    function createNullStore(): ClosedArtifactStore {
        return {
            hash: getNullHash(),
            state: 'closed',
            listArtifacts: async () => ({}),
            listArtifactsSync: () => ({}),
            readArtifact: readData,
            readArtifactSync: readDataSync,
            resolveMetadata: () => {
                throw new Error(`Cannot resolve metadata with a null store`)
            },
            getMetadata: () => {
                throw new Error(`Cannot get metadata with a null store`)
            },
        }
    }

    const getNullStore = memoize(createNullStore)

    const stores = new Map<string, ClosedArtifactStore | Promise<ClosedArtifactStore>>()
    stores.set(getNullHash(), getNullStore())

    function getStore(hash: string) {
        if (stores.has(hash)) {
            return stores.get(hash)!
        }

        const s = loadArtifactStore(hash).then(x => {
            const y = stores.get(hash)
            if (y && !(y instanceof Promise)) {
                return y
            }
            stores.set(hash, x)
            return x
        })
        stores.set(hash, s)

        return s
    }

    function getStoreSync(hash: string) {
        const cached = stores.get(hash)
        if (cached && !(cached instanceof Promise)) {
            return cached
        }

        const s = loadArtifactStoreSync(hash)
        stores.set(hash, s)

        return s
    }

    function commitStore(state: ArtifactStoreState) {
        const sorted = sortAndPruneMetadata({ type: state.mode, artifacts: state.workingMetadata } as ArtifactStoreManifest)
        const manifest = {
            type: state.mode,
            artifacts: sorted,
        } as ArtifactStoreManifest

        const data = Buffer.from(JSON.stringify(manifest), 'utf-8')
        const hash = getHash(data)
        writeData(hash, data)
        indexManifestLazy(hash, manifest)

        return hash
    }

    const manifestBacklog: Record<string, ArtifactStoreManifest> = {}
    function indexManifestLazy(hash: string, manifest: ArtifactStoreManifest) {
        if (metadata.hasIndex(hash)) {
            return
        }

        manifestBacklog[hash] = manifest
    }

    function indexManifest(hash: string, manifest: ArtifactStoreManifest) {
        function hydrateDeps(s: string, o: Record<string, ArtifactMetadata>) {
            for (const m of Object.values(o)) {
                if (m.dependencies?.['']) {
                    m.dependencies[s] = m.dependencies['']
                    delete m.dependencies['']
                }
            }
        }

        if (metadata.hasIndex(hash)) {
            return
        }

        if (manifest.type === 'flat') {
            hydrateDeps(hash, manifest.artifacts)
            metadata.index(hash, { [hash]: manifest.artifacts })

            return
        }

        if (manifest.artifacts['']) {
            manifest.artifacts[hash] = manifest.artifacts['']
            delete manifest.artifacts['']
        }

        for (const k of Object.keys(manifest.artifacts)) {
            hydrateDeps(k, manifest.artifacts[k])
        }

        metadata.index(hash, manifest.artifacts)
    }

    function loadStoreFromManifest(hash: string, manifest: ArtifactStoreManifest) {
        indexManifest(hash, manifest)

        return createArtifactStore(root, {
            status: 'closed',
            hash: hash,
            mode: manifest.type === 'flat' ? 'flat' : 'denormalized',
            workingMetadata: manifest.artifacts,
        } as ArtifactStoreState) as ClosedArtifactStore
    }

    async function loadArtifactStore(hash: string) {
        const manifest = await readManifest(hash)
    
        return loadStoreFromManifest(hash, manifest)
    }

    function loadArtifactStoreSync(hash: string) {
        const manifest = readManifestSync(hash)
    
        return loadStoreFromManifest(hash, manifest)
    }

    async function saveFs(id: string, hash: string) {
        const headData = await getHeadData(id)

        const h: Head = {
            id,
            storeHash: hash,
            timestamp: new Date().toISOString(),
            previousCommit: headData?.commitHash ?? headData?.previousCommit,
        }

        await putHead(h)
    }

    async function commit(id: string, programHash?: string, isRollback?: boolean, isTest?: boolean) {
        await runTask('flush', id, () => flushFs(id), 1)

        const head = await getHeadData(id)
        if (!head) {
            return
        }

        if (!head.commitHash) {
            const proposed = sortRecord({ ...head, programHash, isRollback, isTest }) as any as Head
            const hash = await writeJsonRaw(root, proposed)
            const newHead = { ...proposed, commitHash: hash }
            await putHead(newHead)

            return newHead
        }

        return head
    }

    async function putHead(head: Head) {
        await writeHead(head.id, head)
    }

    async function deleteHead(id: string) {
        await writeHead(id, undefined).catch(throwIfNotFileNotFoundError)
    }

    async function getHeadData(id: string) {
        return readHead(id)
    }

    function getHeadDataSync(id: string) {
        try {
            const data = fs.readFileSync(getHeadPath(id), 'utf-8')

            return JSON.parse(data) as Head
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            return undefined
        }
    }

    async function printBlockInfo(hash: string) {
        const data = await fs.readFile(getBlockPath(hash))
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const info = getBlockInfo(buf)

        printLine(`Header size: ${info.headerSize}`)
        printLine(`Data size: ${info.dataSize}`)
        // printLine(`Objects:`)
        // for (const h of Object.keys(info.objects)) { 
        //     printLine(h)
        // }

        const b = openBlock(buf)
        const index: BuildFsIndex = JSON.parse(b.readObject(hash).toString('utf-8'))
        checkBlock(buf, index)

        for (const [k, v] of Object.entries(index.files)) {
            printLine(`${k}: ${v.hash}`)
        }
    }

    async function flushFs(id: string) {
        let didChange = false
        const fs = await buildFileSystems.get(id)
        if (!fs) {
            return didChange
        }

        // XXX: need to do this per-id
        await Promise.all([...pendingWrites.values()].map(x => x.promise))

        const hash = await fs.flush()
        if (hash) {
            didChange = true
            await runTask('saveFs', id, () => saveFs(id, hash), 1)
        } else {
            getLogger().log(`Skipped saving index ${id} (no changes)`)
        }

        buildFileSystems.delete(id)

        // The index files may be buffered still
        await Promise.all([...pendingWrites.values()].map(x => x.promise))

        // if (didChange) {
        //     // This resets any caching that depends on using the fs as the key
        //     // TODO: add a hash getter to the fs instead to be used as a key
        //     const prefix = `${buildDir}:${id}`
        //     for (const k of roots.keys()) {
        //         if (k.startsWith(prefix)) {
        //             roots.delete(k)
        //         }
        //     }
        // }

        return didChange
    }

    async function flush() {
        await runTask('artifacts', 'flush', async () => {
            await Promise.all(pendingDeletes.values())
            await saveStats()

            for (const [k] of buildFileSystems) {
                await flushFs(k)
            }
        }, 10)

        if (printCountsOnFlush) {
            printCounts()
        }
    }

    return {
        root,
        flush,
        commit,
        getHead: getHeadData,
        putHead,
        deleteHead,
        getStore,
        createStore,
        copyFrom,

        getProgramStore,
        getRootBuildFs,
        getBuildFsIndex,

        saveIndex,

        createRootFs,

        statData,

        // DEBUG
        printBlockInfo,
    }
}

const repos: Record<string, ReturnType<typeof getRepository>> = {}
function getRepo(fs: Fs & SyncFs, rootDir: string) {
    const key = `${getExecutionId()}:${rootDir}`

    return repos[key] ??= getRepository(fs, rootDir)
}

export function getDataRepository(fs: Fs & SyncFs = getFs(), buildDir = getBuildDir()): DataRepository {
    return getRepo(fs, buildDir).root
}

export function getProgramFsIndex(bt: Pick<BuildTarget, 'programId' | 'projectId' | 'branchName'>) {
    return getRepo(getFs(), getBuildDir()).getBuildFsIndex(toProgramRef(bt))
}

export function getDeploymentFsIndex(deploymentId: string) {
    return getRepo(getFs(), getBuildDir()).getBuildFsIndex(deploymentId)
}

export async function getInstallation(fs: Pick<Fs, 'readFile'>): Promise<InstallationAttributes | undefined> {
    const pkg = await tryReadJson<any>(fs, 'packages.json')
    if (!pkg) {
        return
    }

    return { packages: pkg?.packages, packageLockTimestamp: pkg?.packageLockTimestamp, importMap: pkg?.flatImportMap, mode: pkg?.mode }
}

export function checkBlock(block: Buffer, index: BuildFsIndex, source?: Record<string, Uint8Array>) {
    const b = openBlock(block)
    for (const [k, v] of Object.entries(index.files)) {
        if (!b.hasObject(v.hash)) {
            if (source && !source[v.hash]) {
                throw new Error(`Source is missing file: ${k} [${v.hash}]`)
            }
            throw new Error(`Missing file: ${k} [${v.hash}]`)
        }

        const d = b.readObject(v.hash)
        if (isCorrupted(v.hash, d)) {
            throw new Error(`Corrupted file: ${k}`)
        }
    }
}

export async function commitPackages(
    fs: Pick<Fs, 'writeFile'>, 
    packages: Record<string, NpmPackageInfo>, 
    flatImportMap: InstallationAttributes['importMap'],
    packageLockTimestamp: number,
    mode: 'all' | 'types' | 'none'
) {
    await fs.writeFile('[#packages]packages.json', JSON.stringify({
        mode,
        packages,
        flatImportMap,
        packageLockTimestamp,
    }))
}

export async function getTargets(fs: Pick<Fs, 'readFile'>): Promise<TargetsFile | undefined> {
    return tryReadJson(fs, '[#compile]__targets__.json')
}

export async function setTargets(fs: Pick<Fs, 'writeFile'>, targets: TargetsFile): Promise<void> {
    for (const [k, v] of Object.entries(targets)) {
        for (const [k2, v2] of Object.entries(v)) {
            v[k2] = sortRecord(v2)
        }
        targets[k] = sortRecord(v)
    }

    return await fs.writeFile('[#compile]__targets__.json', JSON.stringify(sortRecord(targets)))
}

function isSerializedTemplate(template: TfJson | SerializedTemplate): template is SerializedTemplate {
    return typeof template['provider'] === 'string'
}

export async function getTemplate(fs: Pick<BuildFsFragment, 'readFile' | 'readData'>): Promise<TfJson | undefined> {
    const rawTemplate = await tryReadJson<SerializedTemplate | TfJson>(fs, 'template.json')
    if (!rawTemplate) {
        return
    }

    if (isSerializedTemplate(rawTemplate)) {
        return deserializeTemplate(fs, rawTemplate)
    }

    return rawTemplate
}

export interface TemplateWithHashes {
    readonly template: TfJson
    readonly hashes: SerializedTemplate
}

// Mostly useful for quickly finding changes in templates
export async function getTemplateWithHashes(programHash?: string): Promise<TemplateWithHashes | undefined> {
    if (!programHash) {
        const hashes = await tryReadJson<SerializedTemplate>(getProgramFs(), 'template.json')
        if (!hashes) {
            return
        }

        return {
            template: isSerializedTemplate(hashes) ? await deserializeTemplate(getProgramFs(), hashes) : hashes,
            hashes,
        }
    }

    const repo = getDataRepository()
    const { index } = await repo.getBuildFs(programHash)
    const bfs = createBuildFsFragment(repo, index)

    const hashes = await tryReadJson<SerializedTemplate>(bfs, 'template.json')
    if (!hashes) {
        return
    }

    return {
        template: isSerializedTemplate(hashes) ? await deserializeTemplate(bfs.root, hashes) : hashes,
        hashes,
    }
}


const manifestPath = '[#compile]__runtimeManifest__.json'
const mappingsPath = '[#compile]__infraMapping__.json'

interface BindingTypes {
    readonly name: string
    readonly text: string
    readonly references?: Record<string, string>
    readonly symbols?: Record<string, TypeInfo>
    readonly sourcemap?: string
}

export interface ModuleBindingResult {
    readonly id: string
    readonly path: string
    readonly types?: BindingTypes
    readonly internal?: boolean
}

async function resolveBindingTypes(fs: Pick<Fs, 'readFile'>, types: BindingTypes): Promise<BindingTypes> {
    const [text, sourcemap] = await Promise.all([
        fs.readFile(types.text, 'utf-8'),
        types.sourcemap ? fs.readFile(types.sourcemap, 'utf-8') : undefined,
    ])

    return { name: types.name, text, sourcemap, references: types.references, symbols: types.symbols } 
}

async function resolveBindingResult(index: BuildFsIndex, fs: Pick<Fs, 'readFile'>, result: Omit<ModuleBindingResult, 'id'>): Promise<HashedModuleBinding> {
    const hash = index.files[result.path].hash
    if (!result.types) {
        return { ...result, hash }
    }

    return { ...result, hash, types: await resolveBindingTypes(fs, result.types) }
}

export async function readModuleManifest(fs: Pick<JsonFs, 'readJson'>): Promise<Record<string, ModuleBindingResult> | undefined> {
    const d = await fs.readJson<Record<string, ModuleBindingResult>>(manifestPath).catch(e => {
        throwIfNotFileNotFoundError(e)

        return undefined
    })

    if (d && Object.keys(d).length === 0) {
        return
    }

    return d
}

export async function writeModuleManifest(fs: JsonFs, manifest: Record<string, ModuleBindingResult>) {
    await fs.writeJson(manifestPath, manifest)
}

export async function getModuleMappings(fs: Pick<JsonFs, 'readJson'>) {
    const m = await readModuleManifest(fs)
    if (!m) {
        return
    }

    return Object.fromEntries(Object.values(m).map(v => [v.id, { path: v.path, types: v.types, internal: v.internal }]))
}

export async function readInfraMappings(fs: Pick<Fs, 'readFile'>): Promise<Record<string, string>> {
    const d = await tryReadJson<Record<string, string>>(fs, mappingsPath)

    return d ?? {}
}

export async function writeInfraMappings(fs: Pick<Fs, 'writeFile'>, mappings: Record<string, string>) {
    await fs.writeFile(mappingsPath, JSON.stringify(mappings))
}


export async function getPublished(fs: Pick<Fs, 'readFile'>) {
    return tryReadJson<Record<string, string>>(fs, 'published.json')
}


function expandResources(resources: Record<string, Record<string, any>>) {
    const result: Record<string, Record<string, any>> = {}
    for (const [k, v] of Object.entries(resources)) {
        const [type, ...rest] = k.split('.')
        const name = rest.join('.')
        const group = result[type] ??= {}
        group[name] = v
    }
    return result
}

function flattenResources(resources: Record<string, Record<string, any>>) {
    const result: Record<string, any> = {}
    for (const [k, v] of Object.entries(resources)) {
        for (const [k2, v2] of Object.entries(v)) {
            result[`${k}.${k2}`] = v2
        }
    }
    return result
}

const compressTemplates = false

export async function writeTemplate(template: TfJson, fs: Pick<BuildFsV2, 'writeFile' | 'writeData'> = getProgramFs()): Promise<void> {
    if (!compressTemplates) {
        await fs.writeFile('template.json', JSON.stringify(template))
    } else {
        const { result, dependencies } = await serializeTemplate(fs, template)
        await fs.writeFile('template.json', JSON.stringify(result), { metadata: { dependencies: dependencies } })
    }
}

async function serializeTemplate(fs: Pick<BuildFsV2, 'writeData'>, template: TfJson) {
    // Serialization could be done automatically but breaking things up too much
    // makes compression less efficient
    const writer = createStructuredArtifactWriter('[#synth]', fs)
    const builder = writer.createBuilder<TfJson, SerializedTemplate>()
    builder.writeJson('provider', template.provider)
    builder.writeJson('terraform', template.terraform)

    if (template.resource) {
        builder.writeTree('resource', flattenResources(template.resource))
    }

    if (template.locals) {
        builder.writeTree('locals', template.locals)
    }

    if (template.data) {
        builder.writeTree('data', flattenResources(template.data))
    }

    if (template.moved) {
        builder.writeJson('moved', template.moved)
    }

    if (template['//']) {
        builder.writeJson('//', template['//'])
    }

    return builder.build()
}

export async function readState(fs: Pick<BuildFsV2, 'readFile' | 'readData'> = getDeploymentFs()) {
    const rawState = await tryReadJson<SerializedState>(fs, '__full-state__.json') ?? (await tryReadJson<SerializedState>(fs, 'full-state.json'))
    if (!rawState) {
        return
    }

    return deserializeState(fs, rawState)
}

async function writeState(fs: Pick<BuildFsV2, 'writeFile' | 'writeData'>, state: TfState) {
    const serialized = await serializeState(fs, state)
    await fs.writeFile('__full-state__.json', JSON.stringify(serialized.result), { metadata: { dependencies: serialized.dependencies } })
}

export async function setResourceProgramHashes(fs: Pick<BuildFsV2, 'writeFile'>, hashes: Record<string, string>) {
    await fs.writeFile('__resource-program-hashes__.json', JSON.stringify(hashes))
}

export async function getResourceProgramHashes(fs: Pick<Fs, 'readFile'>): Promise<Record<string, string> | undefined> {
    return tryReadJson(fs, '__resource-program-hashes__.json')
}

async function serializeState(fs: Pick<BuildFsV2, 'writeData'>, state: TfState) {
    const writer = createStructuredArtifactWriter('[#deploy]', fs)
    const resources = Object.fromEntries(state.resources.map(r => [`${r.type}.${r.name}`, r]))
    const builder = writer.createBuilder<{ resources: typeof resources } & Omit<TfState, 'resources'>, SerializedState>()
    builder.writeRaw('serial', state.serial)
    builder.writeRaw('version', state.version)
    builder.writeRaw('lineage', state.lineage)
    builder.writeTree('resources', resources)

    return builder.build()
}

async function deserializeState(fs: Pick<BuildFsFragment, 'readData'>, state: SerializedState): Promise<TfState> {
    const builder = createAsyncObjectBuilder<TfState>()
    builder.addResult('serial', state.serial)
    builder.addResult('version', state.version)
    builder.addResult('lineage', state.lineage)
    builder.addResult('resources', readTree(state.resources, fs).then(Object.values))

    return builder.build()
}

async function readJson<T = any>(pointer: string, reader: Pick<BuildFsFragment, 'readData'>) {
    const data = await reader.readData(isPointer(pointer) ? getArtifactName(pointer) : pointer)

    return JSON.parse(Buffer.from(data).toString('utf-8')) as T
}

async function readTree(tree: Record<string, string>, reader: Pick<BuildFsFragment, 'readData'>) {
    return mapTree(tree, x => readJson(x, reader))
}

async function deserializeTemplate(reader: Pick<BuildFsFragment, 'readData'>, template: SerializedTemplate): Promise<TfJson> {
    const builder = createAsyncObjectBuilder<TfJson>()
    builder.addResult('provider', readJson(template.provider, reader))
    builder.addResult('terraform', readJson(template.terraform, reader))
    if (template.resource) {
        builder.addResult('resource', readTree(template.resource, reader).then(expandResources))
    }
    if (template.data) {
        builder.addResult('data', readTree(template.data, reader).then(expandResources))
    }
    if (template.locals) {
        builder.addResult('locals', readTree(template.locals, reader))
    }
    if (template.moved) {
        builder.addResult('moved', template.moved)
    }
    if (template['//']) {
        builder.addResult('//', readJson(template['//'], reader))
    }

    return builder.build()
}

export type HashedModuleBinding = Omit<ModuleBindingResult, 'id'> & {
    hash: string
}

export interface Snapshot {
    storeHash: string
    published?: Record<string, string>
    pointers?: Record<string, Record<string, string>>
    targets?: TargetsFile
    moduleManifest?: Record<ModuleBindingResult['id'], HashedModuleBinding>
    store?: ReadonlyBuildFs
    types?: TypesFileData
}

export function resolveSnapshot(snapshot: Snapshot) {
    if (snapshot.pointers) {
        for (const [k, v] of Object.entries(snapshot.pointers)) {
            for (const [k2, v2] of Object.entries(v)) {
                snapshot.pointers[k][k2] = toDataPointer(v2)
            }
        }
    }

    return snapshot
}

export const getSnapshotPath = (dir: string) => path.resolve(dir, '.synapse', 'snapshot.json')

async function loadSnapshotFromManifest(repo: DataRepository, fs: Fs & SyncFs, dir: string) {
    const manifest = await tryReadJson<Snapshot>(fs, getSnapshotPath(dir))
    if (!manifest) {
        return
    }

    try {
        const buildFs = await repo.getBuildFs(manifest.storeHash)

        return {
            ...resolveSnapshot(manifest),
            store: buildFs,
        }
    } catch (err) {
        throwIfNotFileNotFoundError(err)
    }

    const snapshotRepo = getDataRepository(fs, path.resolve(dir, '.synapse'))
    const buildFs = await snapshotRepo.getBuildFs(manifest.storeHash)
    await repo.copyFrom(snapshotRepo, buildFs, true)

    return {
        ...resolveSnapshot(manifest),
        store: await repo.getBuildFs(manifest.storeHash), //buildFs,
    }
}

const tarballSnapshotFile = '__bfs-snapshot__.json'
export function isSnapshotTarball(tarball: TarballFile[]) {
    return tarball[0]?.path === tarballSnapshotFile
}

function isCorrupted(expectedHash: string, data: Uint8Array) {    
    return expectedHash !== getHash(data)
}

export async function writeSnapshotFile(fs: Fs, dir: string, snapshot: Snapshot) {
    await fs.writeFile(
        path.resolve(dir, '.synapse', 'snapshot.json'), 
        JSON.stringify(snapshot)
    )
}

export async function dumpData(dir: string, index: BuildFsIndex, hash: string, pack?: boolean | 'both', previousHash?: string) {
    const snapshotRepo = getDataRepository(getFs(), path.resolve(dir, '.synapse'))
    const previous = previousHash ? await snapshotRepo.getBuildFs(previousHash) : undefined
    await snapshotRepo.copyFrom(getDataRepository(getFs()), { hash, index }, pack, previous)
}


export async function unpackSnapshotTarball(repo: DataRepository, tarball: TarballFile[], dest: string) {
    const snapshotFile = tarball.shift()!
    if (snapshotFile.path !== tarballSnapshotFile) {
        throw new Error(`Expected first file of the tarball to be the snapshot manifest, got: ${snapshotFile.path}`)
    }

    const snapshot: Snapshot = JSON.parse(decode(snapshotFile.contents, 'utf-8'))

    // Sanity check
    if (typeof snapshot.storeHash !== 'string') {
        throw new Error(`Unknown snapshot manifest format`)
    }

    const pkgRepo = getDataRepository(getFs(), path.resolve(dest, '.synapse'))
    for (const f of tarball) {
        if (isCorrupted(f.path, f.contents)) {
            throw new Error(`Corrupted data: ${f.path}`)
        }

        await repo.writeData(f.path, f.contents)
        await pkgRepo.writeData(f.path, f.contents)
    }

    const hasFsData = await repo.hasData(snapshot.storeHash)
    if (!hasFsData) {
        throw new Error(`Tarball missing fs index data: ${snapshot.storeHash}`)
    }

    const { index } = await repo.getBuildFs(snapshot.storeHash)
    await dump(repo, index, dest)
    await writeSnapshotFile(getFs(), dest, snapshot)

    return snapshot
}

// https://w3c.github.io/webappsec/specs/subresourceintegrity/

function getDefaultAliases(){
    const bt = getBuildTarget()
    if (!bt) {
        return {}
    }

    const { deploymentId } = bt
    const program = toProgramRef(bt)
    const defaultAliases = deploymentId ? { program, process: deploymentId } : { program }

    return defaultAliases as Record<string, string>
}

const roots = new Map<string, ReturnType<typeof createRootFs>>()
function getRootFs(primary: string, rootDir: string, workingDirectory?: string) {
    const key = `${rootDir}:${primary}:${workingDirectory ?? ''}`
    if (roots.has(key)) {
        return roots.get(key)!
    }

    const defaultAliases = getDefaultAliases()
    const f = createRootFs(getFs(), rootDir, primary, { 
        aliases: defaultAliases, 
        workingDirectory,
    })

    roots.set(key, f)

    return f
}

export async function shutdownRepos() {
    for (const [k, v] of Object.entries(repos)) {
        await v.flush()
        delete repos[k]
    }
}

export function getProgramFs(buildTarget?: Pick<BuildTarget, 'programId' | 'projectId' | 'branchName' | 'workingDirectory'>) {
    if (!buildTarget) {
        const buildDir = getBuildDir()
        const bt = getBuildTargetOrThrow()
        const programRef = toProgramRef(bt)

        return getRootFs(programRef, buildDir, bt.workingDirectory)
    }

    const buildDir = getBuildDir()
    const programRef = toProgramRef(buildTarget)

    return getRootFs(programRef, buildDir, buildTarget.workingDirectory)
}

export function getDeploymentFs(id?: string, programId?: string, projectId?: string, isTest?: boolean) {
    if (!id) {
        const { deploymentId } = getBuildTargetOrThrow()
        const buildDir = getBuildDir()
        const workingDirectory = getWorkingDir()
        if (!deploymentId) {
            throw new Error(`No deployment id found`)
        }
    
        if (isTest) {
            return getRootFs(`${deploymentId}_test`, buildDir, workingDirectory)
        }

        return getRootFs(deploymentId, buildDir, workingDirectory)
    }

    let branchName: string | undefined
    if (!programId) {
        const res = getProgramInfoFromDeployment(id)
        programId = res.programId
        branchName = res.branchName
    } else {
        branchName = getBuildTargetOrThrow().branchName
    }
    
    const rootDir = getBuildDir()
    const workingDirectory = getWorkingDir(programId, projectId, branchName)

    return getRootFs(id, rootDir, workingDirectory)
}

export async function getPreviousFs(id: string) {
    const commits = await listCommits(id, undefined, 1)
    const hash = commits[0]?.storeHash
    if (!hash) {
        return
    }

    return toFsFromHash(hash)
}

export function getPreviousProgramFs(bt = getBuildTargetOrThrow()) {
    return getPreviousFs(toProgramRef(bt))
}

export async function didFileMaybeChange(fileName: string, bt = getBuildTargetOrThrow()) {
    const ref = toProgramRef(bt)
    const commits = await listCommits(ref, undefined, 1)
    const hash = commits[0]?.storeHash
    if (!hash) {
        return true
    }

    const root = await getDataRepository().getRootBuildFs(ref)
    const currentFile = root.findFile(fileName)
    const previousIndex = await getDataRepository().getBuildFs(hash)
    const previousFile = previousIndex.index.files[fileName]

    return currentFile?.fileHash !== previousFile?.hash
}

export async function readResourceState(resource: string) {
    const { deploymentId } = getBuildTargetOrThrow()
    if (!deploymentId) {
        throw new Error(`No deployment id available to read resource: ${resource}`)
    }

    const deploymentFs = getDeploymentFs(deploymentId)
    const { state, deps } = JSON.parse(await deploymentFs.readFile('state.json', 'utf-8'))
    const hash = state[resource]
    if (!hash) {
        throw new Error(`No state found for resource: ${resource}`)
    }

    const storeHash = deps[resource]
    if (!storeHash) {
        throw new Error(`No metadata found for resource: ${resource}`)
    }

    const p = createPointer(hash, storeHash)
    const m = await deploymentFs.getMetadata(p)
    const d = JSON.parse(decode(await deploymentFs.readData(hash), 'utf-8'))
    if (!m.pointers) {
        return d
    }

    return applyPointers(d, m.pointers)
}

export async function loadSnapshot(location: string): Promise<Snapshot | undefined> {
    const fs = getFs()
    const repo = getDataRepository(fs)
    const snapshot = await loadSnapshotFromManifest(repo, fs, location)
    if (snapshot) {
        return snapshot
    }

    const res = await resolveProgramBuildTarget(location)
    if (!res) {
        return
    }

    const snapshotRepo = getRepository(fs, res.buildDir)
    const programStore = snapshotRepo.getProgramStore(res)
    const fullStore = await programStore.getPackageStore()
    const deployStore = res.deploymentId ? await snapshotRepo.getBuildFsIndex(res.deploymentId) : undefined
    const programFs = getProgramFs(res)
    const deploymentFs = res.deploymentId ? getDeploymentFs(res.deploymentId) : undefined

    const merged = deployStore 
        ? { index: mergeBuilds([fullStore.index, deployStore]), hash: 'unknown' }
        : fullStore

    const [targets, moduleMappings, published, pointers, types] = await Promise.all([
        getTargets(programFs),
        getModuleMappings(programFs),
        deploymentFs ? getPublished(deploymentFs) : undefined,
        readPointersFile(programFs),
        getTypesFile(programFs),
    ])

    const moduleManifest = moduleMappings ? await mapModuleManifest(merged.index, programFs, moduleMappings) : undefined

    return {
        published,
        targets,
        store: merged,
        storeHash: merged.hash,
        moduleManifest,
        pointers,
        types,
    }
}

async function mapModuleManifest(fsIndex: BuildFsIndex, programFs: Pick<Fs, 'readFile'>, moduleMappings: NonNullable<Awaited<ReturnType<typeof getModuleMappings>>>) {
    return Object.fromEntries(
        await Promise.all(
            Object.entries(moduleMappings).map(([k, v]) => resolveBindingResult(fsIndex, programFs, v).then(x => [k, x] as const))
        )
    )
}

export async function tryLoadSnapshot(location: string) {
    const fs = getFs()
    const repo = getDataRepository(fs)

    return await loadSnapshotFromManifest(repo, fs, location)
}

export async function createSnapshot(fsIndex: BuildFsIndex, programId: string, deploymentId?: string) {
    const programFs = getProgramFs({
        ...getBuildTargetOrThrow(),
        programId,
    })
    const deploymentFs = deploymentId ? getDeploymentFs(deploymentId) : undefined
    const published = deploymentFs ? await getPublished(deploymentFs) : undefined
    const moduleMappings = await getModuleMappings(programFs)
    const committed = await getRepo(getFs(), getBuildDir()).saveIndex(fsIndex)
    const moduleManifest = moduleMappings ? await mapModuleManifest(fsIndex, programFs, moduleMappings) : undefined

    const pointersFile = await readPointersFile(programFs)
    const pointers: Record<string, Record<string, string>> = {}
    for (const [k, v] of Object.entries(pointersFile ?? {})) {
        pointers[k] = v
        for (const [k2, v2] of Object.entries(v)) {
            pointers[k][k2] = isDataPointer(v2) ? toAbsolute(v2) : v2
        }
    }

    const snapshot = {
        published,
        storeHash: committed.hash,
        targets: await getTargets(programFs),
        pointers,
        moduleManifest,
        types: await getTypesFile(programFs)
    } satisfies Snapshot

    return { snapshot, committed }
}

export async function linkFs(vfs: BuildFsIndex & { id?: string }, dest: string, clean = false) {
    await dump(getDataRepository(), vfs, dest, { clean, writeIndex: true, link: true })
}

export async function copyFs(vfs: BuildFsIndex & { id?: string }, dest: string, clean = false, writeIndex = true) {
    await dump(getDataRepository(), vfs, dest, { clean, writeIndex, link: false })
}

export async function printBlockInfo(hash: string) {
    const repo = getRepository(getFs(), getBuildDir())
    await repo.printBlockInfo(hash)
}


async function syncHeads(repo: DataRepository, remote: RemoteArtifactRepository, localHead?: Head, remoteHead?: Head) {
    if (remoteHead?.storeHash === localHead?.storeHash) {
        if (localHead) {
            getLogger().debug(`Remote is the same as local, skipping sync`, localHead.id)
        }
        return
    }

    const isLocalNewer = !remoteHead?.timestamp || (localHead && (new Date(remoteHead.timestamp).getTime() < new Date(localHead.timestamp).getTime()))
    if (isLocalNewer && localHead) {
        getLogger().debug(`Pushing local changes to remote`, localHead.id)
        await remote.push(localHead.storeHash)
        if (localHead.programHash) {
            await remote.push(localHead.programHash)
        }
        await remote.putHead(localHead)
    } else if (remoteHead) {
        getLogger().debug(`Pulling remote changes`, remoteHead.id)
        await remote.pull(remoteHead.storeHash)
        if (remoteHead.programHash) {
            await remote.pull(remoteHead.programHash)
        }
        await repo.putHead(remoteHead)
    }
}

export async function syncRemote(projectId: string, deploymentId: string) {
    if (isRemoteDisabled()) {
        return
    }

    const repo = getDataRepository()
    const remote = createRemoteArtifactRepo(repo, projectId)

    const remoteProcessHead = await remote.getHead(deploymentId)
    const localProcessHead = await repo.commitHead(deploymentId)

    await syncHeads(repo, remote, localProcessHead, remoteProcessHead)
}

/** @deprecated */
export async function createArtifactFs(
    fs: Fs & SyncFs,
    buildTarget: BuildTarget,
) {
    const repo = getRepo(fs, buildTarget.buildDir)

    const getCurrentProgramStore = memoize(() => repo.getProgramStore(buildTarget))
    const getCurrentProcessStore = memoize(async () => {
        if (!buildTarget.deploymentId) {
            throw new Error(`No deployment exists for the current build target`)
        }

        return getDeploymentStore(buildTarget.deploymentId)
    })

    // XXX: needed for watch mode
    async function clearCurrentProgramStore() {
        await repo.flush()
        getCurrentProgramStore.clear()
    }


   //  const remote = createRemoteArtifactRepo(backendClient, repo.root, buildTarget.projectId)
    async function saveSnapshot(fsIndex: BuildFsIndex, programId: string, deploymentId?: string) {
        const { snapshot, committed } = await createSnapshot(fsIndex, programId, deploymentId)
        const serialized = await repo.root.serializeBuildFs(committed)

        const arr = Object.entries(serialized)
        arr.unshift([
            '__bfs-snapshot__.json',
            Buffer.from(JSON.stringify(snapshot))
        ])

        return arr
    }

    async function readArtifact(hash: string): Promise<Uint8Array> {
        if (isPointer(hash)) {
            hash = getArtifactName(hash)
        }

        return repo.root.readData(hash)
    }

    async function flush() {
        //await repo.flush()
    }


    async function commit(state: TfState, programFsHash?: string, isTest?: boolean) {
        const deployStore = await getCurrentProcessStore()
        await deployStore.commitState(state)
        const programStore = await getCurrentProgramStore().getFullStore()
        await repo.commit(buildTarget.deploymentId!, programFsHash ?? programStore.hash, !!programFsHash, isTest)
    }

    async function getCurrentProgramFsIndex() {
        return await getCurrentProgramStore().getFullStore()
    }

    async function resetManifest(deploymentId: string) {
        await repo.deleteHead(deploymentId)
    }

    async function downloadArtifacts(hashes: string[]) {

    }

    // `filePath` is mutually exclusive with `extname`
    async function resolveArtifact(pointer: string, opt?: ResolveArtifactOpts): Promise<string> {
        return repo.root.resolveArtifact(pointer, opt)
    }

    async function copyFs(vfs: BuildFsIndex, dest: string, writeIndex?: boolean) {
        await dump(repo.root, vfs, dest, { link: false, writeIndex, clean: true })
    }

    async function getBuildFs(hash: string) {
        const { index } = await repo.root.getBuildFs(hash)

        return createBuildFsFragment(repo.root, index)
    }

    function getProgramFs2(programHash?: string): ReturnType<typeof getRootFs>
    function getProgramFs2(programHash: string): Promise<BuildFsFragment>
    function getProgramFs2(programHash?: string) {
        if (!programHash) {
            return getProgramFs(buildTarget)
        }

        return getBuildFs(programHash).then(r => r.root as BuildFsFragment)
    }

    return {
        commit,
        readArtifact,
        resolveArtifact,

        dumpFs,
        linkFs,
        copyFs,

        getCurrentProgramFsIndex,

        maybeRestoreTemplate,

        listCommits,

        flush,
        resetManifest,

        createSnapshot,
        loadSnapshot,
        saveSnapshot,

        getRootFs,
        createStore: repo.createStore,
        getCurrentProgramStore,
        getCurrentProcessStore,
        getProgramFs: getProgramFs2,
        getRootBuildFs: repo.getRootBuildFs,
        getBuildFsIndex: (id: string) => repo.getBuildFsIndex(id),

        getOverlayedFs,

        repo: repo.root,

        downloadArtifacts,

        clearCurrentProgramStore,
    }
}

export const getArtifactFs = memoize(() => createArtifactFs(getFs(), getBuildTargetOrThrow()))

export async function dumpFs(id?: string, dest = path.resolve('.vfs-dump'), repo = getDataRepository()) {
    const opt: DumpFsOptions = { clean: true, prettyPrint: true, link: false, writeIndex: true }

    // It's _probably_ a hash
    if (id?.length === 64) {
        const vfs = await repo.getBuildFs(id)
        await dump(getDataRepository(), { id: vfs.hash, ...vfs.index }, dest, opt)

        return
    }

    function resolveId() {
        switch (id) {
            case 'program':
                return toProgramRef(getBuildTargetOrThrow())
            case 'deployment':
                return getBuildTargetOrThrow().deploymentId!
            case 'test':
                return `${getBuildTargetOrThrow().deploymentId!}_test`
            default:
                return id ?? toProgramRef(getBuildTargetOrThrow())
        }
    }

    const resolved = resolveId()
    const head = await repo.getHead(resolved)
    if (!head) {
        throw new Error(`No build fs found: ${resolved}`)
    }
    const vfs = await repo.getBuildFs(head.storeHash)
    await dump(getDataRepository(), { id: resolved, ...vfs.index }, dest, opt)
}

// Only used for publishing
export async function getOverlayedFs(workingDirectory: string, index: BuildFsIndex) {
    const readOnlyFs = createBuildFsFragment(getDataRepository(), index).root

    return toFs(workingDirectory, readOnlyFs, getFs())
}

export async function commitProgram(repo = getDataRepository(), bt = getBuildTargetOrThrow()) {
    await runTask('commit', `program ${bt.programId}`, () => repo.commitHead(toProgramRef(bt)), 1)
}

export type ProcessStore = ReturnType<typeof getDeploymentStore>
export function getDeploymentStore(deploymentId: string, repo = getDataRepository()) {
    const fs = getDeploymentFs()

    async function getResourceStore(resource: string): Promise<BuildFsFragment> {
        await init()

        const vfs = await repo.getRootBuildFs(deploymentId)
        const key = `/deploy/resource-${resource}`

        return vfs.open(key, { readOnly: true })
    }

    async function createResourceStore(resource: string, dependencies: string[]): Promise<BuildFsFragment> {
        await init()

        const vfs = await repo.getRootBuildFs(deploymentId)
        const key = `/deploy/resource-${resource}`

        return vfs.open(key, { clearPrevious: true })
    }

    const init = memoize(_init)

    async function _init() {
        const moved = await getMoved()
        if (moved) {
            await applyMoved(moved)
        }
    }

    async function applyMoved(moved: { from: string; to: string }[]): Promise<void> {
        const stores = new Set((await fs.listStores('[#deploy]')).map(x => x.name))

        const csResources = moved.filter(r => r.from.startsWith('synapse_resource.'))
        const mapped = Object.fromEntries(csResources.map(r => {
            const from = r.from.slice('synapse_resource.'.length)
            const to = r.to.slice('synapse_resource.'.length)

            return [from, to]
        }))

        const getStoreName = (resource: string) => `[#/deploy/resource-${resource}]`

        const writer = getStateWriter()
        for (const [from, to] of Object.entries(mapped)) {
            if (stores.has(getStoreName(from))) {
                await fs.rename(getStoreName(from), getStoreName(to))
                writer.rename(from, to)
            }
        }
    }

    async function commitState(state: TfState) {
        await runTask('artifacts', 'state', async () => {
            const csResources = state.resources.filter(r => r.type === 'synapse_resource')

            const fragment = await repo.getRootBuildFs(deploymentId)
            const stores = fragment.listStores()
            const published: Record<string, string> = {}

            const rStores = new Set(Array.from(csResources).map(n => `/deploy/resource-${n.name}`))
            for (const [k, v] of Object.entries(stores)) {
                if (k.startsWith(`/deploy/resource-`) && !rStores.has(k)) {
                    fragment.deleteStore(k)
                }
            }

            for (const [k, v] of Object.entries(fragment.listFiles())) {
                if (rStores.has(v.store.name)) {
                    published[k] = `${v.store.hash}:${v.hash}`
                }
            }

            await fs.writeFile('[#deploy]published.json', JSON.stringify(published))
            await writeState(fs, state)
        }, 10)
    }

    const getState = () => {
        try {
            const text = fs.readFileSync('state.json', 'utf-8')

            return JSON.parse(text) as {
                state: Record<string, string>
                deps: Record<string, string>
            }
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
        }
    }

    function isDeployed() {
        return getState() !== undefined
    }

    interface StateFile {
        state: Record<string, string>
        deps: Record<string, string>
    }

    function createStateWriter() {
        let state: StateFile | undefined = undefined

        function loadState() {
            return state ??= getState() ?? { state: {}, deps: {} }
        }

        function saveState(data: StateFile) {
            const sorted: StateFile = {
                state: sortRecord(data.state),
                deps: sortRecord(data.deps),
            }

            fs.writeFileSync('[#deploy]state.json', JSON.stringify(sorted), {
                metadata: { dependencies: Object.entries(data.state).map(([k, v]) => `${data.deps[k]}:${v}`) }
            })
        }

        function update(resource: string, pointer: DataPointer) {
            const s = loadState()
            const { hash, storeHash } = pointer.resolve()
            s.state[resource] = hash
            s.deps[resource] = storeHash

            saveState(s)
        }

        function remove(resource: string) {
            const s = loadState()
            delete s.state[resource]
            delete s.deps[resource]

            saveState(s)
        }

        function rename(from: string, to: string) {
            const s = loadState()
            const x = s.state[from]
            const y = s.deps[from]
            delete s.state[from]
            delete s.deps[from]
            s.state[to] = x
            s.deps[to] = y

            saveState(s)
        }

        function listResources() {
            return Object.keys(loadState().state)
        }

        return { update, remove, rename, listResources }
    }

    const getStateWriter = memoize(createStateWriter)

    function saveResponse(resource: string, inputDeps: string[], resp: any, opType: 'data' | 'read' | 'create' | 'update' | 'delete' | 'import') {
        const [state, pointers, summary] = extractPointers(resp)
        if (opType === 'data') {
            return { state, pointers }
        }

        if (opType !== 'delete') {
            const key = `/deploy/resource-${resource}`
            const dependencies = Object.entries(summary ?? {}).map(([k, v]) => v.map(h => `${k}:${h}`)).flat()
            const pointer = fs.writeDataSync(`[#${key}]`, Buffer.from(JSON.stringify(state), 'utf-8'), {
                metadata: {
                    pointers,
                    dependencies: Array.from(new Set([...dependencies, ...inputDeps])),
                }
            })
            getStateWriter().update(resource, pointer)
        } else {
            getStateWriter().remove(resource)
        }
    
        return { state, pointers }
    }

    return {
        getState,
        isDeployed,
        commitState,
        getResourceStore,
        createResourceStore,
        saveResponse,
    }
}

export async function listCommits(id = getTargetDeploymentIdOrThrow(), repo = getDataRepository(), max = 25) {
    const commits: Head[] = []
    const start = await repo.getHead(id)
    if (start && start.commitHash) {
        commits.push(start)
    }

    let head = start
    while (commits.length < max) {
        if (head?.previousCommit) {
            const data = await repo.readData(head.previousCommit).catch(throwIfNotFileNotFoundError)
            if (!data) break

            head = JSON.parse(Buffer.from(data).toString('utf-8'))
            commits.push(head!)
        } else {
            break
        }
    }

    return commits
}


export async function putState(state: TfState, procFs = getDeploymentFs()) {
    await writeState(procFs, state)
}

export async function saveMoved(moved: { from: string; to: string }[], template?: SerializedTemplate | TfJson) {
    const fs = getProgramFs()
    template ??= await fs.readJson('[#synth]template.json')
    await fs.writeJson('[#synth]template.json', { ...template, moved })
}

export async function getPreviousDeploymentProgramHash() {
    const repo = getDataRepository(getFs())
    const deploymentId = getBuildTargetOrThrow().deploymentId
    if (!deploymentId) {
        throw new Error(`No deployment id found`)
    }

    const h = await repo.getHead(deploymentId)
    if (!h) {
        return
    }

    if (h.commitHash && h.programHash) {
        return h.programHash
    }

    const c = h.previousCommit
    if (!c) {
        return
    }

    const previousCommit = await readJsonRaw<Head>(repo, c)
    const programHash = previousCommit.programHash
    if (!programHash) {
        throw new Error(`No program found for deployment commit: ${c}`)
    }

    return programHash
}

export async function getMoved(programHash?: string): Promise<{ from: string; to: string }[] | undefined> {
    const fs = !programHash ? getProgramFs() : await getFsFromHash(programHash)
    const template: SerializedTemplate | TfJson | undefined = await tryReadJson(fs, '[#synth]template.json')

    return template?.moved
}

export async function getProgramHash(bt = getBuildTargetOrThrow(), repo = getDataRepository()) {
    const head = await repo.getHead(toProgramRef(bt))

    return head?.storeHash
}

export async function maybeRestoreTemplate(head?: Head) {
    const repo = getDataRepository(getFs())
    if (head) {
        if (!head.programHash) {
            throw new Error(`No program to restore from`)
        }

        const { index } = await repo.getBuildFs(head.programHash)
        const bfs = createBuildFsFragment(repo, index)
        
        return getTemplate(bfs.root)
    }

    const programHash = await getPreviousDeploymentProgramHash()
    if (!programHash) {
        return
    }
    
    const fs = await getFsFromHash(programHash, repo)

    return getTemplate(fs)
}

export async function getFsFromHash(hash: string, repo = getDataRepository()) {
    const { index } = await repo.getBuildFs(hash)
    const bfs = createBuildFsFragment(repo, index)

    return bfs.root
}

interface FilePart { 
    readonly hash: string 
    readonly chunk: Buffer 
}

async function* createChunkStream(data: Uint8Array | Readable): AsyncIterable<FilePart> {
    let cursor = 0
    const buffer = Buffer.alloc(chunkSize)
    const inputStream = data instanceof Uint8Array ? Duplex.from(data) : data

    for await (const blob of inputStream) {
        for (let i = 0; i < blob.length; i += chunkSize) {
            const chunk: Buffer = blob.subarray(i, Math.min(i + chunkSize, blob.length))
            const totalSize = cursor + chunk.length
            if (totalSize < chunkSize) {
                buffer.set(chunk, cursor)
                cursor += chunk.length
            } else {
                buffer.set(chunk.subarray(0, chunkSize - cursor), cursor)

                yield {
                    hash: getHash(buffer),
                    chunk: buffer,
                }

                cursor = 0
            }
        }
    }

    if (cursor > 0) {
        const chunk = buffer.subarray(0, cursor)
        const hash = getHash(chunk)
        
        yield { hash, chunk }
    }
}

// function* chunk<T extends any | null>(arr: [string, T][], size: number) {
//     let currentSize = 0
//     let acc: typeof arr = []

//     for (let i = 0; i < arr.length; i++) {
//         const itemSize = arr[i][1] ? arr[i][1]!.content.length : 0
//         if (currentSize + itemSize >= size) {
//             if (acc.length > 0) {
//                 yield acc
//             }

//             acc = []
//             currentSize = 0
//         }

//         acc.push(arr[i])
//         currentSize += itemSize
//     }

//     if (acc.length > 0) {
//         yield acc
//     }
// }
