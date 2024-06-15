import * as path from 'node:path'
import { DataRepository, getDataRepository } from '../artifacts'
import { getFs, runWithContext, throwIfCancelled } from '../execution'
import { ensureDirSync, watchForFile } from '../system'
import { acquireFsLock, getCiType, throwIfNotFileNotFoundError } from '../utils'
import { BuildFsStats, collectStats, diffSets, getEventLogger, mergeRepoStats, printStats } from './stats'
import { colorize, getDisplay, printLine } from '../cli/ui'
import { getLogger } from '..'
import { startGcProcess } from './gcWorker'
import { getBuildDir, getUserSynapseDirectory } from '../workspaces'
import { readKeySync } from '../cli/config'

const gcIntervalMs = 6 * 60 * 60 * 1000 // 6 hours
export const getGcInfoPath = () => path.resolve(getUserSynapseDirectory(), 'gc-info.json')

function createGcView() {
    const view = getDisplay().getOverlayedView()
    const logger = getEventLogger()

    let discovered = 0
    let deleted = 0

    const status = view.createRow()
    function updateStatus() {
        const phase = deleted > 0 ? 'destroy' : 'search'
        const suffix = phase === 'search' 
            ? (discovered === 0 ? '' : ` (${discovered})`)
            : ` (${deleted} / ${discovered})`
        const msg = phase === 'search' ? 'Searching...' : 'Deleting...'
        status.update(`${msg}${suffix}`)
    }

    logger.onGc(ev => {
        if (ev.discovered) {
            discovered += ev.discovered
        }
        if (ev.deleted) {
            deleted += ev.deleted
        }
        updateStatus()
    })

    const printLine = (...args: any[]) => view.writeLine(args.map(String).join(' '))

    logger.onGcSummary(ev => {
        if (!ev.dryrun) {
            status.release(colorize('green', `Done!`))
        } else {
            status.destroy()
            printLine(`Dangling objects`, ev.numObjects)
            printLine(`Empty directories (after delete)`, ev.numDirs)
        }
    })
}

const settings = {
    maxCommits: 10,
    pruneAge: 24 * 60 * 60 * 1000, // 1 day
    useLock: false,
}

function getPruneAge() {
    return readKeySync<number>('gc.pruneAge') ?? settings.pruneAge
}

export function startGarbageCollection(buildDir?: string) {
    const ac = new AbortController()
    const repo = getDataRepository(getFs(), buildDir)
    const cancelError = new Error('Cancelled')

    const locksDir = repo.getLocksDir()
    const stopGcPath = path.resolve(locksDir, 'stop-gc')
    ensureDirSync(stopGcPath)

    function cancel() {
        clearTimeout(cancelTimer)
        ac.abort(cancelError)
    }

    function cancelOnRequest() {
        getLogger().debug(`Received request to stop garbage collection`)
        cancel()
    }

    function cancelOnTimeout() {
        getLogger().debug(`Cancelling garbage collection due to timeout`)
        cancel()
    }

    const maxGcTime = 60_000
    const cancelTimer = setTimeout(cancelOnTimeout, maxGcTime - 5_000).unref()

    const stopWatcher = watchForFile(stopGcPath)
    stopWatcher.onFile(cancelOnRequest)

    /** Returns true on success, false if cancelled */
    async function start() {
        await using gcLock = settings.useLock 
            ? await acquireFsLock(path.resolve(locksDir, 'gc'), maxGcTime)
            : undefined

        if (gcLock) {
            getLogger().log('Lock acquired')
        }

        try {
            await cleanArtifacts(repo)
            getLogger().log('GC complete')

            return true
        } catch (e) {
            if (e !== cancelError) {
                throw e
            }

            return false
        } finally {
            clearTimeout(cancelTimer)
            stopWatcher.dispose()
            await getFs().deleteFile(stopGcPath).catch(throwIfNotFileNotFoundError)
        }
    }

    return runWithContext({ abortSignal: ac.signal }, start)
}


interface GcTrigger extends AsyncDisposable {
    cancel(): void
}

// XXX: must be a function, otherwise `Symbol.asyncDispose` won't be initialized
function getAsyncDispose(): typeof Symbol.asyncDispose {
    if (!Symbol.asyncDispose) {
        const asyncDispose = Symbol.for('Symbol.asyncDispose')
        Object.defineProperty(Symbol, 'asyncDispose', { value: asyncDispose, enumerable: true })
    }

    return Symbol.asyncDispose
}

export function maybeCreateGcTrigger(alwaysRun = false): GcTrigger | undefined {
    if (!alwaysRun && getCiType()) {
        return
    }

    const infoPath = getGcInfoPath()
    const statsPromise = getFs().stat(infoPath).catch(e => {
        if ((e as any).code === 'ENOENT') {
            getFs().writeFile(infoPath, JSON.stringify({}))
        }
    })

    let cancelled = false
    function cancel() {
        cancelled = true
    }

    async function shouldRun() {
        if (alwaysRun) {
            return true
        }

        const stats = await statsPromise
        if (!stats || cancelled) {
            return false
        }

        if (!stats.mtimeMs) {
            return false // bug
        }
    
        const lastRan = Date.now() - stats.mtimeMs
        if (lastRan < gcIntervalMs) {
            return false
        }

        return true
    }

    async function dispose() {
        if (!(await shouldRun())) {
            return
        }

        try {
            await startGcProcess(getBuildDir())
            getLogger().log('Started background gc')
        } catch (e) {
            getLogger().error(`Failed to start gc`, e)
        }
    }

    return {
        cancel,
        [getAsyncDispose()]: dispose,
    }
}

