import * as aws from 'synapse-provider:aws'
import { test, expectEqual } from 'synapse:test'

test('provider version matches', () => {
    expectEqual(aws.version, '5.53.0')
})

// !commands
// synapse test
