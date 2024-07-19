import * as path from 'node:path'
import * as perf from 'node:perf_hooks'
import { formatWithOptions } from 'node:util'
import { LogEvent, Logger, PerfDetail } from '../logging'
import { FsEntityStats, openHandle } from '../system'
import { memoize } from '../utils'
import { getExecutionId, getFs } from '../execution'
import { getLogsDirectory } from '../workspaces'
import { isDataPointer } from '../build-fs/pointers'

const fmtDuration = (val: number, digits = 3) => `${Math.floor(val * Math.pow(10, digits)) / Math.pow(10, digits)} ms`

// Could also add the symbol `nodejs.util.inspect.custom`
function format(a: any) {
    if (isDataPointer(a)) {
        if (!a.isResolved()) {
            return `DataPointer <unresolved ${a.hash.slice(0, 12)}>`
        }

        const { hash, storeHash } = a.resolve()
        if (!storeHash) {
            return `DataPointer <no metadata ${hash.slice(0, 12)}>`
        }

        return `DataPointer <${storeHash.slice(0, 12)} ${hash.slice(0, 12)}>`
    }

    return a
}

const print = (...args: any[]) => formatWithOptions({ colors: false, depth: 4 }, ...args.map(format))

export function logToFile(
    logger: Logger,
    logLevel: Exclude<LogEvent['level'], 'raw'> = 'debug',
    fileName = path.resolve(getLogsDirectory(), `${getExecutionId()}.log`),
) {
    // Log entries are buffered in-mem until the file handle is ready
    const buffer: string[] = []
    const getHandle = memoize(async () => {
        const h = await openHandle(fileName).catch(e => {
            console.error(e)
            throw e
        })

        while (buffer.length > 0) {
            h.write(buffer.shift()!)
        }

        return h
    })


    let handle: Awaited<ReturnType<typeof openHandle>>
    function enqueue(entry: string) {
        if (!handle) {
            buffer.push(entry)
            getHandle().then(h => handle = h)
        } else {
            handle.write(entry)
        }
    }

    const listeners: { dispose: () => void }[] = []

    listeners.push(logger.onPerf(ev => {
        const displayName = ev.taskType ? `${ev.taskType} (${ev.taskName})` : `${ev.taskName}`

        if (ev.duration > (ev.slowThreshold ?? 1000)) {
            const timestamp = ev.timestamp.toISOString()
            enqueue(`${timestamp} [PERF] ${print(displayName, fmtDuration(ev.duration))}\n`)
        }
    }))

    listeners.push(logger.onLog(ev => {
        if (ev.level === 'raw') { // This is for terraform logs
            enqueue(ev.args[0])
        } else {
            if (compareLogLevel(ev.level, logLevel) > 0) { 
                return
            }

            // Timestamps are always printed using UTC
            const timestamp = ev.timestamp.toISOString()
            const entry = `${timestamp} [${ev.level.toUpperCase()}] ${print(...ev.args)}\n`
            enqueue(entry)
        }
    }))

    async function dispose() {
        listeners.forEach(l => l.dispose())
        if (!getHandle.cached && buffer.length === 0) {
            return
        }

        return getHandle().then(h => h.dispose())
    }

    return { dispose }
}

export async function listLogFiles() {
    const fs = getFs()
    const logsDir = getLogsDirectory()
    const files = await fs.readDirectory(logsDir).catch(e => {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
        return []
    })

    return files.filter(f => f.type === 'file').map(f => path.resolve(logsDir, f.name))
}

export async function getMostRecentLogFile() {
    const sorted = await getSortedLogs()

    return sorted[0]?.filePath as string | undefined
}

export async function getSortedLogs() {
    const files = await listLogFiles()
    const stats: (FsEntityStats & { filePath: string })[] = []
    for (const f of files) {
        try {
            stats.push({
                filePath: f,
                ...(await getFs().stat(f)),
            })
        } catch (e) {
            if ((e as any).code === 'EPERM') {
                // File is probably open somewhere else
            } else if ((e as any).code !== 'ENOENT') {
                throw e
            }
        }

    }

    return stats.sort((a, b) => b.ctimeMs - a.ctimeMs)
}

