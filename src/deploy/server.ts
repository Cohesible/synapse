import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { HttpServer, HttpRoute, HttpError, sendResponse, receiveData } from './httpServer'
import { objectId, resolveValue } from '../runtime/modules/serdes'
import { BinaryToTextEncoding, createHash, randomUUID } from 'node:crypto'
import { bundleClosure, createDataExport, getImportMap, isDeduped, normalizeSymbolIds } from '../closures'
import { getLogger } from '../logging'
import { ModuleResolver, createImportMap } from '../runtime/resolver'
import { AsyncLocalStorage } from 'node:async_hooks'
import { BuildFsFragment, ProcessStore } from '../artifacts'
import { PackageService } from '../pm/packages'
import { TerraformPackageManifest } from '../runtime/modules/terraform'
import { Fs, SyncFs, readDirRecursive } from '../system'
import { Pointers, coerceToPointer, createPointer, isDataPointer, pointerPrefix } from '../build-fs/pointers'
import { ImportMap, SourceInfo } from '../runtime/importMaps'
import { getWorkingDir } from '../workspaces'
import { apiRegistrationResourceType, getServiceRegistry } from './registry'


export interface DeploymentContext {
    readonly fs: Fs & SyncFs
    readonly processStore: ProcessStore
    readonly dataDir: string
    readonly packageManifest: TerraformPackageManifest
    readonly packageService: PackageService
    readonly abortSignal?: AbortSignal
    createModuleResolver(): ModuleResolver
    createModuleLoader(): ModuleLoader
    createZip?(files: Record<string, string>, dest: string): Promise<void>
}

export interface ModuleLoader {
    loadModule: (id: string, origin?: string) => Promise<any>
    registerMapping(mapping: ImportMap<SourceInfo>, location: string): void
    runWithContext: <T>(namedContexts: Record<string, any>, fn: () => Promise<T> | T) => Promise<T>
}


interface TerraformResourceConfig {
    readonly type: string
    readonly plan: any
    readonly context?: any
    readonly handler: string
}

interface TerraformResourceRequest extends TerraformResourceConfig {
    readonly resource: string
    readonly state: any
    readonly operation: 'create' | 'update' | 'read' | 'delete' | 'import'
    readonly workingDirectory: string

    // Only relevant for `update`
    readonly priorConfig?: TerraformResourceConfig

    // Only relevant for `import`
    readonly importId?: string
}

interface ResourceDefinition<
    D extends object = object,
    T extends object = object,
    I extends object = T,
    U extends any[] = [],
> {
    read?(state: I): T | Promise<T>
    create?(...args: U): T | Promise<T>
    update?(state: T, ...args: U): T | Promise<T>
    delete?(state: T, ...args: U): void | Promise<void>
    data?(state: I): D | Promise<D>
    import?(id: string): T | Promise<T>
}

export async function loadPointer(loader: ModuleLoader, val: any) {
    val = await resolvePointer(val)

    return val === undefined ? val : deserializeObject(loader, val)
}

export async function loadPointerFromCtx(ctx: DeploymentContext, resource: string, val: any) {
    const fs = await ctx.processStore.getResourceStore(resource) 

    return runWithArtifactFs(fs, () => loadPointer(ctx.createModuleLoader(), coerceToPointer(val)))
}

async function resolvePointer(val: any) {
    if (val === undefined) {
        return
    }

    if (isDataPointer(val)) {
        return getObject(val)
    }

    if (typeof val === 'string' && val.startsWith(pointerPrefix)) {
        return getObject(val)
    }

    return val
}

function deserializeObject(loader: ModuleLoader, obj: any) {
    if (isDeduped(obj)) {
        return resolveValue(obj.captured, loader, obj.table, undefined, false)
    }

    return resolveValue(obj, loader, undefined, undefined, false)
}

