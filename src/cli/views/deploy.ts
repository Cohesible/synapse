import * as path from 'node:path'
import { DeployLogEvent, getLogger } from '../../logging'
import { ParsedPlan, getChangeType, mapResource } from '../../deploy/deployment'
import { DeployEvent, DeploySummaryEvent, FailedDeployEvent } from '../../logging'
import { SymbolNode, SymbolGraph, renderSymbol, MergedGraph, renderSymbolLocation } from '../../refactoring'
import { Color, colorize, format, getDisplay, getSpinnerFrame, printLine, Spinner, spinners, stripAnsi, print, ControlKey, getDisplayWidth } from '../ui'
import { keyedMemoize, sortRecord } from '../../utils'
import { getWorkingDir } from '../../workspaces'
import { resourceIdSymbol } from '../../deploy/server'
import { CancelError } from '../../execution'
import { TfState } from '../../deploy/state'
import type { Symbol } from '../../runtime/modules/terraform'

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


function getBetterName(sym: Symbol) {
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
    for (const v of Object.values(state.resources)) {
        if (v.resourceType.closureKindHint !== 'definition') {
            return false
        }
    }

    return true
}

export function printSymbolTable(symbols: Iterable<[sym: SymbolNode, state: SymbolState]>) {
    const texts = new Map<SymbolNode, string>()
    for (const [k, v] of symbols) {
        if (isOnlyUpdatingDefs(v)) continue

        const text = renderSymbolWithState(k.value, v, spinners.empty)
        texts.set(k, text)
    }

    if (texts.size === 0) {
        return
    }

    const largestWidth = [...texts.values()].map(stripAnsi).sort((a, b) => b.length - a.length)[0]
    const minGap = 2
    const padding = largestWidth.length + minGap

    for (const [k, v] of symbols) {
        if (isOnlyUpdatingDefs(v)) continue

        const relPath = path.relative(getWorkingDir(), k.value.fileName)
        const left = renderSymbolWithState(k.value, v, spinners.empty)
        const right = renderSymbolLocation({ ...k.value, fileName: relPath }, true)
        const leftWidth = stripAnsi(left).length
        //const padding = headerSize - leftWidth
        printLine(`${left}${' '.repeat(padding - leftWidth)}${colorize('gray', right)}`)
    }
}

export function renderSym(sym: Symbol, showType = true, showLocation = true) {
    const parts = getBetterName(sym)
    const words = [parts.name]

    if (parts.type && showType) {
        words.push(colorize('gray', `<${parts.type}>`))
    }

    if (showLocation) {
        words.push(colorize('gray', renderSymbolLocation(sym, true)))
    }

    return words.join(' ')
}

// TODO: the file location for the `from` symbol may appear to be
// incorrect because we can't easily link to the actual source code
//
// The location is correct, but if the user clicks it in an IDE they'll
// be taken to the file in its current state.
export function renderMove(
    from: Symbol,
    to: Symbol,
    workingDir = getWorkingDir(), 
) {

    const fromParts = getBetterName(from)
    const toParts = getBetterName(to)
    const isSameFile = from.fileName === to.fileName
    const isSameType = fromParts.type === toParts.type
    const fromRendered = renderSym({ ...from, fileName: path.relative(workingDir, from.fileName) }, !isSameType, !isSameFile)
    const toRendered = renderSym({ ...to, fileName: path.relative(workingDir, to.fileName) })

    return `${fromRendered} --> ${toRendered}`
}

