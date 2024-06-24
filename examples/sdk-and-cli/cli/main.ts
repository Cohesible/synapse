import { createClient } from 'sdk'

const client = createClient()

export async function main(command: string, key: string, val?: string) {
    switch (command) {
        case 'get':
            const obj = await client.getObject(key)
            console.log(obj)
            break

        case 'put':
            if (val === undefined) {
                throw new Error('Expected a value for the "put" command')
            }

            await client.putObject(key, val)
            console.log('Put object', key)
            break

        default:
            throw new Error(`Invalid command: ${command}`)
    }
}
