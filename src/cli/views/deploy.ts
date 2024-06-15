import * as path from 'node:path'
import { getLogger } from '../..'
import { ParsedPlan, getChangeType, mapResource } from '../../deploy/deployment'
import { DeployEvent, DeploySummaryEvent, FailedDeployEvent } from '../../logging'
import { SymbolNode, SymbolGraph, renderSymbol, MergedGraph, renderSymbolLocation } from '../../refactoring'
import { Color, colorize, createTreeView, format, getDisplay, getSpinnerFrame, printLine, Spinner, spinners, stripAnsi, TreeItem } from '../ui'
import { keyedMemoize } from '../../utils'
import { getWorkingDir } from '../../workspaces'
import { resourceIdSymbol } from '../../deploy/server'

interface ResourceInfo {
    internal?: boolean
    status?: DeployEvent['status']
    action: DeployEvent['action']
    resourceType: ReturnType<SymbolGraph['getResourceType']>

    // Only relevant for `replace`
    destroyed?: boolean
}

interface SymbolState {
    status: DeployEvent['status']
    action: DeployEvent['action']
    resources: Record<string, ResourceInfo>
    startTime?: Date
}


function getBetterName(sym: SymbolNode['value']) {
    const parts = sym.name.split(' = ')
    if (parts.length === 1) {
        return { name: parts[0] }
    }

    const ident = parts[0]
    const rem = parts[1]
    if (rem.startsWith('new ')) {
        return { name: ident, type: rem.slice(4) }
    }

    return { name: ident }
}

export function renderBetterSymbolName(
    sym: SymbolNode['value'], 
    workingDir: string, 
    headerLength: number,
    icon = '*',
    status = ''
) {

    const parts = getBetterName(sym)
    const pSym = {
        ...sym,
        name: `${parts.name}${parts.type ? ` <${parts.type}>` : ''}`,
        fileName: path.relative(workingDir, sym.fileName),
    }

    const loc = renderSymbolLocation(pSym, true)
    const s = `${icon} ${renderSymbol(pSym, false)}${status}`
    const padded = s.padEnd(headerLength - loc.length, ' ')

    return `${padded}${loc}`
}

function getStatusIcon(status: SymbolState['status'], spinner: Spinner, duration: number) {
    switch (status) {
        case 'complete':
            return colorize('green', '\u2713') // ✓
        case 'failed':
            return colorize('red', '\u2717') // ✗

        default:
            return getSpinnerFrame(spinner, duration)
    }
}

function isOnlyUpdatingDefs(state: SymbolState) {
    for (const k of Object.keys(state.resources)) {
         // XXX
        if (!k.endsWith('--definition')) {
            return false
        }
    }

    return true
}

export function printSymbolTable(symbols: Iterable<[sym: SymbolNode, state: SymbolState]>, showLocation = true, maxWidth = 80) {
    const texts = new Map<SymbolNode, string>()
    for (const [k, v] of symbols) {
        if (isOnlyUpdatingDefs(v)) continue

        const text = renderSymbolWithState(k.value, v, undefined, spinners.empty)
        texts.set(k, text)
    }

    if (texts.size === 0) {
        return
    }

    // const headerSize = Math.min(process.stdout.columns, maxWidth)
    const largestWidth = [...texts.values()].map(stripAnsi).sort((a, b) => b.length - a.length)[0]
    const minGap = 2
    const padding = largestWidth.length + minGap

    for (const [k, v] of symbols) {
        if (isOnlyUpdatingDefs(v)) continue

        const relPath = path.relative(getWorkingDir(), k.value.fileName)
        const left = renderSymbolWithState(k.value, v, undefined, spinners.empty)
        const right = renderSymbolLocation({ ...k.value, fileName: relPath }, true)
        const leftWidth = stripAnsi(left).length
        //const padding = headerSize - leftWidth
        printLine(`${left}${' '.repeat(padding - leftWidth)}${colorize('gray', right)}`)
    }
}

