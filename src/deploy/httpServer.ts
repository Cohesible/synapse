import type * as http from 'node:http'
// import * as http2 from 'http2'
import * as url from 'node:url'
import * as stream from 'node:stream'
import { getLogger } from '..'

// https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'HEAD' | 'DELETE' | 'PATCH' | string

type TrimRoute<T extends string> = T extends `${infer U}+` ? U : T
type ExtractPattern<T extends string> = T extends `${infer P}{${infer U}}${infer S}` ? TrimRoute<U> | ExtractPattern<P | S> : never
type CapturedPattern<T extends string> = { [P in ExtractPattern<T>]: string }
type RouteHandler<T extends string> = (request: HttpRequest<T>) => any

// /cars?color=blue&brand=ferrari

// type ExtractQuery<T extends string> = T extends `${infer K}=${infer V}&${infer R}` 
//     ? [[K, V], ...ExtractQuery<R>]
//     : T extends `${infer K}=${infer V}` ? [[K, V]] : []

// type CapturedQuery<T extends string> = { [P in ExtractPattern<T>]: string }


interface BaseHttpRequest<T extends string> {
    readonly request: http.IncomingMessage
    readonly path: T
    readonly method: HttpMethod
    readonly params: CapturedPattern<T>
    readonly query: string
    readonly queryParams: Record<string, string | string[]>
}

interface HttpRequest<T extends string> extends BaseHttpRequest<T> {
    readonly response: http.ServerResponse
}

interface HttpUpgrade<T extends string> extends BaseHttpRequest<T> {
    readonly socket: stream.Duplex
    readonly head: Buffer
}

interface StructuredHttpRequest<T extends string, U extends Record<string, any>> extends HttpRequest<T> {
    readonly body: U
}


interface Route<T extends string = string, U = unknown> {
    readonly path: T
    handleMessage(message: BaseHttpRequest<T>): U
}

export class HttpRoute<T extends string = string, U extends RouteHandler<T> = RouteHandler<T>> {
    public constructor(public readonly path: T, private readonly handler: U) {

    }

    public handleMessage(request: HttpRequest<T>) {
        return this.handler(request)
    }
}

interface HttpErrorProps {
    readonly code?: string
    readonly statusCode?: number
}

export class HttpError extends Error {
    public readonly code: string
    public readonly statusCode: number

    public constructor(message: string, private readonly props?: HttpErrorProps) {
        super(message)
        this.code = this.props?.code ?? 'UnknownError'
        this.statusCode = this.props?.statusCode ?? 500
    }

    public serialize() {
        return JSON.stringify({
            code: this.code,
            message: this.message,
            stack: this.stack,
        })
    }

    public static cast(e: unknown) {
        if (e instanceof this) {
            return e
        }

        if (e instanceof Error) {
            return Object.assign(new this(e.message), { stack: e.stack })
        }

        return new this(`Unknown error: ${e}`)
    }
}

function getHttp() {
    return require('node:http') as typeof import('node:http')
}

export class HttpServer {
    #requestCounter = 0
    readonly #server = getHttp().createServer()
    readonly #routes: Route[] = []
    readonly #patterns = new Map<Route, ReturnType<typeof buildRouteRegexp>>()
    readonly #pending = new Map<number, Promise<unknown>>()
    readonly #errors = new Map<string, unknown>()

    public constructor(private readonly options?: { readonly port: number }) {}

    public static fromRoutes<U extends Route[]>(...routes: U): HttpServer { // & ConvertRoutes<U> {
        const instance = new this()
        instance.#routes.push(...routes)
        routes.forEach(r => instance.#patterns.set(r, buildRouteRegexp(r.path)))

        return instance
    }

    public takeError(requestId: string): unknown | undefined {
        const err = this.#errors.get(requestId)
        if (err === undefined) {
            return
        }

        this.#errors.delete(requestId)
        return err
    }

    public async start(port?: number, hostname = 'localhost') {
        return new Promise<number>((resolve, reject) => {
            this.#server.on('error', reject)
            this.#server.listen(port ?? this.options?.port, hostname, () => {
                const addr = this.#server.address()
                if (typeof addr === 'string' || !addr) {
                    reject(new Error(`Unexpected server address: ${JSON.stringify(addr)}`))
                } else {
                    resolve(addr.port)
                }
            })

            this.#server.on('request', (req, res) => {
                function emitError(e: unknown, requestId: string) {
                    const err = HttpError.cast(e)
                    const blob = err.serialize()

                    res.writeHead(err.statusCode, { 
                        'content-type': 'application/json',
                        'content-length': blob.length,
                        'x-synapse-request-id': requestId,
                    })
                    res.end(blob)
                }

                const handleRequest = () => {
                    if (!req.url) {
                        throw new HttpError(`No url: ${req}`)
                    }
    
                    const { pathname, query } = url.parse(req.url)
                    if (!pathname) {
                        throw new HttpError(`No pathname: ${req.url}`)
                    }
    
                    const result = this.matchRoute(pathname)
                    if (!result) {
                        throw new HttpError(`No route found: ${pathname}`)
                    }
    
                    if (!(result.route instanceof HttpRoute)) {
                        throw new HttpError(`Not an http route: ${result.route.path}`)
                    }
    
                    return result.route.handleMessage({
                        request: req,
                        path: pathname,
                        params: result.match.groups,
                        query: query ?? '',
                        queryParams: {},
                        method: (req.method ?? 'unknown') as any,
                        response: res,
                    })
                }

                const requestId = this.#requestCounter += 1
                const p = handleRequest().catch((e: any) => {
                    const rId = `${requestId}`
                    this.#errors.set(rId, e)
                    emitError(e, rId)
                })

                this.#pending.set(requestId, p.finally(() => this.#pending.delete(requestId)))
            })
        })
    }

    public close(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            await Promise.all(this.#pending.values())

            this.#server.close(err => err ? reject(err) : resolve())
        })
    }

    private matchRoute(path: string) {
        const results = this.#routes.map(route => {
            const pattern = this.#patterns.get(route)!
            const match = pattern.exec(path)

            if (match) {
                return { route, match }
            }
        })

        return results.find(r => !!r)
    }
}

