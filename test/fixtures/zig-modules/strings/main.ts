import { expect, expectEqual } from 'synapse:test'
import { concat } from './mod.zig'

export function main() {
    const res = concat('foo', 'bar')
    expectEqual(res, 'foobar')

    try {
        concat('a', 'b')
        expect(false)
    } catch (e) {
        expectEqual((e as any)?.code, 'StringTooSmall')
    }

    console.log('it works!')
}

// !commands
// synapse run

