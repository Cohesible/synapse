import * as synapse from '..'
import * as path from 'node:path'
import * as os from 'node:os'
import { getObjectByPrefix } from '../build-fs/utils'
import { eagerlyStartDaemon, emitCommandEvent } from '../services/analytics'
import { getCiType, levenshteinDistance, memoize, Mutable, toSnakeCase } from '../utils'
import { getWorkingDir, resolveProgramBuildTarget } from '../workspaces'
import { readKey, setKey } from './config'
import { RenderableError, bold, colorize, dim, getDisplayWidth, printJson, printLine, stripAnsi } from './ui'
import { runWithContext, getBuildTargetOrThrow, getCurrentVersion } from '../execution'
import { handleCompletion } from './completions/completion'
import { runInternalTestFile } from '../testing/internal'
import { getAuth } from '../auth'
import { tryUpgrade } from './updater'
import { getLogger, runTask } from '../logging'
import { passthroughZig, downloadNodeLib } from '../zig/compile'
import { internalBundle, convertBundleToSea } from './buildInternal'
import { installVsCodeZigExtension } from '../zig/installer'


interface TypeMap {
    'string': string
    'number': number
    'boolean': boolean
}

export const enumTypeSym = Symbol('enumType')
export const fileTypeSym = Symbol('fileType')
export const unionTypeSym = Symbol('unionType')

interface EnumType<T = unknown> {
    readonly [enumTypeSym]: Set<T>
}

interface FileType {
    readonly [fileTypeSym]: Set<string> // Valid suffixes
}

interface UnionType<T = any> {
    readonly [unionTypeSym]: ArgType<T>[]
}

// No patterns = match all files
function createFileType(...values: string[]): FileType {
    return { [fileTypeSym]: new Set(values) }
}

const typescriptFileType = createFileType('.ts', '.tsx')


function createEnumType<const T extends [string, ...string[]]>(...values: T): EnumType<T[number]> {
    return { [enumTypeSym]: new Set(values) }
}

function createUnionType<const T extends [ArgType, ...ArgType[]]>(...types: T): UnionType<FromArgType<T[number]>> {
    return { [unionTypeSym]: types }
}

type FromArgType<T> = T extends keyof TypeMap ? TypeMap[T] 
    : T extends (v: string) => Promise<infer U> | infer U ? U
    : T extends UnionType<infer U> ? U
    : T extends EnumType<infer U> ? U 
    : T extends FileType ? string : never

type ArgType<T = any> = keyof TypeMap | ((v: string) => Promise<T> | T) | EnumType<T> | FileType | UnionType

interface ArgumentOptions<T extends ArgType = ArgType> {
    readonly description?: string
    readonly allowMultiple?: boolean
    readonly defaultValue?: FromArgType<T> | (() => FromArgType<T>)
    readonly aliases?: string[]
    readonly hidden?: boolean
}

interface PositionalArgument<T extends ArgType = ArgType> extends ArgumentOptions<T> {
    readonly name: string
    readonly type: T
    readonly optional?: boolean
    readonly minCount?: number
}

interface OptionalArgument<T extends ArgType = ArgType> extends PositionalArgument<T> {
    readonly optional: true
}

interface VarArgsArgument<T extends ArgType = ArgType> extends PositionalArgument<T> {
    readonly allowMultiple: true
    readonly minCount?: number
}

interface SwitchArgument<T extends ArgType = ArgType, K extends string = string> extends ArgumentOptions<T> {
    readonly name: K
    readonly type: T
    readonly passthrough?: boolean
    readonly shortName?: string
    readonly environmentVariable?: string
}

interface VarArgsOption<T extends ArgType = ArgType, K extends string = string> extends SwitchArgument<T, K> {
    readonly allowMultiple: true
}

interface PassthroughSwitch extends VarArgsOption<'string', 'targetArgs'> {
    readonly passthrough: true
}

// Special switch to allow `-- [arg1] [arg2] [arg3] ...`
const passthroughSwitch: PassthroughSwitch = {
    name: 'targetArgs',
    type: 'string',
    allowMultiple: true, 
    passthrough: true,
}

// TODO: allows for <cmd>-<arg> e.g. `run-main.ts`
const dynamicArg: SwitchArgument = {
    name: 'dynamicArg',
    type: 'string',
    hidden: true,
}

const helpFlag: SwitchArgument = {
    name: 'help',
    type: 'boolean',
    hidden: true,
}

export interface RegisteredCommand<T extends any[] = any[]> {
    readonly name: string
    readonly fn: (...args: T) => Promise<void> | void
    readonly descriptor: CommandDescriptor
}

type ExpandArgs<T> = T extends [VarArgsArgument<infer U>] 
    ? [...FromArgType<U>[]] 
    : T extends [OptionalArgument<infer U>, ...infer R] ? [FromArgType<U> | undefined, ...ExpandArgs<R>]
    : T extends [PositionalArgument<infer U>, ...infer R] ? [FromArgType<U>, ...ExpandArgs<R>] : []

type ExpandOptions<T> = T extends [VarArgsOption<infer U, infer K>, ...infer R] 
    ? { [P in K]+?: FromArgType<U>[] } & ExpandOptions<R>
    : T extends [SwitchArgument<infer U, infer K>, ...infer R] 
        ? { [P in K]+?: FromArgType<U> } & ExpandOptions<R> : {}

interface CommandRequirements {
    readonly program?: boolean
    readonly process?: boolean
    readonly project?: boolean
}

export interface CommandDescriptor<
    T extends PositionalArgument[] = PositionalArgument[], 
    U extends SwitchArgument[] = SwitchArgument[]
> {
    // `internal` = exclude from public build
    // `hidden` = include in public build but hide in UI
    readonly hidden?: boolean 
    readonly internal?: boolean
    readonly category?: string | string[]
    readonly examples?: string[]
    readonly aliases?: string[]

    // Maybe add `examplesWithCode`
    // Which would be a short snippet of self-contained code + a command
    //
    // Example:
    // export function main(...args: string[]) {
    //     console.log(`Hello, ${args[0]}!`)
    // }
    //
    // synapse run -- world
    // > Hello, world!
    // 
    //
    // Would only show with --help

    readonly description?: string
    readonly helpDescription?: string // Longer description
    readonly requirements?: CommandRequirements
    readonly inferBuildTarget?: boolean

    readonly args?: T
    readonly options?: U

    readonly isImportantCommand?: boolean

    readonly hasPassthrough?: boolean
}

const registeredCommands = new Map<string, RegisteredCommand>()
const aliasedCommands = new Map<string, string>()

export function registerCommand(name: string, fn: (...args: any[]) => Promise<void> | void, descriptor: CommandDescriptor = {}) {
    if (registeredCommands.has(name) || aliasedCommands.has(name)) {
        throw new Error(`Command "${name}" has already been registered.`)
    }

    if (descriptor.aliases) {
        for (const n of descriptor.aliases) {
            if (registeredCommands.has(n) || aliasedCommands.has(n)) {
                throw new Error(`Command "${n}" has already been registered.`)
            }
            aliasedCommands.set(n, name)
        }
    }

    // Inject common options
    const options = (descriptor as Mutable<typeof descriptor>).options ??= []
    options.push(helpFlag)

    if (!descriptor.hasPassthrough && options?.find(x => x.passthrough)) {
        ;(descriptor as Mutable<CommandDescriptor>).hasPassthrough = true
    }

    validateDescriptor(descriptor)
    registeredCommands.set(name, { name, fn, descriptor })
}

export function registerTypedCommand<
    const T extends PositionalArgument[] = PositionalArgument[], 
    const U extends SwitchArgument[] = SwitchArgument[]
