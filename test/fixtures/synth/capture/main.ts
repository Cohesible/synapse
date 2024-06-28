import { it, expectEqual } from 'synapse:test'

function bar() {
    return 'bar'
}

function foo() {
    return bar()
}

class Bar {
    public readonly x = foo()
}

it('captures field initializers', () => {
    expectEqual(new Bar().x, 'bar')
})

class Foo {
    foo() {
        return 'foo'
    }
}

function doStuff({ foo = new Foo() } = {}) {
    return foo.foo()
}


it('captures initializers in object binding patterns', () => {
    expectEqual(doStuff(), 'foo')
})

function doStuff2(foo = new Foo()) {
    return foo.foo()
}

it('captures parameter initializers', () => {
    expectEqual(doStuff2(), 'foo')
})

function doStuff3([foo = new Foo()] = []) {
    return foo.foo()
}

it('captures array pattern initializers', () => {
    expectEqual(doStuff3(), 'foo')
})

class FooFoo {
    public foo: string
    constructor(foo = new Foo()) {
        this.foo = foo.foo()
    }
}

it('captures constructor parameter initializers', () => {
    expectEqual(new FooFoo().foo, 'foo')
})

// !commands
// synapse compile
// synapse test
