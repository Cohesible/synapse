import * as CloudWatchLogs from '@aws-sdk/client-cloudwatch-logs'

// ResourceNotFoundException -> returns 400 but should be 404

export async function listLogStreams(group: string, limit?: number, region?: string) {
    const client = new CloudWatchLogs.CloudWatchLogs({ region })
    const resp = await client.describeLogStreams({
        logGroupName: group,
        orderBy: 'LastEventTime',
        limit,
        descending: true,
    })

    return resp.logStreams ?? []
}


export async function getLogEvents(group: string, stream: string, region?: string) {
    const client = new CloudWatchLogs.CloudWatchLogs({ region })
    const resp = await client.getLogEvents({
        logGroupName: group,
        logStreamName: stream,
        startFromHead: true,
    })

    return resp.events ?? []
}