function renderSymbolWithState(
    sym: SymbolNode['value'],
    state: SymbolState,
    spinner = spinners.braille
) {
    const actionColor = getColor(state.action)
    const icon = getIcon(state.action)
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

export async function createDeployView(graph: MergedGraph, mode: 'deploy' | 'destroy' | 'import' = 'deploy') {
    const view = getDisplay().getOverlayedView()
    const isDestroy = mode === 'destroy'
    const header = view.createRow(mode === 'import' ? 'Importing...' : `Planning ${mode}...`)
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
                const s = renderSymbolWithState(symbol.value, state)

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

            const s = renderSymbolWithState(res.symbol.value, state)

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

    const resourceLogs: DeployLogEvent[] = []
    getLogger().onDeployLog(ev => {
        resourceLogs.push(ev)
    })

    function dispose(headerText?: string) {
        header.release(headerText)
        for (const [id] of getRow.keys()) {
            getRow(id).release()
        }
        for (const v of timers.values()) {
            clearInterval(v)
        }

        function getDisplayName(resourceKey: string) {
            const sym = graph.hasSymbol(resourceKey) ? graph.getSymbol(resourceKey) : undefined
            
            return sym ? renderSym(sym.value, true, true) : resourceKey
        }

        if (errors.length > 0) {
            view.writeLine()
            view.writeLine('Errors:')

            for (const [r, e] of errors) {
                const name = getDisplayName(r)
                if (typeof e === 'string') {
                    view.writeLine(`[${name}]: ${e}`)
                } else {
                    printLine(`[${name}]: ${format(e)}`)
                }
            }
        }

        if (skipped.size > 0) {
            getLogger().log(`Skipped:`, skipped)
        }

        // FIXME: we should organize into 3 columns (<name> <type> <location>) and pad between each
        // Padding exclusively on the left works but it's not great. The output will look terrible
        // with a large variety of filenames and/or resource types.
        if (resourceLogs.length > 0) {
            view.writeLine()
            view.writeLine('Resource logs:')

            // Ensures finding the padding width is fast
            const resourceDisplayNames = new Map<string, { text: string; width: number }>()
            for (const ev of resourceLogs) {
                if (resourceDisplayNames.has(ev.resource)) continue

                const text = getDisplayName(ev.resource)
                resourceDisplayNames.set(ev.resource, { text, width: getDisplayWidth(text) })
            }

            let paddingWidth = 0
            for (const v of resourceDisplayNames.values()) {
                paddingWidth = Math.max(v.width, paddingWidth)
            }

            for (const ev of resourceLogs) {
                const name = resourceDisplayNames.get(ev.resource)!
                const padding = paddingWidth - resourceDisplayNames.get(ev.resource)!.width
                const paddedName = ' '.repeat(padding) + name.text
                view.writeLine(`[ ${paddedName} ]: ${format(...ev.args)}`)
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

function summarizePlan(plan: ParsedPlan): DeployEvent['action'] | 'no-op' {
    let action: DeployEvent['action'] | 'no-op' = 'no-op'
    for (const [k, v] of Object.entries(plan)) {
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

type ByFile = Record<string, [SymbolNode, SymbolState][]>

export function groupSymbolInfoByPkg(info: Map<SymbolNode, SymbolState>): Record<string, ByFile> {
    const byPkg: Record<string, ByFile> = {}
    for (const [k, v] of info) {
        const pkg = k.value.packageRef ?? k.value.specifier ?? '' // `''` is the root
        const files = byPkg[pkg] ??= {}
        const g = files[k.value.fileName] ??= []
        g.push([k, v])
    }

    // Sort with the root first

    return sortRecord(byPkg)
}

export function getPlannedChanges(plan: ParsedPlan) {
    const resources: Record<string, { change: ReturnType<typeof getChangeType>, plan: ParsedPlan[string] }> = {}
    for (const [k, v] of Object.entries(plan)) {
        if (k.startsWith('data.')) continue
    
        const change = getChangeType(v.change)
        if (change === 'no-op') continue

        resources[k] = {
            change,
            plan: v,
        }
    }
    return resources
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
        const summary = summarizePlan(v)
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

export async function promptForInput(prompt: string) {
    const display = getDisplay()
    const tty = display.writer.tty
    if (!tty) {
        throw new Error('Cannot prompt for confirmation without a tty')
    }

    print(prompt)

    await new Promise<void>(r => setTimeout(r, 100))
    await display.writer.flush()

    // Used for internal test fixtures
    const inputFromTests = process.env['__SYNAPSE_TEST_INPUT']
    if (inputFromTests !== undefined) {
        printLine(inputFromTests)
        await display.getOverlayedView().resetScreenTop()

        return inputFromTests
    }

    display.writer.showCursor()

    return new Promise<string>((resolve, reject) => {
        let buf = ''
        const l = tty.onKeyPress(ev => {
            switch (ev.key) {
                case ControlKey.DEL:
                case ControlKey.Backspace:
                    if (buf.length !== 0) {
                        buf = buf.slice(0, -1)
                        display.writer.moveCursor(-1, 0)
                        display.writer.clearLine(1)
                    }
                    break

                case ControlKey.ESC:
                    print(buf)
                    buf = ''
                    // Fallsthrough

                case ControlKey.Enter:
                    resolve(buf)
                    l.dispose()
                    print(buf)
                    display.writer.hideCursor()
                    break

                default:
                    if (typeof ev.key === 'string') {
                        buf += ev.key
                        display.writer.write(ev.key)
                    }

                    break
            }
        })
    }).finally(() => display.getOverlayedView().resetScreenTop())
}

export async function promptDestroyConfirmation(reason: string, state: TfState) {
    const warning = `${reason} Are you sure you want to destroy this deployment?`
    printLine(colorize('brightYellow', warning))

    const resp = await promptForInput(`(y/N): `)
    // TODO: show what will be deleted

    const trimmed = resp.trim().toLowerCase()
    if (!trimmed || trimmed.startsWith('n') || (trimmed !== 'y' && trimmed !== 'yes')) {
        throw new CancelError('Cancelled destroy')
    }
}
