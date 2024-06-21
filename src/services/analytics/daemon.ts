import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as net from 'node:net'
import * as child_process from 'node:child_process'
import { Bundle } from 'synapse:lib'
import { logToFile } from '../../cli/logger'
import { getLogger } from '../../logging'
import { createClient, AnalyticsEvent } from './backend'
import { getLogsDirectory, getSocketsDirectory } from '../../workspaces'
import { ensureDir } from '../../system'
import { memoize } from '../../utils'

const getSocketPath = () => path.resolve(getSocketsDirectory(), 'analytics.sock')

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

interface AnalyticsCommand {
    name: 'analytics'
    args: AnalyticsEvent[]
}

const hasClient = (function () {
    try {
        createClient()
        return true
    } catch {
        return false
    }
})()

const getClient = memoize(createClient)

const getLogFile = () => path.resolve(getLogsDirectory(), 'analytics.log')
const getStartupLogs = () => path.resolve(getLogsDirectory(), 'analytics-startup.log')

export async function startServer() {
    const disposable = logToFile(getLogger(), undefined, getLogFile())
    const server = net.createServer()

    const inactivityTimer = setInterval(async () => {
        if (sockets.size > 0) {
            return
        }

        getLogger().log('Shutting down due to inactivity')
        await shutdown()
    }, 300_000).unref()

    getLogger().log('Opening socket')

    const socketPath = getSocketPath()

    await new Promise<void>((resolve, reject) => {
        server.once('error', async e => {
            if ((e as any).code === 'EACCES') {
                await fs.mkdir(path.dirname(socketPath), { recursive: true })
                server.once('error', reject)
                return server.listen(socketPath, resolve)
            }

            if ((e as any).code !== 'EADDRINUSE') {
                return reject(e)
            }

            getLogger().log('Removing old socket')
            await fs.rm(socketPath)
            server.once('error', reject)
            server.listen(socketPath, resolve)
        })

        server.listen(socketPath, resolve)
    })

    let timer: NodeJS.Timeout | undefined
    const buffer: AnalyticsEvent[] = []
    function enqueue(...events: AnalyticsEvent[]) {
        buffer.push(...events)

        if (timer !== undefined) {
            clearTimeout(+timer)
        }

        if (buffer.length >= 25) {
            flush()
        } else {
            timer = setTimeout(flush, 30_000)
        }
    }

    async function _flush() {
        while (buffer.length > 0) {
            const batch = buffer.splice(0, 25)
            await getClient().postEvents({ batch })
        }
    }

    let p: Promise<void> | undefined
    function flush() {
        return p ??= _flush().finally(() => (p = undefined))
    }

    async function shutdown() {
        [...sockets].forEach(s => s.end())
        await new Promise<void>((resolve, reject) => {
            server.close(err => err ? reject(err) : resolve())
        })
        // TODO: we should use a lock when we start shutting down
        // There's a race condition atm
        await fs.rm(getLogFile()).catch(() => {})
        clearTimeout(timer)
        await flush()
        await disposable.dispose()
        process.exit(0)
    }

    async function handleRequest(command: IpcCommand | AnalyticsCommand) {
        try {
            if (command.name === 'shutdown') {
                return await shutdown()
            }

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
    

    server.on('connection', socket => {
        inactivityTimer.refresh().unref()
        sockets.add(socket)

        socket.on('end', () => {
            sockets.delete(socket)
        })

        socket.on('data', d => {
            inactivityTimer.refresh().unref()
            const cmd = JSON.parse(d.toString('utf-8')) as IpcCommand
            if (cmd.name === 'analytics') {
                const batch = (cmd as any).args as AnalyticsEvent[]
                if (hasClient) {
                    enqueue(...batch)
                }

                return 
            }

            handleRequest(cmd).then(resp => {
                socket.write(JSON.stringify(resp) + '\n')

            })
        })

        // socket.on('error', ...)
    })

    // server.on('close', async () => {
    //     await shutdown()
    // })

    getLogger().log('Sending ready message')

    process.send?.({ status: 'ready' })
}

async function startDaemon(daemonModule: string) {
    const logFile = getStartupLogs()
    await ensureDir(logFile)
    const log = await fs.open(logFile, 'w')
    const proc = child_process.fork(
        daemonModule, 
        [],
        { 
            stdio: ['ignore', log.fd, log.fd, 'ipc'],
            detached: true,
        }
    )

    await new Promise<void>((resolve, reject) => {
        function onMessage(ev: child_process.Serializable) {
            if (typeof ev === 'object' && !!ev && 'status' in ev && ev.status === 'ready') {
                close()
            }
        }

        function onExit(code: number | null, signal: NodeJS.Signals | null) {
            if (code) {
                close(new Error(`Non-zero exit code: ${code}\n  logs: ${logFile}`))
            } else if (signal) {
                close(new Error(`Received signal to exit: ${signal}`))
            }
            close(new Error(`Process exited without sending a message`))
        }

        function close(err?: any) {
            if (err) {
                reject(err)
            } else {
                resolve()
            }
            proc.removeListener('message', onMessage)
            proc.removeListener('error', close)
            proc.removeListener('error', onExit)
        }

        proc.on('message', onMessage)
        proc.on('error', close)
        proc.on('exit', onExit)
    }).finally(() => log.close())

    proc.unref()
    proc.disconnect()
}

async function startDaemonIfDown(daemonModule: string, socketPath = getSocketPath()) {
    try {
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

const startFn = new Bundle(startServer, {
    immediatelyInvoke: true,
})

export async function connect() {
    const socket = await startDaemonIfDown(startFn.destination)
    socket.on('error', err => {
        getLogger().error('analytics socket', err)
    })

    async function runCommand(name: string, args: string[] | AnalyticsEvent[]) {
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
            socket.on('close', exit)
            socket.on('data', handleData)  
        })

        await new Promise<void>(async (resolve, reject) => {
            socket.write(
                JSON.stringify({ name, args: args as any } satisfies IpcCommand), 
                err => err ? reject(err) : resolve()
            )
        })

        return p
    }

    async function shutdown() {
        return runCommand('shutdown', [])
    }

    function sendAnalytics(events: AnalyticsEvent[]) {
        return new Promise<void>(async (resolve, reject) => {
            socket.write(
                JSON.stringify({ name: 'analytics', args: events as any } satisfies IpcCommand), 
                err => err ? reject(err) : resolve()
            )
        })
    }

    async function dispose() {
        await new Promise<void>((resolve, reject) => socket.end(resolve))
    }

    return {
        shutdown,
        dispose,
        sendAnalytics,

        destroySocket: () => socket.destroy(),
    }
}