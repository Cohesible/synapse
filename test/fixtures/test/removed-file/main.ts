import * as path from 'node:path'
import { test, expectEqual } from 'synapse:test'

const basename = path.basename(__filename)
test(`check filename ${basename}`, () => {
    expectEqual(basename, 'main.ts')
})

// !commands
// synapse test
//
// cp main.ts main2.ts
// (synapse test | grep "\[FAILED\] check filename main2.ts") || (echo "Expected failure message for 2nd test" && false)
// 
// rm main2.ts
// synapse test
// synapse test main2.ts @expectFail
//
//
// @finally rm -f main2.ts
