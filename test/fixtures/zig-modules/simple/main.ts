import { test, expect, expectEqual } from 'synapse:test'
import { add } from './add.zig'
import { Function } from 'synapse:srl/compute'

test('add 1+1', () => {
    expectEqual(add(1, 1), 2)
})

const addFn = new Function(add)

test('add 1+1 (Function)', async () => {
    expectEqual(await addFn(1, 1), 2)
})

// test('add (optimized)', () => {
//     // Trigger lazy-load
//     add(1, 1) 

//     function getNsPerCall(iters: number) {
//         const start = performance.now()
//         for (let i = 0; i < iters; i++) {
//             add(1, 1)
//         }

//         const dur = performance.now() - start
    
//         return (dur*1e6) / iters
//     }

//     const beforeOpt = getNsPerCall(100)
//     getNsPerCall(100000)
//     const afterOpt = getNsPerCall(100)

//     // There is another way to test this: add compile-time instrumentation
//     // to `js.zig` that counts whenever a slow call is made
//     const ratio = beforeOpt / afterOpt
//     expect(ratio >= 10)
// })

export function main() {
    expectEqual(add(1, 1), 2)
}

// !commands
// synapse deploy
// synapse test
// synapse run
