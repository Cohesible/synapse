//# moduleId = synapse:http
//# transform = persist

import * as http from 'node:https'
import * as zlib from 'node:zlib'
import * as crypto from 'node:crypto'
import * as stream from 'node:stream'
import { addBrowserImplementation } from 'synapse:core'

type TypedArray =
    | Uint8Array
    | Uint8ClampedArray
    | Uint16Array
    | Uint32Array
    | Int8Array
    | Int16Array
    | Int32Array
    | BigUint64Array
    | BigInt64Array
    | Float32Array
    | Float64Array

type ZlibInputType = string | TypedArray | ArrayBuffer | DataView

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'HEAD' | 'DELETE' | 'PATCH' | string
type TrimRoute<T extends string> = T extends `${infer U}${'+' | '*'}` ? U : T
type ExtractPattern<T extends string> = T extends `${infer P}{${infer U}}${infer S}` ? TrimRoute<U> | ExtractPattern<P | S> : never
export type CapturedPattern<T extends string> = string extends T ? Record<string, string> : { [P in ExtractPattern<T>]: string }
type SplitRoute<T extends string> = T extends `${infer M extends HttpMethod} ${infer P}` ? [M, P] : [string, T]

export type PathArgs<T extends string> = T extends `${infer P}{${infer U}}${infer S}` 
    ? [...PathArgs<P>, string, ...PathArgs<S>] 
    : []

export type PathArgsWithBody<T extends string, U> = [
    ...PathArgs<T>, 
    ...(U extends undefined ? [body?: U] : unknown extends U ? [body?: any] : [body: U])
]

export interface HttpRequest<T extends string = string> {
    readonly path: string
    readonly method: SplitRoute<T>[0]
    readonly headers: Request['headers']
    readonly cookies?: string[]
    readonly context?: any
    readonly queryString?: string
    readonly pathParameters: CapturedPattern<SplitRoute<T>[1]>
}

export interface TypedRequest<T extends string = string> extends Request {
    readonly method: SplitRoute<T>[0]
    readonly pathParameters: CapturedPattern<SplitRoute<T>[1]>
    readonly body: (Request['body'] & AsyncIterable<Uint8Array>) | null
    readonly context?: any
}

// TODO: we should use `Blob` instead of `Buffer` for `application/octet-stream` with known sizes
// Unfortunately `Blob` doesn't support purely streamed data with unknown initial sizes. So we'll
// need to use a special-case of `Blob` that has `size` optional. `slice` can technically work
// too because the spec allows for ranges beyond the true size of the blob.
//
// Summary: use `StreamedBlob` for all binary data
interface StreamedBlob extends Omit<Blob, 'size'>{
    readonly size?: number
}

export type RequestHandler<T extends string = string, R = unknown> = 
    (request: TypedRequest<T>) => Promise<HandlerResponse<R>> | HandlerResponse<R>

export type RequestHandlerWithBody<T extends string = string, U = any, R = unknown> = 
    (request: TypedRequest<T>, body: U) => Promise<HandlerResponse<R>> | HandlerResponse<R>

// type FormDataValue = string | Blob | File
// type TypedFormData<T extends Record<string, FormDataValue | FormDataValue[]>> = FormData & {
//     [Symbol.iterator](): IterableIterator<[string, FormDataEntryValue]>;
//     /** Returns an array of key, value pairs for every entry in the list. */
//     entries(): IterableIterator<[string, FormDataEntryValue]>;
//     /** Returns a list of keys in the list. */
//     keys(): IterableIterator<string>;
//     /** Returns a list of values in the list. */
//     values(): IterableIterator<FormDataEntryValue>;
// }

// type TypedJsonBody<T> = Omit<Body, 'json'> & { json(): Promise<T> }
// type TypedJsonResponse<T> = Omit<Response, 'json'> & { json(): Promise<T> }

type HandlerResponse<R> = Response | R | void // JsonResponse<R> | R | void
type HandlerArgs<T extends string, U> = U extends undefined ? [request: HttpRequest<T>] : [request: HttpRequest<T>, body: U]
export type HttpHandler<T extends string = string, U = any, R = unknown, C = void> = 
    (this: C, ...args: HandlerArgs<T, U>) => Promise<HandlerResponse<R>> | HandlerResponse<R>