>(name: string, descriptor: CommandDescriptor<T, U>, fn: (...args: [...ExpandArgs<T>, ExpandOptions<U>]) => Promise<void> | void) {
    registerCommand(name, fn, descriptor)
}

function unpackArgs<T extends any[], U>(args: [...T, U]): [T, U] {
    return [args.slice(0, -1) as any, args.at(-1) as any]
}

// The order affects sorting
const categories = ['setup', 'development', 'operations', 'debugging', 'refactoring', 'automation', 'tools']

function groupByCategory(commands: Iterable<RegisteredCommand>) {
    const byCategory = new Map<string, RegisteredCommand[]>()
    for (const v of commands) {        
        const c = v.descriptor.category
        const primary = Array.isArray(c) ? c[0] : c
        if (!primary) continue

        if (!byCategory.has(primary)) {
            byCategory.set(primary, [])
        }

        byCategory.get(primary)!.push(v)
    }

    return new Map(
        [...byCategory].sort((a, b) => categories.indexOf(a[0]) - categories.indexOf(b[0]))
    )
}

interface ShowCommandsOptions {
    categorize?: boolean
    includeInternal?: boolean
    importantOnly?: boolean
    indent?: number
}

function showCommands(opt: ShowCommandsOptions = {}) {
    const {
        categorize = false,
        importantOnly = true,
        includeInternal = false, 
        indent = 4,
    } = opt

    function filter(desc: CommandDescriptor) {
        if (importantOnly && !desc.isImportantCommand) {
            return false
        }
        if (desc.internal && !includeInternal) {
            return false
        }
        if (categorize && (!desc.category || (Array.isArray(desc.category) && desc.category.length === 0))) {
            return false
        }
        return !desc.hidden
    }

    const filtered = [...registeredCommands].filter(([k, v]) => filter(v.descriptor))

    if (categorize) {
        const byCategory = groupByCategory(filtered.map(x => x[1]))
        const paddingWidth = filtered.map(x => x[1].name).reduce((a, b) => Math.max(a, b.length), 0)

        for (const [k, v] of byCategory) {
            printLine((bold(colorize('blue', k))))

            for (const d of v) {
                const name = colorize('cyan', d.name.padEnd(paddingWidth, ' '))
                const desc = d.descriptor.description ? `${d.descriptor.description}` : ''
                printLine(`    ${name}  ${desc}`)
            }

            printLine()
        }

        return
    }

    const parts: [string, string][] = []
    for (const [k, v] of filtered) {
        const suffix = v.descriptor.internal ? colorize('gray', ` [internal]`) : ''
        const label = `${colorize('cyan', k)}${suffix}`
        const desc = v.descriptor.description ? `${v.descriptor.description}` : ''
        parts.push([label, desc])
    }

    if (parts.length === 0) {
        return
    }

    const stripped = parts.map(p => stripAnsi(p[0]))
    const padding = stripped.sort((a, b) => a.length - b.length).at(-1)!.length + 2
    for (const [k, v] of parts) {
        const label = k + ' '.repeat(padding - stripAnsi(k).length)
        printLine(`${' '.repeat(indent)}${label}${v}`)
    }
}

export function showUsage() {
    printLine('Usage: synapse <command> [...arguments] [...options]')
    printLine()
    printLine('Important Commands:')
    showCommands()
    printLine()
    printLine(`Getting started guide:`)
    printLine(`    https://github.com/Cohesible/synapse/blob/main/docs/getting-started.md`)
}

// Really adhoc. I know there's way better ways to do fuzzy matching
function findPossibleSwaps(a: string, b: string) {
    if (a.length > b.length) {
        return findPossibleSwaps(b, a)
    }

    let swaps = 0
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i - 1] && a[i - 1] === b[i]) {
            swaps += 1
        } else if (a[i] === b[i + 1] && a[i + 1] === b[i]) {
            swaps += 1
        }
    }

    return swaps
}

function didYouMean(cmd: string) {
    const scores = [...registeredCommands.entries()]
        .filter(x => !x[1].descriptor.internal && !x[1].descriptor.hidden)
        .map(x => x[0])
        .map(c => [c, levenshteinDistance(c.slice(0, cmd.length), cmd)] as const)
        .sort((a, b) => a[1] - b[1])

    const bestScore = scores[0][1]
    const invalidCmdMsg = `"${cmd}" is not a valid command.`

    // Take all commands with the best score
    const matches = scores.filter(x => x[1] === bestScore).map(x => x[0])
    if (matches.length === 1) {
        const suggestion = renderCmdSuggestion(matches[0], [], false)
        printLine(`${invalidCmdMsg} Did you mean ${suggestion}`)
        return
    }

    // We'll break ties by checking possible tranpositions
    const round2 = matches.map(x => [x, findPossibleSwaps(x, cmd)] as const).sort((a, b) => b[1] - a[1])
    const bestScore2 = round2[0][1]
    const answers = round2.filter(x => x[1] === bestScore2).map(x => x[0])
    if (answers.length === 1) {
        const suggestion = renderCmdSuggestion(answers[0], [], false)
        printLine(`${invalidCmdMsg} Did you mean ${suggestion}`)
    } else {
        printLine(`${invalidCmdMsg} Did you mean:`)
        const colWidth = 16
        const numCols = 4
        const numRows = Math.ceil(answers.length / numCols)
        for (let i = 0; i < numRows; i++) {
            let line = '    '
            for (let j = 0; j < numCols; j++) {
                const m = answers[i * 4 + j]
                if (!m) break

                const text = renderCmdSuggestion(m, [], false)
                const width = stripAnsi(text).length
                line += text + ' '.repeat(colWidth - width)
            }

            printLine(line)
        }
    }
}

export async function runWithAnalytics(name: string, cmd: () => Promise<void>) {
    eagerlyStartDaemon()

    let errorCode: string | undefined
    const startTime = Date.now()

    try {
        await cmd()
    } catch (e) {
        const code = (e as any).code
        errorCode = code ? String(code) : (e as any).name
        // TODO: extract traces that are from the CLI
        // We could emit that data if we scrub filepaths

        throw e
    } finally {
        const duration = Date.now() - startTime

        try {
            emitCommandEvent({
                name,
                duration,
                errorCode,
            })
        } catch {}
    }
}

const oses = ['windows', 'linux', 'darwin']
const archs = ['x64', 'aarch64']

const pairs: string[] = []
for (const os of oses) {
    for (const arch of archs) {
        pairs.push(`${os}-${arch}`)
    }
}

const hostTargetType = createEnumType(pairs[0], ...pairs.slice(1))

const supportedIntegrations = ['local', 'aws', 'azure', 'gcp'] as const

const varargsFiles = {
    name: 'files',
    type: typescriptFileType,
    allowMultiple: true,
} satisfies PositionalArgument

const objectHashType = (val: string) => getObjectByPrefix(val)

const objectHashArg = {
    name: 'objectHash', 
    type: objectHashType,
} satisfies PositionalArgument

const deployTargetOption = { 
    name: 'target' as const,
    shortName: 't',
    type: createUnionType(
        createEnumType(...supportedIntegrations),
        'string',
    ), 
    description: 'The default deployment target to use when synthesizing standard resources' 
} satisfies SwitchArgument

const buildTargetOptions = [
    { name: 'environment', type: 'string', environmentVariable: 'SYNAPSE_ENV', aliases: ['env'], hidden: true }
] as const satisfies SwitchArgument[]

