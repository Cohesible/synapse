import * as core from 'synapse:core'
import * as aws from 'synapse-provider:aws'
import * as smithyHttp from '@smithy/protocol-http'
import { URL } from 'node:url'
import { LambdaFunction } from './lambda'
import { signRequest } from '../sigv4'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HostedZone } from './route53'
import { HttpHandler, Middleware, RouteRegexp, buildRouteRegexp, matchRoutes, HttpResponse, HttpError, HttpRoute, PathArgs, createPathBindings, applyRoute, kHttpResponseBody, compareRoutes, HttpRequest } from 'synapse:http'
import { createSerializedPolicy } from './iam'
import { generateIdentifier } from 'synapse:lib'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import * as storage from 'synapse:srl/storage'
import { Provider } from '..'

export class Gateway {
    private readonly client = new NodeHttpHandler()
    public readonly id: string
    public readonly region: string
    public readonly hostname: string
    public readonly invokeUrl: string
    public readonly resource: aws.Apigatewayv2Api
    public readonly defaultPath?: string

    private requestRouter?: ReturnType<typeof createRequestRouter> & { fn: LambdaFunction }

    public constructor(readonly props?: compute.HttpServiceOptions & { mergeHandlers?: boolean; allowedOrigins?: string[] }) {
        const domain = (props?.domain && 'resource' in props.domain) ? props.domain as HostedZone : undefined

        const apig = new aws.Apigatewayv2Api({
            // the below are required without an OpenApi spec
            name: generateIdentifier(aws.Apigatewayv2Api, 'name', 62),
            protocolType: 'HTTP', // | WEBSOCKET
            disableExecuteApiEndpoint: domain !== undefined,
        })
        this.resource = apig
        const stageName: string = '$default'
        const stage = new aws.Apigatewayv2Stage({
            apiId: apig.id,
            // accessLogSettings: {} <-- nice to have
            autoDeploy: true,
            name: stageName, 
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

    public addRoute<P extends string = string, U = any, R = HttpResponse>(
        route: P, 
        handler: HttpHandler<P, U, R> | HttpHandler<P, string, R>,
        opt?: { rawBody?: boolean }
    ): HttpRoute<[...PathArgs<P>, U], R> {
        const [method, path] = route.split(' ')
        if (path === undefined) {
            throw new Error(`Missing method in route: ${route}`)
        }

        const authHandler = typeof this.props?.auth === 'function' ? this.props.auth : undefined
        const wrapped = wrapHandler(handler as any, authHandler as any, opt?.rawBody, this.middleware, this.props?.allowedOrigins)
        const mergeHandlers = this.props?.mergeHandlers ?? true
        if (mergeHandlers) {
            if (!this.requestRouter) {
                const router = createRequestRouter()
                this.requestRouter = {
                    ...router,
                    fn: this.addRouteInfra('$default', router.routeRequest)
                }
            }

            this.requestRouter.addRoute(route, wrapped)

            core.getPermissionsLater(wrapped, statements => {
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

        return {
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
    }

    private addRouteInfra(route: string, handler: ReturnType<typeof wrapHandler>) {
        const fn = new LambdaFunction(handler)

        const integration = new aws.Apigatewayv2Integration({
            apiId: this.resource.id,
            integrationType: 'AWS_PROXY',
            integrationUri: fn.resource.arn,
            payloadFormatVersion: '2.0',
        })

        new aws.Apigatewayv2Route({
            apiId: this.resource.id,
            routeKey: route,
            target: `integrations/${integration.id}`,
            operationName: route,
            // authorizationType: 'AWS_IAM', // 'NONE' | 'AWS_IAM' | 'CUSTOM
            authorizationType: this.props?.auth === 'native' ? 'AWS_IAM' : 'NONE',
        })

        // BUG: this sometimes requires 2 deploys to get right...
        new aws.LambdaPermission({
            functionName: fn.resource.functionName,
            action: "lambda:InvokeFunction",
            principal: "apigateway.amazonaws.com",
            sourceArn: `${this.resource.executionArn}/*/*`,
        })

        return fn
    }

    // TODO: making method calls on Gateway to set-up the prototype would be cleaner than re-writing expressions
    // In other words, additive transformations are more robust
    public async callOperation<T extends any[], R>(route: HttpRoute<T, R>, ...args: T): Promise<R> {
        const { request, body } = applyRoute(route, args)

        const resp = await this.request(
            `https://${this.hostname}${request.path}`, 
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
        const query = url.searchParams.size === 0 ? undefined : (function () {
            const params: Record<string, string | string[]> = {}
            for (const key of url.searchParams.keys()) {
                const values = url.searchParams.getAll(key)
                params[key] = values.length === 1 ? values[0] : values
            }
            return params
        })()

        const builtRequest = new smithyHttp.HttpRequest({
            body,
            query,
            method,
            path: url.pathname,
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port ? Number(url.port) : undefined,
            headers: {
                'host': url.host,
                'content-type': 'application/json',
            }
        })

        const ctx = { region: this.region, service: 'execute-api' }
        const signed = this.props?.auth === 'native' 
            ? await signRequest(ctx, builtRequest)
            : builtRequest

        signed.headers = headers ? {
            ...Object.fromEntries(headers.entries()),
            ...signed.headers,
        } : signed.headers

        const { response } = await this.client.handle(signed as any)

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
    // identity?: { sourceIp: string }
}

interface ApiGatewayRequestPayloadV2 {
    readonly version: '2.0'
    readonly routeKey: string
    readonly rawPath: string
    readonly rawQueryString: string
    readonly cookies: string[]
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

            const body = kHttpResponseBody in resp 
                ? Buffer.from(resp[kHttpResponseBody] as Uint8Array).toString('utf-8')
                : resp.body ? await resp.text() : undefined

            return {
                body,
                statusCode: resp.status,
                headers: Object.fromEntries(resp.headers.entries()),
            }
        }

        if (resp === undefined) {
            return { statusCode: 204 }
        }

        if (resp instanceof TypedArray) {
            return {
                statusCode: 200,
                body: Buffer.from(resp as any).toString('base64'),
                isBase64Encoded: true,
                headers: {
                    'content-type': 'application/octet-stream',
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
                statusCode: e.fields.statusCode,
            }
        }

        throw e
    }
}

function wrapHandler(
    handler: HttpHandler, 
    authHandler?: HttpHandler, 
    raw = false, 
    middleware: Middleware[] = [],
    allowedOrigins?: string[]
) {
    async function handleRequest(request: ApiGatewayRequestPayloadV2) {
        const decoded = (request.body !== undefined && request.isBase64Encoded) 
            ? Buffer.from(request.body, 'base64').toString('utf-8') 
            : request.body
        const body = (decoded && !raw) ? JSON.parse(decoded) : decoded
        const stage = request.requestContext.stage
        const trimmedPath = request.rawPath.replace(`/${stage}`, '')

        const mappedRequest = {
            path: trimmedPath,
            queryString: request.rawQueryString,
            headers: new Headers(request.headers),
            context: request.requestContext,
            method: request.requestContext.http.method,
            pathParameters: request.pathParameters,

            // Why is `cookies` an array?
            cookies: request.cookies,
        }
        
        return runHandler(async () => {
            if (authHandler) {
                const resp = await authHandler(mappedRequest, body)
                if (resp !== undefined) {
                    return resp
                }
            }
    
            return handler(mappedRequest, body)
        })
    }

    return handleRequest
}

type ApiGatewayHandler = ReturnType<typeof wrapHandler>
function createRequestRouter() {
    interface RouteEntry {
        readonly route: string
        readonly pattern: RouteRegexp<string>
        readonly handler: ApiGatewayHandler
    }

    const routeTable: { [method: string]: RouteEntry[] } = {}

    function addRoute(route: string, handler: ApiGatewayHandler) {
        const [method, path] = route.split(' ')
        const routes = routeTable[method] ??= []
        routes.push({
            route,
            handler,
            pattern: buildRouteRegexp(path),
        })
    }

    function findRoute(path: string, routes: RouteEntry[]) {
        const matched = Array.from(
            matchRoutes(path, routes.map(e => [e.pattern, e]))
        )

        console.log('All matched routes:', matched.map(r => r.value.route))

        const sorted = matched.sort((a, b) => compareRoutes(b.value.route, a.value.route))
        const first = sorted[0]
        if (first === undefined) {
            throw new HttpError(`Resource does not exist: ${path}`, { statusCode: 404 })
        }

        return first
    }

    function routeRequest(request: ApiGatewayRequestPayloadV2) {
        const method = request.requestContext.http.method
        const routes = [
            ...(routeTable[method] ?? []),
            ...(routeTable['ANY'] ?? []),
        ]

        const stage = request.requestContext.stage
        const trimmedPath = request.rawPath.replace(`/${stage}`, '')
        console.log(stage, trimmedPath)

        return runHandler(() => {
            const selectedRoute = findRoute(trimmedPath, routes)
            console.log('Using route:', selectedRoute.value.route)
            request.pathParameters = selectedRoute.match.groups ?? {}
    
            return selectedRoute.value.handler(request)
        })
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

// FIXME: add a way to conditionally add permissions?
// very tempting to just use arbitrary functions instead of templates
core.bindModel<Gateway>(Gateway, {
    callOperation: {
        'Effect': 'Allow',
        'Action': 'execute-api:Invoke',
        // 'Resource': 'arn:{context.Partition}:execute-api:${context.Region}:${context.Account}:${this.resource.id}/Default/${replace(0, " ", "/")}'
        'Resource': 'arn:{context.Partition}:execute-api:{context.Region}:{context.Account}:*'
    },
    forward: {
        'Effect': 'Allow',
        'Action': 'execute-api:Invoke',
        // 'Resource': 'arn:{context.Partition}:execute-api:${context.Region}:${context.Account}:${this.resource.id}/Default/${replace(0, " ", "/")}'
        'Resource': 'arn:{context.Partition}:execute-api:{context.Region}:{context.Account}:*'
    }
})

// {
//     "Version": "2012-10-17",
//     "Statement": [
//       {
//         "Effect": "Permission",
//         "Action": [
//           "execute-api:*" // execute-api:Invoke or execute-api:InvalidateCache
//         ],
//         "Resource": [
//           "arn:aws:execute-api:region:account-id:api-id/stage/METHOD_HTTP_VERB/Resource-path"
//         ]
//       }
//     ]
//   } 

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
        const stageName = 'Default'
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
            this.defaultPath = `/${stage.name}`
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
                stage: 'Default',
            }
            const router = websocketRouter(ctx, {})
            this.requestRouter = {
                ...router,
                fn: this.addRouteInfra(['$default', '$connect', '$disconnect'], router.handleRequest)
            }
        }

        this.requestRouter.addListener(event, handler)

        core.getPermissionsLater(handler, statements => {
            const context = core.getContext(Provider)
            statements.push({
                'Effect': 'Allow',
                'Action': 'execute-api:ManageConnections',
                // 'Resource': 'arn:{context.Partition}:execute-api:${context.Region}:${context.Account}:${this.resource.id}/Default/${replace(0, " ", "/")}'
                'Resource': `arn:${context.partition}:execute-api:${context.region ?? 'us-west-2'}:${context.accountId}:*` // XXX
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
            stage: 'Default',
        })
    }
}


// auth sigv4
// GET - get status
// POST - send message
// DELETE - disconnect
// https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/@connections/{connection_id}

interface CommandRequest {
    apiId: string
    region: string
    stage: string
    connectionId: string
    method: string
    body?: any
}

async function sendCommand(client: NodeHttpHandler, req: CommandRequest) {
    const body = req.body instanceof TypedArray ? req.body : req.body ? JSON.stringify(req.body) : undefined // XXX: FIXME: not robust

    const url = new URL(`https://${req.apiId}.execute-api.${req.region}.amazonaws.com/${req.stage}/@connections/${req.connectionId}`)
    const builtRequest = new smithyHttp.HttpRequest({
        body,
        method: req.method,
        path: url.pathname,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        headers: {
            'host': url.host,
            'content-type': 'application/json',
        }
    })

    const ctx = { region: req.region, service: 'execute-api' }
    const signed = await signRequest(ctx, builtRequest)

    const { response } = await client.handle(signed as any)

    return new Promise<{ body: string; headers: HttpResponse['headers']; statusCode: number }>((resolve, reject) => {
        const buffer: any[] = []
        response.body.on('data', (chunk: any) => buffer.push(chunk))
        response.body.on('error', reject)

        response.body.on('end', () => {
            const result = buffer.join('')

            if (response.statusCode >= 400) {
                const e = result ? JSON.parse(result) : {}

                reject(Object.assign(new Error(e.message ?? ''), e, { statusCode: response.statusCode }))
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

export function sendWebsocketMessage(socket: { id: string }, message: any) {
    return sendCommand(new NodeHttpHandler(), {
        ...(socket as any),
        method: 'POST',
        connectionId: socket.id,
        body: message,
    })
}

core.bindFunctionModel(sendCommand, function (_, req) {
    this.$context.addStatement({
        Action: 'execute-api:ManageConnections',
        Resource: `arn:${this.$context.partition}:execute-api:${req.region}:${this.$context.accountId}:${req.apiId}/${req.stage}/POST/@connections/*`
    })

    return this.$context.createUnknown()
})

function websocketRouter(
    ctx: Pick<CommandRequest, 'apiId' | 'stage' | 'region'>,
    listeners: WebsocketListeners
) {
    async function handleRequest(request: ApiGatewayWebsocketEventV2) {
        console.log(request)
    
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