import { getServiceRegistry, ServiceProvider } from '../deploy/registry'
import type { TfResource, TfState } from '../deploy/state'
import type { LogProviderProps, LogQuery, LogEvent } from '../runtime/modules/core'
import { normalizeTerraform } from '../runtime/modules/serdes'
import { memoize } from '../utils'
import { getSynapseResourceInput, getSynapseResourceOutput, getSynapseResourceType, mapResource } from '../deploy/deployment'
import { getLogger } from '../logging'

interface ExtendedLogQuery extends LogQuery {
    readonly resourceName?: string
    readonly resourceType?: string
    readonly targets?: string[]
    readonly includeSystem?: boolean
}

interface LogEventWithResource extends LogEvent {
    readonly resourceId: string
}

function createLogService() {
    const providers = new Map<string, LogProviderProps>()

    function getResourceTypeAndState(r: TfResource) {
        const subtype = getSynapseResourceType(r)
        if (!subtype) {
            return {
                type: r.type,
                state: normalizeTerraform(r.state.attributes),
            }
        }

        if (subtype !== 'Custom') {
            return {
                type: `${r.type}.${subtype}`,
                state: getSynapseResourceOutput(r),
            }
        }

        const usertype = getSynapseResourceInput(r).type

        return {
            type: `${r.type}.${subtype}.${usertype}`,
            state: getSynapseResourceOutput(r),
        }
    }

    async function queryLogs(state: TfState, query: ExtendedLogQuery) {
        const typeToFn = new Map<string, LogProviderProps['queryLogs']>()
        for (const [k, v] of providers) {
            typeToFn.set(v.resourceType, v.queryLogs)
        }

        const res: Record<string, { state: any; queryFn: LogProviderProps['queryLogs'] }> = {}
        for (const r of state.resources) {
            if (query.resourceName && !r.name.startsWith(query.resourceName)) {
                continue
            }

            if (query.targets && !query.targets.includes(`${r.type}.${r.name}`)) {
                continue
            }

            const typeAndState = getResourceTypeAndState(mapResource(r)!)
            if (query.resourceType && !typeAndState.type.startsWith(query.resourceType)) {
                continue
            }

            const queryFn = typeToFn.get(typeAndState.type)
            if (queryFn) {
                res[`${r.type}.${r.name}`] = {
                    queryFn,
                    state: typeAndState.state,
                }
            }
        }

        async function doQuery(resourceId: string) {
            const val = res[resourceId]
            if (!val) {
                throw new Error(`Missing query provider for resource: ${resourceId}`)
            }

            const resp = await val.queryFn(val.state, query)
            const addResource = (events: LogEvent[]) => events.map(ev => ({
                resourceId,
                ...ev,
            }))

            if (Array.isArray(resp)) {
                return addResource(resp)
            }

            const events: LogEventWithResource[] = []
            for await (const page of resp) {
                events.push(...addResource(page))
            }
            return events
        }

        const queries: Promise<LogEventWithResource[] | void>[] = []
        for (const [k, v] of Object.entries(res)) {
            const eventsPromise = doQuery(k).catch(e => {
                getLogger().warn(`Failed to get logs from resource "${k}"`, e)
            })
            queries.push(eventsPromise)
        }

        const events: LogEventWithResource[] = []
        for (const query of queries) {
            const result = await query
            if (result) {
                events.push(...result)
            }
        }

        if (!query.includeSystem) {
            return events.filter(x => x.sourceType !== 'system')
        }

        return events
    }

    function _getBinding(): ServiceProvider<LogProviderProps> {
        return {
            kind: 'log-provider',
            load: (id, config) => void providers.set(id, config),
            unload: (id) => void providers.delete(id),
        }
    }

    return {
        queryLogs,
        _getBinding,
    }
}

export const getLogService = memoize(createLogService)

getServiceRegistry().registerServiceProvider(
    getLogService()._getBinding()
)


export function formatEvents(events: LogEventWithResource[]) {
    function getTime(timestamp: string | number) {
        if (typeof timestamp === 'number') {
            return timestamp
        }

        return new Date(timestamp).getTime()
    }

    events.sort((a, b) => getTime(a.timestamp) - getTime(b.timestamp))

    return events.map(ev => {
        if (typeof ev.data === 'string') {
            return ev.data
        } else if ('message' in ev.data && typeof ev.data.message === 'string') {
            return ev.data.message
        }

        throw new Error(`Object-based log event messages not yet supported`)
    }).join('\n')
}
