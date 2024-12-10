import * as mod from './mod.zig'
import { test, expectEqual } from 'synapse:test'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

test('return struct', () => {
    expectEqual(mod.getStruct(1), { foo: 1 })
})

test('return nested struct', () => {
    expectEqual(mod.getNestedStruct(1), { foo: 1, nested: { foo: 1 } })
})

test('struct parameter', () => {
    expectEqual(mod.getFoo({ foo: 2 }), 2)
})

test('bigint params + return', () => {
    expectEqual(mod.addU64(9007199254740992n, 9007199254740992n), 18014398509481984n)
})

const typeDefs = path.resolve(__dirname, 'mod.d.zig.ts')
const expectedPath = path.resolve(__dirname, 'expected.d.ts')

test('generated type definitions', async () => {
    const [actual, expected] = await Promise.all([
        fs.readFile(typeDefs, 'utf-8'),
        fs.readFile(expectedPath, 'utf-8'),
    ])
    expectEqual(actual, expected)
})

// !commands
// synapse test
