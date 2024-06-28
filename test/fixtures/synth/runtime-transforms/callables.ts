import * as exported from './callables-exported'
import { Function } from 'synapse:srl/compute'
import { describe, it, expectEqual } from 'synapse:test'

const x = new Function(async () => ({ data: 'hello' }))

export function foo() {
    return new Function(async () => ({ data: 'hello' }))
}

describe('callables', () => {
    it('transforms local function calls', async () => {
        const resp = await x()
        expectEqual(resp.data, 'hello')
    })

    it('works for exported functions', async () => {
        const resp2 = await exported.y()
        expectEqual(resp2.data, 'hello')
    })
})

