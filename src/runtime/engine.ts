import * as crypto from 'node:crypto'

function strcmp(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0
}

interface ResourceDefinition<T = any, U extends any[] = []> {
    read?(state: T): T | Promise<T>
    create(...args: U): T | Promise<T>
    update?(state: T, ...args: U): T | Promise<T>
    delete?(state: T, ...args: U): void | Promise<void>
}

type ResourceConstructor<
    T extends object = object, 
    U extends any[] = [],
> = {
    new (...args: U): Readonly<T>
}

export function defineResource<
    T extends object = object,
    U extends any[] = []
>(
    definition: ResourceDefinition<T, U>
): ResourceConstructor<T, U> {
    return class {
        static [resourceDef] = definition

        constructor() {
            throw new Error(`Use "putResource" for resources`)
        }
    } as any
}

const resourceDef = Symbol.for('synapse.resourceDefinition')

function getDefinition(val: any): ResourceDefinition | undefined {
    return val[resourceDef]
}

interface StateEntry {
    readonly hash: string
    readonly data: any
    readonly args?: any[] // Only added if `delete` might be called
}

interface State {
    get: (key: string) => Promise<StateEntry | undefined> | StateEntry | undefined
    put: (key: string, entry: StateEntry) => Promise<void> | void
}

interface ResourceContext {
    readonly key: string
    readonly state: State
}

const mem: Record<string, StateEntry> = {}
const inmemState: State = {
    get: key => mem[key],
    put: (key, entry) => void (mem[key] = entry),
}

function getCtx(subject?: any): ResourceContext {
    return {
        key: subject?.name,
        state: inmemState,
    }
}

const undefinedHash = crypto.hash('sha256', '$undefined')
const nullHash = crypto.hash('sha256', '$null')
const trueHash = crypto.hash('sha256', '$true')
const falseHash = crypto.hash('sha256', '$false')

// TODO: use wyhash
// TODO: handle self-referential structures
function hashValue(val: any): string {
    const hasher = crypto.createHash('sha256')

    if (Array.isArray(val)) {
        hasher.update('$a')

        for (let i = 0; i < val.length; i++) {
            hasher.update(`:${hashValue(val[i])}`)
        }

        return hasher.digest('hex')
    }

    if (typeof val === 'string') {
        hasher.update(`$s:${val}`)
        return hasher.digest('hex')
    }

    if (typeof val === 'number') {
        hasher.update(`$n:${val}`)
        return hasher.digest('hex')
    }

    if (typeof val === 'undefined') {
        return undefinedHash
    } else if (val === null) {
        return nullHash
    } else if (val === true) {
        return trueHash
    } else if (val === false) {
        return falseHash
    }

    if (typeof val === 'object') {
        hasher.update('$o')

        const sorted = Object.entries(val).sort((a, b) => strcmp(a[0], b[0]))
        for (let i = 0; i < sorted.length; i++) {
            hasher.update(':')
            hasher.update(crypto.createHash('sha25').update(`$s:${sorted[i][0]}`).digest())
            hasher.update(`,${hashValue(sorted[i][1])}`)
        }

        return hasher.digest('hex')
    }

    throw new Error('TODO')
}

export async function putResource<T extends any[], U>(ctx: ResourceContext, subject: (...args: T) => Promise<U> | U, ...args: T): Promise<U> {
    // const ctx = getCtx(subject)
    const hash = hashValue(args)
    const def = getDefinition(subject) as ResourceDefinition<U, T>
    const prior = await ctx.state.get(ctx.key)
    if (!prior) {
        if (def) {
            const data = await def.create(...args)
            await ctx.state.put(ctx.key, { hash, data, args: def.delete ? args : undefined })

            return data
        }

        const data = await subject(...args)
        await ctx.state.put(ctx.key, { hash, data })

        return data
    }

    if (prior.hash === hash) {
        return prior.data
    }

    if (!def) {
        const data = await subject(...args)
        await ctx.state.put(ctx.key, { hash, data })

        return data  
    }

    if (!def.update) {
        if (def.delete && prior.args) {
            await def.delete(prior.data, ...prior.args as any)
        }

        const data = await def.create(...args)
        await ctx.state.put(ctx.key, { hash, data, args: def.delete ? args : undefined })

        return data
    }

    const data = await def.update(prior.data, ...args)
    await ctx.state.put(ctx.key, { hash, data, args: def.delete ? args : undefined })

    return data
}
