import * as path from 'node:path'
import * as zlib from 'node:zlib'
import * as github from '../utils/github'
import { getGlobalCacheDirectory, getUserSynapseDirectory, resolveProgramBuildTarget } from '../workspaces'
import { getBuildTargetOrThrow, getFs } from '../execution'
import { createTarball, extractFileFromZip, extractTarball, hasBsdTar } from '../utils/tar'
import { PackageJson, getPackageJson } from '../pm/packageJson'
import { downloadSource } from '../build/sources'
import { buildGoProgram } from '../build/go'
import { installModules } from '../pm/packages'
import { createMergedView } from '../pm/publish'
import { Snapshot, consolidateBuild, createSnapshot, dumpData, getDataRepository, getModuleMappings, getProgramFs, linkFs, pruneBuild, writeSnapshotFile } from '../artifacts'
import { QualifiedBuildTarget, resolveBuildTarget } from '../build/builder'
import { runCommand } from '../utils/process'
import { toAbsolute, toDataPointer } from '../build-fs/pointers'
import { glob } from '../utils/glob'
import { gzip, memoize, throwIfNotFileNotFoundError } from '../utils'
import { getLogger } from '..'
import { randomUUID } from 'node:crypto'
import { createZipFromDir } from '../deploy/deployment'


const integrations = {
    'synapse-aws': 'integrations/aws',
    'synapse-local': 'integrations/local',

    // Frontend stuff
    'synapse-react': 'integrations/frontend-runtimes/react',
    'synapse-websites': 'integrations/websites',
}

export async function copyIntegrations(rootDir: string, dest: string, included?: string[]) {
    const packagesDir = path.resolve(dest, 'packages')
    const include = included ? new Set(included) : undefined
    for (const [k, v] of Object.entries(integrations)) {
        if (include && !include.has(k)) continue
        const integrationPkgPath = path.resolve(rootDir, v)
        await createPackageForRelease(integrationPkgPath, path.resolve(packagesDir, k), undefined, true)
    }
}

const baseUrl = 'https://nodejs.org/download/release'

// Needed when using `musl`
const unofficialUrl = 'https://unofficial-builds.nodejs.org/download/release'

function getDownloadUrl(version: string, target: QualifiedBuildTarget) {
    const archSuffix = target.arch === 'aarch64' ? 'arm64' : target.arch
    const os = target.os === 'windows' ? 'win' : target.os
    const extname = target.os === 'windows' ? '.zip' : '.tar.gz'
    const libc = target.libc
    const name = ['node', version, os, `${archSuffix}${libc ? `-${libc}` : ''}${extname}`].join('-')
    const url = !libc ? baseUrl : unofficialUrl

    return `${url}/${version}/${name}`
}

function decompress(data: Buffer, format: 'bz' | 'gz') {
    if (format === 'gz') {
        return new Promise<Buffer>((resolve, reject) => {
            zlib.gunzip(data, (err, res) => err ? reject(err) : resolve(res))
        })
    }

    return new Promise<Buffer>((resolve, reject) => {
        zlib.brotliDecompress(data, (err, res) => err ? reject(err) : resolve(res))
    })
}

const getNodeBinCacheDir = () => path.resolve(getGlobalCacheDirectory(), 'node')

const doReq = (url: string) => new Promise<any>((resolve, reject) => {
    const https = require('node:https') as typeof import('node:https')
    const req = https.request(url, { method: 'GET' }, resp => {
        const buffer: any[] = []
        resp.on('data', d => buffer.push(d))
        resp.on('end', () => {
            if (!resp.statusCode) {
                return reject(new Error('Response contained no status code'))
            }

            if (resp.statusCode >= 400) {
                return reject(Object.assign(new Error(buffer.join('')), { statusCode: resp.statusCode }))
            }

            if (resp.headers['content-type'] === 'application/json') {
                resolve(JSON.parse(buffer.join('')))
            } else {
                resolve(Buffer.concat(buffer))
            }
        })
        resp.on('error', reject)
    })

    req.end()
})

