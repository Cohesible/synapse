import * as fs from 'node:fs/promises'
import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as path from 'node:path'
import * as stream from 'node:stream'
import * as child_process from 'node:child_process'
import type * as http from 'node:http'
import { fetch, HttpError, HttpHandler, HttpRequest, HttpResponse, HttpRoute, PathArgs, RouteRegexp, buildRouteRegexp, compareRoutes, createPathBindings, matchRoutes, RequestHandler, RequestHandlerWithBody, PathArgsWithBody } from 'synapse:http'
import { upgradeToWebsocket, WebSocket } from 'synapse:ws'
import * as compute from 'synapse:srl/compute'
import { randomUUID } from 'node:crypto'
import { getLocalPath } from './provider'

interface LocalHttpServiceProps {
    logsDir: string
    port?: number
}

function log(...args: any[]) {
    console.log(new Date().toISOString(), 'SYSTEM', ...args)
}

function createLocalHttpService(props: LocalHttpServiceProps) {
    const b = new lib.Bundle(async () => {
        // Used for restarts
        if (process.env['SYNAPSE_LOCAL_SERVICE_PORT']) {
            props.port ??= Number(process.env['SYNAPSE_LOCAL_SERVICE_PORT'])
        }

        const server = await startServer(props).catch(async e => {
            if ((e as any).code === 'EADDRINUSE') {
                // XXX: add 1 retry, sometimes the port isn't available right away after shutting down
                return new Promise<Awaited<ReturnType<typeof startServer>>>((resolve, reject) => {
                    setTimeout(() => startServer(props).then(resolve, reject), 25)
                })
            }
            throw new Error('Failed to start server', { cause: e })
        })

        process.on('SIGTERM', () => {
            server.shutdown()
        })

        log('started server.', 'hostname:', server.hostname, 'pid:', process.pid)

        process.send?.({
            pid: process.pid,
            port: server.hostname.includes(':') ? Number(server.hostname.split(':')[1]) : undefined,
            hostname: server.hostname, 
        })
    }, { immediatelyInvoke: true })

    return new LocalHttpService(b.destination, props.logsDir)
}

// Only doing this for dev snapshot builds
function getHttp() {
    return require('node:http') as typeof import('node:http')
}

async function startServer(props: LocalHttpServiceProps) {
    const server = getHttp().createServer()
    const controlRouter = createRequestRouter()

    controlRouter.addRoute('POST', '/__control__/routeTable', async (_, req) => {
        const data = await receiveData(req)
        if (!data) {
            throw new Error(`Expected body`)
        }

        const body = JSON.parse(data)
        await setRouteTable(body.filePath)
    })

    let routeTable: ReturnType<typeof createRequestRouter>
    let lastFileName: string
    async function setRouteTable(fileName: string) {
        if (lastFileName) {
            delete require.cache[lastFileName]
        }

        lastFileName = fileName

        // `Bundle` used to treat "plain" objects like module bindings. 
        // Now it puts everything as a default export unless explicitly annotated as a module.
        // The second require handles the legacy case
        routeTable = require(fileName).default ?? require(fileName)

        await emitReloadEvent()
    }

    async function shutdown() {
        log('stopping server...')

        await new Promise<void>(async (resolve, reject) => {
            setTimeout(() => reject(new Error('Failed to shutdown')), 5000).unref()

            await emitReloadEvent().catch(console.error)

            await Promise.all([...sockets].map(ws => {
                return ws.close().catch(console.error)
            }))

            server.close(err => err ? reject(err) : resolve())
            server.closeAllConnections()
        })
    }

    server.on('request', async (req, res) => {
        req.on('error', e => {
            console.error(`Request error`, e)
        })

        if (controlRouter.hasRoute(req)) {
            return await controlRouter.routeRequest(res).catch(e => {
                console.error(`Failed to handle control request`, e)

                return sendResponse(res, undefined, undefined, 500)
            })
        }

        if (!routeTable) {
            return await sendResponse(res, undefined, undefined, 404)
        }

        await routeTable.routeRequest(res).catch(e => {
            console.error(`Failed to handle request`, e)

            return sendResponse(res, undefined, undefined, 500)
        })
    })

    // Probably leaks memory
    const sockets = new Set<WebSocket>()
    server.on('upgrade', async (req, socket) => {
        req.on('error', e => {
            console.error(`Updgrade error`, e)
        })

        const ws = await upgradeToWebsocket(req, socket, false).catch(e => {
            console.error(`Failed to upgrade to websocket`, e)
        })

        if (ws) {
            const l = ws.onClose(() => (l.dispose(), sockets.delete(ws)))
            sockets.add(ws)

            ws.onError(e => {
                console.error(e)
                sockets.delete(ws)
            })
        }
    })

    async function broadcast(msg: string, exclude?: Set<WebSocket>) {
        for (const ws of sockets) {
            if (!exclude?.has(ws)) {
                await ws.send(msg)
            }
        }
    }

    async function emitReloadEvent() {
        const ev = JSON.stringify({
            type: 'reload',
            delay: 10,
        })

        await broadcast(ev)
    }

    server.listen(props.port, 'localhost')

    const hostname = await new Promise<string>((resolve, reject) => {
        function close(data: string, err?: undefined): void
        function close(data: undefined, err: Error): void
        function close(data?: string, err?: Error) {
            if (err) {
                reject(err)
            } else {
                resolve(data!)
            }

            server.removeListener('error', onError)
            server.removeListener('listening', onListening)
        }

        const onError = (err: Error) => close(undefined, err)
        const onListening = () => {
            const addr = server.address()!
            close(typeof addr === 'string' ? addr : `localhost:${addr.port}`)
        }

        server.on('error', onError)
        server.on('listening', onListening)
    })

    return {
        hostname, 
        shutdown,
    }
}

