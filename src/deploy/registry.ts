import { randomUUID } from 'node:crypto'
import { memoize } from '../utils'
import { DeploymentContext, ProviderRequest, assertNotData, loadPointer, loadPointerFromCtx } from './server'
import type { TfState } from './state'
import { getSynapseResourceInput, getSynapseResourceOutput, getSynapseResourceType } from './deployment'

export interface ServiceProvider<T = any> {
    readonly kind: string
    load(id: string, config: T): Promise<void> | void
    unload(id: string): Promise<void> | void
}


export const getServiceRegistry = memoize(createServiceRegistry)
export const apiRegistrationResourceType = 'ApiRegistration'

function createServiceRegistry() {
    const services = new Map<string, ServiceProvider>()
    const registered = new Map<string, any>()

    function getServiceProvider(kind: string) {
        const provider = services.get(kind)
        if (!provider) {
            throw new Error(`Missing service for API handler: ${kind}`)
        }
        return provider
    }

    function registerServiceProvider(provider: ServiceProvider) {
        if (services.has(provider.kind)) {
            throw new Error(`Service already registered: ${provider.kind}`)
        }
        services.set(provider.kind, provider)
    }

    async function setRegistration(id: string, kind: string, config: any) {
        const provider = getServiceProvider(kind)
        await provider.load(id, config)
        registered.set(id, config)
    }

    async function deleteRegistration(id: string, kind: string) {
        if (!registered.has(id)) {
            return
        }

        const provider = getServiceProvider(kind)
        await provider.unload(id)
        registered.delete(id)
    }

    async function createRegistration(ctx: DeploymentContext, request: ProviderRequest & { operation: 'create' } ) {
        const id = randomUUID()
        const config = await loadPointer(ctx.createModuleLoader(), request.plannedState.config)
        await setRegistration(id, request.plannedState.kind, config)

        return { id }
    }

    async function handleRequest(ctx: DeploymentContext, request: ProviderRequest) {
        assertNotData(request.operation)

        switch (request.operation) {
            case 'create':
                return createRegistration(ctx, request)

            case 'update': 
                const id = request.priorState.id
                const config = await loadPointer(ctx.createModuleLoader(), request.plannedState.config)
                await deleteRegistration(id, request.priorInput.kind)
                await setRegistration(id, request.plannedState.kind, config)

                return { id }

            case 'delete': 
                return deleteRegistration(request.priorState.id, request.priorInput.kind)

            case 'read':
                return request.priorState
        }
    }

    async function loadFromState(ctx: DeploymentContext, state: TfState) {
        const resources = state.resources
            .filter(x => getSynapseResourceType(x) === apiRegistrationResourceType)
            .map(x => [getSynapseResourceOutput(x).id, getSynapseResourceInput(x)])

        const promises: Promise<void>[] = []
        for (const [id, { kind, config }] of resources) {
            async function doResolve() {
                const resolved = await loadPointerFromCtx(ctx, id, config)
                await setRegistration(id, kind, resolved)
            }
            promises.push(doResolve())
        }
        await Promise.all(promises)
    }

    return {
        handleRequest,
        registerServiceProvider,

        loadFromState,
    }
}