async function listFilesInZip(zip: Buffer) {
    if (!(await hasBsdTar())) {
        const tmp = path.resolve(process.cwd(), 'dist', `tmp-${randomUUID()}.zip`)
        await getFs().writeFile(tmp, zip)
        const res = await runCommand('unzip', ['-l', tmp]).finally(async () => {
            await getFs().deleteFile(tmp)
        })

        // first three lines and last two lines we don't care
        const lines = res.trim().split('\n').slice(3, -2)
        return lines.map(l => {
            const [length, date, time, name] = l.trim().split(/\s+/)

            return name
        })
    }

    if (process.platform === 'win32') {
        const tmp = path.resolve(process.cwd(), 'dist', `tmp-${randomUUID()}.zip`)
        await getFs().writeFile(tmp, zip)
        const res = await runCommand('tar', ['-tzf', tmp]).finally(async () => {
            await getFs().deleteFile(tmp)
        })
    
        return res.split(/\r?\n/).map(x => x.trim()).filter(x => !!x)
    }

    // Only works with `bsdtar`
    const res = await runCommand('tar', ['-tzf-'], {
        input: zip,
    })

    return res.split(/\r?\n/).map(x => x.trim()).filter(x => !!x)
}

async function getOrDownloadNode(version: string, target: QualifiedBuildTarget) {
    const p = path.resolve(getNodeBinCacheDir(), `${version}-${target.os}-${target.arch}${target.libc ? `-${target.libc}` : ''}`)
    if (await getFs().fileExists(p)) {
        return p
    }

    const url = getDownloadUrl(version, target)
    const d = await doReq(url)
    if (target.os === 'windows') {
        const prefix = path.basename(url).replace(/.zip$/, '')
        const executable = await extractFileFromZip(d, `${prefix}/node.exe`)
        await getFs().writeFile(p, executable)

        return p
    }

    const tarball = extractTarball(await decompress(d, 'gz'))
    const executable = tarball.find(x => x.path.endsWith('bin/node'))
    if (!executable) {
        throw new Error(`Failed to find executable in tarball: ${tarball.map(x => x.path)}`)
    }

    // TODO: check signature + integrity
    await getFs().writeFile(p, executable.contents)

    return p
}

async function getPackageJsonOrThrow(pkgDir: string) {
    const pkg = await getPackageJson(getFs(), pkgDir, false)
    if (!pkg) {
        throw new Error(`Missing package.json: ${pkgDir}`)
    }
    return pkg
}

// TODO: turn this into a resource that resolves into a relative path
async function getNodeJsForPkg(pkgDir: string, target?: Partial<QualifiedBuildTarget>) {
    const resolved = resolveBuildTarget(target)
    const pkg = await getPackageJsonOrThrow(pkgDir)

    const nodeEngine = pkg.data.engines?.node
    if (!nodeEngine) {
        throw new Error(`No node version found: ${pkgDir}`)
    }

    const nodePath = await getOrDownloadNode(`v${nodeEngine}`, resolved)
    await getFs().writeFile(
        path.resolve(pkgDir, 'bin', target?.os === 'windows' ? 'node.exe' : 'node'),
        await getFs().readFile(nodePath)
    )
}

export async function downloadNodeLib(owner = 'Cohesible', repo = 'node') {
    const dest = path.resolve('dist', 'node.lib')
    if (await getFs().fileExists(dest)) {
        return dest
    }

    const assetName = 'node-lib-windows-x64'

    async function downloadAndExtract(url: string) {
        const archive = await github.fetchData(url)
        const files = await listFilesInZip(archive)
        if (files.length === 0) {
            throw new Error(`Archive contains no files: ${url}`)
        }
    
        const file = await extractFileFromZip(archive, files[0])
        await getFs().writeFile(path.resolve('dist', 'node.lib'), file)
        getLogger().log('Downloaded node.lib to dist/node.lib')

        return dest
    }

    if (repo === 'node') {
        const release = await github.getRelease(owner, repo)
        const asset = release.assets.find(a => a.name === `${assetName}.zip`)
        if (!asset) {
            throw new Error(`Failed to find "${assetName}" in release "${release.name} [tag: ${release.tag_name}]"`)
        }

        return downloadAndExtract(asset.browser_download_url)
    }

    const artifacts = (await github.listArtifacts(owner, repo)).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    const match = artifacts.find(a => a.name === assetName)
    if (!match) {
        return
    }

    return downloadAndExtract(match.archive_download_url)
}

