import * as fs from 'node:fs/promises'
import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as path from 'node:path'
import * as S3 from '@aws-sdk/client-s3'
import * as aws from 'synapse-provider:aws'
import * as storage from 'synapse:srl/storage'
import { statSync } from 'fs'
import { getFileHash, getDataHash, listFiles } from '../utils'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getContentType } from 'synapse:http'

export class Bucket implements storage.Bucket {
    private readonly client = new S3.S3({})
    public readonly resource: aws.S3Bucket
    public readonly name: string
    public readonly id: string

    public constructor() {
        this.resource = new aws.S3Bucket({
            bucketPrefix: 'synapse-',
            forceDestroy: !lib.isProd(),
        })
        this.id = this.resource.arn
        this.name = this.resource.bucket

        core.updateLifecycle(this.resource, {
            // Changing `bucketPrefix` = replacement. Not good. This is for backwards compat.
            ignore_changes: ['bucketPrefix']
        })
    }

    // IMPORTANT: S3 returns a 403 instead of a 404 when the user doesn't have permission to list the bucket contents.
    public async get(key: string): Promise<Uint8Array>
    public async get(key: string, encoding: storage.Encoding): Promise<string>
    public async get(key: string, encoding?: storage.Encoding): Promise<Uint8Array | string> {
        const resp = await this.client.getObject({ Bucket: this.name, Key: key })
        const bytes = await resp.Body!.transformToByteArray()

        return !encoding ? bytes : Buffer.from(bytes).toString(encoding)
    }

    public async put(key: string, blob: string | Uint8Array): Promise<void> {
        await this.client.putObject({ Bucket: this.name, Key: key, Body: blob })
    }

    public async stat(key: string): Promise<{ size: number; contentType?: string }> {
        const resp = await this.client.headObject({ Bucket: this.name, Key: key })

        return { size: resp.ContentLength!, contentType: resp.ContentType }
    }

    public async delete(key: string): Promise<void> {
        // TODO: make a `tryDelete` instead
        // if ((e as any).name !== 'NoSuchKey') {
        //     throw e
        // }

        await this.client.deleteObject({ Bucket: this.name, Key: key })
    }

    public async list(prefix?: string): Promise<string[]> {
        const resp = await this.client.listObjectsV2({
            Bucket: this.name,
            Prefix: prefix,
        })

        return resp.Contents?.map(x => x.Key!) ?? []
    }

    public addBlob(sourceOrPointer: string | core.DataPointer, key = path.basename(sourceOrPointer), contentType?: string) {
        new aws.S3Object({
            key,
            source: sourceOrPointer,
            bucket: this.name,
            contentType: contentType ?? getContentType(sourceOrPointer),
        })

        return key
    }

    public getUrl(key: string, expiresIn = 3600) {
        return _getSignedUrl(this.client, this.resource.bucket, key, expiresIn)
    }

    public async startMultipartUpload(key: string) {
        const resp = await this.client.createMultipartUpload({
            Key: key,
            Bucket: this.resource.bucket,
        })

        return { key: key, uploadId: resp.UploadId! }
    }

    public async completeMultipartUpload(uploadId: string, key: string, parts: string[]) {
        await this.client.completeMultipartUpload({ 
            Bucket: this.resource.bucket, 
            Key: key, 
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts.map((p, i) => ({
                    PartNumber: i + 1,
                    ETag: p,
                })),
            },
        })
    }

    public async getMultipartUploadSignedUrls(uploadId: string, key: string, numParts: number, expiresIn = 3600) {
        if (numParts <= 0) {
            throw new Error(`Expected number of parts greater than 0, got: ${numParts}`)
        }

        const baseReq: Omit<UploadPartRequest, 'part'> = { uploadId, bucket: this.resource.bucket, key }
        const urls: Promise<string>[] = []
        for (let i = 0; i < numParts; i++) {
            const url = _getUploadPartSignedUrl(this.client, { ...baseReq, part: i + 1 }, expiresIn)
            urls.push(url)
        }

        return Promise.all(urls)
    }

    public static import(name: string): Bucket {
        const resource = new aws.S3BucketData({ bucket: name })
        const client = new S3.S3({})

        const inst = {
            client,
            resource,
            id: resource.arn,
            name,
        }
        Object.setPrototypeOf(inst, Bucket.prototype)

        return inst as any
    }
}


