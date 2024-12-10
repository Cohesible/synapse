import * as http from 'synapse:http'
import * as stream from 'node:stream/web'
import * as compute from 'synapse:srl/compute'
import { describe, it, expect, expectEqual } from 'synapse:test'

// When running this test on AWS it will sometimes fail on the first run
// due to 404s. Might need to add a "validation" resource.
describe('HttpService', () => {
    const service = new compute.HttpService()
    const helloRoute = service.route('GET', '/hello/{name}', req => {
        const params = new URL(req.url).searchParams
        const exclaim = Number(params.get('exclaim'))
        const exclaimAmount = isNaN(exclaim) || exclaim <= 0 ? 1 : exclaim

        return `Hello, ${req.pathParameters.name}${'!'.repeat(exclaimAmount)}`
    })

    it('uses path parameters', async () => {
        expectEqual(await http.fetch(helloRoute, 'world'), 'Hello, world!')
    })

    it('uses query parameters', async () => {
        const url = new URL('hello/world?exclaim=3', service.invokeUrl)
        expectEqual(await http.fetch(url.toString()), 'Hello, world!!!')
    })

    const someData = Buffer.from('foo')
    const binaryRoute = service.route('GET', '/binary', req => {
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

    const nothingRoute = service.route('GET', '/nothing', req => {})

    it('can return nothing', async () => {
        const actual = await http.fetch(nothingRoute)
        expectEqual(actual, undefined)
    })

    const blobResponseRoute = service.route('POST', '/blob', req => req.blob())

    it('can return blobs', async () => {
        const data = Buffer.from('foo')
        // TODO: types are wrong
        const resp = await http.fetch(blobResponseRoute, data)
        expectEqual((resp as any).toString(), 'foo')
    })

    describe('HttpError', () => {
        const errorRoute = service.route('GET', '/error', req => {
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
        const jsonRequestRoute = service.route('POST', '/hello', (req, body: { name: string }) => {
            return `Hello, ${body.name}!`
        })

        it('handles JSON requests', async () => {
            expectEqual(await http.fetch(jsonRequestRoute, { name: 'world' }), 'Hello, world!')
        })

        const dataRequestRoute = service.route('POST', '/data', async (req) => {
            const buf = await req.arrayBuffer()
            return { size: buf.byteLength }
        })

        it('handles data requests', async () => {
            const data = Buffer.from('foo')
            expectEqual(await http.fetch(dataRequestRoute, data), { size: data.byteLength })
        })

        const echoRoute = service.route('POST', '/echo', (req, body: any) => body)

        it('handles strings', async () => {
            const data = 'foo'
            expectEqual(await http.fetch(echoRoute, data), data)
        })

        // TODO: add recursion detection in library code
        const recursive = service.route('GET', '/recursive/{count}', async (req): Promise<number> => {
            const { count } = req.pathParameters
            const num = Number(count)
            if (isNaN(num) || num < 0) {
                return -1
            }

            if (num > 1) {
                return num
            }

            return http.fetch(recursive, String(num + 1))
        })

        it('handles recursive calls', async () => {
            const resp = await http.fetch(recursive, '0')
            expectEqual(resp, 2)
        })
    })

    describe('auth', () => {
        const mySecret = 'secret'
        const service = new compute.HttpService({
            auth: (req) => {
                const auth = req.headers.get('authorization')
                if (auth !== mySecret) {
                    return new Response(undefined, { status: 403 })
                }
            },
        })

        const route = service.route('GET', '/data', () => 'data')

        it('calls custom auth function', async () => {
            const resp = await http.fetch(route).catch(e => e)
            expect(resp instanceof Error)
            expectEqual((resp as any).statusCode, 403)

            const fetcher = http.createFetcher({ headers: { authorization: mySecret } })
            const data = await fetcher.fetch(route)
            expectEqual(data, 'data')
        })
    })

    describe('streams', () => {
        const supportsStreaming = process.env.SYNAPSE_TARGET === 'local'
        const streamRoute = service.route('POST', '/chunks', async req => {
            const chunks: any[] = []
            for await (const chunk of req.body!) {
                chunks.push(chunk)
            }

            return {
                count: chunks.length,
                data: Buffer.concat(chunks).toString('utf-8'),
            }
        })

        it('handles sending streamed data', async () => {
            const chunkCount = 10
            const chunks = stream.ReadableStream.from((async function* () {
                for (let i = 0; i < chunkCount; i++) {
                    yield `foo-${i}`
                }
            })())

            const resp = await http.fetch(streamRoute, chunks)
            const output = new Array(10).fill(0).map((_, i) => `foo-${i}`).join('')
            expectEqual(resp.count, supportsStreaming ? chunkCount : 1)
            expectEqual(resp.data, output)
        })
    })
})
