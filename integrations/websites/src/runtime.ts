interface JSXElement<
    P = any, 
    T extends string | JSXElementConstructor<P> = string | JSXElementConstructor<P>
> {
    type: T
    props: P
    key: string | null
}

type JSXNode<P = any> = JSXElement<P> | Iterable<JSXElement<P>>

type JSXElementConstructor<P> = (props?: P) => JSXNode<P>

interface Component {
    render(): JSXElement
}

type FunctionComponent<P = any> = (props: P) => JSXNode<P>
export type ComponentType<P = any> = (new (props: P) => Component) | FunctionComponent<P>

const classSymbol = Symbol('__class__')
function isClass<P>(target: ComponentType<P>): target is new (props: P) => Component {
    const v = (target as any)[classSymbol]
    if (v !== undefined) {
        return v
    }

    const props = Object.getOwnPropertyNames(target)
    const isFunction = props.includes('arguments') || !props.includes('prototype')

    return (target as any)[classSymbol] = !isFunction
}

export function instantiate<P>(component: ComponentType<P>, props: P) {
    if (isClass(component)) {
        return new component(props)
    }

    return component(props)
}

interface MountedNode {
    unmount?(): void
}

interface MountOptions {
    rehydrate?: boolean
}

// TODO: combine 'render' functions into one
// we should decide what to do based off the return value
type MountFn<T = JSXNode> = (container: Element | Document, children: T, opt: MountOptions) => MountedNode | void
type RenderFn<T = JSXNode> = (node: T) => Promise<string> | string
type RenderStreamFn<T = JSXNode> = (node: T, opt?: { bootstrapScripts?: string[]} ) => Promise<ReadableStream>
type CreateElement = (type: string | JSXElementConstructor<any>, props?: any, ...children: JSXElement[]) => JSXElement

export interface JSXContext<T = any, U = JSXNode> {
    readonly Provider: ComponentType<{ value: T; children: U }>
    readonly Consumer: ComponentType<{ children: (value: T) => U }> 
}

export interface JSXRuntime<T = JSXNode, U = JSXContext<any, T>> {
    readonly createElement: CreateElement
    readonly mount: MountFn<T>
    readonly render: RenderFn<T>
    // readonly createContext: (value: any) => U 
    readonly renderStream?: RenderStreamFn<T>
}
