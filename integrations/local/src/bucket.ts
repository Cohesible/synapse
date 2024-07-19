import * as fs from 'node:fs/promises'
import * as core from 'synapse:core'
import * as path from 'node:path'
import * as storage from 'synapse:srl/storage'
import { getContentType } from 'synapse:http'
import { createHash, randomUUID } from 'node:crypto'
import { getLocalPath } from './provider'

function isFileNotFoundError(e: unknown) {
    return (e as any).code === 'ENOENT'
}

function throwIfNotFileNotFoundError(e: unknown) {
    if (!isFileNotFoundError(e)) {
        throw e
    }
}

const kvPath = getLocalPath('kv')
function getStoreFilePath(id: string) {
    return path.resolve(kvPath, id)
}

export class LocalKVStore extends core.defineResource({
    create: async () => {
        const id = randomUUID()
        await fs.mkdir(getStoreFilePath(id), { recursive: true })

        return { id }
    },
    update: state => state,
    delete: async (state) => {
        await fs.rm(getStoreFilePath(state.id), { force: true, recursive: true }).catch(throwIfNotFileNotFoundError)
    },
}) {
    async put(key: string, value: Uint8Array) {
        const p = path.resolve(getStoreFilePath(this.id), key)
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, value)
    }

    async get(key: string): Promise<Blob | undefined>
    async get(key: string, encoding: storage.Encoding): Promise<string | undefined>
    async get(key: string, encoding?: storage.Encoding): Promise<string | Blob | undefined> {        
        const data = await fs.readFile(path.resolve(getStoreFilePath(this.id), key), encoding).catch(e => {
            throwIfNotFileNotFoundError(e)
            return undefined
        })

        if (encoding) {
            return data
        }

        return data !== undefined ? new Blob([data]) : undefined
    }

    async stat(key: string) {        
        const stats = await fs.stat(path.resolve(getStoreFilePath(this.id), key))

        return {
            size: stats.size,
            contentType: getContentType(key),
        }
    }

    async list(prefix?: string) {        
        const keys: string[] = []
        const root = getStoreFilePath(this.id)
        const prefixes = prefix ? prefix.split('/') : []
        const getRelPath = (from: string, to: string) => process.platform === 'win32'
            ? path.relative(from, to).replaceAll(path.sep, '/')
            : path.relative(from, to)

        async function readdir(p: string, depth = 0) {
            const prefix = prefixes[depth]
            const files = await fs.readdir(p, { withFileTypes: true })
            for (const f of files) {
                const filePath = path.resolve(p, f.name)
                if (prefix && !(depth === prefixes.length - 1 ? f.name.startsWith(prefix) : f.name === prefix)) continue

                if (f.isDirectory()) {
                    await readdir(filePath, depth + 1)
                    continue
                }

                keys.push(getRelPath(root, filePath))
            }
        }

        await readdir(root)

        return keys
    }

    async delete(key: string) {        
        await fs.rm(path.resolve(getStoreFilePath(this.id), key)).catch(throwIfNotFileNotFoundError)
    }
}

class LocalObject extends core.defineResource({
    create: async (store: LocalKVStore, key: string, source: string) => {
        const data = await fs.readFile(source)
        await store.put(key, data)
    },
    delete: async (_, store, key) => {
        await store.delete(key)
    },
}) {}

export class Bucket implements storage.Bucket {
    private readonly resource = new LocalKVStore()

    public get(key: string): Promise<Blob | undefined>
    public get(key: string, encoding: storage.Encoding): Promise<string | undefined>
    public get(key: string, encoding?: storage.Encoding): Promise<Blob | string | undefined> {
        return this.resource.get(key, encoding)
    }

    public async put(key: string, blob: string | Uint8Array): Promise<void> {
        await this.resource.put(key, typeof blob === 'string' ? Buffer.from(blob) : blob)
    }

    public async stat(key: string): Promise<{ size: number; contentType?: string }> {
        return this.resource.stat(key)
    }

    public async delete(key: string): Promise<void> {
        await this.resource.delete(key)
    }

    public async list(prefix?: string): Promise<string[]> {
        return this.resource.list(prefix)
    }

    public addBlob(source: string, key = path.basename(source), contentType?: string) {
        new LocalObject(this.resource, key, source)

        return key
    }
}

core.addTarget(storage.Bucket, Bucket, 'local')