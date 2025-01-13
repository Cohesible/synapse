import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as child_process from 'node:child_process'
import { DeploymentContext, startService } from './server'
import { BuildTarget, LocalWorkspace, getProviderCacheDir, getBuildDir } from '../workspaces'
import type { TfJson } from '../runtime/modules/terraform'
import EventEmitter from 'node:events'
import { Logger, OutputContext, getLogger, runTask } from '../logging'
import { TemplateService } from '../templates'
import { isErrorLike, isWindows, keyedMemoize, memoize, sortRecord, strcmp } from '../utils'
import { LoadedBackendClient } from '../backendClient'
import { getFs } from '../execution'
import { TfState } from './state'
import { randomUUID } from 'node:crypto'
import { getFsFromHash, getDeploymentFs, getProgramFs, getProgramHash, getResourceProgramHashes, getTemplate, putState, setResourceProgramHashes } from '../artifacts'
import { runCommand } from '../utils/process'
import { readPathKey } from '../cli/config'
import { getDisplay, spinners } from '../cli/ui'
import { readDirRecursive } from '../system'

export interface DeployOptions {
    serverPort?: number
    workingDirectory?: string
    consoleLogger?: boolean | CustomLogger
    updateProviders?: boolean
    autoApprove?: boolean
    targetResources?: string[]
    targetFiles?: string[]
    replaceResource?: string | string[]
    parallelism?: number
    disableRefresh?: boolean
    terraformPath?: string
    useTests?: boolean
    target?: string
    sharedLib?: boolean

    // Persists a session for repeat deployments
    keepAlive?: boolean

    cpuProfile?: boolean

    skipCommit?: boolean

    sync?: boolean // For CI
    syncAfter?: boolean // For CI
    noSave?: boolean
    loadRegistry?: boolean

    // XXX
    /** @deprecated */
    workspaceConfig?: LocalWorkspace
    stateLocation?: string
}

type CustomLogger = (entry: TfJsonOutput) => void

export type DeploymentStatus = 'refreshing' | 'pending' | 'applying' | 'complete' | 'failed' | 'waiting'


export function mapResource(r: TfState['resources'][number] | undefined): typeof r {
    if (r && 'instances' in r) {
        return {
            ...r,
            state: (r as any).instances[0],
        }
    }

    return r
}

export function getSynapseResourceType(r: TfState['resources'][number] | undefined): string | undefined {
    if (r?.type !== 'synapse_resource') return

    return mapResource(r)?.state?.attributes.type
}

export function getSynapseResourceInput(r: TfState['resources'][number]): any {
    return mapResource(r)?.state.attributes.input.value
}

export function getSynapseResourceOutput(r: TfState['resources'][number]): any {
    return mapResource(r)?.state.attributes.output.value
}

function maybeExtractError(takeError: (requestId: string) => unknown | undefined, reason?: string) {
    const requestId = reason?.match(/x-synapse-request-id: ([\w]+)/)?.[1] // TODO: only need to check for this w/ custom resources
    if (!requestId) {
        return
    }

    const maybeError = takeError(requestId)
    if (isErrorLike(maybeError)) {
        return maybeError
    }  
}

function createInitView() {
    const view = getDisplay().getOverlayedView()
    const getRow = keyedMemoize((addr: string) => view.createRow(undefined, undefined, spinners.braille))

    function getProgressText(ev: InstallProviderEvent) {
        switch (ev.phase) {
            case 'downloading': {
                const downloaded = ev.downloaded ?? 0
                const size = ev.size
                const percentage = size !== undefined ? Math.floor((downloaded / size) * 100) : undefined

                return percentage !== undefined ? `${ev.phase} (${percentage}%)` : ev.phase
            }

        }

        return ev.phase
    }

    function handleEvent(ev: InstallProviderEvent) {
        if (ev.phase === 'complete' || ev.error) {
            return getRow(ev.address).destroy()
        }

        const label = `${ev.name}-${ev.version}`

        getRow(ev.address).update(`${label}: ${getProgressText(ev)}`)
    }

    function dispose() {

    }

    return { handleEvent, dispose }
}

export async function createZip(files: Record<string, string>, dest: string) {
    const tfPath = await getTerraformPath()
    const req: string[] = [dest, ...Object.entries(files).sort((a, b) => strcmp(a[0], b[0]))].flat()
    await runCommand(tfPath, ['zip'], { input: req.join('\n') })
}

