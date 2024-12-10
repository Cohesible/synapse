import { Adder } from './adder.zig'
import { test, expectEqual } from 'synapse:test'

test('Adder', () => {
    const adder = new Adder(1)
    expectEqual(adder.add(2), 3)
})


