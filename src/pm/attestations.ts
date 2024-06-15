// Variant of https://github.com/secure-systems-lab/dsse using UTF-8 for the payload

export interface Envelope {
    readonly payload: string // utf-8
    readonly payloadType: string
    readonly signatures: {
        readonly keyid: string
        readonly sig: string // base64url
    }[]
}

export interface KeyPair {
    readonly id: string
    sign(data: Buffer): Promise<Uint8Array>
    verify(data: Buffer, sig: Buffer): Promise<boolean>
}

function createHeader(envelope: Omit<Envelope, 'signatures'>) {
    const data = Buffer.from(envelope.payload, 'utf-8')
    const type = Buffer.from(envelope.payloadType, 'utf-8')
    
    return Buffer.concat([
        Buffer.from(String(type.byteLength) + ' ', 'utf-8'),
        type,
        Buffer.from(' ' + String(data.byteLength) + ' ', 'utf-8'),
        data,
    ])
}

export async function sign(envelope: Omit<Envelope, 'signatures'>, key: Pick<KeyPair, 'id' | 'sign'>) {
    const header = createHeader(envelope)
    const sig = Buffer.from(await key.sign(header)).toString('base64url')

    return { keyid: key.id, sig }
}

export async function verify(envelope: Envelope, key: Pick<KeyPair, 'id' | 'verify'>) {
    const signature = envelope.signatures[0]
    if (!signature) {
        throw new Error(`Envelope is missing a signature`)
    }

    if (signature.keyid !== key.id) {
        throw new Error(`Found different key ids: ${signature.keyid} !== ${key.id}`)
    }

    const header = createHeader(envelope)

    return key.verify(header, Buffer.from(signature.sig, 'base64url'))
}