async function maybeUseGithubArtifact(ref: string, target: QualifiedBuildTarget, name: string) {
    const parsed = github.parseDependencyRef(ref)
    if (parsed.type !== 'github') {
        throw new Error(`Not implemented: ${parsed.type}`)
    }

    async function downloadAndExtract(url: string) {
        const archive = await github.fetchData(url)

        const files = await listFilesInZip(archive)
        if (files.length === 0) {
            throw new Error(`Archive contains no files: ${url}`)
        }
    
        const file = await extractFileFromZip(archive, files[0])
    
        return file
    }

    // TODO: consolidate os/arch normalization
    const arch = target.arch === 'aarch64' ? 'arm64' : target.arch === 'x64' ? 'amd64' : target.arch
    const getName = (arch: string, zip?: boolean) => `${name}-${target.os}-${arch}${zip ? '.zip' : ''}`

    try {
        const latest = await github.getRelease(parsed.owner, parsed.repository)
        const match = latest.assets.find(a => a.name.endsWith(getName(arch, true)))
            ?? latest.assets.find(a => a.name.endsWith(getName(target.arch, true)))

        if (!match) {
            throw new Error(`Asset not found: ${getName(target.arch, true)}`)
        }

        return downloadAndExtract(match.browser_download_url)
    } catch(e) {
        getLogger().log('Failed to get aritfact from release', e)
    }

    const artifacts = (await github.listArtifacts(parsed.owner, parsed.repository)).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    const match = artifacts.find(a => a.name.endsWith(getName(arch))) ?? artifacts.find(a => a.name.endsWith(getName(target.arch)))
    if (!match) {
        return
    }

    return downloadAndExtract(match.archive_download_url)
}

interface NodeBuildOptions {
    lto?: boolean
}

async function findLibtoolFromClang(clangPath: string) {
    const rp = (await runCommand(`realpath`, [clangPath])).trim()
    const res = path.resolve(rp, '..', 'llvm-libtool-darwin')
    if (!(await getFs().fileExists(res))) {
        return
    }

    return res
}

const homebrewClangPath = '/opt/homebrew/bin/clang'

// Needs python + ninja installed
async function buildCustomNodeBin(source: string, target?: Partial<QualifiedBuildTarget> & NodeBuildOptions) {
    const configArgs = ['--without-npm', '--without-corepack', '--ninja']
    if (target?.lto) {
        configArgs.push('--enable-lto')
    }

    const env = { ...process.env }
    if (!env.CC && await getFs().fileExists(homebrewClangPath)) {
        env.CC = homebrewClangPath
        env.LIBTOOL ??= await findLibtoolFromClang(env.CC)
    }

    if (!env.CXX && await getFs().fileExists(`${homebrewClangPath}++`)) {
        env.CXX = `${homebrewClangPath}++`
    }

    // TODO: delete `config.status` if CC/CXX/LIBTOOL changes

    function isSameAsConfig(args: string[]) {
        if (args.length !== configArgs.length) {
            return false
        }

        args.sort()
        configArgs.sort()
        for (let i = 0; i < args.length; i++) {
            if (args[i] !== configArgs[i]) {
                return false
            }
        }

        return true
    }

    if (!(await getFs().fileExists(path.resolve(source, 'config.status')))) {
        getLogger().log('Configuring NodeJS build')
        await runCommand(path.resolve(source, 'configure'), configArgs, { cwd: source, env })
    } else {
        const statusFile = await getFs().readFile(path.resolve(source, 'config.status'), 'utf-8')
        const args = statusFile.match(/exec \.\/configure (.*)/)?.[1]?.split(' ')
        if (!args || !isSameAsConfig(args)) {
            await runCommand(path.resolve(source, 'configure'), configArgs, { 
                cwd: source,
                env,
            })
        }
    }

    getLogger().log('Building custom NodeJS binary')
    await runCommand('make', ['-j16'], { cwd: source, env })
    const outPath = path.resolve(source, 'out', 'Release', 'node')

    return outPath
}

