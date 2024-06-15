import * as zlib from 'node:zlib'
import { getLogger } from '../logging'

// Only covers happy paths
interface DownloadProgressListener {
    onStart: (path: string, size: number) => void
    onProgress: (path: string, bytes: number) => void
    onEnd: (path: string) => void
}

export function createRequester(baseUrl: string, listener?: DownloadProgressListener) {
    let idCounter = 0
    const queued: [id: number, fn: () => Promise<any>, resolve: any, reject: any, retryCount: number][] = []
    const pending = new Map<number, Promise<any>>()
    const maxConnections = 25

    const https = require('node:https') as typeof import('node:https')

    const agent = new https.Agent({ 
        keepAlive: true,
    })

    function run(fn: () => Promise<any>, id: number, retryCount: number) {
        const promise = fn()
            .catch(err => {
                // FIXME: should throw on most 4xx
                if ((err as any).statusCode === 400 || (err as any).statusCode === 401 || (err as any).statusCode === 403 || (err as any).statusCode === 404) {
                    throw err
                }

                let retryDelay = 250 * (retryCount + 1)
                if ((err as any).statusCode === 429) {
                    const retryAfter = (err as any).headers['retry-after']
                    const n = Number(retryAfter)
                    if (!isNaN(n)) {
                        getLogger().log(`Retrying after ${n} seconds`)
                        retryDelay = n * 1000
                    } else if (retryAfter) {
                        const d = new Date(retryAfter)
                        retryDelay = d.getTime() - Date.now()
                        getLogger().log(`Retrying after ${retryDelay} ms`)
                    }
                }
                if (retryCount > 3) {
                    throw err
                }

                getLogger().warn(`Retrying download due to error`, err)

                return new Promise<void>(r => setTimeout(r, retryDelay)).then(() => enqueue(fn, id, retryCount + 1))
            })
            .finally(() => complete(id))

        pending.set(id, promise)

        return promise
    }

    function complete(id: number) {
        pending.delete(id)
        while (queued.length > 0 && pending.size < maxConnections) {
            const [nid, nfn, resolve, reject, retryCount] = queued.shift()!
            run(nfn, nid, retryCount).then(resolve, reject)
        }
    }

    function enqueue(fn: () => Promise<any>, id = idCounter++, retryCount = 0): Promise<any> {
        if (pending.size >= maxConnections) {
            return new Promise<any>((resolve, reject) => {
                queued.push([id, fn, resolve, reject, retryCount])
            })
        } else {
            return run(fn, id, retryCount)
        }
    }

    function request(route: string, body?: any, unzip = false, opt?: { etag?: string; maxAge?: number; acceptGzip?: boolean, abortController?: AbortController; headers?: Record<string, string>; alwaysJson?: boolean }) {
        const [method, path] = route.split(' ')
        const url = new URL(path, baseUrl)
        const err = new Error()
        opt?.abortController?.signal.throwIfAborted()

        const doReq = () => new Promise<any>((resolve, reject) => {
            const headers: Record<string, string> = typeof body === 'object'
                ? { 'content-type': 'application/json', ...opt?.headers }
                : opt?.headers ?? {}

            headers['user-agent'] = 'synapse'

            if (opt?.etag) {
                headers['if-none-match'] = opt.etag
            }

            if (opt?.acceptGzip) {
                headers['accept-encoding'] = 'gzip'
            }

            const req = https.request(url, { method, headers, agent, signal: opt?.abortController?.signal }, resp => {
                const buffer: any[] = []
                const contentLength = resp.headers['content-length']
                if (listener && contentLength) {
                    listener.onStart(path, Number(contentLength))
                }

                const unzipStream = (unzip || resp.headers['content-encoding'] === 'gzip') ? zlib.createGunzip() : undefined

                unzipStream?.on('data', d => buffer.push(d))
                unzipStream?.on('end', () => {
                    if (resp.headers['content-type'] === 'application/json') {
                        resolve(JSON.parse(buffer.join('')))
                    } else {
                        resolve(Buffer.concat(buffer))
                    }
                })
                resp.on('data', d => {
                    if (unzipStream) {
                        unzipStream.write(d)
                    } else {
                        buffer.push(d)
                    }

                    if (listener && contentLength) {
                        listener.onProgress(path, d.length)
                    }
                })
                resp.on('end', () => {
                    if (!resp.statusCode) {
                        return reject(new Error('Response contained no status code'))
                    }

                    if (resp.statusCode >= 400) {
                        return reject(Object.assign(new Error(buffer.join('')), {
                            headers: resp.headers,
                            statusCode: resp.statusCode,
                            stack: err.stack,
                        }))
                    }

                    if (resp.statusCode === 302) {
                        return request(`${method} ${resp.headers['location']}`, undefined, undefined, opt).then(resolve, reject)
                    }

                    if (opt) {
                        opt.etag = resp.headers['etag']

                        if (resp.headers['cache-control']) {
                            const directives = resp.headers['cache-control'].split(',').map(x => x.trim())
                            const maxAge = directives.find(d => d.startsWith('max-age='))
                            if (maxAge) {
                                const seconds = Number(maxAge.slice('max-age='.length))
                                const age = Number(resp.headers['age'] || 0)
                                opt.maxAge = seconds - age
                            }
                        }
                    }

                    if (resp.statusCode === 304) {
                        return resolve(undefined)
                    }

                    if (listener && contentLength) {
                        listener.onEnd(path)
                    }

                    if (unzipStream) {
                        unzipStream.end()
                    } else if (resp.headers['content-type'] === 'application/json' || opt?.alwaysJson) {
                        resolve(JSON.parse(buffer.join('')))
                    } else {
                        resolve(Buffer.concat(buffer))
                    }
                })
                resp.on('error', reject)
            })

            if (typeof body === 'object') {
                req.end(JSON.stringify(body))
            } else {
                req.end(body)
            }
        })

        return enqueue(doReq)
    }

    return request
}

export function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const parsedUrl = new URL(url)
    const request = createRequester(parsedUrl.origin)

    // this is bad software. i'm making bad software
    return request(`GET ${parsedUrl.pathname}`, undefined, undefined, { headers, alwaysJson: true })
}

export function fetchData(url: string, headers?: Record<string, string>): Promise<Buffer> {
    const parsedUrl = new URL(url)
    const request = createRequester(parsedUrl.origin)

    return request(`GET ${parsedUrl.pathname}`, undefined, undefined, { headers, acceptGzip: true })
}