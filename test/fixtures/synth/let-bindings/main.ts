import { it, expectEqual } from 'synapse:test'

let c = 1
function fooFactory() {
    let x: number
    const foo = () => x
    x = c++

    return foo
}

const foo1 = fooFactory()
const foo2 = fooFactory()
expectEqual(foo1(), 1)
expectEqual(foo2(), 2)

it('uses a different symbol binding id for each function', () => {
    expectEqual(foo1(), 1)
    expectEqual(foo2(), 2)
})

function sharedFactory() {
    let x: number
    const get = () => x
    const inc = () => void x++
    x = c++

    // For good measure, we'll also create a nested function
    function createIncTwo() {
        const two = 2

        return function() {
            x += two
        }
    }

    return { get, inc, incTwo: createIncTwo() }
}

const shared = sharedFactory()
expectEqual(shared.get(), 3)
shared.inc()
expectEqual(shared.get(), 4)

it('shares scoped bindings across functions', () => {
    expectEqual(shared.get(), 4)
    shared.inc()
    expectEqual(shared.get(), 5)
})

it('shares scoped bindings with nested functions', () => {
    expectEqual(shared.get(), 4)
    shared.incTwo()
    expectEqual(shared.get(), 6)
})

// Circular references require late binding
function fib(n: number): number {
    return n <= 1 ? n : doFib(n)
}

function doFib(n: number) {
    return fib(n - 2) + fib(n - 1)
}

expectEqual(fib(10), 55)

it('handles late bindings', () => {
    expectEqual(fib(10), 55)
})

const arr: number[] = []
function push(val: number) {
    arr.push(val)
}

function pop() {
    return arr.pop()
}

it('shares arrays across functions', () => {
    push(1)
    expectEqual(pop(), 1)
})

const fns: (() => number)[] = []
for (let i = 0; i < 2; i++) {
    fns[i] = () => i
}

it('captures loop variable correctly in closures (constant)', () => {
    expectEqual(fns[0](), 0)
    expectEqual(fns[1](), 1)
})

// !commands
// synapse deploy
// synapse test
