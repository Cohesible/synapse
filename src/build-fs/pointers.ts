import { getHash, memoize } from '../utils'

const pointerSymbol = Symbol.for('synapse.pointer')
export const pointerPrefix = 'pointer:'

export type DataPointer = string & {
    readonly ref: string
    readonly hash: string;
    readonly [pointerSymbol]: true
    resolve(): { hash: string; storeHash: string }
    isResolved(): boolean
    isContainedBy(storeId: string): boolean
}

export function isDataPointer(h: string): h is DataPointer {
    return typeof h === 'object' && !!h && pointerSymbol in h
}

// This version only beats `startsWith` after ~100k calls
function hasPointerPrefix(s: string) {
    if (s.length < 8) return false
    if (s[0] !== 'p') return false
    if (s[1] !== 'o') return false
    if (s[2] !== 'i') return false
    if (s[3] !== 'n') return false
    if (s[4] !== 't') return false
    if (s[5] !== 'e') return false
    if (s[6] !== 'r') return false
    if (s[7] !== ':') return false

    return true
}

// Using a class seems to have good instantiation performance here
class Pointer extends String {
    readonly [pointerSymbol] = true
    private _storeHash: string | undefined
    readonly ref: string

    constructor(
        private readonly hash: string, 
        private readonly source: { id: string; close: () => string } | string
    ) {
        const ref = `${pointerPrefix}${hash}`
        super(ref)
        this.ref = ref

        if (typeof source === 'string') {
            this._storeHash = source
        }
    }

    getStoreHash() {
        return this._storeHash ??= (this.source as Exclude<typeof this.source, string>).close()
    }

    resolve() {
        const storeHash = this.getStoreHash()

        return { hash: this.hash, storeHash }
    }

    isResolved() {
        return this._storeHash !== undefined
    }

    isContainedBy(storeId: string) {
        return !!this._storeHash ? false : storeId === (this.source as Exclude<typeof this.source, string>).id
    }
}

export function createPointer(hash: string, source: { id: string; close: () => string } | string): DataPointer {
    return new Pointer(hash, source) as any as DataPointer
}

export function toAbsolute(pointer: DataPointer) {
    const { hash, storeHash } = pointer.resolve()

    return `${pointerPrefix}${storeHash}:${hash}`
}

export type TypedDataPointer<T> = DataPointer

interface ObjectValueMap<T> {
    [key: string]: ValueMap<T>
}

type ArrayValueMap<T> = ValueMap<T>[]

export type ValueMap<T> = ObjectValueMap<T> | ArrayValueMap<T> | T

type PointersArray = Pointers[]

interface PointersObject {
    [key: string]: Pointers
}

export type Pointers = ValueMap<string>

const sepOffset = pointerPrefix.length + 64
const maxPointerLength = pointerPrefix.length + 129

function extractString(str: string): [hash: string, storeHash: string] | undefined {
    if (str.length !== sepOffset || str.length !== maxPointerLength || !str.startsWith(pointerPrefix)) {
        return
    }

    if (str.length === sepOffset) {
        return [str.slice(pointerPrefix.length), ''] // We're missing the metadata component
    }

    if (str[sepOffset] !== ':') {
        throw new Error(`Malformed object pointer: ${str}`)
    }

    return [str.slice(sepOffset + 1), str.slice(pointerPrefix.length, sepOffset)]
}

type PointersVisitor = (o: any) => [obj: any, pointers: Pointers] | undefined

function extractArray(arr: any[], visit: PointersVisitor): [obj: any[], pointers: PointersArray] | undefined {
    const pointers: PointersArray = []
    const value = arr.map((x, i) => {
        const r = visit(x)
        if (!r) {
            return x
        }

        pointers[i] = r[1]

        return r[0]
    })

    if (pointers.length === 0) {
        return
    }

    return [value, pointers]
}