export async function createZipFromDir(dir: string, dest: string, includeDir = false) {
    const tfPath = await getTerraformPath()
    const files = await readDirRecursive(getFs(), dir)
    if (includeDir) {
        const base = path.basename(dir)
        const filesWithDir: Record<string, string> = {}
        for (const [k, v] of Object.entries(files)) {
            filesWithDir[path.join(base, k)] = v
        }
        const req: string[] = [dest, ...Object.entries(filesWithDir).sort((a, b) => strcmp(a[0], b[0]))].flat()
        await runCommand(tfPath, ['zip'], { input: req.join('\n') })
    } else {
        const req: string[] = [dest, ...Object.entries(files).sort((a, b) => strcmp(a[0], b[0]))].flat()
        await runCommand(tfPath, ['zip'], { input: req.join('\n') })
    }
}

function createTerraformLogger(
    takeError?: (requestId: string) => unknown | undefined,
    logger: Pick<Logger, 'debug' | 'error' | 'emitDeployEvent' | 'emitPlanEvent' | 'emitDeploySummaryEvent'> = getLogger(),
    onDiagnostic?: (diag: Error | TfDiagnostic) => void,
): CustomLogger {
    // We don't want to bubble up diagnostics that are handled somewhere else
    const handledDiags = new Set<string>() // This is a memory leak

    const getInitView = memoize(createInitView)

    return function (entry) {
        switch (entry.type) {
            case 'change_summary': {
                logger.debug(`Change summary:`, entry.changes)
                if (entry.changes.operation === 'apply') {
                    logger.emitDeploySummaryEvent(entry.changes)
                }
                break
            }
            case 'resource_drift': {
                logger.debug(`Resource drift:`, entry.change.resource.addr)
                break
            }
            case 'planned_change': {
                const resource = entry.change.resource
                logger.debug(`Planned change (${entry.change.action}): ${resource.resource}`)

                // TODO: remove `move` ?
                if (entry.change.action !== 'move') {
                    logger.emitDeployEvent({
                        action: entry.change.action, 
                        resource: resource.resource,
                        status: 'pending',
                    })
                }

                break
            }
            case 'apply_start': {
                const resource = entry.hook.resource
                // TODO: track how much time Terraform is spending w/ serialized data

                logger.debug(`Applying configuration (${entry.hook.action}): ${resource.resource}`)

                logger.emitDeployEvent({
                    action: entry.hook.action,
                    resource: resource.resource,
                    status: 'applying',
                })

                break
            }
            case 'apply_progress': {
                const resource = entry.hook.resource
                logger.debug(`Still applying configuration (${entry.hook.action}) [${entry.hook.elapsed_seconds}s elapsed]: ${resource.resource}`)

                break
            }
            case 'apply_complete': {
                const resource = entry.hook.resource
                // TODO: track how much time Terraform is spending w/ serialized data

                logger.debug(`Finished applying: ${resource.resource}`)

                logger.emitDeployEvent({
                    action: entry.hook.action,
                    resource: resource.resource,
                    status: 'complete',
                    state: entry.hook.state,
                })

                break
            }
            case 'apply_errored': {
                const resource = entry.hook.resource
                logger.debug(`Failed to ${entry.hook.action}: ${resource.resource}`)

                const reason = entry.hook.reason

                if (takeError) {
                    const maybeError = maybeExtractError(takeError, reason)
                    if (maybeError) {
                        handledDiags.add(reason!)
                        onDiagnostic?.(maybeError)

                        return logger.emitDeployEvent({
                            action: entry.hook.action,
                            resource: resource.resource,
                            status: 'failed',
                            reason: maybeError as Error,
                        } as any)
                    }
                }

                logger.emitDeployEvent({
                    action: entry.hook.action,
                    resource: resource.resource,
                    status: 'failed',
                    reason: entry.hook.reason,
                } as any)

                break
            }
            case 'refresh_start': {
                const resource = entry.hook.resource
                logger.debug(`Refreshing: ${resource.resource}`)

                logger.emitDeployEvent({
                    action: 'read',
                    resource: resource.resource,
                    status: 'refreshing',
                })

                break
            }
            case 'refresh_complete': {
                const resource = entry.hook.resource
                logger.debug(`Finished refreshing: ${resource.resource}`)

                logger.emitDeployEvent({
                    action: 'read',
                    resource: resource.resource,
                    status: 'complete',
                })

                break
            }
            case 'diagnostic': {
                const diags = entry.diagnostic ? [entry.diagnostic] : entry.diagnostics!
                for (const diag of diags) {
                    if (onDiagnostic && diag.severity === 'error') {
                        if (!handledDiags.has(diag.summary)) {
                            const err = takeError ? maybeExtractError(takeError, diag.summary) : undefined
                            onDiagnostic(err ?? diag)
                        }
                    } else {
                        logger.debug('Diagnostics:', diag.summary)
    
                        if (diag.detail) {
                            logger.debug('Diagnostics (detail):', diag.detail)
                        }
                    }
                }

                break
            }
            case 'error':
                logger.error(`TF error:`, entry.data)
                break
            case 'plan':
                const plan = parsePlan(entry.data)
                logger.emitPlanEvent({ plan })
                break
            case 'install_provider':
                getInitView().handleEvent(entry.hook)
                break
            default:
                if ((entry as any).type === 'version') {
                    logger.debug(`Running terraform (version: ${(entry as any).terraform})`)
                } else {
                    logger.debug('Unknown', JSON.stringify(entry, undefined, 4))
                }
        }
    }
}

