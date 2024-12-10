
import * as aws from 'synapse-provider:aws'
import * as crypto from 'node:crypto'
import * as core from 'synapse:core'
import { fetch } from 'synapse:http'
import { LambdaFunction } from './lambda'
import * as compute from 'synapse:srl/compute'

export class SecureService {
    private readonly key = new EncryptionKey()
    private readonly router = createRouter(this.key)
    private readonly fn: LambdaFunction
    private readonly url: string

    constructor(obj: Record<string, (...args: any[]) => any>) {
        for (const [k, v] of Object.entries(obj)) {
            this.router.addRoute(`/${k}`, v)
        }

        this.fn = new LambdaFunction(this.router.handleRequest)

        // This is currently needed despite having an auth type of 'none'
        new aws.LambdaPermission({
            functionName: this.fn.resource.functionName,
            action: 'lambda:InvokeFunctionUrl',
            principal: '*',
            functionUrlAuthType: 'NONE',
        })

        const urlResource = new aws.LambdaFunctionUrl({
            functionName: this.fn.resource.functionName,
            authorizationType: 'NONE',
        })

        this.url = urlResource.functionUrl
    }

    public serialize() {
        return JSON.stringify({
            encodedKey: this.key.key,
            url: this.url,
            routes: this.router.getRoutes(),
        }) as any
    }

    public static deserialize = deserialize
}


type PromisifyFunction<T> = T extends (...args: infer A) => Promise<infer _> 
        ? T : T extends (...args: infer A) => infer U 
        ? (...args: A) => Promise<U> : T

type Promisify<T> = { [P in keyof T]: PromisifyFunction<T[P]> }

function deserialize<T>(encoded: string & { __type?: T }): Promisify<T> {
    const parsed = JSON.parse(encoded)

    return createClient(parsed.encodedKey, parsed.url, parsed.routes) as any
}

core.addTarget(compute.SecureService, SecureService, 'aws')

// This appears to be a special case of the API Gateway format
interface RequestPayload {
    readonly version: '2.0'
    readonly routeKey: string
    readonly rawPath: string
    readonly rawQueryString: string
    readonly cookies: string[]
    readonly headers: Record<string, string>
    readonly queryStringParameters: Record<string, string>
    readonly requestContext: {
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
}

async function importKey(key: string, usage: 'encrypt' | 'decrypt') {
    const buf = Buffer.from(key, 'base64')

    return crypto.webcrypto.subtle.importKey('raw', buf, 'AES-GCM', false, [usage])
}

async function encrypt(encodedKey: string, data: ArrayBuffer) {
    const key = await importKey(encodedKey, 'encrypt')
    const iv = crypto.randomBytes(16)
    const encrypted = await crypto.webcrypto.subtle.encrypt({ ...key.algorithm, iv }, key, data)

    return Buffer.concat([iv, Buffer.from(encrypted)])
}

async function decrypt(encodedKey: string, data: ArrayBuffer) {
    const key = await importKey(encodedKey, 'decrypt')
    const iv = Buffer.from(data).subarray(0, 16)
    const payload = Buffer.from(data).subarray(16)

    return crypto.webcrypto.subtle.decrypt({ ...key.algorithm, iv }, key, payload)
}

class EncryptionKey extends core.defineResource({
    create: async () => {
        const key = await crypto.webcrypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, 
            true, 
            ['encrypt', 'decrypt']
        ) as crypto.webcrypto.CryptoKey

        const data = await crypto.webcrypto.subtle.exportKey('raw', key)

        return { key: Buffer.from(data).toString('base64') }
    },
    update: state => state,
}) {}

function createRouter(key: EncryptionKey) {
    const routes: Record<string, (...args: any[]) => any> = {}

    function addRoute(pathname: string, handler: (...args: any[]) => any) {
        if (routes[pathname]) {
            throw new Error(`Route already exists: ${pathname}`)
        }
        routes[pathname] = handler
    }

    async function handleRequest(req: RequestPayload) {
        const pathname = req.rawPath
        const handler = routes[pathname]
        if (!handler) {
            throw new Error(`No route found: ${pathname}`)
        }

        if (!req.body) {
            throw new Error(`Missing body: ${pathname}`)
        }

        const body = Buffer.from(req.body, req.isBase64Encoded ? 'base64' : 'utf-8')
        const decrypted = await decrypt(key.key, body)
        const parsed = JSON.parse(Buffer.from(decrypted).toString('utf-8')) as { args: any[] }

        if (typeof parsed !== 'object' || !parsed) {
            throw new Error(`Invalid request format type, expected an object got: ${typeof parsed === 'object' ? 'null' : typeof parsed}`)
        }

        if (!Array.isArray(parsed.args)) {
            throw new Error(`Invalid request format type, expected "args" to be an array got: ${typeof parsed.args}`)
        }

        let result: any | undefined
        let err: any | undefined
        try {
            result = await handler(...parsed.args)
        } catch (e) {
            err = e
        }

        const type = err !== undefined ? 'error' : 'success'
        const value = type === 'error' 
            ? { ...err, name: err.name, message: err.message, stack: err.stack }
            : result

        const encrypted = await encrypt(key.key, Buffer.from(JSON.stringify({ type, value }), 'utf-8'))

        return {
            statusCode: 200,
            headers: {
                'content-type': 'application/octet-stream',
            },
            body: Buffer.from(encrypted).toString('base64'),
            isBase64Encoded: true,
        }
    }

    return {
        addRoute,
        handleRequest,
        getRoutes: () => Object.keys(routes),
    }
}

function createClient(encodedKey: string, url: string, routes: string[]) {
    async function sendRequest(pathname: string, args: any[]) {
        const body = await encrypt(encodedKey, Buffer.from(JSON.stringify({ args }), 'utf-8'))
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url
        const resp = await fetch(pathname, {
            body,
            baseUrl, 
        })
        const decrypted = await decrypt(encodedKey, resp)
        const parsed = JSON.parse(Buffer.from(decrypted).toString('utf-8')) as { type: 'success' | 'error', value?: any }

        if (parsed.type === 'error') {
            throw Object.assign(new Error(), parsed.value ?? {})
        }

        return parsed.value
    }

    const client: Record<string, (...args: any[]) => any> = {}
    for (const k of routes) {
        client[k.slice(1)] = (...args: any[]) => sendRequest(`POST ${k}`, args)
    }

    return client
}

