import * as path from 'node:path'
import { StdioOptions } from 'node:child_process'
import { mergeBuilds, pruneBuild, getInstallation, writeSnapshotFile, getProgramFs, getDataRepository, getModuleMappings, loadSnapshot, dumpData, getProgramFsIndex, getDeploymentFsIndex, toFsFromIndex, copyFs, createSnapshot, getOverlayedFs, Snapshot, ReadonlyBuildFs, getSnapshotPath } from '../artifacts'
import {  NpmPackageInfo, getDefaultPackageInstaller, installFromSnapshot, testResolveDeps } from './packages'
import { getBinDirectory, getSynapseDir, getLinkedPackagesDirectory, getToolsDirectory, getUserEnvFileName, getWorkingDir, listPackages, resolveProgramBuildTarget, SynapseConfiguration, getUserSynapseDirectory, setPackage, BuildTarget, findDeployment, getOrCreateRemotePackage } from '../workspaces'
import { gunzip, gzip, isNonNullable, keyedMemoize, linkBin, makeExecutable, memoize, throwIfNotFileNotFoundError, tryReadJson } from '../utils'
import { Fs, ensureDir, readFileWithStats } from '../system'
import { glob } from '../utils/glob'
import { getLogger, runTask } from '../logging'
import { homedir } from 'node:os'
import { getBuildTargetOrThrow, getFs, getSelfPathOrThrow, isSelfSea } from '../execution'
import { ImportMap, expandImportMap, hoistImportMap } from '../runtime/importMaps'
import { createCommandRunner, patchPath, runCommand } from '../utils/process'
import { PackageJson, ResolvedPackage, getCompiledPkgJson, getCurrentPkg, getImmediatePackageJsonOrThrow, getPackageJson } from './packageJson'
import { readPathMapKey, setPathKey } from '../cli/config'
import { getEntrypointsFile } from '../compiler/programBuilder'
import { createPackageForRelease } from '../cli/buildInternal'
import * as registry from '@cohesible/resources/registry'
import { createTarball, extractTarball } from '../utils/tar'

const getDependentsFilePath = () => path.resolve(getUserSynapseDirectory(), 'packageDependents.json')

interface DependentsData {
    [directory: string]: Record<string, { location: string; hash: string; timestamp: string }>
}

async function _getDependentsData(): Promise<DependentsData> {
    return getFs().readFile(getDependentsFilePath(), 'utf-8').then(JSON.parse).catch(e => {
        throwIfNotFileNotFoundError(e)

        return {}
    })
}

export const getDependentsData = memoize(_getDependentsData)

export async function setDependentsData(data: DependentsData): Promise<void> {
    await getFs().writeFile(getDependentsFilePath(), JSON.stringify(data, undefined, 4))
}

export function updateDependent(dependents: DependentsData[string], key: string, location: string, hash: string) {
    dependents[key] = { location, hash, timestamp: new Date().toISOString() }
    const size = Object.values(key).length
    if (size > 5) {
        const entries = Object.entries(dependents).map(([k, v]) => [k, v.timestamp ? new Date(v.timestamp).getTime() : Date.now()] as const)
        entries.sort((a, b) => b[1] - a[1])

        const rem = entries.map(x => x[0]).slice(4)
        for (const k of rem) {
            delete dependents[k]
        }
    }
}

async function getDependents(pkgLocation: string) {
    const data = await getDependentsData()

    return data[pkgLocation] ?? {}
}

async function publishPkgUpdates(pkgLocation: string, snapshot: Snapshot & { store: ReadonlyBuildFs }, fs = getFs()) {
    let needsUpdate = false
    const dependents = await getDependents(pkgLocation)
    for (const [k, v] of Object.entries(dependents)) {
        if (v.hash === snapshot.storeHash) continue

        if (!(await fs.fileExists(v.location))) {
            getLogger().debug(`Removing stale dependent "${v.location}"`)

            delete dependents[k]
            needsUpdate = true
            continue
        }

        getLogger().debug(`Updating dependent at "${v.location}"`)
        await installFromSnapshot(k, v.location, pkgLocation, snapshot)
        needsUpdate = true
        updateDependent(dependents, k, v.location, snapshot.storeHash)
    }

    if (needsUpdate) {
        await setDependentsData({
            ...(await getDependentsData()),
            [pkgLocation]: dependents,
        })
    }
}