const compileOptions = [
    ...buildTargetOptions,
    deployTargetOption,
    { name: 'no-incremental', type: 'boolean', description: 'Disables incremental compilation' },
    { name: 'no-synth', type: 'boolean', description: 'Synthesis inputs are emitted instead of executed', hidden: true },
    { name: 'no-infra', type: 'boolean', description: 'Disables generation of synthesis inputs', hidden: true },
    { name: 'skip-install', type: 'boolean' },
    { name: 'host-target', type: hostTargetType, hidden: true },
    { name: 'strip-internal', type: 'boolean', hidden: true }
] as const satisfies SwitchArgument[]

const deployOptions = [
    ...buildTargetOptions,
    deployTargetOption,
    // This will behave like `plan`
    { 
        name: 'dry-run', 
        type: 'boolean', 
        description: 'Shows the predicted changes to a deployment without applying them.' 
    },
    // Hidden because not tested
    { name: 'refresh', type: 'boolean', description: 'Fetches the state of remote resources instead of using the saved state', hidden: true }, 
    { name: 'terraform-path', type: 'string', hidden: true },
    { name: 'provider-server-port', type: 'number', description: 'Use a specific port for the Synapse resource server', hidden: true },
    { name: 'sync-after', type: 'boolean', hidden: true },
    { name: 'symbol', type: 'string', hidden: true, allowMultiple: true },
    { name: 'use-optimizer', type: 'boolean', hidden: true },
] as const satisfies SwitchArgument[]

registerTypedCommand(
    'compile',
    {
        args: [varargsFiles],
        category: ['development'],
        options: [
            ...compileOptions, 
            { name: 'log-symEval', type: 'boolean', hidden: true },
            { name: 'force-infra', type: 'string', allowMultiple: true, hidden: true },
        ],
        requirements: { program: true },
        inferBuildTarget: true,
        description: 'Converts program source code into deployable artifacts.'
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        await synapse.compile(files, {
            deployTarget: opt['target'],
            noInfra: opt['no-infra'],
            noSynth: opt['no-synth'],
            logSymEval: opt['log-symEval'],
            incremental: !opt['no-incremental'],
            skipInstall: opt['skip-install'],
            hostTarget: opt['host-target'],
            forcedInfra: opt['force-infra'],
            stripInternal: opt['strip-internal'],
            environmentName: opt['environment'],
        })
    }
)

registerTypedCommand(
    'watch',
    {
        internal: true,
        category: ['development'],
        options: [{ name: 'auto-deploy', type: 'boolean' }],
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        await synapse.watch(undefined, {
            autoDeploy: opt['auto-deploy'],
        })
    },
)

registerTypedCommand(
    'bundle-to-sea',
    {
        internal: true,
        args: [{ name: 'dir', type: 'string' }],
    },
    async (...args) => {
        await convertBundleToSea(args[0])
    }
)

registerTypedCommand(
    'deploy',
    {
        isImportantCommand: true,
        category: ['operations'],
        args: [varargsFiles], // FIXME: this should accept symbol paths, filenames are a special case
        options: [
            { name: 'rollback-if-failed', type: 'boolean', hidden: true }, 
            { name: 'plan-depth', type: 'number', hidden: true },
            { name: 'expect-no-changes', type: 'boolean', hidden: true }, // For tests
            { name: 'debug', type: 'boolean', hidden: true },
            { name: 'sync', type: 'boolean', hidden: true },
            ...deployOptions, 
        ],
        requirements: { program: true, process: true },
        inferBuildTarget: true,
        description: 'Create or update a deployment.'
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        // XXX: hardcoded
        if (opt.target === 'azure' || opt.target === 'gcp') {
            throw new Error(`The cloud target "${opt.target}" is not yet implemented.`)
        }

        if (opt['dry-run']) {
            return synapse.plan(files, {
                symbols: opt['symbol'],
                forceRefresh: opt['refresh'],
                planDepth: opt['plan-depth'],
                debug: opt['debug'],
                expectNoChanges: opt['expect-no-changes'],
            })
        }

        await synapse.deploy(files, {
            ...opt,
            symbols: opt['symbol'],
            forceRefresh: opt['refresh'],
            deployTarget: opt['target'],
            syncAfter: opt['sync-after'],
            rollbackIfFailed: opt['rollback-if-failed'],
            useOptimizer: opt['use-optimizer'],
        })
    }
)

// FIXME: this currently behaves more like `sync`
// Conflicts are generally "very bad" and are usually analagous to "overwrite this file?"
// So we only really need `sync` and maybe `push`. 
// `sync` - reconcile state (either push, pull, or fail/prompt for conflicts)
// `push` - directly set state
//
// Can states be merged? Yes. But it's something that can either be done automatically or fails.
registerTypedCommand(
    'pull',
    {
        internal: true,
        options: [{ name: 'fail-if-empty', type: 'boolean' }],
    },
    async (...args) => {
        const [_, opt] = unpackArgs(args)

        const bt = getBuildTargetOrThrow()
        if (bt.deploymentId) {
            return synapse.syncModule(bt.deploymentId)
        }

        if (opt['fail-if-empty']) {
            throw new Error(`Nothing to pull`)
        }
        printLine('Nothing to pull')
    }
)

registerTypedCommand(
    'destroy',
    {
        isImportantCommand: true,
        category: ['operations'],
        args: [varargsFiles],
        options: [
            ...deployOptions, 
            { name: 'deploymentId', type: 'string', hidden: true },
            { name: 'tests-only', type: 'boolean', hidden: true },
            { name: 'yes', type: 'boolean', hidden: true },
            { name: 'clean-after', type: 'boolean', hidden: true }
        ],
        requirements: { program: true, process: true },
        inferBuildTarget: true,
        description: 'Tears down resources in a deployment.'
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        await synapse.destroy(files, {
            dryRun: opt['dry-run'],
            symbols: opt['symbol'],
            forceRefresh: opt['refresh'],
            deploymentId: opt.deploymentId,
            useTests: opt['tests-only'],
            yes: opt['yes'],
            cleanAfter: opt['clean-after'],
        })
    }
)

registerTypedCommand(
    'rollback',
    {
        category: ['operations'],
        description: 'Reverts the most recent deploy action.',
        options: [
            ...buildTargetOptions, 
            { name: 'sync-after', type: 'boolean', hidden: true },
        ],
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        await synapse.rollback('', opt as any)
    }
)

registerTypedCommand(
    'test',
    {
        isImportantCommand: true,
        category: ['development', 'automation'],
        args: [varargsFiles],
        options: [
            ...buildTargetOptions, 
            deployTargetOption,
            // TODO: should this include all compile/deploy options because this can do both?
            // I've wanted to do `test --target aws` a few times now
            // I'm thinking we'll categorize options by commands but still have options share a global namespace
            // That way `--target` always means the same thing, though most commands would ignore it
            { name: 'destroy-after', type: 'boolean', hidden: true },
            { name: 'rollback-if-failed', type: 'boolean', hidden: true },
            { name: 'filter', type: 'string', hidden: true },
            { name: 'no-cache', type: 'boolean', description: 'Runs tests without caching results or using cached results' },
            // TODO: need all flags to also have a `no` variant, right now this option does nothing. At all.
            { name: 'show-logs', type: 'boolean', description: 'Shows all test logs regardless of the outcome', defaultValue: true },
        ],
        requirements: { program: true, process: true },
        inferBuildTarget: true,
        description: 'Deploy and run test resources.'
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        await synapse.runTests(files, {
            deployTarget: opt['target'],
            destroyAfter: opt['destroy-after'],
            rollbackIfFailed: opt['rollback-if-failed'],
            filter: opt['filter'],
            noCache: opt['no-cache'],
            showLogs: opt['show-logs'],
        })
    }
)