export function renderSymbolWithState(
    sym: SymbolNode['value'],
    state: SymbolState,
    workingDir = getWorkingDir(), 
    spinner = spinners.braille
) {
    const actionColor = getColor(state.action)
    const icon = getIcon(state.action)
   // const status = state.status !== 'pending' ? ` (${state.status})` : ''
    const duration = state.startTime ? Date.now() - state.startTime.getTime() : undefined
    const seconds = duration ? Math.floor(duration / 1000) : 0
    const durationText = !seconds ? '' : ` (${seconds}s)`

    const parts = getBetterName(sym)

    const status = getStatusIcon(state.status, spinner, duration ?? 0)
    const symType = parts.type ? ` <${parts.type}>` : ''

    const failed = state.status === 'failed' ? colorize('brightRed', ' [failed]') : ''

    const loc = '' // renderSymbolLocation(pSym, true)
    const padding = '' // ' '.repeat(Math.max(headerLength - lhsSize - loc.length - 1, 0))

    const details = colorize('gray', `${symType}${durationText}${failed}${padding}${loc}`)
    const symWithIcon = colorize(actionColor, `${icon} ${parts.name}`)

    return `${status} ${symWithIcon}${details}`
}

interface DeploySummary {
        
}

export async function createDeployView(graph: MergedGraph, isDestroy?: boolean) {
    const view = getDisplay().getOverlayedView()
    const headerLength = Math.min(process.stdout.columns, 80)
    const opName = isDestroy ? 'destroy' : 'deploy'
    const header = view.createRow(`Planning ${opName}...`)
    const errors: [resource: string, reason: (string | Error)][] = []
    const skipped = new Set<string>()

    function _getRow(id: string) {
        return view.createRow()
    }

    const getRow = keyedMemoize(_getRow)
    const timers = new Map<number, number>()

    // TODO: continously update `duration` until the symbol is complete
    // TODO: for multiple file deployments we should show status per-file rather than per-symbol

    getLogger().onPlan(ev => {
        const symbolStates = extractSymbolInfoFromPlan(graph, ev.plan)
        if (symbolStates.size === 0) {
            if (isDestroy) {
                header.release(colorize('green', 'Nothing to destroy!'))
            } else {
                header.release(colorize('green', 'No changes needed'))
            }

            return
        }

        function updateSymbolState(ev: DeployEvent | FailedDeployEvent) {
            if (!graph.hasSymbol(ev.resource)) {
                return
            }

            const symbol = graph.getSymbol(ev.resource)
            const state = symbolStates.get(symbol)
            if (!state) {
                return
            }
    
            const resource = state.resources[ev.resource]
            // TODO: figure out why this is `undefined` when destroying test resources
            if (!resource) {
                return
            }

            const action = resource.action
            if (action === 'noop') {
                resource.status = 'complete'
            } else if (action === 'replace' && ev.status === 'complete') {
                if (!resource.destroyed) {
                    resource.destroyed = true
                } else {
                    resource.status = 'complete'
                }
            } else {
                state.resources[ev.resource] = { ...resource, ...ev, action }
            }

            if (ev.status === 'applying') {
                state.startTime ??= new Date()
            }

            const statuses = Object.values(state.resources).map(ev => ev.status)
            if (statuses.every(s => s === 'complete')) {
                state.status = 'complete'
            } else if (statuses.some(s => s === 'failed')) {
                state.status = 'failed'
            } else if (statuses.some(s => s !== 'pending')) {
                state.status = 'applying'
            }

            return {
                symbol,
                state,
            }
        }

        // Internal resources are considered "boring" because:
        // 1. No remote calls are made
        // 2. Any state changes only exist locally
        // 3. Failures are not usually the user's fault
        //
        // So we generally do not want to show them
        const boringSymbols = new Set<number>()

        let total = 0
        for (const [k, v] of symbolStates) {
            let hasInteresting = false
            for (const r of Object.values(v.resources)) {
                if (!r.internal) {
                    total += 1
                    hasInteresting= true
                }
            }
            
            if (!hasInteresting) {
                total += 1
                boringSymbols.add(k.value.id)
            }
        }

        let completed = 0
        let failed = 0
        const action = isDestroy ? 'Destroying' : 'Deploying'
        function updateHeader() {
            const failedMsg = failed ? colorize('red', ` ${failed} ${failed > 1 ? 'failures' : 'failure'}`) : ''
            header.update(`${action} (${completed}/${total})${failedMsg}`)
        }

        updateHeader()

        function addRenderInterval(symbol: SymbolNode, state: SymbolState) {
            if (timers.has(symbol.value.id)) {
                return
            }

            const r = getRow(`${symbol.value.id}`)
            const t = +setInterval(() => {
                const s = renderSymbolWithState(
                    symbol.value,
                    state,
                    getWorkingDir(),
                )

                r.update(s)
            }, 250)
            timers.set(symbol.value.id, t)
        }

        function clearRenderInterval(symbol: SymbolNode) {
            clearInterval(timers.get(symbol.value.id))
        }

        function onDeployEvent(ev: DeployEvent | FailedDeployEvent) {
            const res = updateSymbolState({ ...ev, state: mapResource(ev.state) })
            if (!res) {
                return
            }

            const r = getRow(`${res.symbol.value.id}`)
            const state = res.state
            addRenderInterval(res.symbol, res.state)

            const s = renderSymbolWithState(
                res.symbol.value,
                state,
                getWorkingDir(),
            )

            if (state.resources[ev.resource].status === 'complete') {
                if (!state.resources[ev.resource].internal) {
                    completed += 1
                    updateHeader()
                }
            } else if (state.resources[ev.resource].status === 'failed') {
                if (!state.resources[ev.resource].internal) {
                    failed += 1
                    updateHeader()
                }
            }

            if (state.status === 'complete') {
                if (boringSymbols.has(res.symbol.value.id)) {
                    completed += 1
                }

                clearRenderInterval(res.symbol)
                r.release(s, 2500)
                updateHeader()
            } else if (state.status === 'failed') {
                if (boringSymbols.has(res.symbol.value.id)) {
                    failed += 1
                }

                clearRenderInterval(res.symbol)
                r.release(s)
            } else {
                r.update(s)
            }
        }

        getLogger().onDeploy(ev => {
            // if (ev.status === 'failed') {
            //     errors.push([ev.resource, (ev as any).reason])
            // }
            if (ev.action === 'noop') {
                skipped.add(ev.resource)
            }

            try {
                onDeployEvent(ev)
            } catch (e) {
                getLogger().error(e)
            }
        })
    })

    const resourceLogs: Record<string, string[]> = {}
    getLogger().onDeployLog(ev => {
        const arr = resourceLogs[ev.resource] ??= []
        arr.push(require('node:util').format(...ev.args))
    })

    function dispose() {
        header.release()
        for (const [id] of getRow.keys()) {
            getRow(id).release()
        }
        for (const v of timers.values()) {
            clearInterval(v)
        }

        if (errors.length > 0) {
            view.writeLine()
            view.writeLine('Errors:')

            // TODO: convert resource names to symbols
            for (const [r, e] of errors) {
                if (typeof e === 'string') {
                    view.writeLine(`[${r}]: ${e}`)
                } else {
                    printLine(`[${r}]: ${format(e)}`)
                }
            }
        }

        if (skipped.size > 0) {
            getLogger().log(`Skipped:`, skipped)
        }

        const l = Object.entries(resourceLogs)
        if (l.length > 0) {
            view.writeLine()
            view.writeLine('Resource logs:')
            // TODO: convert resource names to symbols
            for (const [k, v] of l) {
                for (const z of v) {
                    view.writeLine(`[${k}]: ${z}`)
                }
            }
        }
    }

    function formatError(err: any) {
        const r = err[resourceIdSymbol]

        if (r && graph.hasSymbol(r)) {
            delete err[resourceIdSymbol]

            const callsites = graph.getCallsites(r)
            if (!callsites) {
                return format(err)
            }

            // These callsites are already source-mapped, filenames are relative though
            const s = callsites.map(c => `    at ${c.name} (${c.fileName}:${c.line + 1}:${c.column + 1})`).join('\n')
            err.stack += '\n' + s
        }

        return format(err)
    }

    return { dispose, formatError }
}

