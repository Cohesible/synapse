import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as aws from 'terraform-provider:aws'
import { LambdaFunction } from './lambda'
import { ContainerService } from './ecs'
import { Bucket, BucketDeployment } from './s3'
import * as EC2 from '@aws-sdk/client-ec2'
import { spawn } from 'node:child_process'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import * as storage from 'synapse:srl/storage'
import { spPolicy } from './iam'
import { addResourceStatement, getPermissions } from '../permissions'
import { Provider } from '..'

// For reference -> https://en.wikipedia.org/wiki/Reserved_IP_addresses
// All of the private CIDR blocks for local networks:
// * 10.0.0.0/8
// * 100.64.0.0/10 (carrier NAT)
// * 172.16.0.0/12
// * 192.168.0.0/16

// I think the first one or two addresses in a subnet (or VPC?) are reserved in AWS

interface AwsEndpointProps {
    readonly vpcId: string
    readonly service: string
    readonly region: string
    readonly routeTableIds?: string[] // needed for gateway types
    readonly subnetIds?: string[] // needed for interface types
    readonly securityGroupIds?: string[] // needed for interface types
}

export function createAwsEndpoint(props: AwsEndpointProps) {
    if (props.service === 's3') {
        return new aws.VpcEndpoint({
            vpcId: props.vpcId,
            vpcEndpointType: 'Gateway',
            serviceName: `com.amazonaws.${props.region}.s3`,
            routeTableIds: props.routeTableIds,
        })        
    }

    return new aws.VpcEndpoint({
        vpcId: props.vpcId,
        vpcEndpointType: 'Interface',
        serviceName: `com.amazonaws.${props.region}.${props.service}`,
        subnetIds: props.subnetIds,
        securityGroupIds: props.securityGroupIds,
        privateDnsEnabled: true,
        // dnsOptions: {
        //     privateDnsOnlyForInboundResolverEndpoint: true,
        // }
    })
}

// Must have different CIDR blocks
export function peerVpcs(from: Vpc, to: Vpc, peerRegion?: string) {
    return new aws.VpcPeeringConnection({
        vpcId: from.resource.id,
        peerVpcId: to.resource.id,
        peerRegion,
        autoAccept: peerRegion ? undefined : true,
    })
}

interface VpcProps {
    cidr?: string
    publicSubnetCidr?: string
    availabilityZone?: string
    assignGeneratedIpv6CidrBlock?: boolean
}

export class Vpc {
    public readonly resource: aws.Vpc
    public readonly gateway: aws.InternetGateway
    public readonly subnets: aws.Subnet[] = []
    public readonly tables: aws.RouteTable[] = []
    private _ipv6Counter = 0

    public constructor(props?: VpcProps) {
        this.resource = new aws.Vpc({
            cidrBlock: props?.cidr ?? '10.0.0.0/16',
            enableDnsSupport: true,
            enableDnsHostnames: true,
            assignGeneratedIpv6CidrBlock: props?.assignGeneratedIpv6CidrBlock,
        })

        const igw = new aws.InternetGateway({
            vpcId: this.resource.id,
        })

        this.gateway = igw

        const publicRouteTable = new aws.RouteTable({
            vpcId: this.resource.id,
        })

        this.tables.push(publicRouteTable)

        const zones = new aws.AvailabilityZonesData({
            state: 'available',
            filter: [
                {
                    name: 'opt-in-status',
                    values: ['opt-in-not-required']
                }
            ]
        })

        this.resource.ipv6CidrBlock

        const publicSubnet = new aws.Subnet({
            vpcId: this.resource.id,
            cidrBlock: props?.publicSubnetCidr ?? '10.0.0.0/24',
            ipv6CidrBlock: this.allocateIpv6Cidr(),
            mapPublicIpOnLaunch: true,
            availabilityZone: props?.availabilityZone ?? zones.names[0],
            assignIpv6AddressOnCreation: props?.assignGeneratedIpv6CidrBlock,
        })
        this.subnets.push(publicSubnet)
        
        new aws.Route({
            routeTableId: publicRouteTable.id,
            destinationCidrBlock: '0.0.0.0/0',
            gatewayId: igw.id,
        })

        if (props?.assignGeneratedIpv6CidrBlock) {
            const ipv6Route = new aws.Route({
                routeTableId: publicRouteTable.id,
                destinationIpv6CidrBlock: '::/0',
                gatewayId: igw.id,
            })
        }

        new aws.RouteTableAssociation({
            routeTableId: publicRouteTable.id,
            subnetId: publicSubnet.id,
        })
    }