registerTypedCommand(
    'print-types', 
    {
        internal: true,
        args: [],
        options: [

        ],
    },
    (opt) => synapse.printTypes()
)

registerTypedCommand(
    'show-object', 
    {
        hidden: true,
        args: [objectHashArg],
        options: [
            { name: 'captured', type: 'boolean' },
            { name: 'infra', type: 'boolean' }
        ],
    },
    (obj, opt) => synapse.showPointer(obj, opt)
)

registerTypedCommand(
    'publish',  
    {
        category: ['development'],
        hidden: true,
        options: [
            { name: 'local', type: 'boolean', description: 'Writes to the local Synapse package repository. This is scoped per-project, use `spr:#<pkg-name>` as the version string in consumer packages.' },
            { name: 'sourcemaps', type: 'boolean', hidden: true },
            { name: 'remote', type: 'boolean', hidden: true },
            { name: 'dry-run', type: 'boolean', hidden: true },
            { name: 'skip-install', type: 'boolean', hidden: true },
            { name: 'archive', type: 'string', hidden: true },
            { name: 'overwrite', type: 'boolean', hidden: true },
            { name: 'visibility', type: createEnumType('public', 'private'), hidden: true },
            { name: 'ref', type: 'string', hidden: true },
            ...buildTargetOptions,
        ],
    },
    async (opt) => {
        await synapse.publish('', {
            ...opt,
            dryRun: opt['dry-run'],
            skipInstall: opt['skip-install'],
            archive: opt['archive'],
            environmentName: opt['environment'],
            overwrite: opt['overwrite'],
            visibility: opt['visibility'],
        })
    }
)

registerTypedCommand(
    'gc',  
    {
        hidden: true,
        options: [
            { name: 'dry-run', type: 'boolean' },
            { name: 'age', type: 'number', description: 'Delete objects older than this many seconds. Defaults to 1 day' }
        ],
    }, 
    async (opt) => {
        await synapse.collectGarbage('', {
            ...opt,
            dryRun: opt['dry-run'],
        })
    }
)

registerTypedCommand(
    'gc-resources',  
    {
        internal: true,
        options: [
            { name: 'dry-run', type: 'boolean' }
        ],
    },
    async (opt) => {
        await synapse.collectGarbageResources('', {
            ...opt,
            dryRun: opt['dry-run'],
        })
    }
)


registerTypedCommand(
    'show',  
    {
        category: ['debugging', 'operations'],
        hidden: true,
        args: [{ name: 'symbols', type: 'string', allowMultiple: true }],
        options: [
            ...buildTargetOptions,
            { name: 'names-only',  type: 'boolean' }
        ]
    },
    async (...args) => {
        const [symbols, opt] = unpackArgs(args)

        await synapse.show(symbols, opt)
    }
)

// `synapse help` should only show the most important commands/options rather than
// dumping everything and having the user dig through a bunch of text. The `--all` 
// switch can be used if someone really wants the wall of text.
registerTypedCommand(
    'help',  
    {
        isImportantCommand: true,
        args: [{ name: 'command', type: 'string', description: 'Name of a command to show help for', optional: true }],
        description: 'Shows additional usage information.',
        options: [{ name: 'all', type: 'boolean', description: 'Shows everything', hidden: true }],
    },
    async (...args) => {
        const [commands, opt] = unpackArgs(args)

        if (commands[0]) {
            const targetCmd = getCommand(commands[0])
            if (!targetCmd) {
                throw new Error(`No such command exists: ${commands[0]}`)
            }

            return showHelp(targetCmd.name, targetCmd.descriptor)
        }

        printLine('Usage: synapse <command> [...arguments] [...options]')
        printLine('Use synapse help <command> for a detailed description')
        printLine()
        printLine('Commands by Category:')
        printLine()
        showCommands({ categorize: true, importantOnly: false })
    }
)

registerTypedCommand(
    'clone',
    {
        internal: true,
        category: 'setup',
        description: 'Clones an existing project'
    },
    () => {}
)

registerTypedCommand(
    'detect-refactors',  
    {
        hidden: true,
        category: ['refactoring'],
        description: 'Finds resources that may have been renamed and moves them for the next deployment.',
        args: [varargsFiles],
        options: [
            { name: 'reset', type: 'boolean' }, 
            { name: 'outfile', type: 'string' },
            ...buildTargetOptions
        ],
        aliases: ['migrate'], // Legacy
    },
    async (...args) => {
        const [files, opt] = unpackArgs(args)

        await synapse.migrateIdentifiers(files, opt)
    }
)

registerTypedCommand(
    'status',  
    {
        category: ['development'],
        description: 'Shows the build state for the current program, including any stale files.',
        options: [{ name: 'verbose', shortName: 'v', type: 'boolean' }]
    },
    opt => synapse.showStatus(opt)
)

registerTypedCommand(
    'run',  
    {
        isImportantCommand: true,
        category: ['development', 'automation'],
        args: [{ name: 'target', type: createUnionType(typescriptFileType, 'string'), optional: true }],
        options: [
            // dynamicArg,
            passthroughSwitch, 
            { name: 'skipValidation', type: 'boolean', hidden: true }, 
            { name: 'skipCompile', type: 'boolean', hidden: true }, 
            { name: 'runDir', type: 'string', hidden: true }, 
            { name: 'no-deploy', type: 'boolean', description: 'Skips any prompts to deploy the program' },
            ...buildTargetOptions
        ],
        inferBuildTarget: true,
        description: 'Execute a file or script.',
    },
    async (target, opt) => {
        await synapse.run(target, opt.targetArgs ?? [], { ...opt, noDeploy: opt['no-deploy'] })
    }
)

registerTypedCommand(
    'run-internal-test',
    {
        internal: true,
        args: [{ name: 'file', type: typescriptFileType }],
        options: [{ name: 'synapseCmd', type: 'string' }]
    },
    async (target, opt) => {
        await runInternalTestFile(path.resolve(getWorkingDir(), target), opt)
    }
)

registerTypedCommand(
    'export-identity',
    {
        internal: true,
        args: [{ name: 'destination', type: 'string' }],
    },
    async (target) => {
        const auth = getAuth()
        await auth.exportIdentity(path.resolve(getWorkingDir(), target))
    }
)

registerTypedCommand(
    'import-identity',
    {
        internal: true,
        args: [{ name: 'file', type: 'string', optional: true }],
        requirements: { program: false }
    },
    async (target) => {
        const auth = getAuth()
        await auth.importIdentity(!target ? '-' : path.resolve(getWorkingDir(), target))
    }
)

registerTypedCommand(
    'add',  
    {
        hidden: true,
        category: 'development',
        args: [{ name: 'packages', type: 'string', allowMultiple: true, min: 1 }],
        options: [
            { name: 'dev', shortName: 'd', type: 'boolean' }, 
            { name: 'mode', type: createEnumType('all', 'types'), hidden: true }
        ]
    },
    async (...args) => {
        const [packages, opt] = unpackArgs(args)
        await synapse.install(packages, opt)
    }
)

registerTypedCommand(
    'remove',  
    {
        hidden: true,
        category: 'development',
        args: [{ name: 'packages', type: 'string', allowMultiple: true, min: 1 }],
        options: []
    },
    async (...args) => {
        const [packages, opt] = unpackArgs(args)
        await synapse.install(packages, { ...opt, remove: true })
    }
)

/** @deprecated */
registerTypedCommand(
    'clear-cache',  
    {
        internal: true,
        args: [{ name: 'caches', type: 'string', allowMultiple: true }]
    },
    async (...args) => {
        const [caches, opt] = unpackArgs(args)
        await synapse.clearCache(caches[0], opt)
    }
)

