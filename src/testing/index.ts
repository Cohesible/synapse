import type { TestSuite, Test } from '../runtime/modules/test'
import { Fs } from '../system'
import { Logger, getLogger } from '../logging'
import { TemplateService, parseModuleName } from '../templates'
import { getDeploymentFs, readResourceState } from '../artifacts'
import { SessionContext } from '../deploy/deployment'
import { isDataPointer } from '../build-fs/pointers'
import { keyedMemoize, memoize, sortRecord, strcmp, tryReadJson } from '../utils'
import { PackageService } from '../pm/packages'

interface TestResult {
    id: number
    name: string
    hash: string
}

interface TestResultsCache {
    files: Record<string, TestResult[]>
    hashes: Record<string, string>
}

const testResultsKey = '__testResults__.json'

async function getCachedTestResults(fs: Pick<Fs, 'readFile'>): Promise<TestResultsCache | undefined> {
    const data = await tryReadJson<TestResultsCache>(fs, testResultsKey)
    // XXX: temporary backwards compat
    if (data && !data.hashes) {
        data.hashes = {}
    }
    return data
}

async function setCachedTestResults(fs: Pick<Fs, 'writeFile'>, data: TestResultsCache): Promise<void> {
    const sorted = sortRecord(data.files)
    for (const [k, v] of Object.entries(sorted)) {
        sorted[k] = v.sort((a, b) => a.id - b.id)
    }

    return await fs.writeFile(testResultsKey, JSON.stringify({ ...data, files: sorted }))
}

export async function clearCachedTestResults(fs: Pick<Fs, 'writeFile'> = getTestFs()): Promise<void> {
    await fs.writeFile(testResultsKey, JSON.stringify({ files: {}, hashes: {} }))
}

// Tests are effectively treated as separate deployments
const getTestFs = () => getDeploymentFs(undefined, undefined, undefined, true)

export function createTestRunner(
    loader: ReturnType<SessionContext['createModuleLoader']>,
    pkgService: PackageService,
    opt?: { noCache?: boolean }
) {
    const useCache = !opt?.noCache
    const getCache = memoize(async () => await getCachedTestResults(getTestFs()) ?? { files: {}, hashes: {} })

    async function saveCache() {
        if (getCache.cached) {
            await setCachedTestResults(getTestFs(), await getCache())
        }
    }

    async function maybeGetHash(test: ResolvedTest) {
        // Older versions won't have `pointer`
        // And we don't attempt to forcibly update
        const p = test.resolved.pointer
        if (!p) {
            return
        }

        return pkgService.getHashWithDeps(p, (await getCache()).hashes)
    }

    async function updateCache(test: TestItem) {
        if (!useCache || test.type !== 'test') {
            return
        }

        const hash = await maybeGetHash(test)
        if (!hash) {
            return
        }

        const cache = await getCache()
        const results = cache.files[test.fileName] ??= []
        const index = results.findIndex(r => r.id === test.id)
        const r: TestResult = {
            id: test.id,
            name: test.name,
            hash,
        }

        if (index === -1) {
            results.push(r)
        } else {
            results[index] = r
        }
    }

    async function findCachedTestResult(test: TestItem) {
        if (!useCache || test.type !== 'test') {
            return
        }

        const cache = await getCache()
        const results = cache.files[test.fileName]
        if (!results) {
            return
        }

        const currentHash = await maybeGetHash(test)
        if (!currentHash) {
            return
        }

        return results.find(r => r.hash === currentHash && r.name === test.name)
    }

    type TestEvent = Parameters<Logger['emitTestEvent']>[0]
    function emitStatus(info: TestItem, status: Exclude<TestEvent['status'], 'failed'>): void
    function emitStatus(info: TestItem, status: 'failed', error: Error): void
    function emitStatus(info: TestItem, status: TestEvent['status'], reason?: Error) {
        if (info.hidden) return

        getLogger().emitTestEvent({
            reason,
            status,
            id: `${info.fileName}:${info.id}`,
            name: info.name,
            itemType: info.type,
            parentId: info.parentId !== undefined ? `${info.fileName}:${info.parentId}` : undefined,
        } as TestEvent)
    }

    async function runTest(test: ResolvedTest) {
        const cached = await findCachedTestResult(test)
        if (cached) {
            return emitStatus(test, 'cached')
        }

        emitStatus(test, 'running')

        try {
            await loader.runWithContext({ test: [test] }, test.resolved.run.bind(test.resolved))
            emitStatus(test, 'passed')
            await updateCache(test)
        } catch (e) {
            const err = e as Error
            emitStatus(test, 'failed', err)
            
            return err
        }
    }

    function compareTestItem(a: TestItem, b: TestItem) {
        if (a.fileName !== b.fileName) {
            return strcmp(a.fileName, b.fileName)
        }

        return a.id - b.id
    }

    async function runSuite(suite: ResolvedSuite) {
        emitStatus(suite, 'running')

        const items: TestItem[] = [
            ...suite.tests,
            ...suite.suites,
        ].sort(compareTestItem)

        const results: { id: string; error: Error }[] = []
        for (const item of items) {
            const error = item.type === 'test' ? await runTest(item) : await runSuite(item)
            if (error !== undefined) {
                results.push({ id: `${item.fileName}:${item.id}`, error })
            }
        }

        const errors = results.map(r => r.error)
        if (errors.length === 0) {
            return emitStatus(suite, 'passed')
        }

        const err = new AggregateError(errors, `Test suite failed`)
        emitStatus(suite, 'failed', err)

        return err
    }

    async function runTestItems(items: TestItem[]) {
        const queue: TestItem[] = []
        for (const item of items) {
            emitStatus(item, 'pending')
            queue.push(item)
        }

        while (queue.length > 0) {
            const item = queue.shift()!
            if (item.type === 'suite') {
                await runSuite(item)
            } else {
                await runTest(item)
            }
        }

        await saveCache()
    }

    async function loadSuite(location: string) {
        const { suite } = await loader.loadModule(location)
        if (!suite) {
            throw new Error(`Missing suite export`)
        }

        if (typeof suite.run !== 'function') {
            throw new Error(`Suite object is missing a "run" function`)
        }

        return suite as TestSuite
    }

    async function resolveSuite(id: string) {
        const r = await readResourceState(id.split('.')[1])
        const handler = r.handler
        if (!isDataPointer(handler) && typeof handler !== 'string') {
            throw new Error(`Expected resource "${id}" to have a handler of type "string", got "${typeof handler}"`)
        }

        return loadSuite(handler)
    }

    async function loadTestSuites(suites: Record<string, BaseTestItem>, tests: Record<string, BaseTestItem>) {
        async function _getSuiteWithTests(k: string): Promise<ResolvedSuite> {
            const v = suites[k]
            const resolved = await resolveSuite(k)
            const fileName = v.fileName
            const suiteTests = Object.values(tests)
                .filter(v => v.fileName === fileName && v.parentId === resolved.id)
                .map(async info => {
                    const index = resolved.tests.findIndex(t => t.id === info.id)
                    if (index === -1) {
                        throw new Error(`Test not found in suite "${k}": ${info.id}`)
                    }

                    return {
                        type: 'test',
                        ...info,
                        resolved: resolved.tests[index],
                    } satisfies ResolvedTest
                })

            const childrenSuites = Object.entries(suites)
                .filter(([_, v]) => v.fileName === fileName && v.parentId === resolved.id)
                .map(([k]) => getSuiteWithTests(k))
            
            return { 
                ...v,
                type: 'suite',
                resolved,
                tests: await Promise.all(suiteTests),
                suites: await Promise.all(childrenSuites),
            }
        }
        
        const getSuiteWithTests = keyedMemoize(_getSuiteWithTests)

        const mapped = Object.entries(suites).map(async ([k, v]) => {
            return [k, await getSuiteWithTests(k)] as const
        })
    
        return Object.fromEntries(await Promise.all(mapped))
    }

    return {
        runTestItems,
        loadTestSuites,
    }
}

