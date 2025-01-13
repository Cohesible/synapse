import * as path from 'node:path'
import * as github from '../utils/github'
import * as child_process from 'node:child_process'
import { getCurrentVersion, getFs } from '../execution'
import { compareVersions } from '../pm/versions'
import { resolveBuildTarget } from '../build/builder'
import { getLogger } from '../logging'
import { colorize, printLine } from './ui'
import { homedir } from 'node:os'
import { throwIfNotFileNotFoundError } from '../utils'
import { rename } from '../system'


// TODO:
// 1. Automatically check for updates (in the background, forked proc, with some max frequency e.g. once a day)
// 2. No auto-updates by default
//      * The CLI for `fly.io` has auto-updates and I've found it to be annoying as an occasional user

export async function checkForUpdates(opt?: { force?: boolean; tag?: string }) {
    const latestRelease = await github.getRelease('Cohesible', 'synapse', opt?.tag)
    const latest = latestRelease.tag_name.slice(1)
    const current = getCurrentVersion().semver
    if (compareVersions(latest, current) <= 0 && !opt?.force) {
        return
    }

    const target = resolveBuildTarget()
    const assetName = `synapse-${target.os}-${target.arch}`
    const asset = latestRelease.assets.find(a => a.name.startsWith(assetName))
    if (!asset) {
        getLogger().log(`Found a new update but it is missing a compatible artifact: ${assetName}`)
        return
    }

    return {
        version: latest,
        downloadUrl: asset.browser_download_url,
    }
}

interface UpgradeOptions {
    readonly force?: boolean
    readonly tag?: string
    readonly hash?: string

    // internal/dev options
    readonly installDir?: string
    readonly stepKeyHash?: string 
}

export async function tryUpgrade(opt?: UpgradeOptions) {
    if (!opt?.hash && !opt?.stepKeyHash) {
        const updateInfo = await checkForUpdates(opt)
        if (!updateInfo) {
            return printLine(colorize('green', 'Already on the latest version'))
        }
    
        // Not using `printLine` here because something else will be writing to `stdout`
        process.stdout.write(`Found newer version ${updateInfo.version}. Upgrading...\n`)
    } else {
        process.stdout.write(`Installing from hash: ${opt.hash ?? opt.stepKeyHash}\n`)
    }

    const installDir = opt?.installDir ?? process.env.SYNAPSE_INSTALL ?? path.resolve(homedir(), '.synapse')
    const execPath = path.resolve(installDir, 'app', 'bin', 'synapse.exe')
    const oldExecPath = path.resolve(installDir, 'synapse-old.exe')

    if (process.platform === 'win32') {
        // We can't remove the executable directly if it's already running
        await getFs().deleteFile(oldExecPath).catch(throwIfNotFileNotFoundError)
        await rename(execPath, oldExecPath)
    }

    function getSearchPart() {
        if (!opt?.hash && !opt?.stepKeyHash) {
            return ''
        }

        const params: Record<string, string> = {}
        if (opt.hash) {
            params.hash = opt.hash
        }

        if (opt.stepKeyHash) {
            params.stepKeyHash = opt.stepKeyHash
        }

        return '?' + new URLSearchParams(params).toString()
    }

    const cmd = process.platform === 'win32'
        ? `irm https://synap.sh/install.ps1${getSearchPart()} | iex`
        : `curl -fsSL https://synap.sh/install${getSearchPart()} | bash`

    const env = { ...process.env, SYNAPSE_INSTALL_IS_UPGRADE: 'true' } as Record<string, string>
    if (opt?.installDir) {
        env.SYNAPSE_INSTALL = opt.installDir
    }

    await new Promise<void>((resolve, reject) => {
        const proc = child_process.spawn(cmd, { 
            shell: process.platform === 'win32' ? 'powershell.exe' : true, 
            stdio: 'inherit', 
            windowsHide: true,
            env,
        })

        proc.on('error', reject)
        proc.on('exit', (code, signal) => {
            if (code || signal) {
                const err = new Error(`Not zero exit-code or signal. code: ${code}; signal: ${signal}`)
                reject(err)
            } else {
                resolve()
            }
        })
    }).catch(async e => {
        if (process.platform === 'win32') {
            if (!(await getFs().fileExists(execPath))) {
                await rename(oldExecPath, execPath)
            }
        }

        throw e
    })
}
