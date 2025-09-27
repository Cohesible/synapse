import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Fs, SyncFs, createLocalFs } from './system'
import { BuildTarget } from './workspaces'

interface ExecutionContext {
    readonly id: string
    readonly fs: Fs & SyncFs
    readonly selfPath?: string
    readonly selfBuildType?: 'snapshot' | 'sea'
    readonly buildTarget?: BuildTarget
    readonly abortSignal?: AbortSignal
}

const storage = new AsyncLocalStorage<ExecutionContext>()

function getContextOrThrow() {
    const ctx = storage.getStore()
    if (!ctx) {
        throw new Error(`Not within an execution context`)
    }

    return ctx
}

let defaultContext: Partial<ExecutionContext>
export function setContext(ctx: Partial<ExecutionContext>) {
    defaultContext = ctx
}

export function runWithContext<T>(ctx: Partial<ExecutionContext>, fn: () => T): T {
    const previousStore = storage.getStore()
    const id = ctx.id ?? previousStore?.id ?? randomUUID()
    const fs = ctx.fs ?? previousStore?.fs ?? createLocalFs()

    return storage.run({ ...previousStore, ...ctx, id, fs }, fn)
}

export function getFs() {
    return storage.getStore()?.fs ?? createLocalFs()
}

export function getExecutionId() {
    return defaultContext?.id ?? getContextOrThrow().id
}

export function getBuildTarget() {
    return storage.getStore()?.buildTarget
}

export function isInContext() {
    return storage.getStore() !== undefined
}

export function getBuildTargetOrThrow() {
    const bt = getBuildTarget()
    if (!bt) {
        throw new Error(`No build target found`)
    }

    return bt
}

export function throwIfCancelled() {
    storage.getStore()?.abortSignal?.throwIfAborted()
}

export function isCancelled() {
    return !!storage.getStore()?.abortSignal?.aborted
}

export function getAbortSignal() {
    return storage.getStore()?.abortSignal
}

export function isSelfSea() {
    if (defaultContext?.selfBuildType === 'sea') {
        return true
    }

    return storage.getStore()?.selfBuildType === 'sea'
}

// Need a better name for this because it doesn't always 
// point to a "real" file; it's the entrypoint JS file
export function getSelfPath() {
    if (defaultContext?.selfPath) {
        return defaultContext?.selfPath
    }

    return storage.getStore()?.selfPath
}

export function getSelfPathOrThrow() {
    if (defaultContext?.selfPath) {
        return defaultContext?.selfPath
    }

    const p = getContextOrThrow().selfPath
    if (!p) {
        throw new Error('Missing self path')
    }

    return p
}

export class CancelError extends Error {}

// These are global for now
type DisposableLike = Disposable | AsyncDisposable | (() => Promise<void> | void)
const disposables: DisposableLike[] = []
export function pushDisposable<T extends DisposableLike>(disposable: T): T {
    disposables.push(disposable)
    return disposable
}

export async function dispose() {
    const promises: (PromiseLike<void> | void)[] = []
    for (const d of disposables) {
        if (typeof d === 'function') {
            promises.push(d())
        } else if (Symbol.dispose in d) {
            d[Symbol.dispose]()
        } else {
            promises.push(d[Symbol.asyncDispose]())
        }
    }

    disposables.length = 0
    await Promise.all(promises)
}

// This is mutable and may be set at build-time
let semver = '0.0.0'
let revision: string | undefined
export function setCurrentVersion(_semver: string, _revision?: string) {
    semver = _semver
    revision = _revision
}

export function getCurrentVersion() {
    return { semver, revision }
}