async function lockFileExists(dir: string) {
    try {
        await fs.readFile(path.resolve(dir, '.terraform.lock.hcl'))
        return true
    } catch (e) {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
        return false
    }
}

export type TerraformSession = Awaited<ReturnType<typeof startTerraformSession>>

interface DeployResult {
    readonly error?: Error
    readonly state: TfState
}

type TfExp = { type: 'property', value: string } | { type: 'element', value: number }
export interface TfRef {
    readonly subject: string
    readonly expressions: TfExp[]
}

export interface BoundTerraformSession {
    plan: (opt?: DeployOptions) => Promise<ParsedPlan>
    apply: (opt?: DeployOptions) => Promise<DeployResult>
    destroy: (opt?: DeployOptions) => Promise<DeployResult>
    getState: () => Promise<TfState | undefined>
    getRefs: (targets: string[]) => Promise<Record<string, TfRef[]>>
    setTemplate: (template: TfJson) => Promise<void> // XXX: this is kind of a hack
    importResource: (target: string, id: string) => Promise<DeployResult>
    dispose: () => Promise<void>
    readonly templateService: TemplateService
    readonly moduleLoader: ReturnType<DeploymentContext['createModuleLoader']>
}

export interface SessionContext extends DeploymentContext {
    readonly buildTarget: BuildTarget & { programHash?: string }
    readonly templateService: TemplateService
    readonly backendClient: LoadedBackendClient
    readonly terraformPath: string
}

class TfError extends Error {
    public constructor(summary: string, public readonly detail?: string, public readonly range?: TfDiagnostic['range']) {
        super(detail ? `${summary}: ${detail}` : summary)

        // if (range) {
        //     getSnippet(this).then(m => process.stderr.write(`${m}\n`))
        // }
    }
}

async function getSnippet(err: TfError, context = 25) {
    if (!err.range) return

    const rawTemplate = await getProgramFs().readFile('template.json', 'utf-8')
    const source = rawTemplate.slice(err.range.start.column - 1 - context, err.range.end.column - 1 + context)

    return source
}

export class SessionError extends AggregateError {}

// {"@level":"error","@message":"Error: Inconsistent dependency lock file","@module":"terraform.ui","@timestamp":"2024-03-29T16:55:58.216044-07:00","diagnostic":{"severity":"error","summary":"Inconsistent dependency lock file","detail":"The following dependency selections recorded in the lock file are inconsistent with the current configuration:\n  - provider registry.terraform.io/hashicorp/aws: required by this configuration but no version is selected\n\nTo make the initial dependency selections that will initialize the dependency lock file, run:\n  terraform init"},"type":"diagnostic"}

