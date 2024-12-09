import { HttpService } from 'synapse:srl/compute'
import { Bucket } from 'synapse:srl/storage'
import { fetch, HttpError } from 'synapse:http'

const bucket = new Bucket()
const service = new HttpService({ auth: 'none' })

const getRoute = service.route('GET', '/{key+}', async req => {
    const { key } = req.pathParameters
    const data = await bucket.get(key, 'utf-8')
    if (data === undefined) {
        throw new HttpError(`Key not found: ${key}`, { status: 404 })
    }

    return data
})

const putRoute = service.route('PUT', '/{key+}', async (req, body: string) => {
    const { key } = req.pathParameters
    await bucket.put(key, body)
})

export function createClient() {
    async function getObject(key: string): Promise<string> {
        return fetch(getRoute, key)
    }

    async function putObject(key: string, obj: string): Promise<void> {
        await fetch(putRoute, key, obj)
    }

    return { getObject, putObject }
}