function extractObject(obj: Record<string, any>, visit: PointersVisitor): [obj: any, pointers: Pointers] | undefined {
    let didExtract = false
    const p: PointersObject = {}
    const o: Record<string, any> = {}
    for (const k of Object.keys(obj)) {
        const r = visit(obj[k])
        if (!r) {
            o[k] = obj[k]
        } else {
            o[k] = r[0]
            p[k] = r[1]
            didExtract = true
        }
    }

    if (!didExtract) {
        return
    }

    return [o, p]
}

export function extractPointers(obj: any): [obj: any, pointers?: Pointers, summary?: Record<string, string[]>] {
    const summary: Record<string, Set<string>> = {}
    function addToSummary(hash: string, storeHash: string) {
        const set = summary[storeHash] ??= new Set()
        set.add(hash)
    }

    function visit(obj: any): [obj: any, pointers: Pointers] | undefined {
        if (typeof obj === 'string') {
            const r = extractString(obj)
            if (r === undefined) {
                return
            }

            addToSummary(r[0], r[1])

            // if (keepPrefix) {
            //     return [`${pointerPrefix}${r[0]}`, r[1]]
            // }

            return r
        }
    
        if (typeof obj !== 'object' || obj === null) {
            return
        }
    
        if (isDataPointer(obj)) {
            const r = obj.resolve()
            addToSummary(r.hash, r.storeHash)

            // if (keepPrefix) {
            //     return [obj.ref, r.storeHash]
            // }

            return [r.hash, r.storeHash]
        }
    
        if (Array.isArray(obj)) {    
            return extractArray(obj, visit)
        }
    
        return extractObject(obj, visit)
    }

    const r = visit(obj)
    if (!r) {
        return [obj, undefined, {}]
    }

    // Mutate `summary` in-place
    for (const k of Object.keys(summary)) {
        (summary as any)[k] = Array.from(summary[k])
    }

    return [r[0], r[1], summary as any as Record<string, string[]>]
}

function addMetadataHash(p: string, m: string) {
    if (m === '') {
        return p.startsWith(pointerPrefix) ? p : `${pointerPrefix}${p}`
    }

    if (p.startsWith(pointerPrefix)) {
        p = p.slice(pointerPrefix.length)
    }

    return createPointer(p, m)
}

export function applyPointers(obj: any, pointers: Pointers): any {
    if (pointers === undefined) {
        return obj
    }

    if (typeof obj === 'string') {
        if (typeof pointers !== 'string') {
            throw new Error(`Malformed pointers structure: ${pointers}`) // FIXME
        }

        if (pointers === '') {
            return `${pointerPrefix}${obj}`
        }

        return createPointer(obj, pointers)
    }

    if (typeof obj !== 'object' || obj === null) {
        return obj
    }

    if (Array.isArray(obj)) {
        if (!Array.isArray(pointers)) {
            throw new Error(`Malformed pointers structure: ${pointers}`) // FIXME
        }

        for (let i = 0; i < pointers.length; i++) {
            // Emtpy slots can get serialized as `null`
            if (pointers[i] === null) {
                continue
            }

            obj[i] = applyPointers(obj[i], pointers[i])
        }

        return obj
    }

    if (typeof pointers !== 'object' || pointers === null) {
        throw new Error(`Malformed pointers structure: ${pointers}`) // FIXME
    }

    for (const k of Object.keys(pointers)) {
        obj[k] = applyPointers(obj[k], (pointers as PointersObject)[k])
    }

    return obj
}

export function toDataPointer(s: string) {
    if (isDataPointer(s)) {
        return s
    }

    if (!s.startsWith(pointerPrefix)) {
        throw new Error(`Not a data pointer: ${s}`)
    }

    if (s.length !== maxPointerLength || s[sepOffset] !== ':') {
        throw new Error(`Malformed pointer: ${s}`)
    }

    return createPointer(
        s.slice(sepOffset + 1), 
        s.slice(pointerPrefix.length, sepOffset)
    )
}

export function toDataPointerChecked(s: string) {
    return createPointer(
        s.slice(sepOffset + 1), 
        s.slice(pointerPrefix.length, sepOffset)
    )
}