async function startLocalHttpService(targetFile: string, logsPath: string, port?: number) {
    await fs.mkdir(path.dirname(logsPath), { recursive: true })
    const logsFile = await fs.open(logsPath, 'a')
    const logStream = logsFile.createWriteStream()

    const proc = child_process.fork(
        targetFile, 
        [],
        { 
            stdio: ['ignore', logStream, logStream, 'ipc'],
            detached: true,
            env: {
                ...process.env,
                'SYNAPSE_LOCAL_SERVICE_PORT': port ? String(port) : undefined,
            }
        }
    )
    
    const state = await new Promise<{ pid: number; hostname: string; port?: number }>((resolve, reject) => {
        proc.on('exit', code => reject(new Error(`Process exited unexpectedly: ${code} [logs: ${logsPath}]`)))
        proc.on('error', reject)
        proc.on('message', ev => {
            if (typeof ev === 'object' && !!ev && 'hostname' in ev && typeof ev.hostname === 'string') {
                resolve(ev as any)
            }
        })
    }).finally(() => {
        // The fd should've been duplicated in the child process
        logStream.destroy()
    })
    
    proc.unref()
    proc.disconnect()

    return {
        ...state,
        logsPath,
    }
}

async function stopLocalHttpService(pid: number) {
    const cmd = getProcessCommand(pid)
    if (!cmd || (!cmd.endsWith('node') && !cmd.match(/synapse[0-9]*$/))) {
        return
    }

    if (process.platform === 'win32') {
        child_process.execSync(`taskkill /PID ${pid} /F`)
    } else {
        child_process.execSync(`kill ${pid}`)
    }
} 

class LocalHttpService extends core.defineResource({
    create: async (targetFile: string, logsDir: string) => {
        const id = randomUUID()
        const logsPath = path.resolve(logsDir, 'gateway', `${id}.log`)
        const state = await startLocalHttpService(targetFile, logsPath)

        return {
            id,
            ...state,
            logsPath,
            targetFile,
        }
    },
    update: async (state, targetFile, logsDir) => {
        if (state.targetFile === targetFile && path.dirname(state.logsPath) === logsDir) {
            return state
        }

        await stopLocalHttpService(state.pid)
        const newState = await startLocalHttpService(targetFile, state.logsPath, state.port)

        return {
            ...state,
            ...newState,
            targetFile,
        }
    },
    delete: async (state) => {
        // XXX: TERMINATING THE SERVER BASED OFF PIDS IS DANGEROUS!!!
        await stopLocalHttpService(state.pid)
    },
}) {

}

async function setRouteIntegration(service: LocalHttpService, filePath: string) {
    await fetch(`POST http://${service.hostname}/__control__/routeTable`, {
        body: { filePath },
    })
}

class LocalHttpServiceIntegration extends core.defineResource({
    create: async (service: LocalHttpService, filePath: string) => {
        await setRouteIntegration(service, filePath)
    },
}) {}

function getProcessCommand(pid: number) {
    if (process.platform === 'win32') {
        const resp = child_process.execSync(`wmic process where processId=${pid} get name`, { encoding: 'utf-8' })

        return resp.trim().split('\n').pop()?.replace(/\.exe$/, '')
    }

    try {
        return child_process.execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf-8' }).trim()
    } catch {}
}

