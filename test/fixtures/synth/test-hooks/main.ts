import { describe, it, before, after, expectEqual } from 'synapse:test'

describe('before', () => {
    let x: number

    it('works when placed after the test declaration', () => {
        expectEqual(x, 1)
    })

    before(() => {
        x = 1
    })

    describe('nested', () => {
        it('works when nested', () => {
            expectEqual(x, 1)
        })

        let y: number
        before(() => {
            y = 2
        })

        it('supports multiple hooks', () => {
            expectEqual(x, 1)
            expectEqual(y, 2)
        })
    })

    describe('nested conflict', () => {
        before(() => {
            x = 2
        })

        it('works when nested', () => {
            expectEqual(x, 2)
        })
    })
})

// !commands
// synapse test
