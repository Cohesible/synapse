//@internal
//# moduleId = synapse:ws
//# transform = persist

import * as http from 'node:http'
import * as https from 'node:https'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import * as tls from 'node:tls'
import { HttpError, HttpRequest, HttpResponse } from 'synapse:http'

const WebSocketGUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
function getWsKey(key: string) {
    return crypto.createHash('sha1').update(key).update(WebSocketGUID).digest('base64')
}

const slice = (buf: Buffer, start: number, end?: number) => Uint8Array.prototype.slice.call(buf, start, end)

interface WebSocketServer {
    close: () => Promise<void>
    onConnect: (listener: (ws: WebSocket) => void) => { dispose: () => void }
}

interface MinimalSecureContext {
    readonly cert: string | ArrayBufferView
    readonly key: string | ArrayBufferView
}

interface WebSocketServerOptions {
    port?: number
    address?: string
    secureContext?: MinimalSecureContext
    beforeUpgrade?: (request: HttpRequest) => Promise<HttpResponse | void> | HttpResponse | void
    httpRequestHandler?: (request: HttpRequest, body: any) => Promise<HttpResponse> | HttpResponse
    onCustomProto?: (req: MinimalIncomingMessage, protos: string[], ctx: any) => Promise<HttpResponse | void> | HttpResponse | void
    http?: any
}

interface MinimalIncomingMessage {
    readonly url?: string
    readonly headers: Record<string, string | undefined>
}

// Trying to avoid directly depending on `@types/node`
interface SimpleDuplex {
    on(event: string, listener: (...args: any[]) => void): this
    once(event: string, listener: (...args: any[]) => void): this
    write(chunk: string | ArrayBufferView, cb?: (err?: Error | null) => void): boolean
    end(cb?: () => void): this
    end(data: string, cb?: () => void): this
    destroy(err?: Error): this
    cork(): void
    uncork(): void   
}


const upgradeHeaderBuffers = new Map<String, Buffer>()
function getUpgradeHeaderBuffer(proto = '') {
    const cached = upgradeHeaderBuffers.get(proto)
    if (cached) return cached
    
    const headers = new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
    })

    if (proto) {
        headers.append('Sec-WebSocket-Protocol', proto)
    }

    const str = [
        'HTTP/1.1 101 Switching Protocols',
        ...Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`),
        'Sec-WebSocket-Accept: ',
    ].join('\r\n')

    const b = Buffer.from(str, 'utf-8')
    upgradeHeaderBuffers.set(proto, b)

    return b
}

export async function upgradeToWebsocket(req: MinimalIncomingMessage, socket: SimpleDuplex, isSecureContext = true, maxPayloadLength: number, onCustomProto?: WebSocketServerOptions['onCustomProto'], allocator?: any): Promise<WebSocket | undefined> {
    const key = req.headers['sec-websocket-key']
    const protocol = req.headers['sec-websocket-protocol']
    if (!key) {
        console.log('No key')
        socket.destroy()
        return
    }

    const protos = protocol?.split(', ')

    // const headers = new Headers({
    //     Upgrade: 'websocket',
    //     Connection: 'Upgrade',
    //     'Sec-WebSocket-Accept': getWsKey(key),
    // })

    const ctx: any = {}
    if (protos) {
        //headers.append('Sec-WebSocket-Protocol', protos[0])
        if (onCustomProto) {
            const resp = await onCustomProto(req, protos, ctx)

            if (resp) {
                const code = resp.statusCode ?? 400
                const msg = http.STATUS_CODES[code] ?? 'Unknown'
                const headers = new Headers(resp.headers ?? {})

                const _resp = [
                    `HTTP/1.1 ${code} ${msg}`,
                    ...Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`),
                    '',
                ].join('\r\n')

                socket.end(_resp + '\r\n')
                return
            }
        }
    }

    function getBaseUrl() {
        const scheme = isSecureContext ? 'wss' : 'ws'

        return scheme + '://' + req.headers['host']!
    }

    // TODO: clean this up
    const url = new URL(req.url!, getBaseUrl())

    // const resp = [
    //     'HTTP/1.1 101 Switching Protocols',
    //     ...Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`),
    //     '',
    // ].join('\r\n')

    const b = getUpgradeHeaderBuffer(protos?.[0])

    const addr = req.headers['fly-client-ip'] || (req as any).socket?.remoteAddress
    
    return new Promise<WebSocket>((resolve, reject) => {
        socket.cork()
        socket.write(b)
        socket.write(getWsKey(key))
        socket.write('\r\n\r\n', err => {
            if (!err) {
                resolve(upgradeSocket(socket, url, 'server', maxPayloadLength, addr, ctx, allocator))
            } else {
                reject(err)
            }
        })
        socket.uncork()
    })
}

function maybeGetuWS() {
    if (process.env['NO_UWS']) return

    try {
        return require('uWebSockets.js')
    } catch {}
}