function getLinkedPkgPath(name: string, deploymentId?: string) {
    const packagesDir = getLinkedPackagesDirectory()
    
    return path.resolve(packagesDir, deploymentId ? `${name}-${deploymentId}` : name)
}

async function publishTarball(tarball: Buffer, pkgJson: PackageJson, opt?: PublishToRemoteOptions) {
    const remotePkgId = await getOrCreateRemotePackage(!!opt?.ref)
    getLogger().log(`Using package: ${remotePkgId}`)

    const client = registry.createClient()
    const { hash } = await client.uploadPackage(remotePkgId, tarball)
    if (opt?.ref) {
        getLogger().log(`Setting package ref: ${opt.ref} --> ${hash}`)

        return client.setRef(remotePkgId, opt.ref, hash)
    }

    await client.publishPackage({
        packageId: remotePkgId,
        packageHash: hash,
        packageJson: pkgJson,
        allowOverwrite: opt?.allowOverwrite,
    })

    if (opt?.visibility === 'public') {
        await client.updatePackageMetadata({
            packageId: remotePkgId,
            public: true,
        })
    }
}

interface PublishToRemoteOptions {
    tarballPath?: string
    allowOverwrite?: boolean
    visibility?: 'public' | 'private'
    ref?: string
}

async function publishTarballToRemote(tarballPath: string, opt?: PublishToRemoteOptions) {
    const tarball = Buffer.from(await getFs().readFile(tarballPath))
    const files = extractTarball(await gunzip(tarball))
    const pkgJsonFile = files.find(f => f.path === 'package.json')
    if (!pkgJsonFile) {
        throw new Error(`Missing package.json inside tarball`)
    }

    const pkgJson = JSON.parse(pkgJsonFile.contents.toString('utf-8'))

    await publishTarball(tarball, pkgJson, opt)
}

export async function publishToRemote(opt?: PublishToRemoteOptions) {
    if (opt?.tarballPath) {
        return publishTarballToRemote(opt.tarballPath, opt)
    }

    const bt = getBuildTargetOrThrow()
    const packageDir = getWorkingDir()
    const tmpDest = path.resolve(packageDir, `${path.dirname(packageDir)}-tmp`)

    const pkgJson = await getCurrentPkg()
    if (!pkgJson) {
        throw new Error('Missing package.json')
    }

    try {
        await createPackageForRelease(packageDir, tmpDest, { environmentName: bt.environmentName }, true, true, true)
        const tarball = await createSynapseTarball(tmpDest)
        await publishTarball(tarball, pkgJson.data, opt)
    } finally {
        await getFs().deleteFile(tmpDest).catch(throwIfNotFileNotFoundError)
    }
}

