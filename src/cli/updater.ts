import * as github from '../utils/github'
import * as child_process from 'node:child_process'
import { getCurrentVersion } from '../execution'
import { compareVersions } from '../pm/versions'
import { resolveBuildTarget } from '../build/builder'
import { getLogger } from '..'
import { colorize, printLine } from './ui'


// TODO:
// 1. Automatically check for updates (in the background, forked proc, with some max frequency e.g. once a day)
// 2. No auto-updates by default
//      * The CLI for `fly.io` has auto-updates and I've found it to be annoying as an occasional user

export async function checkForUpdates(opt?: { force?: boolean }) {
    const latestRelease = await github.getRelease('Cohesible', 'synapse')
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

export async function tryUpgrade(opt?: { force?: boolean }) {
    const updateInfo = await checkForUpdates(opt)
    if (!updateInfo) {
        return printLine(colorize('green', 'Already on the latest version'))
    }

    // Not using `printLine` here because something else will be writing to `stdout`
    process.stdout.write(`Found newer version ${updateInfo.version}. Upgrading...\n`)

    const cmd = process.platform === 'win32'
        ? 'irm https://synap.sh/install.ps1 | iex'
        : 'curl -fsSL https://synap.sh/install | bash'

    await new Promise<void>((resolve, reject) => {
        const proc = child_process.spawn(cmd, { 
            shell: true, 
            stdio: 'inherit', 
            detached: process.platform === 'win32', 
            windowsHide: true,
            env: { ...process.env, SYNAPSE_INSTALL_IS_UPGRADE: 'true', }
        })

        proc.on('error', reject)
        proc.on('exit', (code, signal) => {
            if (code || signal) {
                reject(new Error(`Not zero exit-code or signal. code: ${code}; signal: ${signal}`))
            } else {
                resolve()
            }
        })

        if (process.platform === 'win32') {
            proc.unref()
            proc.on('spawn', resolve)
        }
    })
}
