import * as assert from 'assert'
import * as core from 'synapse:core'
import * as aws from 'synapse-provider:aws'
import * as net from 'synapse:srl/net'

export class HostedZone implements net.HostedZone {
    public constructor(
        public readonly name: string, 
        public readonly resource = new aws.Route53Zone({ name })
    ) {
    }

    public createSubzone(name: string): net.HostedZone {
        const qualifiedName = `${name}.${this.name}`
        const subdomain = new HostedZone(qualifiedName)

        new aws.Route53Record({
            name: qualifiedName,
            ttl: 30,
            type: 'NS',
            zoneId: this.resource.zoneId,
            records: subdomain.resource.nameServers,
        })

        return subdomain
    }

    public createSubdomain(name: string): net.HostedZone {
        const qualifiedName = `${name}.${this.name}`

        return new HostedZone(qualifiedName, this.resource)
    }

    public createRecord(record: net.ResourceRecord) {
        new aws.Route53Record({
            name: record.name,
            ttl: record.ttl,
            type: record.type,
            zoneId: this.resource.zoneId,
            records: Array.isArray(record.value) ? record.value : [record.value],
        })
    }
}

core.addTarget(net.HostedZone, HostedZone, 'aws')