// TODO: turn this into a resource that resolves into `Record<string, string>` where the value is a relative path
export async function buildBinaryDeps(pkgDir: string, target?: Partial<QualifiedBuildTarget> & { snapshot?: boolean; downloadOnly?: boolean }) {
    const resolved = resolveBuildTarget(target)
    const pkg = await getPackageJsonOrThrow(pkgDir)

    const res: Record<string, string> = {}
    const deps = pkg.data.synapse?.binaryDependencies
    if (!deps) {
        return res
    }

    const binDir = path.resolve(pkgDir, 'bin')
    const toolsDir = path.resolve(pkgDir, 'tools')
    for (const [k, v] of Object.entries(deps)) {
        const isNode = k === 'node'
        if (isNode && !target?.snapshot && !target?.downloadOnly) continue

        const outputName = target?.os === 'windows' ? `${k}.exe` : k

        const artifact = await maybeUseGithubArtifact(v, resolved, k === 'terraform' ? `${k}-1.5.5` : k).catch(e => {
            if (target?.downloadOnly) {
                throw e
            }

            getLogger().log(`Failed to get artifact from "${v}"`, e)
        })

        const dest = isNode ? path.resolve(binDir, outputName) : path.resolve(toolsDir, outputName)

        if (artifact) {
            getLogger().log(`Using pre-built artifact for dependency: ${k}`)
            res[k] = dest

            await getFs().writeFile(dest, artifact)

            continue
        }

        if (target?.downloadOnly) {
            throw new Error(`No artifact found: ${k}`)
        }

        const source = await downloadSource({
            type: 'git',
            url: v,
            commitish: 'main',
        })

        if (isNode) {
            const outpath = await buildCustomNodeBin(source, target)
            await getFs().deleteFile(path.resolve(binDir, outputName)).catch(throwIfNotFileNotFoundError)
            await getFs().writeFile(
                path.resolve(binDir, outputName), 
                await getFs().readFile(outpath)
            )
            continue
        }

        res[k] = dest
        await buildGoProgram({
            sourceDir: source,
            output: dest,
            target: {
                mode: 'release',
                os: resolved.os,
                arch: resolved.arch,
            }
        })
    }

    return res
}

interface BuildTargetExtras {
    external?: string[]
    sign?: boolean
    skipPackage?: boolean
    stripInternal?: boolean
    buildLicense?: boolean

    // For building nodejs
    lto?: boolean
    snapshot?: boolean
    downloadOnly?: boolean
    environmentName?: string
}

