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
    return crypto.createHash('sha1').update(key + WebSocketGUID).digest().toString('base64')
}

const slice = (buf: Buffer, start: number, end?: number) => Uint8Array.prototype.slice.call(buf, start, end)

interface WebSocketServer {
    close: () => Promise<void>
    onConnect: (listener: (ws: WebSocket) => void) => { dispose: () => void }
}

interface WebSocketServerOptions {
    port?: number
    address?: string
    secureContext?: tls.SecureContextOptions
    beforeUpgrade?: (request: HttpRequest) => Promise<HttpResponse | void> | HttpResponse | void
    httpRequestHandler?: (request: HttpRequest, body: any) => Promise<HttpResponse> | HttpResponse
}

export async function upgradeToWebsocket(req: http.IncomingMessage, socket: Duplex, isSecureContext = true): Promise<WebSocket | undefined> {
    const key = req.headers['sec-websocket-key']
    const protocol = req.headers['sec-websocket-protocol']
    if (!key) {
        console.log('No key')
        socket.destroy()
        return
    }

    const headers = new Headers({
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Accept': getWsKey(key),
        // 'Sec-WebSocket-Protocol': protocol ? protocol.split(',')[0] : '',
    })

    function getBaseUrl() {
        const scheme = isSecureContext ? 'wss' : 'ws'
        
        return scheme + '://' + req.headers['host']!
    }

    // TODO: clean this up
    const url = new URL(req.url!, getBaseUrl())

    const resp = [
        'HTTP/1.1 101 Switching Protocols',
        ...Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`),
        '',
    ].join('\r\n')


    return new Promise<WebSocket>((resolve, reject) => {
        socket.write(resp + '\r\n', err => {
            if (!err) {
                resolve(upgradeSocket(socket, url))
            } else {
                reject(err)
            }
        })
    })
}

/** @internal */
export async function createWebsocketServer(opt: WebSocketServerOptions = {}): Promise<WebSocketServer> {
    const server = opt?.secureContext 
        ? https.createServer(opt.secureContext)
        : http.createServer()

    const emitter = new EventEmitter()
    const connectEvent: Event<[ws: WebSocket]> = createEvent(emitter, 'connect')

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

    const sockets = new Set<WebSocket>()
    server.on('upgrade', async (req, socket, head)  => {
        const beforeUpgradeResp = await opt.beforeUpgrade?.({
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

        const ws = await upgradeToWebsocket(req, socket, !!opt.secureContext)
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

    const port = opt.port ?? (opt.secureContext ? 443 : 80)
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
    send: (data: string | Uint8Array) => Promise<void>
    close: (message?: string) => Promise<void>
    onClose: (listener: (code?: StatusCode, reason?: string) => void) => { dispose: () => void }
    onMessage: (listener: (message: string | Buffer) => void) => { dispose: () => void }
    onError: (listener: (error: unknown) => void) => { dispose: () => void }
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

function upgradeSocket(socket: Duplex, url: URL, mode: 'client' | 'server' = 'server'): WebSocket {
    const emitter = new EventEmitter()
    const pongEvent: Event<[message: string]> = createEvent(emitter, 'pong')
    const errorEvent: Event<[error: unknown]> = createEvent(emitter, 'error')
    const closeEvent: Event<[code?: StatusCode, reason?: string]> = createEvent(emitter, 'close')
    const messageEvent: Event<[message: string | Buffer]> = createEvent(emitter, 'message')

    function ping(msg: string = '') {
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

    async function send(msg: string | Uint8Array) {
        const maskingKey = mode === 'client' ? await randomInt32() : undefined

        return new Promise<void>((resolve, reject) => {
            socket.write(
                createFrame(Opcode.Text, Buffer.from(msg), maskingKey),
                err => err ? reject(err) : resolve()
            )
        })
    }

    async function close(reason?: string) {
        state = SocketState.Closing

        try {
            const closePromise = new Promise<void>((resolve, reject) => {
                socket.once('end', () => resolve())
                // socket.once('error', reject)
            })

            await sendClose(StatusCode.Success, reason)
            await closePromise
        } finally {
            state = SocketState.Closed
        }
    }

    async function sendClose(code?: StatusCode, reason?: string | Uint8Array) {
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

    async function handleFrame(frame: Frame) {
        switch (frame.op) {
            case Opcode.Pong:
                return pongEvent.fire(frame.payload.toString('utf-8'))
            case Opcode.Ping:
                return socket.write(createFrame(Opcode.Pong, frame.payload))
            case Opcode.Close: {
                let code: StatusCode | undefined
                let reason: Buffer | undefined

                if (frame.payload.length >= 2) {
                    code = frame.payload.readUint16BE()
                    reason = Buffer.from(slice(frame.payload, 2))
                }

                closeEvent.fire(code, reason?.toString('utf-8'))

                if (state !== SocketState.Closing && state !== SocketState.Closed) {
                    // console.log('closing', code, reason)
                    state = SocketState.Closing
    
                    try {
                        await sendClose(code, reason)
                    } finally {
                        socket.end(() => state = SocketState.Closed)
                    }
                }

                return
            }
            case Opcode.Text:
            case Opcode.Binary: {
                if (state !== SocketState.Ready) {
                    throw new Error(`Unexpected socket state: ${state}`)
                }

                if (frame.fin) {
                    const res = frame.op === Opcode.Text ? frame.payload.toString('utf-8') : frame.payload
                    messageEvent.fire(res)
                } else {
                    messageBuffer.push(frame.payload)
                    state = frame.op === Opcode.Text ? SocketState.ReadingText : SocketState.ReadingBinary
                }

                return
            }
            case Opcode.Continue: {
                if (state !== SocketState.ReadingText && state !== SocketState.ReadingBinary) {
                    throw new Error(`Unexpected continuation state: ${state}`)
                }

                if (frame.fin) {
                    const res = state === SocketState.ReadingText 
                        ? messageBuffer.join('') 
                        : Buffer.concat(messageBuffer)
                    messageEvent.fire(res)
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
    socket.on('data', async (buf: Buffer) => {
        let frame: Frame
        if (lastFrame) {
            const [_, remainingLength] = readFrameIntoPayload(buf, lastFrame.remainingLength!, 0, lastFrame.maskingKey, lastFrame.payload, lastFrame.payload.length - lastFrame.remainingLength!)

            lastFrame.remainingLength = remainingLength
            if (lastFrame.remainingLength) {
                return
            }

            frame = lastFrame
            lastFrame = undefined
        } else {
            frame = readFrame(buf)
        }

        if (frame.remainingLength) {
            lastFrame = frame
            return
        }

        try {
            await handleFrame(frame)
        } catch (e) {
            errorEvent.fire(e)
        }
    })

    return {
        url,
        ping,
        send,
        close,
        onClose: closeEvent.on,
        onError: errorEvent.on,
        onMessage: messageEvent.on,
    }
}

/** @internal */
export async function createWebsocket(url: string | URL, authorization?: string): Promise<WebSocket> {
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
                if (headers['sec-websocket-protocol']) {
                    return complete(new Error(`Invalid subprotocol: ${headers['sec-websocket-protocol']}`))
                }

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

// https://stackoverflow.com/a/23329386
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

function *chunk(buf: Buffer, amount: number) {
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

function createFrame(op: Opcode, payload?: Buffer, maskingKey?: number, fin = true) {
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
    }
    if (p === 127) {
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
        pos += payload.length
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
}

function readFrame(buf: Buffer): Frame {
    let pos = 0
    const h1 = buf.readUint8(pos)
    pos += 1
    const h2 = buf.readUint8(pos)
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

    const [payload, remainingLength] = readFrameIntoPayload(buf, len, pos, maskingKey)

    return {
        fin,
        payload,
        maskingKey,
        remainingLength,
        op: op as Opcode,
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
        payload.set(Uint8Array.prototype.slice.call(buf, pos, pos + len), offset)
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
