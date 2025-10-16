import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as Kinesis from '@aws-sdk/client-kinesis'
import * as aws from 'terraform-provider:aws'
import { randomBytes } from 'node:crypto'
import { Role, createSerializedPolicy, spPolicy } from './iam'
import * as compute from 'synapse:srl/compute'
import * as storage from 'synapse:srl/storage'
import { HttpError } from 'synapse:http'
import { getPermissions } from '../permissions'

export class Stream<T> implements storage.Stream {
    private readonly client = new Kinesis.Kinesis({})
    public readonly resource: aws.KinesisStream

    public constructor() {
        // 1 provisioned shard is 36 cents per day :(
        this.resource = new aws.KinesisStream({
            name: lib.generateIdentifier(aws.KinesisStream, 'name', 62),
            shardCount: 1,
            retentionPeriod: 24, // Max is 8760
            enforceConsumerDeletion: true,
            streamModeDetails: { streamMode: 'PROVISIONED' } // ON_DEMAND
        })
    }

    public async put(...values: T[]): Promise<void> {
        await this.client.putRecords({
            Records: values.map(v => ({ Data: Buffer.from(JSON.stringify(v)), PartitionKey: '1' })),
            StreamName: this.resource.name,
            StreamARN: this.resource.arn,
        })
    }
    
    async *[Symbol.asyncIterator]() {
        let iter = await this.getFirstIterator()
        // this throws if `iter` is `undefined`...

        do {
            const resp = await this.client.getRecords({
                ShardIterator: iter,
                StreamARN: this.resource.arn,
            })
            const records = resp.Records?.map(r => JSON.parse(Buffer.from(r.Data!).toString('utf-8')))
            yield* records!

            iter = resp.NextShardIterator
        } while (iter)
    }

    private async getFirstIterator() {
        // need to store the iterator id somewhere
        const shard = (await this.getShards().next()).value
        if (!shard) {
            throw new Error('No shard found')
        }

        const resp = await this.client.getShardIterator({ 
            ShardId: shard.ShardId,
            StreamARN: this.resource.arn,
            StreamName: this.resource.name,
            ShardIteratorType: 'TRIM_HORIZON',
        })

        return resp.ShardIterator
    }

    private async* getShards() {
        let nextToken: string | undefined
        do {
            const resp = await this.client.listShards({
                StreamARN: this.resource.arn,
                StreamName: this.resource.name,
                NextToken: nextToken,
            })

            nextToken = resp.NextToken
            yield* resp.Shards!
        } while (nextToken)
    }
}

core.addTarget(storage.Stream, Stream, 'aws')
// core.bindModel(Kinesis.Kinesis, {
//     'putRecord': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:PutRecord',
//         'Resource': '{0.StreamARN}' 
//     },
//     'putRecords': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:PutRecords',
//         'Resource': '{0.StreamARN}' 
//     },
//     'getRecords': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:GetRecords',
//         'Resource': '{0.StreamARN}' 
//     },
//     'createStream': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:CreateStream',
//         'Resource': '*' 
//     },
//     'deleteStream': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:DeleteStream',
//         'Resource': '{0.StreamARN}' 
//     },
//     'listStreams': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:ListStreams',
//         'Resource': '*' 
//     },
//     'listShards': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:ListStreams',
//         'Resource': '{0.StreamARN}' 
//     },
//     'getShardIterator': {
//         'Effect': 'Allow',
//         'Action': 'kinesis:ListStreams',
//         'Resource': '{0.StreamARN}' 
//     }
// })

// TODO: finish this 
// https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_firehose_delivery_stream
type FirehoseDestination = 'http_endpoint' | 'extended_s3'

// Firehose is basically like a bulk stream?
class Firehose {
    private readonly resource: aws.KinesisFirehoseDeliveryStream

