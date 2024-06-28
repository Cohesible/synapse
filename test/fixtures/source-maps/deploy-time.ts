import * as path from 'node:path'
import * as core from 'synapse:core'
import { describe, it, expect, expectEqual } from 'synapse:test'

class MyError extends core.defineResource({
    create: async (key: string) => {
        const stack = new Error(key).stack

        return { stack }
    },
}) {}

const err = new MyError('foo')

describe('source maps', () => {
    it('shows the correct location', () => {
        const stack = err.stack
        expect(stack)
        const firstLine = stack.split('\n')[1]
        expect(firstLine, 'Missing first line of stack trace')
        const location = firstLine.trim().split(' ')[1]
        expect(location, `Missing file location in trace: ${firstLine}`)

        const base = location.split(path.sep).pop()!
        expectEqual(base, 'deploy-time.ts:7:23')
    })
})