registerTypedCommand(
    'dump-fs',  
    {
        hidden: true,
        args: [{ name: 'fs', optional: true, type: createUnionType(createEnumType('program', 'deployment', 'package', 'test'), objectHashType) }],
        options: [...buildTargetOptions, { name: 'block', type: 'boolean', hidden: true }, { name: 'debug', type: 'boolean', hidden: true, defaultValue: true }]
    },
    async (fs, opt) => {
        await synapse.emitBfs(fs, opt)
    }
)

registerTypedCommand(
    'emit',  
    {
        args: [],
        category: 'automation',
        description: 'Writes out the current build artifacts to disk.',
        options: [
            ...buildTargetOptions, 
            { name: 'out-dir', type: 'string', aliases: ['outDir'], description: 'Where to write artifacts. By default, uses `outDir` from `tsconfig.json`, otherwise `./out`' }, 
            { name: 'block', type: 'boolean', hidden: true }, 
            { name: 'debug', type: 'boolean', hidden: true }, 
            { name: 'no-optimize', type: 'boolean', hidden: true }
        ]
    },
    async (opt) => {
        await synapse.emitBfs('package', { ...opt, isEmit: true })
    }
)

registerTypedCommand(
    'emit-blocks',
    {
        internal: true,
        args: [{ name: 'dest', type: 'string' }],
    },
    async (dest) => {
        return synapse.emitBlocks(dest)
    }
)

registerTypedCommand(
    'show-logs',  
    {
        hidden: true,
        options: [{ name: 'list', type: 'boolean' }]
    },
    async (...args) => {
        const [_, opt] = unpackArgs(args)
        await synapse.showLogs(opt.list ? 'list' : '')
    }
)

registerTypedCommand(
    'login',  
    {
        internal: true,
        options: [{ name: 'machine', type: 'boolean', hidden: true }],
        requirements: { program: false }
    },
    async (...args) => {
        const [_, opt] = unpackArgs(args)
        if (opt.machine) {
            return synapse.machineLogin()
        }
        await synapse.login()
    }
)

registerTypedCommand(
    'upgrade',  
    {
        description: 'Installs the latest CLI version.',
        category: 'tools',
        options: [
            { name: 'force', type: 'boolean', description: 'Forcibly installs the CLI over the existing version.' },
            // TODO: add implications to provider better generated docs.
            // I think `--tag` should imply `--force` 
            { name: 'tag', type: 'string', description: 'Download the build associated with a git tag.' },
            { name: 'hash', type: 'string', hidden: true, description: 'Artifact hash. Does not check compat.' },
            { name: 'installDir', type: 'string', hidden: true, description: 'Overrides the current install dir.' },
        ],
        requirements: { program: false }
    },
    async (...args) => {
        const [_, opt] = unpackArgs(args)
        await tryUpgrade(opt)
    }
)

registerTypedCommand(
    'clean',  
    {
        args: [],
        description: 'Deletes internal caches for the current program.',
        category: 'tools',
        options: [
            { name: 'packages', type: 'boolean', description: 'Clears the packages cache' },
            { name: 'tests', type: 'boolean', description: 'Clears the tests cache' },
            { name: 'program', type: 'boolean', hidden: true },

            // TODO: expose this with proper UI surrounding the hazards
            { name: 'deployment', type: 'boolean', hidden: true }
        ],
        requirements: { program: true },
    },
    (opt) => synapse.clean(opt),
)

registerTypedCommand(
    // Rename to `install-packages` ???
    'install',
    {
        hidden: true,
        args: [],
        requirements: { program: true },
    },
    (opt) => synapse.install([]),
) 

registerTypedCommand(
    'locked-install',  
    {
        internal: true,
        args: [],
        requirements: { program: true },
    },
    (opt) => synapse.lockedInstall(),
) 


registerTypedCommand(
    'list-install',  
    {
        internal: true,
        args: [],
        requirements: { program: true },
    },
    (opt) => synapse.listInstallTree(),
) 

registerTypedCommand(
    'build',
    {
        category: 'automation',
        description: 'Builds all executables in the current program.',
        args: [{ name: 'target', type: typescriptFileType, allowMultiple: true }],
        options: [
            { name: 'lazy-load', type: 'string', allowMultiple: true }, 
            { name: 'no-sea', type: 'boolean' },
            { name: 'minify', type: 'boolean' },
            { name: 'synapse-path', type: 'string' },
            { name: 'optimize', hidden: true, type: 'boolean' },

            // Cross-compilation (currently broken due to v8 heap snapshots and/or code caches not being portable)
            { name: 'os', type: createEnumType('windows', 'linux', 'darwin'), hidden: true },
            { name: 'arch', type: createEnumType('x64', 'aarch64'), hidden: true },
        ],
    },
    (...args) => {
        const [files, opt] = unpackArgs(args)
        
        return synapse.buildExecutables(files, {
            os: opt['os'],
            arch: opt['arch'],
            sea: !opt['no-sea'],
            minify: opt['minify'],
            lazyLoad: opt['lazy-load'],
            synapsePath: opt['synapse-path'],
            useOptimizer: opt['optimize'],
        })
    },
)

registerTypedCommand(
    'diff-objects',  
    {
        internal: true,
        args: [{ name: 'obj1', type: objectHashType }, { name: 'obj2', type: objectHashType }],
    },
    (a, b) => synapse.diffObjectsCmd(a, b)
)

registerTypedCommand(
    'diff-indices',  
    {
        internal: true,
        args: [{ name: 'obj1', type: objectHashType }, { name: 'obj2', type: objectHashType }],
    },
    (a, b) => synapse.diffIndicesCmd(a, b)
)

registerTypedCommand(
    'diff-file',  
    {
        internal: true,
        args: [{ name: 'file', type: 'string' }],
        options: [{ name: 'commitsBack', type: 'number' }],
    },
    (a, opt) => synapse.diffFileCmd(a, opt)
)

registerTypedCommand(
    'repl',  
    {
        category: ['debugging', 'operations'],
        description: 'Enters an interactive REPL session, optionally using a target file.',
        // The target file\'s exports are placed in the global scope.
        args: [{ name: 'file', type: typescriptFileType, optional: true }],
        options: [
            ...buildTargetOptions,
            { name: 'no-deploy', type: 'boolean' },
            { name: 'eval', type: 'string', hidden: true }
        ],
    },
    (a, opt) => synapse.replCommand(a, {
        ...opt,
        noDeploy: opt['no-deploy'],
    }),
)

registerTypedCommand(
    'test-glob',  
    {
        internal: true,
        args: [{ name: 'patterns', type: 'string', allowMultiple: true }],
    },
    async (...args) => {
        const [patterns, opt] = unpackArgs(args)
        await synapse.testGlob(patterns, opt)
    }
)

registerTypedCommand(
    'load-block',  
    {
        hidden: true,
        args: [{ name: 'path', type: 'string' }, { name: 'destination', type: 'string', optional: true }],
        options: buildTargetOptions,
    },
    async (...args) => {
        await synapse.loadBlock(args[0], args[1])
    }
)

registerTypedCommand(
    'dump-state',  
    {
        hidden: true,
        args: [{ name: 'path', type: 'string', optional: true }],
        options: buildTargetOptions,
    },
    async (...args) => {
        await synapse.dumpState(args[0])
    }
)

registerTypedCommand(
    'load-state',  
    {
        hidden: true,
        args: [{ name: 'path', type: 'string' }],
        options: buildTargetOptions,
    },
    async (...args) => {
        await synapse.loadState(args[0])
    }
)