export async function linkPackage(opt?: PublishOptions & { globalInstall?: boolean; skipInstall?: boolean; useNewFormat?: boolean }) {
    const bt = getBuildTargetOrThrow()

    function getPkg() {
        if (opt?.packageDir) {
            return getPackageJson(getProgramFs(), packageDir, false)
        }

        return getCurrentPkg()
    }

    const packageDir = opt?.packageDir ?? getWorkingDir()
    const pkg = await getPkg()
    if (!pkg) {
        throw new Error(`No "package.json" found: ${packageDir}`)
    }

    const fs = getFs()
    const pkgName = pkg.data.name ?? path.basename(pkg.directory)
    const resolvedDir = getLinkedPkgPath(pkgName, bt.deploymentId)
    if (opt?.useNewFormat) {
        return createPackageForRelease(packageDir, resolvedDir, { skipBinaryDeps: true }, true, true, true)
    }

    const pruned = await createMergedView(bt.programId, bt.deploymentId)
    const oldManifest = await tryReadJson<Snapshot>(fs, getSnapshotPath(resolvedDir))
    const oldStoreHash = oldManifest?.storeHash

    await runTask('copyFs', 'linkPackage', () => copyFs(pruned, resolvedDir), 100)
    await patchSourceRoots(bt.workingDirectory, resolvedDir)
    const { snapshot, committed } = await createSnapshot(pruned,  bt.programId, bt.deploymentId)
    // TODO: exclusively use data blocks instead of 'both'
    await dumpData(resolvedDir, pruned, snapshot.storeHash, 'both', oldStoreHash)
    await writeSnapshotFile(fs, resolvedDir, snapshot)

    if (!pruned.files['package.json']) {
        await fs.writeFile(
            path.resolve(resolvedDir, 'package.json'), 
            await fs.readFile(path.resolve(packageDir, 'package.json'))
        )
    } else {
        await fs.writeFile(
            path.resolve(resolvedDir, 'package.json'), 
            await getDataRepository().readData(pruned.files['package.json'].hash)
        )
    }

    await setPackage(pkgName, bt.programId)

    if (pkgName === 'synapse') {
        for (const [k, v] of Object.entries(getPkgExecutables(pkg.data) ?? {})) {
            await makeExecutable(path.resolve(resolvedDir, v))
        }
    
        if (!opt?.skipInstall) {
            await writeImportMap(resolvedDir, snapshot.published, snapshot.storeHash)
        }

        // XXX: remove deps
        const pkgData = JSON.parse(await fs.readFile(path.resolve(resolvedDir, 'package.json'), 'utf-8'))
        delete pkgData.bin
        delete pkgData.dependencies
        await fs.writeFile(path.resolve(resolvedDir, 'package.json'), JSON.stringify(pkgData))
    }

    async function replaceIntegration(name: string) {
        await setPathKey(`projectOverrides.synapse-${name}`, resolvedDir)
    }

    if (pkgName.startsWith('synapse-')) {
        await replaceIntegration(pkgName.slice('synapse-'.length))
    }

    // Used internally for better devex
    // This can make things really slow if there are many dependents
    if (!bt.environmentName) {
        const snapshotWithStore = Object.assign(snapshot, { store: committed })
        await publishPkgUpdates(resolvedDir, snapshotWithStore)
        await publishPkgUpdates(packageDir, snapshotWithStore)
    }

    return resolvedDir
}

export async function emitPackageDist(dest: string, bt: BuildTarget, tsOutDir?: string, declaration?: boolean) {
    const pruned = await createMergedView(bt.programId, bt.deploymentId)

    if (!declaration) {
        for (const [k, v] of Object.entries(pruned.files)) {
            if (k.endsWith('.d.ts') || k.endsWith('.d.ts.map')) {
                delete pruned.files[k]
            }
        }
    }

    // We only want files under `tsOutDir`
    if (tsOutDir) {
        for (const [k, v] of Object.entries(pruned.files)) {
            delete pruned.files[k]
            if (!k.startsWith(tsOutDir)) {
                continue
            }

            pruned.files[path.posix.relative(tsOutDir, k)] = v
        }
    }

    await copyFs(pruned, dest, undefined, false)

    return dest
}

export async function dumpPackage(dest: string, opt?: { debug?: boolean }) {
    const fs = getFs()
    const pkg = await getImmediatePackageJsonOrThrow()
    const bt = getBuildTargetOrThrow()

    const programId = bt.programId 
    const deploymentId = bt.deploymentId

    const pruned = await createMergedView(programId, deploymentId)

    await copyFs(pruned, dest)
    const { snapshot } = await createSnapshot(pruned, programId, deploymentId)
    await writeSnapshotFile(fs, dest, snapshot)

    if (!pruned.files['package.json']) {
        await fs.writeFile(
            path.resolve(dest, 'package.json'), 
            await fs.readFile(path.resolve(getWorkingDir(), 'package.json'))
        )    
    }

    for (const [k, v] of Object.entries(getPkgExecutables(pkg.data) ?? {})) {
        await makeExecutable(path.resolve(dest, v))
    }

    await writeImportMap(dest, snapshot.published, snapshot.storeHash)

    return dest
}

