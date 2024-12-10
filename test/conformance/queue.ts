import { Queue, Bucket } from 'synapse:srl/storage'
import { describe, it, expectEqual } from 'synapse:test'
import { waitUntil } from './util'

describe('Queue', () => {
    const bucket = new Bucket()
    const queue = new Queue<[string, string]>()

    queue.on('message', async ([key, value]) => {
        await bucket.put(key, value)
    })

    it('uses listeners', async () => {
        await queue.send(['foo', 'bar'])
        const actual = await waitUntil(100, 2500, () => bucket.get('foo', 'utf-8'))
        expectEqual(actual, 'bar')
        await bucket.delete('foo')
    })
})