const internalBundleOptions = [
    { name: 'snapshot', type: 'boolean' }, 
    { name: 'sea', type: 'boolean' },
    { name: 'production', type: 'boolean' },
    { name: 'lto', type: 'boolean' },
    { name: 'stagingDir', type: 'string' },
    { name: 'downloadOnly', type: 'boolean' },
    { name: 'preserveSource', type: 'boolean' },
    { name: 'integrationsOnly', type: 'boolean' },
    { name: 'libc', type: 'string' },
    { name: 'integration', type: 'string', allowMultiple: true },
    { name: 'seaPrep', type: 'boolean' },
    { name: 'pipelined', type: 'string' },
] as const satisfies SwitchArgument[]

// Will be removed soon
registerTypedCommand(
    'bundle',  
    {
        internal: true,
        args: [{ name: 'target', type: hostTargetType, optional: true }],
        options: internalBundleOptions
    },
    (target, opt) => internalBundle(target, opt)
)

registerTypedCommand(
    'download-node-lib',  
    {
        internal: true,
        args: [],
    },
    async (...args) => {
        await downloadNodeLib('Cohesible', 'synapse-node-private')
    }
)

registerTypedCommand(
    'test-zip',  
    {
        internal: true,
        args: [{ name: 'dir', type: 'string' }, { name: 'dest', type: 'string', optional: true }],
    },
    async (...args) => {
        await synapse.testZip(args[0], args[1])
    }
)


registerTypedCommand(
    'convert-primordials', 
    { internal: true, args: [{ name: 'files', type: 'string', allowMultiple: true }] },
    (...args) => synapse.convertPrimordials(args.slice(0, -1) as string[]),
)


registerTypedCommand(
    'backup', 
    { internal: true, args: [{ name: 'destination', type: 'string' }] },
    (...args) => synapse.backup(args[0]),
)

registerTypedCommand(
    'explain', 
    { internal: true, args: [{ name: 'symbol', type: 'string' }] },
    (...args) => synapse.explain(args[0]),
)

registerTypedCommand(
    'load-moved', 
    { 
        hidden: true, 
        args: [{ name: 'moves', type: 'string' }],
    },
    async (filename) => {
        await synapse.loadMoved(filename, false)
    },
)

registerTypedCommand(
    'list-deployments', 
    { 
        hidden: true,
        options: [{ name: 'all', type: 'boolean' }],
    },
    (opt) => synapse.listDeployments(undefined, opt),
)

registerTypedCommand(
    'test-gc-daemon', 
    { internal: true },
    (...args) => synapse.testGcDaemon(),
)

registerTypedCommand(
    'inspect-block',  
    {
        internal: true,
        args: [{ name: 'target', type: 'string'}],
    },
    (target, opt) => synapse.inspectBlock(target, opt)
)

registerTypedCommand(
    'fs-stats',  
    {
        hidden: true,
        args: [],
        options: [{ name: 'all', type: 'boolean' }, { name: 'deployment', type: 'boolean'}],
    },
    (opt) => synapse.printFsStats(opt)
)

registerTypedCommand(
    'query-logs',  
    {
        category: 'debugging',
        args: [{ name: 'symbol-path', type: 'string', allowMultiple: true }],
        options: [{ name: 'system', type: 'boolean', description: 'Shows system log messages' }],
        description: 'Fetches logs from resources. Use names to filter.'
    },
    (...args) => {
        const [refs, opt] = unpackArgs(args)

        return synapse.queryResourceLogs(refs[0], opt)
    }
)

registerTypedCommand(
    'quote',  
    {
        category: 'tools',
        description: 'Prints a motivational quote queried from a public Synapse application.',
    },
    () => synapse.quote()
)

function coercedJsonParse(v: string) {
    if (v === '') {
        return v
    } else if (v === 'null') {
        return null
    } else if (v[0] === '{' || v[0] === '[' || !Number.isNaN(Number(v))) {
        return JSON.parse(v)
    }

    return v
}

registerTypedCommand(
    'config',  
    {
        hidden: true,
        description: 'Get or set a key in the user config file',
        // TODO: need to make get/set explicit. This is ok for now though
        args: [{ name: 'key', type: 'string' }, { name: 'value', type: coercedJsonParse, optional: true }],
    },
    async (...args) => {
        if (!args[1]) {
            const val = await readKey(args[0])
            printJson(val)
        } else {
            await setKey(args[0], args[1])
        }
    }
)

const getAllCommands = memoize(() => Object.fromEntries([...registeredCommands].map(([k, v]) => [k, v.descriptor])))

registerTypedCommand(
    'completion',
    { options: [passthroughSwitch], hidden: true, requirements: { program: false } },
    (opt) => handleCompletion(opt.targetArgs ?? [], getAllCommands()),
)

registerTypedCommand(
    'deploy-modules',
    {
        internal: true,
        args: [{ name: 'files', type: typescriptFileType, allowMultiple: true }]
    },
    async (...args) => {
        const [files] = unpackArgs(args)
        await synapse.deployModules(files)
    }
)

registerTypedCommand(
    'taint', 
    {
        hidden: true,
        args: [{ name: 'resourceId', type: 'string' }],
    }, 
    (a, opt) => synapse.taint(a, opt)
)

registerTypedCommand(
    'delete-resource', 
    {
        hidden: true,
        args: [{ name: 'resourceId', type: 'string' }],
        options: [{ name: 'force', type: 'boolean' }, ...buildTargetOptions]
    }, 
    (a, opt) => synapse.deleteResource(a, opt)
)

registerTypedCommand(
    'list-commits',  
    {
        hidden: true,
        requirements: { process: true },
        options: [{ name: 'program', type: 'boolean' }]
    },
    async (opt) => await synapse.listCommitsCmd('', { useProgram: opt['program'] }),
)

// TODO: if we want to be fancy (and a bit risky), we can make this command _very_ prominent if the user
// is obviously not in a program/project. For example, it should show first in any commands lists
// and it should be the only recommended command to use. And we would reject commands like `deploy`
// if there's obviously nothing there. But anyway, more logic = more ways to break. This improvement 
// would be great for adoption but should be thrown out soon after.
registerTypedCommand(
    'init',  
    {
        category: 'setup',
        isImportantCommand: true,
        description: 'Initializes a new program in the current directory.',
        options: [
            { name: 'template', type: 'string' }
        ]
    },
    (opt) => synapse.init(opt)
)

registerTypedCommand(
    'process-prof',
    { 
        internal: true,
        args: [{ name: 'cpu-profile', type: 'string', optional: true }],
    },
    (arg) => synapse.processProf(arg)
)

registerTypedCommand(
    'import-resource',
    {
        hidden: true,
        category: ['development', 'operations'],
        args: [
            { name: 'resource', type: 'string' }, 
            { name: 'id', type: 'string' }
        ],
    },
    (...args) => {
        const [[resource, id], opt] = unpackArgs(args)

        return synapse.importResource(resource, id)
    }
)

registerTypedCommand(
    'move-resource',
    {
        args: [
            { name: 'from', type: 'string' }, // These should be symbol paths
            { name: 'to', type: 'string' }
        ],
        description: 'Refactor resources by mapping their current state to code.',
        helpDescription: 'Refactor resources by mapping their current state (<from>) to updated code definitions (<to>) for the next deploy.',
        category: ['refactoring', 'operations'],
        examples: [
            'bucket bucket2 # Move resources under bucket to bucket2',
            'hello.ts#bucket main.ts#bucket2 # Move bucket in hello.ts to bucket2 in main.ts',
        ],
    },
    (...args) => {
        const [[from, to], opt] = unpackArgs(args)

        return synapse.moveResource(from, to)
    }
)

