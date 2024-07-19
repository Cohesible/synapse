import * as core from 'synapse:core'
import * as storage from 'synapse:srl/storage'
import * as compute from 'synapse:srl/compute'
import { HttpError } from 'synapse:http'
import { LocalKVStore } from './bucket'
import { createHash } from 'node:crypto'

function hashObj(o: any) {
    return createHash('sha256').update(JSON.stringify(o)).digest('hex')
}

export class Table<K, V> implements storage.Table<K, V> {
    private readonly resource = new LocalKVStore()

    public async get(key: K): Promise<V | undefined> {
        const d = await this.resource.get(hashObj(key), 'utf-8')

        return d !== undefined ? JSON.parse(d) : undefined
    }

    getBatch(keys: K[]): Promise<{ key: K; value: V }[]> {
        return Promise.all(keys.map(key => this.get(key).then(value => ({ key, value: value! }))))
    }

    public async set(key: K, val: V): Promise<void> {
        await this.resource.put(hashObj(key), Buffer.from(JSON.stringify(val), 'utf-8'))
    }

    async setBatch(items: { key: K; value: V }[]): Promise<void> {
        await Promise.all(items.map(item => this.set(item.key, item.value)))
    }

    public async delete(key: K): Promise<void> {
        await this.resource.delete(hashObj(key))
    }

    async *values(): AsyncIterable<V[]> {
        const keys = await this.resource.list()
        const values = await Promise.all(keys.map(k => this.resource.get(k).then(b => JSON.parse(b.toString()))))
        yield values
    }
}

core.addTarget(storage.Table, Table, 'local')

// TODO: make this actually use `ttl`
export class TTLCache<K extends string, V> implements storage.TTLCache<K, V> {
    private readonly resource = new Table<K, V>()

    public constructor(private readonly ttl: number = 3600) {}

    public async get(key: K): Promise<V | undefined> {
        return this.resource.get(key)
    }

    public async put(key: K, value: V): Promise<void> {
        await this.resource.set(key, value)
    }

    keys(): Promise<K[]> {
        throw new Error('Method not implemented.')
    }

    public async delete(key: K): Promise<void> {
        await this.resource.delete(key)
    }
}

core.addTarget(storage.TTLCache, TTLCache, 'local')

// XXX: must be a function, otherwise `Symbol.asyncDispose` won't be initialized
function getAsyncDispose(): typeof Symbol.asyncDispose {
    if (!Symbol.asyncDispose) {
        const asyncDispose = Symbol.for('Symbol.asyncDispose')
        Object.defineProperty(Symbol, 'asyncDispose', { value: asyncDispose, enumerable: true })
    }

    return Symbol.asyncDispose
}

export class SimpleLock {
    private readonly table = new Table<string, number>()

    async lock(id: string) {
        const currentState = await this.table.get(id)
        if (currentState === 1) {
            throw new HttpError(`Key is already locked: ${id}`, { statusCode: 423 })
        }

        await this.table.set(id, 1)

        return {
            id,
            [getAsyncDispose()]: () => this.unlock(id),
        }
    }

    async unlock(id: string) {
        await this.table.set(id, 0)
    }
}

core.addTarget(compute.SimpleLock, SimpleLock, 'local')