function createProviderRoutes(ctx: DeploymentContext) {
    const ops = ['read', 'create', 'update', 'delete', 'data']
    async function resolveConfig(loader: ModuleLoader, config: TerraformResourceConfig, resourceName: string) {
        if (!config.handler.startsWith(pointerPrefix)) {
            throw new Error(`Unexpected legacy handler found while resolving config: ${config.handler}`)
        }

        const handler = config.handler

        // We have to load the plan before we load the handler so we can parse
        // out any package dependencies that might have been serialized
        const plan = await loadPointer(loader, config.plan) ?? [] as any[]
        const tabularized = createDataExport(plan)
        const importMap = await getImportMap(ctx, tabularized.table)
        const pointerMappings = await ctx.packageService.getPublishedMappings('[handler]', handler)

        if (importMap || pointerMappings) {
            const m = importMap ?? {}
            if (pointerMappings) {
                m[pointerMappings[0]] = pointerMappings[1]
            }
            //getLogger().debug('Registering import map parsed from resource plan:', handler, Object.keys(m))
            loader.registerMapping(m, getWorkingDir())
        }

        const definition: ResourceDefinition = await loader.loadModule(handler)
        if (!definition) {
            throw new HttpError(`No resource definition found for type: ${config.type} (${config.handler})`, {
                statusCode: 404,
                code: 'NoResourceDefinition',
            })
        }

        if (!ops.some(o => o in definition)) {
            throw new HttpError(`Resource definition contains no operations: ${config.type} (${config.handler})`, {
                statusCode: 400,
                code: 'BadResourceDefinition',
            })
        }

        const context = await loadPointer(loader, config.context) ?? {}
        const afs = await getArtifactFs()
        context['afs'] ??= []
        context['afs'].push(afs)

        context['resource'] ??= []
        context['resource'].push(resourceName)

        return {
            plan,
            context,
            definition,
            // dataTable: (await resolvePointer(config.plan))?.table ?? {},
        }
    }

    async function resolvePayload(loader: ModuleLoader, req: TerraformResourceRequest) {
        const config = await resolveConfig(loader, req, req.resource)
        const state = await loadPointer(loader, req.state) ?? {}

        return {
            state,
            ...config,
        }
    }

    // TODO: remove or fix the warning in Node about having too many event listeners
    let didInitListener = false
    const abortListeners: ((err?: any) => void)[] = []
    function addAbortListener(listener: (err?: any) => void) {
        const signal = ctx.abortSignal
        if (!signal) {
            throw new Error('No abort signal available')
        }

        abortListeners.push(listener)

        if (!didInitListener) {
            didInitListener = true

            function onAbort() {
                signal!.removeEventListener('abort', onAbort)
                for (const l of abortListeners) {
                    l(signal!.reason)
                }
            }

            signal.addEventListener('abort', onAbort)
        }

        return { dispose: () => void abortListeners.splice(abortListeners.indexOf(listener), 1) }
    }

    async function runWithCancel(loader: ModuleLoader, context: any, fn: () => Promise<any>) {
        const signal = ctx.abortSignal
        if (!signal) {
            return loader.runWithContext(context, fn)
        }

        signal.throwIfAborted()

        let listener!: { dispose: () => void }
        const cancelPromise = new Promise<any>((_, r) => (listener = addAbortListener(() => {
            // Add a small delay to allow for minimal clean-up
            setTimeout(() => r(signal!.reason), 100).unref()
        })))

        try {
            return await Promise.race([
                cancelPromise,
                loader.runWithContext(context, fn),
            ])
        } finally {
            listener.dispose()
        }
    }

    async function handleProviderRequest(request: TerraformResourceRequest) {
        const loader = ctx.createModuleLoader()
        const resolved = await resolvePayload(loader, request)
        const { state, definition, plan, context } = resolved

        async function deleteResource() {
            const priorResolved = request.priorConfig 
                ? await resolveConfig(loader, request.priorConfig, request.resource)
                : undefined

            if (priorResolved) {
                const deleteOp = priorResolved.definition['delete']
                await loader.runWithContext(priorResolved.context, async () => {
                    await (deleteOp as any)?.(state, ...priorResolved.plan)
                })

                return
            }

            const deleteOp = definition['delete']
            await (deleteOp as any)?.(state, ...plan)
        }

        const op = definition[request.operation]
        async function doOp() {
            if (request.operation === 'import') {
                if (!op) {
                    throw new Error(`Resource "${request.resource}" has no import method`)
                }

                return (op as any)(request.importId)
            }

            if (!op && request.operation === 'update') {
                await deleteResource()
                const createOp = definition['create']
    
                const newState = (await (createOp as any)?.(...plan)) ?? state

                return newState
            }

            if (request.operation === 'delete') {
                await deleteResource()

                return {}
            }

            const parameters = request.operation === 'create' ? plan 
                : request.operation === 'update' ? [state, ...plan] : [state]

            const newState = (await (op as any)?.(...(parameters))) ?? state

            return newState
        }

        return await runWithCancel(loader, context, doOp)
    }

    async function handleDataProviderRequest(request: TerraformResourceRequest) {
        const loader = ctx.createModuleLoader()
        const { definition, plan, context } = await resolvePayload(loader, request)
        if (request.operation !== 'read') {
            throw new Error(`Unexpected operation: ${request.operation}. Only 'read' is allowed.`)
        }

        async function doOp() {
            const op = definition['data'] ?? definition['read']
            if (!op) {
                getLogger().log('No "data" or "read" method found.')
    
                return plan[0] ?? {}
            }
    
            const state = (await (op as any)(...plan))
    
            return state
        }

        return await runWithCancel(loader, context, doOp)
    }

    function serializeValue(val: any, dataTable: Record<string | number, any>): any {
        if ((typeof val !== 'object' && typeof val !== 'function') || !val) {
            return val
        }

        if (isDataPointer(val)) {
            return val
        }

        const id = val[objectId]
        if (id !== undefined) {
            return { ['@@__moveable__']: dataTable[id] }
        }

        if (Array.isArray(val)) {
            return val.map(v => serializeValue(v, dataTable))
        }

        if (typeof val === 'function') {
            throw new Error(`Failed to serialize value: ${val}`)
        }

        // TODO: fail on prop descriptors

        const o: Record<string, any> = {}
        for (const [k, v] of Object.entries(val)) {
            o[k] = serializeValue(v, dataTable)
        }

        return o
    }

    return {
        handleProviderRequest,
        handleDataProviderRequest,
    }
}

