import { test, expectEqual } from 'synapse:test'

const target = process.env.SYNAPSE_TARGET
if (target === 'local') {
    test('local only', () => {
        expectEqual(target, 'local')
    })
}

// !commands
// synapse test