export type HttpFetcher<T extends string = string, U = any, R = unknown> = 
    (...args: [...PathArgs<T>, ...(U extends undefined ? [] : [body: U])]) => Promise<R>

interface BindingBase {
    from: string // JSONPath
    to: string // JSONPath
}

interface PathBinding extends BindingBase {
    type: 'path'
}

interface QueryBinding extends BindingBase {
    type: 'query'
}

interface HeaderBinding extends BindingBase {
    type: 'header'
}

interface BodyBinding extends BindingBase {
    type: 'body'
}

type HttpBinding = PathBinding | QueryBinding | HeaderBinding | BodyBinding

export interface HttpRoute<T extends any[] = any[], R = any> {
    readonly host: string
    readonly port?: number
    readonly method: string
    readonly path: string
    readonly query?: string
    readonly body?: any
    readonly bindings: {
        readonly request: HttpBinding[]
        readonly response: HttpBinding[]
    }

    // "Phantom" fields to force type coercion
    // These will never have a value in practice
    readonly _args?: T
    readonly _body?: R
}

// FIXME: make this more robust
function isRoute(obj: unknown): obj is HttpRoute {
    return typeof obj === 'object' && !!obj && typeof (obj as any)['bindings'] === 'object' && !!(obj as any)['bindings']
}

export interface HttpResponse {
    body?: any
    statusCode?: number
    headers?: Record<string, string>
}

export type SubstituteRoute<T extends string, Root = true> = T extends `${infer L}{${infer U}}${infer R}`
    ? Root extends true 
        ? (`${SubstituteRoute<L, false>}${string}${SubstituteRoute<R, false>}` | `${SubstituteRoute<L, false>}${string}${SubstituteRoute<R, false>}?${string}`)
        : `${SubstituteRoute<L, false>}${string}${SubstituteRoute<R, false>}`
    : Root extends true ? (`${T}?${string}` | T) : T

export type RequestArgs<T> = T extends HttpHandler<infer _, infer U> ? 
    U extends undefined 
        ? [] 
        : any extends U ? [body?: any] : [body: U] : never


export interface HttpErrorFields {
    /** 
     * @internal
     * @deprecated 
     */
    statusCode: number
    status: number
}

export class HttpError extends Error {
    public readonly fields: HttpErrorFields
    public constructor(message: string, fields: Partial<HttpErrorFields> = {}) {
        super(message)
        this.fields = { status: 500, statusCode: 500, ...fields }
        // Backwards compat
        this.fields.statusCode = fields.statusCode ?? fields.status ?? 500
    }
}

/** @internal */
export type Middleware<T extends string = any, U = any> = (
    req: HttpRequest<T>,
    body: U,
    next: HttpHandler<T, U>
) => HttpResponse | Promise<HttpResponse>

interface TypedRegExpExecArray<T extends Record<string, string>> extends RegExpExecArray {
    readonly groups: T
}

/** @internal */
export interface TypedRegexp<T extends Record<string, string>> extends RegExp {
    exec(string: string): TypedRegExpExecArray<T> | null
}

/** @internal */
export interface RouteRegexp<T extends string = string> extends RegExp {
    exec(string: string): TypedRegExpExecArray<CapturedPattern<T>> | null
}

