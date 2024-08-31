import { test, expectEqual } from 'synapse:test'

{
    let y = 0
    const x = { [Symbol.dispose]: () => { y += 1 } }
    
    test('dipose', () => {
        {
            using _ = x
        }
        expectEqual(y, 1)
    })        
}

{
    let y = 0
    const x = { [Symbol.asyncDispose]: async () => { y += 1 } }
    
    test('asyncDispose', async () => {
        {
            await using _ = x
        }
        expectEqual(y, 1)
    })        
}

let c = 0
const iterable: Iterable<number> = {
    [Symbol.iterator]: () => {
        const next = () => ({
            value: c++,
            done: c > 5,
        })

        return { next }
    }
}

test('iterator', () => {
    expectEqual([...iterable], [0, 1, 2, 3, 4])
})

// !commands
// synapse test
