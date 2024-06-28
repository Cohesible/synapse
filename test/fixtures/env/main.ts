import { test, expectEqual } from 'synapse:test'

test('loads env file', () => {
    expectEqual(process.env.foo, 'bar')
})

// !commands
// echo "foo=bar" > .env.test
// export SYNAPSE_ENV=test 
// synapse compile
// synapse test

