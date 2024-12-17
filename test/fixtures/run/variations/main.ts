import { Function } from 'synapse:srl/compute'

const hello = new Function(() => {
    return { message: 'hello, world!' }
})

export async function main(...args: string[]) {
    console.log(await hello())
}

// !commands
// synapse deploy ./main.ts
// synapse deploy main.ts
// @expectEqual "$(synapse run ./main.ts)" "{ message: 'hello, world!' }"
//
// synapse deploy ./folder/hello.ts
// synapse deploy folder/hello.ts
// @expectEqual "$(synapse run ./folder/hello.ts)" "{ message: 'hello, world?' }"