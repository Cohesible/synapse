import { expect, expectEqual } from 'synapse:test'
import { add, throwMe, returnVoid } from './mod.zig'

export async function main() {
    const res = await add(2, 2)
    console.log('2 + 2 =', res)
    expectEqual(res, 4)

    const p = throwMe()
    expect(p instanceof Promise)

    try {
        await p
    } catch (e) {
        expect(e instanceof Error)
        expectEqual((e as { code?: string }).code, 'Failed')
        console.log('Caught error')
    }

    expectEqual(await returnVoid(), undefined)
    console.log('Returned void')
}

// !commands
// synapse run