const logsDir = getLocalPath('logs')

export class Gateway implements compute.HttpService {
    private readonly requestRouter = createRequestRouter()

    readonly hostname: string
    readonly port?: number
    readonly invokeUrl: string

    readonly defaultPath?: string | undefined
    authHandler?: RequestHandlerWithBody

    public async callOperation<T extends any[], R>(route: HttpRoute<T, R>, ...args: T): Promise<R> {
        return fetch(route, ...args)
    }

    forward(req: HttpRequest<string>, body: any): Promise<HttpResponse> {
        throw new Error('Method not implemented.')
    }

    private toRoute(method: string, path: string) {
        const pathBindings = createPathBindings(path)

        return {
            host: 'localhost',
            port: this.port,
            method,
            path: `${this.defaultPath ?? ''}${path}`,
            body: method !== 'GET' ? `$[${pathBindings.length}]` : undefined,
            bindings: { 
                request: [
                    ...pathBindings,
                ],
                response: [] 
            },
        }
    }

    public route<P extends string = string, U = unknown, R = unknown>(
        method: string,
        path: P,
        handler: RequestHandler<`${string} ${P}`, R> | RequestHandlerWithBody<`${string} ${P}`, U, R>
    ): HttpRoute<PathArgsWithBody<P, U>, R> {
        this.requestRouter.addRoute(method, path, wrapRequestHandler(handler, this.authHandler))

        return this.toRoute(method, path)
    }

    constructor(opt?: compute.HttpServiceOptions) {
        if (typeof opt?.auth === 'function') {
            this.authHandler = opt.auth
        }

        const table = new lib.Bundle(this.requestRouter)
        const service = createLocalHttpService({
            logsDir,
        })

        new LocalHttpServiceIntegration(service, table.destination)

        this.hostname = service.hostname
        this.port = service.port
        this.invokeUrl = `http://${this.hostname}`
    }
}

async function runHandler<T>(response: http.ServerResponse, fn: () => Promise<T> | T): Promise<void> {
    try {
        const resp = await fn()
        if (resp instanceof Response) {
            const contentType = resp.headers.get('content-type')
            if (contentType?.startsWith('image/') || contentType === 'application/octet-stream' || contentType === 'application/zip') {
                return await sendResponse(response, Buffer.from(await resp.arrayBuffer()), resp.headers, resp.status)
            }

            const body = resp.body === null ? undefined : resp.body

            return await sendResponse(response, body, resp.headers, resp.status)
        }

        if (resp === undefined) {
            return await sendResponse(response, undefined, undefined, 204)
        }

        return await sendResponse(response, resp)
    } catch (e) {
        if (e instanceof HttpError) {
            return await sendResponse(response, { message: e.message }, undefined, e.fields.statusCode)
        }

        throw e
    }
}

function receiveData(message: http.IncomingMessage): Promise<string> {
    const data: any[] = []

    return new Promise((resolve, reject) => {
        message.on('error', reject)
        message.on('data', chunk => data.push(chunk))
        message.on('end', () => resolve(data.join('')))
    })
}

const TypedArray = Object.getPrototypeOf(Uint8Array)

function sendResponse(response: http.ServerResponse, data?: any, headers?: Headers, status = 200): Promise<void> {
    if (data === undefined) {
        return new Promise((resolve, reject) => {
            response.on('error', reject)
            response.writeHead(status, {
                ...Object.fromEntries(headers?.entries() ?? []),
                // 'Location': headers?.get('location') ?? undefined,
            })
            response.end(resolve)
        })
    }

    if (data instanceof ReadableStream) {
        return new Promise((resolve, reject) => {
            response.on('error', reject)
            response.on('end', resolve)
            response.writeHead(status, { 
                ...Object.fromEntries(headers?.entries() ?? []),
            })

            const piped = stream.Readable.fromWeb(data as any).pipe(response)
            piped.on('error', reject)
            piped.on('close', () => response.end())
        })
    }

    const isTypedArray = typeof data === 'object' && !!data && data instanceof TypedArray
    const contentType = headers?.get('content-type') ?? (!isTypedArray ? 'application/json' : 'application/octet-stream')
    const blob = !isTypedArray ? Buffer.from(JSON.stringify(data), 'utf-8') : Buffer.from(data)

    return new Promise((resolve, reject) => {
        response.on('error', reject)
        response.writeHead(status, { 
            'Content-Type': contentType,
            'Content-Length': blob.length,
            ...Object.fromEntries(headers?.entries() ?? []),
        })
        response.end(blob, resolve)
    })
}

