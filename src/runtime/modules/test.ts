//# moduleId = synapse:test
//# transform = persist

import * as assert from 'node:assert'
import { Export } from 'synapse:lib'
import { createSynapseClass } from 'synapse:terraform'
import { using, defer, getCurrentId, contextType, maybeGetContext, importArtifact } from 'synapse:core'

// Starting at one to guard against erroneous falsy checks on the id
let idCounter = 1

export function test(name: string, fn: () => Promise<void> | void): void {
    const suite = maybeGetContext(TestSuite)
    if (suite) {
        suite.addTest(new Test(idCounter++, name, fn, suite.hooks))
    } else {
        addDeferredTestItem({ type: 'test', name, fn })
    }
}

export function suite(name: string, fn: () => void): void {
    const suite = maybeGetContext(TestSuite)
    if (suite) {
        const id = getCurrentId()
        const child = new TestSuite(idCounter++, name)
        visitTestSuite(id, child, fn)
    } else {
        addDeferredTestItem({ type: 'suite', name, fn })
    }
}

export function it(name: string, fn: () => void) {
    return test(name, fn)
}

export function describe(name: string, fn: () => void) {
    return suite(name, fn)
}

// TODO: `resourceGraph.ts` needs to propagate the types to these declarations 
// export const it = test
// export const describe = suite

export function before(fn: () => Promise<void> | void): void {
    const suite = maybeGetContext(TestSuite)
    if (!suite) {
        throw new Error('Cannot use "before" outside of a test suite')
    }

    const arr = suite.hooks.before ??= []
    arr.push(fn)
}

export function after(fn: () => Promise<void> | void): void {
    const suite = maybeGetContext(TestSuite)
    if (!suite) {
        throw new Error('Cannot use "after" outside of a test suite')
    }

    const arr = suite.hooks.after ??= []
    arr.push(fn)
}

interface TestProps {
    readonly id: number
    readonly name: string
    readonly handler: string // pointer
}

interface TestOutput {
    readonly id: number
    readonly name: string
    readonly handler: string // pointer
}

class TestResource extends createSynapseClass<TestProps, TestOutput>('Test') {}
class TestSuiteResource extends createSynapseClass<TestProps, TestOutput>('TestSuite') {}

interface Hooks {
    before?: (() => Promise<void> | void)[]
    after?: (() => Promise<void> | void)[]
}

export class Test {
    private readonly resource: TestResource

    public constructor(
        public readonly id: number, 
        public readonly name: string, 
        fn: () => Promise<void> | void,
        hooks?: Hooks
    ) {
        const handler = new Export({ fn, hooks })
        this.resource = new TestResource({
            id,
            name,
            handler: handler.destination,
        })
    }

    public async run() {
        const { fn, hooks } = await importArtifact(this.resource.handler)
        for (const h of hooks?.before ?? []) {
            await h()
        }

        try {
            await fn()
        } finally {
            // TODO: catch errors here and aggregate them
            for (const h of hooks?.after ?? []) {
                await h()
            }
        }
    }

    public get pointer() {
        return this.resource.handler
    }
}

export class TestSuite {
    static readonly [contextType] = 'test-suite'
    public readonly tests: Test[] = []

    public readonly hooks: Hooks = {}

    public constructor(
        public readonly id: number, // `id` is needed when serializing
        public readonly name: string,
    ) {
        // Add hooks from parent suites
        defer(() => {
            const suite = maybeGetContext(TestSuite)
            if (!suite) {
                return
            }

            if (suite.hooks.before) {
                const arr = this.hooks.before ??= []
                arr.splice(0, 0, ...suite.hooks.before)
            }

            if (suite.hooks.after) {
                const arr = this.hooks.after ??= []
                arr.push(...suite.hooks.after)
            }
        })
    }

    public addTest(test: Test) {
        this.tests.push(test)
    }

    public async run() {
        const results: { name: string; error?: Error }[] = []
        for (const test of this.tests) {
            const { name } = test

            try {
                await test.run()
                results.push({ name })
            } catch (e) {
                results.push({ name, error: e as Error })
            }
        }

        return results
    }
}

function visitTestSuite(id: string, suite: TestSuite, fn: () => void) {
    const handler = using(suite, () => {
        fn()

        return new Export({ suite }, { 
            id: id + '--test-suite',
            testSuiteId: suite.id,
        })
    })

    new TestSuiteResource({ 
        id: suite.id, 
        name: suite.name, 
        handler: handler.destination,
    })
}

declare function __getCallerModuleId(): string | undefined

