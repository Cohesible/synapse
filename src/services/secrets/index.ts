import * as path from 'node:path'
import { getGlobalCacheDirectory } from '../../workspaces'
import { secrets } from '@cohesible/resources'
import { getFs } from '../../execution'
import { getLogger } from '../../logging'
import { throwIfNotFileNotFoundError } from '../../utils'
import { getInmemSecretService } from './inmem'


const secretsCache = new Map<string, secrets.Secret>()

// XXX: we should not be storing this in plaintext. OS keychain would be best
const getSecretsCacheFile = () => path.resolve(
    getGlobalCacheDirectory(), // TODO: this should be a per-project (or per-program) cache
    'secrets.json'
)

async function writeSecretsCache() {
    const fs = getFs()
    const data = Object.fromEntries(
        [...secretsCache.entries()].map(([k, v]) => [k, { ...v, expiration: v.expiration ?? (new Date(Date.now() + 15 * 60 * 1000)).toISOString()}])
    )
    await fs.writeFile(getSecretsCacheFile(), JSON.stringify(data))
}

async function readSecretsCache() {
    const fs = getFs()
    const data = await fs.readFile(getSecretsCacheFile(), 'utf-8').catch(throwIfNotFileNotFoundError)

    if (!data) {
        return
    }

    for (const [k, v] of Object.entries(JSON.parse(data))) {
        secretsCache.set(k, v as secrets.Secret)
    }
}

const useInmem = false

async function getSecretValue(secretType: string) {
    if (useInmem) {
        return getInmemSecretService().getSecret(secretType)
    }

    const envVar = secretType.toUpperCase().replaceAll('-', '_')
    if (process.env[envVar]) {
        return { value: process.env[envVar]! }
    }

    const resp = await secrets.client.listSecrets()
    const filtered = resp.filter(s => s.secretType === secretType)
    if (filtered.length === 0) {
        throw new Error(`No secrets found matching type: ${secretType}`)
    }

    return secrets.client.getSecretValue(filtered[0].id)
}

export async function getSecret(type: string) {
    await readSecretsCache()
    if (secretsCache.has(type)) {
        const secret = secretsCache.get(type)!
        if (!secret.expiration || (new Date(secret.expiration).getTime() > Date.now())) {
            return secret.value
        }

        getLogger().log(`Removing expired secret from cache: ${type}`)
    }

    getLogger().log(`Getting secret type: ${type}`)
    const secret = await getSecretValue(type)
    secretsCache.set(type, secret)
    await writeSecretsCache()

    return secret.value
}

async function getOrCreateSecret(secretType: string) {
    const resp = await secrets.client.listSecrets()
    const filtered = resp.filter(s => s.kind === secretType)
    if (filtered.length > 0) {
        return filtered[0]
    }

    return await secrets.client.createSecret({ secretType })
}

export async function putSecret(secretType: string, value: string, expiresIn?: number) {
    const secret = await getOrCreateSecret(secretType)
    await secrets.client.putSecretValue(secret.id, value)
}
