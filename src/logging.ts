import * as perf from 'node:perf_hooks'
import { Event, EventEmitter, addMetaListener, createEvent, createEventEmitter } from './events'
import type { BuildTarget } from './workspaces'
import type { ParsedPlan } from './deploy/deployment'
import type { TfState } from './deploy/state'
import type { ResolvedProgramConfig } from './compiler/config'
import { getBuildTarget, getBuildTargetOrThrow, getExecutionId, isInContext } from './execution'
import { InstallLifecycleEvent, PackageProgressEvent } from './cli/views/install'
import { memoize } from './utils'

export interface PerfDetail {
    readonly taskType: string
    readonly taskName: string
    readonly slowThreshold?: number
    readonly aggregate?: boolean
}

const markCounts: Record<string, number> = {}
export function runTask<T>(type: string, name: string, task: () => T, slowThreshold?: number, aggregate?: boolean): T {
    const markName = `${type}-${name}`
    const detail: PerfDetail = { 
        taskType: type, 
        taskName: name,
        slowThreshold,
        aggregate,
    }

    const counts = markCounts[markName] = (markCounts[markName] ?? 0) + 1
    const id = `${markName}-${counts}`
    perf.performance.mark(id, { detail })

    const done = () => {
        perf.performance.measure(`${id}-end`, { start: id, detail })
        perf.performance.clearMarks(id)
    }

    const res = task()
    if (res instanceof Promise) {
        return res.finally(done) as any
    }

    done()

    return res
}

function createObserver(emit: OutputEventTrigger<PerfEvent>) {
    const aggregates: Record<string, number> = {}
    const obs = new perf.PerformanceObserver(items => {
        const measurements = items.getEntriesByType('measure')
        for (const m of measurements) {
            const detail = m.detail as PerfDetail
            if (detail.aggregate) {
                aggregates[detail.taskType] = (aggregates[detail.taskType] ?? 0) + m.duration
            } else {
                emit({ duration: m.duration, ...detail })
            }
        }
    
        perf.performance.clearMeasures()
    })

    process.on('exit', () => {
        for (const [k, v] of Object.entries(aggregates)) {
            emit({ duration: v, taskType: k, taskName: '', slowThreshold: 0 })
        }
    })

    obs.observe({ entryTypes: ['measure'] })

    return obs
}

export interface BaseOutputMessage {
    readonly type: string
    readonly timestamp: Date
    readonly context?: OutputContext

    // readonly system?: string
}

export interface CommandEvent extends BaseOutputMessage {
    readonly type: 'command'
    readonly action: string
    readonly status: 'started' | 'succeeded' | 'failed'
    readonly context: OutputContext
}

// Generic log event
export interface LogEvent extends BaseOutputMessage {
    readonly type: 'log'
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'raw'
    readonly args: any[]
}

export interface PerfEvent extends BaseOutputMessage {
    readonly type: 'perf'
    readonly taskType: string
    readonly taskName: string
    readonly duration: number
    readonly slowThreshold?: number
}

export interface OutputContext {
    readonly buildTarget: BuildTarget
    readonly executionId?: string
}

export function getOutputContext(): OutputContext | undefined {
    if (!isInContext()) {
        return
    }

    const buildTarget = getBuildTarget()
    if (!buildTarget) {
        return
    }

    return {
        buildTarget,
        executionId: getExecutionId(),
    }
}

// COMMON

export interface ResolveConfigEvent extends BaseOutputMessage {
    readonly type: 'resolve-config'
    readonly config: ResolvedProgramConfig
}

// DEPLOY

export type DeployStatus = 'refreshing' | 'pending' | 'applying' | 'complete' | 'failed'
export type DeployAction = 'create' | 'read' | 'update' | 'replace' | 'delete' | 'noop'

export interface DeployEvent extends BaseOutputMessage {
    readonly type: 'deploy'
    readonly status: DeployStatus
    readonly action: DeployAction
    readonly resource: string

    readonly state?: TfState['resources'][number] // Only relevant for `complete` statuses

    // waitingOn?: string[] // for pending states
}

export interface FailedDeployEvent extends DeployEvent {
    readonly type: 'deploy'
    readonly status: 'failed'
    readonly reason: string | Error
}

