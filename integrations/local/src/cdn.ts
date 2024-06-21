import * as core from 'synapse:core'
import * as storage from 'synapse:srl/storage'
import * as compute from 'synapse:srl/compute'

export class CDN implements storage.CDN {
    public readonly url: string

    constructor(props: { bucket: storage.Bucket }) {
        const service = new compute.HttpService({ auth: 'none' })
        service.addRoute('GET /{key+}', async req => {
            const key = req.pathParameters.key
            const [data, metadata] = await Promise.all([
                props.bucket.get(key),
                props.bucket.stat(key)
            ])

            const contentType = metadata.contentType ?? 'application/octet-stream'

            return new Response(data, {
                headers: {
                    'content-type': contentType
                }
            })
        })

        this.url = service.invokeUrl
    }

    addOrigin(origin: storage.OriginOptions): void {
        
    }
}

core.addTarget(storage.CDN, CDN, 'local')
