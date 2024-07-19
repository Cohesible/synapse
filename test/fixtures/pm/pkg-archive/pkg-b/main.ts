import { Service } from 'synapse:services'

class Foo extends Service {
    public bar() {
        return { bar: 'bar' }
    }
}

const foo = new Foo()
foo.addAuthorizer(() => {})

export const Client = foo.createClientClass()

