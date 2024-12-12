import { Function } from 'synapse:srl/compute'

const hello = new Function(() => {
    return { message: 'hello, world?' }
})

export async function main(...args: string[]) {
    console.log(await hello())
}
