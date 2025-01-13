import * as path from 'node:path'
import { getFs, getSelfPath } from '../execution'
import { runCommand } from '../utils/process'
import { makeExecutable, throwIfNotFileNotFoundError } from '../utils'
import { createRequire } from 'node:module'
import { getLogger } from '../logging'
import { seaAssetPrefix } from '../bundler'
import { isDataPointer } from '../build-fs/pointers'
import { getDataRepository } from '../artifacts'
import { getWorkingDir } from '../workspaces'

interface PostjectOptions {
    readonly overwrite?: boolean
    readonly sentinelFuse?: string
    readonly machoSegmentName?: string
}

interface Postject {
    inject: (filename: string, resourceName: string, resourceData: Buffer, options?: PostjectOptions) => Promise<void>
    remove?: (filename: string, resourceName: string, options?: PostjectOptions) => Promise<boolean>
}

function loadFromRelPath() {
    const selfPath = getSelfPath()
    if (!selfPath) {
        throw new Error('Missing self path')
    }

    return createRequire(selfPath)('./postject')
}

function getPostject(): Postject {
    // This is so we can still load `postject` as an SEA
    const origin = path.resolve(getWorkingDir(), 'package.json')
    const loadFromCwd = () => createRequire(origin)('postject')

    try {
        return loadFromRelPath()
    } catch {
        try {
            return require('postject')
        } catch {
            return loadFromCwd()
        }
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

async function removeSeaBlob(executable: string, targetPlatform?: string) {
    const postject = getPostject()
    if (!postject.remove) {
        getLogger().log('Missing `remove` method from `postject`')
        return
    }

    const didRemove = await postject.remove(executable, 'NODE_SEA_BLOB', {
        machoSegmentName: 'NODE_SEA',
        sentinelFuse: sentinelFuseParts.join('_'),
    })

    if (!didRemove) {
        getLogger().log('No existing SEA blob found')
        return
    }

    if (targetPlatform === 'darwin') {
        // Removing the payload removes the signature. We're going to execute the binary
        // to generate the payload so we need to re-sign it.
        await runCommand('codesign', ['--sign', '-', executable]).catch(e => {
            if (!(e as any).stderr.includes('is already signed')) {
                throw e
            }
        })
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

interface SeaOptions {
    assets?: Record<string, string>
    sign?: boolean
    hostPath?: string
    targetPlatform?: string
}

export async function makeSea(main: string, nodePath: string, dest: string, opt?: SeaOptions) {
    const output = path.resolve(path.dirname(dest), 'sea-prep.blob')
    const config: SeaConfig = {
        main,
        output,
        assets: await resolveAssets(opt?.assets),
        useSnapshot: true,
        disableExperimentalSEAWarning: true,
    }

    const sign = opt?.sign ?? true
    const targetPlatform = opt?.targetPlatform ?? process.platform

    getLogger().log(`SEA assets`, config.assets)

    const configPath = path.resolve(path.dirname(dest), 'sea-config.json')
    await getFs().writeFile(configPath, JSON.stringify(config))
    const tmpHost = opt?.hostPath ? path.resolve(path.dirname(dest), 'tmp') : undefined

    try {
        await getFs().writeFile(dest, await getFs().readFile(nodePath))
        await makeExecutable(dest)
        await removeSeaBlob(dest, targetPlatform)

        if (opt?.hostPath) {
            await getFs().writeFile(tmpHost!, await getFs().readFile(opt.hostPath))
            await makeExecutable(tmpHost!)
            await removeSeaBlob(tmpHost!, process.platform)
        }

        getLogger().log('Creating SEA blob using executable', nodePath)
        await runCommand(tmpHost ?? dest, ['--experimental-sea-config', configPath], { 
            cwd: path.dirname(main),
            env: { ...process.env, BUILDING_SEA: '1' },
            shell: false,
            // stdio: 'inherit',
        })

        getLogger().log('Injecting SEA blob')
        const blob = await getFs().readFile(output)
        await injectSeaBlob(dest, Buffer.from(blob))
        if (targetPlatform === 'darwin' && sign) {
            await runCommand('codesign', ['--sign', '-', dest])
        }
    } finally {
        await Promise.all([
            getFs().deleteFile(configPath).catch(throwIfNotFileNotFoundError), 
            getFs().deleteFile(output).catch(throwIfNotFileNotFoundError),
            tmpHost ? getFs().deleteFile(tmpHost!).catch(throwIfNotFileNotFoundError) : undefined,
        ])
    }
}


