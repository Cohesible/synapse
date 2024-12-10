import { add } from './add.zig'
import { test, expectEqual } from 'synapse:test'
import { LambdaFunction } from '@cohesible/synapse-aws/lambda'

const archs = ['aarch64', 'x64'] as const

for (const arch of archs) {
    const fn = new LambdaFunction(add, { arch })
    test(arch, async () => {
        const actual = await fn.invoke(2, 2) // FIXME: `LambdaFunction` doesn't inherit types from `Function`
        expectEqual(actual, 4)
    })
}

// !commands
// # TODO: we can only run this test if we have AWS creds
// echo "skipped"; exit 0
// synapse test
