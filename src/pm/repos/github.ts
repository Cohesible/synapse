import * as path from 'node:path'
import * as github from '../../utils/github'
import { ensureDir, keyedMemoize } from '../../utils'
import { PackageJson, getRequired } from '../packageJson'
import { PackageRepository, ResolvePatternResult } from '../packages'
import { parseVersionConstraint } from '../versions'
import { PackageInfo } from '../../runtime/modules/serdes'
import { runCommand } from '../../utils/process'
import { getFs } from '../../execution'
import { randomUUID } from 'node:crypto'
import { extractToDir, hasBsdTar } from '../../utils/tar'

async function getPackageJsonFromRepo(owner: string, repo: string) {
    const data = await github.downloadRepoFile(owner, repo, 'package.json')

    return JSON.parse(data.toString('utf-8')) as PackageJson
}

export const githubPrefix = 'github:'

export function createGitHubPackageRepo(): PackageRepository {
    const _getPackageJson = keyedMemoize(getPackageJsonFromRepo)

    async function listVersions(name: string) {
        const parsed = github.parseDependencyRef(name)
        const pkg = await _getPackageJson(parsed.owner, parsed.repository) // TODO: commitish

        return [pkg.version ?? '0.0.1']
        // const releases = await github.listReleases(parsed.owner, parsed.repository)

        // return releases.map(r => r.tag_name.replace(/^v/, '')) // TODO: check semver compliance
    }

    async function resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> {
        const parsed = github.parseDependencyRef(pattern)
        const pkg = await _getPackageJson(parsed.owner, parsed.repository) // TODO: commitish

        return {
            name: pkg.name ?? spec,
            version: parseVersionConstraint(pkg.version ?? '*'),
        }
    }

    async function getDependencies(name: string, version: string) {
        const parsed = github.parseDependencyRef(name)
        const pkg = await _getPackageJson(parsed.owner, parsed.repository) // TODO: commitish

        return getRequired(pkg)
    }

    return { 
        listVersions, 
        resolvePattern, 
        getDependencies,
        getPackageJson: async (name, version) => {
            const parsed = github.parseDependencyRef(name)
            const pkg = await _getPackageJson(parsed.owner, parsed.repository) // TODO: commitish
            const release = await github.getRelease(parsed.owner, parsed.repository)
            const asset = release.assets.find(a => a.name === `${pkg.name ?? parsed.repository}.zip`)
            if (!asset) {
                throw new Error(`Package not found for ${name}@${version}`)
            }

            return {
                ...pkg,
                dist: {
                    integrity: '',
                    tarball: asset.browser_download_url,
                },
            }
        }
    }
}

// This does not refer to the "packages" API
export async function downloadGitHubPackage(info: PackageInfo, dest: string) {
    const url = info.resolved?.url
    if (!url) {
        throw new Error(`Missing download URL for package: ${info.name} [destination: ${dest}]`)
    }

    const data = await github.fetchData(url)
    if (url.includes('.zip')) {
        if (await hasBsdTar()) {
            return extractToDir(data, dest, '.zip', 0)
        }

        const tmp = path.resolve(path.dirname(dest), `tmp-${randomUUID()}.zip`)
        await Promise.all([
            getFs().writeFile(tmp, data),
            ensureDir(dest)
        ])

        try {
            await runCommand('unzip', [tmp], { cwd: dest })
        } catch(e) {
            await getFs().deleteFile(dest).catch() // Swallow the error, this is clean-up
            throw e
        } finally {
            await getFs().deleteFile(tmp)
        }

        return
    }

    throw new Error(`Not implemented: ${url}`)
}