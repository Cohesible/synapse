import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'
import { HttpRequest } from "@smithy/protocol-http"
import { defaultProvider } from '@aws-sdk/credential-provider-node'

export interface Credentials {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
}

interface SignerContext {
    readonly region: string
    readonly service: string
    readonly credentials?: Credentials
}

export async function signRequest(ctx: SignerContext, request: HttpRequest) {
    const signer = new SignatureV4({
        ...ctx,
        credentials: defaultProvider(),
        sha256: Hash.bind(null, 'sha256'),
    })

    return signer.sign(request)
}

