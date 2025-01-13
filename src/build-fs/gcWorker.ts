import * as fs from 'fs/promises'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { getFs, runWithContext } from '../execution'
import { ensureDir, watchForFile } from '../system'
import { getLogger } from '../logging'
import { getBuildDir, getLogsDirectory, getUserSynapseDirectory } from '../workspaces'
import { Bundle } from 'synapse:lib'
import { getGcInfoPath, startGarbageCollection } from './gc'
import { logToStderr } from '../cli/logger'

async function runGc() {
    const buildDir = process.argv[2]
    if (!buildDir) {
        throw new Error(`No build dir provided`)
    }

    logToStderr(getLogger())
    process.send?.({ status: 'ready' })
    await runWithContext({}, () => startGarbageCollection(buildDir))
    await getFs().writeFile(getGcInfoPath(), JSON.stringify({}))
}

const startFn = new Bundle(runGc, {
    immediatelyInvoke: true,
})

const getLogsFile = () => path.resolve(getLogsDirectory(), 'gc.log')

export async function startGcProcess(buildDir: string) {
    const logFile = getLogsFile()
    await ensureDir(logFile)
    const log = await fs.open(logFile, 'w')
    const proc = child_process.fork(
        startFn.destination, 
        [buildDir],
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