// Emitted right before a deploy 
export interface PlanEvent extends BaseOutputMessage {
    readonly type: 'plan'
    readonly plan: ParsedPlan
}

// Emitted right after a deploy
export interface DeploySummaryEvent extends BaseOutputMessage { 
    readonly type: 'deploy-summary'
    readonly add: number
    readonly change: number
    readonly remove: number
    readonly errors?: Error[]
}

// From custom resources
export interface DeployLogEvent extends BaseOutputMessage {
    readonly type: 'deploy-log'
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
    readonly args: any[]
    readonly resource: string
}

// COMPILE

// Emitted whenever a new template has been created
export interface CompileEvent extends BaseOutputMessage {
    readonly type: 'compile'
    readonly entrypoint: string
    readonly template: any
}


// Using `console` or `process.(stdout|stderr)` during synthesis will fire this event
export interface SynthLogEvent extends BaseOutputMessage {
    readonly type: 'synth-log'
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'raw'
    readonly source?: 'symEval'
    readonly args: any[]
}

// TESTS

export interface BaseTestEvent extends BaseOutputMessage {
    readonly type: 'test'
    readonly id: number
    readonly name: string
    readonly parentId?: number
    readonly context: OutputContext
    readonly itemType: 'test' | 'suite'
}

export interface PendingTestEvent extends BaseTestEvent {
    readonly status: 'pending'
}

export interface RunningTestEvent extends BaseTestEvent {
    readonly status: 'running'
}

export interface PassedTestEvent extends BaseTestEvent {
    readonly status: 'passed'
}

export interface FailedTestEvent extends BaseTestEvent {
    readonly status: 'failed'
    readonly reason: Error
}

export interface CachedTestEvent extends BaseTestEvent {
    readonly status: 'cached'
}

export type TestEvent = 
    | PendingTestEvent 
    | RunningTestEvent 
    | PassedTestEvent
    | FailedTestEvent
    | CachedTestEvent

export interface TestLogEvent extends BaseOutputMessage {
    readonly type: 'test-log'
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
    readonly args: any[]

    // Test info
    readonly id: number
    readonly name: string
    readonly parentId?: number
}

type OutputEvent = LogEvent | PerfEvent | DeployEvent | TestEvent | CommandEvent | CompileEvent
type OutputEventTrigger<T extends BaseOutputMessage> = (message: Omit<T, keyof BaseOutputMessage>) => void

const getSharedEmitter = memoize(createEventEmitter)

