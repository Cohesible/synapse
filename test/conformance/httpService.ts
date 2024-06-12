import * as http from 'synapse:http'
import * as compute from 'synapse:srl/compute'
import { describe, it, expect, expectEqual } from 'synapse:test'

describe('HttpService', () => {
    const service = new compute.HttpService()
    const helloRoute = service.addRoute('GET /hello/{name}', req => {
        return `Hello, ${req.pathParameters.name}!`
    })

    it('uses path parameters', async () => {
        expectEqual(await http.fetch(helloRoute, 'world'), 'Hello, world!')
    })

    const someData = Buffer.from('foo')
    const binaryRoute = service.addRoute('GET /binary', req => {
        return new Response(someData, {
            headers: {
                'content-type': 'application/octet-stream'
            }
        })
    })

    it('can return binary data', async () => {
        const actual = await http.fetch(binaryRoute)
        expect(actual instanceof Buffer)
    })

    describe('HttpError', () => {
        const errorRoute = service.addRoute('GET /error', req => {
            throw new http.HttpError('Nope', {
                status: 400,
            })
        })
    
        it('converts HttpError into a response', async () => {
            const actual = await http.fetch(errorRoute).catch(e => e)
            expectEqual(actual.statusCode, 400)
        })
    })

    describe('request bodies', () => {
        const jsonRequestRoute = service.addRoute('POST /hello', (req, body: { name: string }) => {
            return `Hello, ${body.name}!`
        })

        it('handles JSON requests', async () => {
            expectEqual(await http.fetch(jsonRequestRoute, { name: 'world' }), 'Hello, world!')
        })
    })
})
