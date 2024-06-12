import * as core from 'synapse:core'
import * as storage from 'synapse:srl/storage'
import * as lib from 'synapse:lib'

interface State<T> {
    buffer: T[]
    listener?: string
}

async function getState<T = any>(bucket: storage.Bucket): Promise<State<T>> {
    try {
        return JSON.parse(await bucket.get('state', 'utf-8'))
    } catch {
        return { buffer: [] }
    }
}

class QueueListener extends core.defineResource({
    create: async (bucket: storage.Bucket, pointer: string) => {
        const state = await getState(bucket)
        if (state.listener) {
            throw new Error(`A queue event listener already exists`)
        }

        state.listener = pointer
        await bucket.put('state', Buffer.from(JSON.stringify(state)))
    },
    update: async (_, bucket, pointer) => {
        const state = await getState(bucket)
        state.listener = pointer
        await bucket.put('state', Buffer.from(JSON.stringify(state)))
    },
    delete: async (_, bucket) => {
        const state = await getState(bucket)
        state.listener = undefined
        await bucket.put('state', Buffer.from(JSON.stringify(state)))
    },
}) {}

export class Queue<T> implements storage.Queue<T> {
    private readonly bucket = new storage.Bucket()

    constructor() {}
    private async setState(state: State<T>): Promise<void> {
        await this.bucket.put('state', Buffer.from(JSON.stringify(state)))
    }

    async send(val: T) {
        const state = await getState<T>(this.bucket)
        if (state.listener) {
            const fn = require(state.listener).default

            return fn(val)
        }

        state.buffer.push(val)
        await this.setState(state)
    }

    async consume<U>(fn: (val: T) => U | Promise<U>): Promise<U> {
        const state = await getState<T>(this.bucket)
        if (state.buffer.length === 0) {
            throw new Error(`No events to consume`)
        }

        const ev = state.buffer.shift()!
        const res = await fn(ev)
        await this.setState(state) // only update the state if the cb succeeds

        return res
    }

    on(event: 'message', listener: (ev: T) => Promise<void> | void) {
        const bundle = new lib.Bundle(listener)
        new QueueListener(this.bucket, bundle.destination)
    }
}


core.addTarget(storage.Queue, Queue, 'local')