export async function startTerraformSession(
    context: SessionContext,
    args: string[] = [], 
    opt?: DeployOptions,
) {
    const diags: (Error | TfDiagnostic)[] = []
    const templateFile = await context.templateService.getTemplateFilePath()
    const templateDir = path.dirname(templateFile)
    const server = await startService(context, context.buildTarget.workingDirectory, opt?.serverPort, templateDir)
    const logger = createTerraformLogger(server.takeError, undefined, d => diags.push(d))

    function mapDiag(d: Error | TfDiagnostic) {
        if (isErrorLike(d)) {
            return d
        }

        return new TfError(d.summary, d.detail, d.range)
    }

    function checkDiags() {
        if (diags.length === 0) {
            return
        }

        if (diags.length === 1) {
            const err = mapDiag(diags[0])
            diags.length = 0
            throw err
        }

        const err = new SessionError(diags!.map(mapDiag), `Operation failed`)
        diags.length = 0
        throw err
    }

    const dataDir = path.resolve(templateDir, 'data')
    await getFs().link(context.dataDir, dataDir, { 
        symbolic: true, 
        typeHint: isWindows() ? 'junction' : 'dir',
        overwrite: false,
    })

    const env = {
        ...process.env,
        TF_SYNAPSE_PROVIDER_ENDPOINT: `http://localhost:${server.port}`,
        TF_SYNAPSE_PROVIDER_WORKING_DIRECTORY: context.buildTarget.workingDirectory,
        // TF_SYNAPSE_PROVIDER_OUTPUT_DIR: '',
        // TF_SYNAPSE_PROVIDER_BUILD_DIR: '',

        TF_PLUGIN_CACHE_DIR: getProviderCacheDir(),
        TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: '1',
    
        TF_AWS_GLOBAL_TIME_MODIFIER: '0.25',
        // TF_LOG: 'TRACE',
    }

    const resolvedArgs = ['start-session', ...args, '-json']

    if (opt?.cpuProfile) {
        resolvedArgs.push('-cpu-profile', `terraform.prof`)
    }

    const c = child_process.spawn(context.terraformPath, resolvedArgs, {
        cwd: path.dirname(templateFile),
        stdio: 'pipe',
        env,
    })

    let didExit = false
    let isReady = false
    const stateEmitter = new EventEmitter()

    c.on('exit', (code, signal) => {
        didExit = true
        server.dispose()

        const err = new Error(`Failed to start session (exit code: ${code})`)
        stateEmitter.emit('ready', err)
        stateEmitter.emit('result', undefined, err)
    })

    function waitForReady() {
        if (isReady) {
            return Promise.resolve()
        }

        return new Promise<void>((resolve, reject) => {
            stateEmitter.once('ready', (err?: Error) => err ? reject(err) : resolve())
        }).finally(checkDiags)
    }

    function waitForResult<T = undefined>() {
        return new Promise<T>((resolve, reject) => {
            stateEmitter.once('result', (data?: any, err?: Error) => err ? reject(err) : resolve(data))
        }).finally(checkDiags)
    }

    function waitForPlan(): Promise<Omit<TfPlan, 'prior_state'>> {
        return new Promise((resolve, reject) => {
            // TODO: listen for `error` events
            stateEmitter.once('plan', (data?: any, err?: Error) => err ? reject(err) : resolve(data))
        })
    }

    let buffer = ''
    function onData(d: Buffer) {
        const lines = (buffer + d).split('\n')
        buffer = lines.pop() ?? ''

        for (const l of lines) {
            try {
                const msg = JSON.parse(l) as TfJsonOutput | { type: 'ready' } // TODO: remove `ready` and just use `result`

                if (msg.type === 'ready') {
                    isReady = true
                    stateEmitter.emit('ready')
                    stateEmitter.emit('result', undefined, undefined)
                } else if (msg.type === 'result') {
                    stateEmitter.emit('result', msg.data)
                } else {
                    logger(msg)
                    if (msg.type === 'plan') {
                        stateEmitter.emit('plan', msg.data)
                    } else if (msg.type === 'change_summary' && stateEmitter.listenerCount('plan')) {
                        const total = msg.changes.add + msg.changes.remove + msg.changes.change + msg.changes.import
                        if (total === 0) {
                            stateEmitter.emit('plan', {})
                        }
                    }
                }
            } catch (e) {
                // Failure is due to non-JSON data
                const err = new Error('Bad parse', { cause: e })
                getLogger().debug(err)

                // TODO: this should fail early in test builds
                // stateEmitter.emit('ready', err)
                // stateEmitter.emit('result', undefined, err)
            }
        }
    }

    function onAbort() {
        getLogger().debug('sending SIGINT to deploy session')
        c.kill('SIGINT')
    }

    context.abortSignal?.addEventListener('abort', onAbort)

    function dispose() {
        context.abortSignal?.removeEventListener('abort', onAbort)
        if (didExit) {
            return
        }

        return write('exit\n')
    }

    c.stdout.on('data', onData)
    c.stderr.on('data', d => getLogger().raw(d))

    function write(chunk: string | Buffer) {
        return new Promise<void>((resolve, reject) => {
            c.stdin.write(chunk, err => err ? reject(err) : resolve())
        })
    }

    await waitForReady()

    const init = async () => {
        isReady = false
        await write(`${['init'].join(' ')}\n`)

        return waitForReady()
    }

    async function needsInit() {
        const tfDir = path.dirname(templateFile)
        const cacheDir = getProviderCacheDir()
        const stateFile = path.resolve(tfDir, '.terraform', 'terraform.tfstate')

        const [hasPluginCache, hasLockFile, hasStateFile] = await Promise.all([
            getFs().fileExists(cacheDir),
            lockFileExists(tfDir),
            getFs().fileExists(stateFile),
        ])

        if (!hasPluginCache) {
            await fs.mkdir(cacheDir, { recursive: true })
            if (hasStateFile) {
                getLogger().warn(`Provider cache is missing but state file exists. Deleting previously installed providers.`)
                await getFs().deleteFile(path.dirname(stateFile))
            }

            return true
        }

        return !hasLockFile || !hasStateFile
    }

    await runTask('init', 'terraform', async () => {
        if (await needsInit()) {
            getLogger().log(`Initializing providers`)
            await init()
        } 
    }, 10)

    return {
        apply: async (opt?: DeployOptions) => {
            isReady = false
            await write(`${['apply', ...getDeployOptionsArgs(opt)].join(' ')}\n`)

            return waitForResult()
        },
        destroy: async (opt?: DeployOptions) => {
            isReady = false
            await write(`${['apply', '-destroy', ...getDeployOptionsArgs(opt)].join(' ')}\n`)

            return waitForReady()
        },
        plan: async (opt?: DeployOptions) => {
            isReady = false
            const result = waitForPlan()
            await write(`${['plan', ...getDeployOptionsArgs(opt)].join(' ')}\n`)
            await waitForReady()

            return result
        },
        reloadConfig: async () => {
            isReady = false
            await write(`${['reload-config'].join(' ')}\n`)

            return waitForReady()
        },
        getState: async () => {
            isReady = false
            const result = waitForResult<TfState>()
            await write(`${['get-state'].join(' ')}\n`)
            await waitForReady()

            return result
        },
        setState: async (fileName: string) => {
            isReady = false
            await write(`${['set-state', fileName].join(' ')}\n`)

            return waitForReady()
        },
        getRefs: async (targets: string[]) => {
            isReady = false
            const result = waitForResult<Record<string, TfRef[]>>()
            await write(`${['get-refs', ...targets].join(' ')}\n`)
            await waitForReady()

            return result
        },
        importResource: async (target: string, id: string) => {
            isReady = false
            await write(`${['import', target, id].join(' ')}\n`)

            return waitForReady()
        },
        dispose,
        isAlive: () => !didExit,
    }
}

