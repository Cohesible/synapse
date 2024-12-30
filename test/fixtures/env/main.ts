import { defineDataSource } from 'synapse:core'
import { test, expectEqual } from 'synapse:test'

const expected = process.env.SYNAPSE_ENV === 'test' ? 'bar' : 'foo'

const foo = process.env.foo
test('loads env file for synthesis', () => {
    expectEqual(foo, expected)
})

test('loads env file for tests', () => {
    expectEqual(process.env.foo, expected)
})

{
    const getFoo = defineDataSource(() => process.env.foo)
    const foo = getFoo()
    test('loads env file for deploy', () => {
        expectEqual(foo, expected)
    })
}

export function main(output: string, expectedFoo: string) {
    const lines = output.split('\n')
    expectEqual(lines.at(-1), 'Skipped 3 unchanged tests')
    expectEqual(expected, expectedFoo)
}

// !commands
// echo "foo=foo" > .env
// synapse test
// echo "foo=bar" > .env.test
// export SYNAPSE_ENV=test
// synapse test
//
// # Unrelated env var changes should not re-synth
// synapse deploy # XXX: needed because the module itself is a resource
// export BAR=bar
// export OUTPUT=$(synapse test)
// synapse run -- "$OUTPUT" bar
//
// # Env vars should trigger a recompilation on deploy
// unset SYNAPSE_ENV
// synapse deploy
// synapse run -- "$OUTPUT" foo
//
// @finally rm -f .env
// @finally rm -f .env.test
