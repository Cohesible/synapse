import * as github from '../utils/github'
import { getCurrentVersion } from '../execution'
import { compareVersions } from '../pm/versions'
import { resolveBuildTarget } from '../build/builder'
import { getLogger } from '..'


// TODO:
// 1. Automatically check for updates (in the background, forked proc, with some max frequency e.g. once a day)
// 2. No auto-updates by default
//      * The CLI for `fly.io` has auto-updates and I've found it to be annoying as an occasional user
// 3. This can fetch GitHub releases directly. No need for our own service.

export async function checkForUpdates() {
    const latestRelease = await github.getRelease('Cohesible', 'synapse')
    const latest = latestRelease.tag_name.slice(1)
    const current = getCurrentVersion().semver
    if (compareVersions(latest, current) <= 0) {
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

// TODO: Re-running the install scripts in a disconnected process (maybe with a delay on windows) 
// is likely the most robust way to update. 

