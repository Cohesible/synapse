import * as aws from 'synapse-provider:aws'
import * as core from 'synapse:core'
import { Account } from './services/organizations'
import { Role } from './services/iam'
import { Fn } from 'synapse:terraform'
import * as srl from 'synapse:srl'

// TODO: providers in Terraform should be treated as a special kind of 
// resource rather than a separate class entirely. This will solve many
// problems as well as enable all sorts of useful functionality.
export class Provider extends aws.AwsProvider {
    static readonly [core.contextType] = 'aws'

    // We need initializers here so that the keys exist on the instance
    private identity?: aws.CallerIdentityData = undefined
    private regionData?: aws.RegionData = undefined
    private partitionData?: aws.PartitionData = undefined
    private _assetBucket?: aws.S3Bucket = undefined

    public get arn() {
        return (this.identity ??= new aws.CallerIdentityData()).arn
    }

    public get regionId() {
        return (this.regionData ??= new aws.RegionData()).id
    }

    public get accountId() {
        return (this.identity ??= new aws.CallerIdentityData()).accountId
    }

    public get partition() {
        return (this.partitionData ??= new aws.PartitionData()).partition
    }

    public get roleArn() {
        return this.assumeRole?.[0].roleArn
    }

    public get assetBucket() {
        // TODO: only create 1 asset bucket per-account (or possibly per-user)
        const assetBucket = core.singleton(aws.S3Bucket, {
            bucketPrefix: 'asset-bucket',
        })
        return this._assetBucket = assetBucket
    }

    public static fromAccount(account: Account, partition = 'aws') {
        return this.fromRoleArn(getManagementRoleArn(account, partition))
    }

    public static fromRoleArn(roleArn: string) {
        return new this({ assumeRole: [{ roleArn }] })
    }

    public static withId(account: Account, id: string, partition = 'aws') {
        const roleName = 'OrganizationAccountAccessRole'
        const roleArn = `arn:${partition}:iam::${account.id}:role/${roleName}`

        return new this(...([{ assumeRole: [{ roleArn }] }, id] as any[]))
    }
}

core.addTarget(srl.Provider, Provider, 'aws')

export function getManagementRoleArn(account: Account, partition = 'aws') {
    return `arn:${partition}:iam::${account.id}:role/${account.managementRoleName}`
}

export function createCrossAccountRole(target: Account, principal?: Role) {
    const awsPrincipal = principal ? principal.resource.arn : core.getContext(Provider).accountId
    const roleName = core.getCurrentId().slice(0, 63) // XXX: we need an independent name to avoid circular deps
    const role = core.using(Provider.fromAccount(target), () => {
        return new Role({
            name: roleName,
            assumeRolePolicy: Fn.jsonencode({
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Action": "sts:AssumeRole",
                        "Principal": {
                            "AWS": awsPrincipal
                        },
                    }
                ]
            })
        })
    })

    principal?.addPolicy({
        name: `Assume-${roleName}`,
        policy: Fn.jsonencode({
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": "sts:AssumeRole",
                    "Resource": `arn:${core.getContext(Provider).partition}:iam::${target.id}:role/${roleName}`
                }
            ]
        })
    })

    return role
}
