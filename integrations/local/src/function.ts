import * as core from 'synapse:core'
import * as compute from 'synapse:srl/compute'
import * as lib from 'synapse:lib'

// TODO: could be optimized
function wrapWithTimeout(fn: (...args: any[]) => any, seconds: number): typeof fn {
    return (...args) => {
        const timeout = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out')), seconds * 1000).unref()
        })

        return Promise.race([fn(...args), timeout])
    }
}

export class LocalFunction<T extends any[] = any[], U = unknown> implements compute.Function<T, U> {
    private readonly dest: string

    constructor(target: (...args: T) => Promise<U> | U, opt?: compute.FunctionOptions) {
        if (opt?.timeout) {
            if (opt.timeout <= 0) {
                throw new Error(`A Function's timeout must be greater than 0`)
            }
            target = wrapWithTimeout(target, opt.timeout)
        }

        const bundle = new lib.Bundle(target, { external: opt?.external })
        this.dest = bundle.destination
    }

    public async invoke(...args: T): Promise<U> {
        const fn = require(this.dest).default

        return fn(...args)
    }

    public async invokeAsync(...args: T): Promise<void> {
        const fn = require(this.dest).default
        fn(...args)
    }
}

export interface LocalFunction<T extends any[] = any[], U = unknown> {
    (...args: T): Promise<U>
}

core.addTarget(compute.Function, LocalFunction, 'local')