async function ensureDir(fileName: string) {
    try {
        await fs.mkdir(path.dirname(fileName), { recursive: true })
    } catch(e) {
        if ((e as any).code !== 'EEXIST') {
            throw e
        }
    }
}

function createStateRoute(stateDirectory: string) {
    const getStatePath = (org: string, workspace: string, branch: string, module: string) => 
        path.resolve(stateDirectory, org, workspace, branch, module)

    async function saveState(location: string, data: string) {
        await ensureDir(location)
        await fs.writeFile(location, data, 'utf-8')
    }

    async function loadState(location: string) {
        try {
            const data = await fs.readFile(location, 'utf-8')

            return data
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }

            throw new HttpError('No state found', { code: 'MissingState', statusCode: 404 })
        }
    }

    async function deleteState(location: string) {
        try {
            await fs.unlink(location)
        } catch(e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
        }
    }

    const stateRoute = new HttpRoute('/{org}/{workspace}/{branch}/state/{module+}', async request => {
        const { org, workspace, branch, module } = request.params
        const location = getStatePath(org, workspace, branch, module)

        switch (request.method) {
            case 'GET':
                return sendResponse(request.response, await loadState(location))
            case 'POST':
                return sendResponse(request.response, await saveState(location, await receiveData(request.request)))
            case 'DELETE':
                return sendResponse(request.response, await deleteState(location))

            // LOCK
            // UNLOCK
        }

        throw new HttpError(`Invalid method: ${request.method}`, { code: 'InvalidMethod', statusCode: 400 })
    })

    return [stateRoute]
}

type Operation = 'create' | 'update' | 'read' | 'delete' | 'data' | 'import'

export function assertNotData(op: Operation): asserts op is Exclude<Operation, 'data'> {
    if (op === 'data') {
        throw new Error('Data operations are not allowed for resources')
    }
}

function assertNotImport(op: Operation, type: string): asserts op is Exclude<Operation, 'import'> {
    if (op === 'import') {
        throw new Error(`Data operations are not allowed for type: ${type}`)
    }
}

async function createArtifactFs2(ctx: DeploymentContext, resource: string, deps: string[], op: Operation) {
    const sfs = op !== 'create' && op !== 'update' && op !== 'data'
        ? await ctx.processStore.getResourceStore(resource) 
        : await ctx.processStore.createResourceStore(resource, op === 'update' ? [...deps, resource] : deps)

    return sfs
}