export async function createPackageForRelease(pkgDir: string, dest: string, target?: Partial<QualifiedBuildTarget> & BuildTargetExtras, isIntegration?: boolean, useCompiledPkgJson = false) {
    const pkg = await getPackageJsonOrThrow(pkgDir) 
    const bt = await resolveProgramBuildTarget(pkgDir, { environmentName: target?.environmentName })
    if (!bt) {
        throw new Error(`Failed to resolve build target: ${pkgDir}`)
    }

    function removeExternalDeps(external: string[], pkgData: PackageJson) {
        if (!pkgData.dependencies && !pkgData.devDependencies) {
            return pkgData
        }

        const copy = { ...pkgData, dependencies: { ...pkgData.dependencies } }
        for (const [k, v] of Object.entries(copy.dependencies)) {
            if (external.find(x => k.startsWith(x))) {
                delete copy.dependencies[k]
            }
        }

        delete copy.devDependencies
        delete copy.scripts 

        return copy
    }

    const fs = getFs()

    const programId = bt.programId 
    const deploymentId = bt.deploymentId

    const programFs = getProgramFs(programId)
    const filesToKeep: string[] = []

    const moduleMappings = await getModuleMappings(programFs)
    if (moduleMappings) {
        for (const [k, v] of Object.entries(moduleMappings)) {
            filesToKeep.push(v.path)
            filesToKeep.push(v.path.replace(/\.js$/, '.infra.js'))
        }
    }

    const pruned = await createMergedView(programId, deploymentId)

    for (const f of Object.keys(pruned.files)) {
        if (isIntegration && (f.endsWith('.js') || f.endsWith('.d.ts')) || f === 'package.json') {
            filesToKeep.push(f)
        }
    }

    const consolidated = await consolidateBuild(getDataRepository(), pruned, filesToKeep, { strip: true })
    const { snapshot } = await createSnapshot(consolidated.index, programId, deploymentId)

    pruneSnapshot(snapshot, filesToKeep, target?.stripInternal)

    // Remap `pointers`
    for (const v of Object.values(snapshot.pointers)) {
        for (const [k, p] of Object.entries(v)) {
            v[k] = toAbsolute(consolidated.copier!.getCopiedOrThrow(p))
        }
    }

    // Same as `pointers`
    if (snapshot.published && isIntegration) {
        for (const [k, p] of Object.entries(snapshot.published)) {
            snapshot.published[k] = toAbsolute(consolidated.copier!.getCopiedOrThrow(`pointer:${p}`)).slice('pointer:'.length)
        }
    }

    await writeSnapshotFile(fs, dest, snapshot)
    await dumpData(dest, consolidated.index, snapshot.storeHash, true)

    if (useCompiledPkgJson && pruned.files['package.json']) {
        await fs.writeFile(
            path.resolve(dest, 'package.json'), 
            await getDataRepository().readData(pruned.files['package.json'].hash)
        )
    } else {
        await fs.writeFile(
            path.resolve(dest, 'package.json'), 
            JSON.stringify(pkg.data, undefined, 4),
        )
    }

    if (!target?.skipPackage) {
        const binaries = await buildBinaryDeps(dest, target)
        if (target?.sign) {
            for (const [k, v] of Object.entries(binaries)) {
                await sign(v)
            }
        }
    
        if (pkg.data.engines?.node && !target?.snapshot && !target?.downloadOnly) {
            await getNodeJsForPkg(dest, target)
        }    
    }

    if (target?.buildLicense) {
        getLogger().log('Building license')
        const license = await buildLicense()
        await getFs().writeFile(path.resolve(dest, 'LICENSE'), license)
    }

    if (target?.external) {
        const mapping = await installExternalPackages(dest, target.external, target)
        const resolved = resolveBuildTarget(target)
        const esbuildName = resolved.os === 'windows' ? `esbuild.exe` : 'esbuild'
        const esbuildBinPath = path.resolve(dest, 'node_modules', 'esbuild', 'bin', esbuildName)

        async function maybeCopyEsbuildBinary() {
            const dir = path.resolve(dest, 'node_modules', '@esbuild')
            const files = await getFs().readDirectory(dir).catch(throwIfNotFileNotFoundError)
            if (!files || files.length > 1 || files[0].type !== 'directory') return false

            // TODO: add `copyFile` to `system.ts`
            const p = path.resolve(dir, files[0].name, 'bin', esbuildName)
            const data = await getFs().readFile(p).catch(e => {
                throwIfNotFileNotFoundError(e)

                return getFs().readFile(path.resolve(dir, files[0].name, esbuildName))
            })

            await getFs().writeFile(esbuildBinPath, data)

            return true
        }

        if (await maybeCopyEsbuildBinary()) {
            if (target?.sign) {
                // TODO: sign `esbuild`
            }

            await getFs().deleteFile(path.resolve(dest, 'node_modules', '@esbuild')).catch(throwIfNotFileNotFoundError)

            if (target.snapshot) {
                await getFs().writeFile(path.resolve(dest, 'tools', esbuildName), await getFs().readFile(esbuildBinPath))
                await getFs().deleteFile(path.resolve(dest, 'node_modules', 'esbuild')).catch(throwIfNotFileNotFoundError)
            } else {
                await patchEsbuildMain(path.resolve(dest, 'node_modules', 'esbuild'), esbuildBinPath)

                if (resolved.os === 'windows') {
                    await getFs().deleteFile(esbuildBinPath.replace('.exe', '')).catch(throwIfNotFileNotFoundError)
                }
            }
        }

        // TODO: figure out why typescript can't find the lib files when not using SEA
        // perhaps remove this if statement?
        if (target.snapshot) {
            // TODO: do we need to copy the other files?
            const typescriptLibPath = path.resolve(dest, 'node_modules', 'typescript', 'lib')
            const libFiles = await glob(getFs(), typescriptLibPath, ['lib.*.d.ts'])
            // const minimalLibs = ['lib.es5.d.ts', 'lib.decorators.d.ts', 'lib.decorators.legacy.d.ts']
            for (const l of libFiles) {
                const text = await getFs().readFile(path.resolve(typescriptLibPath, l), 'utf-8')
                const stripped = text //stripComments()
                await getFs().writeFile(
                    path.resolve(dest, 'dist', path.basename(l)),
                    stripped
                )
            }
        }

        // Remove installed deps from `package.json`
        const copiedData = removeExternalDeps(target.external, pkg.data)
        await fs.writeFile(
            path.resolve(dest, 'package.json'), 
            JSON.stringify(copiedData, undefined, 4),
        )
    
        return { pruned, mapping }
    }

    return { pruned }

    // TODO: write hash list
    // TODO: sign everything
}

