import * as core from 'synapse:core'
import * as SQS from '@aws-sdk/client-sqs'
import * as aws from 'synapse-provider:aws'
import { LambdaFunction } from './lambda'
import { Fn } from 'synapse:terraform'
import * as storage from 'synapse:srl/storage'

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
        await sendMessage(this.resource, JSON.stringify(val))
    }

    public async consume<U>(fn: (val: T) => U | Promise<U>): Promise<U> {
        const resp = await this.client.receiveMessage({
            QueueUrl: this.resource.url,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
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

async function sendMessage(target: aws.SqsQueue, message: string) {
    const client = new SQS.SQS({})
    await client.sendMessage({
        QueueUrl: target.url,
        MessageBody: message,
    })
}

core.bindFunctionModel(sendMessage, function (target) {
    this.$context.addStatement({
        Action: 'sqs:SendMessage',
        Resource: `arn:${this.$context.partition}:sqs:${this.$context.regionId}:${this.$context.accountId}:${target.name}`
    })
})


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

// It's easier to create helper functions and bind permissions to those because
// the APIs accept URLs rather than resource names/ARNs
core.bindModel(SQS.SQS, {
    'createQueue': {
        'Effect': 'Allow',
        'Action': 'sqs:CreateQueue',
        'Resource': '*' 
    },
    'listQueues': {
        'Effect': 'Allow',
        'Action': 'sqs:ListQueues',
        'Resource': '*' 
    }
})

