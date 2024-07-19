import * as assert from 'node:assert'
import * as path from 'node:path'
import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as Lambda from '@aws-sdk/client-lambda'
import * as aws from 'synapse-provider:aws'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import { Role, createSerializedPolicy, spPolicy } from './iam'
import { DockerfileDeployment, GeneratedDockerfile } from './ecr'
import { Provider } from '..'
import { AsyncLocalStorage } from 'node:async_hooks'
import { addResourceStatement, getPermissionsLater } from '../permissions'
import { getLogEvents, listLogStreams } from './cloudwatch-logs'

interface LambdaOptions {
    /** @unused */
    network?: net.Network
    timeout?: number
    name?: string
    createImage?: boolean
    arch?: 'aarch64' | 'amd64'
    baseImage?: string
    imageCommands?: string[]
    /** Used for bundling */
    external?: string[]
    memory?: number
    reservedConcurrency?: number
    ephemeralStorage?: number
    servicePrincipals?: string[]
    /** @unused */
    publish?: boolean
    env?: Record<string, string>
}

export class LambdaFunction<T extends any[] = any[], U = unknown> implements compute.Function<T, U> {
    private readonly client = new Lambda.Lambda({})
    public readonly resource: aws.LambdaFunction
    public readonly principal: Role

    public constructor(target: (...args: T) => Promise<U> | U, opt?: LambdaOptions) {
        const entryPoint = new lib.Bundle(wrap(target), {
            // Bundling the SDK clients results in much better cold-start performance
            external: opt?.external,
            moduleTarget: !opt?.createImage ? 'esm' : undefined,
        })

        const handler = `handler.default` // XXX: this name is hard-coded in `src/server.ts`
        const environment = opt?.env ?? {}

        const policyArn = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
        const servicePrincipals = opt?.servicePrincipals ? [...opt.servicePrincipals, 'lambda.amazonaws.com'] : 'lambda.amazonaws.com'
        const role = new Role({
            name: opt?.name ? `${opt.name}` : undefined,
            assumeRolePolicy: JSON.stringify(spPolicy(servicePrincipals)),
            managedPolicyArns: [policyArn],
        })

        getPermissionsLater(target, statements => {
            role.addPolicy({
                name: 'InlinePolicy',
                policy: createSerializedPolicy(statements),
            })
        })

        this.principal = role

        const ephemeralStorage = opt?.ephemeralStorage ? {
            size: opt?.ephemeralStorage,
        } : undefined

        if (opt?.createImage) {
            const { repo, deployment } = createImage(handler, entryPoint, opt.imageCommands, opt.baseImage, opt.name)
            const imageUri = `${repo.repositoryUrl}:${deployment.tagName}`
            const fn = new aws.LambdaFunction({
                functionName: opt.name ?? lib.generateIdentifier(aws.LambdaFunction, 'functionName', 64),
                timeout: opt?.timeout ?? 900,
                memorySize: opt?.memory ?? 1024,
                packageType: 'Image',
                architectures: opt.arch === 'aarch64' ? ['arm64'] : undefined,
                role: role.resource.arn,
                environment: {
                    variables: {
                        ...environment,
                    },
                },
                // Image tag _must_ be provided
                imageUri, 
                imageConfig: {
                     // XXX: for some reason Lambda won't respect the dockerfile
                    command: [`${path.basename(entryPoint.destination)}.default`],
                },
                publish: opt.publish,
                reservedConcurrentExecutions: opt.reservedConcurrency,
                ephemeralStorage,
                // vpcConfig: opt?.network ? {
                //     subnetIds: opt.network.subnets.map(s => s.id),
                //     securityGroupIds: [opt.network.resource.defaultSecurityGroupId],
                // } : undefined
            });
            this.resource = fn
        } else {
            const bucket = core.getContext(Provider).assetBucket
            // Currently assumes `pointer:` isn't added to the raw state. But nothing should break if that changes.
            const key = core.isDataPointer(entryPoint.destination) ? entryPoint.destination : path.basename(entryPoint.destination)
            const { obj, code } = createS3Archive({
                key,
                bucket: bucket,
                directory: entryPoint,
            })
            const fn = new aws.LambdaFunction({
                functionName: lib.generateIdentifier(aws.LambdaFunction, 'functionName', 64),
                s3Bucket: obj.bucket,
                s3Key: obj.key,
                handler,
                timeout: opt?.timeout ?? 900,
                memorySize: opt?.memory ?? 1024,
                packageType: 'Zip',
                runtime: 'nodejs20.x', // TODO: determine from build context
                role: role.resource.arn,
                environment: {
                    variables: {
                        ...environment,
                    },
                },
                publish: opt?.publish,
                reservedConcurrentExecutions: opt?.reservedConcurrency,
                ephemeralStorage,
                // vpcConfig: opt?.network ? {
                //     subnetIds: opt.network.subnets.map(s => s.id),
                //     securityGroupIds: [opt.network.resource.defaultSecurityGroupId],
                // } : undefined
            });
            this.resource = fn

            // if (opt?.publish) {
            //     const published = new LambdaPublishment(fn, code.hash)
            //     this.version = published.version
            // } else {
            //     this.version = fn.version
            // }
        }
    }

