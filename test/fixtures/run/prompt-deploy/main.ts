import { Function } from 'synapse:srl/compute'

const message = process.env.TEST_MESSAGE

const hello = new Function(() => message)

export async function main(...args: string[]) {
    console.log(await hello())
}

// !commands
// export TEST_MESSAGE=hello
// synapse run @input Y
// @expectEqual "$(synapse run)" hello
//
// # env var change detection only looks at `*.env` files
// # Though I think we should do more than that, while making 
// # it clear that the env vars are implicit
// exit 0
//
// export TEST_MESSAGE=goodbye
// synapse run @input N
// @expectEqual "$(synapse run)" hello
//
// synapse compile # Force recompilation
// synapse run @input Y
// @expectEqual "$(synapse run)" goodbye
