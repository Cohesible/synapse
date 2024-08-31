import * as synapse from 'synapse:core'
import { Bucket } from 'synapse:srl/storage'
import { describe, it, test, expect, expectEqual } from 'synapse:test'

describe('Bucket', () => {
    const b = new Bucket()

    it('returns `undefined` if the key is absent', async () => {
        const data = await b.get('missing-key')
        expectEqual(data, undefined)
    })

    it('returns a blob by default', async () => {
        const data = 'hi'
        await b.put('my-key', data)
        const blob = await b.get('my-key')
        expect(blob instanceof Blob)
    })

    it('stores', async () => {
        const data = 'hi'
        await b.put('my-key', data)
        expectEqual(await b.get('my-key', 'utf-8'), data)
    })

    it('stores streams', async () => {
        const data = 'hi'
        const blob = new Blob([data])
        await b.put('my-key', blob.stream())
        expectEqual(await b.get('my-key', 'utf-8'), data)
    })

    it('deletes', async () => {
        await b.put('delete-me', 'dummy')
        await b.delete('delete-me')
        const data = await b.get('delete-me')
        expectEqual(data, undefined)
    })

    it('stores (nested)', async () => {
        const data = 'im-nested'
        await b.put('my/nested/key', data)
        expectEqual(await b.get('my/nested/key', 'utf-8'), data)
    })

    describe('Bucket (Fresh)', () => {
        const b = new Bucket()

        it('lists (nested)', async () => {
            const data = 'im-nested'
            await b.put('list/key', data)
            await b.put('list/nested/key1', data)
            await b.put('list/nested/key2', data)
    
            const list = await b.list()
            expectEqual(list, ['list/key', 'list/nested/key1', 'list/nested/key2'])
        })    
    })

    it('lists with prefix (nested)', async () => {
        const data = 'im-nested'
        await b.put('list/key', data)
        await b.put('list/nested/key1', data)
        await b.put('list/nested/key2', data)

        const list = await b.list('list/nested')
        expectEqual(list, ['list/nested/key1', 'list/nested/key2'])
    })

    describe('addBlob', () => {
        const dest = b.addBlob(require('node:path').resolve(__filename))

        it('adds a blob', async () => {
            expect(await b.get(dest))
        })

        const assetKey = b.addBlob(synapse.asset('table.ts'))
        it('works with assets', async () => {
            expect(await b.get(assetKey))
        })
    })

    describe('stat', () => {
        it('returns size', async () => {
            const data = Buffer.from('foobar')
            await b.put('my-key', data)
            const stats = await b.stat('my-key')
            expectEqual(stats?.size, data.byteLength)
        })

        it('returns `undefined` for missing items', async () => {
            expectEqual(await b.stat('i-do-not-exist'), undefined)
        })
    })
})