function summarizePlan(graph: MergedGraph, plan: ParsedPlan): DeployEvent['action'] | 'no-op' {
    let action: DeployEvent['action'] | 'no-op' = 'no-op'
    for (const [k, v] of Object.entries(plan)) {
        // if (graph.isInternalResource(k) || k.startsWith('data.')) {
        //     continue
        // }

        if (k.startsWith('data.')) {
            continue
        }

        const change = getChangeType(v.change)

        switch (action) {
            case 'no-op':
                action = change
                break
            case 'read':
                continue

            default:
                if (change !== action) {
                    return 'update'
                }
                break
        }
    }
    
    return action
}

export function groupSymbolInfoByFile(info: Map<SymbolNode, SymbolState>): Record<string, [SymbolNode, SymbolState][]> {
    const groups: Record<string, [SymbolNode, SymbolState][]> = {}
    for (const [k, v] of info) {
        const g = groups[k.value.fileName] ??= []
        g.push([k, v])
    }

    return groups
}

export function extractSymbolInfoFromPlan(graph: MergedGraph, plan: ParsedPlan) {
    const symbolStates = new Map<SymbolNode, SymbolState>()
    const plans = new Map<SymbolNode, ParsedPlan>()
    for (const [k, v] of Object.entries(plan)) {
        if (!graph.hasSymbol(k)) {
            continue
        }

        const symbol = graph.getSymbol(k) 
        if (!plans.has(symbol)) {
            plans.set(symbol, {})
        }

        const plan = plans.get(symbol)!
        plan[k] = v
    }

    for (const [k, v] of plans) {
        const summary = summarizePlan(graph, v)
        if (summary === 'no-op') {
            continue
        }

        const resources: SymbolState['resources'] = {}
        for (const [rId, planned] of Object.entries(v)) {
            const action = getChangeType(planned.change)
            if (action === 'no-op') {
                continue
            }

            resources[rId] = { 
                action,
                status: 'pending', 
                internal: graph.isInternalResource(rId),
                resourceType: graph.getResourceType(rId)!,
            }
        }

        symbolStates.set(k, {
            action: summary,
            status: 'pending',
            resources,
        })
    }

    const sorted = [...symbolStates.entries()].sort((a, b) => a[0].value.line - b[0].value.line)

    return new Map(sorted)
}

