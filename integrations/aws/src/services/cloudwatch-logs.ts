import * as assert from 'assert'
import * as core from 'synapse:core'
import * as CloudWatchLogs from '@aws-sdk/client-cloudwatch-logs'
import * as aws from 'synapse-provider:aws'

// ResourceNotFoundException -> returns 400 but should be 404

export async function listLogStreams(group: string, limit?: number) {
    const client = new CloudWatchLogs.CloudWatchLogs()
    const resp = await client.describeLogStreams({
        logGroupName: group,
        orderBy: 'LastEventTime',
        limit,
    })

    return resp.logStreams ?? []
}


export async function getLogEvents(group: string, stream: string) {
    const client = new CloudWatchLogs.CloudWatchLogs()
    const resp = await client.getLogEvents({
        logGroupName: group,
        logStreamName: stream,
        startFromHead: true,
    })

    return resp.events ?? []
}

