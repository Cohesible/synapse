import * as nodeUtil from 'node:util'
import { bold, colorize, dim, getDisplay, renderDuration } from '../ui'
import { CompilerOptions } from '../../compiler/host'
import { ResolvedProgramConfig } from '../../compiler/config'
import { getLogger } from '../../logging'
import { getPreviousDeploymentProgramHash, getTemplateWithHashes, readState } from '../../artifacts'
import { TfJson } from '../../runtime/modules/terraform'
import { getBuildTarget } from '../../execution'
import { getWorkingDir } from '../../workspaces'
import { SymbolNode, createMergedGraph, createSymbolGraphFromTemplate, evaluateMoveCommands } from '../../refactoring'
import { TfState } from '../../deploy/state'
import { renderCmdSuggestion } from '../commands'


// Useful events
// * Program/process/project resolution (if not obvious)
// * Config resolution (esp. `deployTarget`)
// * Completion per-file
// * Start/end of synthesis
// * User logs during synthesis

// Potential (future) sources of config, roughly ordered highest precedence first:
// * command line
// * environment variables 
// * `package.json` / `tsconfig.json`
// * `~/.synapse/config.json` (per-user; global)
// * Per-project config (might be a file or possibly remote)
// * Organization (?)
// * Hard-coded defaults
//
// A good way to determine what precedence to give a config source is to think about 
// how specific it is to a given command invocation. Command line args are for only _that_
// invocation and so it has the highest weight. But hard-coded defaults can apply to literally 
// every single command invocation by every single user, so it should have the lowest. The broader
// the scope, the lower the precedence.
// 
// Project/organization config could potentially have the highest precedence if the setting is "locked"
//
// Other tenets:
// * Don't give devs the chance to say "but it works on my machine"

interface ConfigDelta<T = any> {
    input: T | undefined
    resolved: T | undefined // TODO: show where we got this value
    clobbered?: boolean // Clobbered input with higher precedence === bug

    // TODO: show other clobbers/deltas somehow (there may be more multiple sources of config)
    // I think the easiest way would be to gather all config sources into an array and sort by 
    // precedence. This array could then be used to create per-input deltas on-demand.

}

// This is intentionally hand-written to include only the most relevant things
interface ConfigDiff {
    environmentName?: ConfigDelta<string>
    deployTarget?: ConfigDelta<string>
}

function getDelta<T>(input: T | undefined, resolved: T | undefined): ConfigDelta<T> | undefined {
    if (input === resolved) {
        return
    }

    return { 
        input, 
        resolved, 
        clobbered: input !== undefined && input !== resolved,
    }
}

// When should we show a resolved input?
// * Potentially mon-obvious input sources e.g. environment variables, hard-coded defaults, etc.
// * Derived and/or inferred values
// * When one implicit input overrides another (Synapse config vs. `tsconfig.json`)

function diffConfig(
    config: ResolvedProgramConfig,
    inputOptions: CompilerOptions = {}
): ConfigDiff {
    const diff: ConfigDiff = {}
    diff.deployTarget = getDelta(inputOptions.deployTarget, config.csc.deployTarget)
    diff.environmentName = getDelta(inputOptions.environmentName, config.csc.environmentName)

    for (const [k, v] of Object.entries(diff)) {
        if (v === undefined) {
            delete diff[k as keyof ConfigDiff]
        }
    }

    return diff
}

function mapOptionName(name: string) {
    switch (name) {
        case 'deployTarget':
            return 'target'
        case 'environmentName':
            return 'env'
    }

    return name
}

interface CompileSummaryOpt {
    showResourceSummary?: boolean
    showSuggestions?: boolean
}

// `inputOptions` is used for diffing the resolved config
export function createCompileView(inputOptions?: CompilerOptions & { hideLogs?: boolean }) {
    const view = getDisplay().getOverlayedView()
    const header = view.createRow('Compiling...')
    let headerText = 'Compiling...'
    let resolvedConfigText: string | undefined
    let duration: number

    function updateHeader() {
        const h = `${headerText}${renderDuration(duration)}`
        const newText = resolvedConfigText ? `${h} ${resolvedConfigText}` : h
        header.update(newText)
    }

    function setHeaderText(text: string) {
        headerText = text
        updateHeader()
    }

    function setConfigText(text: string) {
        resolvedConfigText = text
        updateHeader()
    }

    const startTime = Date.now()

    // The config may undergo multiple resolutions
    // But individual values must never change after being set
    // Anything that uses a particular key must use the resolved form
    getLogger().onResolveConfig(ev => {
        const diff = diffConfig(ev.config, inputOptions)
        const entries = Object.entries(diff) as [string, ConfigDelta][]
        if (entries.length === 0) {
            return
        }

        function renderEntry(k: string, v: ConfigDelta) {
            return dim(`${mapOptionName(k)}: ${bold(colorize(v.clobbered ? 'red' : 'blue', v.resolved ?? v.input))}`)
        }

        const resolved = entries.filter(([k, v]) => v.resolved !== undefined)
        const rendered = resolved.map(([k, v]) => renderEntry(k, v)).join(dim(', '))
        const text = `${dim('(')}${rendered}${dim(')')}`
        setConfigText(text)
    })

    function done() {
        duration = Date.now() - startTime
        // Maybe show # of files compiled
        setHeaderText(colorize('green', 'Done!'))
        header.release()
    }

    getLogger().onCompile(ev => {
        done()
    })

    let isFirstSynthLog = true
    getLogger().onSynthLog(ev => {
        if (inputOptions?.hideLogs) {
            getLogger().log(`<synth>`, ...ev.args)
            return
        }

        if (ev.source === 'symEval' && !inputOptions?.logSymEval) {
            return
        }

        if (isFirstSynthLog) {
            isFirstSynthLog = false
            view.writeLine()
            view.writeLine(`Synthesis logs:`)
        }

        const formatted = `${dim(`[${ev.level}]`)} ${nodeUtil.format(...ev.args)}` // TODO: show source file + line # + col #
        const lines = formatted.split('\n')
        for (const l of lines) {
            view.writeLine(`  ${l}`)
        }
    })

    return { showSimplePlanSummary, done }
}

