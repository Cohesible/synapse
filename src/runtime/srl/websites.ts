///# moduleId = synapse:srl/websites

import { HttpHandler, HttpFetcher, CapturedPattern } from 'synapse:http'
import { HostedZone } from 'synapse:srl/net'


export interface JSXElement<
    P = any, 
    T extends string | JSXElementConstructor<P> = string | JSXElementConstructor<P>
> {
    type: T
    props: P
    key: string | null
}

export type JSXNode<P = any> = JSXElement<P> | Iterable<JSXElement<P>>

type JSXElementConstructor<P> = ((props: P) => JSXNode<P>) | (new (props: P) => Component)

interface Component {
    render(): JSXElement
}

type FunctionComponent<P = any, C = any, U = any> = (props: P, context?: C) => U
// type ComponentType<P = any> = (new (props: P) => Component) | FunctionComponent<P>
type ComponentType<P = any, C = any> = FunctionComponent<P, C>

export interface Layout {
    readonly parent?: Layout
    // readonly stylesheet?: Stylesheet
    readonly component: ComponentType<{ children: JSXNode }>
}

export interface Page<T extends Record<string, string> = {}, U = any> {
    readonly layout: Layout
    readonly component: ComponentType<T, U>
}

export interface RouteablePage<T extends Record<string, string> = {}> extends Page<T> {
    readonly route: string
}

//# resource = true
export declare class Website {
    readonly url: string
    constructor(options?: { domain?: HostedZone })

    addAsset(source: string, name?: string, contentType?: string): string

    addPage<T extends string>(route: T, page: Page<CapturedPattern<T>>): RouteablePage<CapturedPattern<T>>
    addPage<T extends string, U>(route: T, page: Page<CapturedPattern<T>, U>, context: U): RouteablePage<CapturedPattern<T>>

    // XXX: having the `string` overload makes things work correctly ???
    addHandler<T extends string, R = unknown>(route: T, handler: HttpHandler<T, string, R>): HttpFetcher<T, string, R>
    addHandler<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R>): HttpFetcher<T, U, R>

    bind<T extends any[], U>(handler: (...args: T) => Promise<U> | U): (...args: T) => Promise<U>
}