interface DeferredTest {
    type: 'test'
    name: string
    fn: () => Promise<void> | void
}

interface DeferredSuite {
    type: 'suite'
    name: string
    fn: () => void
}

type DeferredTestItem = DeferredTest | DeferredSuite

const deferredTestsItems = new Map<string, DeferredTestItem[]>()
function addDeferredTestItem(item: DeferredTestItem) {
    const caller = __getCallerModuleId()
    if (!caller) {
        throw new Error(`Missing caller module id`)
    }

    if (deferredTestsItems.has(caller)) {
        deferredTestsItems.get(caller)!.push(item)
        return
    }

    const arr: DeferredTestItem[] = []
    arr.push(item)
    deferredTestsItems.set(caller, arr)

    defer(() => {
        const suite = new TestSuite(idCounter++, caller)

        using(suite, () => {
            for (const item of arr) {
                if (item.type === 'test') {
                    suite.addTest(new Test(idCounter++, item.name, item.fn, suite.hooks))
                } else {
                    const id = getCurrentId()
                    const child = new TestSuite(idCounter++, item.name)
                    visitTestSuite(id, child, item.fn)
                }
            }

            const handler = new Export({ suite }, { 
                id: caller + '--test-suite',
                testSuiteId: suite.id,
            })
    
            new TestSuiteResource({ 
                id: suite.id, 
                name: suite.name, 
                handler: handler.destination,
            })
        })
    })
}

// First operand -> actual
// Second operand (optional) -> expected
//
// We're just wrapping `node:assert` currently

function createAssertionError(
    actual?: unknown,
    expected?: unknown,
    operator?: 'strictEqual' | 'deepStrictEqual' | '==',
    message?: string
) {

    // We just want the error message, not the stack trace
    const err = new assert.AssertionError({ message, actual, expected, operator })

    return new Error(err.message)
}

function assertOk(value: unknown, message?: string) {
    if (!value) {
        throw createAssertionError(value, true, '==', message)
    }
}

function assertStrictEqual(actual: unknown, expected: unknown) {
    if (!Object.is(actual, expected)) {
        throw createAssertionError(actual, expected, 'strictEqual')
    }
}

function deepArrayEqual(actual: unknown[], expected: unknown[], message?: string) {
    if (actual.length !== expected.length) {
        throw createAssertionError(actual, expected, 'deepStrictEqual', message)
    }

    for (let i = 0; i < actual.length; i++) {
        assertDeepStrictEqual(actual[i], expected[i], message)
    }
}

// Not the best impl.
// This was quickly thrown together
// TODO: check proto, check descriptors
function assertDeepStrictEqual(actual: unknown, expected: unknown, message?: string) {
    if (typeof actual !== typeof expected) {
        throw createAssertionError(
            actual === null ? 'null' : typeof actual, 
            expected === null ? 'null' : typeof expected, 
            'deepStrictEqual', 
            message
        )
    }

    if (Object.is(actual, expected)) {
        return
    }

    if (actual === null || expected === null) {
        throw createAssertionError(actual, expected, 'deepStrictEqual', message)
    }

    if (typeof actual !== 'object') {
        throw createAssertionError(actual, expected, 'deepStrictEqual', message)
    }

    if (Array.isArray(actual) || Array.isArray(expected)) {
        if (!Array.isArray(actual) || !Array.isArray(expected)) {
            throw createAssertionError(actual, expected, 'deepStrictEqual', message)
        }

        return deepArrayEqual(actual, expected, message)
    }

    const actualKeys = Object.getOwnPropertyNames(actual).sort()
    const expectedKeys = Object.getOwnPropertyNames(expected).sort()
    deepArrayEqual(actualKeys, expectedKeys, message)

    for (const k of actualKeys) {
        assertDeepStrictEqual((actual as any)[k], (expected as any)[k], message)
    }
}

export function expect(actual: unknown, message?: string): asserts actual {
    assertOk(actual, message)
}

export function expectEqual<const T>(actual: unknown, expected: T, message?: string): asserts actual is T {
    assertDeepStrictEqual(actual, expected, message)
}

export function expectReferenceEqual<const T>(actual: unknown, expected: T): asserts actual is T {
    assertStrictEqual(actual, expected)
}

// TODO: the types don't make sense here
// export function expectReject<const T>(actual: Promise<unknown>, expected: T, message?: string): asserts actual is Promise<unknown> {
//     let didReject = false
//     const res = waitForPromise(actual.catch(e => (didReject = true, e)))
//     expect(didReject, message ?? 'Promise did not reject')
//     expectEqual(res, expected, message)
// }
