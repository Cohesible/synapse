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

        it('works when nested (top down)', () => {
            expectEqual(x, 2)
        })
    })
})

describe('after', () => {
    let x: number
    let afterCount = 0

    after(() => {
        expectEqual(x, 1)
        // Little bit of a hack because there are few ways to know for 
        // sure `after` was called without another testing layer on top
        console.log('called after', afterCount++)
    })

    it('works when placed before the test declaration', () => {
        x = 1
    })

    describe('nested', () => {
        let y: number

        it('supports multiple hooks', () => {
            x = 1
            y = 2
        })

        after(() => {
            expectEqual(y, 2)
            console.log('called after', afterCount++)
        })
    })

    describe('nested conflict', () => {
        after(() => {
            expectEqual(x, 2)
            x = 1
            console.log('called after', afterCount++)
        })

        it('works when nested (bottoms up)', () => {
            x = 2
        })
    })
})

// !commands
// # We can verify the order of `after` calls by parsing the output
// export OUTPUT=$(synapse test --show-logs | grep "called after" | cut -c 18 | tr -d "\n")
// @expectEqual "$OUTPUT" 00101
