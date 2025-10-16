import * as core from 'synapse:core'
import * as EventBridge from '@aws-sdk/client-eventbridge'
import * as aws from 'terraform-provider:aws'
import * as compute from 'synapse:srl/compute'
import { LambdaFunction } from './lambda'
import { Role, spPolicy } from './iam'

export class ScheduledExecution  {
    private readonly client = new EventBridge.EventBridge({})

    public constructor() {    }
}

export class Schedule {
    private readonly resource: aws.SchedulerSchedule

    public constructor(expression: string, fn: () => void) {
        const lambda = new LambdaFunction(fn)
        const role = new Role({
            assumeRolePolicy: JSON.stringify(spPolicy("scheduler.amazonaws.com")),
            inlinePolicy: [
                {
                    name: 'SchedulerInvokePolicy',
                    policy: JSON.stringify({
                        Version: "2012-10-17",
                        Statement: [{
                            Action: ['lambda:InvokeFunction'],
                            Resource: [lambda.resource.arn],
                            Effect: 'Allow',
                        }],
                    })
                }
            ]
        })

        this.resource = new aws.SchedulerSchedule({
            scheduleExpression: expression,
            target: {
                arn: lambda.resource.arn,
                roleArn: role.resource.arn,
            },
            flexibleTimeWindow: {
                mode: 'OFF'
            }
        })
    }


    public on(event: 'tick', fn: () => void): void {
        throw new Error('TODO')
    }
}

core.addTarget(compute.Schedule, Schedule, 'aws')

