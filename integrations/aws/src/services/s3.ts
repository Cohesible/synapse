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
import { addResourceStatement } from '../permissions'

function throwIfNotNoSuchKey(err: unknown) {
    if (!(err instanceof Error) || err.name !== 'NoSuchKey') {
        throw err
    }
    return undefined
}

export class Bucket implements storage.Bucket {
    private readonly client = new S3.S3({})
    public readonly resource: aws.S3Bucket
    public readonly name: string
    public readonly id: string

    public constructor(opt?: { bucket?: aws.S3Bucket }) {
        if (opt?.bucket) {
            this.resource = opt.bucket
        } else {
            this.resource = new aws.S3Bucket({
                bucketPrefix: 'synapse-',
                forceDestroy: !lib.isProd(),
            })
        }
        this.id = this.resource.arn
        this.name = this.resource.bucket

        core.updateLifecycle(this.resource, {
            // Changing `bucketPrefix` = replacement. Not good. This is for backwards compat.
            ignore_changes: ['bucketPrefix']
        })
    }

    // IMPORTANT: S3 returns a 403 instead of a 404 when the user doesn't have permission to list the bucket contents.
    public async get(key: string): Promise<Blob | undefined>
    public async get(key: string, encoding: storage.Encoding): Promise<string | undefined>
    public async get(key: string, encoding?: storage.Encoding): Promise<Blob | string | undefined> {
        try {
            const resp = await this.client.getObject({ Bucket: this.name, Key: key })
            const bytes = await resp.Body!.transformToByteArray()

            // TODO: need way to convert web stream to blob
            return !encoding ? new Blob([bytes]) : Buffer.from(bytes).toString(encoding)
        } catch (e) {
            return throwIfNotNoSuchKey(e)
        }
    }

    public async put(key: string, blob: string | Uint8Array | Blob | AsyncIterable<Uint8Array>): Promise<void> {
        // Currently run into:
        // "Are you using a Stream of unknown length as the Body of a PutObject request? Consider using Upload instead from @aws-sdk/lib-storage."
        if (typeof blob === 'object' && Symbol.asyncIterator in blob) {
            const chunks: Uint8Array[] = []
            for await (const chunk of blob) {
                chunks.push(chunk)
            }
            
            await this.client.putObject({ Bucket: this.name, Key: key, Body: Buffer.concat(chunks) })
            return
        }

        await this.client.putObject({ Bucket: this.name, Key: key, Body: blob })
    }

    public async stat(key: string): Promise<{ size: number; contentType?: string } | undefined> {
        try {
            const resp = await this.client.headObject({ Bucket: this.name, Key: key })

            return { size: resp.ContentLength!, contentType: resp.ContentType }
        } catch (e) {
            // I think `headObject` uses a different exception? 
            if ((e as any).name === 'NotFound' || (e as any).errorType === '403') {
                return
            }
            return throwIfNotNoSuchKey(e)
        }
    }

    public async delete(key: string): Promise<void> {
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

    public getPutUrl(key: string, expiresIn = 3600) {
        return _getPutSignedUrl(this.client, this.resource.bucket, key, expiresIn)
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

function _getPutSignedUrl(client: S3.S3, bucket: string, key: string, expiresIn: number) {
    const command = new S3.PutObjectCommand({ Bucket: bucket, Key: key })

    return getSignedUrl(client, command, { expiresIn })
}

core.addTarget(storage.Bucket, Bucket, 'aws')

function addS3Statement(recv: any, action: string | string[], resource: string) {
    addResourceStatement({
        service: 's3',
        region: '',
        account: '',
        action,
        resource,
    }, recv)
}

core.bindFunctionModel(_getSignedUrl, function (client, bucket, key) {
    addS3Statement(this, 'GetObject', `${bucket}/${key}`)

    return ''
})

core.bindFunctionModel(_getUploadPartSignedUrl, function (client, req) {
    addS3Statement(this, 'PutObject', `${req.bucket}/${req.key}`)

    return ''
})

core.bindFunctionModel(_getPutSignedUrl, function (client, bucket, key) {
    addS3Statement(this, 'PutObject', `${bucket}/${key}`)

    return ''
})

core.bindModel(S3.S3, {
    'putObject': function (req) {
        addS3Statement(this, 'PutObject', `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
    },
    'getObject': function (req) {
        addS3Statement(this, 'GetObject', `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
    },
    'headObject': function (req) {
        addS3Statement(this, 'GetObject', `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
    },
    'listBuckets': function (req) {
        addS3Statement(this, 'ListAllMyBuckets', '*')

        return core.createUnknown()
    },
    'deleteObject': function (req) {
        addS3Statement(this, 'DeleteObject', `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
    },
    'listObjects': function (req) {
        addS3Statement(this, 'ListBucket', req.Bucket)

        return core.createUnknown()
    },
    'listObjectsV2': function (req) {
        addS3Statement(this, 'ListBucket', req.Bucket)

        return { Contents: [{ Key: core.createUnknown() }] }
    },
    'createBucket': function (req) {
        addS3Statement(this, 'CreateBucket', req.Bucket)

        return core.createUnknown()
    },
    'deleteBucket': function (req) {
        addS3Statement(this, 'DeleteBucket', req.Bucket)

        return core.createUnknown()
    },
    'putBucketPolicy': function (req) {
        addS3Statement(this, 'PutBucketPolicy', req.Bucket)

        return core.createUnknown()
    },
    'getBucketPolicy': function (req) {
        addS3Statement(this, 'GetBucketPolicy', req.Bucket)

        return core.createUnknown()
    },
    'copyObject': function (req) {
        addS3Statement(this, ['GetObject', 'GetObjectTagging'], req.CopySource)
        addS3Statement(this, ['PutObject', 'PutObjectTagging'], `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
    },
    'createMultipartUpload': function (req) {
        addS3Statement(this, 'PutObject', `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
    },
    'completeMultipartUpload': function (req) {
        addS3Statement(this, 'PutObject', `${req.Bucket}/${req.Key}`)

        return core.createUnknown()
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


