import * as core from 'synapse:core'
import * as aws from 'terraform-provider:aws'
import { Bucket, BucketDeployment } from './s3'
import { HostedZone } from './route53'
import * as certs from './certificate-manager'
import * as CloudFront from '@aws-sdk/client-cloudfront'
import { LambdaFunction } from './lambda'
import { Provider } from '..'
import { generateIdentifier } from 'synapse:lib'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import * as storage from 'synapse:srl/storage'
import { HttpHandler } from 'synapse:http'

export class Website {
    readonly _url: string
    public get url() {
        return this._url
    }
    public constructor(props: { path: string, domain?: HostedZone }) {
        const bucket = new Bucket()
        new BucketDeployment(bucket, props.path)

        const domain = props.domain
        const distribution = new Distribution({bucket, domain})

        this._url = domain ? domain.name : distribution.resource.domainName
    }
}

interface DistributionProps {
    readonly bucket: Bucket
    readonly indexKey?: string
    readonly domain?: HostedZone
    readonly additionalRoutes?: {
        origin: string
        targetPath: string
        originPath?: string
        allowedMethods: string[]
    }[]
    readonly compress?: boolean
    readonly middleware?: HttpHandler<any, any, Response>
}

interface CloudFrontViewerRequestEvent {
    Records: {
        cf: {
            config: {
                distributionDomainName: string
                distributionId: string
                eventType: string
                requestId: string
            }
            request: {
                clientIp: string
                headers: Record<string, { key: string; value: string }[]>
                method: string
                querystring: string
                uri: string // this is the path
            }
            body?: {
                inputTruncated: boolean
                action?: 'read-only' | 'replace'
                encoding?: 'base64' | 'text'
                data: string
            }
        }
    }[]
}

function mapCloudFrontEvent(fn: HttpHandler<any, any, Response>) {
    async function handler(ev: CloudFrontViewerRequestEvent) {
        const r = ev.Records[0]
        const cookies = r.cf.request.headers['cookie']?.flatMap(x => x.value.split(';')).map(x => x.trim())

        const resp = await fn({
            cookies,
            headers: new Headers(Object.values(r.cf.request.headers).flatMap(v => v.map(x => [x.key, x.value] as [string, string]))),
            method: r.cf.request.method,
            path: r.cf.request.uri,
            queryString: r.cf.request.querystring,
            pathParameters: {},
        }, r.cf.body?.data)

        if (resp) {
            return {
                status: String(resp.status),
                body: resp.body,
                headers: resp.headers ? Object.fromEntries(
                    Object.entries(resp.headers).map(([k, v]) => [k, [{ value: v }]])
                ) : undefined
            }
        }

        return r.cf.request
    } 

    return handler
}


export class Distribution {
    public readonly url: string
    public readonly resource: aws.CloudfrontDistribution

    private readonly origins: aws.CloudfrontDistributionOriginProps[] = []
    private readonly cacheBehavior: aws.CloudfrontDistributionOrderedCacheBehaviorProps[] = []

    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html#compressed-content-cloudfront-file-types
    private compress?: boolean

    private readonly bucketDomainName: string