const contextStorage = new AsyncLocalStorage<{ readonly afs: BuildFsFragment }>()
async function getArtifactFs() {
    const afs = contextStorage.getStore()?.afs
    if (!afs) {
        throw new Error(`No artifact fs available`)
    }
    return afs
}

function runWithArtifactFs<T, U extends any[]>(afs: BuildFsFragment, fn: (...args: U) => T, ...args: U): T {
    return contextStorage.run({ afs }, fn, ...args)
}

interface GetAttrStep {
    readonly type: 'get_attr'
    readonly value: string
}

interface IndexStep {
    readonly type: 'index'
    readonly value: string | { type: 'number'; value: number }
}

type PathStep = GetAttrStep | IndexStep

function getKey(step: PathStep) {
    if (typeof step.value === 'object') {
        return step.value.value
    }

    return step.value
}

function applyPath(target: any, steps: PathStep[]) {
    if (steps.length === 0) {
        return target
    }

    return applyPath(target?.[getKey(steps[0])], steps.slice(1))
}

interface DataPointer {
    readonly path: PathStep[]
    readonly value: string
}

interface EncodedPointers {
    readonly prior?: DataPointer[]
    readonly planned?: DataPointer[]
}

interface ProviderConfig {
    readonly outputDirectory: string
    readonly workingDirectory: string
}

interface BaseProviderRequest {
    readonly type: string // This is the _custom_ resource type
    readonly resourceName: string
    readonly dependencies: string[] // Resource names
    readonly operation: Operation
    readonly priorInput?: any | null
    readonly priorState?: any | null
    readonly plannedState?: any | null
    readonly providerConfig: ProviderConfig
    readonly pointers?: EncodedPointers
}

interface CreateRequest extends BaseProviderRequest {
    readonly plannedState: any
    readonly operation: 'create'
}

interface DataRequest extends BaseProviderRequest {
    readonly plannedState: any
    readonly operation: 'data'
}

interface ReadRequest extends BaseProviderRequest {
    readonly priorInput: any
    readonly priorState: any
    readonly operation: 'read'
}

interface UpdateRequest extends BaseProviderRequest {
    readonly priorInput: any
    readonly priorState: any
    readonly plannedState: any
    readonly operation: 'update'
}

interface DeleteRequest extends BaseProviderRequest {
    readonly priorInput: any
    readonly priorState: any
    readonly operation: 'delete'
}

interface ImportRequest extends BaseProviderRequest {
    readonly importId: string
    readonly plannedState: any
    readonly operation: 'import'
}

export type ProviderRequest = 
    | CreateRequest
    | DataRequest
    | ReadRequest
    | UpdateRequest
    | DeleteRequest
    | ImportRequest

function hydratePointers<T extends BaseProviderRequest>(req: T) {
    const inputDeps = new Set<string>()
    if (!req.pointers) {
        return { hydrated: req, inputDeps }
    }

    function normalizePointers(type: 'input' | 'output', arr: DataPointer[] = []) {
        return arr.filter(x => x.path[0].value === type).map(x => ({ ...x, path: x.path.slice(1) }))
    }

    // This _mutates_ the object!
    function hydrate(obj: any, arr: DataPointer[], isPlannedInput = false) {
        for (const p of arr) {
            const last = p.path.pop()
            if (!last) {
                continue
            }
    
            const target = applyPath(obj, p.path)
            if (!target) {
                getLogger().warn(`Missing target [${p.path.map(x => x.value).join('.')}]: ${obj}`)
                continue
            }

            const key = getKey(last)
            const hash = target[key]
            if (p.value === '') {
                target[key] = `${pointerPrefix}${hash}`
            } else {
                target[key] = createPointer(hash, p.value)
                if (isPlannedInput) {
                    inputDeps.add(`${p.value}:${hash}`)
                }
            }
        }

        return obj
    }


    const priorInputPointers = normalizePointers('input', req.pointers.prior)
    const priorStatePointers = normalizePointers('output', req.pointers.prior)
    const plannedStatePointers = normalizePointers('input', req.pointers.planned)

    const hydrated = {
        ...req,
        priorInput: hydrate(req.priorInput, priorInputPointers),
        priorState: hydrate(req.priorState, priorStatePointers),
        plannedState: hydrate(req.plannedState, plannedStatePointers, true),
    }

    return { hydrated, inputDeps }
}