export function buildRouteRegexp<T extends string>(path: T, prefix?: string): RouteRegexp<T> {
    const pattern = /{([A-Za-z0-9]+)([\+\*])?}/g
    const searchPatterns: string[] = []
    let match: RegExpExecArray | null
    let lastIndex = 0

    // TODO: handle duplicates
    while (match = pattern.exec(path)) {
        const qualifer = match[2]
        const name = match[1]

        searchPatterns.push(path.slice(lastIndex, match.index).replace(/\//g, '\\/'))
        if (!qualifer) {
            searchPatterns.push(`(?<${name}>[^\\/\\s:]+\\/?)`)
        } else {
            searchPatterns.push(`(?<${name}>[^\\s:]${qualifer})`)
        }
        lastIndex = pattern.lastIndex
    }

    if (lastIndex < path.length) {
        searchPatterns.push(path.slice(lastIndex))
    }

    searchPatterns.push('$')

    return new RegExp(`^${prefix ?? ''}` + searchPatterns.join('')) as RouteRegexp<T>
}

export function* matchRoutes<T>(path: string, entries: readonly [pattern: RegExp, value: T][]) {
    for (const [pattern, value] of entries) {
        const match = pattern.exec(path)

        if (match) {
            yield { value, match }
        }
    }
}

function parseSegment(segment: string) {
    const pattern = /{([A-Za-z0-9]+)([\+\*])?}/g
    const parts: ({ type: 'literal'; value: string } | { type: 'pattern'; value: { qualifier?: '*' | '+' } })[] = []

    let match: RegExpExecArray | null
    let lastIndex = 0

    while (match = pattern.exec(segment)) {
        const qualifier = match[2] as '+' | '*' | undefined
        const name = match[1]

        if (match.index !== 0) {
            parts.push({
                type: 'literal',
                value: segment.slice(lastIndex, match.index),
            })
        }

        parts.push({
            type: 'pattern',
            value: { qualifier },
        })

        lastIndex = pattern.lastIndex
    }

    if (lastIndex < segment.length) {
        parts.push({
            type: 'literal',
            value: segment.slice(lastIndex),
        })
    }

    return parts
}

// TODO: `+` should take precdence over `*`
// e.g. `/{foo+}` > `/{foo*}`
// or make it so these routes are incompatible. That's probably smarter.
function compareSegment(a: string, b: string): number {
    const pa = parseSegment(a)
    const pb = parseSegment(b)

    if (pa.length > pb.length) {
        return -compareSegment(b, a)
    }

    for (let i = 0; i < pa.length; i++) {
        const ai = pa[i]
        const bi = pb[i]

        if (ai.type === 'pattern' && bi.type === 'literal') {
            return -1
        } else if (ai.type === 'literal' && bi.type === 'pattern') {
            return 1
        } else if (ai.type === 'literal' && bi.type === 'literal') {
            const d = ai.value.length - bi.value.length
            if (d !== 0) {
                return d
            }
        }   
    }
    
    if (pa[pa.length - 1].type === 'literal') {
        return 1
    }

    return 0
}

export function compareRoutes(a: string, b: string) {
    const diff = a.split('/').length - b.split('/').length
    if (diff === 0) {
        return compareSegment(a, b)
    }

    return diff
}

const TypedArray = Object.getPrototypeOf(Uint8Array)
function isTypedArray(obj: any) {
    return obj instanceof TypedArray
}

function resolveBody(body: any) {
    if (body === undefined) {
        return
    }

    if (typeof body === 'string' || typeof body === 'number' || typeof body === 'boolean') {
        return {
            contentType: 'application/json',
            body: JSON.stringify(body),
        }
    }

    if (typeof body !== 'object') {
        return { body }
    }

    if (body === null) {
        return {
            contentType: 'application/json',
            body: 'null'
        }
    }

    if (body instanceof ArrayBuffer) {
        return { 
            body: typeof Buffer !== 'undefined' ? Buffer.from(body) : body,
        }
    }

    if (isTypedArray(body)) {
        const contentEncoding = body[contentEncodingSym]

        return {
            body,
            contentEncoding,
        }
    }

    if (body instanceof ReadableStream) {
        return {
            contentType: 'application/octet-stream',
            body,
        }
    }

    if (body instanceof URLSearchParams) {
        return {
            contentType: 'application/x-www-form-urlencoded',
            body: body.toString()
        }
    }

    return {
        contentType: 'application/json',
        body: typeof Buffer !== 'undefined' 
            ? Buffer.from(JSON.stringify(body), 'utf-8').toString('utf-8')
            : JSON.stringify(body)
    }
}

function parseContentType(header: string) {
    const directives = header.split(';')
    const mimeType = directives[0].trim()
    const remainder = directives.slice(1).map(d => {
        const match = d.trim().match(/(?<key>.*)=(?<value>.*)/) as TypedRegExpExecArray<{ key: string; value: string }> | null

        return match?.groups
    })

    const encoding = remainder.find(d => d?.key === 'charset')?.value
    const boundary = remainder.find(d => d?.key === 'boundary')?.value

    return {
        mimeType,
        encoding,
        boundary,
    }
}

function isJsonMimeType(mimeType: string) {
    const match = mimeType.match(/application\/(?:([^+\s]+)\+)?json/)
    
    return !!match
}

function filterUndefined<T extends Record<string, any>>(obj: T): { [P in keyof T]+?: NonNullable<T[P]> } {
    return Object.fromEntries(Object.entries(obj).filter(([k, v]) => v !== undefined)) as any
}

function toLowerCase<T extends Record<string, any>>(obj: T): { [P in keyof T & string as Lowercase<P>]+?: T[P] } {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])) as any
}