/** @internal */
export async function createWebsocketServer(opt: WebSocketServerOptions = {}): Promise<WebSocketServer> {
    const emitter = new EventEmitter()
    const connectEvent: Event<[ws: WebSocket]> = createEvent(emitter, 'connect')
    const port = opt.port ?? (opt.secureContext ? 443 : 80)

    const uWS = maybeGetuWS()
    if (uWS) {
        const idleTimeout = opt.idleTimeout ?? 0
        const _logFailedUpgrades = true // !!process.env['LOG_FAILED_UPGRADES']
        const _maxPayloadLength = process.env['MAX_PAYLOAD_LENGTH']
        const maxPayloadLength = opt.maxPayloadLength ?? (_maxPayloadLength ? Number(_maxPayloadLength) : 1024)
        console.log('using uws', 'maxPayloadLength', maxPayloadLength, 'idleTimeout', idleTimeout, '_logFailedUpgrades', _logFailedUpgrades)
        const App = opt?.secureContext ? uWS.SSLApp : uWS.App

        const appOpt = {}
        if (opt?.secureContext) {
            const threadId = require('node:worker_threads').threadId
            const fs = require('node:fs') as typeof import('node:fs')
            fs.writeFileSync(`cert-${threadId}.pem`, opt.secureContext.cert)
            fs.writeFileSync(`key-${threadId}.pem`, opt.secureContext.key)
            appOpt.key_file_name = `key-${threadId}.pem`
            appOpt.cert_file_name = `cert-${threadId}.pem`
        }

        function initWs(url, addr, ctx) {
            const emitter = new EventEmitter()
            const errorEvent: Event<[error: unknown]> = createEvent(emitter, 'error')
            const closeEvent: Event<[code?: StatusCode, reason?: string]> = createEvent(emitter, 'close')
            const messageEvent: Event<[message: string | Buffer]> = createEvent(emitter, 'message')
            const messageBuffer: any[] = []

            function ping() {
                return ws.ping()
            }

            let ws
            function send(msg: any) {
                if (_closed) return 3
                if (_logFailedUpgrades) {
                    const code = ws.send(msg, true)
                    if (code === 2) {
                        console.log('backpressure limit!',  ws.getBufferedAmount())                        
                    }
                    return code
                }

                return ws.send(msg, true)
            }

            function setWs(_ws) {
                ws = _ws
            }

            function sendMany(msgs: any[]) {
                if (_closed) return 3
                ws.cork(() => {
                    for (const m of msgs) {
                        const code = ws.send(m, true)
                        if (code === 2) break
                    }
                })
            }

            async function close(msg?: string, code = 1001) {
                if (_closed) return
                ws.end(code, msg)
                _closed = true
            }

            let messageHandler: any
            function getMessageHandler() {
                return messageHandler
            }

            function onMessage(handler: any) {
                messageHandler = handler
                while (messageBuffer.length) {
                    messageHandler(messageBuffer.shift())
                }
            }

            function handleMessage(msg: ArrayBuffer) {
                if (!messageHandler) {
                    const b = Buffer.allocUnsafe(msg.byteLength)
                    b.set(new Uint8Array(msg))
                    messageBuffer.push(b)
                    if (messageBuffer.length > 1000) {
                        throw new Error('no handler')
                    }
                    return
                }
                messageHandler(msg)
            }

            let _closed = false
            function closed() {
                _closed = true
            }

            return {
                url,
                addr, // XXX
                ctx, // XXX
                ping,
                send,
                close,
                onClose: closeEvent.on,
                onError: errorEvent.on,
                onMessage: onMessage, // messageEvent.on,
                messageEvent,
                errorEvent,
                closeEvent,
                setWs,
                handleMessage,
                getMessageHandler,
                closed,
                sendMany,
            }
        }

        return new Promise((resolve, reject) => {
            const app = App(appOpt).ws('/*', {
                closeOnBackpressureLimit: true,
                maxBackpressure: 8 * 1024 * 1024,
                maxPayloadLength,
                maxLifetime: 0,
                sendPingsAutomatically: false,
                idleTimeout,
                upgrade: async (res, req, context) => {
                    const url = req.getUrl()
                    const ctx = {}
                    const addr = req.getHeader('fly-client-ip') || Buffer.from(res.getRemoteAddressAsText()).toString('utf-8')

                    const key = req.getHeader('sec-websocket-key')
                    const ext = req.getHeader('sec-websocket-extensions')
                    const protocol = req.getHeader('sec-websocket-protocol')


                    const protos = protocol?.split(', ')
                    const onCustomProto = opt?.onCustomProto

                    if (protos) {
                        if (onCustomProto) {
                            let aborted = false
                            res.onAborted(() => {
                                aborted = true
                                if (_logFailedUpgrades) {
                                    console.log('ws upgrade aborted!')
                                }
                            })

                            const resp = await onCustomProto(req, protos, ctx)
                            if (aborted) return

                            if (resp) {
                                res.cork(() => {
                                    res.writeStatus(`${resp.statusCode ?? 400} Forbidden`)
                                    res.end(undefined, true)
                                })

                                return
                            }
                        }
                    }

                    const wrapper = initWs(url, addr, ctx)

                    res.cork(() => {
                        res.upgrade(
                            { wrapper },
                            key,
                            protos?.[0] ?? '',
                            ext,
                            context
                        )
                    })
                },
                open: (ws) => {
                    const wrapper = ws.getUserData().wrapper
                    wrapper.setWs(ws)
                    process.nextTick(() => {
                        connectEvent.fire(wrapper)
                    })
                },
                message: (ws, message, isBinary) => {
                    const wrapper = ws.getUserData().wrapper
                    if (!isBinary) return

                    return wrapper.handleMessage(message)
                },
                //drain: (ws) => {
                    // console.log('WebSocket backpressure: ' + ws.getBufferedAmount());
                //},
                // dropped?: ((ws, message, isBinary) => void | Promise<void>); 
                close: (ws, code, message) => {
                    const wrapper = ws.getUserData().wrapper
                    wrapper.closed()
                    return wrapper.closeEvent.fire(code, message)
                },
            }).listen(port, (token) => {
                if (!token) return reject('Failed to listen on port')

                async function close() {
                    return app.close()
                }
                resolve({
                    close,
                    onConnect: connectEvent.on,
                })
            })
        })
    }

    const server = opt?.secureContext
        ? https.createServer({
            ...opt.secureContext as tls.SecureContextOptions,
            ...opt?.http,
        }) // Types are too strict, it doesn't need `Buffer`
        : http.createServer(opt?.http)

    server.on('request', async (req, res) => {
        if (!opt.httpRequestHandler) {
            return res.end('')
        }

        const body = await new Promise<string>((resolve, reject) => {
            const buffer: Buffer[] = []
            req.once('error', reject)
            req.on('data', chunk => buffer.push(chunk))
            req.on('end', () => resolve(buffer.join('')))
        })

        try {
            const resp = await opt.httpRequestHandler({
                // body: body as any,
                path: req.url!,
                method: req.method!,
                pathParameters: {},
                headers: new Headers(Object.entries(req.headers).filter(([_, v]) => typeof v === 'string') as any),
            }, body)

            if (resp.body) {
                throw new Error('Not implemented')
            }

            res.writeHead(resp.statusCode ?? 200, resp.headers)
            res.end('')
        } catch (e) {
            if (e instanceof HttpError) {
                const body = JSON.stringify({ message: e.message })
                res.writeHead(e.fields.statusCode, {
                    'content-type': 'application/json',
                    'content-length': body.length,
                })
                res.end(body)

                return
            }

            res.writeHead(500)
            res.end('')

            throw e
        }
    })

    const _maxPayloadLength = process.env['MAX_PAYLOAD_LENGTH']
    const maxPayloadLength = opt.maxPayloadLength ?? (_maxPayloadLength ? Number(_maxPayloadLength) : 1024)

    let overflow = 0
    let bufCount = 0
    const bufs: Buffer[] = new Array(10)
    function free(b: Buffer) {
        if (bufCount === 10) {
            overflow = (overflow + 1) % 10
            bufs[overflow] = b
        } else {
            bufs[bufCount++] = b
        }
    }

    function allocate() {
        if (bufCount) {
            return bufs[bufCount--]
        }
        return Buffer.allocUnsafe(maxPayloadLength)
    }

    const shared = Buffer.allocUnsafe(maxPayloadLength)

    const allocator = {
        shared,
        allocate,
        free,
    }

    const sockets = new Set<WebSocket>()
    server.on('upgrade', async (req, socket, head) => {
        if (opt.beforeUpgrade) {
            const beforeUpgradeResp = await opt.beforeUpgrade({
                // body: undefined,
                path: req.url!,
                method: req.method!,
                pathParameters: {},
                headers: new Headers(Object.entries(req.headers).filter(([_, v]) => typeof v === 'string') as any),
            })

            if (beforeUpgradeResp) {
                const code = beforeUpgradeResp.statusCode ?? 400
                const msg = http.STATUS_CODES[code] ?? 'Unknown'
                const headers = new Headers(beforeUpgradeResp.headers ?? {})

                const resp = [
                    `HTTP/1.1 ${code} ${msg}`,
                    ...Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`),
                    '',
                ].join('\r\n')

                return socket.end(resp + '\r\n')
            }
        }

        const ws = await upgradeToWebsocket(req as MinimalIncomingMessage, socket, !!opt.secureContext, maxPayloadLength, opt.onCustomProto, allocator)
        if (!ws) {
            return
        }

        const l = ws.onClose(() => (l.dispose(), sockets.delete(ws)))
        sockets.add(ws)
        connectEvent.fire(ws)
    })

    async function close() {
        await Promise.all(Array.from(sockets).map(ws => ws.close()))

        return new Promise<void>((resolve, reject) =>
            server.close(err => err ? reject(err) : resolve())
        )
    }

    function listen(address?: string) {
        return new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, address, () => {
                server.removeListener('error', reject)
                resolve()
            })
        })
    }

    if (opt.address === '*') {
        await Promise.all([listen('::'), listen('0.0.0.0')])
    } else {
        await listen(opt.address)
    }

    return {
        close,
        onConnect: connectEvent.on,
    }
}

// FIXME: conform with WHATWG WebSocket
export interface WebSocket {
    readonly url: URL
    ping: (message?: string) => Promise<number>
    send: (data: string | Uint8Array) => 0 | 1
    sendRaw: (data: Uint8Array) => 0 | 1
    close: (message?: string) => Promise<void>
    onClose: (listener: (code?: StatusCode, reason?: string) => void) => { dispose: () => void }
    onMessage: (listener: (message: string | Uint8Array) => void) => { dispose: () => void }
    onError: (listener: (error: unknown) => void) => { dispose: () => void }

    getBufferedAmount(): number
}

interface Event<T extends any[]> {
    fire(...args: T): void
    on(listener: (...args: T) => void): { dispose: () => void }
    once(listener: (...args: T) => void): { dispose: () => void }
}

function createEvent<T extends any[], U extends string>(emitter: EventEmitter, type: U): Event<T> {
    return {
        fire: (...args) => emitter.emit(type, ...args),
        on: listener => {
            emitter.on(type, listener as any)

            return { dispose: () => void emitter.removeListener(type, listener as any) }
        },
        once: listener => {
            emitter.once(type, listener as any)

            return { dispose: () => void emitter.removeListener(type, listener as any) }
        },
    }
}

function upgradeSocket(
    socket: SimpleDuplex, 
    url: URL, 
    mode: 'client' | 'server', 
    maxPayloadLength: number, 
    addr?: string, 
    ctx?: any,
    allocator?: any
): WebSocket {
    const emitter = new EventEmitter()
    const pongEvent: Event<[message: string]> = createEvent(emitter, 'pong')
    const errorEvent: Event<[error: unknown]> = createEvent(emitter, 'error')
    const closeEvent: Event<[code?: StatusCode, reason?: string]> = createEvent(emitter, 'close')
    const messageEvent: Event<[message: string | Buffer]> = createEvent(emitter, 'message')

    function ping(msg: string = '') {
        if (!(socket as any).writable) return Promise.resolve()

        const now = Date.now()

        return new Promise<number>((resolve, reject) => {
            const l = pongEvent.once(() => resolve(Date.now() - now))
            socket.write(
                createFrame(Opcode.Ping, Buffer.from(msg)),
                err => err ? (l.dispose(), reject(err)) : void 0,
            )
        })
    }

    function randomInt32() {
        return new Promise<number>((resolve, reject) => {
            crypto.randomInt(0, 2 ** 32, (err, value) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(value)
                }
            })
        })
    }

    function send(msg: string | Uint8Array) {
        const op = typeof msg === 'string' ? Opcode.Text : Opcode.Binary

        return sendRaw(createFrame(op, msg instanceof Buffer ? msg : Buffer.from(msg)))
    }

    async function close(reason?: string) {
        if (state === SocketState.Closing || state === SocketState.Closed) return

        state = SocketState.Closing

        try {
            const closePromise = new Promise<void>(async (resolve, reject) => {
                if (!(socket as any).writable) return resolve()

                socket.once('end', () => resolve())
                await sendClose(StatusCode.Success, reason)
            })

            await closePromise
        } finally {
            state = SocketState.Closed
        }
    }

    function sendClose(code?: StatusCode, reason?: string | Uint8Array) {
        if (!(socket as any).writable) return Promise.resolve()

        return new Promise<void>((resolve, reject) => {
            socket.write(
                createCloseFrame(code, reason),
                err => err ? reject(err) : resolve()
            )
        })
    }

    let state = SocketState.Ready
    let lastFrame: Frame | undefined
    let messageBuffer: Buffer[] = []

    function handleFrame(frame: Frame) {
        switch (frame.op) {
            case Opcode.Pong:
                return pongEvent.fire(frame.payload.toString('utf-8'))
            case Opcode.Ping:
                if (!(socket as any).writable) return

                return socket.write(createFrame(Opcode.Pong, frame.payload))
            case Opcode.Close: {
                if (state === SocketState.Closed) return

                let code: StatusCode | undefined
                let reason: Buffer | undefined

                if (frame.payload.length >= 2) {
                    code = frame.payload.readUint16BE()
                    reason = frame.payload.length > 2 ? frame.payload.subarray(2) : undefined
                }

                
                closeEvent.fire(code, reason?.toString('utf-8'))

                if (state !== SocketState.Closing) {
                    // console.log('closing', code, reason)
                    state = SocketState.Closing

                    return sendClose(code, reason).finally(() => {
                        if (!(socket as any).writable) return

                        socket.end(() => state = SocketState.Closed)
                    })
                }

                if (state === SocketState.Closing) {
                    if (!(socket as any).writable) return

                    socket.end(() => state = SocketState.Closed)
                }

                return
            }
            case Opcode.Text:
            case Opcode.Binary: {
                if (state === SocketState.Closing || state === SocketState.Closed) {
                    return
                }

                if (state !== SocketState.Ready) {
                    throw new Error(`Unexpected socket state: ${state}`)
                }

                if (frame.fin) {
                    const res = frame.op === Opcode.Text ? frame.payload.toString('utf-8') : frame.payload
                    onMessageHandler(res as any)
                } else {
                    messageBuffer.push(frame.payload)
                    state = frame.op === Opcode.Text ? SocketState.ReadingText : SocketState.ReadingBinary
                }

                return
            }
            case Opcode.Continue: {
                if (state === SocketState.Closing || state === SocketState.Closed) {
                    return
                }

                if (state !== SocketState.ReadingText && state !== SocketState.ReadingBinary) {
                    throw new Error(`Unexpected continuation state: ${state}`)
                }

                if (frame.fin) {
                    const res = state === SocketState.ReadingText
                        ? messageBuffer.join('')
                        : Buffer.concat(messageBuffer)
                    onMessageHandler(res as any)
                    messageBuffer = []
                    state = SocketState.Ready
                } else {
                    messageBuffer.push(frame.payload)
                }

                return
            }
            default:
                return sendClose(StatusCode.ProtocolError, `unknown opcode: ${frame.op}`)
        }
    }

    socket.on('error', errorEvent.fire)
    socket.on('end', () => {
        if (state === SocketState.Closing) {
            emitter.removeAllListeners()
            return
        }

        if (state !== SocketState.Closed) {
            closeEvent.fire(StatusCode.UnexpectedCloseState)
            state = SocketState.Closed
        }

        emitter.removeAllListeners()
    })

    socket.once('close', () => {
        if (state !== SocketState.Closed) {
            closeEvent.fire(StatusCode.UnexpectedCloseState)
            state = SocketState.Closed
        }
        emitter.removeAllListeners()
        ;(socket as any).removeAllListeners()
    })

    function onFrame(frame: Frame) {
        try {
            handleFrame(frame)
        } catch (e) {
            errorEvent.fire(e)
        }

        while (frame.carry) {
            if (!canReadClientFrame(frame.carry)) {
                if (fragmentSize !== 0) {
                    throw new Error(`expected no fragments: ${fragmentSize} [carry: ${frame.carry.byteLength}]`)
                }
                //fragementBuffer = Buffer.allocUnsafe(16)
                fragementBuffer.set(frame.carry, 0)
                fragmentSize += frame.carry.byteLength
                break
            }

            frame = readFrame(frame.carry, allocator.shared)
            if (frame.remainingLength) {
                allocator.shared = Buffer.allocUnsafe(maxPayloadLength)
                lastFrame = frame
                return
            }

            try {
                handleFrame(frame)
            } catch (e) {
                errorEvent.fire(e)
            }
        }
    }

    function onData(buf: Buffer) {
        if (lastFrame) {
            const r = lastFrame.remainingLength!
            const [_, remainingLength] = readFrameIntoPayload(buf, r, 0, lastFrame.maskingKey, lastFrame.payload, lastFrame.payload.length - lastFrame.remainingLength!)

            lastFrame.remainingLength = remainingLength
            if (lastFrame.remainingLength) {
                return
            }

            if (r < buf.byteLength) {
                lastFrame.carry = buf.subarray(r)
            }

            const frame = lastFrame
            lastFrame = undefined
            return onFrame(frame)
        }

        const frame = readFrame(buf, allocator.shared)
        if (frame.remainingLength) {
            allocator.shared = Buffer.allocUnsafe(maxPayloadLength)
            lastFrame = frame
            return
        }

        return onFrame(frame)
    }

    function _onData(buf: Buffer) {
        if (lastFrame) {
            try {
                return onData(buf)
            } catch (e) {
                return errorEvent.fire(e)
            }
        }

        if (fragmentSize === 0) {
            if (!canReadClientFrame(buf)) {
                //fragementBuffer = Buffer.allocUnsafe(16)
                fragementBuffer.set(buf, fragmentSize)
                fragmentSize += buf.byteLength
                return
            }
        } else {
            if (!canReadClientFrame2(fragementBuffer, fragmentSize, buf)) {
                fragementBuffer.set(buf, fragmentSize)
                fragmentSize += buf.byteLength
                return
            } else {
                const end = setupPartialFrame(fragementBuffer, fragmentSize, buf)
                const f1 = fragementBuffer.subarray(0, end)
                const f2 = buf.subarray(end-fragmentSize)

                fragmentSize = 0
                //fragementBuffer = undefined

                try {
                    onData(f1)
                    return onData(f2)
                } catch (e) {
                    return errorEvent.fire(e)
                }
            }
        }

        try {
            return onData(buf)
        } catch (e) {
            errorEvent.fire(e)
        }
    }

    const fragementBuffer = Buffer.allocUnsafe(maxPayloadLength < 65_000 ? 8 : 16)
    let fragmentSize = 0

    socket.on('data', _onData)

    const maxBufferedAmount = 8*1024*1024
    const buffers: (Uint8Array | Buffer)[] = []

    let bufferedAmount = 0
    let needsDrain = false
    let hasCorkTick = false
    let corkedAmount = 0
    socket.on('drain', () => {
        if (!needsDrain) return

        needsDrain = false

        const len = buffers.length
        if (len > 1) {
            while (!needsDrain && buffers.length) {
                let c = 0
                socket.cork()
                while (buffers.length && c < corkBufferSize) {
                    const b = buffers.shift()!
                    socket.write(b)
                    c += b.byteLength
                    bufferedAmount -= b.byteLength
                }
                socket.uncork()
                needsDrain = (socket as any).writableNeedDrain
            }
        } else if (len === 1) {
            const buf = buffers[0]
            if (buf.byteLength < corkBufferSize) {
                socket.cork()
                hasCorkTick = true
                process.nextTick(() => {
                    hasCorkTick = false
                    if (!corkedAmount) return
                    socket.uncork()
                    corkedAmount = 0
                })

                socket.write(buf)
                corkedAmount += buf.byteLength
            } else {
                needsDrain = !socket.write(buf)
            }
            buffers.length = 0
            bufferedAmount = 0
        }
    })

    function sendRaw(buf: Uint8Array | Buffer) {
        if (!(socket as any).writable) {
            return 2
        }

        if (needsDrain) {
            buffers.push(buf)
            bufferedAmount += buf.byteLength

            const buffered = (socket as any).writableLength + bufferedAmount
            if (buffered > maxBufferedAmount) {
                socket.destroy(new Error(`too much backpressure: ${buffered}`))
                return 2
            }

            return 1
        }

        if (buf.byteLength < corkBufferSize || corkedAmount) {
            if (!corkedAmount) {
                socket.cork()
                if (!hasCorkTick) {
                    hasCorkTick = true
                    process.nextTick(() => {
                        hasCorkTick = false
                        if (!corkedAmount) return
                        socket.uncork()
                        corkedAmount = 0
                    })
                }
            }

            socket.write(buf)
            corkedAmount += buf.byteLength

            if (corkedAmount >= corkBufferSize) {
                socket.uncork()
                corkedAmount = 0
                needsDrain = (socket as any).writableNeedDrain
                return needsDrain ? 1 : 0
            }

            return 0
        }

        if (socket.write(buf)) {
            return 0
        }

        const buffered = (socket as any).writableLength
        if (buffered > maxBufferedAmount) {
            socket.destroy(new Error(`too much backpressure: ${buffered}`))
            return 2
        }

        needsDrain = true

        return 1
    }

    function getBufferedAmount() {
        return (socket as any).writableLength
    }

    let onMessageHandler: (b: Buffer) => void
    function _onMessage(handler: typeof onMessageHandler) {
        onMessageHandler = handler
    }

    function sendMany(msgs: any[]) {
        if (!(socket as any).writable) {
            return 2
        }

        for (const m of msgs) {
            if (send(m) === 2) break
        }
    }

    return {
        url,
        addr, // XXX
        ctx, // XXX
        ping,
        send,
        close,
        onClose: closeEvent.on,
        onError: errorEvent.on,
        onMessage: _onMessage as any,
        sendRaw,
        sendMany,
        getBufferedAmount,
    } as WebSocket
}

const corkBufferSize = 16 * 1024

/** @internal */
export async function createWebsocket(url: string | URL, authorization?: string, protos?: string[]): Promise<WebSocket> {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
        throw new Error(`Invalid protocol "${parsedUrl.protocol}". Must be one of: ws:, wss:`)
    }

    const port = Number(parsedUrl.port || (parsedUrl.protocol === 'wss:' ? 443 : 80))
    const socket = await new Promise<Duplex>((resolve, reject) => {
        let s: Duplex

        function complete(err?: Error) {
            if (err) {
                reject(err)
            } else {
                resolve(s)
            }

            s.removeListener('error', complete)
        }

        if (parsedUrl.protocol === 'ws:') {
            s = net.connect({
                port,
                host: parsedUrl.hostname,
            }, complete)
        } else {
            s = tls.connect({
                port,
                host: parsedUrl.hostname,
                servername: parsedUrl.hostname,
            }, complete)
        }

        s.on('error', complete)
    })

    const nonce = crypto.randomBytes(16).toString('base64')
    const headers = new Headers({
        Host: parsedUrl.hostname,
        Upgrade: 'websocket',
        Connection: 'upgrade',
        'Sec-WebSocket-Key': nonce,
        'Sec-WebSocket-Version': '13',
        // 'Sec-WebSocket-Protocol': protocol ? protocol.split(',')[0] : '',
    })

    if (protos) {
        headers.set('Sec-WebSocket-Protocol', protos.join(', '))
    }

    if (authorization) {
        headers.set('Authorization', authorization)
    }

    const req = [
        `GET ${parsedUrl.pathname} HTTP/1.1`,
        ...Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`),
        '',
    ].join('\r\n')

    return new Promise(async (resolve, reject) => {
        function complete(err?: Error) {
            if (err) {
                reject(err)
            } else {
                resolve(upgradeSocket(socket, parsedUrl, 'client'))
            }

            socket.removeListener('data', onData)
            socket.removeListener('error', complete)
        }

        let buffer = ''
        function onData(chunk: Buffer) {
            buffer += chunk
            if (buffer.endsWith('\r\n\r\n')) {
                const lines = buffer.split('\r\n').slice(0, -1)
                if (lines.length === 0) {
                    return complete(new Error(`Missing or malformed HTTP response`))
                }

                const [httpVersion, statusCode, message] = lines[0].split(' ')
                if (!httpVersion || !statusCode) {
                    return complete(new Error(`Malformed status line: ${lines[0]}`))
                }

                // TODO: handle redirect
                if (statusCode !== '101') {
                    return complete(new Error(`Server rejected upgrade request: ${statusCode} ${message}`))
                }

                const headers = Object.fromEntries(
                    lines.slice(1)
                        .map(l => l.split(': ', 2))
                        .filter(([_, v]) => v !== undefined)
                        .map(([k, v]) => [k.toLowerCase(), v])
                ) as Record<string, string>

                if (headers['upgrade']?.toLowerCase() !== 'websocket') {
                    return complete(new Error(`Invalid upgrade header: ${headers['upgrade']}`))
                }

                if (headers['connection']?.toLowerCase() !== 'upgrade') {
                    return complete(new Error(`Invalid connection header: ${headers['connection']}`))
                }

                // TODO: subprotocols
                // if (headers['sec-websocket-protocol']) {
                //     return complete(new Error(`Invalid subprotocol: ${headers['sec-websocket-protocol']}`))
                // }

                complete()
            }
        }

        socket.on('error', complete)
        socket.write(req + '\r\n', err => {
            if (!err) {
                socket.on('data', onData)
            }
        })

        setTimeout(() => {
            if (socket.listeners('error').includes(complete)) {
                socket.emit('error', new Error('Timed out waiting for connection'))
            }
        }, 10000).unref()
    })
}

function byteLength(str: string | Uint8Array) {
    if (typeof str !== 'string') {
        return str.length
    }

    let len = str.length
    for (let i = str.length - 1; i >= 0; i--) {
        const code = str.charCodeAt(i)
        if (code >= 0xDC00 && code <= 0xDFFF) i--

        if (code > 0x7F && code <= 0x7FF) len++
        else if (code > 0x7FF && code <= 0xFFFF) len += 2
    }

    return len
}


enum SocketState {
    Ready = 0,
    ReadingText = 1,
    ReadingBinary = 2,
    Closing = 3,
    Closed = 4,
    Truncated = 10,
}

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-------+-+-------------+-------------------------------+
// |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
// |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
// |N|V|V|V|       |S|             |   (if payload len==126/127)   |
// | |1|2|3|       |K|             |                               |
// +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
// |     Extended payload length continued, if payload len == 127  |
// + - - - - - - - - - - - - - - - +-------------------------------+
// |                               |Masking-key, if MASK set to 1  |
// +-------------------------------+-------------------------------+
// | Masking-key (continued)       |          Payload Data         |
// +-------------------------------- - - - - - - - - - - - - - - - +
// :                     Payload Data continued ...                :
// + - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
// |                     Payload Data continued ...                |
// +---------------------------------------------------------------+

const maxFrameSize = 65536

function* chunk(buf: Buffer, amount: number) {
    let pos = 0
    while (true) {
        const start = pos === 0
        const c = Uint8Array.prototype.slice.call(buf, pos, Math.min(pos + amount, buf.length))
        pos += c.length

        const fin = pos >= buf.length
        yield [c, start, fin]
        if (fin) break
    }
}

function createDataFrames(payload: Buffer, maskingKey?: number) {

}

function createCloseFrame(code?: StatusCode, reason?: string | Uint8Array) {
    if (code === undefined) {
        return createFrame(Opcode.Close)
    }

    const size = (reason ? byteLength(reason) : 0) + 2
    const payload = Buffer.allocUnsafe(size)
    payload.writeUint16BE(code)
    if (typeof reason === 'string') {
        payload.write(reason, 2)
    } else if (reason instanceof Uint8Array) {
        payload.set(reason, 2)
    }

    return createFrame(Opcode.Close, payload)
}

export function getFrameSize(payloadSize: number, mask = false) {
    const p = payloadSize <= 125 ? payloadSize : payloadSize <= 65536 ? 126 : 127
    
    return 2 + payloadSize + (mask ? 4 : 0) + (p === 126 ? 2 : p === 127 ? 8 : 0)
}

export function getFramePayloadStart(payloadSize: number) {
    const p = payloadSize <= 125 ? payloadSize : payloadSize <= 65536 ? 126 : 127
    
    return 2 + (p === 126 ? 2 : p === 127 ? 8 : 0)
}

export function writeFramePreAllocated(frame: Buffer, len: number, fin = true) {
    const mask = false
    const p = len <= 125 ? len : len <= 65536 ? 126 : 127

    frame[0] = ((fin ? 1 : 0) << 7) | Opcode.Binary
    frame[1] = ((mask ? 1 : 0) << 7) | p

    if (p === 126) {
        frame.writeUint16BE(len, 2)
    } else if (p === 127) {
        frame.writeBigUint64BE(BigInt(len), 2)
    }

    return frame
}

export function createFrame(op: Opcode, payload?: Buffer, maskingKey?: number, fin = true) {
    if (payload === undefined) {
        return Buffer.of(((fin ? 1 : 0) << 7) | op)
    }

    let pos = 0

    const mask = maskingKey !== undefined
    const p = payload.length <= 125 ? payload.length : payload.length <= 65536 ? 126 : 127
    const size = 2 + payload.length + (mask ? 4 : 0) + (p === 126 ? 2 : p === 127 ? 8 : 0)

    const frame = Buffer.allocUnsafe(size)
    pos = frame.writeUInt8(((fin ? 1 : 0) << 7) | op, pos)
    pos = frame.writeUint8((mask ? 1 : 0) << 7 | p, pos)
    if (p === 126) {
        pos = frame.writeUint16BE(payload.length, pos)
    } else if (p === 127) {
        pos = frame.writeBigUint64BE(BigInt(payload.length), pos)
    }
    if (mask) {
        pos = frame.writeUint32BE(maskingKey, pos)
        let i: number
        for (i = 0; i < payload.length - 4; i += 4) {
            pos = frame.writeInt32BE(payload.readInt32BE(i) ^ maskingKey, pos)
        }
        for (; i < payload.length; i++) {
            const m = i % 4
            const k = (maskingKey >>> (m === 0 ? 24 : m === 1 ? 16 : m === 2 ? 8 : 0)) & 0xFF
            pos = frame.writeUint8(payload.readUint8(i) ^ k, pos)
        }
    } else {
        frame.set(payload, pos)
    }

    return frame
}

interface Frame {
    op: Opcode
    fin: boolean
    payload: Buffer

    // Only relevant for partial frames
    maskingKey?: number
    remainingLength?: number

    carry?: Buffer
}

function readFrameSize(buf: Buffer) {
    const h = buf.readUint8(1) & 0x7F
    switch (h) {
        case 126:
            return buf.readUint16BE(2)
        case 127: {
            const len = buf.readBigUint64BE(2)
            if (len > Number.MAX_SAFE_INTEGER) {
                throw new Error('Payload too big')
            }
            return Number(len)
        }
    }
    return h
}

function canReadClientFrame(buf: Buffer) {
    if (buf.byteLength < 2) return false

    const h = buf[1]
    const mask = (h & 0x80) === 0x80
    const base = mask ? 6 : 2

    switch (h & 0x7F) {
        case 126:
            return buf.byteLength >= base+2
        case 127:
            return buf.byteLength >= base+8
    }

    return buf.byteLength >= base
}

function willNeedMoreData(buf: Buffer) {
    const h = buf[1]
    const mask = (h & 0x80) === 0x80
    const base = mask ? 6 : 2
    const l = h & 0x7F

    switch (l) {
        case 126: {
            const len = buf.readUint16BE(2)
            return buf.byteLength - (base+2) > len
        }
        case 127:
            return buf.byteLength >= base+8
    }
    return buf.byteLength - base > l
}

function canReadClientFrame2(buf: Buffer, bufLen: number, buf2: Buffer) {
    const size = bufLen + buf2.byteLength
    if (size < 2) return false

    const h = bufLen <= 1 ? buf2[1-bufLen] : buf[1]
    const mask = (h & 0x80) === 0x80
    const base = mask ? 6 : 2

    switch (h & 0x7F) {
        case 126:
            return size >= base+2
        case 127:
            return size >= base+8
    }

    return size >= base
}

function setupPartialFrame(buf: Buffer, bufLen: number, buf2: Buffer) {
    const h = bufLen <= 1 ? buf2[1-bufLen] : buf[1]
    const mask = (h & 0x80) === 0x80
    const base = mask ? 6 : 2

    let end = base
    switch (h & 0x7F) {
        case 126:
            end = base+2
            break
        case 127:
            end = base+8
            break
    }

    buf.set(buf2.subarray(0, end-bufLen), bufLen)

    return end
}


function readFrame(buf: Buffer, payloadBuf: Buffer): Frame {
    let pos = 0
    const h1 = buf[pos]
    pos += 1
    const h2 = buf[pos]
    pos += 1

    const fin = (h1 & 0x80) === 0x80
    const ext = h1 & 0x70
    const op = h1 & 0x0F
    const mask = (h2 & 0x80) === 0x80
    const p1 = h2 & 0x7F

    let len: bigint | number = p1
    if (len === 126) {
        len = buf.readUInt16BE(pos)
        pos += 2
    } else if (len === 127) {
        len = buf.readBigUint64BE(pos)
        pos += 8
        if (len > Number.MAX_SAFE_INTEGER) {
            throw new Error('Payload too big')
        }
        len = Number(len)
    }

    let maskingKey: number | undefined
    if (mask) {
        maskingKey = buf.readUint32BE(pos)
        pos += 4
    }

    const [payload, remainingLength] = readFrameIntoPayload(buf, len, pos, maskingKey, payloadBuf.subarray(0, len))

    let carry: Buffer | undefined
    if ((len + pos) < buf.byteLength) {
        if (remainingLength) {
            throw new Error(`??? buf: ${buf.byteLength} len: ${len} pos: ${pos} reminaing: ${remainingLength}`)
        }
        carry = buf.subarray(len + pos)
    }

    return {
        fin,
        payload,
        maskingKey,
        remainingLength,
        op: op as Opcode,
        carry,
    }
}

function rotateKey(maskingKey: number, offset: number) {
    switch (offset % 4) {
        case 0:
            return maskingKey
        case 1:
            return (maskingKey >>> 8) | (maskingKey << 24)
        case 2:
            return (maskingKey >>> 16) | (maskingKey << 16)
        case 3:
            return (maskingKey >>> 24) | (maskingKey << 8)
        default:
            throw new Error(`Unexpected offset: ${offset}`)
    }
}

function readFrameIntoPayload(buf: Buffer, len: number, pos: number, maskingKey?: number, payload = Buffer.allocUnsafe(len), offset = 0) {
    let remainingLength: number | undefined

    if (len > (buf.length - pos)) {
        const truncated = buf.length - pos
        remainingLength = len - truncated
        len = truncated
    }

    if (maskingKey !== undefined) {
        maskingKey = rotateKey(maskingKey, offset)

        let i: number
        for (i = 0; i < len - 4; i += 4) {
            // Bitwise XOR converts everything to 32-bit integers
            payload.writeInt32BE(buf.readInt32BE(pos + i) ^ maskingKey, offset + i)
        }
        for (; i < len; i++) {
            const m = i % 4
            const k = (maskingKey >>> (m === 0 ? 24 : m === 1 ? 16 : m === 2 ? 8 : 0)) & 0xFF
            payload.writeUint8(buf.readUint8(pos + i) ^ k, offset + i)
        }
    } else {
        payload.set(buf.subarray(pos, pos + len), offset)
    }

    return [payload, remainingLength] as const
}

enum Opcode {
    Continue = 0,
    Text = 1,
    Binary = 2,
    Close = 8,
    Ping = 9,
    Pong = 10,
}

enum StatusCode {
    Success = 1000,
    Leaving = 1001,
    ProtocolError = 1002,
    UnrecognizedDataType = 1003,
    NoStatusCode = 1005, // MUST NOT be sent over the wire
    UnexpectedCloseState = 1006, // MUST NOT be sent over the wire
    InconsistentDataType = 1007,
    Rejection = 1008,
    MessageTooBig = 1009,
    MissingExtension = 1010,
    InternalError = 1011,
    BadCert = 1015,
}


// interface EventBase {
//     readonly type: string
// }


// interface EventTarget {
//     addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void;
//     dispatchEvent(event: EventBase): boolean;
//     removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void;
// }

// declare var WebSocket: {
//     prototype: WebSocket;
//     new(url: string | URL, protocols?: string | string[]): WebSocket;
//     readonly CONNECTING: 0;
//     readonly OPEN: 1;
//     readonly CLOSING: 2;
//     readonly CLOSED: 3;
// };

// interface MessageEvent<T> extends EventBase {
//     readonly type: 'message'
//     readonly data: T;
//     /**
//      * Returns the last event ID string, for server-sent events.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/lastEventId)
//      */
//     readonly lastEventId: string;
//     /**
//      * Returns the origin of the message, for server-sent events and cross-document messaging.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/origin)
//      */
//     readonly origin: string;
//     /**
//      * Returns the MessagePort array sent with the message, for cross-document messaging and channel messaging.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/ports)
//      */
//     readonly ports: ReadonlyArray<MessagePort>;
//     /**
//      * Returns the WindowProxy of the source window, for cross-document messaging, and the MessagePort being attached, in the connect event fired at SharedWorkerGlobalScope objects.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MessageEvent/source)
//      */
//     readonly source: MessageEventSource | null;
// }

// interface CloseEvent extends EventBase {
//     readonly type: 'close'
//     readonly code: number
//     readonly reason: string
//     readonly wasClean: boolean
// }

// interface WebSocketEventMap {
//     "close": CloseEvent;
//     "error": Event;
//     "message": MessageEvent;
//     "open": Event;
// }

// /**
//  * Provides the API for creating and managing a WebSocket connection to a server, as well as for sending and receiving data on the connection.
//  *
//  * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket)
//  */
// interface WebSocket extends EventTarget {
//     /**
//      * Returns a string that indicates how binary data from the WebSocket object is exposed to scripts:
//      *
//      * Can be set, to change how binary data is returned. The default is "blob".
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/binaryType)
//      */
//     binaryType: BinaryType;
//     /**
//      * Returns the number of bytes of application data (UTF-8 text and binary data) that have been queued using send() but not yet been transmitted to the network.
//      *
//      * If the WebSocket connection is closed, this attribute's value will only increase with each call to the send() method. (The number does not reset to zero once the connection closes.)
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/bufferedAmount)
//      */
//     readonly bufferedAmount: number;
//     /**
//      * Returns the extensions selected by the server, if any.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/extensions)
//      */
//     readonly extensions: string;
//     /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/close_event) */
//     onclose: ((this: WebSocket, ev: CloseEvent) => any) | null;
//     /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/error_event) */
//     onerror: ((this: WebSocket, ev: Event) => any) | null;
//     /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/message_event) */
//     onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null;
//     /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/open_event) */
//     onopen: ((this: WebSocket, ev: Event) => any) | null;
//     /**
//      * Returns the subprotocol selected by the server, if any. It can be used in conjunction with the array form of the constructor's second argument to perform subprotocol negotiation.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/protocol)
//      */
//     readonly protocol: string;
//     /**
//      * Returns the state of the WebSocket object's connection. It can have the values described below.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/readyState)
//      */
//     readonly readyState: number;
//     /**
//      * Returns the URL that was used to establish the WebSocket connection.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/url)
//      */
//     readonly url: string;
//     /**
//      * Closes the WebSocket connection, optionally using code as the the WebSocket connection close code and reason as the the WebSocket connection close reason.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/close)
//      */
//     close(code?: number, reason?: string): void;
//     /**
//      * Transmits data using the WebSocket connection. data can be a string, a Blob, an ArrayBuffer, or an ArrayBufferView.
//      *
//      * [MDN Reference](https://developer.mozilla.org/docs/Web/API/WebSocket/send)
//      */
//     send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
//     readonly CONNECTING: 0;
//     readonly OPEN: 1;
//     readonly CLOSING: 2;
//     readonly CLOSED: 3;
//     addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
//     addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
//     removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (this: WebSocket, ev: WebSocketEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
//     removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
// }

// declare var WebSocket: {
//     prototype: WebSocket;
//     new(url: string | URL, protocols?: string | string[]): WebSocket;
//     readonly CONNECTING: 0;
//     readonly OPEN: 1;
//     readonly CLOSING: 2;
//     readonly CLOSED: 3;
// };