export const resourceIdSymbol = Symbol.for('synapse.resourceId')

function createProviderRoute(ctx: DeploymentContext, handlers: Handlers) {
    interface ProviderResponse<T> {
        readonly state: T
        readonly pointers?: Pointers
    }

    async function runResourceRequestWithArtifactFs<T>(payload: ProviderRequest, fn: (payload: ProviderRequest) => Promise<T>): Promise<ProviderResponse<T>> {
        const { hydrated, inputDeps } = hydratePointers(payload)
        const sfs = await createArtifactFs2(ctx, payload.resourceName, payload.dependencies, payload.operation)

        return runWithArtifactFs(sfs, fn, hydrated).then(async resp => {
            // FIXME: `resp ?? null` is not entirely correct here. We have no way to serialize `undefined`
            return ctx.processStore.saveResponse(payload.resourceName, Array.from(inputDeps), resp ?? null, payload.operation)
        }).catch(e => {
            const resourceId = `synapse_resource.${payload.resourceName}`
            throw Object.assign(e, { [resourceIdSymbol]: resourceId })
        })
    }

    async function handleRequest(payload: ProviderRequest) {
        switch (payload.type) {
            case 'Asset':
                assertNotData(payload.operation)
                assertNotImport(payload.operation, payload.type)

                return handlers.asset.handleAssetRequest({
                    operation: payload.operation,
                    ...payload.priorInput,
                    ...payload.priorState,
                    ...payload.plannedState,
                    ...payload.providerConfig, 
                })    
            
            case 'Closure':
                assertNotData(payload.operation)
                assertNotImport(payload.operation, payload.type)

                const location = payload.operation === 'read'
                    ? payload.priorInput.location
                    : payload.plannedState?.location

                return handlers.closure.handleClosureRequest({
                    operation: payload.operation,
                    ...payload.priorInput,
                    ...payload.priorState,
                    ...payload.plannedState,
                    ...payload.providerConfig,
                    location,
                })

            case 'Custom':
                assertNotData(payload.operation)
                const importId = payload.operation === 'import' ? payload.importId : undefined

                return handlers.provider.handleProviderRequest({
                    importId,
                    resource: payload.resourceName,
                    operation: payload.operation,
                    ...payload.priorInput,
                    ...payload.plannedState,
                    ...payload.providerConfig,
                    state: payload.priorState,
                    priorConfig: payload.priorInput,
                })

            case 'CustomData':
                assertNotImport(payload.operation, payload.type)

                return handlers.provider.handleDataProviderRequest({
                    resource: payload.resourceName,
                    operation: 'read',
                    ...payload.plannedState,
                    ...payload.providerConfig,  
                })

            case 'ObjectData': {
                const artifactFs = await getArtifactFs()
                const data = payload.plannedState!.value

                // TODO: attach the symbol mapping as metadata so we can reverse the normalization
                const normalized = isDeduped(data) ? normalizeSymbolIds(data) : data
                const pointer = await artifactFs.writeData2(normalized)

                return { filePath: pointer }
            }

            case 'Artifact': {
                const pointer = payload.plannedState!.url
                // TODO: remove this check? I think it's for backwards compat 
                if (!pointer.startsWith(pointerPrefix)) {
                    return { filePath: path.resolve(payload.providerConfig.workingDirectory, pointer) }
                }

                const artifactFs = await getArtifactFs()
                
                return { filePath: await artifactFs.resolveArtifact(pointer) }
            }

            case 'Test':
            case 'TestSuite': {
                assertNotData(payload.operation)
                assertNotImport(payload.operation, payload.type)

                switch (payload.operation) {
                    case 'create':
                    case 'update':
                        const { id, name, handler } = payload.plannedState

                        return { id, name, handler }
                    case 'delete':
                        return {}
                    case 'read':
                        return payload.priorState
                }
            }

            // Effectively no-op resources
            case 'ModuleExports':
                return payload.plannedState ?? payload.priorState

            case apiRegistrationResourceType:
                return getServiceRegistry().handleRequest(ctx, payload)
        }
    }

    const handlerRoute = new HttpRoute('/handle', async request => {
        const payload = JSON.parse(await receiveData(request.request)) as ProviderRequest
        const resp = await runResourceRequestWithArtifactFs(payload, handleRequest)

        return sendResponse(request.response, resp)
    })

    return [
        handlerRoute,

        // These routes are for backwards compat w/ "scaffolding"
        // They can be removed after re-deploying (or destroying) all existing processes
        new HttpRoute('/provider', async request => {
            const payload = JSON.parse(await receiveData(request.request)) as any
            const resp = await handlers.provider.handleProviderRequest(payload)
    
            return sendResponse(request.response, resp)
        }),

        new HttpRoute('/assets', async request => {
            const payload = JSON.parse(await receiveData(request.request)) as any
            const resp = await handlers.asset.handleAssetRequest(payload)
    
            return sendResponse(request.response, resp)
        }),

        new HttpRoute('/closure', async request => {
            const payload = JSON.parse(await receiveData(request.request)) as any
            const resp = await handlers.closure.handleClosureRequest(payload)
    
            return sendResponse(request.response, resp)
        }),

        new HttpRoute('/hooks/{action}', async request => {
            const { action } = request.params
            const payload = JSON.parse(await receiveData(request.request)) as any
            const loader = ctx.createModuleLoader()
            const handler = await loader.loadModule(payload.handler)
            const op = handler[action]
            if (!op) {
                throw new HttpError(`No operation found in handler: ${action}`, { statusCode: 404 })
            }

            if (action === 'beforeDestroy') {
                const state = await op(payload.instance)

                return sendResponse(request.response, { state })
            } else if (action === 'afterCreate') {
                await op(payload.instance, payload.state)

                return sendResponse(request.response, {})
            } else {
                throw new HttpError(`Invalid operation: ${action}`, { statusCode: 404 })
            }
        })
    ]
}