function getIcon(action: DeployEvent['action']) {
    switch (action) {
        case 'create':
            return '+'
        case 'delete':
            return '-'
        case 'update':
            return '~'
        case 'replace':
            return '±'
        case 'read':
            return '^'
    }
}

function getColor(action: DeployEvent['action']): Color {
    switch (action) {
        case 'create':
            return 'green'
        case 'delete':
            return 'red'
        case 'replace':
            return 'yellow'
        case 'update':
            // return 'none'
            return 'blue'
        case 'noop':
        case 'read':
            return 'none'
    }
}

export function renderSummary(ev: DeploySummaryEvent) {
    if (ev.add === 0 && ev.change === 0 && ev.remove === 0) {
        const noChangesMessage = colorize('green', 'No changes needed')

        return noChangesMessage
    }

    if (ev.errors && ev.errors.length > 0) {
        const deployFailed = colorize('red', 'Deploy failed!')

        return deployFailed // TODO: enumerate errors
    }

    const deploySucceeded = colorize('green', 'Deploy succeeded!')
    const lines = [
        deploySucceeded,
        '',
        'Resource summary:',
    ]

    if (ev.add > 0) {
        lines.push(`  - ${ev.add} created`)
    }
    if (ev.change > 0) {
        lines.push(`  - ${ev.change} changed`)
    }
    if (ev.remove > 0) {
        lines.push(`  - ${ev.remove} destroyed`)
    }

    // One empty line for padding
    lines.push('')

    return lines.join('\n')
}