    private async doInvoke(args: any[], opt?: { type?: 'sync' | 'async' }) {
        const payload = args.length > 0 ? Buffer.from(JSON.stringify(toEvent(args))) : undefined
        const resp = await this.client.invoke({
            FunctionName: this.resource.functionName,
            Payload: payload,
            InvocationType: opt?.type === 'async' ? 'Event' : undefined,
        })

        // FIXME: check for "StatusCode": 202 before returning ??
        if (opt?.type === 'async') {
            return
        }

        assert.ok(resp.Payload)
        const resultString = Buffer.from(resp.Payload).toString('utf-8')
        if (resultString === 'null') {
            return void 0 as U
        }

        if (resp.FunctionError) {
            const errResp = JSON.parse(resultString) as { errorType: string; errorMessage: string; trace: string }
            const err = new Error(errResp.errorMessage)
            err.name = errResp.errorType
            // Maybe do this too
            // err.stack = err.trace 
            throw err
        }

        const respObj = JSON.parse(resultString)
        if (typeof respObj === 'object' && !!respObj && 'val' in respObj) {
            return deserialize(respObj.val, respObj.type)
        }

        return respObj
    }

    public async invoke(...args: T): Promise<U> {
        return this.doInvoke(args, { type: 'sync' })
    }

    public async invokeAsync(...args: T): Promise<void> {
        return this.doInvoke(args, { type: 'async' })
    }
}

export interface LambdaFunction<T extends any[] = any[], U = unknown> {
    (...args: T): Promise<U>
}

core.addTarget(compute.Function, LambdaFunction, 'aws')
core.bindModel(Lambda.Lambda, {
    'invoke': function (req) {
        addResourceStatement({
            service: 'lambda',
            action: 'InvokeFunction',
            resource: `function:${req.FunctionName}`,
        }, this)

        return core.createUnknown()
    }
})

// https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/aws-lambda/handler.d.ts
export interface CognitoIdentity {
    readonly cognitoIdentityId: string;
    readonly cognitoIdentityPoolId: string;
}

export interface LambdaContext {
    getRemainingTimeInMillis(): number
    readonly awsRequestId: string
    readonly functionName: string
    readonly functionVersion: string
    readonly memoryLimitInMB: number
    readonly invokedFunctionArn: string
    readonly logGroupName: string
    readonly logStreamName: string

    readonly identity?: CognitoIdentity
    // readonly clientContext

    // Not relevant to users
    // callbackWaitsForEmptyEventLoop: boolean
}

const TypedArray = Object.getPrototypeOf(Uint8Array)

interface SynapseEvent {
    readonly isSynapseEvent: true
    readonly args: any[]
    readonly types?: any[]
}

function isSynapseEvent(ev: any): ev is SynapseEvent {
    return typeof ev === 'object' && !!ev && ev.isSynapseEvent
}

interface SynapseResponse {
    readonly val: any
    readonly type?: any
}

function serialize(val: any): [v: any, type: any] | undefined {
    if (val instanceof TypedArray) {
        return [Buffer.from(val).toString('base64'), val.constructor.name]
    }
}

function deserialize(val: any, type?: any): any {
    switch (type) {
        // This is not entirely accurate
        case 'Buffer':
        case 'Uint8Array':
            return Buffer.from(val, 'base64')

        // TODO: everything else
        // It'll be easier to focus on refining a single serdes library
        // rather than re-implementing things easier
    }

    return val
}

// This serialization is _very_ simple and hardly handles
// anything substantial. The long-term strategy will be to
// re-use the format used for compilation/synthesis.
function toEvent(args: any[]): SynapseEvent {
    let types: any[] | undefined
    const len = args.length
    const args2: any[] = []
    for (let i = 0; i < len; i++) {
        const a = args[i]
        const s = serialize(a)
        if (s) {
            const arr = types ??= []
            arr[i] = s[1]
            args2[i] = s[0]
        } else {
            args2[i] = a
        }
    }

    return {
        isSynapseEvent: true,
        types,
        args: args2,
    }
}