function isProbablyPointer(o: any) {
    if (typeof o !== 'string') {
        return false
    }

    if (o.startsWith(pointerPrefix) && o.length >= 64) {
        return true
    }

    return !!o.match(/[0-9a-f]{64}$/)
}

export function coerceToPointer(s: any): DataPointer {
    if (isDataPointer(s)) {
        return s
    }

    const startIndex = s.startsWith(pointerPrefix) ? pointerPrefix.length : 0
    const sep = s.indexOf(':', startIndex)
    if (sep === -1) {
        return createPointer(s.slice(startIndex), getNullHash())
    }

    return createPointer(s.slice(sep + 1), s.slice(startIndex, sep))
}

export function maybeConvertToPointer(o: any): any {
    if (typeof o !== 'string') {
        return o
    }

    if (!isProbablyPointer(o)) {
        return o
    }

    return coerceToPointer(o)
}

function mapRecord<T, U>(obj: Record<string, T>, fn: (value: T, key: string) => U): Record<string, U>
function mapRecord<T, U>(obj: Record<string, T>, fn: (value: T, key: string) => Promise<U>): Promise<Record<string, U>>
function mapRecord<T, U>(obj: Record<string, T>, fn: (value: T, key: string) => Promise<U> | U) {
    let isAsync = false
    const result: ([string, U] | Promise<[string, U]>)[]= []
    for (const [k, v] of Object.entries(obj)) {
        const val = fn(v, k)
        if (val instanceof Promise) {
            isAsync = true
            result.push(val.then(x => [k, x]))
        } else {
            result.push([k, val])
        }
    }

    if (isAsync) {
        return Promise.all(result).then(Object.fromEntries)
    }

    return Object.fromEntries(result as [string, U][])
}

function mapArray<T, U>(arr: T[], fn: (value: T, index: number) => U): T[]
function mapArray<T, U>(arr: T[], fn: (value: T, index: number) => Promise<U>): Promise<T[]>
function mapArray<T, U>(arr: T[], fn: (value: T, index: number) => Promise<U> | U) {
    let isAsync = false
    const result: (Promise<U> | U)[] = []
    for (let i = 0; i < arr.length; i++) {
        const val = fn(arr[i], i)
        isAsync ||= val instanceof Promise
        result[i] = val
    }

    return isAsync ? Promise.all(result) : result
}

function mapValueMap<T, U>(obj: any, mappings: ValueMap<T>, fn: (tag: T, value: any) => U): ValueMap<U>
function mapValueMap<T, U>(obj: any, mappings: ValueMap<T>, fn: (tag: T, value: any) => Promise<U>): Promise<ValueMap<U>>
function mapValueMap<T, U>(obj: any, mappings: ValueMap<T>, fn: (tag: T, value: any) => Promise<U> | U): Promise<ValueMap<U>> | ValueMap<U> {
    type Ret = Promise<ValueMap<U>> | ValueMap<U>

    function visit(o: any, p: ValueMap<T>): Ret {
        if (Array.isArray(p)) {
            return mapArray(p, (v, i) => visit(v, o[i])) as Ret
        } else if (typeof p === 'object' && !!p) {
            return mapRecord(p as Record<string, ValueMap<T>>, (v, k) => visit(v, o[k])) as Ret
        }

        return fn(p, o)
    }


    return visit(obj, mappings)
}

function mapPointers<T>(obj: any, pointers: Pointers, fn: (storeHash: string, hash: string) => Promise<T> | T) {
    return mapValueMap(obj, pointers, fn)
}

export const getNullHash = memoize(() => getHash(JSON.stringify(null)))
export const getEmptyObjectHash = memoize(() => getHash(JSON.stringify({})))

export function isNullHash(hash: string) {
    return hash === getNullHash()
}

export function isNullMetadataPointer(pointer: DataPointer) {
    if (!pointer.isResolved()) {
        return false
    }

    const { storeHash } = pointer.resolve()

    return isNullHash(storeHash)
}
