//@internal
//# moduleId = synapse:key-service
//# transform = persist

import { defineResource } from 'synapse:core'
import * as crypto from 'node:crypto'
import * as storage from 'synapse:srl/storage'
import { HttpError } from 'synapse:http'

export function createKeyService() {
    const keyBucket = new storage.Bucket()

    class EdwardsKeyPair extends defineResource({
        create: async () => {
            const id = crypto.randomUUID()
            const { publicKey, privateKey } = await createEdwardsKeyPair()
    
            await Promise.all([
                keyBucket.put(`${id}.public`, Buffer.from(publicKey)),
                keyBucket.put(`${id}.private`, Buffer.from(privateKey)),
            ])
    
            return { id, alg: 'EdDSA', crv: 'Ed448' }
        },
        update: state => state,
        delete: async state => {
            await Promise.all([
                keyBucket.delete(`${state.id}.public`),
                keyBucket.delete(`${state.id}.private`)
            ])
        }
    }) {
        async sign(data: string | Buffer) {
            const location = `${this.id}.private`
            const keyData = Buffer.from(await keyBucket.get(location))
            const privateKey = await importPrivateEdwardsKey(keyData)
            const buffer = typeof data === 'string' ? Buffer.from(data) : data
    
            return crypto.subtle.sign('Ed448', privateKey, buffer)
        }
    
        async verify(data: string | Buffer, signature: Buffer) {
            const keyData = await this.getPublicKey()
            const publicKey = await importPublicEdwardsKey(keyData)
            const buffer = typeof data === 'string' ? Buffer.from(data) : data
    
            return crypto.subtle.verify('Ed448', publicKey, signature, buffer)
        }
    
        async getPublicKey() {
            const location = `${this.id}.public`
            const keyData = Buffer.from(await keyBucket.get(location))
    
            return keyData
        }
    
        async getPublicWebKey() {
            const keyData = await this.getPublicKey()
            const publicKey = await crypto.subtle.importKey('raw', keyData, { name: 'Ed448' }, true, ['verify'])
            const jwk = await crypto.subtle.exportKey('jwk', publicKey)
    
            return jwk
        }
    }
    
    class RSAKeyPair extends defineResource({
        create: async () => {
            const id = crypto.randomUUID()
            const result = crypto.generateKeyPairSync('rsa', { 
                modulusLength: 4096
            })
            
            const publicKey = result.publicKey.export({ type: 'pkcs1', format: 'pem' })
            const privateKey = result.privateKey.export({ type: 'pkcs8', format: 'pem' })
    
            await Promise.all([
                keyBucket.put(`${id}.public`, publicKey),
                keyBucket.put(`${id}.private`, privateKey)
            ])
    
            return { id, alg: 'RS256', crv: undefined }
        },
        update: state => state,
        delete: async state => {
            await Promise.all([
                keyBucket.delete(`${state.id}.public`),
                keyBucket.delete(`${state.id}.private`)
            ])
        }
    }) {
        async sign(data: string | Buffer) {
            const location = `${this.id}.private`
            const privateKey = crypto.createPrivateKey(Buffer.from(await keyBucket.get(location)))
            const signer = crypto.createSign('RSA-SHA256')
    
            return signer.update(data).sign(privateKey)
        }
    
        async verify(data: string | Buffer, signature: Buffer) {
            const location = `${this.id}.public`
            const publicKey = crypto.createPublicKey(Buffer.from(await keyBucket.get(location)))
            const verifier = crypto.createVerify('RSA-SHA256')
    
            return verifier.update(data).verify(publicKey, signature)
        }
    
        async getPublicKey() {
            const location = `${this.id}.public`
            const keyData = Buffer.from(await keyBucket.get(location))
    
            return keyData
        }
    
        async getPublicWebKey() {
            const keyData = await this.getPublicKey()
            const publicKey = crypto.createPublicKey(keyData)
    
            return publicKey.export({ format: 'jwk' })
        }
    }

    return { RSAKeyPair, EdwardsKeyPair }
}

type ServiceResources = ReturnType<typeof createKeyService>
export type RSAKeyPair = InstanceType<ServiceResources['RSAKeyPair']>
export type EdwardsKeyPair = InstanceType<ServiceResources['EdwardsKeyPair']>

// From `lib.dom.d.ts`
export interface RsaOtherPrimesInfo {
    d?: string;
    r?: string;
    t?: string;
}

// From `lib.dom.d.ts`
export interface JsonWebKey {
    alg?: string;
    crv?: string;
    d?: string;
    dp?: string;
    dq?: string;
    e?: string;
    ext?: boolean;
    k?: string;
    key_ops?: string[];
    kty?: string;
    n?: string;
    oth?: RsaOtherPrimesInfo[];
    p?: string;
    q?: string;
    qi?: string;
    use?: string;
    x?: string;
    y?: string;
}

export interface KeyPair {
    readonly alg: string
    readonly crv?: string
    sign(data: string | Buffer): Promise<ArrayBuffer>
    verify(data: string | Buffer, signature: Buffer): Promise<boolean>
    getPublicWebKey(): Promise<JsonWebKey> 
}

