import { b } from './b'
import { expectEqual } from 'synapse:test'

export async function main() {
    expectEqual(await b.get('foo', 'utf-8'), 'bar')
}

// !commands
// synapse run @input Y