interface TypedRegExpExecArray<T extends Record<string, string>> extends RegExpExecArray {
    readonly groups: T
}

interface RouteRegexp<T extends string> extends RegExp {
    exec(string: string): TypedRegExpExecArray<CapturedPattern<T>> | null
}

function buildRouteRegexp<T extends string>(path: T): RouteRegexp<T> {
    const pattern = /{([A-Za-z0-9]+\+?)}/g
    const searchPatterns: string[] = []
    let match: RegExpExecArray | null
    let lastIndex = 0

    // TODO: handle duplicates
    while (match = pattern.exec(path)) {
        const isGreedy = match[1].endsWith('+')
        const name = isGreedy ? match[1].slice(0, -1) : match[1]

        searchPatterns.push(path.slice(lastIndex, match.index - 1))
        if (!isGreedy) {
            searchPatterns.push(`\\/(?<${name}>[^\\/\\s:]+\\/?)`)
        } else {
            searchPatterns.push(`\\/(?<${name}>[^\\s:]+)`)
        }
        lastIndex = pattern.lastIndex
    }

    if (lastIndex < path.length) {
        searchPatterns.push(path.slice(lastIndex))
    }

    searchPatterns.push('$')

    return new RegExp('^' + searchPatterns.join('')) as RouteRegexp<T>
}

export function receiveData(message: http.IncomingMessage): Promise<string> {
    const data: any[] = []

    return new Promise((resolve, reject) => {
        message.on('error', reject)
        message.on('data', chunk => data.push(chunk))
        message.on('end', () => resolve(data.join('')))
    })
}

export function sendResponse(response: http.ServerResponse, data?: any): Promise<void> {
    if (data === undefined) {
        return new Promise((resolve, reject) => {
            response.on('error', reject)
            response.writeHead(204)
            response.end(resolve)
        })
    }

    const contentType = typeof data === 'object' ? 'application/json' : 'application/octet-stream'
    const blob = typeof data === 'object' ? Buffer.from(JSON.stringify(data), 'utf-8') : Buffer.from(data)

    return new Promise((resolve, reject) => {
        response.on('error', reject)
        response.writeHead(200, { 
            'Content-Type': contentType,
            'Content-Length': blob.length,
        })
        response.end(blob, resolve)
    })
}

type WebSocketRouteHandler<T extends string> = (params: CapturedPattern<T>, socket: WebSocket) => any



// type Http2RouteHandler<T extends string> = (stream: Http2Stream<T>) => any

// interface Http2Stream<T extends string> {
//     readonly params: CapturedPattern<T>
//     readonly stream: http2.ServerHttp2Stream
// }

// export class Http2Route<T extends string = string, U extends Http2RouteHandler<T> = Http2RouteHandler<T>> {
//     public constructor(public readonly path: T, private readonly handler: U) {

//     }

//     public handleMessage(stream: Http2Stream<T>) {
//         this.handler(stream)
//     }
// }

// interface Http2Route2<T extends string = string> {
//     readonly path: T
//     handleMessage(stream: Http2Stream<T>): any
// }


// export class Http2Server {
//     readonly #routes: Http2Route2[] = []
//     readonly #patterns = new Map<Http2Route2, ReturnType<typeof buildRouteRegexp>>()

//     public constructor(private readonly options?: { readonly port: number }) {

//     }

//     public static fromRoutes<U extends Http2Route2[]>(...routes: U): Http2Server { 
//         const instance = new this()
//         instance.#routes.push(...routes)
//         routes.forEach(r => instance.#patterns.set(r, buildRouteRegexp(r.path)))

//         return instance
//     }

//     public listen(port = this.options?.port ?? 80) {
//         this.server.listen(port)
//         this.server.on('stream', (stream, headers) => {
//             function destroy(err?: Error): never {
//                 stream.destroy(err)
//                 throw err
//             }

//             const method = headers[http2.constants.HTTP2_HEADER_METHOD]
//             const path = headers[http2.constants.HTTP2_HEADER_PATH]
//             if (typeof method !== 'string') {
//                 destroy(new Error(`Method was not a string: ${method}`))
//             } else if (typeof path !== 'string') {
//                 destroy(new Error(`Path was not a string: ${path}`))
//             }

//             const result = this.matchRoute(path)
//             if (!result) {
//                 destroy(new Error(`No route found: ${path}`))
//             }

//             result.route.handleMessage({
//                 stream,
//                 params: result.match.groups,
//             })
//         })
//     }

//     #server?: http2.Http2Server
//     private get server() {
//         return this.#server ??= http2.createServer()
//     }

//     private matchRoute(path: string) {
//         const results = this.#routes.map(route => {
//             const pattern = this.#patterns.get(route)!
//             const match = pattern.exec(path)

//             if (match) {
//                 return { route, match }
//             }
//         })

//         return results.find(r => !!r)
//     }
// }