const contentEncodingSym = Symbol.for('contentEncoding')

/** @internal */
export function encode(data: ZlibInputType, encoding: 'gzip' | 'br' = 'gzip') {
    const encodeFn = encoding === 'gzip' ? zlib.gzip : zlib.brotliCompress

    return new Promise<Uint8Array>((resolve, reject) => encodeFn(data, (err, res) => {
        if (err) {
            reject(err)
        } else {
            Object.defineProperty(res, contentEncodingSym, {
                value: encoding,
                configurable: true,
                enumerable: false,
                writable: false,
            })
            resolve(res)
        }
    }))
}

function getDecodeFn(encoding: 'gzip' | 'br' | 'deflate') {
    switch (encoding) {
        case 'gzip':
            return zlib.gunzip
        case 'br':
            return zlib.brotliDecompress
        case 'deflate':
            return zlib.deflate
        default:
            throw new Error(`Unsupported encoding: ${encoding}`)
    }
}

/** @internal */
export function decode(data: ZlibInputType, encoding: 'gzip' | 'br' | 'identity') {
    if (encoding === 'identity') {
        return Promise.resolve(Buffer.from(data as string) as Uint8Array)
    }

    const decodeFn = getDecodeFn(encoding)

    return new Promise<Uint8Array>((resolve, reject) => decodeFn(data, (err, res) => {
        if (err) {
            reject(err)
        } else {
            resolve(res)
        }
    }))
}

// TODO: need caching to avoid infinitely recursive queries when adding the logger to the DNS service
function createDnsResolver() {
    // http.globalAgent.options.lookup
}

export function createFetcher(init?: Pick<FetchInit, 'headers'>) {
    async function doFetch<T extends any[] = [], R = unknown>(route: HttpRoute<T, R>, ...args: T): Promise<R> {
        const { request, body } = applyRoute(route, args)

        if (init?.headers) {
            request.headers ??= {}
            request.headers = { ...init.headers, ...request.headers }
        }

        return doRequest(request, body)
    }

    return { fetch: doFetch }
}

interface FetchInit {
    body?: any
    baseUrl?: string
    method?: string
    headers?: Record<string, string>
}

export function fetch<T extends any[] = []>(route: HttpRoute<T, Response>, ...request: T): Promise<Buffer>
export function fetch<T extends any[] = [], R = unknown>(route: HttpRoute<T, R>, ...request: T): Promise<R>
export function fetch(url: string, init?: FetchInit): Promise<any>
export async function fetch(urlOrRoute: string | HttpRoute, ...args: [init?: FetchInit] | any[]): Promise<any> {
    if (isRoute(urlOrRoute)) {
        const { request, body } = applyRoute(urlOrRoute, args)
        const resp = await doRequest(request, body)
        // TODO: response bindings

        return resp
    }

    let url = urlOrRoute
    const init = args[0] as FetchInit
    const method = init?.method ?? (!url.startsWith('/') && url.includes(' ') ? url.split(' ')[0] : 'GET')
    if (!method) {
        throw new Error(`No method provided`)
    }

    if (url.includes(' ')) url = url.split(' ')[1]
    if (init?.baseUrl) url = init.baseUrl + url

    const parsedUrl = new URL(url)
    const resolvedBody = resolveBody(init?.body)
    const headers = filterUndefined({
        'content-type': resolvedBody?.contentType,
        'content-encoding': resolvedBody?.contentEncoding,
        'accept-encoding': 'br, gzip, deflate',
        ...(init?.headers ? toLowerCase(init.headers) : undefined),
    })

    return doRequest({
        method,
        headers,
        host: parsedUrl.host,
        hostname: parsedUrl.hostname, // XXX: added to make `localhost:${port}` work
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        protocol: parsedUrl.protocol,
        search: parsedUrl.search, // not sure if this is correct
    }, resolvedBody?.body)
}

interface AppliedRoute {
    method?: string
    host?: string
    port?: number
    path?: string
    protocol: string
    headers?: Record<string, string>
}