export async function createEdwardsKeyPair() {
    const result = (await crypto.subtle.generateKey({
        name: 'Ed448',
    }, true, ['sign', 'verify'])) as crypto.webcrypto.CryptoKeyPair

    const publicKey = await crypto.subtle.exportKey('raw', result.publicKey)
    const privateKey = await crypto.subtle.exportKey('pkcs8', result.privateKey)

    return { publicKey, privateKey }
}

export async function importPublicEdwardsKey(keyData: Buffer) {
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'Ed448' }, true, ['verify'])

    return key
}

export async function importPrivateEdwardsKey(keyData: Buffer) {
    const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'Ed448' }, true, ['sign'])

    return key
}

export async function createJwsBody(url: string, payload: any, key: KeyPair, nonce: string, kid?: string) {
    const baseHeader = {
        alg: key.alg, 
        crv: key.crv, 
    }
    const header = kid 
        ? { ...baseHeader, kid, nonce, url } 
        : { ...baseHeader, jwk: await key.getPublicWebKey(), nonce, url } 

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const encodedPayload = payload ? Buffer.from(JSON.stringify(payload)).toString('base64url') : ''
    const encoded = encodedHeader + '.' + encodedPayload
    const signature = Buffer.from(await key.sign(encoded)).toString('base64url')

    return {
        protected: encodedHeader,
        payload: encodedPayload,
        signature,
    }
}

export async function thumbprintBase64Url(jwk: JsonWebKey) {
    const hash = await crypto.subtle.digest('SHA-256', Buffer.from(JSON.stringify(getData())))

    return Buffer.from(hash).toString('base64url')

    function getData() {
        switch (jwk.kty) {
            case 'RSA':
                return {
                    e: jwk.e,
                    kty: jwk.kty,
                    n: jwk.n,
                }
            case 'EC':
                return  {
                    crv: jwk.crv,
                    kty: jwk.kty,
                    x: jwk.x,
                    y: jwk.y
                }
            case 'oct':
                return {
                    k: jwk.k,
                    kty: jwk.kty,
                }
            default: 
                throw new Error(`Unknown key type: ${jwk.kty}`)
        }
    }
}

// TODO: dedupe with `createJwsBody`
export async function encodeJwt(payload: any, key: Pick<KeyPair, 'alg' | 'crv' | 'sign'>) {
    const header = { alg: key.alg, crv: key.crv }
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const encoded = encodedHeader + '.' + encodedPayload
    const signature = Buffer.from(await key.sign(encoded)).toString('base64url')

    return `${encoded}.${signature}`
}

interface JwtClaims {
    iss?: string
    sub?: string
    aud?: string | string[]
    exp?: number
    nbf?: number
    iat?: number
    jti?: string 
}

// JWTs kind of suck. There's no need to encode so much information into 
// the token when using centralized auth.
export async function createJwt(
    key: Pick<KeyPair, 'alg' | 'crv' | 'sign'>, 
    durationInMinutes: number, 
    claims: Omit<JwtClaims, 'iat' | 'exp'>
) {
    const payload = {
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: Math.floor(Date.now() / 1000) + (durationInMinutes * 60),
        // jti: claims.jti ?? crypto.randomUUID(),
        ...claims,
    }

    return {
        token: await encodeJwt(payload, key),
        expirationEpoch: Date.now() + ((durationInMinutes - 1) * 60 * 1000), // 1 minute offset for clock drift
    }
}

export async function getClaims(token: string, secret: Pick<KeyPair, 'alg' | 'crv' | 'verify'>) {
    const [header, body, signature] = token.split('.')
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf-8')) 
    if (decodedHeader.alg !== secret.alg) {
        throw new Error(`Invalid JWT header. Expected "alg" to be "${secret.alg}".`)
    }

    if (secret.crv && decodedHeader.crv !== secret.crv) {
        throw new Error(`Invalid JWT header. Expected "crv" to be "${secret.crv}".`)
    }

    const isValidSignature = await secret.verify(header + '.' + body, Buffer.from(signature, 'base64url'))
    if (!isValidSignature) {
        throw new HttpError('Bad JWT signature', { statusCode: 401 })
    }

    return JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as JwtClaims
}

export function isJwtExpired(claims: JwtClaims) {
    if (!claims.exp) {
        return false
    }

    const currentTimeSeconds = Date.now() / 1000

    return claims.exp <= currentTimeSeconds
}

export class RandomString extends defineResource({
    create: (length: number) => {
        const value = crypto.randomBytes(length).toString('base64url')

        return { value }
    },
    update: state => state,
}) {}


export async function buildDnsTxtValue(token: string, key: EdwardsKeyPair | RSAKeyPair) {
    const thumbprint = await thumbprintBase64Url(await key.getPublicWebKey())
    const hash = await crypto.subtle.digest('SHA-256', Buffer.from(token + '.' + thumbprint))

    return Buffer.from(hash).toString('base64url')
}


// MacOS profiles
// https://developer.apple.com/business/documentation/Configuration-Profile-Reference.pdf