function getDeployOptionsArgs(opt: DeployOptions | undefined) {
    const args: string[] = []
    if (!opt) {
        return args
    }

    if (opt.parallelism) {
        args.push(`-parallelism=${opt.parallelism}`)
    }

    if (opt.disableRefresh) {
        args.push('-refresh=false')
    }

    if (opt.useTests) {
        args.push('-use-tests')
    }

    if (opt.autoApprove) {
        args.push('-auto-approve')
    }

    function addMultiValuedSwitch(switchName: string, val: string | string[]) {
        if (!Array.isArray(val)) {
            args.push(`-${switchName}=${val}`)

            return
        }

        for (const r of val) {
            args.push(`-${switchName}=${r}`)
        }
    }

    if (opt.targetResources) {
        addMultiValuedSwitch('target', opt.targetResources)
    }

    if (opt.targetFiles) {
        addMultiValuedSwitch('module', opt.targetFiles)
    }

    if (opt.replaceResource) {
        addMultiValuedSwitch('replace', opt.replaceResource)
    }

    return args
}

interface TerraformVersion {
    readonly version: string
    readonly platform: string //"darwin_arm64",
    // "provider_selections": {
    //  "registry.terraform.io/hashicorp/test1": "7.8.9-beta.2",
    //  "registry.terraform.io/hashicorp/test2": "1.2.3"
    //}
}

async function getTerraformVersion(tfPath: string) {
    const stdout = await runCommand(tfPath, ['-v', '-json'])
    const parsed = JSON.parse(stdout)
    if ('terraform_version' in parsed) {
        throw new Error(`Binary is not compatible with Synapse`)
    }

    if (typeof parsed.version !== 'string' || typeof parsed.platform !== 'string') {
        throw new Error('Bad output format')
    }

    return parsed
}

export interface TfStateResource {
    // mode: 'managed'
    readonly type: string
    readonly name: string
    readonly provider: string
    readonly values: Record<string, any>
}

// TODO: after successful destroy, delete these files
// .terraform/terraform.tfstate
// .terraform.lock.hcl

interface TfJsonOutputBase {
    '@level': 'info' | 'warn' | 'error'
    '@message': string
    '@module': string // always `terraform.ui`
    '@timestamp': string // RFC3339
} 

type TfAction = 'create' | 'read' | 'update' | 'replace' | 'delete' // | 'noop' | 

