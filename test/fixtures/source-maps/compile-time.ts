import { Bundle } from 'synapse:lib'
import { getPermissions, bindFunctionModel } from 'synapse:core'

// .infra.js mappings
function infraMappings() {
    function bar() {
        throw new Error('bar')
    }

    bar()

}

function permissions() {
    function foo() {}

    bindFunctionModel(foo, () => {
        throw new Error('Hello!')
    })

    getPermissions(foo)
}

function capturing() {
    const anonSymbol = Symbol() // TODO: eventually this won't fail, use something else

    function f1() {
        console.log(anonSymbol)
    }

    function f2() {
        f1()
    }

    new Bundle(() => f2())
}