function gatherInfo() {
    const version = getCurrentVersion()

    return {
        version: version.semver,
        revision: version.revision,
        host: `${process.platform}-${process.arch}-${os.endianness()}`,
        'os-version': os.release(),
    }
}

function printInfo() {
    for (const [k, v] of Object.entries(gatherInfo())) {
        if (v === undefined) continue
        printLine(`* ${k}: ${v}`)
    }
}

registerTypedCommand('print-info', { hidden: true }, printInfo)

registerTypedCommand(
    'report-bug',
    {
        description: 'Report a bug with Synapse.',
        category: 'tools', // Or `feedback`?
        args: [],
    },
    (...args) => {
        // ?body=<url encoded>
        // Use URL shortener e.g. `synap.sh/bug-report/<short-id>`
        // API would just be `POST synap.sh/bug-report` w/ relevant body
        // Just need to guard against spam
        const issueUrl = 'https://github.com/Cohesible/synapse/issues/new?labels=bug&template=bug_report.md'

        printLine()
        printLine(colorize('brightBlue', 'Open this link to create a new issue:'))
        printLine(`    ${issueUrl}`)
        printLine()

        printLine(colorize('brightBlue', 'Then paste the following under "System Info":'))
        printLine()
        printInfo()
        printLine()
    }
)

registerTypedCommand(
    'zig',
    {
        internal: true,
        options: [passthroughSwitch],
    },
    (...args) => {
        const [rest, opt] = unpackArgs(args)

        return passthroughZig(opt.targetArgs ?? [])
    }
)

registerTypedCommand(
    'install-vscode-zig-extension',
    { 
        hidden: true,
        requirements: { program: false },
    },
    () => installVsCodeZigExtension()
)

export function isEnumType(type: ArgType): type is EnumType {
    return typeof type === 'object' && !!(type as any)[enumTypeSym]
}

function isUnionType(type: ArgType): type is UnionType {
    return typeof type === 'object' && !!(type as any)[unionTypeSym]
}

export function isFileType(type: ArgType): type is FileType {
    return typeof type === 'object' && !!(type as any)[fileTypeSym]
}

function parseNumber(arg: string) {
    const n = Number(arg)
    if (isNaN(n)) {
        throw new Error('Not a number')
    }
    return n
}

async function parseArg(val: string, type: ArgType) {
    if (type === 'number') {
        return parseNumber(val)
    }

    if (typeof type === 'function') {
        return type(val)
    }

    if (isFileType(type)) {
        const extnames = type[fileTypeSym]
        const ext = path.extname(val) // TODO: support extnames with multiple dots?
        if (!extnames.has(ext)) {
            throw new Error(`Invalid value "${val}". Expected a filename ending in one of: ${[...extnames].join(', ')}`)
        }

        return val
    }

    if (isUnionType(type)) {
        const types = type[unionTypeSym]
        const errors: [ArgType, Error][] = []
        for (const t of types) {
            try {
                return await parseArg(val, t)
            } catch(e) {
                errors.push([t, e as Error])
            }
        }

        throw new AggregateError(errors)
    }

    if (isEnumType(type)) {
        const s = type[enumTypeSym]
        if (!s.has(val)) {
            throw new Error(`Invalid value "${val}". Expected one of: ${[...s].join(', ')}`)
        }

        return val
    }

    return val
}

// Design/style inspired by `git` man pages
function showHelp(name: string, desc: CommandDescriptor) {
    function renderArg(arg: PositionalArgument) {
        let res = `<${arg.name}>`
        if (arg.allowMultiple) {
            res = `${res}...`
        }
        if (arg.optional || (arg.allowMultiple && (arg.minCount ?? 0) === 0)) {
            res = `[${res}]` // Would a `?` be better?
        }
        return res
    }

    function renderType(t: any, skipParens = false): string {
        switch (t) {
            case 'boolean': return ''
            case 'number': return '<number>'
            case 'string': return '<string>'
        }

        if (isEnumType(t)) {
            const s = `${[...t[enumTypeSym]].join('|')}`

            return skipParens ? s : `(${s})`
        }

        if (isUnionType(t)) {
            const types = [...t[unionTypeSym]]
            const s = `${types.map(t => renderType(t, true)).join('|')}`

            return skipParens ? s : `(${s})`
        }

        if (isFileType(t)) {
            const extnames = [...t[fileTypeSym]]

            return `<${extnames.join(',')} file>`
        }

        if (typeof t === 'function') {
            return `<${t._name ?? t.name}>` // FIXME: compiler should not minify functions where `.name` could be accessed
        }

        return '<any>'
    }

    function renderOption(opt: SwitchArgument) {
        const type = renderType(opt.type)
        const parts: string[] = []
        const names: string[] = []
        if (opt.shortName) {
            names.push(`-${opt.shortName}`)
        }

        names.push(`--${opt.name}`)
        parts.push(names.join(', '))

        if (type) {
            parts.push(type)
        }

        return `${parts.join(' ')}`
    }

    const publicOptions = desc.options?.filter(x => !x.hidden && !x.passthrough) ?? []

    function renderAllArgs() {
        const args = (desc.args ?? []).map(renderArg)
        
        // Better to lump them together past a certain point
        if (publicOptions.length > 3) {
            args.push('[...options]')
        } else {
            // TODO: show allow mutliple
            args.push(...publicOptions.map(x => `[${renderOption(x)}]`))
        }

        return args.join(' ')
    }

    function printWrappedText(indent: string, text: string) {
        // FIXME: doesn't handle wrapping
        const width = getDisplayWidth(text)
        const maxWidth = process.stdout.columns - indent.length
        const lines = Math.ceil(width / maxWidth)
        for (let i = 0; i < lines; i++) {
            printLine(`${indent}${text.slice(i * maxWidth, (i + 1) * maxWidth)}`)
        }
    }

    const indent = '    '
    printLine(bold('SYNOPSIS'))
    printLine(`${indent}${inferCmdName()} ${name} ${renderAllArgs()}`)

    const helpDesc = desc.helpDescription ?? desc.description
    if (helpDesc) {
        printLine()
        printLine(bold('DESCRIPTION'))
        printWrappedText(indent, helpDesc)
    }

    // TODO: dynamic examples would be _amazing_

    if (publicOptions.length > 0) {
        printLine()
        printLine(bold('OPTIONS'))
    
        for (const opt of publicOptions) {
            printLine(`${indent}${renderOption(opt)}`)

            if (opt.description) {
                printWrappedText(indent.repeat(2), opt.description)
            }

            printLine()
        }
    }
}

function validateDescriptor(desc: CommandDescriptor) {
    // Argument rules:
    // 1. Commands with optional args cannot have a rest argument
    // 2. Rest args must be the last argument
    // 3. Optional args cannot precede required args
    // 4. Maximum of 1 rest arg

    if (!desc.args) {
        return
    }

    const restIndex = desc.args.findIndex(x => x.allowMultiple)
    if (restIndex !== -1 && restIndex !== desc.args.length - 1) {
        throw new Error(`Rest arg must come at the end`)
    }

    if (desc.args.filter(x => x.allowMultiple).length > 1) {
        throw new Error(`Multiple rest args are not allowed`)
    }

    const optionalArgs = desc.args.filter(x => x.optional)
    const hasOptional = optionalArgs.length > 0
    if (hasOptional) {
        if (restIndex !== -1) {
            throw new Error(`Cannot combine rest arg with optional args`)
        }

        const firstOptional = optionalArgs[0]
        const rem = desc.args.slice(desc.args.indexOf(firstOptional) + 1)
        const required = rem.filter(x => !x.optional)
        if (required.length > 0) {
            throw new Error(`Required args cannot come before optional args`)
        }
    }
}

