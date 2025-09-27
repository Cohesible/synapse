import * as core from 'synapse:core'
import * as SQS from '@aws-sdk/client-sqs'
import * as aws from 'synapse-provider:aws'
import { LambdaFunction } from './lambda'
import { Fn } from 'synapse:terraform'
import * as storage from 'synapse:srl/storage'
import { addResourceStatement } from '../permissions'

export class Queue<T = string>  {
    private readonly client = new SQS.SQS({})
    public readonly resource: aws.SqsQueue

    public constructor() {
        this.resource = new aws.SqsQueue({})
    }

    public on(eventType: 'message', cb: (message: T) => Promise<void> | void) {
        const handler = forwardEvent(cb)
        const fn = new LambdaFunction(handler, {
            timeout: this.resource.visibilityTimeoutSeconds,
        })
        const event = new aws.LambdaEventSourceMapping({
            functionName: fn.resource.functionName,
            batchSize: 10,
            eventSourceArn: this.resource.arn,
            functionResponseTypes: ['ReportBatchItemFailures']
        })

        fn.principal.addPolicy({
            name: 'SQSPolicy',
            policy: Fn.jsonencode({
                Version: "2012-10-17",
                Statement: [{
                    Effect: 'Allow',
                    Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
                    Resource: [this.resource.arn],
                }],
            })
        })

        return event
    }

    public async send(val: T): Promise<void> {
        await this.client.sendMessage({
            QueueUrl: this.resource.url,
            MessageBody: JSON.stringify(val),
        })
    }

    public async consume<U>(fn: (val: T) => U | Promise<U>, timeout = 20): Promise<U> {
        const resp = await this.client.receiveMessage({
            QueueUrl: this.resource.url,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: timeout,
        })

        const message = resp.Messages?.[0]
        if (!message) {
            throw new Error('No message in queue')
        }

        const result = await fn(JSON.parse(message.Body!))
        await this.client.deleteMessage({
            QueueUrl: this.resource.url,
            ReceiptHandle: message.ReceiptHandle,
        })

        return result
    }
}

function addSqsStatement(recv: any, action: string | string[], resource = '*') {
    addResourceStatement({
        service: 'sqs',
        action,
        resource,
    }, recv)
}

// https://docs.aws.html#example-standard-queue-message-event
interface MessageRecord {
    readonly body: string
    readonly messageId: string
}

interface MessageEvent {
    readonly Records: MessageRecord[]
}

interface MessageEventResponse {
    readonly batchItemFailures: { readonly itemIdentifier: string }[]
}

function forwardEvent<T>(target: (message: T) => Promise<void> | void, fifo = false) {
    async function unwrapRecords(event: MessageEvent) {
        const batchItemFailures: MessageEventResponse['batchItemFailures'] = []

        async function processRecord(record: MessageRecord) {
            try {
                await target(JSON.parse(record.body))
            } catch (e) {
                batchItemFailures.push({ itemIdentifier: record.messageId })

                return e
            }
        }

        if (fifo) {
            for (const record of event.Records) {
                const result = await processRecord(record)
                if (result) {
                    console.log('Stopping early due to error', result)
                    break
                }
            }
        } else {
            const results = await Promise.all(event.Records.map(r => processRecord(r)))
            results.forEach(e => {
                if (e) {
                    console.log('Failed to process record', e)
                }
            })
        }

        return { batchItemFailures }
    }

    return unwrapRecords
}

core.addTarget(storage.Queue, Queue, 'aws')

const parseQueueName = core.defineDataSource((url: string) => {
    const segments = url.split('/').filter(x => !!x)

    return segments.pop()!
})

function queueName(url: string) {
    if (core.isUnknown(url)) {
        return url
    }

    return parseQueueName(url)
}

// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-api-permissions-reference.html
core.bindModel(SQS.SQS, {
    'createQueue': function () {
        addSqsStatement(this, 'CreateQueue')

        return core.createUnknown()
    },
    'listQueues': function () {
        addSqsStatement(this, 'ListQueues')

        return core.createUnknown()
    },
    'sendMessage': function (req) {
        addSqsStatement(this, 'SendMessage', queueName(req.QueueUrl))

        return core.createUnknown()
    },
    'receiveMessage': function (req) {
        addSqsStatement(this, 'ReceiveMessage', queueName(req.QueueUrl))

        return core.createUnknown()
    },
    'deleteMessage': function (req) {
        addSqsStatement(this, 'DeleteMessage', queueName(req.QueueUrl))

        return core.createUnknown()
    },
})
