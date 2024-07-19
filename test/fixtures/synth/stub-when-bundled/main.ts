import { HttpService } from 'synapse:srl/compute'
import { stubWhenBundled } from 'synapse:core'
import { test, expectEqual } from 'synapse:test'

function bar() {
    return 'bar'
}

const shouldStub = !!process.env.SHOULD_STUB
if (shouldStub) {
    stubWhenBundled(bar)
}

const service = new HttpService()
const route = service.route('GET', '/foo', bar)

test(shouldStub ? 'it can stub' : 'it does not stub', async () => {
    const actual = await service.callOperation(route)
    if (shouldStub) {
        expectEqual(actual, undefined)
    } else {
        expectEqual(actual, 'bar')
    }
})

// !commands
// synapse deploy
// synapse test
// SHOULD_STUB=1 synapse compile
// synapse deploy
// synapse test
// synapse destroy