export function applyRoute(route: HttpRoute, args: any[]) {
    const pathBindings = route.bindings.request.filter(b => b.type === 'path') as PathBinding[]
    const body = route.body !== undefined 
        ? substitutePaths(route.body, args)
        : undefined

    const resolvedBody = resolveBody(body)

    const headerBindings = route.bindings.request.filter(b => b.type === 'header') as HeaderBinding[]

    const request: AppliedRoute = {
        method: route.method,
        host: route.host,
        port: route.port,
        path: subsitutePathTemplate(route.path, pathBindings, args),
        // hostname: parsedUrl.hostname, // TODO: add this so it works w/ the VSC ext proxy agent
        // XXX: hack to make local impl. work
        protocol: route.host === 'localhost' ? 'http:' : 'https:',
        headers: filterUndefined({
            ...resolveHeaderBindings(headerBindings),
            'content-type': resolvedBody?.contentType,
            'content-encoding': resolvedBody?.contentEncoding,
        })
    }

    return { request, body: resolvedBody?.body }
}

function resolveHeaderBindings(bindings: HeaderBinding[]) {
    if (bindings.length === 0) {
        return 
    }

    const headers: Record<string, string> = {}
    for (const b of bindings) {
        if (b.from === 'randomUUID()') {
            headers[b.to] = randomUUID()
        } else {
            throw new Error(`Unknown binding: ${b.from}`)
        }
    }

    return headers
}

function randomUUID(): string {
    return crypto.randomUUID()
}

function randomUUIDBrowser() {
    return self.crypto.randomUUID()
}

addBrowserImplementation(randomUUID, randomUUIDBrowser)


function getResourceFromOptions(opt: http.RequestOptions) {
    const protocol = opt.protocol ?? 'https:'
    const host = `${opt.host}${opt.port ? `:${opt.port}` : ''}` ?? opt.hostname
    if (host) {
        return `${protocol}//${host}${opt.path ?? ''}`
    }

    if (!opt.path) {
        throw new Error('Unable to create URL from request: no pathname specified')
    }

    return opt.path
}

const _fetch = globalThis.fetch
async function sendFetchRequest(request: http.RequestOptions | URL, body?: any) {
    if (request instanceof URL) {
        return _fetch(request, { body })
    }

    const resource = getResourceFromOptions(request)
    return _fetch(resource, {
        body,
        method: request.method,
        headers: request.headers 
            ? new Headers(filterUndefined(request.headers) as Record<string, string>) 
            : undefined,
    })
}

async function doRequestBrowser(request: http.RequestOptions | URL, body?: any) {
    const resp = await sendFetchRequest(request, body)
    const contentTypeRaw = resp.headers.get('content-type')
    const contentType = contentTypeRaw ? parseContentType(contentTypeRaw) : undefined
    const isJson = contentType ? isJsonMimeType(contentType.mimeType) : false

    // TODO: handle content encodings other than utf-8 for JSON?
    const data = await (isJson ? resp.json() : resp.text())

    if (resp.status >= 400) {
        if (isJson && data) {
            throw Object.assign(
                new Error(data.message ?? `Received non-2xx status code: ${resp.status} [${resp.statusText}]`), 
                { statusCode: resp.status }, 
                data
            )
        } else {
            throw Object.assign(
                new Error(`Received non-2xx status code: ${resp.status} [${resp.statusText}]`), 
                { statusCode: resp.status, message: data }, 
            )
        }
    } else if (resp.status === 302 || resp.status === 303) {
        // TODO: follow redirect?
        throw new Error(`Received redirect: ${resp.headers.get('location')}`)
    }

    return data
}

addBrowserImplementation(doRequest, doRequestBrowser)

const agents = new Map<typeof import('node:https'), http.Agent>()
function getAgent(http: typeof import('node:https')) {
    const existing = agents.get(http)
    if (existing) {
        return existing
    }

    const agent = new http.Agent({ 
        keepAlive: true,
    })
    agents.set(http, agent)

    return agent
}

function tryParseRetryAfter(val: string | undefined) {
    if (!val) {
        return
    }

    const num = Number(val)
    if (!isNaN(num)) {
        return num >= 0 ? num * 1000 : undefined
    }

    const date = new Date(val)

    return Date.now() - date.getTime()
}