interface BaseTestItem {
    id: number // `id` is _always_ relative to the file
    name: string
    fileName: string
    parentId?: number
    hidden?: boolean
}

interface ResolvedTest extends BaseTestItem {
    type: 'test'
    resolved: Test
}

interface ResolvedSuite extends BaseTestItem {
    type: 'suite'
    resolved: TestSuite
    tests: ResolvedTest[]
    suites: ResolvedSuite[]
}

type TestItem = ResolvedTest | ResolvedSuite

interface TestFilter {
    parentId?: number
    fileNames?: string[]
    targetIds?: number[]
    names?: string
}

function canIncludeItem(item: BaseTestItem, filter: TestFilter) {
    if (filter.parentId !== undefined && item.parentId !== filter.parentId) {
        return false
    }

    if (filter.fileNames !== undefined && !filter.fileNames.includes(item.fileName)) {
        return false
    }

    if (filter.targetIds !== undefined && !filter.targetIds.includes(item.id)) {
        return false
    }

    if (filter.names !== undefined && !item.name.includes(filter.names)) {
        return false
    }

    return true
}

const csResourceType = 'synapse_resource'
export async function listTests(templates: TemplateService, filter: TestFilter = {}) {
    const resources = (await templates.getTemplate()).resource
    const csResources: Record<string, any> = resources?.[csResourceType] ?? {}

    const tests: Record<string, BaseTestItem> = {}
    for (const [k, v] of Object.entries(csResources)) {
        if (v.type === 'Test') {
            const { fileName, testSuiteId } = parseModuleName(v.module_name)
            if (testSuiteId === undefined) {
                throw new Error(`Test is missing a suite id: ${k}`)
            }

            const name = v.input?.name
            if (typeof name !== 'string') {
                throw new Error(`Test has no name: ${k}`)
            }

            const id = v.input?.id
            if (typeof id !== 'number') {
                throw new Error(`Test has no id: ${k}`)
            }

            const item = { id, name, fileName, parentId: testSuiteId }
            if (!canIncludeItem(item, filter)) {
                continue
            }

            tests[`${csResourceType}.${k}`] = item
        }
    }
 
    return tests
}

export async function listTestSuites(templates: TemplateService, filter: TestFilter = {}) {
    const resources = (await templates.getTemplate()).resource
    const csResources: Record<string, any> = resources?.[csResourceType] ?? {}

    const suites: Record<string, BaseTestItem> = {}
    for (const [k, v] of Object.entries(csResources)) {
        if (v.type === 'TestSuite') {
            const id: number = v.input.id
            const { fileName, testSuiteId } = parseModuleName(v.module_name)
            const parentId = testSuiteId !== id ? testSuiteId : undefined

            const name = v.input?.name
            if (typeof name !== 'string') {
                throw new Error(`Test has no name: ${k}`)
            }

            const hidden = parentId === undefined
            const item : BaseTestItem = { id, name, fileName, parentId, hidden }
            // XXX: don't use names to include all relevant suites
            if (!canIncludeItem(item, { ...filter, names: undefined })) {
                continue
            }

            suites[`${csResourceType}.${k}`] = item
        }
    }
 
    return suites
}

