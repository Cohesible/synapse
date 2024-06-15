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
type Authorization = () => Promise<string>

type Promisify<T> = { [P in keyof T]: T[P] extends (...args: infer U) => infer R 
    ? R extends Promise<infer _> ? T[P]
    : (...args: U) => Promise<R> : T[P]
}

export type Client<T> = Omit<T, keyof Service>

/**
 * `Service` is distinct from a normal class in that it creates
 * a "boundary" between external consumers and its internals. 
 * 
 * Normally a class is serialized in its entirety across all consumers, 
 * which may be problematic when embedded in client-side applications.
 */
export abstract class Service<T = void> {
    private authorizer?: Authorizer<this, T>
    private authorization?:  () => Promise<string> | string
    protected readonly context!: T

    public constructor() {
        this.init()
    }

    public addAuthorizer(authorizer: Authorizer<this, T>) {
        this.authorizer = authorizer
    }

    public setAuthorization(authorization: () => Promise<string> | string) {
        this.authorization = authorization
    }

    private init() {
        // TODO: recursively do this operation until reaching `Service` as the proto
        const proto = Object.getPrototypeOf(this)
        const descriptors = Object.getOwnPropertyDescriptors(proto)
        const client: Record<string, any> = {}

        // XXX: a bit hacky. We use `defer` here because instance fields won't be initialized
        // until after `init` returns. Normally it would be ok to capture `this` directly but
        // in this case we cannot because we are essentially overriding the methods on the 
        // instance. So we have to capture things indirectly instead.
        core.defer(() => {
            const service = new compute.HttpService({ 
                mergeHandlers: true, 
                auth: this.authorizer ? 'none' : 'native',
            })

            const ctor = proto.constructor
            const self: Record<string, any> = {}
            for (const [k, v] of Object.entries(this)) {
                if (k in descriptors) continue
                self[k] = v
            }

            let authz = this.authorization
            async function getAuthorization() {
                if (!authz) {
                    throw new Error(`No credentials available`)
                }

                return await authz()
            }
            
            client['setAuthorization'] = (fn:  () => Promise<string> | string) => void (authz = fn)

            for (const [k, v] of Object.entries(descriptors)) {
                if (k !== 'constructor' && typeof v.value === 'function') {
                    const route = service.addRoute(`POST /__rpc/${k}`, async (req, body: { args: any[] }) => {
                        const args = body.args
                        if (self.authorizer) {
                            const authorization = req.headers.get('authorization')
                            if (!authorization) {
                                throw new HttpError('Missing `Authorization` header', { statusCode: 401 })
                            }

                            const context = await self.authorizer(authorization, { method: k, args })
                            const withContext = Object.assign({ context }, self)
                            Object.setPrototypeOf(withContext, ctor.prototype) // FIXME: can we skip doing this somehow?

                            return ctor.prototype[k].call(withContext, ...args)
                        }

                        Object.setPrototypeOf(self, ctor.prototype) // FIXME: can we skip doing this somehow?

                        return ctor.prototype[k].call(self, ...args)
                    })

                    // Backwards compat
                    service.addRoute(`POST /Default/__rpc/${k}`, async (req, body: { args: any[] }) => {
                        const args = body.args
                        if (self.authorizer) {
                            const authorization = req.headers.get('authorization')
                            if (!authorization) {
                                throw new HttpError('Missing `Authorization` header', { statusCode: 401 })
                            }

                            const context = await self.authorizer(authorization, { method: k, args })
                            const withContext = Object.assign({ context }, self)
                            Object.setPrototypeOf(withContext, ctor.prototype) // FIXME: can we skip doing this somehow?

                            return ctor.prototype[k].call(withContext, ...args)
                        }

                        Object.setPrototypeOf(self, ctor.prototype) // FIXME: can we skip doing this somehow?

                        return ctor.prototype[k].call(self, ...args)
                    })
    
                    if (this.authorizer) {
                        client[k] = async (...args: any[]) => {
                            const authorization = await getAuthorization()
                            const fetcher = createFetcher({ headers: { authorization } })

                            return fetcher.fetch(route, { args } as any)
                        }
                    } else {
                        client[k] = (...args: any[]) => service.callOperation(route, { args } as any)
                    }
                }
            }

            Object.assign(this, client)
        })
    }
}

export type Client2<T> = Promisify<Omit<T, keyof Service2>>

export interface ClientConfig {
    authorization?: () => Promise<string> | string
}

function createClientClass<T>(routes: Record<string, HttpRoute>): new (config?: ClientConfig) => Client2<T> {
    class Client {
        constructor(config?: ClientConfig) {
            for (const [k, route] of Object.entries(routes)) {
                (this as any)[k] = async (...args: any[]) => {
                    const authorization = await config?.authorization?.()
                    const fetcher = createFetcher(authorization ? { headers: { authorization } } : undefined)
    
                    return fetcher.fetch(route, { args } as any)
                }
            }
        }
    }

    // TODO: serializing fails for class expressions in return statements
    return Client as any
}

interface ServiceOptions {
    readonly domain?: net.HostedZone
}

export abstract class Service2<T = void> {
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