function doRequest(request: http.RequestOptions | URL, body?: any) {
    // We create an error here to preserve the trace
    const err = new Error()

    return new Promise<any>((resolve, reject) => {
        const http: typeof import('node:https') = request.protocol === 'http:' ? require('node:http') : require('node:https')

        if (!(request instanceof URL) && !request.agent) {
            request.agent = getAgent(http)
        }

        if (!(request instanceof URL) && (request as any).search && !request.path?.includes('?')) {
            request.path = `${request.path}${(request as any).search}`
        }

        const req = http.request(request, res => {
            const contentType = res.headers['content-type'] ? parseContentType(res.headers['content-type']) : undefined
            const contentEncoding = res.headers['content-encoding']
            const isJson = contentType ? isJsonMimeType(contentType.mimeType) : false
            const buffers: Buffer[] = []

            function close(val: any, code?: number) {
                if (val instanceof Error) {
                    reject(val)
                } else {
                    if (code === 204 && !val) {
                        resolve(undefined)
                    } else {
                        resolve(val)
                    }
                }

                res.destroy()
            }

            res.on('data', d => buffers.push(d))
            res.on('error', close)
            res.on('end', async () => {
                const result = Buffer.concat(buffers)
                const decoded = contentEncoding 
                    ? ((await decode(result, contentEncoding as any) as Buffer)) // XXX: `as Buffer` is not safe
                    : result

                if (res.statusCode && res.statusCode >= 400) {
                    if (res.statusCode === 429 || res.statusCode === 503) {
                        const retryAfter = tryParseRetryAfter(res.headers['retry-after'])
                        if (retryAfter !== undefined) {
                            setTimeout(() => {
                                // TODO: original stack trace is lost here
                                doRequest(request, body).then(resolve, reject)
                            }, retryAfter)

                            return
                        }
                    }

                    if (isJson && result) {
                        let e: any | undefined
                        try {
                            e = JSON.parse(decoded.toString('utf-8'))
                        } catch (parseErr) {
                            e = new Error(decoded.toString('utf-8'))
                        }

                        err.message = e.message ?? `Received non-2xx status code: ${res.statusCode}`
                        const stack = `${e.name ?? 'Error'}: ${err.message}\n` + err.stack?.split('\n').slice(1).join('\n')
                        close(Object.assign(err, { statusCode: res.statusCode, stack }, e))
                    } else {
                        err.message = decoded.toString('utf-8')
                        const stack = `${err.name ?? 'Error'}: ${err.message}\n` + err.stack?.split('\n').slice(1).join('\n')
                        close(Object.assign(err, { statusCode: res.statusCode, stack }))
                    }
                } else if (res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 304) {
                    close({
                        statusCode: res.statusCode,
                        headers: res.headers,
                    })
                } else {
                    if (isJson) {
                        close(decoded ? JSON.parse(decoded.toString('utf-8')) : undefined, res.statusCode)
                    } else if (res.headers['content-type'] === 'application/octet-stream') {
                        close(decoded, res.statusCode)
                    } else {
                        close(decoded.toString('utf-8'), res.statusCode)
                    }
                }
            })
        })

        req.on('error', reject)

        if (body instanceof ReadableStream) {
            stream.Readable.fromWeb(body as any).pipe(req)
        } else {
            req.end(body)
        }
    })
}

function substitutePaths(template: any, args: any[]): any {
    if (typeof template === 'string') {
        return getPath(args, template)
    }

    if (Array.isArray(template)) {
        return template.map(x => substitutePaths(x, args))
    }

    if (typeof template === 'object' && !!template) {
        const res = { ...template }
        for (const [k, v] of Object.entries(res)) {
            res[k] = substitutePaths(v, args)
        }

        return res
    }

    return template
}

export function createPathBindings(pathTemplate: string) {
    const pattern = /{([A-Za-z0-9]+\+?)}/g
    const result: PathBinding[] = []
    let match: RegExpExecArray | null

    while (match = pattern.exec(pathTemplate)) {
        result.push({ 
            type: 'path', 
            from: `$[${result.length}]`, // This is the naive solution (no duplicates)
            to: match[1],
        })
    }

    return result
}

