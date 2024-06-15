import * as util from './util.zig'

// This will likely crash if called inside an immediate callback
export function waitForPromise<T>(promise: Promise<T> | T): T {
    if (process.release.name !== 'node-synapse') {
        throw new Error(`"waitForPromise" is not available in the current runtime`)
    }

    if (promise instanceof Promise) {
        return util.waitForPromise(promise)
    }

    if (!!promise && typeof promise === 'object' && 'then' in promise) {
        return util.waitForPromise(promise)
    }

    return promise
}