    public allocateIpv6Cidr() {
        const cidr = this.resource.ipv6CidrBlock

        return ipv6CidrSubnet(cidr, this._ipv6Counter++)
    }
}

const ipv6CidrSubnet = core.defineDataSource((block: string, index: number) => {
    // TODO: handle the mask length instead of assuming 56 bits
    const addr = block.split('/')[0]
    const segments = addr.slice(0, -2).split(':')
    const l = (segments[3] ?? '0').padStart(4, '0')
    const bytes = Buffer.from(l, 'hex')
    const lower = bytes.readUint16LE()
    bytes.writeUint16LE(lower + index) // FIXME: we should only update 1 byte for /64
    segments[3] = bytes.toString('hex')

    return `${segments.join(':')}::/64`
})

export class Subnet {
    public readonly resource: aws.Subnet

    public constructor(vpc: Vpc, opt?: Omit<aws.SubnetProps, 'vpcId'>) {
        this.resource = new aws.Subnet({
            ...opt,
            vpcId: vpc.resource.id,
        })
    }
}

// export class InternetGateway extends aws.InternetGateway {

// }

export class TransitGateway extends aws.Ec2TransitGateway {

     // ASN must be in 64512-65534 or 4200000000-4294967294 ranges.
    public addNetwork(network: net.Network) {
        if (!(network instanceof Vpc)) {
            throw new Error('Not supported')
        }

        new aws.Ec2TransitGatewayVpcAttachment({
            vpcId: network.resource.id,
            transitGatewayId: this.id,
            subnetIds: []
        })
    }
}

core.addTarget(net.TransitGateway, TransitGateway, 'aws')


export class SecurityGroupRule {
    public readonly resource: aws.SecurityGroupRule

    public constructor(network: Vpc, props: net.NetworkRuleProps) {
        const p = props
        const port = p.port

        this.resource = new aws.SecurityGroupRule({
            type: p.type,
            cidrBlocks: [p.target],
            protocol: String(p.protocol),
            fromPort: Array.isArray(port) ? port[0] : port,
            toPort: Array.isArray(port) ? port[1] : port,
            securityGroupId: network.resource.defaultSecurityGroupId,
        })
    }
}

type LoadBalancerTarget = LambdaFunction | ContainerService

export class LoadBalancer {
    public readonly resource: aws.Lb

    public constructor(network: Vpc, targets: LoadBalancerTarget[]) {
        this.resource = new aws.Lb({
            loadBalancerType: 'application',
            subnets: network.subnets.map(s => s.id),
            securityGroups: [network.resource.defaultSecurityGroupId],
        })

        const listener = new aws.AlbListener({
            loadBalancerArn: this.resource.arn,
            port: 80,
            protocol: 'HTTP',
            defaultAction: [
                {
                    type: 'fixed-response',
                    fixedResponse: {
                        contentType: 'text/plain',
                        messageBody: 'Error',
                        statusCode: '500',
                    }
                }
            ],
        })

        const groups: aws.AlbTargetGroup[] = []
        for (const target of targets) {
            const group = new aws.AlbTargetGroup({
                targetType: target instanceof LambdaFunction ? 'lambda' : 'ip',
                vpcId: network.resource.id,
            })
            groups.push(group)
    
            const perms = target instanceof LambdaFunction ? new aws.LambdaPermission({
                action: 'lambda:invokeFunction',
                functionName: target.resource.functionName,
                principal: 'elasticloadbalancing.amazonaws.com',
                sourceArn: group.arn,
            }) : undefined

            // This is incorrect for container service
            const targetId = target instanceof LambdaFunction ? target.resource.arn : target.network.resource.arn
            new aws.AlbTargetGroupAttachment({
                targetId: targetId,
                targetGroupArn: group.arn,
                // dependsOn: perms ? [perms.construct] : undefined,
            })


            new aws.AlbListenerRule({
                priority: groups.length + 100,
                listenerArn: listener.arn,
                condition: [
                    {
                        pathPattern: { values: ['*'] }
                    }
                ],
                action: [
                    {
                        type: 'forward',
                        targetGroupArn: group.arn,
                    }
                ],
            })
        }
    }
}

type ResultElement = [
    region: string,
    name: string,
    version: string,
    arch: string,
    instanceType: string,
    date: string,
    href: string, // parse out ami, e.g. >ami-0028fcd8f39b4ace1</a>
    akiId: 'hvm' | string, // not sure
]