async function collectGarbage(repo: DataRepository, exclude: Set<string>, pruneAge = getPruneAge()) {
    const fs = getFs()
    const emptyDirs = new Set<string>()
    const toDelete = new Set<string>()

    function shouldDelete(hash: string): Promise<boolean> | boolean {
        if (exclude.has(hash)) {
            return false
        }

        if (pruneAge === undefined) {
            return true
        }

        return repo.statData(hash).then(stats => {
            if (stats.missing || stats.corrupted) {
                return true
            }

            return (Date.now() - stats.mtimeMs) >= pruneAge
        })
    }

    const dataDir = repo.getDataDir()
    for (const f of await fs.readDirectory(dataDir)) {
        if (f.type === 'directory' && f.name.length === 2) {
            let isEmpty = true
            let discovered = 0
            for (const f2 of await fs.readDirectory(path.resolve(dataDir, f.name))) {
                if (f2.type === 'directory' && f2.name.length === 2) {
                    throwIfCancelled()

                    let isEmpty2 = true
                    for (const f3 of await fs.readDirectory(path.resolve(dataDir, f.name, f2.name))) {
                        if (f3.type === 'file' && f3.name.length === 60) {
                            const hash = `${f.name}${f2.name}${f3.name}`
                            if (await shouldDelete(hash)) {
                                discovered += 1
                                toDelete.add(hash)
                            } else if (isEmpty2) {
                                isEmpty2 = false
                            }
                        }
                    }

                    if (isEmpty2) {
                        emptyDirs.add(path.resolve(dataDir, f.name, f2.name))
                    } else {
                        isEmpty = false
                    }
                }
            }

            if (isEmpty) {
                emptyDirs.add(path.resolve(dataDir, f.name))
            }

            if (discovered) {
                getEventLogger().emitGcEvent({ discovered })
            }
        }
    }

    return {
        toDelete,
        emptyDirs,
    }
}

export async function cleanArtifacts(repo = getDataRepository(getFs()), dryRun = false, deleteStubs = true, pruneAge?: number) {
    if (process.stdout.isTTY) {
        createGcView()
    }

    async function isStub(v: BuildFsStats) {
        if (!(v.objects.size === 1 && v.stores.size === 1 && v.indices.size === 1 && v.commits.size === 0)) {
            return false
        }

        // Stubs should have `__full-state__.json` as their only file
        const { index } = await repo.getBuildFs([...v.indices.values()][0])
        const f = index.files['__full-state__.json']

        return !!f
    }

    const fs = getFs()
    const stats = await collectStats(repo, settings.maxCommits)
    const stubs = new Set<string>()

    const exclude = new Set<string>()
    for (const [k, v] of Object.entries(stats)) {
        if (v.objects.size === 0) {
            // TODO: mark head for deletion
            continue
        }

        const { missing = new Set(), corrupted = new Set() } = v
        for (const h of [...missing, ...corrupted]) {
            exclude.add(h)
        }

        throwIfCancelled()

        if (missing.size > 0 || corrupted.size > 0) {
            printLine(`ID: ${k} [missing: ${missing.size}; corrupted: ${corrupted.size}]`)
        } else if (dryRun) {
           // await printStats(k, v)
        }

        for (const h of corrupted) {
            await repo.deleteData(h)
        }

        if (deleteStubs && await isStub(v)) {
            v.objects.clear()
            v.indices.clear()
            v.stores.clear()
            stubs.add(k)
        }
    }

    const merged = mergeRepoStats(stats)

    const allObjects = new Set([
        ...merged.objects,
        ...merged.stores,
        ...merged.indices,
        ...merged.commits,
    ])

    getLogger().log(`Total objects found`, allObjects.size)

    const garbage = await collectGarbage(repo, allObjects, pruneAge)
    if (dryRun) {
        getEventLogger().emitGcSummaryEvent({
            numObjects: garbage.toDelete.size,
            numDirs: garbage.emptyDirs.size,
            dryrun: true,
        })

        return
    }

    if (garbage.toDelete.size > 0) {
        getLogger().log(`Deleting ${garbage.toDelete.size} objects`)
    } else {
        getLogger().log(`Nothing to delete`)
    }

    for (const h of garbage.toDelete) {
        throwIfCancelled()

        await repo.deleteData(h)
        getEventLogger().emitGcEvent({ deleted: 1 })
    }

    // Empty dirs need to be deleted longest-path first
    const dirs = [...garbage.emptyDirs].sort((a, b) => b.length - a.length)
    for (const d of dirs) {
        throwIfCancelled()

        await fs.deleteFile(path.resolve(d, '.stats.json')).catch(throwIfNotFileNotFoundError)
        await fs.deleteFile(d, { recursive: false, force: false })

        for (const s of stubs) {
            await repo.deleteHead(s)
        }
    }

    getEventLogger().emitGcSummaryEvent({
        numObjects: garbage.toDelete.size,
        numDirs: garbage.emptyDirs.size,
    })
}