function stripComments(text: string) {
    const lines = text.split('\n')
    let line = lines.length - 1
    for (; line > 0; line--) {
        if (lines[line - 1].startsWith('/// <')) break
    }

    const result = lines.slice(0, line)
    const rest: string[] = []
    for (; line < lines.length; line++) {
        const stripped = lines[line].replace(/\/\/.*/g, '')
        if (stripped.trim()) {
            rest.push(stripped)
        }
    }

    result.push(rest.join('\n').replace(/\/\*(\n|.)*\*\//g, ''))

    return result.join('\n')
}

export async function createArchive(dir: string, dest: string, sign?: boolean) {
    if (path.extname(dest) === '.tgz') {
        const files = await glob(getFs(), dir, ['**/*', '**/.synapse'])    
        const tarball = createTarball(await Promise.all(files.map(async f => ({
            contents: Buffer.from(await getFs().readFile(f)),
            mode: 0o755,
            path: path.relative(dir, f),
        }))))
    
        const zipped = await gzip(tarball)
        await getFs().writeFile(dest, zipped)
    } else if (path.extname(dest) === '.zip') {
        try {
            await createZipFromDir(dir, dest, true)
        } catch (e) {
            getLogger().log(`failed to use built-in zip command`, e)
            const cwd = path.dirname(dir)
            await runCommand('zip', ['-r', dest, path.basename(dir)], { cwd })
        }
    } else {
        throw new Error(`Not implemented: ${path.extname(dest)}`)
    }

    // TODO: notarize for darwin
}

function pruneObject(obj: Record<string, any>, s: Set<string>) {
    for (const [k, v] of Object.entries(obj)) {
        if (!s.has(k)) {
            delete obj[k]
        }
    }
}

function pruneSnapshot(snapshot: Snapshot, filesToKeep: string[], stripInternal = false) {
    const s = new Set(filesToKeep)
    if (snapshot.published) {
        pruneObject(snapshot.published, s)
    }
    if (snapshot.pointers) {
        pruneObject(snapshot.pointers, s)
    }

    // Delete sourcemaps on types
    const typesToKeep = new Set<string>()
    if (snapshot.moduleManifest) {
        for (const [k, v] of Object.entries(snapshot.moduleManifest)) {
            if (v.types) {
                delete (v.types as any).sourcemap
                typesToKeep.add(v.path.replace(/\.js$/, '.d.ts'))
            }
        }
    }

    if (snapshot.types) {
        for (const k of Object.keys(snapshot.types)) {
            if (!typesToKeep.has(k)) {
                delete snapshot.types[k]
            }
        }
    }
}

async function patchEsbuildMain(pkgDir: string, binPath: string) {
    const main = path.resolve(pkgDir, 'lib', 'main.js')

    const mainText = await getFs().readFile(main, 'utf-8')
    if (mainText.startsWith('var ESBUILD_BINARY_PATH = ')) {
        // Maybe validate that the binary works?
        return
    }

    const relBinPath = path.relative(path.dirname(main), binPath)

    const patched = `var ESBUILD_BINARY_PATH = require("node:path").resolve(__dirname, "${relBinPath}");\n${mainText}`
    await getFs().writeFile(main, patched)
}

export async function installExternalPackages(pkgDir: string, external: string[], target?: Partial<QualifiedBuildTarget>) {
    const pkg = await getPackageJsonOrThrow(pkgDir)
    const deps = pkg.data.dependencies
    if (!deps) {
        return
    }

    const needsInstall: [string, string][] = []
    for (const [k, v] of Object.entries(deps)) {
        if (external.find(s => k.startsWith(s))) {
            needsInstall.push([k, v])
        }
    }

    if (needsInstall.length === 0) {
        return
    }

    const { mapping } = await installModules(pkgDir, Object.fromEntries(needsInstall), target)

    return mapping
}

async function verifyCodesign() {
    // codesign --verify --deep --strict --verbose=2 <code-path>
}


// Developer ID Application <-- use this cert
// https://appstoreconnect.apple.com/access/integrations/api

async function codesign(fileName: string, certId: string, entitlementsPath?: string) {
    const args = ['--sign', certId, '--timestamp', '--options', 'runtime', fileName]
    if (entitlementsPath) {
        args.unshift('--entitlements', entitlementsPath)
    }

    await runCommand('codesign', args)
}

interface ConnectCreds {
    id: string
    key: string // file path
    issuer: string
    teamId: string
}

async function notarize(fileName: string, creds: ConnectCreds) {
    const credsArgs = [
        '--key', creds.key,
        '--key-id', creds.id,
        '--issuer', creds.issuer,
        '--team-id', creds.teamId
    ]

    const args = [
        'notarytool', 
        'submit', fileName, 
        '--wait', 
        '--output-format', 'json', 
        ...credsArgs,
    ]

    const res = JSON.parse(await runCommand('xcrun', args)) as { id: string; status: string; message: string }
    if (res.status === 'Invalid') {
        const logsRaw = await runCommand('xcrun', ['notarytool', 'log', res.id, ...credsArgs])
        const logs = JSON.parse(logsRaw)

        throw new Error(`Failed to notarize: ${logsRaw}`)
    }
}

const entitlements = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.get-task-allow</key>
    <true/>
</dict>
</plist>
`

async function sign(fileName: string, entitlements?: string) {
    if (process.platform !== 'darwin') {
        return
    }

    const keyId = process.env.SIGNING_KEY_ID
    if (!keyId) {
        throw new Error(`Missing environment variable: SIGNING_KEY_ID`)
    }

    const entitlementsPath = entitlements ? path.resolve(path.dirname(fileName), 'tmp-entitlements.plist') : undefined
    if (entitlements && entitlementsPath) {
        await getFs().writeFile(entitlementsPath, entitlements)
    }

    await codesign(fileName, keyId, entitlementsPath).catch(e => {
        if ((e as any).stderr?.includes('is already signed')) {
            return
        }
    })

    if (entitlements && entitlementsPath) {
        await getFs().deleteFile(entitlementsPath)
    }
}

export async function signWithDefaultEntitlements(fileName: string) {
    return sign(fileName, entitlements)
}

const thirdPartyNotice = `
This file is based on or incorporates material from the projects listed below
(collectively "Third Party Code"). Cohesible is not the original author of the 
Third Party Code. The original copyright notice and the license, under which 
Cohesible received such Third Party Code, are set forth below. Such licenses and 
notices are provided for informational purposes only. 

Cohesible, not the third party, licenses the Third Party Code to you under the 
terms set forth at the start of this file. Cohesible reserves all other rights 
not expressly granted under this agreement, whether by implication, estoppel 
or otherwise.
`.trim()

export async function buildLicense() {
    // from 5.4.5
    const typescriptLicense = `
Copyright (c) Microsoft Corporation. All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0

THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
MERCHANTABLITY OR NON-INFRINGEMENT.

See the Apache Version 2.0 License for specific language governing permissions
and limitations under the License.
`.trim()

    // from 0.20.2
    const esbuildLicense = `
MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.    
`.trim()

    const nodeLicense = await github.downloadRepoFile('Cohesible', 'node', 'LICENSE')
    const terraformLicense = await github.downloadRepoFile('Cohesible', 'terraform', 'LICENSE')

    const synapseLicense = `
Copyright (c) Cohesible, Inc.
Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0

THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
MERCHANTABLITY OR NON-INFRINGEMENT.

See the Apache Version 2.0 License for specific language governing permissions
and limitations under the License.
`.trim()

    // TODO: include TypeScript's third party notice
    const sections = {
        'Node.js': nodeLicense.toString('utf-8'),
        Terraform: terraformLicense.toString('utf-8'),
        TypeScript: typescriptLicense,
        esbuild: esbuildLicense,
    }

    const license: string[] = []
    license.push(synapseLicense)
    license.push('')
    license.push(thirdPartyNotice)
    license.push('')

    for (const [k, v] of Object.entries(sections)) {
        const border = '-'.repeat(16)
        license.push(`${border} ${k} ${border}`)
        license.push('')
        license.push(v)
        license.push('')
    }

    return license.join('\n')
}
