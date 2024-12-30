import * as watcher from './watcher'
import { getResolvedTsConfig } from '../../compiler/config'
import { getFs } from '../../execution'
import { throwIfNotFileNotFoundError } from '../../utils'
import { getWatcherStateFilePath, getWorkingDir } from '../../workspaces'

async function getWatcherSettings(): Promise<watcher.Settings> {
    const config = await getResolvedTsConfig()

    return {
        extnames: ['ts', 'tsx'],
        included_patterns: config?.include,
        excluded_patterns: config?.exclude,
        excluded_dirnames: ['node_modules'],
    }
}

export async function maybeDetectChanges() {
    const watcherState = await getFs().readFile(getWatcherStateFilePath()).catch(throwIfNotFileNotFoundError)
    if (!watcherState) {
        return
    }

    const settings = await getWatcherSettings()
    const result = await watcher.detectChanges(watcherState, getWorkingDir(), settings)
    if (!result) {
        return []
    }

    await getFs().writeFile(getWatcherStateFilePath(), new Uint8Array(result.state))

    return result.changes
}

export async function initOrUpdateWatcherState() {
    const settings = await getWatcherSettings()
    const watcherState = await getFs().readFile(getWatcherStateFilePath()).catch(throwIfNotFileNotFoundError)
    if (!watcherState) {
        const state = await watcher.initState(getWorkingDir(), settings)
        if (!state) {
            throw new Error('Fatal error initializing state')
        }

        await getFs().writeFile(getWatcherStateFilePath(), new Uint8Array(state))

        return
    }

    const result = await watcher.detectChanges(watcherState, getWorkingDir(), settings)
    if (result) {
        await getFs().writeFile(getWatcherStateFilePath(), new Uint8Array(result.state))

        return result.changes
    }
}