export function getPkgExecutables(pkgData: PackageJson) {
    const bin = pkgData.bin
    if (!bin) {
        return
    }

    if (typeof bin === 'string' && !pkgData.name) {
        throw new Error('An executable name must be provided when omitting the package name')
    }

    return typeof bin === 'string' ? Object.fromEntries([[pkgData.name, bin]]) : bin
}

async function getOverridesFromProject() {
    const res: Record<string, string> = {}
    const bt = getBuildTargetOrThrow()
    const projectId = bt.projectId
    const packages = await listPackages(projectId)
    for (const [k, v] of Object.entries(packages)) {
        const procId = await findDeployment(v, projectId, bt.environmentName, bt.branchName)
        const pkgLocation = getLinkedPkgPath(k, procId)
        if (await getFs().fileExists(pkgLocation)) {
            res[k] = pkgLocation
        }
    }

    return res
}

async function getMergedOverrides() {
    const [fromConfig, fromProject] = await Promise.all([
        readPathMapKey('projectOverrides'),
        getOverridesFromProject()
    ])

    return {  ...fromProject, ...fromConfig }
}

async function _getLocalOverrides() {
    const overrides = await getMergedOverrides()
    
    return Object.keys(overrides).length === 0 ? undefined : overrides
}

const getLocalOverrides = memoize(_getLocalOverrides)

export async function getProjectOverridesMapping(fs: Fs) {
    const overrides = await getLocalOverrides()
    if (!overrides) {
        return
    }

    const mapping: Record<string, string> = {}
    for (const [k, v] of Object.entries(await listPackages())) {
        const dest = overrides[k]
        if (!dest) {
            continue
        }

        mapping[dest] = getWorkingDir(v)
    }

    return mapping
}

export async function getSelfDir() {
    const pkg = await getPackageJson(getFs(), path.dirname(getSelfPathOrThrow()), true)
    if (!pkg || pkg.data.name !== 'synapse') {
        return
    }

    return pkg.directory
}

async function findOwnSnapshot(currentDir: string) {
    const fs = getFs()
    const pkg = await getPackageJson(fs, currentDir, true)
    if (!pkg) {
        getLogger().error(`Failed to find own package starting from ${currentDir}`)
        return
    }

    const snapshot = await loadSnapshot(pkg.directory)
    if (!snapshot) {
        throw new Error(`Missing own snapshot`)
    }

    return { pkg, snapshot }
}

export async function addImplicitPackages(
    packages: Record<string, string>, 
    synapseConfig?: SynapseConfiguration,
) {
    const withTargets = synapseConfig?.target && !synapseConfig?.sharedLib 
        ? maybeAddTargetPackage(packages, synapseConfig.target) 
        : packages

    // Already installed as a project package
    const s = Object.values(packages).find(x => x === `spr:#synapse`)
    if (s) {
        return withTargets
    }

    // The time is from copying files. Only for "block-less" copies. 
    // When using blocks this takes less than a millisecond
    //
    // 2024-04-05T20:23:03.150Z [PERF] packages (findOwnSnapshot) 944.399 ms
    const _findOwnSnapshot = () => runTask('packages', 'findOwnSnapshot', () => findOwnSnapshot(path.dirname(getSelfPathOrThrow())), 1)

    async function getSelfDir() {
        return (await getPackageOverride('synapse')) ?? (await _findOwnSnapshot())?.pkg.directory 
    }

    const selfDir = await getSelfDir()
    if (!selfDir) {
        throw new Error(`Failed to find Synapse runtime package`)
    }

    getLogger().debug('Adding self to package dependencies')

    return {
        ...withTargets,
        '@cohesible/synapse': `file:${selfDir}`,
    }
}

function maybeAddTargetPackage(packages: Record<string, string>, target: string) {
    const pkgName = `synapse-${target}`
    const pkgUrl = `spr:#${pkgName}`

    // Already installed as a project package
    const s = Object.values(packages).find(x => x === pkgUrl)
    if (s) {
        return packages
    }

    getLogger().debug('Adding target to package dependencies')

    return {
        ...packages,
        [`@cohesible/${pkgName}`]: pkgUrl,
    }
}