    public constructor() {
        const service = createIngestionService(() => {})

        // X-Amz-Firehose-Access-Key

        // X-Amz-Firehose-Common-Attributes
        // e.g.
        // `commonAttributes: { foo: 'bar' }`

        const name = lib.createGeneratedIdentifier({ maxLength: 63 })
        const bucket = Firehose.backupBucket
        // FIXME: I should get the same result by using `${name}/${k}`
        const perms = getPermissions((k: string) => bucket.put(`${name}/*`, '')) 
        const role = new Role({ 
            assumeRolePolicy: JSON.stringify(spPolicy('firehose.amazonaws.com')),
        })

        role.addPolicy({
            name: 'PutObject',
            policy: createSerializedPolicy(perms),
        })

        // Buffering interval can be from 60 seconds to 900 seconds
        // Size can be 1 MB to 100 MB. Some destinations/configurations require a higher minimum.
        this.resource = new aws.KinesisFirehoseDeliveryStream({
            name,
            destination: 'http_endpoint' satisfies FirehoseDestination,
            httpEndpointConfiguration: {
                url: service.url,
                accessKey: service.accessKey,
                bufferingSize: 1,
                bufferingInterval: 60,
                s3BackupMode: 'FailedDataOnly',
                s3Configuration: {
                    prefix: name,
                    roleArn: role.resource.arn,
                    bucketArn: (bucket as any).resource.arn,
                }
            },
        })

        const metricsRole = new Role({ 
            assumeRolePolicy: JSON.stringify(spPolicy('streams.metrics.cloudwatch.amazonaws.com')),
        })

        metricsRole.addPolicy({
            name: 'PutRecords',
            policy: createSerializedPolicy([
                {
                    Effect: 'Allow',
                    Action: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
                    Resource: this.resource.arn,
                }
            ]),
        })

        const metricsStream = new aws.CloudwatchMetricStream({
            roleArn: metricsRole.resource.arn,
            firehoseArn: this.resource.arn,
            outputFormat: 'json',
        })
    }

    private static _backupBucket: storage.Bucket
    private static get backupBucket() {
        return this._backupBucket ??= new storage.Bucket()
    }
}

// Each record may contain multiple newline-separated datum
interface CloudWatchMetricStreamDatum {
    // There's some other stuff here too...
    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-metric-streams-formats-json.html

    readonly namespace: string
    readonly metric_name: string
    readonly dimensions: Record<string, string>
    readonly timestamp: number // epoch ms
    readonly unit: string
    readonly value: {
        readonly count: number
        readonly sum: number
        readonly max: number
        readonly min: number
    }
}

interface FirehosePutRequest {
    readonly requestId: string
    readonly timestamp: number // epoch ms
    readonly records: {
        readonly data: string // base64
    }[]
}

interface FirehosePutResponse {
    readonly requestId: string
    readonly timestamp: number // epoch ms
    readonly errorMessage?: string
}

function createIngestionService(consumer: (data: string) => Promise<void> | void) {
    const accessKey = randomBytes(32).toString('hex')
    const service = new compute.HttpService({
        mergeHandlers: true,
        auth: (req) => {
            const key = req.headers.get('X-Amz-Firehose-Access-Key')
            if (!key) {
                throw new HttpError('Missing access key', { statusCode: 403 })
            }

            if (key !== accessKey) {
                throw new HttpError('Invalid access key', { statusCode: 403 })
            }
        },
    })


    const route = service.route('POST', '/ingest', async (req, body: FirehosePutRequest) => {
        try {
            await Promise.all(body.records.map(r => consumer(r.data)))

            return {
                requestId: body.requestId,
                timestamp: Date.now(),
            }
        } catch (e) {
            const headers = new Headers()
            headers.append('content-type', 'application/json')

            return new Response(JSON.stringify({
                requestId: body.requestId,
                timestamp: Date.now(),
                errorMessage: (e as any).message,
            }), {
                headers,
                status: 500,
            })
        }
    })

    const url = `https://${route.host}${route.path}`

    return {
        url,
        accessKey,
    }
}
