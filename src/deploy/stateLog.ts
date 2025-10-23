import { TfResource, TfState } from './state'
import { BuildTarget, getDeploymentBuildDirectory } from '../workspaces'
import { glob } from '../utils/glob'
import { getFs } from '../execution'
import { getLogger } from '../logging'
import { DeploymentStore, getDeploymentFs } from '../artifacts'
import { createPointer } from '../build-fs/pointers'

interface WriteAheadEntry {
    readonly k: 0
    readonly d: {
        readonly r: string
        readonly a: 'c' | 'u' | 'd' | '?'
    }
}

interface CommitEntry {
    readonly k: 1
    readonly d: TfResource
    readonly a?: { h: string; sh: string }
}

interface CommitDestroyEntry {
    readonly k: 2
    readonly d: string // resource addr
}

interface StartEntry {
    readonly k: 199
    readonly d: {
        readonly l: string
        readonly s: number
    }
}

interface EndEntry {
    readonly k: 200
}

type LogEntry = 
    | StartEntry
    | WriteAheadEntry
    | CommitEntry
    | CommitDestroyEntry
    | EndEntry

function tryParseLogLine(l: string) {
    try {
        const entry = JSON.parse(l) as LogEntry
        // let it error if it's not an object
        if (typeof entry.k !== 'number') {
            throw new Error(`kind is not a number`)
        }
        return { entry }
    } catch (err) {
        return { err }
    }
}

export function parseStateLog(txt: string) {
    let didEnd = false

    const actions = new Map<string, string>()
    const partialState: Record<string, TfResource | null> = {}
    const bfsState: Record<string, { h: string; sh: string } | null> = {}

    const lines = txt.split('\n')
    loop: for (const l of lines) {
        if (!l) continue

        const parsed = tryParseLogLine(l)
        if (parsed.err) {
            console.log('parse error', l, parsed.err)
            continue
        }

        const entry = parsed.entry!

        switch (entry.k) {
            case 0: {
                actions.set(entry.d.r, entry.d.a) // todo: check dupe
                break
            }
            // todo: validate that the log matches
            case 1: {
                const addr = entry.d.type + '.' + entry.d.name
                actions.delete(addr)
                partialState[addr] = entry.d
                if (entry.a) {
                    bfsState[entry.d.name] = entry.a
                }
                break
            }
            case 2: {
                actions.delete(entry.d)
                partialState[entry.d] = null
                if (entry.d.startsWith('synapse_resource.')) {
                    bfsState[entry.d.slice('synapse_resource.'.length)] = null
                }
                break
            }
            case 200: {
                // todo: check that there's not extra entries (that's probably a bug)
                didEnd = true
                break loop
            }
        }

    }

    return {
        didEnd,
        actions,
        partialState,
        bfsState,
    }
}

export function tryRepairState(state: TfState, store: DeploymentStore, stateLog: string) {
    const parsed = parseStateLog(stateLog)

    const resources = new Map<string, TfResource>()
    for (const r of state.resources) {
        const key = `${r.type}.${r.name}`
        if (parsed.partialState[key] === null) {
            continue // deleted
        }

        resources.set(key, r)
    }

    store.repairState(parsed.bfsState)

    for (const [k, v] of Object.entries(parsed.partialState)) {
        if (v) {
            resources.set(k, v)
        } else {
            resources.delete(k)
        }
    }

    const fixed = [...resources.values()]
    fixed.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type < b.type ? -1 : 1
        }
        return a.name < b.name ? -1 : 1
    })

    return {
        ...state,
        resources: fixed,
    }
}

export function didLogEnd(txt: string) {
    const lastLine = txt.lastIndexOf('\n')
    const lastLine2 = txt.lastIndexOf('\n', lastLine-1)
    if (lastLine2 === -1) {
        return true
    }

    const line = txt.slice(lastLine2+1, lastLine)
    const parsed = tryParseLogLine(line)
    if (parsed.err) {
        getLogger().warn('state log parse error', parsed.err)
        return false
    }

    return parsed.entry?.k === 200
}

export function tryParseLogStart(txt: string) {
    const firstLine = txt.indexOf('\n')
    if (firstLine === -1) {
        return
    }

    const line = txt.slice(0, firstLine)
    const parsed = tryParseLogLine(line)
    if (parsed.err) {
        getLogger().warn('state log parse error', parsed.err)
        return
    }

    if (parsed.entry?.k !== 199) {
        return
    }

    return {
        lineage: parsed.entry.d.l,
        serial: parsed.entry.d.s,
    }
}

export async function gatherStateLogs(bt: BuildTarget) {
    const dir = getDeploymentBuildDirectory(bt)
    glob(getFs(), dir, ['*.log'])
}
