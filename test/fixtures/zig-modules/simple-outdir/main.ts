import { add } from './add.zig'
import { expectEqual } from 'synapse:test'

export function main() {
    expectEqual(add(1, 1), 2)
}

// !commands
// synapse run
// synapse build
// ./dist/bin/main
