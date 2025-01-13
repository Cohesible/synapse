import { Function } from 'synapse:srl/compute'
import { test, expectEqual } from 'synapse:test'

const foo = process.env.FOO ?? 'foo'
const fn = new Function(async () => {
    return foo
})

test('a test', async () => {
    expectEqual(await fn(), 'foo')
})

export async function main(expected: string) {
    expectEqual(await fn(), expected)
}

// !commands
// # Base-case
// synapse deploy
// synapse test
// synapse run -- foo
//
// export FOO=bar
// synapse compile
// synapse deploy
// synapse run -- $FOO
// synapse test --rollback-if-failed @expectFail "Expected test to fail"
// synapse run -- foo
