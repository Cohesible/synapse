import { Bundle, isProd } from 'synapse:lib'
import { CapturedPattern, HttpHandler, HttpFetcher, fetch, TypedRegexp, buildRouteRegexp, HttpError, getContentType, HttpRoute } from 'synapse:http'
import { defineDataSource, isDataPointer } from 'synapse:core'
import { UseServerContext, getObjectId, runWithContext } from './hooks'
import { JSXRuntime } from './runtime'
import { Bucket, CDN } from 'synapse:srl/storage'
import { HttpService } from 'synapse:srl/compute'
import { HostedZone } from 'synapse:srl/net'
import { execSync } from 'node:child_process'

export { useServer } from './hooks'
export { JSXRuntime }

interface JSXElement<
    P = any, 
    T extends string | JSXElementConstructor<P> = string | JSXElementConstructor<P>
> {
    type: T
    props: P
    key: string | null
}

type JSXNode<P = any> = JSXElement<P> | Iterable<JSXElement<P>>

type JSXElementConstructor<P> = ((props: P) => JSXNode<P>) | (new (props: P) => Component)

interface Component {
    render(): JSXElement
}

type FunctionComponent<P = any, C = any, U = any> = (props: P, context?: C) => U
type ComponentType<P = any, C = any> = FunctionComponent<P, C>

interface MountedNode {
    unmount?(): void
}

interface MountOptions {
    rehydrate?: boolean
}

type MountFn = (container: Element | Document, children: JSXNode, opt: MountOptions) => MountedNode
type RenderSyncFn = (node: JSXNode) => string
type RenderStreamFn = (node: JSXNode, opt?: { bootstrapScripts?: string[]} ) => Promise<ReadableStream>

export interface Layout {
    readonly parent?: Layout
    // readonly stylesheet?: Stylesheet
    readonly component: ComponentType<{ children: JSXNode }>
}

export interface Page<T extends Record<string, string> = {}, U = any> {
    readonly layout: Layout
    readonly component: ComponentType<T, U>
}

interface RouteablePage<T extends Record<string, string> = {}> extends Page<T> {
    readonly route: string
}

export interface WebsiteHost {
    readonly url: string

    addAsset(source: string, name?: string, contentType?: string): string

    addPage<T extends string>(route: T, page: Page<CapturedPattern<T>>): RouteablePage<CapturedPattern<T>>
    addPage<T extends string, U>(route: T, page: Page<CapturedPattern<T>, U>, context: U): RouteablePage<CapturedPattern<T>>

    // XXX: having the `string` overload makes things work correctly ???
    addHandler<T extends string, R = unknown>(route: T, handler: HttpHandler<T, string, R>): HttpFetcher<T, string, R>
    addHandler<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R>): HttpFetcher<T, U, R>

    bind<T extends any[], U>(handler: (...args: T) => Promise<U> | U): (...args: T) => Promise<U>

    addRoute<T extends string, R = unknown>(route: T, handler: HttpHandler<T, string, R>): HttpRoute<[string], R>
    addRoute<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R>): HttpRoute<[request: U], R>
}

interface WebsiteHostProps {
    readonly domain?: HostedZone
    readonly useCdn?: boolean
    readonly defaultRoot?: string
}

// Reserved paths:
// _assets
// _api

function finalizePage<T extends Record<string, string>, U>(page: Page<T, U>, context: U) {
    const components: ComponentType[] = []
    let layout: Layout | undefined = page.layout
    while (layout) {
        components.push(layout.component)
        layout = layout.parent
    }

    const initComponent = page.component
    return function (props: T) {
        return components.reduceRight((a, b) => b({ children: a }), initComponent(props, context))
    }

    // return function (props: T) {
    //     const children = components.reduceRight((a, b) => b({ children: a }), initComponent(props))

    //     return instantiate(context.Provider, {
    //         children,
    //         value: contextVal, 
    //     })
    // }
}

const renderComponent = defineDataSource(async ({ render, component, footer }: { render: RenderSyncFn, component: ComponentType, footer: string }) => {
    const rendered = render(component({}))

    // XXX: very bad
    return '<!DOCTYPE html>\n' + rendered.replace(/<\/head>/, `${footer}$&`)
})