function compareEntries(a: ResultElement, b: ResultElement) {
    const parseVersion = (s: string) => {
        const [major, minor] = s.split(' ')[0].split('.')

        return { major: Number(major), minor: Number(minor) }
    }

    const versionA = parseVersion(a[2])
    const versionB = parseVersion(b[2])
    const d2 = versionB.major - versionA.major
    if (d2 !== 0) {
        return d2
    }

    const toDate = (s: string) => new Date(`${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`)
    const d = toDate(b[5]).getTime() - toDate(a[5]).getTime()
    if (d !== 0) {
        return d
    }

    return versionB.minor - versionA.minor
}

interface FetchResponse {
    readonly aaData: ResultElement[]
}

async function fetchUbuntuAmis() {
    const url = new URL(`https://cloud-images.ubuntu.com/locator/ec2/releasesTable?_=${Date.now()}`)
    const res = await fetch(url)
    if (res.status !== 200) {
        throw new Error(`Request failed: ${res.statusText} [status: ${res.status}]`)
    }

    return await res.json() as FetchResponse
}

async function getLatestUbuntuReleaseAmi(region: string) {
    const arr = (await fetchUbuntuAmis()).aaData    
    const sorted = arr.filter(x => x[0] === region).sort(compareEntries)
    const latest = sorted[0]
    if (!latest) {
        throw new Error(`No matching release found: ${region}`)
    }

    const ami = latest[6].match(/>ami-(.+)<\/a>/)?.[1]
    if (!ami) {
        throw new Error(`Failed to parse AMI: ${latest[6]}`)
    }

    return `ami-${ami}`
}

const latestUbuntuAmi = core.defineDataSource(getLatestUbuntuReleaseAmi)

const regionalBucketUrl = core.defineDataSource((region: string, name: string, key: string) => {
    if (region === 'us-east-1') {
        return `https://${name}.s3.amazonaws.com/${key}`
    }

    return `https://${name}.s3-${region}.amazonaws.com/${key}`
})

export class Instance {
    private readonly client = new EC2.EC2({})
    public readonly resource: aws.Instance
    public readonly networkInterfaceId: string
    public readonly localKeyPath?: string
    public readonly instanceRole: aws.IamRole

    public constructor(network: Vpc, target: (() => Promise<void> | void) | lib.Bundle, key?: KeyPair, opt?: any) {
        const entryPoint = typeof target !== 'function' ? target : new lib.Bundle(target)        
        const amiResource = { id: latestUbuntuAmi(core.getContext(Provider).regionId) }

        const netInterface = new aws.NetworkInterface({
            subnetId: opt?.subnetId ?? network.subnets[0].id,
            privateIps: opt?.privateIp ? [opt.privateIp] : undefined,
            privateIpsCount: opt?.privateIp ? 1 : undefined,
            securityGroups: opt?.vpcSecurityGroupIds,
        })

        this.networkInterfaceId = netInterface.id

        const assetBucket = core.getContext(Provider).assetBucket

        const asset = new aws.S3Object({
            bucket: assetBucket.bucket,
            key: entryPoint.destination,
            source: entryPoint.destination,
        })

        const bucketPolicy = {
            name: 'BucketPolicy',
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Action: ['s3:GetObject'],
                        Resource: [`${assetBucket.arn}/*`],
                    },
                    ...(opt?.extraStatements ?? []), // XXX
                ]
            })
        }

        const statements = typeof target !== 'function' ? [] : getPermissions(target)
        const inlinePolicyResource = statements.length > 0
            ? {
                name: 'InlinePolicy', // name is required!!!!!!!
                policy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: statements,
                })
            } : undefined

        const instanceRole = new aws.IamRole({
            assumeRolePolicy: JSON.stringify(spPolicy("ec2.amazonaws.com")),
            inlinePolicy: inlinePolicyResource ? [bucketPolicy, inlinePolicyResource] : [bucketPolicy],
        })

        this.instanceRole = instanceRole

        const instanceProfile = new aws.IamInstanceProfile({
            role: instanceRole.name,
        })

// Content-Type: multipart/mixed; boundary="//"
// MIME-Version: 1.0

// --//
// Content-Type: text/cloud-config; charset="us-ascii"
// MIME-Version: 1.0
// Content-Transfer-Encoding: 7bit
// Content-Disposition: attachment; filename="cloud-config.txt"

// #cloud-config
// cloud_final_modules:
// - [scripts-user, always]
// runcmd:

// --//
// Content-Type: text/x-shellscript; charset="us-ascii"
// MIME-Version: 1.0
// Content-Transfer-Encoding: 7bit
// Content-Disposition: attachment; filename="userdata.txt"

