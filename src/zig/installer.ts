
import * as path from 'node:path'
import * as builder from '../build/builder'
import { fetchData, fetchJson } from '../utils/http'
import { getPackageCacheDirectory, getUserSynapseDirectory, getWorkingDir } from '../workspaces'
import { runCommand } from '../utils/process'
import { ensureDir, getNodeLocation, isNonNullable, isWindows, memoize, printNodes } from '../utils'
import { readPathKey, setPathKey } from '../cli/config'
import { extractToDir } from '../utils/tar'
import { registerToolProvider } from '../pm/tools'
import { getFs } from '../execution'
import { downloadSource } from '../build/sources'
import { homedir } from 'node:os'
import { printLine } from '../cli/ui'

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

const zigPathKey = 'zig.path'
const zlsPathKey = 'zig.zls.path'

export async function getZigPath() {
    const fromNodeModules = path.resolve(getWorkingDir(), 'node_modules', '.bin', isWindows() ? `zig.exe` : 'zig')
    if (await getFs().fileExists(fromNodeModules)) {
        return fromNodeModules
    }

    const fromConfig = await readPathKey(zigPathKey)
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

    await setPathKey(zigPathKey, zigPath)

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

const zlsRepoUrl = 'https://github.com/Cohesible/zls'
const zlsRef = 'v0.13.0'
export async function installZls() {
    const source = await downloadSource({
        type: 'git',
        url: zlsRepoUrl,
        commitish: zlsRef,
    })

    const zigPath = await getZigPath()
    await runCommand(zigPath, ['build', '-Doptimize=ReleaseSafe'], { cwd: source })

    const zlsExecPath = path.resolve(source, 'zig-out', 'bin', process.platform === 'win32' ? 'zls.exe' : 'zls')

    return zlsExecPath
}

async function getOrInstallZls() {
    const fromConfig = await readPathKey(zlsPathKey)
    if (fromConfig) {
        return fromConfig
    }

    printLine('Building ZLS from source...')
    const zlsPath = await installZls()

    // Better to just re-build every time because it's not a frequent operation
    // await setPathKey(zlsPathKey, zlsPath)

    return zlsPath
}

async function getVsCodeSettings() {
    const [zigPath, zlsPath, jsLibPath] = await Promise.all([
        getZigPath(),
        getOrInstallZls(),
        getJsLibPath(),
    ])

    return {
        [zigPathKey]: zigPath,
        [zlsPathKey]: zlsPath,
        'zig.zls.jsLibPath': jsLibPath, // TODO: make this consistent
    }
}

async function findVsCodeSettingsFile() {
    function getPathSuffix() {
        switch (process.platform) {
            case 'darwin':
                return 'Library/Application Support/Code/User/settings.json'
            case 'win32':
                return '\\Code\\User\\settings.json'
            default:
                return '.config/Code/User/settings.json'
        }
    }

    function getPathPrefix() {
        if (process.platform === 'win32') {
            return process.env.APPDATA ?? homedir()
        }

        return homedir()
    }

    const p = path.resolve(getPathPrefix(), getPathSuffix())
    if (await getFs().fileExists(p)) {
        return p
    }
}

// used for JSONC reading/writing
import ts from 'typescript'

export async function installVsCodeZigExtension() {
    const extId = 'ziglang.vscode-zig'
    await runCommand('code', ['--install-extension', extId])

    const settings = await getVsCodeSettings()

    const settingsPath = await findVsCodeSettingsFile()
    if (!settingsPath) {
        printLine(`Failed to find VS Code's "settings.json" file.`)
        printLine(`The following settings need to be added manually:`)

        for (const [k, v] of Object.entries(settings)) {
            if (v !== undefined) {
                printLine(`  "${k}": "${v.replaceAll('\\', '\\\\')}"`)
            }
        }

        return
    }

    await updateVsCodeSettings(settingsPath, settings)
    printLine('Updated VS Code settings')
}

// Doesn't preserve trailing commas in array/object literals
async function updateVsCodeSettings(settingsPath: string, settings: Record<string, string | undefined>) {
    const text = await getFs().readFile(settingsPath, 'utf-8')
    const parsed = ts.parseJsonText(settingsPath, text)

    const jsonObj = parsed.statements[0]?.expression

    if (!jsonObj || !ts.isObjectLiteralExpression(jsonObj)) {
        throw new Error('Settings does not contain a JSON object')
    }

    const props = jsonObj.properties.map(p => {
        if (!ts.isPropertyAssignment(p)) {
            throw new Error(`Not a property assignment: ${getNodeLocation(p)}`)
        }

        if (!ts.isStringLiteral(p.name)) {
            throw new Error(`Not a string literal: ${getNodeLocation(p.name)}`)
        }

        const key = p.name.text
        if (key in settings && settings[key]) {
            const val = settings[key]
            delete settings[key]
            return ts.factory.updatePropertyAssignment(p, p.name, ts.factory.createStringLiteral(val))
        }

        return p
    })

    for (const [k, v] of Object.entries(settings)) {
        if (v !== undefined) {
            props.push(ts.factory.createPropertyAssignment(
                ts.factory.createStringLiteral(k), 
                ts.factory.createStringLiteral(v))
            )
        }
    }

    const updated = ts.factory.updateExpressionStatement(
        parsed.statements[0],
        ts.factory.updateObjectLiteralExpression(jsonObj, props)
    )

    // Statement is emitted as a parenthesized expression
    const result = printNodes([updated], parsed, { removeComments: false }).slice(1, -1)
    await getFs().writeFile(settingsPath, result)
}