function getBody(node: JSXNode) {
    if (Symbol.iterator in node) {
        throw new Error(`Unexpected fragment`)
    }

    const children = node.props.children
    if (Array.isArray(children)) {
        const b = children.find(x => x.type === 'body')
        if (!b) {
            throw new Error('No body found')
        }
        return b
    }

    if (children?.type !== 'body') {
        throw new Error('Missing body')
    }

    return children
}

declare var __deployTarget: string | undefined
function isDev() {
    if (typeof __deployTarget === 'undefined') {
        return false
    }

    return __deployTarget === 'local'
}

function createEntrypoint<T extends Record<string, string>, U>(
    runtime: JSXRuntime<U>,
    page: FunctionComponent<T, any, U>, 
    routePattern: TypedRegexp<T>,
    addAsset: WebsiteHost['addAsset'],
    hostBind: WebsiteHost['bind'],
) {
    const mount = runtime.mount
    const render = runtime.render as RenderSyncFn

    function entrypoint() {
        const match = routePattern.exec(window.location.pathname)
        if (!match) {
            throw new Error(`Invalid route`)
        }

        const node = page(match.groups)
        const body = getBody(node as JSXNode)
        mount(document.body, body.props.children, { rehydrate: true })
    }

    bindFunctions(hostBind, addAsset, entrypoint)

    const artifact = new Bundle(entrypoint, {
        moduleTarget: 'esm',
        platform: 'browser', 
        immediatelyInvoke: true,
        minify: isProd(),
    })

    const entrypointPath = addAsset(artifact.destination, undefined, 'text/javascript')

    // The dummy script tag is to prevent a weird FireFox bug causing content to flash
    const footer = `
<script>0</script>
<script type="module" src="${entrypointPath}" async=""></script>
`

    return renderComponent({ render, component: page, footer })
}

function createStreamedEntrypoint<T extends Record<string, string>, U>(
    runtime: JSXRuntime<U>,
    page: FunctionComponent<T, any, U>, 
    routePattern: TypedRegexp<T>,
    addAsset: WebsiteHost['addAsset'],
    hostBind: WebsiteHost['bind'],
    injectLocalhostWebsocket = isDev()
) {
    const mount = runtime.mount
    const render = runtime.renderStream!

    function entrypoint() {
        const match = routePattern.exec(window.location.pathname)
        if (!match) {
            throw new Error(`Invalid route`)
        }

        mount(document, page(match.groups), { rehydrate: true })

        if (injectLocalhostWebsocket) {
            const ws = new WebSocket(`ws://${location.host}`)
            ws.onmessage = async ev => {
                const msg = JSON.parse(ev.data)
                if (msg.type === 'reload') {
                    setTimeout(() => location.reload(), msg.delay ?? 0)
                }
            }
        }
    }

    bindFunctions(hostBind, addAsset, entrypoint)

    const artifact = new Bundle(entrypoint, {
        moduleTarget: 'esm',
        platform: 'browser', 
        immediatelyInvoke: true,
        minify: process.env.NODE_ENV === 'production',
    })

    const entrypointPath = addAsset(artifact.destination, undefined, 'text/javascript')
    const bootstrapScripts = [entrypointPath]

    return async function(props: T, useServerContext: UseServerContext) {
        const rendered = await runWithContext(useServerContext, () => render(page(props), { bootstrapScripts }))

        return rendered
    }
}

