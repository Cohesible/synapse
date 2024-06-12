import * as core from 'synapse:core'
import * as storage from 'synapse:srl/storage'

export class Counter implements storage.Counter {
    private readonly bucket = new storage.Bucket()

    constructor(private readonly init: number = 0) {
        
    }

    async get(): Promise<number> {
        try {
            const d = JSON.parse(await this.bucket.get('counter', 'utf-8'))

            return d
        } catch {
            return this.init
        }
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