function subsitutePathTemplate(pathTemplate: string, bindings: PathBinding[], args: any[]) {
    const pattern = /{([A-Za-z0-9]+\+?)}/g
    const result: string[] = []
    let match: RegExpExecArray | null
    let lastIndex = 0

    while (match = pattern.exec(pathTemplate)) {
        const binding = bindings.find(b => b.to === match![1])
        if (!binding) {
            throw new Error(`Missing binding for path pattern: ${match[1]}`)
        }

        result.push(pathTemplate.slice(lastIndex, match.index))

        const val = getPath(args, binding.from)
        if (typeof val !== 'string') {
            throw new Error(`Invalid path binding for "${match[1]}". Expected type string, got ${typeof val}`)
        }

        result.push(val)
        lastIndex = pattern.lastIndex
    }

    if (lastIndex < pathTemplate.length) {
        result.push(pathTemplate.slice(lastIndex))
    }

    return result.join('')
}

// JSON path expressions

function assignPath(state: Record<string, any> | any[], p: string, val: any) {
    let didInit = false
    let current: typeof state | undefined
    let lastKey: string | undefined
    const scanner = createJsonPathScanner(p)
    for (const key of scanner.scan()) {
        if (!didInit) {
            if (key !== '$') {
                throw new Error(`Expected expression to start with '$'`)
            }

            current = state
            didInit = true
        } else {
            if (lastKey !== undefined) {
                current = (current as any)[lastKey] ??= (isNaN(Number(key)) ? {} : [])
            }
            lastKey = key
        }
    }

    if (!lastKey) {
        throw new Error(`Cannot set value at root node`)
    }

    (current as any)[lastKey] = val

    return state
}

function getPath(state: Record<string, any> | any[], p: string) {
    let didInit = false
    let current: typeof state | undefined
    const scanner = createJsonPathScanner(p)
    for (const key of scanner.scan()) {
        if (!didInit) {
            if (key !== '$') {
                throw new Error(`Expected expression to start with '$'`)
            }

            current = state
            didInit = true
        } else {
            current = (current as any)?.[key]
        }
    }

    return current
}

function createJsonPathScanner(expression: string) {
    let pos = 0

    // This state is entered when encountering a '['
    function parseElementKey() {
        const c = expression[pos]
        if (c === "'" || c === '"') {
            for (let i = pos + 1; i < expression.length; i++) {
                if (expression[i] === c) {
                    if (expression[i + 1] !== ']') {
                        throw new Error(`Expected closing bracket at position ${pos}`)
                    }

                    const token = expression.slice(pos + 1, i)
                    pos = i + 2

                    return token
                }
            }
        } else {
            if (c < '0' || c > '9') {
                throw new Error(`Expected a number at position ${pos}`)
            }

            for (let i = pos + 1; i < expression.length; i++) {
                const c = expression[i]
                if (c  === ']') {
                    const token = expression.slice(pos, i)
                    pos = i + 1

                    return token
                }

                if (c < '0' || c > '9') {
                    throw new Error(`Expected a number at position ${pos}`)
                }
            }
        }

        throw new Error(`Malformed element access at position ${pos}`)
    }

    function parseIdentifer() {
        for (let i = pos; i < expression.length; i++) {
            const c = expression[i]
            if (c === '[' || c === '.') {
                const token = expression.slice(pos, i)
                pos = i

                return token
            }
        }

        const token = expression.slice(pos)
        pos = expression.length

        return token
    }

    function* scan() {
        if (pos === expression.length) {
            return
        }

        while (pos < expression.length) {
            const c = expression[pos]
            if (c === '[') {
                pos += 1
    
                yield parseElementKey()
            } else if (c === '.') {
                pos += 1
    
                yield parseIdentifer()
            } else {
                yield parseIdentifer()
            }
        }
    }

    return { scan }
}


export function getContentType(p: string) {
    return getMimeType(p)
}

const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.cjs': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.xls': 'application/vnd.ms-excel',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.zip': 'application/zip',
    '.xml': 'application/xml',
    '.mp3': 'audio/mpeg',
    '.mpeg': 'video/mpeg',
    '.tiff': 'image/tiff',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.odp': 'application/vnd.oasis.opendocument.presentation',
    '.rar': 'application/x-rar-compressed',
    '.tar': 'application/x-tar',
    '.rtf': 'application/rtf',
    '.bmp': 'image/bmp',
    '.psd': 'image/vnd.adobe.photoshop',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.flv': 'video/x-flv',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
} as Record<string, string | undefined>

function getMimeType(p: string) {
    const dotIndex = p.lastIndexOf(".")
    const extension = dotIndex === -1 ? p : p.slice(dotIndex)

    return mimeTypes[extension] || 'application/octet-stream'
}