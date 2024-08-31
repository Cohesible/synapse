//# moduleId = synapse:srl/storage

import { HttpHandler } from 'synapse:http'
import { HostedZone } from 'synapse:srl/net'

// FIXME: this only works if the declaration files are transformed to use the same
// ambient module specifier. A reference directive then needs to be added to the importing file

// import { Bucket } from './bucket'
// export * from './bucket'

//# resource = true
export declare class Queue<T = unknown> {
    send(val: T): Promise<void> 
    /** @internal */
    consume<U>(fn: (val: T) => U | Promise<U>): Promise<U> 

    //# resource = true
    on(eventType: 'message', cb: (message: T) => Promise<void> | void): unknown
}

//# resource = true
export declare class Table<K = unknown, V = unknown> {
    constructor()
    get(key: K): Promise<V | undefined>
    /** @internal */
    getBatch(keys: K[]): Promise<{ key: K, value: V }[]> 
    set(key: K, val: V): Promise<void>
    /** @internal */
    setBatch(items: { key: K, value: V }[]): Promise<void>
    delete(key: K): Promise<void>
    /** @internal */
    values(): AsyncIterable<V[]>
}

//# resource = true
/** @internal */
export declare class Secret<T = unknown> {
    constructor(envVar?: string) 
    get(): Promise<T> 
}

// For CDN
/** @internal */
export interface OriginOptions {
    origin: string
    targetPath: string
    originPath?: string
    allowedMethods: string[]
}

/** @internal */
export interface CDNProps {
    readonly bucket: Bucket
    readonly indexKey?: string
    readonly domain?: HostedZone
    readonly additionalRoutes?: OriginOptions[]
    readonly middleware?: HttpHandler<any, any, Response>
    readonly compress?: boolean
}

//# resource = true
/** @internal */
export declare class CDN {
    readonly url: string
    constructor(store: {
        readonly bucket: Bucket
        readonly indexKey?: string
        readonly domain?: HostedZone
        readonly additionalRoutes?: OriginOptions[]
        readonly middleware?: HttpHandler<any, any, Response>
        readonly compress?: boolean
    })

    //# resource = true
    addOrigin(origin: OriginOptions): void
}

//# resource = true
/** @internal */
export declare class StaticDeployment {
    constructor(store: Bucket, source?: string)
    add(file: string): string
}

//# resource = true
export declare class Counter {
    constructor(init?: number)
    get(): Promise<number>
    set(amount: number): Promise<number>
    inc(amount?: number): Promise<number>
}

//# resource = true
/** @internal */
export declare class KeyedCounter {
    constructor(init?: number)
    get(key: string): Promise<number>
    set(key: string, amount: number): Promise<number>
    inc(key: string, amount?: number): Promise<number>
    dec(key: string, amount?: number): Promise<number>
}

//# resource = true
/** @internal */
export declare class TTLCache<K extends string = string, V = any> {
    /** TTL is in seconds */
    constructor(ttl?: number)
    get(key: K): Promise<V | undefined>
    put(key: K, value: V): Promise<void>
    keys(): Promise<K[]>
    delete(key: K): Promise<void>
}

import { DataPointer } from 'synapse:core'

export type Encoding = 'utf-8' | 'base64' | 'base64url' | 'hex'

//# resource = true
export declare class Bucket {
    get(key: string): Promise<Blob | undefined>
    get(key: string, encoding: Encoding): Promise<string | undefined>
    put(key: string, blob: string | Uint8Array | AsyncIterable<Uint8Array>): Promise<void>
    list(prefix?: string): Promise<string[]>
    /** @internal */
    stat(key: string): Promise<{ size: number; contentType?: string } | undefined>

    // Ideally we'd return true/false here depending on whether
    // or not the key existed prior to deletion. But not every
    // API makes this easy (like AWS S3)
    delete(key: string): Promise<void>

    //# resource = true
    /** @internal */
    addBlob(sourceLocation: string | DataPointer, key?: string, contentType?: string): string
}

//# resource = true
/** @internal */
export declare class Stream<T = unknown> implements AsyncIterable<T> {
    put(...values: T[]): Promise<void>
    [Symbol.asyncIterator](): AsyncIterator<T>
}
