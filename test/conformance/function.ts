import * as compute from 'synapse:srl/compute'
import { Bucket } from 'synapse:srl/storage'
import { describe, it, test, expect, expectEqual } from 'synapse:test'

function sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms).unref())
}

describe('Function', () => {
    describe('arguments', () => {
        const noArgs = new compute.Function(() => 'hi')
        const sum = new compute.Function((a: number, b: number) => a + b)

        it('handles 0 arguments', async () => {
            expectEqual(await noArgs(), 'hi')
        })

        it('handles more than 1 argument', async () => {
            expectEqual(await sum(1, 2), 3)
        })
    })

    describe('serdes', () => {
        const echo = new compute.Function((req: any) => req)
        const cases: Record<string, any> = {
            'zero': 0,
            'number': 42,
            'string': 'hello, world!',
            'empty string': '',
            'array': [1, 2, 3],
            'heterogeneous array': [1, 'foo', { apple: 'sauce' }, [[null]]],
            'object': { foo: 'bar' },
            'nested object': { foo: 'bar', fizz: { buzz: 'buzz!' } },
            'null': null,
            'undefined': undefined,
            'true': true,
            'false': false,

            // TODO: typed arrays, bigint
        }

        for (const [k, v] of Object.entries(cases)) {
            test(k, async () => {
                expectEqual(await echo(v), v)
            })
        }
    })

    describe('invoke modes', () => {
        const b = new Bucket()
        const slowFn = new compute.Function(async (key: string, data: string) => {
            // Artifical delay. This number may need to be larger if running
            // these tests from a network with high latency. 
            await sleep(100)
            await b.put(key, data)
    
            return { key }
        })

        it('returns synchronously with `invoke`', async () => {
            const key = 'invoke'
            await b.delete(key)
    
            const timestamp = new Date().toISOString()
            const resp = await slowFn.invoke(key, timestamp)
            expectEqual(resp.key, key)
    
            const actual = await b.get(key, 'utf-8')
            expectEqual(actual, timestamp)
        })
    
        it('returns immediately with `invokeAsync`', async () => {
            const timeout = 2500
            const key = 'invokeAsync'
            await b.delete(key)
    
            const timestamp = new Date().toISOString()
            const resp = await slowFn.invokeAsync(key, timestamp)
            expectEqual(resp, undefined)
    
            const actual = await b.get(key, 'utf-8').catch(e => e)
            expect(actual instanceof Error)
            expectEqual(actual.name, 'NoSuchKey')
    
            const start = Date.now()
            while (Date.now() - start < timeout) {
                try {
                    const actual = await b.get(key, 'utf-8')
                    expectEqual(actual, timestamp)
                    return
                } catch (e) {
                    if ((e as any).name !== 'NoSuchKey') {
                        throw e
                    }
                }
    
                await sleep(250)
            }
    
            throw new Error(`Timed-out waiting for key "${key}" in bucket`)
        })    
    })

    describe('exceptions', () => {
        const throwSimple = new compute.Function((msg: string) => { throw new Error(msg) })

        it('can throw Error', async () => {
            const actual = await throwSimple('uh oh').catch(e => e)
            expect(actual instanceof Error)
            expectEqual(actual.message, 'uh oh')
        })

        class CustomError extends Error {
            public readonly name = 'CustomError'
            public readonly myErrorCode = 99
        }

        const throwCustom = new compute.Function(() => { throw new CustomError() })

        it('can throw subclasses of Error', async () => {
            const actual = await throwCustom().catch(e => e)
            // TODO: we don't use `instanceof CustomError` here because serdes for 
            // exact prototypes isn't implemented
            expectEqual(actual.name, 'CustomError')
            expectEqual(actual.myErrorCode, 99)
        })
    })

    describe('timeout', () => {
        const sleepyFn = new compute.Function(async () => { 
            await sleep(2500)
        }, { timeout: 1 })

        it('fails if the function takes too long', async () => {
            const actual = await sleepyFn().catch(e => e)
            expect(actual instanceof Error)
        })
    })
})