function isJsonRequest(headers: Headers) {
    const contentType = headers.get('content-type')
    if (!contentType) {
        return false
    }

    return !!contentType.match(/application\/(?:([^+\s]+)\+)?json/)
}

function wrapRequestHandler(
    handler: RequestHandler | RequestHandlerWithBody, 
    authHandler?: RequestHandler | RequestHandlerWithBody, 
) {
    async function handleRequest(url: URL, req: http.IncomingMessage, pathParameters: Record<string, string>) {
        const method = req.method
        const headers = new Headers(Object.entries(req.headers).filter(([_, v]) => v !== undefined) as any)
        const body = isJsonRequest(headers) && handler.length >= 2 && method !== 'GET' && method !== 'HEAD'
            ? JSON.parse(await receiveData(req)) 
            : undefined

        const reqBody = method === 'GET' || method === 'HEAD' ? undefined : (body ?? stream.Readable.toWeb(req))
        const newReq = new Request(url, {
            headers,
            method,
            body: reqBody,
            duplex: 'half', // specific to node
        } as RequestInit)

        ;(newReq as any).pathParameters = pathParameters

        if (authHandler) {
            const resp = await authHandler(newReq as any, body)
            if (resp !== undefined) {
                return resp
            }
        }

        return handler(newReq as any, body)
    }

    return handleRequest
}

type GatewayHandler = ReturnType<typeof wrapRequestHandler>

interface RouteEntry {
    readonly route: string
    readonly pattern: RouteRegexp<string>
    readonly handler: GatewayHandler
}

function createRequestRouter() {
    const routeTable: { [method: string]: RouteEntry[] } = {}

    function addRoute(method: string, path: string, handler: GatewayHandler) {
        const routes = routeTable[method] ??= []
        const r = {
            route: `${method} ${path}`,
            handler,
            pattern: buildRouteRegexp(path),
        }

        routes.push(r)

        return {
            dispose: () => {
                const idx = routes.indexOf(r)
                if (idx !== -1) {
                    routes.splice(idx, 1)
                }
            },
        }
    }

    function findRoute(path: string, routes: RouteEntry[]) {
        const matched = Array.from(
            matchRoutes(path, routes.map(e => [e.pattern, e]))
        )

        log('all matched routes:', matched.map(r => r.value.route))

        const sorted = matched.sort((a, b) => compareRoutes(b.value.route, a.value.route))
        const first = sorted[0]
        if (first === undefined) {
            throw new HttpError(`Resource does not exist: ${path}`, { statusCode: 404 })
        }

        return first
    }

    function hasRoute(req: http.IncomingMessage) {
        const method = req.method!
        const url = new URL(req.url!, `http://${req.headers.host}`)
        const routes = [
            ...(routeTable[method] ?? []),
            ...(routeTable['ANY'] ?? []),
        ]

        const matched = Array.from(
            matchRoutes(url.pathname, routes.map(e => [e.pattern, e]))
        )

        return matched.length > 0
    }

    function routeRequest(resp: http.ServerResponse) {
        const req = resp.req
        const method = req.method!
        const routes = [
            ...(routeTable[method] ?? []),
            ...(routeTable['ANY'] ?? []),
        ]
        const url = new URL(req.url!, `http://${req.headers.host}`)

        return runHandler(resp, () => {
            const selectedRoute = findRoute(url.pathname, routes)
            const pathParameters = selectedRoute.match.groups ?? {}
            const entry = selectedRoute.value
            log('using route:', entry.route)

            return entry.handler(url, req, pathParameters)
        })
    }

    return { addRoute, routeRequest, hasRoute }
}

core.addTarget(compute.HttpService, Gateway, 'local')

core.registerLogProvider(
    LocalHttpService,
    async (r, q) => {
        const data = await fs.readFile(r.logsPath, 'utf-8').catch(e => {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
        })

        if (!data) {
            return []
        }

        let lastTimestamp = 0
        const events = data.split('\n').map(l => {
            if (l.match(/^[\d]{4}-/) && l.includes(' SYSTEM')) {
                const parts = l.split(' ')
                const rem = parts.slice(2).join(' ')
                lastTimestamp = new Date(parts[0]).getTime()

                return {
                    timestamp: parts[0],
                    sourceType: 'system',
                    data: rem,
                }
            }

            return {
                timestamp: lastTimestamp+1, // XXX: need to instrument user logs
                data: l,
            }
        })

        return events
    }
)
