import * as synapse from 'synapse:core'
import { Bucket } from 'synapse:srl/storage'
import { describe, it, expect, expectEqual } from 'synapse:test'

describe('Bucket', () => {
    const b = new Bucket()

    // TODO: rethink this API. Most JS APIs do not throw on missing keys.
    it('throws if the key is absent', async () => {
        const err = await b.get('missing-key').catch(e => e)
        expect(err instanceof Error)
        expectEqual(err.name, 'NoSuchKey')
    })

    it('stores', async () => {
        const data = 'hi'
        await b.put('my-key', data)
        expect(await b.get('my-key', 'utf-8') === data)
    })

    it('deletes', async () => {
        await b.put('delete-me', 'dummy')
        await b.delete('delete-me')
        const err = await b.get('delete-me').catch(e => e)
        expect(err instanceof Error)
        expectEqual(err.name, 'NoSuchKey')
    })

    it('stores (nested)', async () => {
        const data = 'im-nested'
        await b.put('my/nested/key', data)
        expect(await b.get('my/nested/key', 'utf-8') === data)
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
})
