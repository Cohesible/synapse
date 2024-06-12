import { Table } from 'synapse:srl/storage'
import { describe, it, expectEqual } from 'synapse:test'

describe('Table', () => {
    const table = new Table()

    it('can set and get items', async () => {
        const key = 'foo'
        const timestamp = new Date().toISOString()
        await table.set(key, timestamp)
        expectEqual(await table.get(key), timestamp)
    })

    it('can delete items', async () => {
        const key = 'delete-me'
        await table.set(key, key)
        expectEqual(await table.get(key), key)
        await table.delete(key)
        expectEqual(await table.get(key), undefined)
    })
})
