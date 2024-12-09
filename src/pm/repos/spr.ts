import * as path from 'node:path'
import * as registry from '@cohesible/resources/registry'
import { ensureDir, getHash, gunzip, keyedMemoize, memoize } from '../../utils'
import { PackageJson, getRequired } from '../packageJson'
import { PackageRepository, ResolvePatternResult } from '../packages'
import { parseVersionConstraint } from '../versions'
import { PackageInfo } from '../../runtime/modules/serdes'
import { getFs } from '../../execution'
import { extractTarball, extractToDir, hasBsdTar } from '../../utils/tar'
import { findRemotePackage, listRemotePackages, isRemoteDisabled } from '../../workspaces'

export const sprPrefix = 'spr:'

const getClient = memoize(() => 
    registry.createClient(isRemoteDisabled() ? { authorization: () => 'none' } : undefined)
)

const downloadPackage = keyedMemoize(async (pkgId: string, hash: string) => {
    const data = await getClient().downloadPackage(hash, pkgId)
    if (!data) {
        throw new Error(`Failed to fetch data for package: ${pkgId}`)
    }

    if (getHash(data) !== hash) {
        throw new Error(`Integrity check failed: ${pkgId}`)
    }

    return await gunzip(data)
})

export const getPipelineDeps = memoize(() => {
    const data = process.env.SYNAPSE_PIPELINE_DEPS
    if (!data) {
        return
    }

    return JSON.parse(data) as Record<string, string | { stepKeyHash: string; gitRef?: string; repoUrl?: string }>
})

async function maybeParseRefsFromPipeline() {
    const parsed = getPipelineDeps()
    if (!parsed) {
        return
    }

    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string') continue // TODO

        const found = await findRemotePackage(k)
        if (found) {
            result[k] = `${found}@${v}`
        }
    }

    return result
}

async function _getDirectRefs() {
    const pkgs = process.env.SYNAPSE_PACKAGES
    if (!pkgs) {
        return maybeParseRefsFromPipeline()
    }

    return JSON.parse(pkgs) as Record<string, string>
}

const getDirectRefs = memoize(_getDirectRefs)

export function createSynapsePackageRepo(): PackageRepository {
    const getPrivatePackages = memoize(() => listRemotePackages())
    const getManifest = keyedMemoize((pkgId: string) => getClient().getPackageManifest(pkgId))
    const reffed = new Map<string, string>()

    const getPackageJson = keyedMemoize(async (pkgId: string, version: string) => {
        if (reffed.has(pkgId)) {            
            return getPackageJsonFromRef(pkgId, reffed.get(pkgId)!)
        }

        const manifest = await getManifest(pkgId)
        const pkgJson = manifest.versions[version]
        if (!pkgJson) {
            throw new Error(`Version "${version}" not found for package: ${pkgId}`)
        }

        return pkgJson
    })

    const getPackageJsonFromRef = keyedMemoize(async (pkgId: string, ref: string) => {
        const hash = await getClient().getRef(pkgId, ref)
        if (!hash) {
            throw new Error(`Package ${pkgId}@${ref} not found`)
        }

        const tarball = await downloadPackage(pkgId, hash)
        const files = extractTarball(tarball)
        const match = files.find(f => f.path.endsWith('package.json'))
        if (!match) {
            throw new Error(`Package ${pkgId}@${ref} did not contain package.json`)
        }

        const parsed = JSON.parse(match.contents.toString('utf-8'))
        parsed.dist = {
            integrity: `sha256:${hash}`,
            url: '',
        }

        return parsed
    })

    async function listVersions(pkgId: string) {
        if (reffed.has(pkgId)) {
            const pkgJson = await getPackageJsonFromRef(pkgId, reffed.get(pkgId)!)
            
            return [pkgJson.version ?? '0.0.0']
        }

        const manfiest = await getManifest(pkgId)

        return Object.keys(manfiest.versions)
    }

    async function resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> {
        if (!pattern.startsWith('#')) {
            throw new Error(`Public packages not implemented: ${pattern}`)
        }

        const [name, version = '*'] = pattern.slice(1).split('@')
        const maybeOverride = (await getDirectRefs())?.[name]
        if (maybeOverride) {
            const [pkgId, ref] = maybeOverride.split('@')
            reffed.set(pkgId, ref)

            return {
                name: pkgId,
                version: parseVersionConstraint(version), 
            }
        }

        const pkgs = await getPrivatePackages()
        const pkgId = pkgs?.[name]
        if (!pkgId) {
            const found = await findRemotePackage(name)
            if (found) {
                return {
                    name: found,
                    version: parseVersionConstraint(version),
                } 
            }

            throw new Error(`Package "${spec}" not found: ${pattern}`)
        }

        return {
            name: pkgId,
            version: parseVersionConstraint(version),
        }
    }

    async function getDependencies(pkgId: string, version: string) {
        const pkg = await getPackageJson(pkgId, version)

        return getRequired(pkg)
    }

    return { 
        listVersions, 
        resolvePattern, 
        getDependencies,
        getPackageJson,
    }
}

export async function downloadSynapsePackageTarball(info: PackageInfo, dest?: string) {
    const integrity = info.resolved?.integrity
    if (!integrity?.startsWith('sha256:')) {
        throw new Error(`Missing integrity for package: ${info.name}${dest ? `[destination: ${dest}]` : ''}`)
    }

    const publishedHash = integrity.slice('sha256:'.length)

    return downloadPackage(info.name, publishedHash)
}

export async function downloadSynapsePackage(info: PackageInfo, dest: string) {
    const tarball = await downloadSynapsePackageTarball(info, dest)
    const files = extractTarball(tarball)
    await Promise.all(files.map(async f => {
        const absPath = path.resolve(dest, f.path)
        await getFs().writeFile(absPath, f.contents, { mode: f.mode })
    }))
}