// XXX: hack to make permissions work
function _getSignedUrl(client: S3.S3, bucket: string, key: string, expiresIn: number) {
    const command = new S3.GetObjectCommand({ Bucket: bucket, Key: key })

    return getSignedUrl(client, command, { expiresIn })
}

interface UploadPartRequest {
    readonly bucket: string
    readonly key: string
    readonly uploadId: string
    readonly part: number
}

function _getUploadPartSignedUrl(client: S3.S3, req: UploadPartRequest, expiresIn: number) {
    const command = new S3.UploadPartCommand({ Bucket: req.bucket, Key: req.key, UploadId: req.uploadId, PartNumber: req.part })

    return getSignedUrl(client, command, { expiresIn })
}

core.addTarget(storage.Bucket, Bucket, 'aws')

core.bindFunctionModel(_getSignedUrl, function (client, bucket, key) {
    this.$context.addStatement({
        Action: 's3:GetObject',
        Resource: `arn:${this.$context.partition}:s3:::${bucket}/${typeof key === 'symbol' ? '*' : key}`
    })
    return ''
})

core.bindFunctionModel(_getUploadPartSignedUrl, function (client, req) {
    this.$context.addStatement({
        Action: 's3:PutObject',
        Resource: `arn:${this.$context.partition}:s3:::${req.bucket}/${typeof req.key === 'symbol' ? '*' : req.key}`
    })
    return ''
})

core.bindModel(S3.S3, {
    'putObject': {
        'Effect': 'Allow',
        'Action': 's3:PutObject',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}' 
    },
    'getObject': {
        'Effect': 'Allow',
        'Action': 's3:GetObject',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}' 
    },
    'headObject': {
        'Effect': 'Allow',
        'Action': 's3:GetObject',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}' 
    },
    'listBuckets': {
        'Effect': 'Allow',
        'Action': 's3:ListAllMyBuckets',
        'Resource': 'arn:{context.Partition}:s3:::*'
    },
    'deleteObject': {
        'Effect': 'Allow',
        'Action': 's3:DeleteObject',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}' 
    },
    'listObjects': {
        'Effect': 'Allow',
        'Action': 's3:ListBucket',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}' 
    },
    'listObjectsV2': function (req) {
        this.$context.addStatement({
            'Action': 's3:ListBucket',
            'Resource': `arn:${this.$context.partition}:s3:::${req.Bucket}`
        })

        return { Contents: [{ Key: this.$context.createUnknown() }] }
    },
    'createBucket': {
        'Effect': 'Allow',
        'Action': 's3:CreateBucket',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}' 
    },
    'deleteBucket': {
        'Effect': 'Allow',
        'Action': 's3:DeleteBucket',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}' 
    },
    'putBucketPolicy': {
        'Effect': 'Allow',
        'Action': 's3:PutBucketPolicy',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}' 
    },
    'getBucketPolicy': {
        'Effect': 'Allow',
        'Action': 's3:GetBucketPolicy',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}' 
    },
    'copyObject': [
        {
            'Effect': 'Allow',
            'Action': ['s3:GetObject', 's3:GetObjectTagging'],
            'Resource': 'arn:{context.Partition}:s3:::{0.CopySource}' 
        },
        {
            'Effect': 'Allow',
            'Action': ['s3:PutObject', 's3:PutObjectTagging'],
            'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}' 
        }
    ],
    'createMultipartUpload': {
        'Effect': 'Allow',
        'Action': 's3:PutObject',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}'
    },
    'completeMultipartUpload': {
        'Effect': 'Allow',
        'Action': 's3:PutObject',
        'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}'
    },
})

