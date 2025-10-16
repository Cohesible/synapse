import * as core from 'synapse:core'
import { addIndirectRefs } from 'synapse:terraform'
import * as aws from 'terraform-provider:aws'
import * as smithyHttp from '@smithy/protocol-http'
import { URL } from 'node:url'
import { LambdaFunction } from './lambda'
import { signRequest } from '../sigv4'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HostedZone } from './route53'
import { Middleware, RouteRegexp, buildRouteRegexp, matchRoutes, HttpResponse, HttpError, HttpRoute, runWithRequestCtx, getSetCookieHeaders, createPathBindings, applyRoute, compareRoutes, HttpRequest, RequestHandler, RequestHandlerWithBody, PathArgsWithBody } from 'synapse:http'
import { createSerializedPolicy } from './iam'
import { generateIdentifier } from 'synapse:lib'
import * as compute from 'synapse:srl/compute'
import * as net from 'synapse:srl/net'
import { Provider } from '..'
import { addResourceStatement, getPermissionsLater } from '../permissions'

export class Gateway {
    private readonly client = new NodeHttpHandler()
    public readonly id: string
    public readonly region: string
    public readonly hostname: string
    public readonly invokeUrl: string
    public readonly resource: aws.Apigatewayv2Api
    public readonly defaultPath?: string

    private requestRouter?: ReturnType<typeof createRequestRouter> & { fn: LambdaFunction }