interface TfLog extends TfJsonOutputBase {
    type: 'log'
}

interface TfResult extends TfJsonOutputBase {
    type: 'result'
    data: any
}

interface TfChangeSummary extends TfJsonOutputBase {
    type: 'change_summary'
    changes: {
        add: number
        change: number
        import: number
        remove: number
        operation: 'plan' | 'apply' | 'destroy' // Not sure if these are correct
    }
}

interface TfResourceDrift extends TfJsonOutputBase {
    type: 'resource_drift'
    change: {
        resource: TfResource,
        action: 'update' // ???
    }
}

// This message does not include details about the exact changes which caused the change to be planned.
// That information is available in the JSON plan output.
interface TfPlannedChange extends TfJsonOutputBase {
    type: 'planned_change'
    change: {
        resource: TfResource
        previous_resource?: TfResource
        action: TfAction | 'move'
        reason?: 'tainted' | 'requested' | 'cannot_update' | 'delete_because_no_resource_config' | 'delete_because_wrong_repetition' | 'delete_because_count_index' | 'delete_because_each_key' | 'delete_because_no_module'
    }
}

interface TfRefreshStart extends TfJsonOutputBase {
    type: 'refresh_start'
    hook: {
        resource: TfResource
        id_key: string
        id_value: string
    }
}

interface TfRefreshComplete extends TfJsonOutputBase {
    type: 'refresh_complete'
    hook: {
        resource: TfResource
        id_key: string
        id_value: string
    }
}

interface TfApplyStart extends TfJsonOutputBase {
    type: 'apply_start'
    hook: {
        action: TfAction
        resource: TfResource
        id_key?: string
        id_value?: string // maybe string
    }
}

interface TfApplyProgress extends TfJsonOutputBase {
    type: 'apply_progress'
    hook: {
        action: TfAction
        resource: TfResource
        id_key?: string
        id_value?: unknown
        elapsed_seconds: number
    }
}

interface TfApplyComplete extends TfJsonOutputBase {
    type: 'apply_complete'
    hook: {
        action: TfAction
        resource: TfResource
        id_key?: string
        id_value?: unknown
        elapsed_seconds: number
        state?: TfState['resources'][number]
    }
}
  
interface TfResource {
    addr: string
    module: string
    resource: string
    resource_type: string
    resource_name: string
    resource_key: string | null
    implied_provider: string
}

// Error is rendered as a diagnostic...
interface TfApplyErrored extends TfJsonOutputBase {
    type: 'apply_errored'
    hook: {
        action: TfAction
        resource: TfResource
        id_key?: string
        id_value?: unknown
        elapsed_seconds: number
        reason?: string
    }
}

interface TfDiagnostic {
    severity: 'warning' | 'error'
    summary: string
    detail?: string
    range?: {
        filename: string
        start: TfPosition // inclusive
        end: TfPosition // exclusive
    },
    snippet?: {
        context?: string
        code: string
        start_line: number
        highlight_start_offset: number
        highlight_end_offset: number
        values: {
            traversal: string
            statement: string
        }[]
    }
}

interface TfDiagnosticOutput extends TfJsonOutputBase {
    type: 'diagnostic'
    valid: boolean
    error_count: number
    warning_count: number
    diagnostic?: TfDiagnostic
    diagnostics?: TfDiagnostic[]
}

interface InstallProviderEvent {
    address: string
    name: string
    version: string
    size?: number
    downloaded?: number
    phase?: 'downloading' | 'verifying' | 'extracting' | 'complete'
    error?: string
}

interface TfInstallProvider extends TfJsonOutputBase {
    type: 'install_provider'
    hook: InstallProviderEvent
}

interface TfPosition {
    byte: number
    line: number
    column: number
}

interface TfErrorOutput extends TfJsonOutputBase {
    type: 'error'
    data: string
}

interface TfPlanOutput extends TfJsonOutputBase {
    type: 'plan'
    data: Omit<TfPlan, 'prior_state'>
}

type TfJsonOutput =
    | TfLog
    | TfResult
    | TfPlanOutput
    | TfErrorOutput
    | TfChangeSummary
    | TfResourceDrift
    | TfPlannedChange 
    | TfRefreshStart 
    | TfRefreshComplete 
    | TfApplyStart
    | TfApplyProgress
    | TfApplyComplete
    | TfApplyErrored
    | TfInstallProvider
    | TfDiagnosticOutput

