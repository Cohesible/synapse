//# moduleId = synapse:srl/compute

import { HttpRequest, HttpResponse, HttpRoute, PathArgs, RequestHandler, RequestHandlerWithBody, PathArgsWithBody } from 'synapse:http'
// import { WebSocket } from 'synapse:ws'
import { HostedZone, Network } from 'synapse:srl/net'

//# resource = true
/** @internal */
export declare class Host {
    constructor(network: Network, target: () => Promise<void> | void , key?: KeyPair)
    // ssh(user: string, keyPath: string): Promise<import("child_process").ChildProcess>
}

//# resource = true
/** @internal */
export declare class KeyPair {
    public constructor(publicKey: string)
}

// XXX: `opt.createImage` and `opt.imageCommands` is an experiment
export interface FunctionOptions {
    /** @internal */
    network?: Network // TODO: `Network` should be apart of the context
    /** @internal */
    createImage?: boolean
    /** @internal */
    imageCommands?: string[]
    external?: string[]
    /** @internal */
    memory?: number // Vendor option?
    timeout?: number
    /** @internal */
    reservedConcurrency?: number, // Vendor option
    /** @internal */
    ephemeralStorage?: number // Vendor option
}

//# resource = true
//# callable = invoke
export declare class Function<T extends any[] = any[], U = unknown> { 
    constructor(fn: (...args: T) => Promise<U> | U, opts?: FunctionOptions)
    invoke(...args: T): Promise<U>
    invokeAsync(...args: T): Promise<void> 
}

export interface Function<T extends any[] = any[], U = unknown> {
    (...args: T): Promise<U>
}

export interface HttpServiceOptions {
    /** 
     * Sets the authorization method for all routes on the service.
     *
     * Can be one of:
     * * `none` - no authorization
     * * `native` - authorizes using the target cloud provider (the default)
     * * A custom function that intercepts the request. Returning nothing passes the request on to the router.
     */
    auth?: 'none' | 'native' | RequestHandlerWithBody<any, any, Response | HttpResponse | undefined>

    /**
     * Uses a custom domain name instead of the one provided by the cloud provider.
     */
    domain?: HostedZone

    /** @internal */
    allowedOrigins?: string[]

    /** @internal */
    mergeHandlers?: boolean
}

// Nonexhaustive
type HttpBodyMethod = 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH'

//# resource = true
export declare class HttpService {
    readonly hostname: string
    readonly invokeUrl: string
    /** @internal */
    readonly defaultPath?: string

    constructor(opt?: HttpServiceOptions)

    /** @internal */
    callOperation<T extends any[], R>(route: HttpRoute<T, R>, ...args: T): Promise<R>

    /** @internal */
    forward(req: HttpRequest, body: any): Promise<HttpResponse> 

    //# resource = true
    route<P extends string = string, R = unknown>(
        method: 'GET',
        path: P,
        handler: RequestHandler<`GET ${P}`, R>
    ): HttpRoute<PathArgs<P>, R>

    //# resource = true
    route<P extends string = string, U = unknown, R = unknown>(
        method: 'ANY',
        path: P,
        handler: RequestHandlerWithBody<`${string} ${P}`, U, R>
    ): HttpRoute<PathArgsWithBody<P, U>, R>

    //# resource = true
    route<P extends string = string, U = unknown, R = unknown, M extends HttpBodyMethod = HttpBodyMethod>(
        method: HttpBodyMethod,
        path: P,
        handler: RequestHandlerWithBody<`${HttpBodyMethod} ${P}`, U, R>
    ): HttpRoute<PathArgsWithBody<P, U>, R>

    //# resource = true
    route<P extends string = string, U = unknown, R = unknown>(
        method: string,
        path: P,
        handler: RequestHandlerWithBody<`${string} ${P}`, U, R>
    ): HttpRoute<PathArgsWithBody<P, U>, R>

    /** TODO */
    // addMiddleware(
    //     middleware: (req: HttpRequest<any>, body: any, next: HttpHandler<any, any>) => HttpResponse | Promise<HttpResponse>
    // ): any
}

/** @internal */
export interface ContainerInstance {
    readonly name: string
    readonly ip: string
    readonly port: number // obviously this is 1:1 w/ a running app
}

//# resource = true
/** @internal */
export declare class Container {
    constructor(network: Network, target: () => Promise<void> | void)
    updateTaskCount(count: number): Promise<void> 
    listInstances(): Promise<ContainerInstance[]>
    //# resource = true
    static fromEntrypoint(network: Network, entrypoint: () => any): Container
    //# resource = true
    static fromDockerfile(network: Network, dockerfile: string): Container
}

interface AsyncDisposable {
    [Symbol.asyncDispose](): PromiseLike<void>
}

/** @internal */
export interface AcquiredLock extends AsyncDisposable {
    readonly id: string
}

//# resource = true
/** @internal */
export declare class SimpleLock {
    lock(id: string): Promise<AcquiredLock>
    unlock(id: string): Promise<void>
}

//# resource = true
/** @internal */
export declare class Website {
    readonly url: string
    constructor(props: { path: string, domain?: HostedZone })
}

//# resource = true
/** @internal */
export declare class Schedule {
    public constructor(expression: string, fn: () => Promise<void> | void)
}

type PromisifyFunction<T> = T extends (...args: infer A) => Promise<infer _> 
        ? T : T extends (...args: infer A) => infer U 
        ? (...args: A) => Promise<U> : T

type Promisify<T> = { [P in keyof T]: PromisifyFunction<T[P]> }

//# resource = true
/**
 * @internal Used internally for registering environment-agnostic API handlers
 */
export declare class SecureService<T> {
    public constructor(obj: T)

    public serialize(): string & { __type?: T }

    public static deserialize<T>(encoded: string & { __type?: T }): Promisify<T>
}
