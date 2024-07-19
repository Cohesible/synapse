import { addBrowserImplementation } from 'synapse:core'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface UseServerContext {
    readonly cache: Map<any, any>
    readonly handlers: Map<string, any>
    onComplete: typeof onComplete
}

const storage = new AsyncLocalStorage<UseServerContext>()
function getStore() {
    const store = storage.getStore()
    if (!store) {
        throw new Error('Server-side rendering with `useServer` must use `runWithContext`')
    }

    return store
}

function onComplete(key: any[], value?: any, error?: Error) {
    getStore().onComplete(key, value, error)
    if (error) {
        throw error
    }
    return value
}

addBrowserImplementation(onComplete, (key, value, error) => {
    if (error) {
        throw error
    }
    return value
})

function getCache() {
    return getStore().cache
}

addBrowserImplementation(getCache, () => {
    return (globalThis as any).USE_SERVER_CACHE ??= new Map<any, any>()
})

function getHandler(fnId: string) {
    return getStore().handlers.get(fnId)
}

addBrowserImplementation(getHandler, () => {})

// Server-only!
export function runWithContext<T>(context: UseServerContext, fn: () => T): T {
    return storage.run(context, fn)
}

// React does some bizarre message passing by throwing unresolved promises to `Suspense` components
function usePromise<T>(val: Promise<T> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: T; reason?: unknown }): T {
    switch (val.status) {
        case 'pending':
            throw val
        case 'fulfilled':
            return val.value as T
        case 'rejected':
            throw val.reason
        default:
            val.status = 'pending'

            throw val.then(
                value => {
                    val.status = 'fulfilled'
                    val.value = value
                }, 
                reason => {
                    val.status = 'rejected'
                    val.reason = reason
                },
            )
    }
}

function getCachedItem<U>(key: any[], c: Map<any, any>, index = 0): U | undefined {
    const k = key[index]
    if (key.length - 1 === index) {
        return c.get(k)
    }

    if (!c.has(k)) {
        return
    }

    return getCachedItem(key, c.get(k), index + 1)
}

function setCachedItem<U>(val: U, key: any[], c: Map<any, any>, index = 0): U {
    const k = key[index]
    if (key.length - 1 === index) {
        c.set(k, val)
        return val
    }

    if (!c.has(k)) {
        c.set(k, new Map())
    }

    return setCachedItem(val, key, c.get(k)!, index + 1)
}

export function useServer<T extends any[], U>(fn: (...args: T) => Promise<U> | U, ...args: T): U {
    const cache = getCache()
    const fnId = getObjectId(fn)
    const baseKey = [fnId, ...args]

    const p = getCachedItem<U>(baseKey, cache)
    const handler = getHandler(fnId) ?? fn
    // TODO: add `hasCachedItem` so we can support `undefined` cached values
    if (p === undefined) {
        const item = handler(...args).then(
            (val: any) => onComplete(baseKey, val),
            (err: any) => onComplete(baseKey, undefined, err),
        )

        const val = usePromise(setCachedItem(item as any, baseKey, cache) as any)
        
        return setCachedItem(val as any, baseKey, cache)
    } else if (p instanceof Promise) {
        const val = usePromise(p)
        
        return setCachedItem(val, baseKey, cache)
    }

    if (p === 'PROMISE_PENDING') {
        const val = Object.assign(Promise.resolve(), { status: 'pending' })
        throw setCachedItem(val as any, [...baseKey], cache)
    }

    if (typeof p === 'object' && !!p && (p as any).__type == 'SERVER_ERROR' && !!(p as any).__value) {
        throw (p as any).__value
    }

    return p
}

let c = 0
const objectId = Symbol.for('synapse.objectId')
export function getObjectId(obj: object | Function): string {
    if (Object.prototype.hasOwnProperty.call(obj, objectId)) {
        return (obj as any)[objectId]
    }

    const id = String(c++)
    ;(obj as any)[objectId] = id

    return id
}
