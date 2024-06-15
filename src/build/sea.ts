import * as path from 'node:path'
import { getFs } from '../execution'
import { runCommand } from '../utils/process'
import { getHash, makeExecutable, throwIfNotFileNotFoundError } from '../utils'
import { createRequire } from 'node:module'
import { getLogger } from '..'
import { seaAssetPrefix } from '../bundler'
import { isDataPointer } from '../build-fs/pointers'
import { getDataRepository } from '../artifacts'

interface PostjectOptions {
    readonly overwrite?: boolean
    readonly sentinelFuse?: string
    readonly machoSegmentName?: string
}

interface Postject {
    inject: (filename: string, resourceName: string, resourceData: Buffer, options?: PostjectOptions) => Promise<void>
    remove?: (filename: string, resourceName: string, options?: PostjectOptions) => Promise<boolean>
}

function getPostject(): Postject {
      // This is so we can still load `postject` as an SEA
    const loadFromCwd = () => createRequire(path.resolve(process.cwd(), 'package.json'))('postject')

    try {
        return require('postject')
    } catch {
        return loadFromCwd()
    }
}

// This is split so it doesn't get treated as the sentinel
const sentinelFuseParts = ['NODE_SEA_FUSE', 'fce680ab2cc467b6e072b8b5df1996b2']

async function injectSeaBlob(executable: string, blob: Buffer) {
    await getPostject().inject(executable, 'NODE_SEA_BLOB', blob, {
        overwrite: true,
        machoSegmentName: 'NODE_SEA', // Darwin only
        sentinelFuse: sentinelFuseParts.join('_'),
    })
}

async function removeSeaBlob(executable: string) {
    const postject = getPostject()
    if (!postject.remove) {
        getLogger().log('Missing `remove` method from `postject`')
        return
    }

    const didRemove = await postject.remove(executable, 'NODE_SEA_BLOB', {
        machoSegmentName: 'NODE_SEA', // Darwin only
        sentinelFuse: sentinelFuseParts.join('_'),
    })

    if (!didRemove) {
        getLogger().log('No existing SEA blob found')
        return
    }

    if (process.platform === 'darwin') {
        await runCommand('codesign', ['--sign', '-', executable])
    }
}

interface SeaConfig {
    readonly main: string
    readonly output: string
    readonly disableExperimentalSEAWarning?: boolean
    readonly useSnapshot?: boolean
    readonly useCodeCache?: boolean
    readonly assets?: Record<string, string>
}

export async function resolveAssets(assets?: Record<string, string>): Promise<Record<string, string> | undefined> {
    if (!assets) {
        return
    }

    const resolved: Record<string, string> = {}
    for (const [k, v] of Object.entries(assets)) {
        if (!k.startsWith(seaAssetPrefix)) {
            throw new Error(`Invalid asset name: ${k}. Expected prefix "${seaAssetPrefix}".`)
        }

        const name = k.slice(seaAssetPrefix.length)
        if (isDataPointer(v)) {
            resolved[name] = await getDataRepository().resolveArtifact(v.hash)
        } else {
            resolved[name] = path.resolve(v)
        }
    }

    return resolved
}

export async function makeSea(main: string, nodePath: string, dest: string, assets?: Record<string, string>, sign = true) {
    const output = path.resolve(path.dirname(dest), 'sea-prep.blob')
    const config: SeaConfig = {
        main,
        output,
        assets: await resolveAssets(assets),
        useSnapshot: true,
        disableExperimentalSEAWarning: true,
    }

    getLogger().log(`SEA assets`, config.assets)

    const configPath = path.resolve(path.dirname(dest), 'sea-config.json')
    await getFs().writeFile(configPath, JSON.stringify(config))

    try {
        await getFs().writeFile(dest, await getFs().readFile(nodePath))
        await makeExecutable(dest)
        await removeSeaBlob(dest)

        getLogger().log('Creating SEA blob using executable', nodePath)
        await runCommand(dest, ['--experimental-sea-config', configPath], { 
            cwd: path.dirname(main),
            env: { ...process.env, BUILDING_SEA: '1' },
            shell: false,
            // stdio: 'inherit',
        })

        getLogger().log('Injecting SEA blob')
        const blob = await getFs().readFile(output)
        await injectSeaBlob(dest, Buffer.from(blob))
        if (process.platform === 'darwin' && sign) {
            await runCommand('codesign', ['--sign', '-', dest])
        }
    } finally {
        await Promise.all([
            getFs().deleteFile(configPath).catch(throwIfNotFileNotFoundError), 
            getFs().deleteFile(output).catch(throwIfNotFileNotFoundError)
        ])
    }
}