// Marker for any functions passed to `useServer`
const useServerFlag = Symbol.for('synapse.useServer')
const browserImpl = Symbol.for('synapse.browserImpl')
const moveable = Symbol.for('__moveable__')
const bound = Symbol('boundToWebsite')
const boundFunctions = new Map<Function, Function>()
function bindFunctions(hostBind: WebsiteHost['bind'], addAsset: WebsiteHost['addAsset'], target: any) {
    if (boundFunctions.has(target)) {
        return boundFunctions.get(target)!
    }

    if (typeof target === 'function' && useServerFlag in target) {
        const fn = hostBind(target)
        boundFunctions.set(target, fn)
        Object.assign(target, { [browserImpl]: fn })

        return fn
    }

    if (typeof target === 'function' && moveable in target) {
        // We don't want to re-bind functions
        if (bound in target) {
            return
        }

        const v = target[moveable]()
        if (v.captured) {
            const last = v.captured.at(-1)
            if (typeof last === 'object' && !!last && last.__synapse_assets__) {
                const replacement: Record<string, string> = {}
                for (const [k2, v2] of Object.entries(last)) {
                    if (!isDataPointer(v2 as any)) continue

                    replacement[k2] = addAsset(v2 as any, undefined, getContentType(k2))
                }

                replaceCapturedAssets(target, v, replacement)
            }

            for (const x of v.captured) {
                bindFunctions(hostBind, addAsset, x)
            }
        }
    }
}

function replaceCapturedAssets(target: any, desc: any, replacement: Record<string, string>) {
    const newCaptured = desc.captured.slice(0, -1)
    newCaptured.push(replacement)

    const newFn = () => {
        return {
            ...desc,
            captured: newCaptured,
        }
    }
    return Object.assign(target, { [moveable]: newFn })
}


// Useful caching directives:
// stale-while-revalidate
// stale-if-error

type RuntimeContext<T> = T extends JSXRuntime<infer _, infer U> ? U : never

