import * as pkg from 'pkg'
import { Function } from 'synapse:srl/compute'
import { test, expectEqual } from 'synapse:test'

const client = pkg.createClient()

const fn = new Function(async (key: string) => {
    return client.get(key)
})

test('client puts and gets', async () => {
    await client.put('foo', 'bar')
    expectEqual(await fn('foo'), 'bar')
})

// !commands
// (cd pkg && synapse deploy)
// synapse test
