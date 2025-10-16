import * as core from 'synapse:core'
import * as aws from 'terraform-provider:aws'
import { HostedZone } from './route53'
import { addResourceStatement } from '../permissions'

export class Certificate {
    public readonly resource: aws.AcmCertificate

    // This can be used to force other resources to wait for validation:
    // `core.addDependencies(myResource, cert.validation)`
    public readonly validation: aws.AcmCertificateValidation

    //private static provider?: InstanceType<typeof AwsProvider_1>
    public constructor(props: { name?: string, zone: HostedZone }) {
        const { name, zone } = props

        // this needs to be in us-east-1 to validate under a domain
        const provider = new aws.AwsProvider({ region: 'us-east-1' })
        const domainName = name ? `${name}.${zone.resource.name}` : zone.name

        const { cert, validation } = core.using(provider, () => {
            const cert = new aws.AcmCertificate({
                domainName,
                validationMethod: 'DNS',
            })

            // TODO: get count???
            const dvo = cert.domainValidationOptions[0]
            const validationRecord = new aws.Route53Record({
                name: dvo.resourceRecordName,
                zoneId: zone.resource.zoneId,
                allowOverwrite: true,
                type: dvo.resourceRecordType,
                records: [dvo.resourceRecordValue],
                ttl: 60,
            })
    
            const validation = new aws.AcmCertificateValidation({
                certificateArn: cert.arn,
                validationRecordFqdns: [validationRecord.fqdn],
            })

            return { cert, validation }
        })

        this.resource = cert
        this.validation = validation
    }
}

// https://docs.aws.amazon.com/acm/latest/userguide/authen-apipermissions.html
core.bindConstructorModel(aws.AcmCertificate, function () {
    const addCertStatement = (action: string | string[], lifecycle: 'create' | 'update' | 'delete' | 'read', resource = '*') => {
        addResourceStatement({
            service: 'acm',
            action,
            lifecycle: [lifecycle],
            resource: `certificate/${resource}`
        }, this)
    }

    addCertStatement('RequestCertificate', 'create')
    addCertStatement('UpdateCertificateOptions', 'update', this.id)
    addCertStatement('DeleteCertificate', 'delete', this.id)
    addCertStatement(['GetCertificate', 'DescribeCertificate'], 'read', this.id)
})