    // `network` sets the placement for the compute but not the gateway
    // A network solver becomes desirable to avoid configuration overload.
    // Then users only need to say what should be public. Everything else is private by default.
    public constructor(readonly props?: compute.HttpServiceOptions & { mergeHandlers?: boolean; allowedOrigins?: string[]; network?: net.Network; _lambdaOpt?: any; rateLimiter?: GlobalRateLimiterFn }) {
        const domain = (props?.domain && 'resource' in props.domain) ? props.domain as HostedZone : undefined

        const apig = new aws.Apigatewayv2Api({
            // the below are required without an OpenApi spec
            name: generateIdentifier(aws.Apigatewayv2Api, 'name', 62),
            protocolType: 'HTTP', // | WEBSOCKET

            // TODO: we only want to disable this endpoint for gateways that
            // start with a domain rather than when a domain is added.
            //
            // Otherwise this becomes a backwards incompatible change which we
            // should strive to avoid whenever possible.
            //
            // disableExecuteApiEndpoint: domain !== undefined,
        })

        this.resource = apig
        const stageName: string = '$default'
        const stage = new aws.Apigatewayv2Stage({
            apiId: apig.id,
            // accessLogSettings: {} <-- nice to have
            autoDeploy: true,
            name: stageName, 
        })

        const mergeHandlers = this.props?.mergeHandlers ?? true

        if (domain !== undefined) {
            this.invokeUrl = `https://${addDomain(stage, domain)}`
            this.hostname = domain.name
        } else {
            this.invokeUrl = stage.invokeUrl
            this.hostname = apig.apiEndpoint.replace(/https:\/\//, '')
            this.defaultPath = stageName === '$default' ? undefined : `/${stage.name}`
        }

        const region = new aws.RegionData()

        this.id = apig.arn // TODO: use this form arn:aws:execute-api:${region}:${account}:${api-id}/${stage}/*
        this.region = region.name

        if (mergeHandlers) {
            const router = createRequestRouter(props?.rateLimiter)
            this.requestRouter = {
                ...router,
                fn: this.addRouteInfra('$default', router.routeRequest)
            }

            // if (!domain && typeof this.props?.auth !== 'function') {
            //     const healthCheck = this._addRoute('HEAD', '/__checkEndpoint__', () => {})
            //     // `{ callOperation: this.callOperation.bind(this) }` fails to serialize
            //     // TODO: add way to serialize methods, particularly bound methods
            //     const actualInvokeUrl = this.invokeUrl
            //     const region = this.region
            //     const client = this.client
            //     const sign = this.props?.auth === 'native'
            //     this.invokeUrl = checkEndpoint(healthCheck, {
            //         invokeUrl: actualInvokeUrl,
            //         callOperation: (route, ...args) => {
            //             const { request, body } = applyRoute(route, args)
            //             const url = new URL(`https://${request.host}${request.path}`)

            //             return sendRequest(client, {
            //                 url,
            //                 body,
            //                 sign,
            //                 region,
            //                 method: request.method,
            //             }) as any
            //         },
            //     })
            // }
        }
    }

    private _addRoute(method: string, path: string, handler: RequestHandler | RequestHandlerWithBody) {
        const authHandler = typeof this.props?.auth === 'function' ? this.props.auth : undefined
        const wrapped = wrapRequestHandler(handler, authHandler)

        const route = `${method} ${path}`
        if (this.requestRouter) {
            this.requestRouter.addRoute(route, wrapped)

            getPermissionsLater(wrapped, statements => {
                this.requestRouter!.fn.principal.addPolicy({
                    // [\w+=,.@-]+{1,128}
                    name: `Route-${route.replace(/[\s\/]+/g, '_').replace(/[{}]/g, '')}`,
                    policy: createSerializedPolicy(statements),
                })
            })
        } else {
            this.addRouteInfra(route, wrapped)
        }

        const pathBindings = createPathBindings(path)
        const routeBinding: HttpRoute = {
            host: this.hostname,
            method,
            path: `${this.defaultPath ?? ''}${path}`,
            body: method !== 'GET' ? `$[${pathBindings.length}]` : undefined,
            bindings: { 
                request: [
                    ...pathBindings,
                ],
                response: [] 
            },
        }

        addIndirectRefs(routeBinding, wrapped)

        return routeBinding
    }

    public route<P extends string = string, U = unknown, R = unknown>(
        method: string,
        path: P,
        handler: RequestHandler<`${string} ${P}`, R> | RequestHandlerWithBody<`${string} ${P}`, U, R>
    ): HttpRoute<PathArgsWithBody<P, U>, R> {
        return this._addRoute(method, path, handler)
    }

    private addRouteInfra(route: string, handler: ApiGatewayHandler) {
        const fn = new LambdaFunction(handler, {
            network: this.props?.network,
            ...this.props?._lambdaOpt,
        })

        const integration = new aws.Apigatewayv2Integration({
            apiId: this.resource.id,
            integrationType: 'AWS_PROXY',
            integrationUri: this.props?._lambdaOpt?.provisionedConcurrency
                ? `${fn.resource.arn}:${fn.resource.version}`
                : fn.resource.arn,
            payloadFormatVersion: '2.0',
        })

        new aws.Apigatewayv2Route({
            apiId: this.resource.id,
            routeKey: route,
            target: `integrations/${integration.id}`,
            operationName: route,
            authorizationType: this.props?.auth === 'native' ? 'AWS_IAM' : 'NONE', // 'NONE' | 'AWS_IAM' | 'CUSTOM
        })

        new aws.LambdaPermission({
            functionName: fn.resource.functionName,
            action: "lambda:InvokeFunction",
            principal: "apigateway.amazonaws.com",
            sourceArn: `${this.resource.executionArn}/*/*`,
            qualifier: this.props?._lambdaOpt?.provisionedConcurrency ? fn.resource.version : undefined,
        })

        return fn
    }

    // TODO: making method calls on Gateway to set-up the prototype would be cleaner than re-writing expressions
    // In other words, additive transformations are more robust
    public async callOperation<T extends any[], R>(route: HttpRoute<T, R>, ...args: T): Promise<R> {
        const { request, body } = applyRoute(route, args)

        const resp = await this.request(
            `https://${request.host}${request.path}`, 
            request.method ?? 'GET', 
            body
        )

        const data = resp.body
        if (!data || data === 'null') {
            return undefined as R
        }

        if (resp.headers?.['content-type'] === 'application/json') {
            // I'm pretty sure there's a bug with API gateway and/or Lambda. Returning a string
            // sets the content-type to 'application/json' which causes this to fail.
            return JSON.parse(data) as any
        }

        return data as any
    }

    public async forward(request: HttpRequest, body: any): Promise<HttpResponse> {
        const query = request.queryString
        const resp = await this.request(
            `${this.invokeUrl}${request.path}${query ? `?${query}` : ''}`, 
            request.method ?? 'GET', 
            body,
            request.headers
        )

        return resp
    }
    
    private readonly middleware: Middleware[] = []
    public addMiddleware(middleware: Middleware) {
        this.middleware.push(middleware)
    }

    private async request(path: string, method: string, body?: string | Uint8Array, headers?: HttpRequest['headers']) {
        const url = new URL(path, this.invokeUrl)

        return sendRequest(this.client, {
            url,
            method,
            body,
            headers,
            region: this.region,
            sign: this.props?.auth === 'native',
        })
    }
}

interface RequestContextBase {
    accountId: string
    apiId: string
    authentication?: any
    authorizer?: any
    domainName: string
    domainPrefix: string
    requestId: string
    routeKey: string
    stage: string
    time: string
    timeEpoch: number
    identity?: { 
        sourceIp: string
        userAgent: string
    }
}

interface ApiGatewayRequestPayloadV2 {
    readonly version: '2.0'
    readonly routeKey: string
    readonly rawPath: string
    readonly rawQueryString: string
    readonly cookies?: string[]
    readonly headers: Record<string, string>
    readonly queryStringParameters: Record<string, string>
    readonly requestContext: RequestContextBase & {
        http: {
            method: string
            path: string
            protocol: 'HTTP/1.1'
            sourceIp: string
            userAgent: string
        }
    }
    readonly body?: string
    readonly isBase64Encoded: boolean
    readonly stageVariables: Record<string, string>
    pathParameters: Record<string, string>
}

// For logging
// { "requestId":"$context.requestId", "ip": "$context.identity.sourceIp", "requestTime":"$context.requestTime", "httpMethod":"$context.httpMethod","routeKey":"$context.routeKey", "status":"$context.status","protocol":"$context.protocol", "responseLength":"$context.responseLength", "errorMessage": "$context.error.message" }

const TypedArray = Object.getPrototypeOf(Uint8Array)

async function runHandler<T>(fn: () => Promise<T> | T): Promise<T | HttpResponse> {
    try {
        const resp = await fn()
        const setCookies = getSetCookieHeaders()
        const extraHeaders: Record<string, string> = {}
        if (setCookies && setCookies.length > 0) {
            extraHeaders['set-cookie'] = setCookies[0]
        }

        if (resp instanceof Response) {
            if (resp.headers.get('content-type')?.startsWith('image/')) {
                const body = Buffer.from(await resp.arrayBuffer()).toString('base64')

                return {
                    body,
                    isBase64Encoded: true,
                    statusCode: resp.status,
                    headers: Object.fromEntries(resp.headers.entries()),
                } as any
            }

            const body = resp.body ? await resp.text() : undefined

            return {
                body,
                statusCode: resp.status,
                headers: Object.fromEntries(resp.headers.entries()),
            }
        }

        if (resp === undefined) {
            return { statusCode: 204, headers: extraHeaders }
        }

        if (resp instanceof TypedArray || resp instanceof Blob) {
            const data = resp instanceof Blob ? await resp.arrayBuffer() : resp as any

            return {
                statusCode: 200,
                body: Buffer.from(data).toString('base64'),
                isBase64Encoded: true,
                headers: {
                    'content-type': 'application/octet-stream',
                    ...extraHeaders,
                }
            } as any
        }

        if (typeof resp === 'number' || typeof resp === 'string' || (typeof resp === 'object' && !!resp && typeof (resp as any).statusCode !== 'number')) {
            return {
                body: Buffer.from(JSON.stringify(resp)).toString('utf-8'),
                statusCode: 200,
                headers: {
                    'access-control-allow-origin': '*', // FIXME: use `allowedOrigins` if available
                    'content-type': 'application/json',
                    ...extraHeaders,
                },
            }
        }

        if (setCookies && setCookies.length > 0) {
            return {
                body: Buffer.from(JSON.stringify(resp)).toString('utf-8'),
                statusCode: 200,
                headers: {
                    'content-type': 'application/json',
                    ...extraHeaders,
                },
            }
        }
        
        return resp
    } catch (e) {
        // FIXME: this check doesn't work if the handlers reference `resources.HttpError` because
        // the whole module is captured in that situation vs. only the class here
        if (e instanceof HttpError) {
            return {
                body: JSON.stringify({ message: e.message }),
                statusCode: e.fields.status ?? e.fields.statusCode,
            }
        }

        throw e
    }
}

function isJsonRequest(headers: Record<string, string>) {
    const contentType = headers['content-type'] || headers['Content-Type'] // TODO: check if the headers are already normalized
    if (!contentType) {
        return false
    }

    return !!contentType.match(/application\/(?:([^+\s]+)\+)?json/)
}

function wrapRequestHandler(
    handler: RequestHandler | RequestHandlerWithBody, 
    authHandler?: RequestHandler | RequestHandlerWithBody, 
) {
    async function handleRequest(request: ApiGatewayRequestPayloadV2) {
        const decoded = (request.body !== undefined && request.isBase64Encoded) 
            ? Buffer.from(request.body, 'base64').toString('utf-8') 
            : request.body

        const body = (decoded && isJsonRequest(request.headers)) ? JSON.parse(decoded) : decoded
        const stage = request.requestContext.stage
        const trimmedPath = request.rawPath.replace(`/${stage}`, '')
        const queryString = request.rawQueryString
        const url = new URL(`${trimmedPath}${queryString ? `?${queryString}` : ''}`, `https://${request.headers['host']}`)
        const headers = new Headers(request.headers)
        const method = request.requestContext.http.method
        const reqBody = method === 'GET' || method === 'HEAD' ? undefined : body

        const newReq = new Request(url, {
            headers,
            method,
            body: reqBody,
            duplex: 'half', // specific to node
        } as RequestInit)

        ;(newReq as any)._decoded = decoded // XXX
        ;(newReq as any).cookies = request.cookies
        ;(newReq as any).context = request.requestContext
        ;(newReq as any).pathParameters = request.pathParameters

        const bodyWithFallback = isJsonRequest(request.headers) ? body : newReq.body
        if (authHandler) {
            const resp = await authHandler(newReq as any, bodyWithFallback)
            if (resp !== undefined) {
                return resp
            }
        }

        return handler(newReq as any, bodyWithFallback)
    }

    return handleRequest
}

type GlobalRateLimiterFn = (context: ApiGatewayRequestPayloadV2['requestContext'], cookies?: string[]) => Promise<void | boolean | number | object> | void | boolean | number | object

const canLog = !process.env['SYNAPSE_NO_LOG']

type ApiGatewayHandler = ReturnType<typeof wrapRequestHandler>
function createRequestRouter(rateLimiter?: GlobalRateLimiterFn) {
    interface RouteEntry {
        readonly route: string
        readonly pattern: RouteRegexp<string>
        readonly handler: ApiGatewayHandler
    }

    const routeTable = new Map<string, RouteEntry[]>()
    const mergedRouteTable = new Map<string, [pattern: RouteRegexp<string>, route: RouteEntry][]>()
    function getRouteArray(method: string) {
        let arr = mergedRouteTable.get(method)
        if (!arr) {
            arr = [
                ...(routeTable.get(method) ?? []),
                ...(routeTable.get('ANY') ?? []),
            ].map(e => [e.pattern, e] as [RouteRegexp<string>, RouteEntry])

            arr.sort((a, b) => compareRoutes(b[1].route, a[1].route))

            routeTable.delete(method)
            mergedRouteTable.set(method, arr)
        }
        return arr
    }

    function addRoute(route: string, handler: ApiGatewayHandler) {
        const [method, path] = route.split(' ')
        let routes = routeTable.get(method)
        if (!routes) {
            routeTable.set(method, routes = [])
        }
        routes.push({
            route,
            handler,
            pattern: buildRouteRegexp(path),
        })
    }

    function findRoute(path: string, routes: [pattern: RouteRegexp<string>, route: RouteEntry][]) {
        const g = matchRoutes(path, routes)
        const r = g.next()
        if (!r.value) {
            throw new HttpError(`Resource does not exist: ${path}`, { statusCode: 404 })
        }

        return r.value
    }

    async function routeRequest(request: ApiGatewayRequestPayloadV2) {
        if (rateLimiter) {
            const resp = await rateLimiter(request.requestContext, request.cookies)
            if (resp) {
                if (typeof resp === 'object') return resp

                const headers: Record<string, string> = {}
                if (typeof resp === 'number') {
                    headers['retry-after'] = String(resp)
                }

                return {
                    statusCode: 429,
                    headers,
                }
            }
        }

        const method = request.requestContext.http.method
        const routes = getRouteArray(method)

        const stage = request.requestContext.stage
        const trimmedPath = request.rawPath.replace(`/${stage}`, '')
        if (canLog) {
            console.log('got request, stage:', stage, 'pathname:', trimmedPath)
        }

        const reqCtx = { 
            priorCookies: new Map<string, string>(), 
            setCookies: (request.requestContext as any).setCookies,
        }
        if (request.cookies) {
            for (const c of request.cookies) {
                const [key, value] = c.split('=', 2)
                reqCtx.priorCookies.set(key, value)
            }
        }

        // I think `multiValueHeaders` is broken
        return runWithRequestCtx(reqCtx, () => runHandler(async () => {
            const selectedRoute = findRoute(trimmedPath, routes)
            if (canLog) {
                console.log('using route:', selectedRoute.value.route)
            }
            request.pathParameters = selectedRoute.match.groups ?? {}

            const resp = await selectedRoute.value.handler(request)
            if (resp instanceof Response) {
                const etag = resp.headers.get('etag')
                if (etag && request.headers['if-none-match'] === etag) {
                    const headers = new Headers(resp.headers)
                    headers.delete('etag')
                    headers.delete('content-type')

                    return new Response(undefined, {
                        status: 304,
                        headers, 
                    })
                }
            }

            return resp
        }))
    }

    return { addRoute, routeRequest }
}

core.addTarget(compute.HttpService, Gateway, 'aws')

function addDomain(stage: aws.Apigatewayv2Stage, domain: HostedZone) {
    const endpoint = domain.name

    const cert = new aws.AcmCertificate({
        domainName: endpoint,
        validationMethod: 'DNS',
    })

    const dvo = cert.domainValidationOptions[0]
    const validationRecord = new aws.Route53Record({
        name: dvo.resourceRecordName,
        zoneId: domain.resource.zoneId,
        allowOverwrite: true,
        type: dvo.resourceRecordType,
        records: [dvo.resourceRecordValue],
        ttl: 60,
    })

    const certValidation = new aws.AcmCertificateValidation({
        certificateArn: cert.arn,
        validationRecordFqdns: [validationRecord.fqdn],
    })

    const domainName = new aws.Apigatewayv2DomainName({
        domainName: endpoint,
        domainNameConfiguration: {
            certificateArn: cert.arn,
            endpointType: 'REGIONAL',
            securityPolicy: 'TLS_1_2',
        },
    })

    core.addDependencies(domainName, certValidation)

    const mapping = new aws.Apigatewayv2ApiMapping({
        apiId: stage.apiId,
        stage: stage.name,
        domainName: domainName.domainName,
    })

    new aws.Route53Record({
        name: domainName.domainName,
        zoneId: domain.resource.zoneId,
        type: 'A',
        alias: {
            name: domainName.domainNameConfiguration.targetDomainName,
            zoneId: domainName.domainNameConfiguration.hostedZoneId,
            evaluateTargetHealth: false,
        },
        //records: []
    })

    return domainName.domainName
}


core.bindModel<Gateway>(Gateway, {
    callOperation: function() {
        addResourceStatement({
            service: 'execute-api',
            action: 'Invoke',
            // <api-id>/<stage>/<http-verb>/<path>
            resource: `${this.resource.id}/*`
        }, this)

        return core.createUnknown()
    },
    forward: function() {
        addResourceStatement({
            service: 'execute-api',
            action: 'Invoke',
            resource: `${this.resource.id}/*`
        }, this)

        return core.createUnknown()
    },
})

// TODO:
// automatically setup logs for APIG if we detect it's not enabled



export class WebsocketGateway {
    private readonly client = new NodeHttpHandler()
    public readonly id: string
    public readonly region: string
    public readonly hostname: string
    public readonly invokeUrl: string
    public readonly resource: aws.Apigatewayv2Api
    public readonly defaultPath?: string