export async function purgeOldLogs() {
    const sorted = await getSortedLogs()
    for (const f of sorted.slice(25)) {
        if (f.filePath.endsWith('analytics.log')) continue // XXX
        await getFs().deleteFile(f.filePath).catch(e => {
            if ((e as any).code !== 'ENOENT') {
                // Failed to delete log file for some reason (possibly opened?)
            }

            // Log file was deleted by something else
        })
    }
}

const levels = new Set(['error', 'warn', 'info', 'debug', 'trace'])

function logLevelOrder(logLevel: Exclude<LogEvent['level'], 'raw'>): number {
    switch (logLevel) {
        case 'error':
            return 0
        case 'warn':
            return 1
        case 'info':
            return 2
        case 'debug':
            return 3
        case 'trace':
            return 4
    }
}

export type LogLevel = Exclude<LogEvent['level'], 'raw'>
export function validateLogLevel(level: string): LogLevel | undefined {
    if (levels.has(level)) {
        return level as LogLevel
    }
}

function compareLogLevel(a: LogLevel, b: typeof a) {
    return logLevelOrder(a) - logLevelOrder(b)
}

export function logToStderr(logger: Logger, logLevel: LogLevel = 'debug') {
    const stream = process.stderr
    const print = (...args: any[]) => formatWithOptions({ colors: stream.isTTY, depth: 4 }, ...args)
    const level = logLevelOrder(logLevel)

    logger.onLog(ev => {
        if (ev.level === 'raw') { // This is for terraform logs
            stream.write(ev.args[0])
        } else if (logLevelOrder(ev.level) <= level) {
            const timestamp = ev.timestamp.toISOString()
            stream.write(`${timestamp} [${ev.level.toUpperCase()}] ${print(...ev.args)}\n`)
        }
    })

    logger.onPerf(ev => {
        const displayName = ev.taskType ? `${ev.taskType} (${ev.taskName})` : `${ev.taskName}`

        if (ev.duration > (ev.slowThreshold ?? 100)) {
            const timestamp = ev.timestamp.toISOString()
            stream.write(`${timestamp} [PERF] ${print(displayName, fmtDuration(ev.duration))}\n`)
        }
    })

    logger.onDeploy(ev => {
        if (ev.status === 'failed') {
            logger.error(`Failed to deploy ${ev.resource}:`, (ev as any).reason)
        }
    })

    logger.onTest(ev => {
        // XXX: don't write out suite names
        if (ev.parentId === undefined) {
            return
        }

        if (ev.status === 'passed') {
            stream.write(`[TEST]: ${ev.name} [passed]\n`)
        } else if (ev.status === 'failed') {
            stream.write(`[TEST]: ${ev.name} [failed]\n`)
            stream.write(print(ev.reason).split('\n').map(x => `  ${x}`).join('\n') + '\n')
        }
    })

    logger.onTestLog(ev => {
        if (logLevelOrder(ev.level) <= level) {
            stream.write(`> (${ev.name}) [${ev.level.toUpperCase()}] ${print(...ev.args)}\n`)
        }
    })

    registerDeployPerfHook(logger)

    return { dispose: () => logger.dipose() }
}

// Translates `deploy` events into timing events
function registerDeployPerfHook(logger: Logger, slowThreshold = 100) {
    const marked = new Set<string>()

    return logger.onDeploy(ev => {
        const detail: PerfDetail = { taskType: 'deploy', taskName: ev.resource, slowThreshold }

        // FIXME: this can collide if deploying multiple programs as the same time
        if (ev.status === 'applying' && !marked.has(ev.resource)) {
            perf.performance.mark(`deploy-${ev.resource}`, { detail })
            marked.add(ev.resource)
        }

        if (ev.status === 'complete' && marked.has(ev.resource)) {
            const markName = `deploy-${ev.resource}`
            perf.performance.measure(`deploy-${ev.resource}-complete`, { start: markName, detail })
            perf.performance.clearMarks(markName)
            marked.delete(ev.resource)
        }
    })
}
