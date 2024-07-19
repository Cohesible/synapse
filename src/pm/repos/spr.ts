import * as path from 'node:path'
import * as registry from '@cohesible/resources/registry'
import { ensureDir, gunzip, keyedMemoize, memoize } from '../../utils'
import { PackageJson, getRequired } from '../packageJson'
import { PackageRepository, ResolvePatternResult } from '../packages'
import { parseVersionConstraint } from '../versions'
import { PackageInfo } from '../../runtime/modules/serdes'
import { getFs } from '../../execution'
import { extractTarball, extractToDir, hasBsdTar } from '../../utils/tar'
import { findRemotePackage, listRemotePackages } from '../../workspaces'

export const sprPrefix = 'spr:'

const shouldUseRemote = !!process.env['SYNAPSE_SHOULD_USE_REMOTE']
const getClient = memoize(() => registry.createClient(shouldUseRemote ? undefined : { authorization: () => 'none' }))

export function createSynapsePackageRepo(): PackageRepository {
    const getPrivatePackages = memoize(() => listRemotePackages())
    const getManifest = keyedMemoize((pkgId: string) => getClient().getPackageManifest(pkgId))

    const getPackageJson = keyedMemoize(async (pkgId: string, version: string) => {
        const manifest = await getManifest(pkgId)
        const pkgJson = manifest.versions[version]
        if (!pkgJson) {
            throw new Error(`Version "${version}" not found for package: ${pkgId}`)
        }

        return pkgJson
    })

    async function listVersions(pkgId: string) {
        const manfiest = await getManifest(pkgId)

        return Object.keys(manfiest.versions)
    }

    async function resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> {
        if (!pattern.startsWith('#')) {
            throw new Error(`Public packages not implemented: ${pattern}`)
        }

        const [name, version = '*'] = pattern.slice(1).split('@')

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

export async function downloadSynapsePackage(info: PackageInfo, dest: string) {
    const integrity = info.resolved?.integrity
    if (!integrity?.startsWith('sha256:')) {
        throw new Error(`Missing integrity for package: ${info.name} [destination: ${dest}]`)
    }

    const publishedHash = integrity.slice('sha256:'.length)
    const data = await getClient().downloadPackage(publishedHash, info.name)
    if (!data) {
        throw new Error(`Failed to fetch data for package: ${info.name} [destination: ${dest}]`)
    }

    const tarball = await gunzip(data)
    const files = extractTarball(tarball)
    await Promise.all(files.map(async f => {
        const absPath = path.resolve(dest, f.path)
        await getFs().writeFile(absPath, f.contents, { mode: f.mode })
    }))
}