async function parseArgs(args: string[], desc: CommandDescriptor) {
    let argPosition = 0
    let invalidPositionalArgs = 0

    const parsedArgs: any[] = []
    const options: Record<string, any> = {}

    const errors: [string, Error][] = []
    const unknownOptions: string[] = []

    const allowMultipleArg = desc.args?.find(a => a.allowMultiple)
    const minArgs = (desc.args?.filter(x => !x.allowMultiple && !x.optional).length ?? 0) + (allowMultipleArg?.minCount ?? 0)
    const passthroughOpt = desc.hasPassthrough ? desc.options?.find(x => x.passthrough) : undefined

    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '--') {
            // If the command doesn't support passthrough args, it's possibly a typo
            if (!passthroughOpt) {
                errors.push([a, new Error(`Passthrough arguments not supported`)])
                continue
            }

            // Consume the remaining args
            options[passthroughOpt.name] = args.slice(i + 1)
            break
        }

        const isLongSwitch = a.startsWith('--')
        const isShortSwitch = !isLongSwitch && a.startsWith('-')
        if (isShortSwitch || isLongSwitch) {
            const n = a.slice(isShortSwitch ? 1 : 2)
            const opt = isLongSwitch 
                ? desc.options?.find(x => x.name === n || x.aliases?.includes(n))
                : desc.options?.find(x => x.shortName === n)

            if (!opt) {
                if (passthroughOpt) {
                    options[passthroughOpt.name] ??= []
                    options[passthroughOpt.name].push(a)
                    continue
                }

                unknownOptions.push(n)
                continue
            }

            if (opt.type === 'boolean') {
                options[opt.name] = true
                continue
            }

            if (i === args.length - 1) {
                errors.push([a, new Error(`Missing value`)])
                break
            }

            const arg = args[++i]
            if (arg.startsWith('-')) {
                // User probably forgot to add a value?
            }

            try {
                const parsed = await parseArg(arg, opt.type)
                if (opt.allowMultiple) {
                    const arr = options[opt.name] ??= []
                    arr.push(parsed)
                } else if (opt.name in options) {
                    errors.push([a, new Error('Duplicate option')])
                } else {
                    options[opt.name] = parsed
                }
            } catch (e) {
                errors.push([a, e as any])
            }
        } else {
            const currentArg = desc.args?.[argPosition]
            if (!currentArg) {
                if (passthroughOpt) {
                    options[passthroughOpt.name] ??= []
                    options[passthroughOpt.name].push(a)
                    continue
                }
                errors.push([a, new Error('Unknown argument')])
                continue
            }

            try {
                const parsed = await parseArg(a, currentArg.type)
                if (!currentArg.allowMultiple) {
                    argPosition += 1
                }
    
                parsedArgs.push(parsed)
            } catch (e) {
                invalidPositionalArgs += 1
                errors.push([a, e as any])
            }
        }
    }

    const providedArgs = parsedArgs.length + invalidPositionalArgs
    if (providedArgs < minArgs) {
        for (let i = providedArgs; i < minArgs; i++) {
            const a = desc.args![i]
            if (a.allowMultiple) break

            errors.push([a.name, new Error('Missing argument')])
        }

        if (allowMultipleArg?.minCount) {
            errors.push([
                allowMultipleArg.name, 
                new Error(`Requires at least ${allowMultipleArg.minCount} argument${allowMultipleArg.minCount > 1 ? 's' : ''}`)
            ])
        }
    }

    if (errors.length > 0) {
        throw new RenderableError('Invalid arguments', () => {
            for (const [n, e] of errors) {
                printLine(colorize('brightRed', `${e.message} - ${n}`))
            }
        })
    }

    const argCountWithOptional = desc.args?.filter(x => !x.allowMultiple).length ?? 0

    // Fill with default / `undefined`
    while (parsedArgs.length < argCountWithOptional) {
        const arg = desc.args?.[parsedArgs.length]
        const defaultValue = arg?.defaultValue
        if (typeof defaultValue === 'function') {
            parsedArgs.push(await defaultValue())
        } else {
            parsedArgs.push(defaultValue)
        }
    }

    return { args: parsedArgs, options }
}

function getEnvironmentName(params: string[]) {
    const environmentIndex = params.indexOf('--environment')
    if (environmentIndex !== -1) {
        return params[environmentIndex+1]
    }

    return process.env.SYNAPSE_ENV || undefined
}

async function getBuildTarget(cmd: CommandDescriptor, params: string[]) {
    const start = performance.now()
    const cwd = process.cwd()
    const environmentName = getEnvironmentName(params)
    const res = await resolveProgramBuildTarget(cwd, { environmentName })
    if (!res && cmd.inferBuildTarget) {
        const programFiles = params.filter(x => x.match(/\.tsx?$/))
        if (programFiles.length > 1) {
            throw new RenderableError('Failed to infer build target', () => {
                printLine(colorize('brightRed', 'Package-less builds with multiple files are not supported'))
                printLine()
                printLine('Create a `package.json` file in the root of your project first.')
                printLine('The file can contain an empty object: {}')
                // TODO: add link to docs on `package.json`

            })
        }

        return resolveProgramBuildTarget(cwd, { program: programFiles[0], environmentName })
    }

    getLogger().debug(`getBuildTarget() took ${Math.floor((performance.now() - start) * 1000) / 1000}ms`)

    return res
}

function getCommand(cmd: string) {
    const name = aliasedCommands.get(cmd) ?? cmd
    
    return registeredCommands.get(name)
}

export async function executeCommand(cmd: string, params: string[]) {
    const command = getCommand(cmd)
    if (!command) {
        throw new RenderableError(`Invalid command: ${cmd}`, () => didYouMean(cmd))
    }

    async function parseAndRun(command: RegisteredCommand) {
        const parsed = await runTask('parse', cmd, () => parseArgs(params, command.descriptor), 1)
        if (parsed.options.help) {
            return showHelp(command.name, command.descriptor)
        }

        const args = [...parsed.args, parsed.options]

        return runTask('run', cmd, () => command.fn(...args), 1)
    }

    if (command.descriptor.requirements?.program === false) {
        return parseAndRun(command)
    }

    const buildTarget = await getBuildTarget(command.descriptor, params)
    if (!buildTarget) {
        if (command.descriptor.requirements) {
            throw new RenderableError('No build target', () => {
                printLine(colorize('brightRed', 'No build target found'))
            })
        }
        getLogger().debug(`No build target found`)
    } else {
        getLogger().debug(`Using resolved build target`, buildTarget)
    }

    await runWithContext({ buildTarget }, () => parseAndRun(command))
}

function _inferCmdName() {
    const execName = path.basename(process.env['SYNAPSE_PATH'] || process.execPath)
    if (execName === 'node' || execName === 'node.exe') {
        return 'synapse'
    }

    const extLength = path.extname(execName).length
    return extLength ? execName.slice(0, -extLength) : execName
}

const inferCmdName = memoize(_inferCmdName)

export function renderCmdSuggestion(commandName: string, args: string[] = [], includeExec = true) {
    const parts = includeExec ? [inferCmdName(), commandName, ...args] : [commandName, ...args]

    return colorize('cyan', parts.join(' '))
}

export function removeInternalCommands() {
    for (const [k, v] of registeredCommands) {
        if (v.descriptor.internal) {
            registeredCommands.delete(k)
        }
    }
}
