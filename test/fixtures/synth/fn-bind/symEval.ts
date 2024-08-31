import { test, expectEqual } from 'synapse:test'
import { symEval, bindFunctionModel } from 'synapse:core'

const add = (a: number, b: number) => a + b

const addCalls: [number, number][] = []

bindFunctionModel(add, (a, b) => {
    addCalls.push([a, b])

    return add(a, b)
})

const boundAdd = add.bind(undefined, 1)
symEval(() => boundAdd(2))

test('boundAdd (symbolic evaluation)', () => {
    expectEqual(addCalls, [[1, 2]])
})


// TODO: need to rework some of the code for this
// Test bound `this`

// const addThis = function (this: number, n: number) { return this + n }

// const addThisCalls: [number, number][] = []

// bindFunctionModel(addThis, function (n) {
//     addThisCalls.push([this, n])

//     return addThis.call(this, n)
// })

// const boundAddThis = addThis.bind(2, 3)
// symEval(() => boundAddThis())

// test('boundAddThis (symbolic evaluation)', () => {
//     expectEqual(addThisCalls, [[2, 3]])
// })

