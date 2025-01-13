import { test, expectEqual } from 'synapse:test'

const a = process.env.A || 'a'
const b = process.env.B || 'b'

test('a', () => expectEqual(a, a))
test('b', () => expectEqual(b, b))

export function main(output: string, expected: string) {
    const lastLine = output.split('\n').at(-1)
    expectEqual(lastLine, `Skipped ${expected} unchanged tests`)
}

// !commands
// synapse deploy && synapse test
// export OUTPUT=$(synapse test)
// synapse run -- "$OUTPUT" 2
// 
// export A=aa
// synapse compile && synapse deploy
// export OUTPUT=$(synapse test)
// synapse run -- "$OUTPUT" 1
