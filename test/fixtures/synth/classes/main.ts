import { test, expectEqual } from 'synapse:test'

class A {
    foo() { return 'foo' }
}

test('constructor', () => {
    expectEqual(new A().foo(), 'foo')
})

const B = class {
    foo() { return 'foo' }
}

test('anonymous class', () => {
    expectEqual(new B().foo(), 'foo')
})

const foo = new B().foo
test('anonymous class (method)', () => {
    expectEqual(foo(), 'foo')
})

const getValSym = Symbol.for('getVal')

class C {
    constructor(private readonly val: string) {}

    getVal() {
        return this.val 
    }

    [getValSym]() {
        return this.val
    }
}

const c = new C('bar')
const getVal = c.getVal.bind(c)

test('bound methods', () => {
    expectEqual(getVal(), 'bar')
})

const getVal2 = c.getVal
test('methods (no bind)', () => {
    expectEqual(getVal2.call({ val: 'bar2' }), 'bar2')
})

const getVal3 = c[getValSym]
test('methods (computed name)', () => {
    expectEqual(getVal3.call({ val: 'bar3' }), 'bar3')
})

{
    const suffix = '!'

    class D {
        constructor(public readonly val: string) {}
        
        getVal() {
            return `${this.val}${suffix}`
        }
    }

    const d = new D('bar4')
    const getVal4 = d.getVal
    test('methods (captured)', () => {
        expectEqual(getVal4.call({ val: 'bar4' }), 'bar4!')
    })

    class E {
        constructor(public readonly val: string) {}
        
        getVal(count: number) {
            return `${this.val}${suffix}`.repeat(count)
        }
    }

    const e = new E('bar5')
    const getVal5 = e.getVal
    test('methods (captured with args)', () => {
        expectEqual(getVal5.call({ val: 'bar5' }, 2), 'bar5!bar5!')
    })
}

{
    const y = 2
    class F {
        static readonly x = 1
        static foo() {
            return this.x + y
        }
    }
    
    test('static methods', () => {
        expectEqual(F.foo(), 3)
    })
}

{
    // Individuals method should fail to serialize but we should
    // still be able to use the class itself
    class X {
        #foo = 1

        static m() {
            const x = new this()
            x.#foo = 2

            return x
        }

        m() {
            return this.#foo
        }

        m2() {
            return this.#foo.toString()
        }

        #privateMethod() {
            return this.#foo + 1
        }

        plusOne() {
            return this.#privateMethod()
        }
    }

    const x = new X()
    test('private members', () => {
        expectEqual(x.m(), 1)
    })

    test('private members (nested)', () => {
        expectEqual(x.m2(), '1')
    })

    test('private method', () => {
        expectEqual(x.plusOne(), 2)
    })
}

{
    class X {
        foo() {
            return 'a'
        }
    }

    // We can't serialize `foo` yet but we should be able to compile the class
    class Y extends X {
        foo() {
            return super.foo() + 'b'
        }
    }

    const y = new Y()
    test('super prop access', () => {
        expectEqual(y.foo(), 'ab')
    })
}

// !commands
// synapse test