export async function getPackageOverride(spec: string) {
    const overrides = await getLocalOverrides()

    return overrides?.[spec]
}

interface CachedImportMap {
    mappings: ImportMap
    fsHash: string
}

const importMapFileName = '[#install]__import-map__.json'
async function readCachedImportMap() {
    const programFs = getProgramFs()
    const d = await tryReadJson<CachedImportMap>(programFs, importMapFileName)
    if (d && !('fsHash' in d)) {
        return
    }

    return d
}

async function writeCachedImportMap(mapping: CachedImportMap) {
    const programFs = getProgramFs()

    await programFs.writeFile(importMapFileName, JSON.stringify(mapping))
}

async function writeImportMap(packageDir: string, published?: Record<string, string>, fsHash?: string) {
    const fs = getFs()
    const cached = fsHash ? await readCachedImportMap() : undefined
    if (cached && cached.fsHash === fsHash) {
        await fs.writeFile(path.resolve(packageDir, 'import-map.json'), JSON.stringify(cached.mappings))

        return
    }

    const installation = await getInstallation(getProgramFs())

    async function getMapping() {
        if (installation?.importMap) {
            return expandImportMap(installation.importMap)
        }

        const m = await testResolveDeps(path.resolve(packageDir, 'package.json'))
        const pkgInstaller = getDefaultPackageInstaller()
        return pkgInstaller.getImportMap(m)
    }

    const pkgInstaller = getDefaultPackageInstaller()
    const importMap = await getMapping()
    const runtimeMappings = (await getModuleMappings(getProgramFs())) ?? {}
    for (const [k, v] of Object.entries(runtimeMappings)) {
        importMap[k] = { location: path.resolve(packageDir, v.path), locationType: 'module' }
    }

    if (published) {
        for (const [k, v] of Object.entries(published)) {
            const m = await pkgInstaller.getPublishedMappings(k, v)
            if (m) {
                importMap[m[0]] = m[1]
            }
        }
    }

    if (fsHash) {
        await writeCachedImportMap({ mappings: importMap, fsHash })
    }

    await fs.writeFile(path.resolve(packageDir, 'import-map.json'), JSON.stringify(importMap))
}

export async function createMergedView(programId: string, deploymentId?: string, pruneInfra = true, preferProgram = false) {
    const builds = await Promise.all([
        getProgramFsIndex({ ...getBuildTargetOrThrow(), programId }),
        deploymentId ? getDeploymentFsIndex(deploymentId) : undefined
    ])

    if (builds[1] && preferProgram) {
        const workingDirectory = getWorkingDir()
        const programFs = toFsFromIndex(builds[0])
        const deployables = (await getEntrypointsFile(programFs))?.deployables
        const programDeployables = new Set<string>(Object.values(deployables ?? {}).map(f => path.relative(workingDirectory, f)))
        for (const [k, v] of Object.entries(builds[1].files)) {
            if (builds[0].files[k] && !programDeployables.has(k)) {
                delete builds[1].files[k]
            }
        }
    }

    const merged = mergeBuilds(builds.filter(isNonNullable))
    const infraFiles = pruneInfra ? Object.keys(merged.files).filter(x => x.endsWith('.infra.js') || x.endsWith('.infra.js.map')) : []
    const privateFiles = Object.keys(merged.files).filter(x => !!x.match(/^__([a-zA-Z_-]+)__\.json$/)) // XXX
    const pruned = pruneBuild(merged, ['template.json', 'published.json', 'state.json', 'packages.json', ...infraFiles, ...privateFiles])

    return pruned
}

async function patchSourceRoots(rootDir: string, targetDir: string) {
    const sourcemaps = await glob(getFs(), targetDir, ['**/*.map'], ['node_modules'])
    for (const f of sourcemaps) {
        const sm = JSON.parse(await getFs().readFile(f, 'utf-8'))
        const source = sm.sources[0]
        if (!source || source.startsWith(rootDir)) {
            continue
        }

        const s = path.resolve(f, '..', source)
        sm.sources[0] = path.resolve(rootDir, path.relative(targetDir, s))
        await getFs().writeFile(f, JSON.stringify(sm))
    }
}