async function getObject(val: string | undefined, isPointer = true) {
    if (!val) {
        return {}
    }

    if (!isPointer) {
        return JSON.parse(val)
    }

    try {
        const artifactFs = await getArtifactFs()

        return await artifactFs.readData2(val)
    } catch (e) {
        throw new Error(`Failed to resolve artifact: ${val}`, { cause: e })
    }
}

function createClosureRoutes(ctx: DeploymentContext) {
    interface BaseClosureRequest {
        readonly options?: Record<string, any>
        readonly source: string // relative to the cwd
        readonly location?: string
        readonly workingDirectory: string
        readonly outputDirectory: string
        readonly operation: string
        readonly captured: string // pointer
        readonly globals?: string // pointer
    }

    interface CreateClosureRequest extends BaseClosureRequest {
        readonly operation: 'create'
    }

    interface DeleteClosureRequest extends BaseClosureRequest {
        readonly operation: 'delete'
        readonly destination: string
    }

    interface ReadClosureRequest extends BaseClosureRequest {
        readonly operation: 'read'
        readonly destination: string
        readonly extname: string
        readonly assets?: Record<string, string>
    }

    interface UpdateClosureRequest extends BaseClosureRequest {
        readonly operation: 'update'
        readonly destination: string
    }

    type ClosureRequest = CreateClosureRequest | DeleteClosureRequest | ReadClosureRequest | UpdateClosureRequest

    async function handleClosureRequest(payload: ClosureRequest) {
        async function deleteFile(payload: UpdateClosureRequest | DeleteClosureRequest) {
            if (payload.destination.startsWith(pointerPrefix)) {
                return
            }

            const location = payload.destination

            try {
                await ctx.fs.deleteFile(path.resolve(payload.workingDirectory, location))
            } catch (e) {
                if ((e as any).code !== 'ENOENT') {
                    throw e
                }
                getLogger().log('Failed to delete file', e)
            }
        }

        async function createClosure() {
            const captured = await getObject(payload.captured)
            const globals = await getObject(payload.globals)
            const source = payload.source || `${payload.captured.slice(pointerPrefix.length)}.ts`

            const result = await bundleClosure(
                ctx,
                await getArtifactFs(),
                source,
                captured, 
                globals, 
                payload.workingDirectory, 
                payload.outputDirectory,
                {
                    ...payload.options,
                    destination: payload.location,
                }
            )

            const isResourceDef = result.location.startsWith(pointerPrefix)
            const destination = isResourceDef ? result.location : path.relative(payload.workingDirectory, result.location)

            return { destination, extname: result.extname, assets: result.assets }
        }

        switch (payload.operation) {
            case 'create':
            case 'update':    
                return await createClosure()
            case 'delete':
                await deleteFile(payload)

                return {}
            case 'read':
                if (payload.destination.startsWith(pointerPrefix)) {
                    return { destination: payload.destination, extname: payload.extname, assets: payload.assets }
                }

                const location = path.resolve(payload.workingDirectory, payload.destination)

                if (!(await ctx.fs.fileExists(location))) {
                    getLogger().log('Re-creating missing closure', location)

                    return await createClosure()
                }

                return { destination: payload.destination, extname: payload.extname, assets: payload.assets }
            
            default:
                throw new Error(`Unknown operation: ${(payload as any).operation}`)
        }
    }

    return { handleClosureRequest }
}

