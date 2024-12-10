import * as path from 'node:path'
import { DataRepository, getDataRepository, readJsonRaw, Head } from '../artifacts'
import { getFs, runWithContext, throwIfCancelled } from '../execution'
import { createBlock } from './block'
import { collectAllStats, mergeRepoStats } from './stats'

export async function createIndexBackup(dest: string) {
    const repo = getDataRepository(getFs())
    const indices = new Set<string>()

    async function visitHead(h: Head, source: string) {
        indices.add(h.storeHash)
        if (h.programHash) {
            indices.add(h.programHash)
            const { index } = await repo.getBuildFs(h.programHash)
            if (index.dependencies) {
                Object.values(index.dependencies).forEach(d => indices.add(d))
            }
        }
        
        if (h.previousCommit) {
            const commit = await readJsonRaw<Head>(repo, h.previousCommit)
            await visitHead(commit, source)
        }
    }

    const stats = await collectAllStats(repo)
    const merged = mergeRepoStats(stats)

    const allObjects = new Set([
        ...merged.objects,
        ...merged.stores,
        ...merged.indices,
        ...merged.commits,
    ])

    const data: Record<string, Uint8Array> = {}
    for (const h of allObjects) {
        data[h] = await repo.readData(h)
    }

    const block = createBlock(Object.entries(data))
    await getFs().writeFile(dest, block)

    // for (const h of await repo.listHeads()) {
    //     await visitHead(h, h.id)
    // }

    // // XXX: doing this all in-mem = fast way to OOM
    // const blocks = new Map<string, Buffer>()
    // for (const h of indices) {
    //     const data = await repo.serializeBuildFs(await repo.getBuildFs(h))
    //     const block = createBlock(Object.entries(data))
    //     blocks.set(h, block)
    // }

    // console.log([...blocks.values()].reduce((a, b) => a + b.byteLength, 0) / (1024 * 1024))
}