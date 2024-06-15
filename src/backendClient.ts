import * as secrets from './services/secrets/index'
import type { BackendClient } from './runtime/modules/core'
import { getExecutionId } from './execution'
import { processes } from '@cohesible/resources'
import { readState } from './artifacts'
import { getAuthClient } from './auth'
import { getLogger } from '.'
import { mapResource } from './deploy/deployment'

type ModulePointer<T extends object = Record<string, unknown>> = T | string  

export type AuthSource = ModulePointer<{ default: (workspace: string, branch?: string) => Credentials | Promise<Credentials> }>
export type LoadedBackendClient = ReturnType<typeof getBackendClient>


function getBootstrapClient() {
    const serverAddr = 'http://localhost:8681'
    const localClient: BackendClient = {
        config: {} as any,
        getMissingArtifacts: async () => ({ missing: [] }),
        getManifest: async () => ({ artifacts: {} }),
        putManifest: async () => {},
        putArtifactsBatch: async () => {},
        getArtifactsBatch: async () => ({}),
        getSecret: async (type: string) => {
            const envVar = type.toUpperCase().replaceAll('-', '_')
            if (process.env[envVar]) {
                return { value: process.env[envVar] }
            }

            throw new Error(`No secret found: ${type}`)
        },
    } as any

    return Object.assign(localClient, {
        getState: async (id: string) => {
            // XXX: horrible horrible hack
            if (id.endsWith('--lib--Bundle')) {
                id += '--Closure'
            }

            getLogger().log(`Getting state for resource`, id)
            const state = await readState()
            const r = state?.resources?.find(x => id === `${x.type}.${x.name}`)
            const s = r ? mapResource(r)?.state.attributes : undefined
            if (!s) {
                return
            }

            return r!.type === 'synapse_resource' ? s.output.value : s
        },
        getToolDownloadUrl: async () => {
            return {} as any
        },
        getCredentials: async () => ({
            token: '',
            expirationEpoch: 0,
        }) as any,
        config: {
            address: serverAddr,
        } as any,
    })
}

function _getClient() {
    processes.client.getState

    const identityClient = getAuthClient()

    return {
        ...identityClient,
        getSecret: secrets.getSecret,
    } as any as BackendClient
}

function _createBackendClient() {
    const client = _getClient()

    async function getToolDownloadUrl(type: string, opt?: { os?: string; arch?: string; version?: string }) {
        throw new Error('Not implemented')
    }

    return Object.assign(client, { 
        getToolDownloadUrl,
        getSecret: (type: string) => {
            const envVar = type.toUpperCase().replaceAll('-', '_')
            if (process.env[envVar]) {
                return { value: process.env[envVar] }
            }

            return client.getSecret(type)
        }
    })
}

const clients: Record<string, ReturnType<typeof _createBackendClient>> = {}
export function getBackendClient() {
    const k = getExecutionId()
    if (clients[k]) {
        return clients[k]
    }

    try {
        return clients[k] = _createBackendClient()
    } catch {
        return clients[k] = getBootstrapClient()
    }
}


interface Credentials {
    token: string
    expirationEpoch: number
}