// https://developer.hashicorp.com/terraform/internals/json-format#plan-representation
type ActionReason = 
    | 'read_because_config_unknown'
    | 'delete_because_no_resource_config'
    | 'replace_by_triggers'
    | 'replace_because_cannot_update'

interface TfPlan {
    prior_state?: { 
        format_version: string // ??? not sure
        terraform_version: string
        values: {
            root_module: {
                resources: {
                    address: string
                    type: string
                    name: string
                    values: Record<string, any>
                    depends_on?: string[]
                }[]
            }
        }
    }
    resource_changes?: {
        readonly type: string
        readonly name: string
        readonly action_reason: ActionReason
        readonly change: TfResourceChange
    }[]
    relevant_attributes?: {
        readonly resource: string
        readonly attribute: string[]
    }[]
}

interface TfResourceChange {
    readonly actions: ('no-op' | 'create' | 'read' | 'update' | 'delete')[]

    // These are only provided when requesting a "full" plan
    readonly before?: any
    readonly after?: any
    readonly after_unknown?: TfResourceChange['after'] // But with booleans
    readonly replace_paths?: string[][]
}

function filterNoise(plan: TfPlan) {
    const filtered = plan.resource_changes?.filter(r => {
        if (r.change.actions.length === 1 && ['no-op', 'read'].includes(r.change.actions[0])) {
            return false
        }

        return true
    })

    return { ...plan, resource_changes: filtered }
}

const unknown = Symbol.for('tfUnknown')

function mergeUnknowns(val1: any, val2: any): any {
    if (val2 === true) {
        return unknown
    }

    if (Array.isArray(val1)) {
        if (!Array.isArray(val2)) {
            throw new Error(`Expected arrays: ${val1} -> ${val2}`)
        }

        return val1.map((x, i) => mergeUnknowns(x, val2[i]))
    }

    if (typeof val1 === 'object' && typeof val2 === 'object' && val1 !== null && val2 !== null) {
        const res: Record<string, any> = {}
        const keys = new Set([...Object.keys(val1), ...Object.keys(val2)])
        for (const k of keys) {
            const v1 = val1[k]
            const v2 = val2[k]
            if (v2 === undefined) {
                res[k] = v1
            } else {
                res[k] = mergeUnknowns(v1, v2)
            }
        }

        return res
    }


    return val1
}

// ASSUMES KEYS ARE ALREADY SORTED
function diff(val1: any, val2: any): any {
    if (val1 === val2) {
        return
    }

    if (typeof val1 !== typeof val2 || typeof val1 !== 'object' || val1 === null || val2 === null) {
        return { from: val1, to: val2 }
    }

    if (Array.isArray(val1)) {
        if (!Array.isArray(val2)) {
            throw new Error(`Expected arrays: ${val1} -> ${val2}`)
        }

        const length = Math.max(val1.length, val2.length)
        const res: any[] = []
        for (let i = 0; i < length; i++) {
            const v1 = i >= val1.length ? null : val1[i]
            const v2 = i >= val2.length ? null : val2[i]
            const d = diff(v1, v2)
            res.push(d)
        }

        if (res.filter(x => x !== undefined).length !== 0) {
            return res
        }

        return undefined
    }

    const res: Record<string, any> = {}
    const keys = new Set([...Object.keys(val1), ...Object.keys(val2)])
    for (const k of keys) {
        if (val2[k] === undefined) continue

        const d = diff(val1[k], val2[k])
        if (d !== undefined) {
            res[k] = d
        }
    }

    if (Object.keys(res).length > 0) {
        return res
    }
}

interface ResourcePlan {
    readonly change: TfResourceChange
    readonly reason?: ActionReason
    readonly attributes?: string[][]
    readonly state?: any
}

export function getChangeType(change: TfResourceChange): 'create' | 'update' | 'replace' | 'delete' | 'read' | 'no-op' {
    if (change.actions.length === 1) {
        return change.actions[0]
    }

    if (change.actions[0] === 'create' && change.actions[1] === 'delete') {
        return 'replace'
    }

    if (change.actions[0] === 'delete' && change.actions[1] === 'create') {
        return 'replace'
    }

    throw new Error(`Unknown change action set: ${change.actions.join(', ')}`)
}

export function isTriggeredReplaced(plan: ResourcePlan) {
    if (getChangeType(plan.change) !== 'replace') {
        return false
    }

    return plan.reason === 'replace_by_triggers'
}

export function getDiff(change: TfResourceChange): any {
    if (change.before === undefined && change.after === undefined) {
        return
    }

    return diff(change.before, mergeUnknowns(change.after ?? {}, change.after_unknown))
}

