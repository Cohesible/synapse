import { Function } from 'synapse:srl/compute'
import { describe, it, test, expectEqual } from 'synapse:test'
import './symEval'

const add = (a: number, b: number) => a + b
const plus1 = add.bind(undefined, 1)

test('plus1', () => {
    expectEqual(plus1(1), 2)
})

const plus1plus2 = plus1.bind(undefined, 2)

test('plus1plus2', () => {
    expectEqual(plus1plus2(1), 3)
})

function getThis(this: any) {
    return this
}

const getThisNumber = getThis.bind(5)
const getThisBindTwice = getThisNumber.bind(6) // should not change `this` binding

test('getThis', () => {
    expectEqual(getThisNumber(), 5)
    expectEqual(getThisBindTwice(), 5)
})

describe('Function', () => {
    const fn = new Function(plus1)

    it('works with bound functions', async () => {
        expectEqual(await fn(1), 2)
    })
})


// !commands
// synapse deploy
// synapse test
