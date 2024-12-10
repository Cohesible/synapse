import * as one from './one.zig'
import * as two from './two.zig'
import { test, expectEqual } from 'synapse:test'

test('one', () => {
    expectEqual(one.addOne(1), 2)
})

test('two', () => {
    expectEqual(two.addTwo(2), 4)
})

// !commands
// synapse test