    private requestRouter?: ReturnType<typeof websocketRouter> & { fn: LambdaFunction }

    public constructor(readonly props?: compute.HttpServiceOptions & { mergeHandlers?: boolean }) {
        const domain = (props?.domain && 'resource' in props.domain) ? props.domain as HostedZone : undefined

        const apig = new aws.Apigatewayv2Api({
            // the below are required without an OpenApi spec
            name: generateIdentifier(aws.Apigatewayv2Api, 'name', 62),
            protocolType: 'WEBSOCKET',
            disableExecuteApiEndpoint: domain !== undefined,
        })
        this.resource = apig
        const stageName = '$default'
        const stage = new aws.Apigatewayv2Stage({
            apiId: apig.id,
            // accessLogSettings: {} <-- nice to have
            autoDeploy: true,
            name: stageName, // make this configurable?
        })

        if (domain !== undefined) {
            this.invokeUrl = `https://${addDomain(stage, domain)}`
            this.hostname = domain.name
        } else {
            this.invokeUrl = stage.invokeUrl
            this.hostname = apig.apiEndpoint.replace(/https:\/\//, '')
            this.defaultPath = stageName === '$default' ? undefined : `/${stage.name}`
        }

        const region = new aws.RegionData()

        this.id = apig.arn // TODO: use this form arn:aws:execute-api:${region}:${account}:${api-id}/${stage}/*
        this.region = region.name
    }

    // pricing
    // $0.25 per million connection minutes
    // $1.00 per million requests, $0.80 after 1 billion

    private createIntegration(route: string, fn: LambdaFunction) {
        const integration = new aws.Apigatewayv2Integration({
            apiId: this.resource.id,
            integrationType: 'AWS_PROXY',
            integrationUri: fn.resource.arn,
        })

        new aws.Apigatewayv2Route({
            apiId: this.resource.id,
            routeKey: route,
            target: `integrations/${integration.id}`,
            operationName: route,
            authorizationType: this.props?.auth === 'native' ? 'AWS_IAM' : 'NONE',
        })

        // BUG: this sometimes requires 2 deploys to get right...
        new aws.LambdaPermission({
            functionName: fn.resource.functionName,
            action: "lambda:InvokeFunction",
            principal: "apigateway.amazonaws.com",
            sourceArn: `${this.resource.executionArn}/*/*`,
        })
    }

    private addRouteInfra(routes: string[], handler: any) {
        const fn = new LambdaFunction(handler)

        for (const r of routes) {
            this.createIntegration(r, fn)
        }

        return fn
    }

    public on<T extends keyof WebsocketListeners>(event: T, handler: NonNullable<WebsocketListeners[T]>): void
    public on(event: 'connect' | 'message' | 'disconnect', handler: NonNullable<WebsocketListeners[keyof WebsocketListeners]>) {
        if (!this.requestRouter) {
            const ctx = {
                apiId: this.resource.id,
                region: this.region,
            }
            const router = websocketRouter(ctx, {})
            this.requestRouter = {
                ...router,
                fn: this.addRouteInfra(['$default', '$connect', '$disconnect'], router.handleRequest)
            }
        }

        this.requestRouter.addListener(event, handler)

        getPermissionsLater(handler, statements => {
            const context = core.getContext(Provider)
            statements.push({
                'Effect': 'Allow',
                'Action': 'execute-api:ManageConnections',
                'Resource': `arn:${context.partition}:execute-api:${context.regionId}:${context.accountId}:${this.resource.id}/*`
            })
            this.requestRouter!.fn.principal.addPolicy({
                // [\w+=,.@-]+{1,128}
                name: `Route-${event.replace(/[\s\/]+/g, '_').replace(/[{}]/g, '')}`,
                policy: createSerializedPolicy(statements),
            })
        })
    }

    public sendMessage(connectionId: string, body: any) {
        return sendCommand(this.client, {
            apiId: this.resource.id,
            region: this.region,
            connectionId: connectionId,
            body,
            method: 'POST',
        })
    }
}

interface NodeHttpRequest {
    url: URL
    method: string
    body?: any
    sign?: boolean
    region?: string
    headers?: Headers
}

async function sendRequest(client: NodeHttpHandler, req: NodeHttpRequest) {
    const query = req.url.searchParams.size === 0 ? undefined : (function () {
        const params: Record<string, string | string[]> = {}
        for (const key of req.url.searchParams.keys()) {
            const values = req.url.searchParams.getAll(key)
            params[key] = values.length === 1 ? values[0] : values
        }
        return params
    })()

    const builtRequest = new smithyHttp.HttpRequest({
        body: req.body,
        query,
        method: req.method,
        path: req.url.pathname,
        protocol: req.url.protocol,
        hostname: req.url.hostname,
        port: req.url.port ? Number(req.url.port) : undefined,
        headers: {
            'host': req.url.host,
            'content-type': 'application/json',
        }
    })

    const ctx = { region: req.region, service: 'execute-api' }
    const signed = req.sign 
        ? await signRequest(ctx, builtRequest)
        : builtRequest

    signed.headers = req.headers ? {
        ...Object.fromEntries(req.headers),
        ...signed.headers,
    } : signed.headers

    const { response } = await client.handle(signed as any)

    return new Promise<{ body: string; headers: HttpResponse['headers']; statusCode: number }>((resolve, reject) => {
        const buffer: any[] = []
        response.body.on('data', (chunk: any) => buffer.push(chunk))
        response.body.on('error', reject)

        response.body.on('end', () => {
            const result = buffer.join('')

            if (response.statusCode >= 400) {
                const e = JSON.parse(result)

                reject(Object.assign(new Error(e.message ?? ''), e))
            } else {
                resolve({
                    body: result,
                    headers: response.headers,
                    statusCode: response.statusCode,
                })
            }
        })
    })
}

// auth sigv4
// GET - get status
// POST - send message
// DELETE - disconnect
// https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/@connections/{connection_id}

interface CommandRequest {
    apiId: string
    region: string
    stage?: string
    connectionId: string
    method: string
    body?: any
}

async function sendCommand(client: NodeHttpHandler, req: CommandRequest) {
    const body = req.body instanceof TypedArray ? req.body : req.body ? JSON.stringify(req.body) : undefined // XXX: FIXME: not robust

    const pathname = `${req.stage ? `${req.stage}/` : ''}@connections/${req.connectionId}`
    const url = new URL(`https://${req.apiId}.execute-api.${req.region}.amazonaws.com/${pathname}`)

    return sendRequest(client, {
        url,
        body,
        ...req,
    })
}


interface ApiGatewayWebsocketEventV2 {
    readonly version: '2.0'
    readonly routeKey: string
    readonly rawPath: string
    readonly rawQueryString: string
    readonly cookies: string[]
    readonly headers: Record<string, string>
    readonly queryStringParameters: Record<string, string>
    readonly requestContext: RequestContextBase & {
        eventType: 'CONNECT' | 'DISCONNECT' | 'MESSAGE'
        disconnectStatusCode?: number
        connectionId: string
        // connectedAt
        messageId?: string // Only for `MESSAGE`
    }
    readonly body?: string
    readonly isBase64Encoded: boolean
    readonly stageVariables: Record<string, string>
    pathParameters: Record<string, string>
}

// I think API gateway supports sending a response directly
interface WebsocketListeners {
    readonly connect?: (socket: { id: string }) => Promise<void> | void
    readonly message?: (data: Uint8Array, socket: { id: string }) => Promise<any | void> | any | void
    readonly disconnect?: (code: number, socket: { id: string }) => Promise<void> | void
}

export function sendWebsocketMessage(socket: { id: string }, message: any, client = new NodeHttpHandler()) {
    return sendCommand(client, {
        ...(socket as any),
        method: 'POST',
        connectionId: socket.id,
        body: message,
    })
}

core.bindFunctionModel(sendCommand, function (_, req) {
    addResourceStatement({ 
        service: 'execute-api',
        action: 'ManageConnections',
        resource: `${req.apiId}/${req.stage ?? '*'}/POST/@connections/*`
    }, this)

    return core.createUnknown()
})

function websocketRouter(
    ctx: Pick<CommandRequest, 'apiId' | 'stage' | 'region'>,
    listeners: WebsocketListeners
) {
    async function handleRequest(request: ApiGatewayWebsocketEventV2) {    
        const socket = { id: request.requestContext.connectionId, ...ctx }
        const event = request.requestContext.eventType
        switch (event) {
            case 'CONNECT':
                await listeners.connect?.(socket)
                break
            case 'MESSAGE':
                const decoded = (request.body !== undefined && request.isBase64Encoded) 
                    ? Buffer.from(request.body, 'base64')
                    : request.body ? Buffer.from(request.body) : Buffer.allocUnsafe(0)

                await listeners.message?.(decoded, socket)

                break
            case 'DISCONNECT':
                await listeners.disconnect?.(request.requestContext.disconnectStatusCode!, socket)
                break

            default:
                throw new Error(`Unknown event type: ${event}`)
        }

        return { statusCode: 200 }
    }

    function addListener(event: keyof WebsocketListeners, handler: any) {
        (listeners as any)[event] = handler
    }

    return {
        addListener,
        handleRequest,
    }
}

interface EndpointCheckProps {
    readonly endpoint: string
    readonly checkFn: (endpoint: string) => Promise<boolean>
    readonly interval: number
    readonly timeoutMs: number
}

async function waitForEndpoint(props: EndpointCheckProps) {
    const start = Date.now()
    const end = start + props.timeoutMs
    let sleepTime = props.interval

    while (Date.now() < end) {
        if (await props.checkFn(props.endpoint)) {
            return { endpoint: props.endpoint }
        }

        await new Promise<void>(r => setTimeout(r, sleepTime))
        sleepTime = Math.min(sleepTime * 1.5, 1000)
    }

    throw new Error(`Timed-out waiting for endpoint: ${props.endpoint}`)
}

class EndpointCheck extends core.defineResource({
    create: (props: EndpointCheckProps) => {
        return waitForEndpoint(props)
    },
    update: async (state, props) => {
        if (props.endpoint === state.endpoint) {
            return state
        }

        return waitForEndpoint(props)
    },
}) {}

function checkEndpoint(route: HttpRoute<[]>, service: Pick<compute.HttpService, 'invokeUrl' | 'callOperation'>) {
    async function checkFn(endpoint: string) {
        try {
            await service.callOperation(route)

            return true
        } catch (e) {
            if ((e as any).statusCode !== 404) {
                throw e
            }

            return false
        }
    }

    const check = new EndpointCheck({
        endpoint: service.invokeUrl,
        checkFn,
        interval: 50,
        timeoutMs: 15000,
    })

    return check.endpoint
}
