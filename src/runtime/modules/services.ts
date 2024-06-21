//@internal
//# moduleId = synapse:services
//# transform = persist

import * as core from 'synapse:core'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import { HttpRoute, PathArgs, HttpError, HttpHandler, createFetcher } from 'synapse:http'

type ServiceRequest<T> = { 
    [P in keyof T]: T[P] extends (...args: infer U) => any 
        ? { method: P; args: U } 
        : never 
}[keyof T]

type Authorizer<T, R = void> = (authorization: string, request: ServiceRequest<T>) => Promise<R> | R

type Promisify<T> = { [P in keyof T]: T[P] extends (...args: infer U) => infer R 
    ? R extends Promise<infer _> ? T[P]
    : (...args: U) => Promise<R> : T[P]
}

export type Client<T> = Promisify<Omit<T, keyof Service>>

export interface ClientConfig {
    authorization?: () => Promise<string> | string
}

// We currently capture declared symbols but we don't want that here
// So this is a way to use `core.defer` without capturing it
const container = { defer: core.defer as typeof core.defer | undefined }
core.defer(() => (delete container.defer))

function createClientClass<T>(routes: Record<string, HttpRoute>): new (config?: ClientConfig) => Client<T> {
    class Client {
        constructor(config?: ClientConfig) {
            const init = () => {
                for (const [k, route] of Object.entries(routes)) {
                    (this as any)[k] = async (...args: any[]) => {
                        const authorization = await config?.authorization?.()
                        const fetcher = createFetcher(authorization ? { headers: { authorization } } : undefined)
        
                        return fetcher.fetch(route, { args } as any)
                    }
                }
            }

            // We need to use `defer` here because `routes` is also deferred
            if (container.defer !== undefined) {
                container.defer(init)
            } else {
                init()
            }
        }
    }

    // TODO: serializing fails for class expressions in return statements
    return Client as any
}

interface ServiceOptions {
    readonly domain?: net.HostedZone
}

export abstract class Service<T = void> {
    #authorizer?: Authorizer<this, T>
    protected readonly context!: T

    public constructor(opt?: ServiceOptions) {
        this.init(opt)
    }

    public addAuthorizer(authorizer: Authorizer<this, T>) {
        this.#authorizer = authorizer
    }

    readonly #routes: Record<string, HttpRoute> = {}

    private init(opt?: ServiceOptions) {
        // TODO: recursively do this operation until reaching `Service` as the proto
        const proto = Object.getPrototypeOf(this)
        const ctor = proto.constructor
        const descriptors = Object.getOwnPropertyDescriptors(proto)

        // `defer` is needed to allow the authorizer to be set
        core.defer(() => {
            const authorizer = this.#authorizer
            const service = new compute.HttpService({
                domain: opt?.domain,
                auth: authorizer ? 'none' : 'native',
            })

            for (const [k, v] of Object.entries(descriptors)) {
                // Private methods
                if (k.startsWith('_')) continue
                if (k === 'constructor' || typeof v.value !== 'function') continue

                const route = service.addRoute(`POST /__rpc/${k}`, async (req, body: { args: any[] }) => {
                    const args = body.args
                    if (authorizer) {
                        const authorization = req.headers.get('authorization')
                        if (!authorization) {
                            throw new HttpError('Missing `Authorization` header', { statusCode: 401 })
                        }

                        const context = await authorizer(authorization, { method: k, args } as any)
                        Object.assign(this, { context })

                        return ctor.prototype[k].call(this, ...args)
                    }

                    return ctor.prototype[k].call(this, ...args)
                })

                this.#routes[k] = route
            }
        })
    }

    public createClientClass(): ReturnType<typeof createClientClass<this>> {       
        return createClientClass(this.#routes)
    }
}

type GetContext<T> = T extends Service<infer U> ? U : never

function addHttpRoute<T extends Service, U extends string = string, R = unknown>(
    target: T, 
    route: U, 
    handler: HttpHandler<U, string, R, T & { context: GetContext<T> }>
): HttpRoute<[...PathArgs<U>, string], R> {
    throw new Error('TODO')
}

export function registerSecretProvider(secretType: string, provider: core.SecretProvider) {
    new core.SecretProvider2({
        secretType,
        getSecret: () => provider.getSecret(),
    })
}

export const getSecret = core.defineDataSource(async (secretType: string) => {
    const client = core.getBackendClient()
    const secret = await client.getSecret(secretType)

    return secret
})

interface IdentityProviderRegistrationProps {
    name?: string
    type: string
    authenticate: compute.Function<Parameters<core.AuthenticateFn>, Awaited<ReturnType<core.AuthenticateFn>>>
    startAuthentication: compute.Function<Parameters<core.StartAuthenticationFn>, Awaited<ReturnType<core.StartAuthenticationFn>>>
}

class IdentityProviderRegistration extends core.defineResource({
    create: async (props: IdentityProviderRegistrationProps) => {
        const client = core.getBackendClient()
        const resp = await client.createIdentityProvider(props)

        return {
            providerId: resp.id,
            providerType: props.type,
        }
    },
    delete: async (state) => {
        const client = core.getBackendClient()
        await client.deleteIdentityProvider(state.providerId)
    }
}) {}

interface IdentityProvider {
    name?: string
    type: string
    authenticate: core.AuthenticateFn
    startAuthentication: core.StartAuthenticationFn
}

export function registerIdentityProvider(idp: IdentityProvider) {
    const authenticate = new compute.Function(idp.authenticate)
    const startAuthentication = new compute.Function(idp.startAuthentication)
    const registration = new IdentityProviderRegistration({
        ...idp,
        authenticate,
        startAuthentication,
    })

    return registration
}