type PreviousData = Awaited<ReturnType<typeof getPreviousDeploymentData>>

export async function getPreviousDeploymentData() {
    const procId = getBuildTarget()?.deploymentId
    if (!procId) {
        return
    }

    const programHash = await getPreviousDeploymentProgramHash()
    const [state, oldTemplate] = await Promise.all([
        readState(),
        programHash ? getTemplateWithHashes(programHash) : undefined,
    ])

    return {
        state,
        programHash,
        oldTemplate,
    }
}

// async function getStatelessTerraformSession(template: TfJson) {
//     return startStatelessTerraformSession(template, await getTerraformPath())
// }

// // This diff is "fast" because we make no remote calls
// //
// // We're only diffing the inputs. We cannot know the change in program
// // state (output) without actually executing the program.
// async function getFastDiff(current: TemplateWithHashes, previous: PreviousData) {
//     const session = await getStatelessTerraformSession(current.template)

// }


// TODO: we could diff the new template with the last deployed template, if available
function showSimplePlanSummary(template: TfJson, target: string, entrypoints: string[], previousData?: PreviousData) {
    const printLine = getDisplay().getOverlayedView().writeLine

    const graph = createSymbolGraphFromTemplate(template)
    const oldGraph = previousData?.oldTemplate ? createSymbolGraphFromTemplate(previousData?.oldTemplate.template) : undefined
    const mergedGraph = oldGraph ? createMergedGraph(graph, oldGraph) : undefined

    const sorted = graph.getSymbols().sort((a, b) => {
        if (a.value.fileName !== b.value.fileName) {
            return 0
        }

        if (a.value.line === b.value.line) {
            return a.value.column - b.value.column
        }

        return a.value.line - b.value.line
    })

    function getResourceCounts(sym: SymbolNode['value']) {
        const byType: Record<string, number> = {}
        for (const r of sym.resources) {
            if (r.subtype === 'Closure' && r.name.endsWith('--definition')) continue
            if (r.subtype === 'Closure' && (sym.name === 'describe' || sym.name === 'suite')) continue

            const ty = graph.getResourceType(`${r.type}.${r.name}`)
            if (ty.kind === 'custom') {
                byType[ty.name] = (byType[ty.name] ?? 0) + 1
            } else if (r.subtype === 'Closure') {
                byType['<Closure>'] = (byType['<Closure>'] ?? 0) + 1
            } else if (!r.subtype) {
                byType[r.type] = (byType[r.type] ?? 0) + 1
            }
        }

        return Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))
    }

    const counts = new Map<SymbolNode, ReturnType<typeof getResourceCounts>>()
    for (const s of sorted) {
        const c = getResourceCounts(s.value)
        if (c.length > 0) {
            counts.set(s, c)
        }
    }

    let hasTests = false
    for (const s of sorted) {
        for (const r of s.value.resources) {
            const testInfo = graph.getTestInfo(`${r.type}.${r.name}`)
            if (testInfo?.testSuiteId !== undefined) {
                hasTests = true
            }
        }
    }

    if (counts.size === 0) {
        return printLine('No resources found.')
    }

    printLine()

    // entrypoint && !entrypoint.startsWith('--') ? `${cliName} test ${entrypoint}` : 
    const isUpdate = !!previousData?.state && previousData.state.resources.length > 0
    const deployCmd = renderCmdSuggestion('deploy')
    const verb = isUpdate ? 'update' : 'start'
    if (hasTests) {
        const testCmd = renderCmdSuggestion('test') 
        printLine(`Commands you can use next:`)
        printLine(`  ${deployCmd} to ${verb} your application`)
        printLine(`  ${testCmd} to ${verb} and test your application`)
    } else {
        printLine(`Run ${deployCmd} to ${verb} your application`)
    }

    printLine()    

    const previousTarget = previousData?.oldTemplate?.template['//']?.deployTarget
    if (previousTarget && previousTarget !== target) {
        printLine(colorize('yellow', `Previous deployment used a different target: ${previousTarget}`))
    }

    if (previousData?.state) {
        const moves = evaluateMoveCommands(template, previousData?.state)
        if (moves && moves.length > 0) {
            getLogger().debug('Evaluated moves', moves)
            printLine(colorize('yellow', 'Detected possible refactors.'))
            printLine(`Run ${renderCmdSuggestion('migrate')} to proceed.`)
        }
    }
}

interface ShowWhatICanDoNextProps {
    entrypoint?: string
    deployTarget?: string
    graph?: ReturnType<typeof createSymbolGraphFromTemplate>
    state?: TfState
}

// AKA "clippyMode"
function showWhatICanDoNext(command: 'compile' | 'deploy', props?: ShowWhatICanDoNextProps) {
    // After compile:
    // * `deploy`
    // * `test` (only if there are test resources)
    // * `plan` (only if there is an existing process)
    // * `run` (only if we found a `main` function _and_ it doesn't need deployment)

    // After deploy:
    // * `destroy`
    // * `show`
    // * `test` (only if there are test resources)
    // * `repl` (need to make it obvious that you can use any file in your program as an entrypoint)

    const thingsToDo: string[] = []

    switch (command) {
        case 'compile': {

        }
    }

    // If the # of next steps if 1, show it on one line (?)
    // Also add something to say how to disable these suggestions
}