export function createWebsiteHost<T>(
    runtime: JSXRuntime<T>,
    props?: WebsiteHostProps
): WebsiteHost {
    const assets = new Bucket()
    const website = new HttpService({ 
        mergeHandlers: true, 
        domain: props?.useCdn ? undefined : props?.domain,
    })

    const defaultPath = website.defaultPath ?? ''
    const cdn = props?.useCdn 
        ? new CDN({ bucket: assets, domain: props.domain, indexKey: props.defaultRoot }) 
        : undefined

    const pageMaxAge = isProd() ? 300 : 10

    if (cdn) {
        cdn.addOrigin({
            origin: website.hostname,
            targetPath: `${defaultPath}/_assets/*`,
            allowedMethods: ['GET', 'HEAD'],
        })

        cdn.addOrigin({
            origin: website.hostname,
            targetPath: `${defaultPath}/_api/*`,
            allowedMethods: ['HEAD', 'DELETE', 'POST', 'GET', 'OPTIONS', 'PUT', 'PATCH'],
        })

        cdn.addOrigin({
            origin: website.hostname,
            targetPath: `/*`,
            originPath: website.defaultPath,
            allowedMethods: ['GET', 'HEAD'],
        })

        const allowedOrigins = new Set([cdn.url, `https://${website.hostname}`])
        if (props?.domain) {
            allowedOrigins.add(`https://${props.domain.name}`)
            if ((cdn as any).resource) {
                allowedOrigins.add(`https://${(cdn as any).resource.domainName}`) // XXX
            }
        }

        const defaultOrigin = props?.domain ? `https://${props.domain.name}` : cdn.url

        website.addRoute(`OPTIONS /{proxy+}`, async req => {
            const origin = req.headers.get('origin')

            return {
                statusCode: 200,
                body: 'OK',
                headers: {
                    'Access-Control-Allow-Headers': 'Authorization, Cookie, Content-Type',
                    'Access-Control-Allow-Origin': !origin || !allowedOrigins.has(origin) ? defaultOrigin : origin,
                    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                    'Content-Type': 'application/json', // ???
                    'Connection': 'Keep-Alive',
                    'Vary': 'Origin',
                }
            }
        })
    }

    const contentTypes: Record<string, string> = {}

    // TODO: optionally include eTag when using aliased assets
    async function getAsset(name: string) {
        const blob = await assets.get(name)

        return new Response(blob, {
            headers: {
                'content-type': contentTypes[name],
                'cache-control': 'max-age=31536000, immutable',
            }
        })
    }

    website.addRoute('GET /_assets/{path+}', async (req) => {
        const pathname = req.pathParameters.path

        return await getAsset(pathname)
    })

    // This route automatically redirects paths with trailing slashes to the normalized path
    website.addRoute('GET {path*}/', req => {
        return new Response(undefined, {
            status: 308,
            headers: new Headers({
                'location': `${defaultPath}${req.pathParameters.path}`
            })
        })
    })

    const getAssetPath = (name: string) => {
        return `${defaultPath}/_assets/${name}`
    }

    function addAsset(source: string, name?: string, contentType = getContentType(source)) {
        const key = assets.addBlob(source, name, contentType)
        contentTypes[key] = contentType

        return getAssetPath(key)
    }

    const hasCdn = !!cdn

    function addPage<T extends string, U>(route: T, page: Page<CapturedPattern<T>, U>, context?: U) {
        const fixedRoute = route === '/' && !props?.domain && website.defaultPath ? '' as T : route

        const fixedRoot = props?.defaultRoot && route === `/${props.defaultRoot}` ? '/' as T : undefined // XXX: big hack to make `/synapse-redirect` work
        const routeRegexp = buildRouteRegexp(fixedRoot ?? fixedRoute, hasCdn ? undefined : defaultPath)
        const finalizedPage = finalizePage(page, context as U)

        // `defaultPath` implies API Gateway atm.
        if (runtime.renderStream && !website.defaultPath) {
            const getStream = createStreamedEntrypoint(runtime, finalizedPage, routeRegexp, addAsset, bind)
            const r = website.addRoute(`GET ${fixedRoute}`, async (req) => {
                const cache = new Map<any, any>()
                const ctx: UseServerContext = { 
                    cache, 
                    handlers: fnMap,
                    onComplete: (key, value, error) => {
                        // Initially a noop because we haven't sent any state to the client
                    }
                }

                const stream = await getStream(req.pathParameters as CapturedPattern<T>, ctx)
                const reader = stream.getReader()

                function serialize(v: any): any {
                    if (v instanceof Map) {
                        return [
                            '__MAP__',
                            ...[...v].map(([k, v]) => [k, serialize(v)])
                        ]
                    }

                    if (v instanceof Promise && 'status' in v) {
                        if (v.status === 'pending') {
                            return 'PROMISE_PENDING'
                        } else if (v.status === 'rejected') {
                            const reason = (v as any).reason as Error
                            return { __type: 'SERVER_EXCEPTION', __value: { message: reason.message } }
                        } else if (v.status === 'fulfilled') {
                            return (v as any).value
                        }
                    }

                    return v
                }

                function createCacheUpdate(key: any[], val: any) {
                    return Buffer.from(`<script>globalThis.UPDATE_SERVER_CACHE(${JSON.stringify(key)}, ${JSON.stringify(val)})</script>`)
                }

                // This sends render state over to the client
                function createCacheInjection() {
                    const serialized = JSON.stringify(serialize(cache))
                    const deserialize = `function deserialize(v) { 
                        if (Array.isArray(v) && v[0] === '__MAP__') {
                            return new Map(v.slice(1).map(e => [e[0], deserialize(e[1])]))
                        }
                        return v
                    }`

                    const injectCache = `
                    const cache = deserialize(${serialized})
                    if (!globalThis.USE_SERVER_CACHE) {
                        globalThis.USE_SERVER_CACHE = cache
                    } else {
                        for (const [k, v] of cache) {
                            setCachedItem(k, v)
                        }
                    }
                    function setCachedItem(key, val, c = globalThis.USE_SERVER_CACHE, index = 0) {
                        const k = key[index]
                        if (key.length === index - 1) {
                            c.set(k, val)
                            return val
                        }

                        if (!c.has(k)) {
                            c.set(k, new Map())
                        }

                        return setCachedItem(key, val, c.get(k), index + 1)
                    }
                    globalThis.UPDATE_SERVER_CACHE = setCachedItem
                    `

                    return Buffer.from(`<script>${deserialize}; ${injectCache}</script>`)
                }

                const rs = (require('node:stream/web') as typeof import('node:stream/web')).ReadableStream
                const stream2 = rs.from<Uint8Array>((async function*() {
                    let onComplete: Promise<ReadableStreamReadResult<any>> | undefined
                    function setOnComplete() {
                        onComplete = new Promise((resolve) => {
                            ctx.onComplete = (key, val, err) => {
                                console.log(key, val, err)
                                resolve({
                                    done: false,
                                    value: createCacheUpdate(key, err ?? val),
                                    isOnComplete: true,
                                } as ReadableStreamReadResult<any>)
                                setOnComplete()
                            }
                        })
                    }

                    while (true) {
                        const r = reader.read()
                        const chunk = await (onComplete ? Promise.race([r, onComplete]) : r)
                        if (chunk.done) {
                            break
                        }
                        yield chunk.value
                        if ((chunk as any).isOnComplete) {
                            const chunk = await r
                            if (chunk.done) {
                                break
                            }
                            yield chunk.value
                        }

                        // XXX: hacky!
                        if (!onComplete && cache.size > 0 && Buffer.from(chunk.value).toString().includes('</body></html>')) {
                            yield createCacheInjection()
                            setOnComplete()
                        }
                    }
                })())

                return new Response(stream2 as any, {
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                    }
                })
            })
    
            return {} as any
        }

        const indexText = createEntrypoint(runtime, finalizedPage, routeRegexp, addAsset, bind)

        const r = website.addRoute(`GET ${fixedRoute}`, (req) => {
            return new Response(indexText, {
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': `max-age=${pageMaxAge}`,
                    // TODO: etag
                }
            })
        })

        return {} as any
    }

    const fnMap = new Map<string, Function>()
    // XXX: permissions solver doesn't work on `Map`
    const fnMap2: Record<string, Function> = {}
    const apiRoute = website.addRoute('POST /_api/{id+}', async (req, body: { args: any[] }) => {
        const { id } = req.pathParameters
        const handler = fnMap2[id]
        if (!handler) {
            throw new HttpError('No handler found', { statusCode: 404 })
        }

        return handler(...body.args)
    })

    function bind<T extends any[], U>(handler: (...args: T) => Promise<U> | U): (...args: T) => Promise<U> {
        let fnId: string
        const fn = (...args: any[]) => fetch(apiRoute, fnId, { args })

        fnId = getObjectId(fn)
        fnMap.set(fnId, handler)
        fnMap2[fnId] = handler

        // XXX: needed because the server has a ref to `handler` instead of `fn`
        // The original impl. used `fn` for both 
        Object.assign(handler, { [Symbol.for('synapse.objectId')]: fnId })
        Object.assign(fn, { [bound]: true })

        return fn as any
    }

    function addHandler<T extends string, R = unknown>(route: T, handler: HttpHandler<T, string, R>): HttpFetcher<T, string, R>
    function addHandler<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R>): HttpFetcher<T, U, R>
    function addHandler<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R> | HttpHandler<T, string, R>) {
        const r = website.addRoute(route, handler as any)
        const fn = (...args: any[]) => fetch(r, ...args)
        fnMap.set(getObjectId(fn), handler)

        return fn
    }

    function addRoute<T extends string, R = unknown>(route: T, handler: HttpHandler<T, string, R>): HttpRoute<[string], R>
    function addRoute<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R>): HttpRoute<[request: U], R>
    function addRoute<T extends string, U, R = unknown>(route: T, handler: HttpHandler<T, U, R> | HttpHandler<T, string, R>) {
        return website.addRoute(route, handler as any)
    }

    return {
        url: website.invokeUrl,
        addAsset,
        addPage,
        addHandler,
        addRoute,
        bind,
    }
}

export async function openBrowser(url: string) {
    if (process.platform === 'win32') {
        try {
            execSync(`explorer "${url}"`)
        } catch (e) {
            // This succeeds with exit code 1 on Windows for some reason
            if ((e as any).exitCode !== 1) {

            }
        }
    } else if (process.platform === 'darwin') {
        execSync(`open "${url}"`)
    } else if (process.platform === 'linux') {
        // TODO: not all distros will have `xdg-utils`
        execSync(`xdg-open "${url}"`)

        // Other options
        //  sensible-browser
        //  x-www-browser
        //  gnome-open

        // Can also try different vendor executables e.g. `firefox`
    }
}