// cloud.bindModel(aws.S3Bucket, {
//     'constructor': [
//         {
//             'Effect': 'Allow',
//             'Action': ['s3:GetObject', 's3:GetObjectTagging'],
//             'Resource': 'arn:{context.Partition}:s3:::${0.CopySource}' 
//         },
//         {
//             'Effect': 'Allow',
//             'Action': ['s3:PutObject', 's3:PutObjectTagging'],
//             'Resource': 'arn:{context.Partition}:s3:::{0.Bucket}/{0.Key}' 
//         }
//     ]
// })

export class BucketDeployment {
    public readonly assets: string[] = []
    private readonly objects: (aws.S3Object | DirectoryDeployment)[] = []

    public constructor(
        private readonly store: Bucket, 
        target?: string | lib.Archive
    ) {
        if (!target) {
            return
        }

       if (typeof target === 'string') {
            const dirOrFile = path.resolve(process.cwd(), target)
            if (statSync(dirOrFile).isDirectory()) {
                this.objects.push(new DirectoryDeployment(store.name, dirOrFile))
            } else {
                this.add(target)
            }
        } else if (target instanceof lib.Archive) {
            const location = target.filePath
            const key = path.basename(location)
            this.addObject({
                key,
                source: location,
                bucket: store.name,
                sourceHash: getFileHash(location),
                contentType: getContentType(key),
            })
        }
    }

    public add(source: string) {
        const key =  path.basename(source)
        this.addObject({
            key,
            source,
            bucket: this.store.name,
        })

        return getObjectUrl(this.store, key)
    }

    private addObject(...args: ConstructorParameters<typeof aws.S3Object>) {
        const o = new aws.S3Object(...args)
        this.assets.push(args[0].key)
        this.objects.push(o)

        return o
    }
}

export function getObjectUrl(bucket: Bucket, key: string) {
    return `https://${bucket.name}.s3-${bucket.resource.region}.amazonaws.com/${key}`
}

core.addTarget(storage.StaticDeployment, BucketDeployment, 'aws')

class DirectoryDeployment extends core.defineResource({
    create: async (bucketName: string, dir: string) => {
        const client = new S3.S3({})
        const assets = Array.from(listFiles(dir)).map(async p => {
            const key = path.basename(p)
            const body = await fs.readFile(p)
            const hash = getDataHash(body)
            // Checksum is base64 encoded ???

            await client.putObject({
                Key: key,
                Body: body,
                Bucket: bucketName,
                // ChecksumSHA256: hash,
                ContentType: getContentType(p),
            })

            return { key, hash }
        })

        return { bucketName, assets: await Promise.all(assets) }
    },
    update: async (state, bucketName, dir) => {
        const client = new S3.S3({})
        const assets = Array.from(listFiles(dir)).map(async p => {
            const key = path.basename(p)
            const body = await fs.readFile(p)
            const hash = getDataHash(body)
            const matched = state.assets.find(f => f.key === key)
            if (!matched || matched?.hash !== hash) {
                await client.putObject({
                    Key: key,
                    Body: body,
                    Bucket: bucketName,
                    ContentType: getContentType(p),
                })
            }

            return { key, hash }
        })

        const updatedAssets = await Promise.all(assets)
        for (const f of state.assets) {
            const matched = updatedAssets.find(f2 => f.key === f2.key)
            if (!matched) {
                await deleteObject(client, f.key, state.bucketName)
            }
        }

        return { bucketName, assets: updatedAssets }
    },
    delete: async (state) => {
        const client = new S3.S3({})
        await Promise.all(state.assets.map(async ({ key }) => {
            if (!key) return;
            await deleteObject(client, key, state.bucketName)
        }))
    },
}) {}

async function deleteObject(client: S3.S3, key: string, bucket: string) {
    try {
        await client.deleteObject({
            Key: key,
            Bucket: bucket,
        })
    } catch (e) {
        if ((e as any).name !== 'NoSuchKey') {
            throw e
        }
    }
}


