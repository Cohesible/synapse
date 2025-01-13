import { b } from './b'
import { expectEqual } from 'synapse:test'
import { Bucket } from 'synapse:srl/storage'

// Force the current file to be "deployable"
const b2 = new Bucket()

export async function main() {
    await b2.get('a')
    expectEqual(await b.get('foo', 'utf-8'), 'bar')
}

// !commands
// synapse run @input Y