
import * as path from 'node:path'
import * as builder from '../build/builder'
import { fetchData, fetchJson } from '../utils/http'
import { getPackageCacheDirectory, getUserSynapseDirectory, getWorkingDir } from '../workspaces'
import { runCommand } from '../utils/process'
import { ensureDir, isNonNullable, isWindows, memoize } from '../utils'
import { readPathKey, setPathKey } from '../cli/config'
import { extractToDir } from '../utils/tar'
import { registerToolProvider } from '../pm/tools'
import { getFs } from '../execution'
import { getLogger } from '../logging'

interface ZigDownload {
    readonly tarball: string    // url
    readonly shasum: string     // sha256, hex
    readonly size: number       // bytes
}

type Os = 'macos' | 'windows' | 'linux' | 'freebsd'
type Arch = 'x86_64' | 'i386' | 'aarch64' | 'riscv64' | 'armv7a'

type ZigReleaseBase = { [P in PlatformPair]?: ZigDownload }

interface ZigRelease extends ZigReleaseBase {

    // Other stuff that we don't use
    readonly date: string       // e.g. 2021-06-04
    readonly docs: string       // url
    readonly stdDocs: string    // url
    readonly notes: string      // url
    readonly src: ZigDownload
    readonly bootstrap: ZigDownload

}

type PlatformPair = `${Arch}-${Os}`

// signed with `minisign`
// key: RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U
// https://ziglang.org/download/0.11.0/zig-macos-aarch64-0.11.0.tar.xz.minisig
interface ZigVersionIndex {
    readonly master: ZigRelease // This is built from the head commit
    readonly [version: string]: ZigRelease
}

function getOs(platform: typeof process.platform | 'windows' = process.platform): Os {
    switch (platform) {
        case 'darwin':
            return 'macos'

        case 'win32':
        case 'windows':
            return 'windows'

        case 'linux':
        case 'freebsd':
            return platform
    
        default:
            throw new Error(`Not supported: ${platform}`)
    }
}

function getArch(arch: typeof process.arch | 'aarch64' = process.arch): Arch {
    switch (arch) {
        case 'arm64':
            return 'aarch64'
        case 'x64':
            return 'x86_64'
        case 'ia32':
            return 'i386'
        case 'riscv64':
            return 'riscv64'
        case 'arm':
            return 'armv7a' // not sure if this is right

        case 'aarch64':
            return arch

        default:
            throw new Error(`Not supported: ${arch}`)
    }
}

function toBuildArch(arch: Arch): builder.Arch | undefined {
    switch (arch) {
        case 'aarch64':
            return arch
        // case 'i386':
        //     return 'ia32'
        // case 'riscv64':
        //     return 'riscv64'
        case 'x86_64':
            return 'x64'
    }
}

function toBuildOs(os: Os): builder.Os | undefined {
    switch (os) {
        case 'macos':
            return 'darwin'
        case 'windows':
        case 'linux':
        case 'freebsd':
            return os
    }
}

async function getVersions() {
    return await fetchJson<ZigVersionIndex>('https://ziglang.org/download/index.json')
}

function listOsArchPairs(release: ZigRelease) {
    const pairs = Object.keys(release).map(x => {
        const m = x.match(/^([a-z0-9_]+)-([a-z0-9_]+)$/)
        if (!m) {
            return
        }

        const os = toBuildOs(m[2] as any) 
        if (!os) return

        const arch = toBuildArch(m[1] as any) 
        if (!arch) return

        return { os, arch }
    })

    return pairs.filter(isNonNullable)
}

export function registerZigProvider() {
    const getVersionsCached = memoize(getVersions)
    registerToolProvider({
        name: 'zig',
        listVersions: async () => {
            const versions = await getVersionsCached()

            return Object.entries(versions).slice(1).flatMap(([k, v]) => listOsArchPairs(v).map(p => ({ ...p, version: k }))) as any
        },
        getDownloadInfo: async release => {
            const versions = await getVersionsCached()
            const v = versions[release.version]?.[`${getArch(release.arch)}-${getOs(release.os)}`]
            if (!v) {
                throw new Error(`No such release found: ${release.os}-${release.arch}@${release.version}`)
            }

            return { url: v.tarball, integrity: v.shasum }
        },
    })
}

interface Target {
    os?: Os
    arch?: Arch
    version?: string
}

async function getReleaseDownload(target?: Target) {
    const versions = await getVersions()
    const os = target?.os ?? getOs()
    const arch = target?.arch ?? getArch()
    const version = target?.version ?? Object.keys(versions).slice(1)[0] // Assumes versions are sorted in descending order

    const release = versions[version]?.[`${arch}-${os}`]
    if (!release) {
        throw new Error(`No such release found: ${os}-${arch}@${version}`)
    }

    return {
        os,
        arch,
        version,
        release,
    }
}

const getDefaultInstallDir = (version: string, os = toBuildOs(getOs()), arch = toBuildArch(getArch())) => {
    return path.resolve(getPackageCacheDirectory(), 'synapse-tool', 'zig', `${os}-${arch}-${version}`)
}

export async function installZig(dst?: string) {
    const r = await getReleaseDownload()
    const dir = dst ?? getDefaultInstallDir(r.version)
    if (await getFs().fileExists(dir)) {
        return dir
    }

    await ensureDir(dir)
    
    const data = await fetchData(r.release.tarball)
    const ext = path.extname(r.release.tarball)

    await extractToDir(data, dir, ext as '.xz' | '.zip')

    return dir
}

async function getExecVersion(p: string) {
    const resp = await runCommand(p, ['version'])

    return resp.trim()
}

export async function getZigPath() {
    const fromNodeModules = path.resolve(getWorkingDir(), 'node_modules', '.bin', isWindows() ? `zig.exe` : 'zig')
    if (await getFs().fileExists(fromNodeModules)) {
        return fromNodeModules
    }

    const fromConfig = await readPathKey('zig.path')
    if (fromConfig) {
        return fromConfig
    }

    const installDir = await installZig()
    const zigPath = path.resolve(installDir, isWindows() ? `zig.exe` : 'zig')
    // sanity check
    const v = await getExecVersion(zigPath)
    const expected = path.basename(installDir).split('-').at(-1)
    if (v !== expected) {
        throw new Error(`Unexpected zig version install: found ${v}, expected: ${expected}`)
    }

    await setPathKey('zig.path', zigPath)

    return zigPath
}

function getSynapseZigLibDir() {
    return readPathKey('zig.synapseLibDir')
}

export async function getJsLibPath() {
    const libDir = await getSynapseZigLibDir()
    if (!libDir) {
        return
    }

    return path.resolve(libDir, 'js.zig')
}
