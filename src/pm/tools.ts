import { Arch, Os, toNodeArch, toNodePlatform } from '../build/builder'
import { keyedMemoize } from '../utils'
import { PackageRepository } from './packages'
import { parseVersionConstraint } from './versions'

interface ToolVersion {
    readonly os: Os
    readonly arch: Arch
    readonly version: string
}

interface ToolDownloadInfo {
    readonly url: string
    readonly integrity?: string
    readonly bin?: Record<string, string> // Maps tool names to relative paths
}

export interface ToolProvider {
    readonly name: string
    listVersions(): Promise<ToolVersion[]>
    getDownloadInfo(release: ToolVersion): Promise<ToolDownloadInfo>
}

export const toolPrefix = `synapse-tool:`

const providers = new Map<string, ToolProvider>()

export function registerToolProvider(provider: ToolProvider) {
    if (provider.name.includes('/')) {
        throw new Error(`Invalid character '/' in tool name`)
    }

    providers.set(provider.name, provider)
}

function getProviderOrThrow(name: string) {
    const p = providers.get(name)
    if (!p) {
        throw new Error(`No tool provider found: ${name}`)
    }
    return p
}

export function createToolRepo(): PackageRepository {
    const getToolVersions = keyedMemoize((name: string) => getProviderOrThrow(name).listVersions())

    async function listVersions(name: string) {
        const m = name.match(/^(.+)\/(.+)-(.+)$/)
        const versions = await getToolVersions(m?.[1] ?? name)

        if (!m) {
            return Array.from(new Set(versions.map(r => r.version)))
        }

        const os = m[2] as Os
        const arch = m[3] as Arch

        return versions.filter(r => r.os === os && r.arch === arch).map(r => r.version)
    }

    function resolvePattern(spec: string, pattern: string) {
        return { name: spec, version: parseVersionConstraint(pattern) }
    }

    function getName(toolName: string, os: Os, arch: Arch) {
        return `${toolName}/${os}-${arch}`
    }

    async function generateDeps(toolName: string, version: string) {
        const versions = await getToolVersions(toolName)
        const filtered = versions.filter(r => r.version === version)

        return Object.fromEntries(filtered.map(r => [`${toolPrefix}${getName(toolName, r.os, r.arch)}`, r.version]))
    }

    async function getDependencies(name: string, version: string) {
        const m = name.match(/^(.+)\/(.+)-(.+)$/) // this is ok because we enforce that '/' isn't allowed in tool names
        if (m) {
            return
        }

        return generateDeps(name, version)
    }

    async function getPackageJson(name: string, version: string) {
        const m = name.match(/^(.+)\/(.+)-(.+)$/) 
        if (!m) {
            return {
                name,
                version,
                dist: {
                    tarball: '',
                    integrity: '',
                    isStubPackage: true,
                },
            }
        }

        const realName = m[1]
        const os = m[2] as Os
        const arch = m[3] as Arch

        const info = await getProviderOrThrow(m[1]).getDownloadInfo({ os, arch, version })
        const bin = info.bin ?? ({ [m[1]]: os !== 'windows' ? `./${realName}` : `./${realName}.exe` })

        return {
            name: realName,
            version,
            bin,
            os: [toNodePlatform(os)],
            cpu: [toNodeArch(arch)],
            dist: {
                tarball: info.url,
                integrity: info.integrity ?? '',
            }
        }
    }

    return { 
        listVersions, 
        resolvePattern, 
        getDependencies,
        getPackageJson,
    }
} 