enum AssetType {
    FILE = 0,
    DIRECTORY = 1,
    ARCHIVE = 2
}

function createAssetRoute(ctx: DeploymentContext, terraformWorkingDirectory: string) {
    interface BaseAssetRequest {
        readonly path: string
        readonly extname?: string
        readonly type?: AssetType
        readonly extraFiles?: Record<string, string>
        readonly workingDirectory: string
        readonly outputDirectory: string
        readonly operation: string
    }

    interface CreateAssetRequest extends BaseAssetRequest {
        readonly operation: 'create'
    }

    interface DeleteAssetRequest extends BaseAssetRequest {
        readonly operation: 'delete'
        readonly filePath: string
    }

    interface ReadAssetRequest extends BaseAssetRequest {
        readonly operation: 'read'
        readonly filePath: string
        readonly sourceHash?: string
    }

    interface UpdateAssetRequest extends BaseAssetRequest {
        readonly operation: 'update'
    }

    type AssetRequest = CreateAssetRequest | DeleteAssetRequest | ReadAssetRequest | UpdateAssetRequest

    async function zip(dir: string, target: string, dest: string, targetIsDir = false, extraFiles?: Record<string, string>) {
        if (ctx.createZip) {
            const files: Record<string, string> = targetIsDir
                ? await readDirRecursive(ctx.fs, dir)
                : { [target]: path.resolve(dir, target) }

            if (extraFiles) {
                for (const [k, v] of Object.entries(extraFiles)) {
                    const name = k.startsWith('file:./') ? k.slice('file:./'.length) : k
                    const location = v.startsWith('pointer:') 
                        ? (await getArtifactFs()).resolveArtifact(v) 
                        : path.resolve(terraformWorkingDirectory, v)

                    files[name] = await location
                }
            }

            try {
                return await ctx.createZip(files, dest)
            } catch (e) {
                getLogger().debug(`Failed to use built-in zip command`, e)
            }
        }

        getLogger().debug(`Running "zip" on file "${target}" from`, dir)

        // TODO: use `tar` if `zip` isn't available
        const c = child_process.spawn('zip', ['-r', dest, `./${target}`], {
            cwd: dir,
        })

        // FIXME: use common impl. for spawning processes
        function logZip(d: Buffer) {
            getLogger().log(`child process [zip]: ${d.toString('utf-8').trimEnd()}`)
        }

        c.stdout?.on('data', logZip)
        c.stderr?.on('data', logZip)

        return new Promise<void>((resolve, reject) => {
            c.on('error', reject)
            c.on('exit', code => {
                if (code !== 0) {
                    reject(new Error(`Non-zero exit code: ${code}`))
                } else {
                    resolve()
                }
            })
        })
    }

    async function computeHash(fileName: string, encoding: BinaryToTextEncoding = 'base64url') {
        return createHash('sha256').update(await fs.readFile(fileName)).digest(encoding)
    }

    async function computeHashDir(dir: string): Promise<string> {
        const hash = createHash('sha256')
        for (const f of await fs.readdir(dir, { withFileTypes: true })) {
            const absPath = path.resolve(dir, f.name)
            // TODO: follow sym links?
            if (f.isFile()) {
                hash.update(await fs.readFile(absPath))
            } else if (f.isDirectory()) {
                hash.update(await computeHashDir(absPath))
            }
        }

        return hash.digest('base64url')
    }

    // XXX: this is used for Lambdas to ensure a static handler name
    // Otherwise we get this error from the AWS TF provider: `handler and runtime must be set when PackageType is Zip`
    async function resolveArtifact(dir: string, p: string, extname = '') {
        const resolved = path.resolve(dir, `handler${extname}`)
        const afs = await getArtifactFs()

        return afs.resolveArtifact(p, { filePath: resolved })
    }

    async function handleAssetRequest(payload: AssetRequest) {
        async function createAsset() {
            const tmpDir = path.resolve(terraformWorkingDirectory, 'archives', 'tmp', randomUUID())

            const target = payload.path.startsWith(pointerPrefix)
                ? await resolveArtifact(tmpDir, payload.path, payload.extname)
                : path.resolve(payload.workingDirectory, payload.path)

            if (payload.type === AssetType.ARCHIVE) {
                const isDir = !payload.path.startsWith(pointerPrefix) && (await fs.stat(target)).isDirectory()
                const sourceHash = await (isDir ? computeHashDir(target) : computeHash(target))
                const outFile = `${sourceHash}.zip`
                const relPath = path.join('archives', outFile)
                const dest = path.resolve(terraformWorkingDirectory, relPath)
                await ensureDir(dest)

                if (isDir) {
                    await zip(target, '.', dest, true, payload.extraFiles)
                } else {
                    await zip(path.dirname(target), path.basename(target), dest, false, payload.extraFiles)
                }

                await fs.rm(tmpDir, { force: true, recursive: true })
    
                return {
                    sourceHash,
                    filePath: relPath,
                }
            }

            return {
                filePath: target,
            }
        }

        if (payload.operation === 'create' || payload.operation === 'update') {
            return createAsset()
        } else if (payload.operation === 'delete') {
            const dest = path.resolve(terraformWorkingDirectory, payload.filePath)

            try {
                await fs.rm(dest)
            } catch (e) {
                if ((e as any).code !== 'ENOENT') {
                    throw e
                }
            }

            return {}
        } else if (payload.operation === 'read') {
            const dest = path.resolve(terraformWorkingDirectory, payload.filePath)
            if (!payload.filePath || !(await ctx.fs.fileExists(dest))) {
                return createAsset()
            }

            return { filePath: payload.filePath, sourceHash: payload.sourceHash }
        }
    }

    return { handleAssetRequest }
}

