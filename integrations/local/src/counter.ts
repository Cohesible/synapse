import * as core from 'synapse:core'
import * as storage from 'synapse:srl/storage'
import * as compute from 'synapse:srl/compute'
import { randomUUID } from 'node:crypto'

export class Counter implements storage.Counter {
    private readonly bucket = new storage.Bucket()

    constructor(private readonly init: number = 0) {
        
    }

    async get(): Promise<number> {
        const data = await this.bucket.get('counter', 'utf-8')

        return data !== undefined ? JSON.parse(data) : this.init
    }

    async set(amount: number): Promise<number> {
        const currentVal = await this.get()
        await this.bucket.put('counter', JSON.stringify(amount))

        return currentVal
    }

    async inc(amount = 1): Promise<number> {
        const currentVal = await this.get()
        const newVal = currentVal + amount
        await this.set(newVal)

        return newVal
    }
}

core.addTarget(storage.Counter, Counter, 'local')

export class SimpleLock {
    private readonly bucket = new storage.Bucket()

    async lock(id: string, timeout?: number) {
        let sleepTime = 1

        while (true) {
            const l = await this.tryLock(id)
            if (l) {
                return l
            }

            await new Promise<void>(r => setTimeout(r, sleepTime))

            if (sleepTime < 100) {
                sleepTime = Math.round((1 + Math.random()) * sleepTime)
            }
        }
    }

    async tryLock(id: string) {
        const currentState = await this.bucket.get(id, 'utf-8')
        if (currentState && currentState !== '0') {
            return
        }

        const lockId = randomUUID()
        await this.bucket.put(id, lockId)
        const c = await this.bucket.get(id, 'utf-8')

        if (c === lockId) {
            return {
                id,
                [Symbol.asyncDispose]: () => this.unlock(id),
            }
        }
    }

    async unlock(id: string) {
        await this.bucket.put(id, '0')
    }

    async clear() {
        for (const k of await this.bucket.list()) {
            await this.bucket.delete(k)
        }
    }
}

core.addTarget(compute.SimpleLock, SimpleLock, 'local')