function fromEvent(ev: SynapseEvent): any[] {
    if (!ev.types) {
        return ev.args
    }

    const res: any[] = []
    const len = ev.args.length
    for (let i = 0; i < len; i++) {
        res[i] = deserialize(ev.args[i], ev.types[i])
    }

    return res
}

type LambdaHandler = (event: any, ctx: LambdaContext) => Promise<any>

const store = new AsyncLocalStorage<LambdaContext>()
export function getContext(): LambdaContext | undefined {
    return store.getStore()
}

function wrap<T, U extends any[]>(fn: (...args: U) => T): LambdaHandler {
    function withContext(ctx: LambdaContext, args: any[]) {
        return store.run(ctx, fn, ...(args as any))
    }

    return async (event, ctx) => {
        try {
            if (!isSynapseEvent(event)) {
                return withContext(ctx, [event])
            }

            const resp = await withContext(ctx, fromEvent(event))
            const serialized = serialize(resp)
            if (serialized) {
                return { val: serialized[0], type: serialized[1] } satisfies SynapseResponse
            }

            return { val: resp } satisfies SynapseResponse
        } catch (err) {
            if (typeof err === 'object') {
                console.error({
                    ...err,
                    name: (err as any).name,
                    message: (err as any).message,
                    stack: (err as any).stack,
                })
            }

            throw err
        }
    }
}

interface ArchiveProps {
    readonly key: string
    readonly bucket: aws.S3Bucket
    readonly directory: string | lib.Bundle
}

function createS3Archive(props: ArchiveProps) {
    const code = new lib.Archive(props.directory)
    const obj = new aws.S3Object({
        bucket: props.bucket.bucket,
        key: props.key, //`${config.version}/${asset.fileName}`,
        source: code.filePath, // returns a posix path
    })

    core.updateLifecycle(obj, { replace_triggered_by: [code] })

    // FIXME: use hash?
    if (props.directory instanceof lib.Bundle) {
        core.updateLifecycle(code, { replace_triggered_by: [props.directory] })
    }

    return { obj, code }
}


function createImage(handler: string, entrypoint: lib.Bundle, extraCommands?: string[], baseImage?: string, name?: string) {
    const repo = new aws.EcrRepository({
        name: name ?? lib.generateIdentifier(aws.EcrRepository, 'name', 256),
        forceDelete: true,
    })

    const dockerfile = new GeneratedDockerfile(entrypoint, { 
        baseImage: baseImage ?? '--platform=linux/amd64 public.ecr.aws/lambda/nodejs:18', // This base image already has `@aws-sdk`
        entrypoint: handler,
        workingDirectory: '$${LAMBDA_TASK_ROOT}', // Need to escape ${}
        postCopyCommands: extraCommands,
    })

    const region = new aws.RegionData()
    const deployment = new DockerfileDeployment({
        type: 'ecr',
        dockerfilePath: dockerfile.location,
        region: region.name,
        repositoryUrl: repo.repositoryUrl,
        repoName: repo.name,
    })

    core.updateLifecycle(deployment, { replace_triggered_by: [
        entrypoint,
        dockerfile
    ] })

    return { repo, deployment }
}

async function getLogs(fn: aws.LambdaFunction) {
    const region = fn.qualifiedArn.split(':')[3]
    const logGroup = fn.loggingConfig?.logGroup ?? `/aws/lambda/${fn.functionName}`
    const streams = await listLogStreams(logGroup, 5, region)
    const events: Awaited<ReturnType<typeof getLogEvents>> = []
    for (const s of streams) {
        const r = await getLogEvents(logGroup, s.logStreamName!, region)
        events.push(...r)
    }
    return events
}

core.registerLogProvider(
    aws.LambdaFunction,
    async (r, q) => {
        const events = await getLogs(r)

        return events.map(ev => {
            const msg = ev.message!
            // TODO: parse out JSON from the message
            const sourceType = !!msg.match(/^[A-Z]/) || msg.includes('ERROR\tInvoke Error') ? 'system' : 'user'
            if (sourceType === 'user') {
                const columns = msg.split('\t')
                const rem = columns.slice(3).join('\t')

                return {
                    timestamp: ev.timestamp!,
                    sourceType,
                    data: {
                        requestId: columns[1],
                        level: columns[2],
                        message: rem.endsWith('\n') ? rem.slice(0, -1) : rem,
                    },
                }
            }

            return {
                timestamp: ev.timestamp!,
                sourceType,
                data: msg.endsWith('\n') ? msg.slice(0, -1) : msg,
            }
        })
    }
)
