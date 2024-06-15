import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as net from 'node:net'
import * as child_process from 'node:child_process'
import { listenAll, getLogger } from '../logging'
import { executeCommand } from './commands'
import { getSocketsDirectory } from '../workspaces'

const getSocketPath = () => path.resolve(getSocketsDirectory(), 'daemon.sock')

interface IpcEventMessage {
    readonly type: 'event'
    readonly data: any
}

interface IpcStdoutMessage {
    readonly type: 'stdout'
    readonly data: string | Buffer
}

interface IpcErrorMessage {
    readonly type: 'error'
    readonly data: any
}

type IpcMessage = IpcEventMessage | IpcStdoutMessage | IpcErrorMessage

interface IpcCommand {
    name: string
    args: string[]
}

export async function startServer() {
    const server = net.createServer()

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(getSocketPath(), () => {
            server.removeListener('error', reject)
            resolve()
        })
    })

    async function shutdown() {
        [...sockets].forEach(s => s.end())
        await new Promise<void>((resolve, reject) => {
            server.close(err => err ? reject(err) : resolve())
        })
        process.exit(0)
    }

    async function handleRequest(command: IpcCommand) {
        try {
            if (command.name === 'shutdown') {
                return await shutdown()
            }

            await executeCommand(command.name, command.args)

            return {
                type: 'stdout',
                data: '',
            }
        } catch (e) {
            return {
                type: 'error',
                data: {
                    ...(e as any),
                    name: (e as any).name,
                    message: (e as any).message,
                    stack: (e as any).stack,
                }
            }
        }
    }

    const sockets = new Set<net.Socket>()

    function sendMessage(socket: net.Socket, message: string | Buffer) {
        return new Promise<void>((resolve, reject) => {
            socket.write(message, err => err ? reject(err) : resolve())
        })
    }

    async function broadcast(msg: string | Buffer) {
        await Promise.all([...sockets].map(s => sendMessage(s, msg)))
    }

    async function broadcastEvent(ev: any) {
        await broadcast(JSON.stringify({ type: 'event', data: ev } satisfies IpcEventMessage) + '\n')
    }

    process.stdout.on('data', d => getLogger().raw(d))

    listenAll(getLogger(), broadcastEvent)

    server.on('connection', socket => {
        sockets.add(socket)

        socket.on('end', () => {
            sockets.delete(socket)
        })

        socket.on('data', async d => {
            const cmd = JSON.parse(d.toString('utf-8')) as IpcCommand
            const resp = await handleRequest(cmd)
            socket.write(JSON.stringify(resp) + '\n')
        })

        // socket.on('error', ...)
    })

    // server.on('close', async () => {
    //     await shutdown()
    // })

    process.send?.({ status: 'ready' })
}

async function startDaemon(daemonModule: string) {
    const proc = child_process.fork(
        path.resolve(__dirname, '..', 'runtime', 'entrypoint.js'), 
        [daemonModule],
        { 
            stdio: 'ignore',
            detached: true,
        }
    )

    await new Promise<void>((resolve, reject) => {
        proc.on('error', reject)
        proc.on('message', ev => {
            if (typeof ev === 'object' && !!ev && 'status' in ev && ev.status === 'ready') {
                resolve()
            }
        })
    })

    proc.unref()
    proc.disconnect()
}

async function startDaemonIfDown(daemonModule: string, socketPath = getSocketPath()) {
    try {
        await fs.access(socketPath, fs.constants.F_OK)

        return await openSocket(socketPath)
    } catch(e) {
        await startDaemon(daemonModule)

        return openSocket(socketPath)
    }
}

async function openSocket(socketPath: string) {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
        function complete(err?: Error) {
            s.removeListener('error', complete)
            s.removeListener('ready', complete)

            if (err) {
                reject(err)
            } else {
                resolve(s)
            }
        }

        const s = net.connect(socketPath)
        s.once('ready', complete)
        s.once('error', complete)
    })

    return socket
}

export async function connect(daemonModule: string) {
    const socket = await startDaemonIfDown(daemonModule)

    async function runCommand(name: string, args: string[]) {
        const p = new Promise<void>((resolve, reject) => {
            function complete(err?: Error) {
                socket.removeListener('exit', exit)
                socket.removeListener('data', handleData)
    
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
            }

            let buffer = ''
            async function handleData(d: Buffer) {
                buffer += d.toString('utf-8')

                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''

                for (const l of lines) {
                    const msg = JSON.parse(l) as IpcMessage

                    if (msg.type === 'error') {
                        complete(msg.data)
                    } else if (msg.type === 'stdout') {
                        complete()
                    } else {
                        getLogger().emit(msg.data.type, msg.data)
                    }
                }
            }

            function exit() {
                complete(new Error(`Socket closed unexpectedly`))
            }
    
            socket.on('exit', exit)
            socket.on('data', handleData)  
        })

        await new Promise<void>(async (resolve, reject) => {
            socket.write(
                JSON.stringify({ name, args } satisfies IpcCommand), 
                err => err ? reject(err) : resolve()
            )
        })

        return p
    }

    async function shutdown() {
        return runCommand('shutdown', [])
    }

    async function dispose() {
        await new Promise<void>((resolve, reject) => socket.end(resolve))
    }

    return {
        runCommand,
        shutdown,
        dispose,
    }
}