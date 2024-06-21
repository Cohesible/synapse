import * as storage from 'synapse:srl/storage'
import { Service } from 'synapse:services'
import { RandomString } from 'synapse:key-service'
import { HttpError } from 'synapse:http'
import { randomUUID } from 'node:crypto'
import { getDeviceId } from './deviceId'
import { describe, it, expect } from 'synapse:test'

export interface AnalyticsEvent {
    readonly type: string
    readonly timestamp: string // ISO
    readonly attributes?: Record<string, any>    
}

interface StoredAnalyticsEvent extends AnalyticsEvent {
    readonly deviceId: string
}

interface PostEventsRequest {
    readonly batch: AnalyticsEvent[]
}

interface DeviceIdentity {
    readonly id: string
}

function getEventKey(ev: Pick<AnalyticsEvent, 'timestamp'>) {
    const d = new Date(ev.timestamp)
    
    return `${d.getUTCFullYear()}/${(d.getUTCMonth() + 1).toString().padStart(2, '0')}/${(d.getUTCDate()).toString().padStart(2, '0')}`
}

const maxBufferSize = 10 * 1024 * 1024

function createBufferedBucket(bucket: storage.Bucket) {
    interface BufferedData {
        id: string
        size: number
        chunks: Uint8Array[]
    }

    const buffers: Record<string, BufferedData> = {}
    function getBuffer(key: string) {
        if (key in buffers) {
            return buffers[key]
        }

        return buffers[key] = {
            id: randomUUID(),
            size: 0,
            chunks: [],
        }
    }

    const pendingResolves: Record<string, [() => void, (err: Error) => void][]> = {}

    async function _write(key: string, d: BufferedData) {
        const k = `${key}/${d.id}`

        while (true) {
            const pending = pendingResolves[k]
            if (!pending) {
                break
            }

            delete pendingResolves[k]

            try {
                await bucket.put(k, Buffer.concat(d.chunks))
                for (const r of pending) {
                    r[0]()
                }
            } catch (e) {
                for (const r of pending) {
                    r[1](e as Error)
                }
            }
        }
    }

    const pendingWrites: Record<string, Promise<void>> = {}
    function write(key: string, d: BufferedData) {
        const k = `${key}/${d.id}`
        const p = new Promise<void>((resolve, reject) => {
            const arr = pendingResolves[k] ??= []
            arr.push([resolve, reject])
        })

        if (k in pendingWrites) {
            return p
        }

        pendingWrites[k] = _write(key, d).finally(() => delete pendingWrites[k])

        return p
    }

    function put(key: string, data: Uint8Array) {
        const b = getBuffer(key)
        b.size += data.byteLength
        b.chunks.push(data)

        if (b.size >= maxBufferSize) {
            delete buffers[key]
        }

        return write(key, b)
    }

    return { put }
}

interface GetEventsRequest {
    from?: string
    to?: string
    type?: string
}

class Analytics extends Service<DeviceIdentity> {
    private readonly bucket = new storage.Bucket()
    private readonly buffered = createBufferedBucket(this.bucket)

    public async postEvents(req: PostEventsRequest) {
        const events = req.batch.map(ev => ({ ...ev, deviceId: this.context.id } satisfies StoredAnalyticsEvent))
        const promises: Promise<void>[] = []
        for (const ev of events) {
            const d = Buffer.from(JSON.stringify(ev) + '\n', 'utf-8')
            promises.push(this.buffered.put(getEventKey(ev), d))
        }

        await Promise.all(promises)
    }

    // public async getEvents(req: GetEventsRequest) {
    //     const t = req.from ? new Date(req.from) : new Date()
    //     const k = getEventKey({ timestamp: t.toISOString() })
    //     const keys = await this.bucket.list(k)
    //     const events: StoredAnalyticsEvent[] = []
    //     for (const k of keys) {
    //         const d = await this.bucket.get(k, 'utf-8')
    //         for (const l of d.split('\n')) {
    //             if (l) {
    //                 events.push(JSON.parse(l))
    //             }
    //         }
    //     }

    //     return { events }
    // }
}

// This token is embedded into the CLI as simple mechanism to prevent abuse
const secret = new RandomString(16).value

const analytics = new Analytics()
analytics.addAuthorizer(async (authz, req) => {
    const [scheme, rest] = authz.split(' ')
    if (scheme !== 'Basic') {
        throw new HttpError(`Bad scheme: ${scheme}`, { statusCode: 403 })
    }

    const [id, token] = Buffer.from(rest, 'base64').toString('utf-8').split(':')
    if (token !== secret) {
        throw new HttpError(`Invalid token`, { statusCode: 403 })
    }

    return { id }
})

const Client = analytics.createClientClass()

export function createClient() {
    return new Client({
        // This isn't intended to be super secure.
        authorization: async () => {
            const deviceId = await getDeviceId()
            const authorization = `Basic ${Buffer.from(`${deviceId}:${secret}`).toString('base64')}`

            return authorization
        }
    })
}

describe('analytics', () => {
    function makeTestEvent(attr?: Record<string, any>, time = new Date()): AnalyticsEvent {
        return {
            type: 'test',
            timestamp: time.toISOString(),
            attributes: attr,
        }
    }

    // it('can send events', async () => {
    //     const req: PostEventsRequest = { batch: [makeTestEvent(), makeTestEvent()] }
    //     await client.postEvents(req)
    //     const data = await analytics.getEvents({})
    //     expect(data.events.find(ev => ev.timestamp === req.batch[0].timestamp))
    // })
})