export type Logger = ReturnType<typeof createLogger>
function createLogger() {
    const emitter = createEventEmitter()
    const logEvent: OutputEventEmitter<LogEvent> = createOutputEvent(emitter, 'log')
    const perfEvent: OutputEventEmitter<PerfEvent> = createOutputEvent(emitter, 'perf')
    const deployEvent: OutputEventEmitter<DeployEvent | FailedDeployEvent> = createOutputEvent(emitter, 'deploy')
    const compileEvent: OutputEventEmitter<CompileEvent> = createOutputEvent(emitter, 'compile')
    const testEvent: OutputEventEmitter<TestEvent> = createOutputEvent(emitter, 'test')
    const commandEvent: OutputEventEmitter<CommandEvent> = createOutputEvent(emitter, 'command')

    const testLogEvent: OutputEventEmitter<TestLogEvent> = createOutputEvent(emitter, 'test-log')
    const synthLogEvent: OutputEventEmitter<SynthLogEvent> = createOutputEvent(emitter, 'synth-log')
    const deployLogEvent: OutputEventEmitter<DeployLogEvent> = createOutputEvent(emitter, 'deploy-log')

    const planEvent: OutputEventEmitter<PlanEvent> = createOutputEvent(emitter, 'plan')
    const deploySummaryEvent: OutputEventEmitter<DeploySummaryEvent> = createOutputEvent(emitter, 'deploy-summary')
    const resolveConfigEvent: OutputEventEmitter<ResolveConfigEvent> = createOutputEvent(emitter, 'resolve-config')

    const installEvent: OutputEventEmitter<InstallLifecycleEvent> = createOutputEvent(emitter, 'install-lifecycle')
    const packageProgressEvent: OutputEventEmitter<PackageProgressEvent> = createOutputEvent(emitter, 'install-package')

    let perfCount = 0
    let perfObs: ReturnType<typeof createObserver> | undefined
    addMetaListener(emitter, ev => {
        if (ev.eventName === 'perf') {
            perfCount += ev.mode === 'added' ? 1 : -1
        }

        if (perfCount === 0) {
            perfObs?.disconnect()
            perfObs = undefined
        } else if (!perfObs) {
            perfObs = createObserver(perfEvent.fire)
        }
    })

    return {
        log: (...args: any[]) => logEvent.fire({ level: 'info', args }),
        warn: (...args: any[]) => logEvent.fire({ level: 'warn', args }),
        error: (...args: any[]) => logEvent.fire({ level: 'error', args }),
        debug: (...args: any[]) => logEvent.fire({ level: 'debug', args }),
        trace: (...args: any[]) => logEvent.fire({ level: 'trace', args }),
        raw: (data: string | Uint8Array) => logEvent.fire({ level: 'raw', args: [data] }),

        emit: emitter.emit.bind(emitter),
        emitDeployEvent: deployEvent.fire,
        emitCompileEvent: compileEvent.fire,
        emitTestEvent: testEvent.fire,
        emitCommandEevent: commandEvent.fire,
        emitTestLogEvent: testLogEvent.fire,
        emitPlanEvent: planEvent.fire,
        emitDeploySummaryEvent: deploySummaryEvent.fire,
        emitResolveConfigEvent: resolveConfigEvent.fire,
        emitSynthLogEvent: synthLogEvent.fire,
        emitDeployLogEvent: deployLogEvent.fire,
        emitInstallEvent: installEvent.fire,
        emitPackageProgressEvent: packageProgressEvent.fire,

        onLog: logEvent.on,
        onPerf: perfEvent.on,
        onDeploy: deployEvent.on,
        onCompile: compileEvent.on,
        onTest: testEvent.on,
        onTestLog: testLogEvent.on,
        onCommand: commandEvent.on,
        onPlan: planEvent.on,
        onDeploySummary: deploySummaryEvent.on,
        onResolveConfig: resolveConfigEvent.on,
        onSynthLog: synthLogEvent.on,
        onDeployLog: deployLogEvent.on,
        onInstall: installEvent.on,
        onPackageProgress: packageProgressEvent.on,

        dipose: () => {
            emitter.removeAllListeners()
            perfObs?.disconnect()
        },
    }
}

let logger: Logger
export function getLogger() {
    return logger ??= createLogger()
}

export function createConsole(logger: Logger): typeof globalThis.console {
    return logger as any
}

export function listenAll(logger: Logger, listener: (ev: OutputEvent) => void) {
    const emitter = new EventEmitter()
    emitter.on('any', listener)

    function emit(ev: OutputEvent) {
        emitter.emit('any', ev)
    }

    const disposeables = [
        logger.onLog(emit),
        logger.onPerf(emit),
        logger.onDeploy(emit),
        logger.onCompile(emit),
        logger.onTest(emit),
        logger.onCommand(emit),
    ]

    return {
        dispose: () => {
            emitter.removeAllListeners()
            for (const d of disposeables) {
                d.dispose()
            }
        },
    }
}

type OutputEventEmitter<T extends BaseOutputMessage> = Omit<Event<[message: T]>, 'fire'> & { fire: OutputEventTrigger<T> }

function createOutputEvent<T extends BaseOutputMessage, U extends string>(emitter: EventEmitter, type: U): OutputEventEmitter<T> {
    const event = createEvent(emitter, type)

    return {
        on: event.on,
        fire: message => {
            const base: BaseOutputMessage = { 
                type, 
                timestamp: new Date(),
                context: getOutputContext(),
            }

            return event.fire(Object.assign(message, base))
        },
    }
}

export function getTypedEventEmitter<T extends BaseOutputMessage, U extends string = T['type']>(type: U): OutputEventEmitter<T> {
    return createOutputEvent(getSharedEmitter(), type)
}
