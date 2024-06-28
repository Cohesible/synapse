import { Function } from 'synapse:srl/compute'
import { expectEqual } from 'synapse:test'

const fn = new Function(() => 'Hello, world!')

export async function main() {
    expectEqual(await fn(), 'Hello, world!')
}

// !commands
// synapse deploy
// synapse run