    public constructor(props: DistributionProps) {
        const { bucket, indexKey, domain, compress = true } = props
        this.compress = compress

        const accessControl = new aws.CloudfrontOriginAccessControl({
            name: generateIdentifier(aws.CloudfrontOriginAccessControl, 'name', 62, '/'),
            signingProtocol: 'sigv4',
            signingBehavior: 'always',
            originAccessControlOriginType: 's3',
        })

        const domainName = bucket.resource.bucketRegionalDomainName
        this.bucketDomainName = domainName

        const cert = domain !== undefined ? new certs.Certificate({ zone: domain }) : undefined
        const fn = props.middleware 
            ? core.using(
                new Provider({ region: 'us-east-1' }), 
                () => new LambdaFunction(
                    mapCloudFrontEvent(props.middleware!),
                    { 
                        memory: 128, 
                        timeout: 5, 
                        servicePrincipals: ['edgelambda.amazonaws.com'], 
                        publish: true, // CloudFront requires versioned functions
                    }
            ))
            : undefined

        this.origins.push({
            domainName,
            originId: domainName,
            originAccessControlId: accessControl.id,
        })

        if (props.additionalRoutes) {
            for (const r of props.additionalRoutes) {
                this.addOrigin(r)
            }
        }

        this.resource = new aws.CloudfrontDistribution({
            origin: this.origins,
            aliases: domain !== undefined ? [domain.name] : undefined,
            enabled: true,
            defaultCacheBehavior: {
                compress,
                allowedMethods: ["GET", "HEAD"],
                cachedMethods: ["GET", "HEAD"],
                targetOriginId: domainName,
                viewerProtocolPolicy: 'redirect-to-https',
                cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // 'Managed-CachingOptimized',
                originRequestPolicyId: '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf', // 'Managed-CORS-S3Origin',
                lambdaFunctionAssociation: fn ? [{
                    eventType: 'viewer-request', 
                    lambdaArn: fn.resource.arn + ':' + fn.resource.version
                }] : undefined,
                // forwardedValues: {
                //     queryString: true,
                //     // headers: ['Authorization'],
                //     cookies: { forward: 'none' }
                // }
            },
            orderedCacheBehavior: this.cacheBehavior,
            defaultRootObject: indexKey ?? 'index.html',
            restrictions: {
                geoRestriction: {
                    locations: [],
                    restrictionType: 'none',
                }
            },
            viewerCertificate: cert !== undefined 
                ? { 
                    acmCertificateArn: cert.resource.arn,
                    sslSupportMethod: 'sni-only',
                    minimumProtocolVersion: 'TLSv1.2_2021',
                } 
                : { cloudfrontDefaultCertificate: true }
        })

        if (cert) {
            core.addDependencies(this.resource, cert.validation)
        }

        if (domain !== undefined) {
            new aws.Route53Record({
                zoneId: domain.resource.zoneId,
                name: domain.name,
                type: 'A',
                alias: {
                    name: this.resource.domainName,
                    evaluateTargetHealth: false,
                    zoneId: this.resource.hostedZoneId,
                }
            })
        }

        const policy = new aws.S3BucketPolicy({
            bucket: bucket.name,
            policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: 'Allow',
                        Action: ['s3:GetObject'],
                        Resource: [`${bucket.id}/*`],
                        Principal: {
                            Service: 'cloudfront.amazonaws.com'
                        },
                        Condition: {
                            StringEquals: {
                                'AWS:SourceArn': this.resource.arn,
                            }
                        }
                    }
                ],
            })
        })

        this.url = `https://${domain?.resource.name ?? this.resource.domainName}`
    }

    // XXX: internal only
    public addBucketOrigin(path: string) {
        this.cacheBehavior.push({
            compress: this.compress,
            pathPattern: path,
            allowedMethods: ["GET", "HEAD"],
            cachedMethods: ["GET", "HEAD"],
            targetOriginId: this.bucketDomainName,
            viewerProtocolPolicy: 'redirect-to-https',
            cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // 'Managed-CachingOptimized',
            originRequestPolicyId: '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf', // 'Managed-CORS-S3Origin',
        })
    }
    
    public addOrigin(r: storage.OriginOptions) {
        const originId = `${r.origin}-${this.origins.length}`

        this.origins.push({
            originId,
            domainName: r.origin,
            originPath: r.originPath,
            customOriginConfig: {
                httpPort: 80,
                httpsPort: 443,
                originProtocolPolicy: 'https-only',
                originSslProtocols: ['TLSv1.2'],
            },
        })

        this.cacheBehavior.push({
            targetOriginId: originId,
            allowedMethods: r.allowedMethods,
            cachedMethods: ['GET', 'HEAD'],
            pathPattern: r.targetPath,
            viewerProtocolPolicy: 'redirect-to-https',
            forwardedValues: { queryString: true, cookies: { forward: 'all' } },
            compress: this.compress,
            minTtl: 0,
            maxTtl: 31536000,
            defaultTtl: 86400,
        })
    }
}

export class Invalidation extends core.defineResource({
    create: async (distribution: Distribution) => {
        const command = new CloudFront.CreateInvalidationCommand({
            DistributionId: distribution.resource.id,
            InvalidationBatch: {
                Paths: {
                    Quantity: 1, // Ok so apparently it's the length of items...
                    Items: ['/*'],
                },
                CallerReference: String(Date.now()),
            }
        })
        const client = new CloudFront.CloudFrontClient({})
        const resp = await client.send(command)

        return { id: resp.Invalidation!.Id! }
    }
}) {}

core.addTarget(compute.Website, Website, 'aws')
core.addTarget(storage.CDN, Distribution, 'aws')