interface Status {
    workingDirectory: string
    startTime?: Date
}

function createStatusRoute(status: Status) {
    return new HttpRoute('/status', async request => {
        const startTime = status.startTime?.getTime()
        const uptime = startTime ? Date.now() - startTime : -1

        return sendResponse(request.response, { workingDirectory: status.workingDirectory, uptime })
    })
}

interface Handlers {
    closure: ReturnType<typeof createClosureRoutes>
    provider: ReturnType<typeof createProviderRoutes>
    asset: ReturnType<typeof createAssetRoute>
}

export async function startService(
    ctx: DeploymentContext,
    rootDir: string,
    port?: number,
    terraformWorkingDirectory = rootDir
) {
    const stateDir = path.join(rootDir, '.state')
    const stateHandler = createStateRoute(stateDir)
    const status = { workingDirectory: rootDir } as Status
    const server = HttpServer.fromRoutes(
        ...stateHandler,
        createStatusRoute(status),
        ...createProviderRoute(ctx, {
            closure: createClosureRoutes(ctx),
            provider: createProviderRoutes(ctx),
            asset: createAssetRoute(ctx, terraformWorkingDirectory)
        }),
    )

    const boundPort = await server.start(port)
    status.startTime = new Date()
    getLogger().log(`Listening to port ${boundPort} at`, rootDir)

    return {
        port: boundPort,
        takeError: (requestId: string) => server.takeError(requestId),
        dispose: () => server.close(),
    }
}

