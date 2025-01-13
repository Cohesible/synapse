import * as core from 'synapse:core'
import * as crypto from 'node:crypto'
import * as http from 'synapse:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpService } from 'synapse:srl/compute'
import { Table, Queue } from 'synapse:srl/storage'

interface CheckpointInfo {
    readonly id: string
    // TODO: this will be used to map back to the fn
    // readonly resourceId: string
    readonly handler: (...args: any[]) => any
    readonly options: CheckpointOptions
}

function toMilliseconds(unit: string) {
    switch (unit) {
        case 's':
        case 'second':
            return 1000
        case 'm':
        case 'minute':
            return 1000 * 1000
        case 'h':
        case 'hour':
            return 1000 * 1000 * 1000

        default:
            throw new Error(`Invalid time unit: ${unit}`)
    }
}

// We always parse into milliseconds
function parseTime(s: string) {
    const m = s.match(/^([0-9]+) (second|minute|hour)s?$/)
    if (m) {
        return Number(m[1]) * toMilliseconds(m[2]) 
    }

    const m2 = s.match(/^([0-9]+)(s|m|h)$/)
    if (!m2) {
        throw new Error(`Failed to parse time: ${s}`)
    }

    return Number(m2[1]) * toMilliseconds(m2[2]) 
}

interface RetryPolicy {
    initialInterval: string
    maximumInterval: string
    backoffCoefficient?: number     // default: 2
    maximumAttempts?: number        // default: 3

    // `nonRetryableErrors` would be a better name
    nonRetryableErrorTypes?: string[]
}

export interface CheckpointOptions {
    // temporal.io options
    retry?: RetryPolicy
    startToCloseTimeout?: string
}

function wrapHandler(fn: (...args: any[]) => any, info: CheckpointInfo) {
    async function handler(...args: any[]): Promise<any> {
        throw new Error('Not called inside of a workflow')
    }

    return Object.assign(handler, { [checkpointSym]: info })
}

const checkpointSym = Symbol.for('synapse.checkpoint')

export function checkpoint<T extends any[], U>(fn: (...args: T) => Promise<U> | U, opt?: CheckpointOptions): (...args: T) => Promise<U> {
    const id = new CheckpointId()

    return wrapHandler(fn, {
        id: id.value,
        // resourceId: core.getResourceId(id)!,
        handler: fn,
        options: opt ?? {},
    })
}

// We generate an id that is independent from the logical code id
//
// This gives us more flexibility for decoupling code changes from how
// checkpointed states are tracked. The compiler will help us prevent
// drift during code changes.
class CheckpointId extends core.defineResource({
    create: () => {
        return { value: crypto.randomUUID() }
    },
    update: state => state,
}) {}

interface Host {
    bind<T extends any[], U>(handler: (...args: T) => Promise<U> | U): (...args: T) => Promise<U> | U
}

const moveable = Symbol.for('__moveable__')
const boundFunctions = new Map<Function, Function>()
function bindFunctions(host: Host, target: any) {
    if (boundFunctions.has(target)) {
        return boundFunctions.get(target)!
    }

    if (typeof target !== 'function' || !(moveable in target)) {
        return target
    }

    const v = target[moveable]()
    if (!v.captured) {
        const boundFn = host.bind(target)
        boundFunctions.set(target, boundFn)
        boundFunctions.set(boundFn, boundFn)

        return boundFn
    }

    // We're changing `captured`, create a copy via `bind`
    const copy = target.bind(undefined)
    for (const sym of Object.getOwnPropertySymbols(target)) {
        copy[sym] = target[sym]
    }

    boundFunctions.set(target, copy)

    const captured = v.captured.map(x => bindFunctions(host, x))
    Object.assign(copy, {
        [moveable]: () => ({
            ...v,
            captured,
        })
    })

    const boundFn = host.bind(copy)
    boundFunctions.set(target, boundFn)
    boundFunctions.set(boundFn, boundFn)

    return boundFn
}

// needed for sym eval, compiler isn't aware of how `run` is implemented
// FIXME: doesn't work, we are not hydrating correctly
// core.bindModel(AsyncLocalStorage, {
//     run: (store, cb, ...args) => {
//         return cb(...args) as any
//     }
// })

function runWithStore<T>(store: { workflowRunId: string }, cb: () => T): T {
    return storage.run(store, cb)
}

core.bindFunctionModel(runWithStore, (_, cb) => cb())


const storage = new AsyncLocalStorage<{ workflowRunId: string }>()
function getWorkflowRunId() {
    const ctx = storage.getStore()
    if (!ctx) {
        throw new Error('Not in a workflow context')
    }

    return ctx.workflowRunId
}

// TODO: add a queue
interface CheckpointExecution {
    readonly args: any[]
    status: 'failed' | 'running' | 'complete' | 'cancelled'
    error?: any
    result?: any
}

interface CheckpointState {
    attempt?: number
    // startedAt
}

interface CheckpointRunEvent {
    readonly type: 'checkpoint_run'
    readonly id: string 
    readonly workflowRunId: string
    readonly args: any[]
}

export function createWorkflowService() {
    const service = new HttpService({ auth: 'none' })
    const checkpoints = new Map<string, CheckpointInfo>()
    const states = new Table<string, { result: any }>()

    const fns = new Map<any, (...any: any[]) => Promise<any>>()
    function getFn<T extends any[], U>(handler: (...args: T) => Promise<U> | U): (...args: T) => Promise<U> {
        if (fns.has(handler)) {
            return fns.get(handler)!
        }

        const bound = bindFunctions(host, handler)
        if (bound === handler) {
            return bound
        }

        fns.set(handler, bound)

        return bound
    }

    const host: Host = {
        bind: fn => {
            const info = fn[checkpointSym] as CheckpointInfo | undefined
            if (!info) {
                return fn
            }
    
            delete fn[checkpointSym]
    
            const id = info.id
            checkpoints.set(id, {
                ...info,
                handler: getFn(info.handler),
            })
    
            return async function (...args) {
                const workflowRunId = getWorkflowRunId()
                // console.log('calling activity', id)
                const { result } = await http.fetch(runCheckpointRoute, id, { args, workflowRunId })
    
                return result
            }
        }
    }

    function registerWorkflow<T extends any[], U>(handler: (...args: T) => Promise<U> | U) {
        const bound = getFn(handler)

        async function run(key: string | undefined, ...args: T): Promise<U> {
            return storage.run({ workflowRunId: key ?? crypto.randomUUID() }, bound, ...args)
        }

        return { run }
    }

    const runCheckpointRoute = service.route('POST', '/checkpoint/{id}/run', async (req, body: { args: any[]; workflowRunId: string }) => {
        const info = checkpoints.get(req.pathParameters.id)
        if (!info) {
            throw new Error('No checkpoint found')
        }
    
        const key = `${info.id}:${body.workflowRunId}`
        const prior = await states.get(key)
        if (prior !== undefined) {
            return { result: prior.result }
        }

        // TODO: run in a worker thread
        // We set the context to support nested checkpoints
        try {
            const result = await runWithStore(
                { workflowRunId: body.workflowRunId }, 
                () => info.handler(...body.args)
            )
    
            await states.set(key, { result })
        
            return { result }
        } catch (e) {
            // TODO: propagate stack
            if (e instanceof Error) {
                throw new http.HttpError(`${e.message}`, { status: 500 })
            }

            throw e
        }
    })

    return {
        register: registerWorkflow,
    }
}