export type ParsedPlan = Record<string, ResourcePlan>
export function parsePlan(plan: Omit<TfPlan, 'prior_state'>, state?: Record<string, any>): ParsedPlan {
    const resources = plan.resource_changes ?? []
    const relevantAttributes: Record<string, string[][]> = {}
    if (plan.relevant_attributes) {
        for (const o of plan.relevant_attributes) {
            const arr = relevantAttributes[o.resource] ??= []
            arr.push(o.attribute)
        }
    }

    return Object.fromEntries(
        resources.map(
            r => [`${r.type}.${r.name}`, {
                change: r.change,
                reason: r.action_reason,
                attributes: relevantAttributes[`${r.type}.${r.name}`],
                state: state?.[`${r.type}.${r.name}`],
            }] as const
        )
    )
}

export function renderPlan(plan: TfPlan) {
    const filtered = filterNoise(plan)
    const values = filtered.prior_state?.values
    const states = values ? Object.fromEntries(values.root_module.resources.map(r => [r.address, r])) : undefined

    return parsePlan(filtered, states)
}

export async function getTerraformPath() {
    // This is configured on installation.
    const configuredPath = await readPathKey('terraform.path')
    if (configuredPath) {
        return configuredPath
    }

    throw new Error(`Missing binary. Corrupted installation?`)
}

// We mutate the state object directly
export function createStatePersister(currentState: TfState | undefined, programHash: string, procFs = getDeploymentFs()) {
    const getLineage = memoize(() => currentState?.lineage ?? randomUUID())
    const getNextSerial = memoize(() => (currentState?.serial ?? 0) + 1)

    function createStateFile(resources: TfState['resources']): TfState {
        const version = resources.length === 0 
            ? (currentState?.version ?? 4)
            : resources[0].state ? 5 : 4

        return {
            version,
            serial: getNextSerial(),
            lineage: getLineage(),
            resources,
        }
    }

    // These hashes are used for incremental deploys
    const resourceHashes: Record<string, string | null> = {}
    const stateMap: Record<string, TfState['resources'][number]> = {}
    if (currentState) {
        for (const r of currentState.resources) {
            stateMap[`${r.type}.${r.name}`] = r
        }
    }

    const getPreviousHashes = memoize(() => getResourceProgramHashes(procFs))

    async function saveHashes() {
        const previous = await getPreviousHashes()
        const merged = sortRecord({ ...previous, ...resourceHashes })
        for (const [k, v] of Object.entries(merged)) {
            if (v === null) {
                delete merged[k]
            }
        }
        await setResourceProgramHashes(procFs, merged as Record<string, string>)
    }

    // FIXME: this should write out to a separate backup file in addition to the normal flow
    async function _saveState() {
        await Promise.all([
            saveHashes(),
            putState(createStateFile(Object.values(stateMap)), procFs),
        ])
    }

    let writeTimer: number | undefined
    let pendingSave: Promise<unknown> | undefined
    function saveState() {
        return pendingSave ??= _saveState().finally(() => pendingSave = undefined)
    }

    function triggerSave() {
        clearTimeout(writeTimer)
        writeTimer = +setTimeout(async () => {
            await pendingSave
            await saveState()
        }, 10)
    }

    function updateResource(id: string, instanceState?: TfState['resources'][number]) {
        if (!instanceState) {
            delete stateMap[id]
        } else {
            stateMap[id] = instanceState
        }

        triggerSave()
    }

    const l = getLogger().onDeploy(ev => {
        if (ev.action === 'noop') {
            resourceHashes[ev.resource] = programHash
        }
        if (ev.status !== 'complete' || ev.resource.startsWith('data.')) return

        if (ev.action !== 'read' && ev.action !== 'noop') {
            updateResource(ev.resource, ev.state)
        }

        if (ev.action !== 'read') {
            if (ev.action === 'delete') {
                resourceHashes[ev.resource] = null
            } else {
                resourceHashes[ev.resource] = programHash
            }
        }
    })

    const l2 = getLogger().onPlan(ev => {
        let needsSave = false
        for (const [k, v] of Object.entries(ev.plan)) {
            if (k.startsWith('data.')) continue

            const change = getChangeType(v.change)
            if (change === 'no-op') {
                resourceHashes[k] = programHash
                needsSave = true
            }
        }

        if (needsSave) {
            triggerSave()
        }
    })

    async function dispose() {
        l.dispose()
        l2.dispose()
        clearTimeout(writeTimer)

        if (writeTimer && !pendingSave) {
            await saveState()
        } else {
            await pendingSave
        }
    }

    return { getLineage, getNextSerial, dispose }
}