async function getIncludedFiles(fs: Fs, pkg: ResolvedPackage) {
    const included = [...(pkg.data.files ?? ['*'])]
    included.push(
        'README',
        'CHANGES',
        'CHANGELOG',
        'HISTORY',
        'LICENSE',
        'LICENCE',
        'NOTICE'
    )

    const excluded: string[] = []
    excluded.push('node_modules', '.git', '.synapse')
    excluded.push('**/*.map')

    return glob(fs, pkg.directory, included, excluded)
}


interface PublishOptions {
    readonly dryRun?: boolean
    readonly packageDir?: string
    readonly includeSourceMaps?: boolean
}

interface ToolsManifest {
    [directory: string]: string
}

async function readToolsManifest(fs: Fs, name: string): Promise<ToolsManifest> {
    const p = path.resolve(getToolsDirectory(), 'index', `${name}.json`)

    return (await tryReadJson<ToolsManifest>(fs, p)) ?? {}
}

async function writeToolsManifest(fs: Fs, name: string, data: ToolsManifest): Promise<void> {
    const p = path.resolve(getToolsDirectory(), 'index', `${name}.json`)

    return await fs.writeFile(p, JSON.stringify(data, undefined, 4))
}

async function createToolWrapper(name: string, manifest: ToolsManifest, fs = getFs()) {
    const cases: string[] = []
    for (const [k, v] of Object.entries(manifest).sort((a, b) => b[0].localeCompare(a[0]))) {
        cases.push(
`
    "${k}"*)
        exec "${v}" "$@"
        ;;
`
        )
    }

    cases.push(
`
    *)
        echo "No tool installed in current directory"
        exit 1
        ;;
`
    )

    const text = `
#!/usr/bin/env bash

case $PWD in
${cases.join('')}
esac
`

    const dest = path.resolve(getBinDirectory(), name)
    await fs.writeFile(dest, text, { mode: 0o755 })
}

const useToolManifest = false

async function createBinShim(fs: Fs, executablePath: string) {
    const shimPath = path.resolve(getSelfPathOrThrow(), '..', 'shim.exe')
    const data = await fs.readFile(shimPath)
    const magic = 0x74617261

    enum ShimType {
        Native,
        Interpretted,
        Unknown,
    }

    interface ResolvedParams {
        shimType: ShimType
        runtime?: string
    }

    function getShimType() {
        switch (path.extname(executablePath)) {
            case '.bat':
            case '.cmd':
            case '.exe':
                return ShimType.Native

            case '.js':
            case '.mjs':
            case '.cjs':
                return ShimType.Interpretted

            default:
                return ShimType.Unknown
        }
    }

    async function parseShebangLine() {
        const text = await fs.readFile(executablePath, 'utf-8')
        if (!text.startsWith('#!')) {
            return
        }

        const nl = text.indexOf('\n')
        if (nl === -1) {
            return
        }

        return text.slice(0, nl)
    }

    async function getResolvedSelf() {
        const resolved = path.resolve(getSelfPathOrThrow(), '..', '..', 'bin', 'synapse.exe')
        if (!(await fs.fileExists(resolved))) {
            throw new Error(`Missing runtime executable: ${resolved}`)
        }

        return resolved
    }

    async function resolveParams(): Promise<ResolvedParams> {
        let shimType = getShimType()
        if (shimType === ShimType.Native) {
            return { shimType }
        }

        const shebang = await parseShebangLine()
        if (!shebang) {
            if (shimType === ShimType.Unknown) {
                return { shimType }
            }

            return { 
                shimType,
                runtime: await getResolvedSelf(),
            }
        }

        shimType = ShimType.Interpretted

        const parts = shebang.split(' ')
        if (parts[1] === 'node') {
            return { 
                shimType,
                runtime: await getResolvedSelf(),
            }
        }

        if (parts.length === 1) {
            // TODO: convert common paths to windows equivalents e.g. /bin/sh to bash.exe
            return {
                shimType,
                runtime: path.resolve(parts[0]),
            }
        }

        const runtime = (await runCommand('where', [parts[1]])).trim()

        return { shimType, runtime }
    }

    const resolved = await resolveParams()
    if (resolved.shimType === ShimType.Unknown) {
        throw new Error(`Failed to detect executable type`)
    }

    const target = Buffer.from(executablePath, 'utf-16le')
    const runtime = resolved.runtime ? Buffer.from(resolved.runtime, 'utf-16le') : undefined

    const footerSize = 8
    const payloadSize = target.byteLength + 2 + (runtime ? (runtime.byteLength + 2) : 0)
    const totalSize = 1 + payloadSize + footerSize

    const buf = Buffer.allocUnsafe(data.byteLength + totalSize)
    buf.set(data)

    let pos = data.byteLength
    pos = buf.writeUInt8(resolved.shimType, pos)

    buf.set(target, pos)
    pos += target.byteLength
    pos = buf.writeUint16LE(0, pos)

    if (runtime) {
        buf.set(runtime, pos)
        pos += runtime.byteLength
        pos = buf.writeUint16LE(0, pos) 
    }

    pos = buf.writeUint32LE(1 + payloadSize, pos)
    pos = buf.writeUint32LE(magic, pos)

    return buf
}

