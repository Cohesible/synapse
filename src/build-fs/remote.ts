import * as path from 'node:path'
import { DataRepository, Head } from '../artifacts'
import { getLogger } from '../logging'
import { projects } from '@cohesible/resources'
import { getFs } from '../execution'
import { createBlock, openBlock } from './block'
import { getHash, gunzip, gzip } from '../utils'

export interface RemoteArtifactRepository {
    // listHeads(): Promise<Head[]>
    getHead(id: string): Promise<Head | undefined>
    putHead(head: Head): Promise<void>
    pull(storeHash: string): Promise<void>
    push(storeHash: string): Promise<void>
}

export function createRemoteArtifactRepo(
    repo: DataRepository,
    projectId: string
): RemoteArtifactRepository {
    async function putHead(head: Head) {
        await projects.client.putHead(projectId, {
            ...head,
            indexHash: head.storeHash,
            previousCommit: undefined, // XXX
        })
    }

    async function getHead(id: Head['id']): Promise<Head | undefined> {
        const head = await projects.client.getHead(projectId, id).catch(e => {
            if ((e as any).statusCode !== 404) {
                throw e
            }
        })
        if (!head) {
            return
        }

        return {
            ...head,
            storeHash: head.indexHash,
        }
    }

    async function pull(buildFsHash: string): Promise<void> {
        if (await repo.hasData(buildFsHash)) {
            getLogger().debug(`Skipped pulling index`, buildFsHash)
            return
        }

        getLogger().debug(`Pulling index`, buildFsHash)

        const block = await projects.client.getObject(buildFsHash, 'block').then(gunzip)
        const b = openBlock(block)
        await Promise.all(b.listObjects().map(h => repo.writeData(h, b.readObject(h))))
    }

    async function push(buildFsHash: string): Promise<void> {
        getLogger().debug(`Pushing index`, buildFsHash)

        const buildFs = await repo.getBuildFs(buildFsHash)
        const data = await repo.serializeBuildFs(buildFs)
        const block = createBlock(Object.entries(data))
        const zipped = await gzip(block)

        const hash = getHash(zipped)
        await projects.client.putObject(hash, zipped.toString('base64'), 'block', buildFsHash)
    }

    return {
        getHead,
        putHead,
        pull,
        push,
    }
}