// #!/bin/bash
// /bin/echo "Hello World" >> /tmp/testfile.txt
// --//--

        const bucketRegion = assetBucket.region
        // XXX: the global endpoint isn't accessible immediately, you get a 302
        const s3Uri = regionalBucketUrl(bucketRegion, assetBucket.bucket, asset.key)

        //  /var/log/cloud-init-output.log 

        const installService = `
[Unit]
Description=Start my blessed entry script
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/lib
Environment=AWS_REGION=${bucketRegion}
ExecStart=/_start.sh
Restart=on-failure

[Install]
WantedBy=multi-user.target
`.trim()

        const initScript = `
#!/bin/bash
PROFILE=/dev/null bash -c 'wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash'
NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
nvm install node
npm --version

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

INSTANCE_PROFILE=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/iam/security-credentials/)
METADATA=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/iam/security-credentials/$INSTANCE_PROFILE)
AWS_ACCESS_KEY_ID=$(echo "$METADATA" | grep AccessKeyId | sed -e 's/  "AccessKeyId" : "//' -e 's/",$//')
AWS_SECRET_ACCESS_KEY=$(echo "$METADATA" | grep SecretAccessKey | sed -e 's/  "SecretAccessKey" : "//' -e 's/",$//')
AWS_SESSION_TOKEN=$(echo "$METADATA" | grep Token | sed -e 's/  "Token" : "//' -e 's/",$//')

mkdir -p /var/lib
curl -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" -H "x-amz-security-token: $AWS_SESSION_TOKEN" --aws-sigv4 "aws:amz:${bucketRegion}:s3" --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -L ${s3Uri} -o /var/lib/entry.js

${opt?.initCommand ?? ''}

ln -sf "$(which node)" /usr/bin/node

tee /etc/sysctl.d/10-custom-kernel-bbr.conf <<EOF >/dev/null
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
EOF

sysctl --system

tee /etc/systemd/system/blessme.service <<EOF >/dev/null
${installService}
EOF

tee /_start.sh <<EOF >/dev/null
#!/bin/bash
exec /usr/bin/node -e 'require("/var/lib/entry.js").default()'
EOF

chmod +x /_start.sh

sudo systemctl stop apt-daily.timer apt-daily-upgrade.timer && sudo systemctl disable apt-daily.timer apt-daily-upgrade.timer && sudo systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service

systemctl daemon-reexec
systemctl enable --now blessme.service
`.trim()

        this.resource = new aws.Instance({
            // instanceType: 't4g.nano',
            ami: amiResource.id,
            instanceType: opt?.instanceType ?? 't2.micro',
            networkInterface: [
                {
                    deviceIndex: 0,
                    networkInterfaceId: netInterface.id,
                }
            ],
            rootBlockDevice: {
                volumeSize: 30,
                volumeType: opt?.volumeType,
            },
            userData: initScript,
            iamInstanceProfile: instanceProfile.name,
            keyName: key ? key.resource.keyName : undefined,
            cpuThreadsPerCore: opt?.cpuThreadsPerCore,
        })
    }

    public async ssh(user: string, keyPath: string) {
        const resp = await this.client.describeInstances({ 
            InstanceIds: [this.resource.id]
        })

        const ip = resp?.Reservations?.[0].Instances?.[0].PublicIpAddress
        if (!ip) {
            throw new Error('No public ip found')
        }

        // -o "StrictHostKeyChecking accept-new"
        // or add directly `ssh-keyscan <HOST> >> ~/.ssh/known_hosts`
        return spawn('ssh', ['-tt', '-i', keyPath, `${user}@${ip}`])
    }

    public async stop() {
        await this.client.stopInstances({
            InstanceIds: [this.resource.id],
        })
    }

    public async start() {
        await this.client.startInstances({ 
            InstanceIds: [this.resource.id]
        })
    }

    public async getState() {
        const resp = await this.client.describeInstanceStatus({ 
            InstanceIds: [this.resource.id]
        })

        return resp.InstanceStatuses[0].InstanceState
    }
}

export class KeyPair {
    public readonly resource: aws.KeyPair
    public constructor(publicKey: string) {
        this.resource = new aws.KeyPair({ publicKey })
    }
}


core.addTarget(net.Network, Vpc, 'aws')
core.addTarget(net.Subnet, Subnet, 'aws')
core.addTarget(net.NetworkRule, SecurityGroupRule, 'aws')

core.addTarget(compute.Host, Instance, 'aws')
core.addTarget(compute.KeyPair, KeyPair, 'aws')

core.bindModel(EC2.EC2, {
    'describeInstances': function (req) {
        addResourceStatement({
            service: 'ec2',
            action: 'DescribeInstances',
        }, this)

        return core.createUnknown()
    },
    'describeNetworkInterfaces': function (req) {
        addResourceStatement({
            service: 'ec2',
            action: 'DescribeNetworkInterfaces',
        }, this)

        return core.createUnknown()
    }
})