export async function installBin(fs: Fs, executablePath: string, toolName: string, dir: string, removeNested = false) {
    if (useToolManifest) {
        await makeExecutable(executablePath)
        // FIXME: PERF: this is _very_ slow atm
        await installWithToolManifest(fs, executablePath, toolName, dir, removeNested)

        return
    }

    if (process.platform === 'win32') {
        const dest = path.resolve(dir, 'node_modules', '.bin', toolName.replace(/\..*$/, '') + '.exe')
        const shim = await createBinShim(fs, executablePath)
        await fs.writeFile(dest, shim)

        return
    }

    const dest = path.resolve(dir, 'node_modules', '.bin', toolName)
    const link = async () => fs.link(executablePath, dest, { symbolic: true, mode: 0o755, typeHint: 'file' })
    await link().catch(async e => {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }

        await ensureDir(dest)
        await link()
    })
}

async function installWithToolManifest(fs: Fs, executablePath: string, toolName: string, dir: string, removeNested = false) {
    const m = await readToolsManifest(fs, toolName)
    if (removeNested) {
        for (const key of Object.keys(m)) {
            if (key.startsWith(dir)) {
                delete m[key]
            }
        }
    }

    if (m[dir] !== executablePath) {
        m[dir] = executablePath
        await writeToolsManifest(fs, toolName, m)
        await createToolWrapper(toolName, m)
    }
}

function isBinInstalled() {
    const paths = process.env['PATH']?.split(':')

    return paths?.includes(getBinDirectory())
}

// `bash` config file predcedence:
//     `.bash_profile` > `.bash_login` > `.profile`

export function createInstallCommands(synapseDir: string, includeComments = false, completionsPath?: string) {
    const maybeRelPath = synapseDir.replace(homedir(), '$HOME')
    const resolvedCompletions = completionsPath ?? path.resolve(synapseDir, 'completions', 'synapse.sh')
    const completions = resolvedCompletions.replace(synapseDir, '$SYNAPSE_INSTALL')

    return [
        includeComments ? `# Synapse install` : '',
        `export SYNAPSE_INSTALL="${maybeRelPath}"`,
        `export PATH="$SYNAPSE_INSTALL/bin:$PATH"`,
        includeComments ? '# enables Synapse command line completions' : '',
        `[ -f "${completions}" ] && source "${completions}"`
    ].filter(x => !!x)
}

function uninstallFromProfile(lines: string[]) {
    function shouldRemove(line: string) {
        if (line.startsWith('# Synapse install') || line.startsWith('# enables Synapse command line')) {
            return true
        }
        if (line.startsWith('#')) {
            return false
        }
        return line.includes('$SYNAPSE_INSTALL') || line.includes('SYNAPSE_INSTALL=')
    }

    return lines.filter(l => !shouldRemove(l))
}

