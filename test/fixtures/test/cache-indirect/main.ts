import { HttpService } from 'synapse:srl/compute'
import { fetch } from 'synapse:http'
import { test, expectEqual } from 'synapse:test'

const service = new HttpService()

const goodData = 1
const badData = 0
const data = process.env.USE_GOOD_DATA !== '0' ? goodData : badData

const getData = service.route('GET', '/data', () => data)

test('returns good data', async () => {
    const resp = await fetch(getData)
    expectEqual(resp, goodData)
})

// !commands
// # First make sure the test passes normally
// export USE_GOOD_DATA=1
// synapse deploy
// synapse test
//
// # Now we build with bad data
// export USE_GOOD_DATA=0
// synapse compile
// synapse deploy
// synapse test @expectFail
//
// # Check that tests pass again after rebuild
// export USE_GOOD_DATA=1
// synapse compile
// synapse deploy
// synapse test