async function installToProfile(synapseDir: string, profileFile: string, fs = getFs(), shouldOverride = true) {
    const text = await fs.readFile(profileFile, 'utf-8').catch(throwIfNotFileNotFoundError)

    const getInstallationLines = () => createInstallCommands(synapseDir, true)

    if (!text) {
        await fs.writeFile(profileFile, getInstallationLines().join('\n'))

        return true
    }

    async function appendInstall(lines: string[]) {
        const isLastLineEmpty = !lines.at(-1)?.trim()
        const isSecondLastLineEmpty = !lines.at(-2)?.trim()
        const installLines = getInstallationLines()
        // if (exportedPathLocation === -1) {
        //     lines.push(...installLines)
        // } else {
        //     lines.splice(exportedPathLocation, 1, '', ...installLines)
        // }

        if (isLastLineEmpty && isSecondLastLineEmpty) {
            lines.pop()
        } else if (!isLastLineEmpty) {
            lines.push('')
        }

        lines.push(...installLines, '')
    
        await fs.writeFile(profileFile, lines.join('\n'))
    }

    const lines = text.split('\n')
    const oldInstall = lines.findIndex(x => x.startsWith('# Synapse install') || x.includes('SYNAPSE_INSTALL='))
    if (oldInstall !== -1) {
        const desiredInstallLocation = `"${synapseDir.replace(homedir(), '$HOME')}"`
        if (lines.findIndex(x => !x.startsWith('#') && x.includes(`SYNAPSE_INSTALL=${desiredInstallLocation}`)) !== -1) {
            return true
        }
        // const lastLine = lines.findIndex((x, i) => i > oldInstall && x.includes('$SYNAPSE_INSTALL')) 
        // if (lastLine === -1) {
        //     // Corrupted install?
        // } else if (shouldOverride) {
        //     lines.splice(oldInstall, (lastLine - oldInstall) + 1, ...getInstallationLines())
        //     await fs.writeFile(profileFile, lines.join('\n'))
        // }
        await appendInstall(uninstallFromProfile(lines))
        return true
    }

    await appendInstall(lines)
    return true
}

const supportedShells = ['sh', 'bash', 'zsh'] as const

export function isSupportedShell(shell: string): shell is (typeof supportedShells)[number] {
    return supportedShells.includes(shell as any)
}

export async function installToUserPath(target: 'sh' | 'bash' | 'zsh' = 'zsh', synapseDir = getUserSynapseDirectory()) {
    switch (target) {
        case 'sh':
        case 'bash':
            return installToProfile(synapseDir, path.resolve(homedir(), '.profile'))
        case 'zsh':
            return installToProfile(synapseDir, path.resolve(homedir(), '.zprofile'))
    }
}

function findBinPathsSync(pkgDir: string, fs = getFs()) {
    const paths: string[] = []

    let dir = pkgDir
    while (true) {
        const p = path.resolve(dir, 'node_modules', '.bin')
        if (fs.fileExistsSync(p)) {
            paths.push(p)
        }

        const next = path.dirname(dir)
        if (next === dir || next === '.') {
            break
        }
        dir = next
    }

    return paths
}

export function createNpmLikeCommandRunner(pkgDir: string, env?: Record<string, string>, stdio?: StdioOptions, shell?: string) {
    const paths = findBinPathsSync(pkgDir)
    env = patchPath(paths.join(':'), env)

    return createCommandRunner({ 
        cwd: pkgDir, 
        env, 
        stdio,
        shell,
    })
}

export async function createSynapseTarball(dir: string) {
    const files = await glob(getFs(), dir, ['**/*', '**/.synapse'])
    const tarball = createTarball(await Promise.all(files.map(async f => {
        const { data, stats } = await readFileWithStats(f)

        return {
            contents: Buffer.from(data),
            mode: 0o755,
            path: path.relative(dir, f),
            mtime: Math.round(stats.mtimeMs),
        }
    })))

    const zipped = await gzip(tarball)

    return zipped
}
