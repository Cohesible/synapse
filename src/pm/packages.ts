import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { TargetsFile, readPointersFile } from '../compiler/host'
import { getLogger, runTask } from '../logging'
import { synapsePrefix, providerPrefix } from '../runtime/loader'
import type { DependencyTree, PackageInfo } from '../runtime/modules/serdes'
import { SynapseConfiguration, getSynapseDir, getRootDirectory, getToolsDirectory, getUserSynapseDirectory, getWorkingDir, getGlobalCacheDirectory, resolveProgramBuildTarget, getPackageCacheDirectory } from '../workspaces'
import { Mutable, acquireFsLock, createHasher, createMinHeap, deepClone, escapeRegExp, getHash, gunzip, isNonNullable, isRelativeSpecifier, isRunningInVsCode, isWindows, keyedMemoize, memoize, resolveRelative, sortRecord, strcmp, throwIfNotFileNotFoundError, tryReadJson } from '../utils'
import type { TerraformPackageManifest } from '../runtime/modules/terraform'
import { ProviderConfig, createProviderGenerator, getProviderSource, listProviderVersions } from '../codegen/providers'
import { createHash } from 'node:crypto'
import { DataRepository, InstallationAttributes, ModuleBindingResult, ReadonlyBuildFs, Snapshot, commitPackages, getInstallation, getModuleMappings, getPrefixedPath, isSnapshotTarball, readInfraMappings, unpackSnapshotTarball, getDataRepository, getProgramFs, loadSnapshot, tryLoadSnapshot, commitProgram, getProgramHash } from '../artifacts'
import { getDependentsData, getPackageOverride, installBin, setDependentsData, updateDependent } from './publish'
import { ModuleResolver } from '../runtime/resolver'
import { extractTarball, extractToDir } from '../utils/tar'
import { Fs, JsonFs, SyncFs, readDirectorySync } from '../system'
import { glob } from '../utils/glob'
import { getBuildTargetOrThrow, getFs, getSelfPath, getSelfPathOrThrow, isCancelled } from '../execution'
import { getTerraformPath } from '../deploy/deployment'
import { TypesFileData } from '../compiler/resourceGraph'
import { coerceToPointer, createPointer, isDataPointer, isNullHash, pointerPrefix, toAbsolute, toDataPointer } from '../build-fs/pointers'
import { ImportMap, SourceInfo, expandImportMap, flattenImportMap, hoistImportMap } from '../runtime/importMaps'
import { PackageJson, ResolvedPackage, createSynapseProviderRequirement, diffPkgDeps, getCurrentPkg, getPackageJson, getRequired, isFileUrl, resolveFileSpecifier, resolveWorkspaces, runIfPkgChanged, setCompiledPkgJson } from './packageJson'
import { QualifiedBuildTarget, resolveBuildTarget, toNodeArch, toNodePlatform } from '../build/builder'
import { InstallSummary, createInstallView } from '../cli/views/install'
import { VersionConstraint, compareConstraints, isCompatible, isExact, parseVersionConstraint } from './versions'
import { createRequester, fetchData } from '../utils/http'
import { createToolRepo, toolPrefix } from './tools'
import { cleanDir, fastCopyDir, removeDir } from '../zig/fs-ext'
import { colorize, printLine } from '../cli/ui'
import { OptimizedPackageManifest, PackageManifest, PublishedPackageJson, createManifestRepo, createMultiRegistryClient, createNpmRegistryClient } from './manifests'
import { createGitHubPackageRepo, downloadGitHubPackage, githubPrefix } from './repos/github'
import { createSynapsePackageRepo, downloadSynapsePackage, downloadSynapsePackageTarball, getPipelineDeps, sprPrefix } from './repos/spr'
import { getTsPathMappings } from '../compiler/entrypoints'
import { getOutputFilename, getResolvedTsConfig } from '../compiler/config'
import { execCommand } from '../utils/process'

// legacy
const providerRegistryHostname = ''

export type ResourceKind = 'inline' | 'construct'

export interface PackageEntry {
    readonly name: string
    readonly version: string // This can be a pattern e.g. `^2.0.0`
}

// Exports can be conditional
// Key order matters for determining which export to use
// Common conditions:
// `node`
// `browser`
// `import`
// `require`
// `default`
// `module`
// `development`
// `production`

interface SubpathExports {
    readonly '.'?: PackageExport
    readonly [entry: `./${string}`]: PackageExport
}

export interface ConditionalExports {
    readonly node?: PackageExport
    readonly browser?: PackageExport
    readonly require?: PackageExport
    readonly import?: PackageExport
    readonly module?: PackageExport
    readonly default?: PackageExport
    readonly [entry: string]: PackageExport | undefined
}

type PackageExport = SubpathExports | ConditionalExports | string | null

// Target is expected to be a relative path from the target package directory
export function resolveExport(target: string, exports: PackageExport, conditions?: string[], defaultEntrypoint?: string): string | [resolved: string, ...conditions: string[]] {
    const condSet = new Set<string>(conditions)
    condSet.add('default')

    return inner(exports)

    function inner(exports: PackageExport, pathReplacement?: string) {
        if (!exports) {
            throw new Error(`No exports available matching target "${target}": ${exports}`)
        }
    
        if (typeof exports === 'string') {
            if (pathReplacement !== undefined) {
                return exports.replace(/\*/, pathReplacement)
            }

            if (pathReplacement === undefined && target !== '.') {
                throw new Error(`Unable to resolve subpath "${target}". Package does not export any subpaths.`)
            }    

            return exports
        }

        if (Array.isArray(exports)) {
            const errors: any[] = []
            for (const x of exports) {
                try {
                    return inner(x, pathReplacement)
                } catch (e) {
                    errors.push(e)
                }
            }

            throw new AggregateError(errors, 'Failed to resolve exports array')
        }
    
        const keys = Object.keys(exports)
        if (keys.length === 0) {
            throw new Error(`Found empty exports object while resolving subpath "${target}"`)
        }
    
        if (isRelativeSpecifier(keys[0]) || keys[0][0] === '#') {
            if (pathReplacement !== undefined) {
                throw new Error(`Unexpected nested subpaths exports found while resolving "${target}"`)
            }

            return resolveSubpathExports(exports as SubpathExports)
        } else {
            return resolveConditionalExports(exports as ConditionalExports, pathReplacement)
        }
    }

    function resolveSubpathExports(subpaths: SubpathExports): string | [resolved: string, ...conditions: string[]] {
        if (defaultEntrypoint && target === '.' && !('.' in subpaths)) {
            return defaultEntrypoint
        }

        // Start from longest subpath first to handle private exports
        // Paths containing a wildcard are considered longer
        const entries: [string, PackageExport][] = Object.entries(subpaths).sort((a, b) => b[0].length - a[0].length)
        for (const [k, v] of entries) {
            const pattern = new RegExp(`^${escapeRegExp(k).replace(/\\\*/, '(.*)')}$`)
            const match = pattern.exec(target)
            if (match) {
                const replacement = match?.[1]
                if (replacement) {
                    return inner(v, replacement)
                }

                return inner(v, '')
            }
        }

        throw new Error(`Found no subpaths matching "${target}": ${entries.map(x => x[0])}`)
    }

    function resolveConditionalExports(cond: ConditionalExports, pathPattern?: string): string | [resolved: string, ...conditions: string[]] {
        // We iterate over the condition set instead of 
        // the conditions to ensure priority
        for (const k of condSet) {
            const v = cond[k]
            if (!v) continue

            try {
                const resolved = inner(v, pathPattern)
                if (typeof resolved === 'string' && k !== 'default') {
                    return [resolved, k]
                }
                return resolved
            } catch {}
        }

        throw new Error(`Found no conditions matching "${target}"`)
    }
}

function getConditions(mode: 'cjs' | 'esm' | 'synapse') {
    switch (mode) {
        case 'cjs':
            return ['node', 'require']
        case 'esm':
            return ['module', 'import']
        case 'synapse':
            return ['module', 'import', 'node', 'require']
    }

    throw new Error(`Unknown mode: ${mode}`)
}

// "synapse" mode can use both esm + cjs but prefers esm when available

interface ResolveResult {
    readonly fileName: string
    readonly moduleType: 'cjs' | 'esm'
}

export function resolvePrivateImport(spec: string, pkg: PackageJson, mode: 'cjs' | 'esm' | 'synapse'): ResolveResult {
    const imports = pkg.imports
    if (!imports) {
        throw new Error(`Package "${pkg.name}" has no imports field`)
    }

    const conditions = getConditions(mode)
    const resolved = resolveExport(spec, imports, conditions)

    if (typeof resolved === 'string') {
        return {
            fileName: resolved,
            moduleType: pkg.type === 'module' ? 'esm' : 'cjs',
        }
    }

    const lastCond = resolved[resolved.length - 1]
    if (lastCond === 'node' && pkg.type === 'module') {
        return {
            fileName: resolved[0],
            moduleType: 'esm',
        }
    }

    const moduleType = lastCond === 'import' || lastCond === 'module' ? 'esm' 
        : lastCond === 'node' || lastCond === 'require' ? 'cjs' 
        : lastCond === 'default' ? pkg.type === 'module' ? 'esm' : 'cjs' : 'cjs'

    return {
        fileName: resolved[0],
        moduleType,
    }
}

export function resolveBareSpecifier(spec: string, pkg: PackageJson, mode: 'cjs' | 'esm' | 'synapse'): ResolveResult {
    const components = getSpecifierComponents(spec)
    const target = components.export ? `./${components.export}` : '.'
    const defaultEntrypoint = mode === 'cjs' ? pkg.main : pkg.module
    const pkgType = pkg.type === 'module' ? 'esm' : 'cjs'
    const defaultModuleType = mode === 'synapse' ? pkgType : mode

    if (pkg.exports) {
        const conditions = getConditions(mode)
        const resolved = resolveExport(target, pkg.exports, conditions, defaultEntrypoint)

        if (typeof resolved === 'string') {
            return {
                fileName: resolved,
                moduleType: mode === 'synapse' ? (resolved === pkg.main ? 'cjs' : resolved === pkg.module ? 'esm' : pkgType) : pkgType,
            }
        }

        const lastCond = resolved[resolved.length - 1]
        const moduleType = lastCond === 'import' || lastCond === 'module' ? 'esm' 
            : lastCond === 'node' || lastCond === 'require' ? 'cjs' 
            : lastCond === 'default' ? pkgType : defaultModuleType

        return {
            fileName: resolved[0],
            moduleType,
        }
    }

    // Direct access to the package
    if (components.export) {
        return { fileName: target, moduleType: defaultModuleType }
    }

    if (mode === 'cjs') {
        if (!defaultEntrypoint) {
            // throw new Error(`Package "${spec}" has no main export`)
            return { fileName: 'index.js', moduleType: 'cjs' }
        }

        return { fileName: defaultEntrypoint, moduleType: 'cjs' }
    }

    if (pkg.module) {
        return { fileName: pkg.module, moduleType: 'esm' }
    }

    if (!pkg.main) {
        throw new Error(`Package "${spec}" has no module or main export`)
    }

    return { fileName: pkg.main, moduleType: defaultModuleType }
}

// From https://github.com/nodejs/node/blob/a00f0b1f0a53d47ae334b67e4566f27be02d7d8a/lib/internal/modules/esm/resolve.js#L346
const invalidSegmentRegEx = /(^|\\|\/)((\.|%2e)(\.|%2e)?|(n|%6e|%4e)(o|%6f|%4f)(d|%64|%44)(e|%65|%45)(_|%5f)(m|%6d|%4d)(o|%6f|%4f)(d|%64|%44)(u|%75|%55)(l|%6c|%4c)(e|%65|%45)(s|%73|%53))?(\\|\/|$)/i
const invalidPackageNameRegEx = /^\.|%|\\/

const packageCache = new Map<string, { name: string; directory: string, entry: PackageEntry } | undefined>()
const packageLockJsonCache = new Map<string, { directory: string; data: PackageLockV3 } | undefined>()


export interface PackageLockV3Entry {
    name?: string
    version?: string
    resolved?: string
    integrity?: string
    link?: boolean
    dev?: boolean
    bin?: Record<string, string>
    optional?: boolean
    engines?: Record<string, string> // e.g. { "node": ">=14.17" }
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
}

export interface PackageLockV3 {
    name: string
    lockfileVersion: 3
    packages: Record<string, PackageLockV3Entry>
}

// This function doesn't look at parent directories unlike `getPackageJson`
export async function getPackageLockJson(fs: Fs, dir: string): Promise< { directory: string; data: PackageLockV3 } | undefined> {
    if (packageLockJsonCache.has(dir)) {
        return packageLockJsonCache.get(dir)!
    }

    let result: { directory: string; data: PackageLockV3 } | undefined
    try {
        const data = JSON.parse(await fs.readFile(path.resolve(dir, 'package-lock.json'), 'utf-8')) as PackageLockV3
        result = { directory: dir, data }
    } catch (e) {
        throwIfNotFileNotFoundError(e)

        // Best effort look up
        const dotPackageLock = path.resolve(dir, 'node_modules', '.package-lock.json')
        const contents = await fs.readFile(dotPackageLock, 'utf-8').catch(throwIfNotFileNotFoundError)

        if (contents !== undefined) {
            const data = JSON.parse(contents) as PackageLockV3
            result = { directory: dir, data }
        }
    } finally {
        packageLockJsonCache.set(dir, result)
    }

    return result
}

export async function getNearestPackageLock(fs: Fs, dir: string): Promise< { directory: string; data: PackageLockV3 }> {
    let currentDir = dir
    while (true) {
        const result = await getPackageLockJson(fs, currentDir)
        if (result) {
            return result
        }

        const nextDir = path.dirname(currentDir)
        if (nextDir === currentDir) {
            break
        }

        currentDir = nextDir
    }

    throw new Error(`Unable to find a package lock file starting from: ${dir}`)
}

function splitAt(str: string, pos: number): [string, string] {
    return [str.slice(0, pos), str.slice(pos + 1)]
}

interface SpecifierComponents {
    readonly scheme?: string
    readonly scope?: string // authority
    readonly name: string
    readonly export?: string
}

export function getSpecifierComponents(specifier: string): SpecifierComponents {
    const schemeIndex = specifier.indexOf(':')
    if (schemeIndex !== -1) {
        const [scheme, remainder] = splitAt(specifier, schemeIndex)
        const components = getSpecifierComponents(remainder)
        if (components.scheme) {
            throw new Error(`Malformed module specifier: only one colon (:) is allowed: ${specifier}`)
        }

        return { scheme, ...components }
    }

    const isScoped = specifier.startsWith('@')
    if (isScoped) {
        const [scope, spec, ...rest] = specifier.split('/')

        return {
            scope,
            name: `${scope}/${spec}`,
            export: rest.length > 0 ? rest.join('/') : undefined,
        }
    }

    const [spec, ...rest] = specifier.split('/')

    return {
        name: spec,
        export: rest.length > 0 ? rest.join('/') : undefined,
    }
}

// https://docs.npmjs.com/policies/crawlers
// https://github.com/npm/concurrent-couch-follower
// https://skimdb.npmjs.com/registry

// Have to use CouchbaseDB to sync w/ the npm registry

interface ResolvedDependency {
    name: string
    version: string
    peers: Record<string, ConstraintGroup['id']>
    dependencies: Record<string, ConstraintGroup['id']>
}

interface ConstraintGroup {
    readonly id: number
    readonly name: string
    readonly constraint: VersionConstraint
    readonly parents?: ConstraintGroup[]
}

export type ResolvePatternResult = { name: string, version: VersionConstraint }

function isTag(version: string) {
    return !!version.match(/^[A-Za-z]/)
}

export interface PackageRepository {
    listVersions(name: string): Promise<string[]> | string[]
    getDependencies(name: string, version: string): Promise<Record<string, string> | undefined>
    resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> | ResolvePatternResult
    getPeerDependencies?(name: string, version: string): Promise<Record<string, string> | undefined>

    getPackageJson(name: string, version: string): Promise<PublishedPackageJson>
}

async function extractPackage(tarball: Buffer, dest: string, requirePkgJson = true) {
    const fs = getFs()
    const files = extractTarball(tarball)
    const pkgFiles = files
        .filter(f => !!f.path.match(/[\\\/]?package\.json$/))
        .sort((a, b) => a.path.length - b.path.length)

    const root = pkgFiles[0]?.path
    if (!root && requirePkgJson) {
        throw new Error(`Failed to find package.json in tarball`)
    }

    const prefix = root ? root.replace(/package\.json$/, '') : undefined
    await Promise.all(files.map(async f => {
        if (prefix && !f.path.startsWith(prefix)) {
            return
        }

        const trimmedPath = prefix ? f.path.slice(prefix.length) : f.path
        const absPath = path.resolve(dest, trimmedPath)
        if (f.contents.length > 0 && !f.path.endsWith('/')) {
            await fs.writeFile(absPath, f.contents, { mode: f.mode })
        } else {
            // FIXME: set dir permissions
            // This is a directory
        }
    }))
}

type ImportMap2 = ImportMap<SourceInfo>

const getNpmPackageRepo = memoize(() => {
    return createNpmPackageRepo()
})

const getMultiRegistryNpmClient = keyedMemoize(createMultiRegistryClient)

interface NpmRepoOptions {
    shouldPrefetch?: boolean
    system?: { cpu: string; os: string }
}

interface NpmPackageRepository extends PackageRepository {
    close: () => Promise<void>
    maybeDownloadPackage: (url: string, dest: string) => Promise<{ cached: boolean; dest: string }>
}

function createNpmPackageRepo(opt?: NpmRepoOptions): NpmPackageRepository {
    const client = createNpmRegistryClient()
    const manifestRepo = createManifestRepo(client)
    const packagesDir = path.resolve(getUserSynapseDirectory(), 'packages')

    const { shouldPrefetch = true } = opt ?? {}

    const prefetched = new Set<string>()

    async function prefetchDeps(name: string, manifest: PackageManifest | OptimizedPackageManifest): Promise<void> {
        if (prefetched.has(name)) {
            return
        }

        prefetched.add(name)

        const tags = 'symbolTable' in manifest ? manifest.tags : manifest['dist-tags']
        const latest = tags?.['latest'] ?? Object.keys(manifest.versions).pop()!
        const deps = getRequired(await getPackageJson(name, latest), undefined, undefined, undefined, false) ?? {}
        for (const [k, v] of Object.entries(deps)) {
            const p = resolvePattern(k, v)
            if (p instanceof Promise) {
               return p.then(r => manifestRepo.getPackageManifest(r.name).then(m => prefetchDeps(r.name, m))).catch(e => {
                    if (e !== manifestRepo.cancelError) { throw new Error(`Failed to prefetch "${k}@${v}"`, { cause: e }) }
                })
            } else {
                return manifestRepo.getPackageManifest(p.name).then(m => prefetchDeps(p.name, m)).catch(e => {
                    if (e !== manifestRepo.cancelError) { throw new Error(`Failed to prefetch "${k}@${v}"`, { cause: e }) }
                })
            }
        }
    }

    async function getPackageJson(name: string, version: string) {
        const pkg = await manifestRepo.getPackageJson(name, version)

        return pkg
    }

    async function close() {
        await manifestRepo.close()
    }

    async function resolveTag(name: string, tag: string): Promise<VersionConstraint> {
        const tags = await manifestRepo.listTags(name)
        const v = tags?.[tag]
        if (!v) {
            throw new Error(`No version found matching tag "${tag}" for package: ${name}`)
        }
    
        return parseVersionConstraint(v)
    }

    async function listVersions(name: string) {
        return manifestRepo.listVersions(name)
    }

    async function getDependencies(name: string, version: string) {
        return getRequired(await getPackageJson(name, version))
    }

    async function getPeerDependencies(name: string, version: string) {
        const pkg = await getPackageJson(name, version)
        const peers: Record<string, string> = { ...pkg.peerDependencies }

        let isEmpty = true
        if (pkg.peerDependencies) {
            for (const [k, v] of Object.entries(pkg.peerDependencies)) {
                if (!isFileUrl(v) && !pkg.peerDependenciesMeta?.[k]?.optional) {
                    peers[k] = v
                    isEmpty = false
                }
            }
        }

        return !isEmpty ? peers : undefined
    }

    function _resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> | ResolvePatternResult {
        // "npm:string-width@^4.2.0"
        if (pattern.startsWith('npm:')) {
            const rem = pattern.slice(4)

            // "npm:@docusaurus/react-loadable@6.0.0"
            if (rem.startsWith('@')) {
                const [name, version = '*'] = rem.slice(1).split('@')

                return { name: `@${name}`, version: parseVersionConstraint(version) }
            }
    
            const [name, version = '*'] = rem.split('@')
    
            return { name, version: parseVersionConstraint(version) }
        }
    
        if (!isTag(pattern)) {
            return { name: spec, version: parseVersionConstraint(pattern) }
        }

        return resolveTag(spec, pattern).then(version => ({ name: spec, version }))    
    }

    function resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> | ResolvePatternResult {
        if (!shouldPrefetch) {
            return _resolvePattern(spec, pattern)
        }

        const res = _resolvePattern(spec, pattern)
        if (res instanceof Promise) {
            return res.then(resp => {
                manifestRepo.getPackageManifest(resp.name).then(m => prefetchDeps(resp.name, m).catch(e => getLogger().debug(`Failed to prefetch "${resp.name}"`, e)))

                return resp
            })
        }

        manifestRepo.getPackageManifest(res.name).then(m => prefetchDeps(res.name, m).catch(e => getLogger().debug(`Failed to prefetch "${res.name}"`, e)))
        return res
    }

    async function downloadPackage(url: string, dest: string) {
        const tarball = await client.downloadPackage(url)
        await extractPackage(tarball, dest)
    }

    const pending = new Map<string, Promise<{ cached: boolean; dest: string }>>()

    function maybeDownloadPackage(url: string, dest: string) {
        if (pending.has(dest)) {
            return pending.get(dest)!
        }

        const p = (async function () {
            // TODO: need to place a tmp file while we extract in case
            // we crash while extracting
            if (await getFs().fileExists(dest)) {
                return { cached: true, dest }
            }

            await downloadPackage(url, dest)

            return { cached: false, dest }
        })()

        pending.set(dest, p)

        return p
    }

    return { listVersions, getDependencies, getPeerDependencies, resolvePattern, getPackageJson, maybeDownloadPackage, close } 
}

function parseCspmRef(url: string) {
    const ident = url.slice(url.startsWith('cspm') ? 5 : 4)
    if (!ident.startsWith('#')) {
        throw new Error(`Public packages not implemented: ${ident}`)
    }

    return ident.slice(1)
}

function createFilePackageRepo(fs: Fs, workingDirectory: string): PackageRepository {
    const _getSnapshot = keyedMemoize((dir: string) => fs.readFile(path.resolve(dir, '.synapse', 'snapshot.json'), 'utf-8')
        .then(JSON.parse, throwIfNotFileNotFoundError) as Promise<Snapshot | undefined>
    )

    const _getPackageJson = keyedMemoize((dir: string) => {
        // const snapshot = await _getSnapshot(dir)
        // if (!snapshot) {
        //     return getPackageJson(fs, dir, false)
        // }

        // const store = await getDataRepository().getBuildFs(snapshot.storeHash)
        // if (store.index.files['package.json']) {
        //     return getDataRepository().readData(store.index.files['package.json'].hash).then(d => JSON.parse(Buffer.from(d).toString('utf-8')))
        // }

        return getPackageJson(fs, dir, false)
    })

    async function listVersions(name: string) {
        const pkgDir = path.resolve(workingDirectory, name)
        const pkg = await _getPackageJson(pkgDir)
        if (!pkg) {
            throw new Error(`No package found for path: ${name} [from ${workingDirectory}]`)
        }

        const version = pkg.data.version ?? '0.0.0' 

        return [version]
    }

    async function resolvePattern(spec: string, pattern: string): Promise<ResolvePatternResult> {
        const pkgDir = path.resolve(workingDirectory, pattern)
        const pkg = await _getPackageJson(pkgDir)
        if (!pkg) {
            throw new Error(`No package found for path: ${pattern} [from ${workingDirectory}]`)
        }

        return {
            name: pkg.data.name ?? spec,
            version: parseVersionConstraint(pkg.data.version ?? '*'),
        }
    }

    async function getDependencies(name: string, version: string) {
        const pkgDir = path.resolve(workingDirectory, name)
        const pkg = await _getPackageJson(pkgDir)
        if (!pkg) {
            throw new Error(`No package found for path: ${name} [from ${workingDirectory}]`)
        }

        return getRequired(pkg.data)
    }

    return { 
        listVersions, 
        resolvePattern, 
        getDependencies,
        getPackageJson: async (name, version) => {
            const pkgDir = path.resolve(workingDirectory, name)
            const pkg = await _getPackageJson(pkgDir) // TODO: use the compiled `package.json` if present
            if (!pkg) {
                throw new Error(`No package found for path: ${name} [from ${workingDirectory}]`)
            }

            const snapshot = await _getSnapshot(pkgDir)
            if (snapshot) {
                return {
                    ...pkg.data,
                    version,
                    dist: {
                        tarball: pkgDir,
                        integrity: snapshot.storeHash,
                        isSynapsePackage: true,
                    },
                }
            }

            const bt = await resolveProgramBuildTarget(pkgDir).catch(() => {})
            if (!bt) {
                return {
                    ...pkg.data,
                    version,
                    dist: { tarball: pkgDir, integrity: '' },
                }
            }


            const integrity = await getProgramHash(bt, getDataRepository(undefined, bt.buildDir))

            return {
                ...pkg.data,
                version,
                dist: {
                    tarball: pkgDir,
                    integrity: integrity ?? '',
                    isSynapsePackage: !!integrity,
                },
            }
        }
    }
}

function createSprRepoWrapper(
    fs: Fs,
    projectId: string,
    workingDirectory: string
): PackageRepository & { close: () => Promise<void> } {
    const manifestCacheDir = path.resolve(getGlobalCacheDirectory(), 'package-manifests')
    const sprCacheDir = path.resolve(manifestCacheDir, 'spr')
    const npmRepo = getNpmPackageRepo()
    const fileRepo = createFilePackageRepo(fs, workingDirectory)
    const toolRepo = createToolRepo()
    const githubRepo = createGitHubPackageRepo()
    const sprRepo = createSynapsePackageRepo()
    const pipelineDeps = getPipelineDeps()

    const _getTerraformPath = memoize(getTerraformPath)
    async function _getProviderVersions(name: string) {
        // Double reverse!
        return listProviderVersions(name, providerRegistryHostname, await _getTerraformPath()).then(x => x.reverse())
    }

    const workspacePackages = new Map<string, { version: VersionConstraint, location: string }>()

    const getPrivatePackageManifest = keyedMemoize(async function (name: string): Promise<any> {
        const l = path.resolve(sprCacheDir, name)

        try {
            return JSON.parse(await fs.readFile(l, 'utf-8'))
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            throw new Error(`SPR not implemented`)
        }
    })

    function maybeMatchProvider(name: string) {
        const prefixLen = name.startsWith('cspm:') ? 5 : 4
        const providerMatch = name.slice(prefixLen).match(/^_provider-([a-z\/]+):(.+)$/)
        if (providerMatch) {
            return { name: providerMatch[1], version: parseVersionConstraint(providerMatch[2]) }
        }
    }

    async function listVersions(name: string) {
        if (name.startsWith(toolPrefix)) {
            return toolRepo.listVersions(name.slice(toolPrefix.length))
        }

        if (name.startsWith(githubPrefix)) {
            return githubRepo.listVersions(name.slice(githubPrefix.length))
        }

        if (name.startsWith('file:')) {
            return fileRepo.listVersions(name.slice('file:'.length))
        }

        if (name.startsWith(providerPrefix)) {
            return _getProviderVersions(name.slice(providerPrefix.length))
        }

        if (name.startsWith(sprPrefix)) {
            return sprRepo.listVersions(name.slice(sprPrefix.length))
        }

        if (name.startsWith('cspm:')) {
            const manifest = await getPrivatePackageManifest(parseCspmRef(name))

            return Object.keys(manifest.versions)
        }

        return npmRepo.listVersions(name)
    }

    async function getPackageJson(name: string, version: string): Promise<PublishedPackageJson> {
        if (name.startsWith(toolPrefix)) {
            return toolRepo.getPackageJson(name.slice(toolPrefix.length), version)
        }

        if (name.startsWith(githubPrefix)) {
            return githubRepo.getPackageJson(name.slice(githubPrefix.length), version)
        }

        if (name.startsWith('file:')) {
            return fileRepo.getPackageJson(name.slice('file:'.length), version)
        }

        if (name.startsWith(providerPrefix)) {
            return {
                name: name.slice(providerPrefix.length).split('/').pop()!,
                version,
                dist: {
                    tarball: getProviderSource(name.slice(providerPrefix.length)),
                    integrity: version, // TODO: use hash
                },
            }
        }

        if (name.startsWith(sprPrefix)) {
            return sprRepo.getPackageJson(name.slice(sprPrefix.length), version)
        }

        if (name.startsWith('cspm:')) {
            const manifest = await getPrivatePackageManifest(parseCspmRef(name))
            const pkgJson = manifest.versions[version]

            return { 
                ...pkgJson,
                name: manifest.name,
                dist: {
                    tarball: manifest.name, // XXX
                    integrity: pkgJson.packageDataHash, // XXX
                } 
            }
        }

        return npmRepo.getPackageJson(name, version)
    }

    async function resolvePattern(spec: string, pattern: string) {
        if (spec.startsWith(toolPrefix)) {
            return toolRepo.resolvePattern(spec, pattern)
        }

        if (pattern.startsWith('file:')) {
            if (pattern.endsWith('.tgz')) {
                const location = path.resolve(workingDirectory, pattern.slice(5))
                const data = Buffer.from(await fs.readFile(location))
                const dest = path.resolve(getPackageCacheDirectory(), 'extracted', getHash(data))   

                if (!(await fs.fileExists(dest))) {
                    getLogger().log(`Extracting specifier "${spec}" to:`, dest)
                    await extractPackage(await gunzip(data), dest, false)
                }

                pattern = `file:${dest}`
            }

            const resolved = await fileRepo.resolvePattern(spec, pattern.slice(5))
            workspacePackages.set(resolved.name, { version: resolved.version, location: pattern.slice(5) })

            return { name: pattern, version: resolved.version }
        }

        if (pattern.startsWith('cspm:') || pattern.startsWith('spr:')) {
            const provider = maybeMatchProvider(pattern)
            if (provider) {
                return { name: `${providerPrefix}${provider.name}`, version: provider.version }
            }

            const name = parseCspmRef(pattern)
            if (!pipelineDeps?.[name]) {
                const override = await getPackageOverride(name)
                if (override) {
                    return { name: `file:${override}`, version: parseVersionConstraint('*') }
                }
            }

            if (pattern.startsWith(sprPrefix)) {
                const resolved = await sprRepo.resolvePattern(spec, pattern.slice(sprPrefix.length))

                return { name: `spr:${resolved.name}`, version: resolved.version }
            }

            return { name: pattern, version: parseVersionConstraint('*') }
        }

        // https://github.com/oven-sh/bun/issues/10889
        if (workspacePackages.has(spec)) {
            const resolved = workspacePackages.get(spec)!
            const parsed = parseVersionConstraint(pattern)
            if (isCompatible(resolved.version, parsed)) {
                return {
                    name: `file:${resolved.location}`,
                    version: parsed,
                }
            }
        }

        // FIXME: this detection is fragile
        if (pattern.startsWith(githubPrefix) || (pattern.includes('/') && !pattern.includes(':'))) {
            const trimmed = pattern.startsWith(githubPrefix) ? pattern.slice(githubPrefix.length) : pattern
            const resolved = await githubRepo.resolvePattern(spec, trimmed)

            return {
                name: pattern.startsWith(githubPrefix) ? pattern : `github:${pattern}`,
                version: resolved.version,
            }
        }
    
        return npmRepo.resolvePattern(spec, pattern)
    }

    async function getDependencies(name: string, version: string) {
        if (name.startsWith(toolPrefix)) {
            return toolRepo.getDependencies(name.slice(toolPrefix.length), version)
        }

        if (name.startsWith(githubPrefix)) {
            return githubRepo.getDependencies(name.slice(githubPrefix.length), version)
        }

        if (name.startsWith('file:')) {
            return fileRepo.getDependencies(name.slice('file:'.length), version)
        }

        if (name.startsWith(providerPrefix)) {
            return
        }

        if (name.startsWith(sprPrefix)) {
            return sprRepo.getDependencies(name.slice(sprPrefix.length), version)
        }

        if (name.startsWith('cspm:')) {
            const manifest = await getPrivatePackageManifest(parseCspmRef(name))
            const inst = manifest.versions[version]
            if (!inst) {
                throw new Error(`Version "${version}" not found for package: ${name}`)
            }

            return getRequired(inst.packageFile)
        }

        return npmRepo.getDependencies(name, version)
    }

    async function getPeerDependencies(name: string, version: string) {
        if (name.startsWith('file:')) {
            return fileRepo.getPeerDependencies?.(name.slice('file:'.length), version)
        }

        if (name.startsWith(githubPrefix)) {
            return // TODO
        }

        if (name.startsWith(providerPrefix)) {
            return
        }

        if (name.startsWith(toolPrefix)) {
            return 
        }

        if (name.startsWith(sprPrefix)) {
            return
        }

        if (name.startsWith('cspm:')) {
            // const manifest = await getPrivatePackageManifest(parseCspmRef(name))
            // const inst = manifest.versions[version]
            // if (!inst) {
            //     throw new Error(`Version "${version}" not found for package: ${name}`)
            // }

            // return getRequired(inst.packageFile)
            return undefined // TODO
        }

        return npmRepo.getPeerDependencies?.(name, version)
    }

    return { listVersions, getDependencies, resolvePattern, getPeerDependencies, getPackageJson, close: npmRepo.close }
}


interface ResolveDepsResult {
    readonly roots: Record<string, ConstraintGroup['id']>
    readonly installed: [ConstraintGroup, ResolvedDependency][]
}

export async function resolveDeps(deps: Record<string, string>, repo: PackageRepository): Promise<ResolveDepsResult> {
    interface Key {
        next(id: number): Key
        toString(): string
    }
    
    function createPosKey(): Key {
        const keys: Record<string, Key> = {}
    
        function inner(pos: number[], str = ''): Key {
            function next(id: number) {
                const nPos = [...pos, id].sort()
                const k = nPos.join('.')
               
                return keys[k] ??= inner(nPos, k)
            }
    
            function toString() {
                return str
            }
    
            return { next, toString }
        }
    
        return inner([])
    }
    
    
    type Element = [
        installed: [ConstraintGroup, ResolvedDependency][], 
        groups: ConstraintGroup[],
        key: Key,
        fScore: number,
    ]

    // TODO: this should break ties by picking the most recent element first
    const pq = createMinHeap<Element>((a, b) => a[3] - b[3])

    const _listVersions = keyedMemoize((spec: string) => repo.listVersions(spec))
    const _resolvePattern = keyedMemoize((spec: string, pattern: string) => repo.resolvePattern(spec, pattern))

    let groupCounter = 0
    const groups: ConstraintGroup[] = []
    const roots: Record<string, ConstraintGroup['id']> = {}

    const patterns = await Promise.all(Object.entries(deps).map(async ([k, v]) => [k, await _resolvePattern(k, v)] as const))
    for (const [k, { name, version }] of patterns) {
        const id = groupCounter++
        roots[k] = id
        groups.push({
            id,
            name,
            constraint: version,
        })
    }

    const scores = new Map<string, number>()
    pq.insert([[], groups, createPosKey(), 0])

    while (pq.length > 0) {
        const [installed, groups, key] = pq.extract()
        if (groups.length === 0) {
            return { roots, installed }
        }

        if (isCancelled()) {
            break
        }

        const g = groups.pop()!
        const nk = key.next(g.id)
        const nks = nk.toString()
        const s = scores.get(nks)
        if (s !== undefined && installed.length + 1 >= s) {
            continue
        }

        async function resolveGroup(k: string) {
            const ni = [...installed]
            const ng: ConstraintGroup[] = []
            const r: ResolvedDependency = {
                name: g.name,
                version: k,
                peers: {},
                dependencies: {},
            }

            async function resolve(spec: string, req: string, isPeer = false) {
                const patternResult = await _resolvePattern(spec, req)
                const name = patternResult.name
                const constraint = patternResult.version

                // If an already installed group exists and has a compatible constraint then 
                // we can use it directly without changing anything.
                const idx = ni.findIndex(x => x[0].name === name && isCompatible(x[0].constraint, constraint, true))
                if (idx !== -1) {
                    const ig = ni[idx]
                    const isBefore = compareConstraints(ig[0].constraint, constraint) < 0

                    if (isBefore) {
                        ni[idx] = [
                            { 
                                ...ig[0],
                                constraint,
                                parents: [g, ...(ig[0].parents ?? [])], 
                            },
                            ig[1]
                        ]
                    } else {
                        ni[idx] = [
                            { ...ig[0], parents: [g, ...(ig[0].parents ?? [])], },
                            ig[1]
                        ]
                    }

                    if (!isPeer) {
                        r.dependencies[spec] = ig[0].id
                    } else {
                        r.peers[spec] = ig[0].id
                    }

                    return true
                }

                const eg = groups.find(x => x.name === name && isCompatible(x.constraint, constraint, true))
                if (eg) {
                    const isBefore = compareConstraints(eg.constraint, constraint) <= 0
                    ng.push({
                        id: eg.id,
                        name: eg.name,
                        constraint: isBefore ? constraint : eg.constraint,
                        parents: [g, ...(eg.parents ?? [])],
                    })
                } else {
                    if (isPeer) {
                        const isRootPeer = !g.parents || g.parents.length === 0
                        const parents = isRootPeer 
                            ? Object.values(roots).map(r => groups[r]) 
                            : g.parents

                        for (const p of parents) {
                            const alreadyInstalled = ni.findIndex(x => x[0] === p && (x[0].name === spec || x[1].peers[spec]))
                            if (alreadyInstalled !== -1) {
                                const z = ni[alreadyInstalled]
                                if (z[0].name === spec && !isCompatible(z[0].constraint, constraint)) {
                                    return false
                                }
                                // TODO: implement this case
                                // } else if (z[1].peers[spec] && !isCompatible(z[1].peers[spec], constraint)) {

                                // }
                            }    
                        }
                    }

                    ng.push({
                        id: groupCounter++,
                        name,
                        constraint,
                        parents: [g]
                    })
                }

                if (!isPeer) {
                    r.dependencies[spec] = ng[ng.length - 1].id
                } else {
                    r.peers[spec] = ng[ng.length - 1].id
                }

                return true
            }

            // Peer dependencies must be installed as a unit. They cannot be installed directly under the dependent.
            // If they cannot be installed as a peer then the current dependency cannot be installed at all.
            const peers = await repo.getPeerDependencies?.(g.name, k)
            if (peers) {
                for (const [k2, v2] of Object.entries(peers)) {
                    const didInstall = await resolve(k2, v2, true)
                    if (!didInstall) {
                        getLogger().warn(`Failed to install peer dependency: ${k2}`)
                        return
                    }
                }
            }

            const required = await repo.getDependencies(g.name, k)
            if (required) {
                for (const [k2, v2] of Object.entries(required)) {
                    await resolve(k2, v2)
                }
            }

            ni.push([g, r])

            // const nk = key.next(g.id)
            // const nks = nk.toString()
            // const s = scores.get(nks)
            const ns = ni.length
           // if (s === undefined || ns < s) {
                // Add any missing groups in
                const ids = new Set(ng.map(x => x.id))
                for (const x of groups) {
                    if (!ids.has(x.id)) {
                        ng.push(x)
                    }
                }

                scores.set(nks, ns)
                pq.insert([ni, ng, nk, ns + ng.length])

                // For UI
                getLogger().emitInstallEvent({ phase: 'resolve', resolveCount: ns } as any)

                return true
            //}
        }

        // Fast path
        if (isExact(g.constraint)) {
            continue
        }

        const versions = await _listVersions(g.name)

        let didAdd = false
        for (let i = versions.length - 1; i >= 0; i--) {
            const k = versions[i]
            const c = parseVersionConstraint(k)
            if (!isCompatible(g.constraint, c)) {
                continue
            }

            // Assumes `versions` is sorted
            if (await resolveGroup(k)) {
                didAdd = true
                break
            }
        }
        if (!didAdd) {
            throw new Error(`No version found matching pattern "${g.constraint.source}" for package "${g.name}"`)
        }
    }

    throw new Error(`Failed to resolve packages`)
}

// For every spec/constraint pair:
// 1. Search for an already installed version by walking up the tree
// 2. If none are found, install it in the first open slot (top-down)
//   a) This may be immediately under the dependent
// 3. Repeat for every new install

interface RootTree {
    subtrees: Record<string, Tree> // spec -> tree
    parent?: undefined
}

interface Tree {
    id: number
    name: string
    constraint: VersionConstraint
    subtrees: Record<string, Tree> // spec -> tree
    parent: Tree | RootTree
    resolved?: ResolvedDependency
    ghosts: Record<string, Tree>
}

interface RebuiltTree extends Tree {
    subtrees: Record<string, RebuiltTree> // spec -> tree
    parent: RebuiltTree | RebuiltRootTree
    dependencies: Record<string, RebuiltTree>
    peers: Record<string, RebuiltTree>
    resolved: ResolvedDependency
}

interface RebuiltRootTree extends RootTree {
    ids: number
    subtrees: Record<string, RebuiltTree>
}

function rebuildTree(data: ReturnType<typeof flattenImportMap>): RebuiltRootTree | undefined {
    const root: RebuiltRootTree = { ids: 0, subtrees: {} }
    const r = data.mappings['#root']

    const trees: Record<string, RebuiltTree> = {}
    function getTree(id: string): RebuiltTree {
        const s = data.sources[id]
        if (!s || s.type !== 'package') {
            throw new Error(`No source found`)
        }

        const deps = (s as any).data.dependencies ?? {}
        const peers = (s as any).data.peers ?? {}

        function getName(data: PackageInfo) {
            switch (data.type) {
                case 'file':
                    return `file:${data.name}`
                case 'spr':
                    return `${sprPrefix}${data.name}`
                case 'synapse-provider':
                    return `${providerPrefix}${data.name}`
            }

            return data.name
        }

        const t: RebuiltTree = {
            id: root.ids++,
            name: s.data.name,
            parent: root,
            subtrees: {},
            constraint: parseVersionConstraint(s.data.version),
            dependencies: {},
            peers: {},
            ghosts: {},
            resolved: {
                name: getName(s.data),
                version: s.data.version,
                dependencies: deps,
                peers: peers,
            },
        }
        trees[t.id] = t

        for (const [k, v] of Object.entries(data.mappings[id] ?? {})) {
            t.subtrees[k] = getTree(v)
            t.subtrees[k].parent = t
        }

        return t
    }

    try {
        for (const [k, v] of Object.entries(r)) {
            root.subtrees[k] = getTree(v)
        }

        for (const t of Object.values(trees)) {
            const ancestors: (RebuiltTree | RebuiltRootTree)[] = []
            let p = t
            while (p) {
                ancestors.push(p)
                p = p.parent as any
            }

            const deps = t.resolved.dependencies
            for (const [k, v] of Object.entries(deps)) {
                for (const p of ancestors) {
                    if (p.subtrees[k]) {
                        t.dependencies[k] = p.subtrees[k]
                        break
                    }
                }
            }

            const peers = t.resolved.peers
            for (const [k, v] of Object.entries(peers)) {
                for (const p of ancestors) {
                    if (p.subtrees[k]) {
                        t.peers[k] = p.subtrees[k]
                        break
                    }
                }
            }
        }
    } catch(e) {
        getLogger().warn(`Failed to load existing installation data`, e)
        return
    }

    return root
}

interface ResolveDepsOptions {
    readonly oldData?: ReturnType<typeof flattenImportMap>
    readonly validateResult?: boolean // default: false
}

// The result is already hoisted
export async function resolveDepsGreedy(deps: Record<string, string>, repo: PackageRepository, opt?: ResolveDepsOptions) {
    const _listVersions = keyedMemoize((spec: string) => repo.listVersions(spec))
    const _resolvePattern = keyedMemoize((spec: string, pattern: string) => repo.resolvePattern(spec, pattern))
    const oldTreeRoot = opt?.oldData ? rebuildTree(opt.oldData) : undefined

    let ids = 0
    const root: RootTree = { subtrees: {} }
    const oldTreeMap = new Map<Tree, RebuiltTree>()
    const patterns = Object.fromEntries(await Promise.all(Object.entries(deps).map(async ([k, v]) => [k, await _resolvePattern(k, v)] as const)))
    for (const [k, v] of Object.entries(deps)) {
        root.subtrees[k] = {
            id: ids++,
            name: patterns[k].name,
            constraint: patterns[k].version,
            subtrees: {},
            parent: root,
            ghosts: {},
        }

        if (oldTreeRoot && oldTreeRoot.subtrees[k]) {
            oldTreeMap.set(root.subtrees[k], oldTreeRoot.subtrees[k])
        }
    }

    function findAlreadyInstalledTree(tree: Tree | RootTree, name: string, spec: string, constraint: VersionConstraint, ignoreTag?: boolean): Tree | false | undefined {
        const g = !isRootTree(tree) ? tree.ghosts[spec] : undefined
        const x = g ?? tree.subtrees[spec]
        if (!x) {
            if (!tree.parent) {
                return
            }
    
            return findAlreadyInstalledTree(tree.parent, name, spec, constraint, ignoreTag)
        }


        if (name !== x.name || !isCompatible(x.constraint, constraint, ignoreTag)) {
            return false
        }

        // The initial constraint was compatible but we chose an incompatible version
        // This happens when a dependency has a stricter requirement than a previously
        // added dependency. Example:
        //
        // semver - ^7.5.4 -> resolved 7.6.0
        // ...some other dep
        //   semver - 7.5.4 -> must resolve to 7.5.4
        // 
        if (x.resolved && !isCompatible(parseVersionConstraint(x.resolved.version), constraint, ignoreTag)) {
            return false
        }

        const isBefore = compareConstraints(x.constraint, constraint) < 0
        if (isBefore) {
            x.constraint = constraint
        }

        return x
    }

    let lastClone: RootTree['subtrees'] | undefined
    class ResolveFailure extends Error {}

    // Used for debugging
    const originalParents = new Map<Tree, Tree>()
    function getOriginalParent(tree: Tree) {
        return originalParents.get(tree) ?? tree.parent
    }

    function printTree(tree: RootTree | Tree) {
        if (isRootTree(tree)) {
            printLine(`<root>`)
        } else if (tree.resolved) {
            printLine(`${tree.resolved.name}@${tree.resolved.version}`)
        } else {
            printLine(`${tree.name}@${tree.constraint.source} <unresolved>`)
        }
    }

    function printTrace(tree: Tree) {
        let t: Tree | RootTree = tree
        while (true) {
            if (isRootTree(t)) {
                break
            }

            printTree(t)
            t = getOriginalParent(t)
        }
    }

    async function resolveTree(tree: Tree, oldTree = oldTreeMap.get(tree), isTopFrame = false) {
        if (tree.resolved) {
            return
        }

        const pendingTrees: Tree[] = []
        async function resolve(parent: Tree, spec: string, req: string, isPeer = false) {
            const patternResult = await _resolvePattern(spec, req)
            const name = patternResult.name
            const constraint = patternResult.version

            return _resolve(parent, name, spec, constraint, isPeer)
        }

        function _resolve(parent: Tree, name: string, spec: string, constraint: VersionConstraint, isPeer = false) {
            const inst = findAlreadyInstalledTree(parent, name, spec, constraint, isPeer)
            if (inst) {
                let z = parent
                const y = inst.parent
                while (z !== y && z !== root as any) {
                    (z as any).ghosts[spec] = inst
                    z = z.parent as any
                } 
                if (isPeer) {
                    parent.resolved!.peers[spec] = inst.id
                } else {
                    parent.resolved!.dependencies[spec] = inst.id
                }

                return inst
            }

            // We have to add a new tree
            const t: Tree = {
                id: ids++,
                name,
                parent, // Temporary assignment
                constraint,
                subtrees: {},
                ghosts: {},
            }
            originalParents.set(t, parent)

            // Not very accurate but it works
            getLogger().emitInstallEvent({ phase: 'resolve', resolveCount: ids } as any)

            // Peer deps cannot be installed as immediate deps unless it's the root
            const ancestors: (Tree | RootTree)[] = []
            let q: Tree | RootTree | undefined = isPeer ? parent.parent : parent
            while (q) {
                if (q.subtrees[spec] || (!isRootTree(q) && q.ghosts[spec])) break
                ancestors.unshift(q)
                q = q.parent
            }

            const firstOpenTree = ancestors[0]
            if (!firstOpenTree) {
                // for (const [k, v] of Object.entries(root.subtrees)) {
                //     printTree(v)
                // }
                // if (root.subtrees[spec]) {
                //     printTrace(root.subtrees[spec])
                // }
                // printTrace(parent)
                if (isPeer) {
                    getLogger().warn(`Invalid peer dependency: ${spec}`)
                    //printLine(colorize('gray', `    invalid peer dependency: ${spec}`))
                    const resolved = root.subtrees[spec]
                    parent.resolved!.peers[spec] = resolved.id

                    return resolved
                }

                throw new ResolveFailure(`Failed to resolve spec ${spec} ${constraint.source} [peer: ${isPeer}]`)
            }

            for (const x of ancestors) {
                if (!isRootTree(x)) {
                    x.ghosts[spec] = t
                }
            }

            t.parent = firstOpenTree
            firstOpenTree.subtrees[spec] = t
            pendingTrees.push(t)

            if (oldTree) {
                const tt = isPeer ? oldTree.peers[spec] : oldTree.dependencies[spec]
                if (tt) {
                    oldTreeMap.set(t, tt)
                }
            }

            if (isPeer) {
                parent.resolved!.peers[spec] = t.id
            } else {
                parent.resolved!.dependencies[spec] = t.id
            }

            return t
        }

        async function resolveDeps(name: string, version: string) {
            const peers = await repo.getPeerDependencies?.(name, version)
            if (peers) {
                for (const [k2, v2] of Object.entries(peers)) {
                    await resolve(tree, k2, v2, true)
                }
            }

            const required = await repo.getDependencies(name, version)
            if (required) {
                for (const [k2, v2] of Object.entries(required)) {
                    const p = await _resolvePattern(k2, v2)
                    _resolve(tree, p.name, k2, p.version)
                }
            }

            // Not using `Promise.all` here because it makes the result non-deterministic
            for (const t of pendingTrees) {
                await resolveTree(t)
            }
        }

        async function resolveOldTree(oldTree: RebuiltTree) {
            tree.resolved = {
                name: tree.name,
                version: oldTree.resolved.version,
                peers: {},
                dependencies: {},
            }

            for (const [k, v] of Object.entries(oldTree.peers)) {
                _resolve(tree, v.resolved.name, k, parseVersionConstraint(v.resolved.version), true)
            }

            for (const [k, v] of Object.entries(oldTree.dependencies)) {
                _resolve(tree, v.resolved.name, k, parseVersionConstraint(v.resolved.version))
            }

            for (const t of pendingTrees) {
                await resolveTree(t)
            }
        }

        function getClone() {
            if (lastClone) {
                for (const [k, v] of Object.entries(root.subtrees)) {
                    lastClone[k] = v
                }
                return lastClone
            }

            return lastClone = { ...root.subtrees }
        }

        // Really dumb/simple way to backtrack
        let clonedSubtrees = isTopFrame ? getClone() : undefined

        function unwind(e: unknown) {
            if (!(e instanceof ResolveFailure)) {
                throw e
            }

            delete (root as any).subtrees
            ;(root as any).subtrees = clonedSubtrees
            lastClone = undefined
            clonedSubtrees = getClone()
        }

        if (oldTree && isCompatible(parseVersionConstraint(oldTree.resolved.version), tree.constraint)) {
            if (!isTopFrame) {
                return resolveOldTree(oldTree)
            }

            try {
                return await resolveOldTree(oldTree)
            } catch (e) {
                unwind(e)
            }
        }

        // Fast path, allows us to skip `listVersions`
        if (isExact(tree.constraint)) {
            const v = tree.constraint.label 
                ? `${tree.constraint.pattern}-${tree.constraint.label}` 
                : tree.constraint.pattern

            tree.resolved = {
                name: tree.name,
                version: v,
                peers: {},
                dependencies: {},
            }

            await resolveDeps(tree.name, v)

            return
        }

        const versions = await _listVersions(tree.name)

        for (let i = versions.length - 1; i >= 0; i--) {
            const k = versions[i]
            const c = parseVersionConstraint(k)
            if (!isCompatible(tree.constraint, c)) {
                continue
            }

            tree.resolved = {
                name: tree.name,
                version: k,
                peers: {},
                dependencies: {},
            }

            // Assumes `versions` is sorted
            await resolveDeps(tree.name, k)
            break
        }

        if (!tree.resolved) {
            throw new ResolveFailure(`Failed to resolve dependency ${tree.name}@${tree.constraint.source}`)
        }
    }

    const v = Object.values(root.subtrees)
    for (const t of v) {
        await resolveTree(t, undefined, !!oldTreeRoot)
    }

    if (opt?.validateResult) {
        try {
            await validateTree(root, repo)    
        } catch (e) {
            await (repo as any).close?.()
            throw e
        }
    }

    return root
}

export function printTree(tree: Tree | RootTree, depth = 0, spec?: string) {
    if (isRootTree(tree)) {
        for (const [k, v] of Object.entries(tree.subtrees)) {
            printTree(v, depth, k)
        }
    } else {
        printLine(`${'  '.repeat(depth)}${spec ?? tree.name} - ${tree.resolved!.version}`)
        for (const [k, v] of Object.entries(tree.subtrees)) {
            printTree(v, depth + 1, k)
        }
    }
}

function isRootTree(tree: Tree | RootTree): tree is RootTree {
    return !tree.parent
}

function findTree(tree: Tree | RootTree, spec: string) {
    const match = tree.subtrees[spec]
    if (match) return match
    if (tree.parent) return findTree(tree.parent, spec)
}

async function validateTree(tree: Tree | RootTree, repo: PackageRepository, stack: [spec: string, parent: Tree | RootTree][] = []) {
    function fail(message: string): never {
        for (const [spec, parent] of stack) {
            const name = isRootTree(parent) 
                ? '[root]' 
                : `${parent.name}@${parent.resolved?.version ?? parent.constraint.source}`

            printLine(`${name} -> ${spec}`)
        }

        throw new Error(message)
    }

    if (!isRootTree(tree)) {
        if (!tree.resolved) {
            fail(`Unresolved tree: ${tree.name}@${tree.constraint.source}`)
        }

        if (tree.parent !== stack[stack.length - 1][1]) {
            printLine(`   ${(tree.parent as any).name} ${(tree.parent as any).id}`)
            fail(`Bad parent ${tree.name}@${tree.constraint.source}`)
        }

        async function validateDep(parentTree: Tree & { resolved: ResolvedDependency }, k: string, v: string, isPeer = false) {
            const t = findTree(tree, k)
            if (!t) fail(`No dependency found: ${k}@${v}`)
            if (!t.resolved) fail(`Unresolved dependency: ${k}@${v}`)

            const p = await repo.resolvePattern(k, v)
            if (!isCompatible(parseVersionConstraint(t.resolved.version), p.version, isPeer)) {
                fail(`Matched dependency ${t.resolved.name}@${t.resolved.version} with incompatible constraint ${v} from ${parentTree.resolved.name}@${parentTree.resolved.version}`)
            }

            if (isPeer && t === tree) {
                fail(`Matched invalid peer dependency ${t.resolved.name}@${t.resolved.version} from ${parentTree.resolved.name}@${parentTree.resolved.version}`)
            }
        }

        const pkg = await repo.getPackageJson(tree.resolved.name, tree.resolved.version)
        const required = getRequired(pkg, false)
        if (required) {
            for (const [k, v] of Object.entries(required)) {
                await validateDep(tree as any, k, v)
            }
        }

        if (pkg.peerDependencies) {
            const meta = pkg.peerDependenciesMeta ?? {}
            for (const [k, v] of Object.entries(pkg.peerDependencies)) {
                const isOptional = meta[k]?.optional
                if (isOptional) continue

                await validateDep(tree as any, k, v, true)
            }
        }
    }

    for (const [k, v] of Object.entries(tree.subtrees)) {
        await validateTree(v, repo, [...stack, [k, tree]])
    }
}


export function showManifest(m: TerraformPackageManifest, maxDepth = 0, dedupe = false) {
    const seen = new Set<string>()

    function render(spec: string, id: string, depth = 0) {
        if (depth > maxDepth) {
            return
        }

        const pkg = m.packages[id]
        const key = `${spec}-${pkg.version}-${depth}`
        if (seen.has(key)) {
            return
        }

        if (dedupe) {
            seen.add(key)
        }

        // TODO: show when `spec` !== `pkg.name`
        getLogger().log(`${'  '.repeat(depth)}${depth ? '|__ ' : ''}${spec} - ${pkg.version} `)
        const deps = m.dependencies[id]
        if (deps) {
            for (const [k, v] of Object.entries(deps)) {
                render(k, `${v.package}`, depth + 1)
            }
        }
    }

    for (const [k, v] of Object.entries(m.roots)) {
        render(k, `${v.package}`)
    }
}

export async function testResolveDeps(target: string, cmp?: string) {
    const pkg = JSON.parse(await getFs().readFile(target, 'utf-8'))
    const previousInstallation = await getInstallationCached(getProgramFs())
    const repo = createSprRepoWrapper(getFs(), getBuildTargetOrThrow().projectId, pkg.directory)
    const result = await resolveDepsGreedy({ ...pkg.dependencies, ...pkg.devDependencies }, repo, {
        oldData: previousInstallation?.importMap,
    })

    const manifest = await toPackageManifestFromTree(repo, result)
    await repo.close()

    return manifest
}

function getNameAndScheme(name: string) {
    const parts = name.split(':')
    if (parts.length === 1) {
        return { name: parts[0] }
    }

    const scheme = parts[0]
    const actualName = parts.slice(1).join(':')

    return {
        scheme,
        name: actualName,
    }
}

export async function getSynapseTarballs(deps: string[]) {
    const fs = getFs()
    const repo = createSprRepoWrapper(fs, getBuildTargetOrThrow().projectId, getWorkingDir())
    const specs = Object.fromEntries(deps.map(d => [d, `spr:#${d}`]))
    const result = await resolveDepsGreedy(specs, repo)
    const manifest = await toPackageManifestFromTree(repo, result)

    const promises: Promise<[k: string, v: Buffer]>[] = []
    for (const [k, v] of Object.entries(manifest.roots)) {
        const info = manifest.packages[v.package]
        if (info.type !== 'spr') {
            throw new Error(`"${k}" is not a Synapse package: ${info.type}`)
        }

        promises.push(downloadSynapsePackageTarball(info).then(b => [k, b]))
    }

    return Object.fromEntries(await Promise.all(promises))
}

export async function installModules(dir: string, deps: Record<string, string>, target?: Partial<QualifiedBuildTarget>) {
    const fs = getFs()
    const repo = createSprRepoWrapper(fs, getBuildTargetOrThrow().projectId, dir)
    const result = await resolveDepsGreedy(deps, repo)

    const manifest = await toPackageManifestFromTree(repo, result)
    const installer = createPackageInstaller({ fs, target })
    const mapping = await installer.getImportMap(manifest)

    const res = await writeToNodeModules(fs, mapping, dir, undefined, { mode: 'all', hoist: false })
    await repo.close()

    return { res, mapping }
}

type NodeModulesInstallMode = 'none' | 'types' | 'all' // Changes what we write to `node_modules`

interface WriteToNodeModulesOptions {
    mode?: NodeModulesInstallMode
    hoist?: boolean
    verifyBin?: boolean
    hideInternalTypes?: boolean
}

const isProd = process.env.SYNAPSE_ENV === 'production'

export async function installFromSnapshot(
    dir: string, 
    dest: string,
    pkgLocation: string, 
    snapshot: Snapshot & { store: ReadonlyBuildFs },
    shouldUpdateDependents = false
) {
    const fs = getFs()

    await fs.deleteFile(dest).catch(throwIfNotFileNotFoundError)
    const p: Promise<void>[] = []
    for (const [k, v] of Object.entries(snapshot.store.index.files)) {
        if (k.endsWith('.ts') || k === 'package.json') {
            p.push(getDataRepository().readData(v.hash).then(d => fs.writeFile(path.resolve(dest, k), d)))
        }
    }

    if (!snapshot.store.index.files['package.json']) {
        p.push(fs.writeFile(path.resolve(dest, 'package.json'), await fs.readFile(path.resolve(pkgLocation, 'package.json'))))
    }

    await Promise.all(p)

    if (shouldUpdateDependents) {
        const data = await getDependentsData()
        const obj = data[pkgLocation] ??= {}
        updateDependent(obj, dir, dest, snapshot.storeHash)

        await setDependentsData(data)
    }
}

const postinstallAllowlist = new Set(['puppeteer'])

export async function writeToNodeModules(
    fs: Fs, 
    mapping: ImportMap2, 
    installDir: string,
    oldPackages?: Record<string, NpmPackageInfo>,
    opt: WriteToNodeModulesOptions = {},
): Promise<{ packages: Record<string, NpmPackageInfo>; installed: string[]; removed: string[]; changed: string[] }> {
    const { 
        hoist = false, 
        mode = 'types', 
        verifyBin = false,
        hideInternalTypes = isProd,
    } = opt

    const rootDir = getRootDirectory()
    const typesOnly = mode === 'types'
    const ensureDir = keyedMemoize((dir: string) => require('node:fs/promises').mkdir(dir, { recursive: true }).catch((e: any) => {
        if ((e as any).code !== 'EEXIST') {
            throw e
        }
    }))

    const packages: Record<string, NpmPackageInfo> = {}

    //const missing = new Set<string>()
    const noop = new Set<string>()
    const needsClean = new Set<string>()
    const needsInstall: Record<string, { dir: string; spec: string; pkgLocation: string; info?: PackageInfo }> = {}
    const removed = oldPackages ? new Set<string>(Object.keys(oldPackages)) : undefined

    async function verifyBinDir() {
        const p: Promise<unknown>[] = []
        for (const [k, v] of Object.entries(packages)) {
            const pkg = v.packageFile
            const bin = pkg.bin
            if (!bin) continue

            const tools = typeof bin === 'string' ? [[pkg.name, bin] as const] : Object.entries(bin)
            const dest = path.resolve(installDir, k)
            const dir = path.dirname(path.dirname(dest))
            async function checkOrInstallBin(k: string, v: string) {
                const d = path.resolve(dir, 'node_modules', '.bin', k)
                if (await getFs().fileExists(d)) {
                    return
                }

                return installBin(fs, path.resolve(dest, v), k, dir)
            }

            p.push(Promise.all(tools.map(([k, v]) => checkOrInstallBin(k, v).catch(e => {
                getLogger().warn(`Failed to install bin "${k}" from package: ${path.relative(installDir, dest)}`, e)
            }))))
        }
        await Promise.all(p)
    }

    function visit2(m: ImportMap2, dir: string) {
        const nodeModules = path.resolve(dir, 'node_modules')

        async function visitInner(k: string, v: ImportMap2[string]) {
            if (v.source?.type === 'artifact') {
                return
            }

            const pkgInfo = v.source?.data
            const dest = path.resolve(nodeModules, k)
            const directory = path.relative(installDir, dest)
            const oldEntry = oldPackages?.[directory]
            const p = v.mapping ? visit2(v.mapping, dest) : undefined

            if (oldEntry) {
                removed?.delete(directory)
            }

            if (await fs.fileExists(dest)) {
                if (!oldEntry || oldEntry.integrity !== pkgInfo?.resolved?.integrity) {
                    needsClean.add(directory)
                    needsInstall[directory] = { dir, spec: k, pkgLocation: v.location, info: pkgInfo }
                } else {
                    packages[directory] = oldEntry 
                }
            } else {
                // if (oldEntry) {
                //     missing.add(directory)
                // }
                needsInstall[directory] = { dir, spec: k, pkgLocation: v.location, info: pkgInfo }
            }

            return p
        }

        const promises: Promise<void>[] = []
        for (const [k, v] of Object.entries(m)) {
            promises.push(visitInner(k, v))
        }

        return Promise.all(promises).then(() => {})
    }

    const rootDeps = new Set(Object.keys(mapping)) // This assumes the mapping hasn't already been hoisted
    const hoisted = hoist ? hoistImportMap(mapping) : mapping

    // First step - figure out what needs to be done
    if (await getFs().fileExists(path.resolve(installDir, 'node_modules'))) {
        await visit2(hoisted, installDir)
    } else {
        function visit2(m: ImportMap2, dir: string) {
            const nodeModules = path.resolve(dir, 'node_modules')
    
            function visitInner(k: string, v: ImportMap2[string]) {
                if (v.source?.type === 'artifact') {
                    return
                }
        
                const pkgInfo = v.source?.data
                const dest = path.resolve(nodeModules, k)
                const directory = path.relative(installDir, dest)
    
                if (v.mapping) {
                    visit2(v.mapping, dest)
                }
    
                needsInstall[directory] = { dir, spec: k, pkgLocation: v.location, info: pkgInfo }    
            }
    
            for (const [k, v] of Object.entries(m)) {
                visitInner(k, v)
            }    
        }
        visit2(hoisted, installDir)
    }

    if (verifyBin) {
        await verifyBinDir()
    } 

    // Second step - install
    const promises: Record<string, Promise<void>> = {}
    const sorted = Object.entries(needsInstall).sort((a, b) => strcmp(a[0], b[0])) // shortest first
    for (const [k, v] of sorted) {
        getLogger().log(`installing ${v.info?.name}@${v.info?.version} [${k}]`)
        promises[k] = install(v.dir, v.spec, v.pkgLocation, v.info).then(x => {
            packages[k] = x
        })
    }

    await Promise.all(Object.values(promises))

    async function copyFile(src: string, dest: string) {
        const fs2 = require('node:fs/promises') as typeof import('node:fs/promises')

        return fs2.copyFile(src, dest).catch(async e => {
            throwIfNotFileNotFoundError(e)
            await fs2.mkdir(path.dirname(dest), { recursive: true })

            return fs2.copyFile(src, dest)
        })
    }

    // Used when you want to preserve existing files
    async function copyIntoDir(src: string, dest: string) {
        const fs2 = require('node:fs/promises') as typeof import('node:fs/promises')

        const files = await getFs().readDirectory(src)
        const p: Promise<void>[] = []
        for (const f of files) {
            if (f.type === 'directory') {
                p.push(fastCopyDir(path.resolve(src, f.name), path.resolve(dest, f.name)))
            } else {
                p.push(fs2.copyFile(path.resolve(src, f.name), path.resolve(dest, f.name)))
            }
        }

        await Promise.all(p)
    }

    async function install(dir: string, spec: string, pkgLocation: string, pkgInfo?: PackageInfo) {
        const dest = path.resolve(dir, 'node_modules', spec)
        const directory = path.relative(installDir, dest)

        if (pkgInfo?.type === 'synapse-tool') {
            const bin = pkgInfo.bin
            if (bin) {
                getLogger().debug(`Installing bin from package "${directory}"`)
                const tools = typeof bin === 'string' ? [[pkgInfo?.name, bin]] : Object.entries(bin)
                await Promise.all(tools.map(([k, v]) => installBin(fs, path.resolve(pkgLocation, v), k, dir).catch(e => {
                    getLogger().warn(`Failed to install bin "${k}" from package: ${directory}`, e)
                })))
            }

            return {
                name: pkgInfo?.name,
                version: pkgInfo?.version,
                resolved: pkgInfo?.resolved?.url,
                integrity: pkgInfo?.resolved?.integrity,
                directory: pkgLocation,
                specifier: spec,
                isSynapsePackage: pkgInfo?.resolved?.isSynapsePackage,
                packageFile: { name: pkgInfo?.name ?? '' },
            }
        }

        if (pkgInfo?.type === 'synapse-provider') {
            noop.add(directory)

            if (mode !== 'none' && pkgInfo?.name && rootDeps.has(spec)) {
                const installer = getDefaultPackageInstaller()
                await installer.installProviderTypes(dir, { [pkgInfo.name]: pkgLocation })
            }

            return {
                name: pkgInfo?.name,
                version: pkgInfo?.version,
                resolved: pkgInfo?.resolved?.url,
                integrity: pkgInfo?.resolved?.integrity,
                directory: pkgLocation,
                specifier: spec,
                isSynapsePackage: pkgInfo?.resolved?.isSynapsePackage,
                packageFile: { name: pkgInfo?.name ?? '' },
            }    
        }

        let hasSnapshot = false
        if (pkgInfo?.type !== 'npm') { // TODO: add a check to `package.json` ?
            const snapshot = pkgInfo?.resolved?.isSynapsePackage
                ? await getSnapshot(pkgLocation) 
                : await tryLoadSnapshot(pkgLocation)

            hasSnapshot = !!snapshot

            if (snapshot?.moduleManifest) {
                const declarations = toTypeDeclarations(rootDir, snapshot.moduleManifest, hideInternalTypes)
                getLogger().debug(`Installing types from package "${directory}": ${Object.keys(declarations.packages)}`)
                const installed = await installTypes(fs, dir, declarations)
                for (const [k, v] of Object.entries(installed)) {
                    packages[path.relative(dir, k)] = v
                }
            }
            
            if (pkgInfo?.type === 'file') {
                if (snapshot?.store) {
                    const selfPath = getSelfPath()
                    const selfDir = selfPath ? path.dirname(path.dirname(selfPath)) : undefined
                    // const updateDependents = selfDir ? !pkgLocation.startsWith(selfDir) : false
                    const updateDependents = false
                    await installFromSnapshot(installDir, path.resolve(dir, 'node_modules', spec), pkgLocation, snapshot as Snapshot & { store: ReadonlyBuildFs }, updateDependents)
                } else {
                    const link = () => fs.link(pkgLocation, dest, { symbolic: true, typeHint: 'dir' })
                    await link().catch(async e => {
                        if ((e as any).code !== 'EEXIST') {
                            throw e
                        }
    
                        // The symlink can get corrupted. This probably happened here. Try again.
                        getLogger().warn(`Removing possibly broken symlink:`, dest, (e as any).code)
                        await fs.deleteFile(dest)
                        await link()
                    })
                }
            }

            if (snapshot?.store && pkgInfo?.type === 'spr') {
                const repo = getDataRepository()
                const promises: Promise<void>[] = []
                for (const [k, v] of Object.entries(snapshot.store.index.files)) {
                    if (k.endsWith('.d.ts')) {
                        promises.push(repo.readData(v.hash).then(d => fs.writeFile(path.resolve(dest, k), d)))
                    }
                }

                promises.push(
                    getFs().deleteFile(path.resolve(dest, '.synapse')).catch(throwIfNotFileNotFoundError),
                    getFs().deleteFile(path.resolve(dest, 'package.json')).catch(throwIfNotFileNotFoundError),
                )

                await Promise.all(promises)
                await copyIntoDir(pkgLocation, dest)
            }
        }

        const oldEntry = oldPackages?.[directory]?.packageFile
        const pkg = oldEntry ?? (await getPackageJson(fs, pkgLocation, false))?.data
        if (!pkg) {
            throw new Error(`No package.json found: "${dest}"`)
        }

        function hasNodeModules() {
            if (!needsClean.has(directory)) {
                return false
            }

            if (pkg!.bundledDependencies) {
                return true
            }

            return getFs().fileExists(path.resolve(dest, 'node_modules'))
        }

        if (mode !== 'none' && pkgInfo?.type !== 'file' && !hasSnapshot) {
            // We need to wait for the parent copy to finish when using fast copy
            const parentDir = path.relative(installDir, dir)
            await promises[parentDir]

            const _hasNodeModules = await hasNodeModules()

            if (needsClean.has(directory)) {
                if (_hasNodeModules) {
                    await cleanDir(dest, ['node_modules'])
                } else {
                    await removeDir(dest).catch(throwIfNotFileNotFoundError)
                }
            }

            if (!_hasNodeModules && (spec.startsWith('@') || dir !== installDir)) {
                await ensureDir(path.dirname(dest))
            }
            
            try {
                if (_hasNodeModules) {
                    await copyIntoDir(pkgLocation, dest)
                } else {
                    await fastCopyDir(pkgLocation, dest)
                }
            } catch (e) {
                if ((e as any).code !== 'EEXIST') {
                    if (!(e as any).message.includes('is not available in the current runtime')) {
                        getLogger().debug(`Fast copy failed on "${directory}"`, e)
                    }

                    // Copy `package.json` to help TypeScript
                    const patterns = typesOnly ? ['**/*.d.ts', 'package.json'] : ['**']
                    // A decent chunk of a time is just spent globbing
                    // We also aren't streaming the discovered files
                    const files = await glob(fs, pkgLocation, patterns) 
                    await Promise.all(files.map(async f => copyFile(f, path.resolve(dest, path.relative(pkgLocation, f)))))
                }
            }

            // TODO: UI needs to show that we're running install scripts
            if (pkgInfo?.name && pkgInfo?.type === 'npm' && pkg.scripts?.postinstall && postinstallAllowlist.has(pkgInfo.name)) {
                getLogger().log(`Running postinstall for pkg "${pkgInfo.name}" in:`, directory)
                await execCommand(pkg.scripts.postinstall, {
                    cwd: dest,
                })
            }
        }

        const bin = pkg.bin
        if (bin && mode !== 'none') {
            getLogger().debug(`Installing bin from package "${path.relative(installDir, dest)}"`)
            const tools = typeof bin === 'string' ? [[pkg.name, bin]] : Object.entries(bin)
            await Promise.all(tools.map(([k, v]) => installBin(fs, path.resolve(dest, v), k, dir).catch(e => {
                getLogger().warn(`Failed to install bin "${k}" from package: ${path.relative(installDir, dest)}`, e)
            })))
        }

        return {
            name: pkg.name,
            version: pkgInfo?.version,
            resolved: pkgInfo?.resolved?.url,
            integrity: pkgInfo?.resolved?.integrity,
            directory: pkgInfo?.type !== 'file' ? directory : pkgLocation,
            packageFile: oldEntry ?? prunePkgJson(pkg),
            specifier: spec,
            isSynapsePackage: pkgInfo?.resolved?.isSynapsePackage,
            hasSnapshot,
        }    
    }

    return { 
        packages, 
        installed: Object.keys(needsInstall).filter(x => !needsClean.has(x) && !noop.has(x)), 
        removed: removed ? [...removed] : [], 
        changed: [...needsClean].filter(x => x in packages),
    }
}

async function toPackageManifestFromTree(repo: PackageRepository, tree: { subtrees: Record<string, Tree> }, oldData?: ReturnType<typeof flattenImportMap>): Promise<TerraformPackageManifest> {
    const roots: Record<string, { package: number; versionConstraint: string }> = {}
    const packages = new Map<PackageInfo, number>()
    const dependencies: Record<string, Record<string, { package: number; versionConstraint: string }>> = {}

    function getPackageId(info: PackageInfo) {
        if (!packages.has(info)) {
            packages.set(info, packages.size)
        }

        return packages.get(info)!
    }

    const oldPackages = new Map<string, PackageInfo>()
    if (oldData) {
        for (const v of Object.values(oldData.sources)) {
            if (v?.type !== 'package') continue
            const key = `${v.data.type}-${v.data.name}-${v.data.version}`
            if (!oldPackages.has(key)) {
                oldPackages.set(key, v.data)
            }
        }
    }

    const packageInfos = new Map<number, PackageInfo>()
    async function getPackageInfo(gid: number, resolved: ResolvedDependency) {
        if (packageInfos.has(gid)) {
            return packageInfos.get(gid)!
        }

        const isProvider = resolved.name.startsWith(providerPrefix)
        const isTool = resolved.name.startsWith(toolPrefix)
        const parsed = getNameAndScheme(resolved.name)
        const type: PackageInfo['type'] = parsed.scheme as any ?? 'npm'
        const key = `${type}-${resolved.name}-${resolved.version}`
        if (oldPackages.has(key)) {
            const info = oldPackages.get(key)!
            const copy = { ...info }
            packageInfos.set(gid, copy)

            return copy
        }

        const pkgJson = await repo.getPackageJson(resolved.name, resolved.version)

        const isSynapsePackage = !!pkgJson.synapse || pkgJson.dist.isSynapsePackage
        const info: PackageInfo = {
            type: type === 'npm' && pkgJson?.synapse ? 'spr' : type,
            name: (isProvider || isTool) ? pkgJson.name : parsed.name,
            version: resolved.version,
            os: pkgJson.os,
            cpu: pkgJson.cpu,
            bin: pkgJson.bin,
            resolved: { 
                integrity: pkgJson.dist.integrity, 
                url: pkgJson.dist.tarball,
                isStubPackage: pkgJson.dist.isStubPackage,
                isSynapsePackage,
            },
        }

        Object.assign(info, {
            dependencies: resolved.dependencies,
            peers: resolved.peers,
        })

        packageInfos.set(gid, info)

        return info
    }

    const constraints: Record<number, { package: number; versionConstraint: string }> = {}
    const trees: Record<number, Tree> = {}

    async function visit(tree: Tree) {
        if (!tree.resolved) {
            throw new Error(`Found unresolved tree: ${tree.name}`)
        }
        const info = await getPackageInfo(tree.id, tree.resolved)
        const id = getPackageId(info)
        constraints[tree.id] = { package: id, versionConstraint: tree.constraint.source! }
        trees[tree.id] = tree

        for (const [k, v] of Object.entries(tree.subtrees)) {
            await visit(v)
        }
    }

    for (const [k, v] of Object.entries(tree.subtrees)) {
        await visit(v)
    }

    for (const [k, v] of Object.entries(trees)) {
        const id = constraints[v.id].package
        const deps = dependencies[id] ??= {}
        for (const [k2, v2] of Object.entries(v.subtrees)) {
            deps[k2] = constraints[v2.id]
        }
    }

    for (const [spec, t] of Object.entries(tree.subtrees)) {
        roots[spec] = constraints[t.id]
    }

    return {
        roots,
        dependencies,
        packages: Object.fromEntries([...packages.entries()].map(i => i.reverse() as [number, PackageInfo])),
    }
}

async function toPackageManifest(repo: PackageRepository, resolved: ResolveDepsResult): Promise<TerraformPackageManifest> {
    const roots: Record<string, { package: number; versionConstraint: string }> = {}
    const packages = new Map<PackageInfo, number>()
    const dependencies: Record<string, Record<string, { package: number; versionConstraint: string }>> = {}

    function getPackageId(info: PackageInfo) {
        if (!packages.has(info)) {
            packages.set(info, packages.size)
        }

        return packages.get(info)!
    }

    const packageInfos = new Map<number, PackageInfo>()
    async function getPackageInfo(gid: number, resolved: ResolvedDependency) {
        if (packageInfos.has(gid)) {
            return packageInfos.get(gid)!
        }

        const pkgJson = await repo.getPackageJson(resolved.name, resolved.version)

        const isProvider = resolved.name.startsWith(providerPrefix)
        const isTool = resolved.name.startsWith(toolPrefix)

        const isSynapsePackage = !!pkgJson.synapse || pkgJson.dist.isSynapsePackage
        const parsed = getNameAndScheme(resolved.name)
        const type: PackageInfo['type'] = parsed.scheme as any ?? 'npm'
        const info: PackageInfo = {
            type,
            name: (isProvider || isTool) ? pkgJson.name : parsed.name,
            version: resolved.version,
            os: pkgJson.os,
            cpu: pkgJson.cpu,
            bin: pkgJson.bin,
            resolved: { 
                integrity: pkgJson.dist.integrity, 
                url: pkgJson.dist.tarball,
                isStubPackage: pkgJson.dist.isStubPackage,
                isSynapsePackage,
            },
        }
        packageInfos.set(gid, info)

        return info
    }

    const constraints: Record<number, { package: number; versionConstraint: string }> = {}
    for (const [k, v] of resolved.installed) {
        const info = await getPackageInfo(k.id, v)
        const id = getPackageId(info)
        constraints[k.id] = { package: id, versionConstraint: k.constraint.source! }
    }

    for (const [k, v] of resolved.installed) {
        const id = constraints[k.id].package
        for (const [k2, v2] of Object.entries(v.dependencies)) {
            const deps = dependencies[id] ??= {}
            deps[k2] = constraints[v2]
        }

        // TODO: peer deps at the root require creating a new root
        // Peers are added to all parent constraint groups
        for (const [k2, v2] of Object.entries(v.peers)) {
            // This is a peer dependency of a root dep, add it as a root dep
            if (!k.parents) {
                roots[k2] = constraints[v2]
                continue
            }

            for (const parentId of k.parents.map(p => p.id)) {
                const id = constraints[parentId].package
                const deps = dependencies[id] ??= {}
                deps[k2] = constraints[v2]
            }
        }
    }

    for (const [spec, id] of Object.entries(resolved.roots)) {
        roots[spec] = constraints[id]
    }

    return {
        roots,
        dependencies,
        packages: Object.fromEntries([...packages.entries()].map(i => i.reverse() as [number, PackageInfo])),
    }
}


export async function downloadDependency(dir: string, dep: PublishedPackageJson) {
    const client = createNpmRegistryClient()
    const key = `${dep.name}-${dep.version}`
    const dest = path.resolve(dir, key)
    if (await fs.access(dest, fs.constants.F_OK).then(() => true, () => false)) {
        getLogger().log(`Using cached package: ${key}`)

        return dest
    }

    const tarball = await client.downloadPackage(dep.dist.tarball)
    const files = extractTarball(tarball)
    for (const f of files) {
        const absPath = path.resolve(dest, f.path.replace(/^package\//, ''))
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await fs.writeFile(absPath, f.contents, { mode: f.mode })
    }

    return dest
}

export async function listInstall(dir = getWorkingDir(), programFs: Pick<Fs, 'readFile' | 'writeFile'> = getProgramFs()) {
    const installation = await getInstallationCached(programFs)
    const pkgs = installation?.packages
    if (!pkgs) {
        return
    }

    interface Pkg {
        readonly name: string
        readonly version: string
        readonly deps: Record<string, Pkg>
        readonly isRoot?: boolean
    }

    const trees: Record<string, Pkg> = {}
    function getTree(dir: string[]): Pkg {
        const p = dir.flatMap(x => ['node_modules', x]).join(path.sep)
        if (dir.length === 1) {
            return trees[dir[0]] ??= { 
                name: pkgs![p].name,
                version: pkgs![p].version!,
                deps: {},
                isRoot: true,
            }
        }

        const t = getTree(dir.slice(0, -1))
        return t.deps[dir.at(-1)!] ??= { 
            name: pkgs![p].name,
            version: pkgs![p].version!,
            deps: {},
        }
    }

    function printTree(pkg: Pkg, depth = 0) {
        printLine('  '.repeat(depth) + `${pkg.name}@${pkg.version}`)
        for (const p of Object.values(pkg.deps)) {
            printTree(p, depth + 1)
        }
    }

    const dirs = Object.keys(pkgs).map(x => x.split('node_modules').map(x => {
        if (x.endsWith(path.sep)) {
            x = x.slice(0, -1)
        }
        if (x.startsWith(path.sep)) {
            x = x.slice(1)
        }
        return x
    }).filter(x => !!x)).filter(x => x.length > 0).sort((a, b) => {
        const d = a.length - b.length
        if (d !== 0) {
            return d
        }

        return strcmp(a[a.length - 1], b[b.length - 1])
    })

    for (const d of dirs) {
        getTree(d)
    }

    for (const t of Object.values(trees)) {
        if (t.isRoot) {
            printTree(t)
        }
    }
}

export function importMapToManifest(importMap: NonNullable<InstallationAttributes['importMap']>) {
    const manifest: TerraformPackageManifest = { roots: {}, dependencies: {}, packages: {} }
    const root = importMap.mappings['#root']
    for (const [k, v] of Object.entries(root)) {
        const source = importMap.sources[v]
        if (source?.type !== 'package') continue

        manifest.roots[k] = { package: Number(v), versionConstraint: source.data.version }
    }

    for (const [k, v] of Object.entries(importMap.sources)) {
        if (v?.type !== 'package') continue
        manifest.packages[k] = v.data
    }

    for (const [k, v] of Object.entries(importMap.mappings)) {
        if (v === root) continue

        manifest.dependencies[k] = Object.fromEntries(Object.entries(v).map(([x, y]) => {
            const source = importMap!.sources[y]
            if (source?.type !== 'package') { throw new Error(`not implemented: ${source?.type}`) }

            return [x, { package: Number(y), versionConstraint: source.data.version }]
        }))
    }

    return manifest
}

export async function verifyInstall(dir = getWorkingDir(), programFs: Pick<Fs, 'readFile' | 'writeFile'> = getProgramFs()) {
    const installation = await getInstallationCached(programFs)
    if (!installation?.importMap) {
        return
    }

    const manifest = importMapToManifest(installation.importMap)

    const view = createInstallView()
    getLogger().emitInstallEvent({ phase: 'start' })

    const installer = getDefaultPackageInstaller()
    const mapping = await installer.getImportMap(manifest)

    getLogger().emitInstallEvent({ phase: 'write' })
    const mode = installation.mode
    const res = await writeToNodeModules(getFs(), mapping, dir, installation.packages, { mode, verifyBin: true })
    await commitPackages(programFs, res.packages, flattenImportMap(mapping, false), Date.now(), mode)

    const pkg = await getCurrentPkg()
    const deps = (pkg ? getRequired(pkg.data, undefined, true) : undefined) ?? {}

    const summary = await createSummary(deps, mapping, res, installation.importMap)

    getLogger().emitInstallEvent({ phase: 'end', summary } as any)
    view.summarize()

    await getNpmPackageRepo().close()
}


export async function downloadAndInstall(
    pkg: ResolvedPackage, 
    service: PackageInstaller = getDefaultPackageInstaller(),
    installAll = false
) {
    const fs = getFs()
    const programFs = getProgramFs()
    const previousInstallation = await getInstallationCached(programFs)

    const csDeps = pkg?.data.synapse?.dependencies ?? {}
    const providers = pkg?.data.synapse?.providers ?? {}
    const tools = pkg?.data.synapse?.devTools ?? {}

    const deps: Record<string, string> = {
        ...pkg.data.dependencies,
        ...pkg.data.devDependencies,
        ...Object.fromEntries(Object.entries(csDeps).map(x => [x[0], `spr:${x[1]}`])),
        ...Object.fromEntries(Object.entries(providers).map(x => createSynapseProviderRequirement(x[0], x[1]))),
        ...Object.fromEntries(Object.entries(tools).map(x => [`${toolPrefix}${x[0]}`, x[1]])),
        ...resolveWorkspaces(pkg.data.workspaces ?? [], pkg.directory)
    }

    getLogger().emitInstallEvent({ phase: 'start' })

    const repo = createSprRepoWrapper(fs, getBuildTargetOrThrow().projectId, pkg.directory)
    const doResolve = () => resolveDepsGreedy(deps, repo, { oldData: previousInstallation?.importMap, validateResult: false })
    const result = await runTask('install', 'resolve deps', doResolve, 10)

    const oldPackages = previousInstallation?.packages

    const createManifest = () => toPackageManifestFromTree(repo, result, previousInstallation?.importMap)

    const manifest = await runTask('install', 'create manifest', createManifest, 10)
    const getImportMap = () => service.getImportMap(manifest)

    const mapping = await runTask('install', 'get import map', getImportMap, 10)

    getLogger().emitInstallEvent({ phase: 'write' })

    const mode = 'all'
    const doWrite = () => writeToNodeModules(getFs(), mapping, pkg.directory, oldPackages, { 
        mode, 
        hoist: false,
        hideInternalTypes: pkg.data.synapse?.config?.exposeInternal ? false : undefined,
    })

    const res = await runTask('install', 'write node_modules', doWrite, 100)
    
    await commitPackages(programFs, res.packages, flattenImportMap(mapping, false), Date.now(), mode)

    getLogger().log('Creating summary')
    const summary = await createSummary(deps, mapping, res, previousInstallation?.importMap, repo)

    await repo.close()

    getLogger().emitInstallEvent({ phase: 'end', summary } as any)

    return result
}

async function createSummary(
    deps: Record<string, string>,
    mapping: ImportMap2,
    writeResult: Awaited<ReturnType<typeof writeToNodeModules>>,
    oldMapping?: ReturnType<typeof flattenImportMap>,
    repo: PackageRepository = getNpmPackageRepo()
): Promise<InstallSummary> {
    const current: Record<string, string> = {}
    const summary: InstallSummary = { rootDeps: {}, ...writeResult }

    const maybeNeedsLatestVersion = new Set<string>()

    for (const k of Object.keys(deps)) {
        const m = mapping[k]
        const s = m?.source
        if (!s || s.type !== 'package') continue

        if (s.data.type === 'npm') {
            maybeNeedsLatestVersion.add(k)
        }

        current[k] = s.data.version
        summary.rootDeps[k] = {
            name: s.data.name,
            installedVersion: s.data.version,
        }
    }

    async function getDepsForComparison() {
        const oldPkg = await getProgramFs().readFile('package.json', 'utf-8')
            .then(JSON.parse).catch(throwIfNotFileNotFoundError)
        
        if (!oldPkg) {
            return
        }

        return { ...oldPkg.dependencies, ...oldPkg.devDependencies }
    }

    const previousDeps: Record<string, string> = {}
    const root = oldMapping?.mappings['#root']
    if (root) {
        for (const [k, v] of Object.entries(await getDepsForComparison())) {
            const source = oldMapping.sources[root[k]]
            if (source?.type !== 'package') continue

            previousDeps[k] = source.data.version
            if (!(k in summary.rootDeps)) {
                summary.rootDeps[k] = {
                    name: source.data.name,
                    installedVersion: source.data.version,
                }
            }
        }
    }

    const diff = diffPkgDeps({ dependencies: current }, { dependencies: previousDeps })

    function shouldFetchLatestVersion(k: string) {
        return diff?.added?.[k] || diff?.changed?.[k]
    }

    for (const k of maybeNeedsLatestVersion) {
        if (shouldFetchLatestVersion(k)) {
            const latestVersion = (await repo.resolvePattern(k, 'latest')).version
            summary.rootDeps[k].latestVersion = latestVersion.source
        }
    }

    return { ...summary, diff }
}

export async function getLatestVersion(pkgName: string) {
    const repo = getNpmPackageRepo()
    const resolved = await repo.resolvePattern(pkgName, 'latest')

    return resolved.version
}

// TODO: lifecycle hooks
// https://github.com/oven-sh/bun/issues/9527

export function getDefaultPackageInstaller(fs = getFs()) {
    return createPackageInstaller({
        fs,
        getProviderGenerator: memoize(async () => {
            const tfPath = await getTerraformPath()

            return createProviderGenerator(fs, providerRegistryHostname, tfPath)
        })
    })
}

export async function maybeDownloadPackages(pkg: ResolvedPackage, installAll?: boolean, alwaysRun?: boolean) {
    const fs = getProgramFs()
    const doInstall = () => downloadAndInstall(pkg, getDefaultPackageInstaller(), installAll).then(res => {
        installations.delete(fs)
        return res
    })

    if (alwaysRun) {
        return doInstall()
    }

    const hasInstallation = await getInstallationCached(fs)
    if (!hasInstallation) {
        return doInstall()
    }

    await runIfPkgChanged(doInstall)
}

export async function downloadAndUpdatePackage(pkg: ResolvedPackage, deps: Record<string, string>, isDev?: boolean, installAll?: boolean, isRemove?: boolean) {
    const d = pkg.data as Mutable<typeof pkg.data>
    const currentDeps = isDev ? d.devDependencies ??= {} : d.dependencies ??= {}
    for (const [k, v] of Object.entries(deps)) {
        if (isRemove) {
            if (d.dependencies) {
                delete d.dependencies[k]
            }
            if (d.devDependencies) {
                delete d.devDependencies[k]
            }
        } else {
            currentDeps[k] =  v
            if (isDev && d.dependencies && k in d.dependencies) {
                delete d.dependencies[k]
            } else if (!isDev && d.devDependencies && k in d.devDependencies) {
                delete d.devDependencies[k]
            }
        }
    }

    const installer = getDefaultPackageInstaller()
    const result = await downloadAndInstall(pkg, installer, installAll)

    for (const [k, v] of Object.entries(result.subtrees)) {
        if (isRemove || !(k in deps)) continue

        if (deps[k].startsWith('file:')) {
            currentDeps[k] = deps[k]
            continue
        }

        const z = parseVersionConstraint(deps[k])
        if (isExact(z)) {
            currentDeps[k] = `${v.resolved!.version}`
        } else {
            currentDeps[k] = `^${v.resolved!.version}`
        }
    }

    await setCompiledPkgJson(pkg.data)
    await commitProgram()

    // We don't use `pkg.data` directly because it's the "compiled" (transformed) package.json
    const userPkg: Omit<PackageJson, 'name'> = await getPackageJson(getFs(), pkg.directory, false).then(r => r?.data) ?? {}
    for (const k of Object.keys(deps)) {
        const dep = pkg.data.dependencies?.[k]
        if (dep) {
            const userDeps = (userPkg as Mutable<PackageJson>).dependencies ??= {}
            userDeps[k] = dep
        } else {
            if ((userPkg as Mutable<PackageJson>).dependencies) {
                delete (userPkg as Mutable<PackageJson>).dependencies![k]
            }
        }
        const devDep = pkg.data.devDependencies?.[k]
        if (devDep) {
            const userDevDeps = (userPkg as Mutable<PackageJson>).devDependencies ??= {}
            userDevDeps[k] = devDep
        } else {
            if ((userPkg as Mutable<PackageJson>).devDependencies) {
                delete (userPkg as Mutable<PackageJson>).devDependencies![k]
            }
        }
    }

    await getFs().writeFile(
        path.resolve(pkg.directory, 'package.json'), 
        JSON.stringify(userPkg, undefined, 4)
    )
}


interface PackageTypeDeclarations {
    files: Record<string, string>
    roots: string[]
    symbols?: TypesFileData
    sourcemaps?: Record<string, string>
}

interface TypeDeclarations {
    readonly packages: Record<string, PackageTypeDeclarations>
}

// `rootDir` is used for sourcemaps
function toTypeDeclarations(rootDir: string, manifest: Record<string, Omit<ModuleBindingResult, 'id'>>, hideInternal?: boolean) {
    const packages: Record<string, PackageTypeDeclarations> = {}
    for (const [k, v] of Object.entries(manifest)) {
        if (!v.types) {
            continue
        }
        
        if (hideInternal && v.internal) {
            continue
        }

        const namespace = k.split(':')[0]
        const declarations: PackageTypeDeclarations = packages[namespace] ??= { files: {}, roots: [] }
        declarations.files[v.types.name] = v.types.text
        declarations.roots.push(v.types.name)

        if (v.types.sourcemap && !v.types.sourcemap.startsWith('pointer:')) {
            const maps = declarations.sourcemaps ??= {}
            const mapping = JSON.parse(v.types.sourcemap)
            mapping.sourceRoot = rootDir
            maps[`${v.types.name}.map`] = JSON.stringify(mapping) 
        }

        if (v.types.symbols) {
            const symbols = declarations.symbols ??= {}
            symbols[v.types.name] = v.types.symbols
        }

        // Not implemented
        // if (v.types.references) {
        //     for (const [k2, v2] of Object.entries(v.types.references)) {
        //         declarations.files[k2] = getFs().readFileSync(path.resolve(pkgDir, v2), 'utf-8')
        //     }
        // }
    }

    return { packages }
}

async function installTypePackage(fs: Fs, typesDir: string, name: string, types: PackageTypeDeclarations) {
    const dest = path.resolve(typesDir, name)

    async function writeAll(files: Record<string, string>) {
        await Promise.all(Object.entries(files).map(([k, v]) => fs.writeFile(path.resolve(dest, k), v)))
    }

    await writeAll(types.files)
    if (types.sourcemaps) {
        await writeAll(types.sourcemaps)
    }

    const indexText = types.roots.sort()
        .map(p => `/// <reference path="${p}" />`)
        .join('\n')

    const indexDest = path.resolve(dest, 'index.d.ts')
    await fs.writeFile(indexDest, indexText)

    const pkgJson = {
        name: `@types/${name}`,
        types: 'index.d.ts',
    }

    await fs.writeFile(
        path.resolve(dest, 'package.json'),
        JSON.stringify(pkgJson, undefined, 4)
    )

    return [dest, {
        name: pkgJson.name,
        directory: dest,
        packageFile: pkgJson,
        types: types.symbols,
    }] satisfies [string, NpmPackageInfo]
}

async function installTypes(fs: Fs, rootDir: string, types: TypeDeclarations): Promise<Record<string, NpmPackageInfo>> {
    const packages: Record<string, NpmPackageInfo> = {}
    const typesDir = path.resolve(rootDir, 'node_modules', '@types')
    for (const [k, v] of Object.entries(types.packages)) {
        const [dir, info] = await installTypePackage(fs, typesDir, k, v)
        packages[dir] = info
    }

    return packages
}

function checkOs(info: Pick<PackageInfo, 'os'>, platform = process.platform) {
    if (!info.os) {
        return
    }

    let isNegation = false
    for (const os of info.os) {
        if (os.startsWith('!')) {
            isNegation = true
            if (platform === os.slice(1)) {
                return false
            }
        } else if (platform === os) {
            return true
        }
    }

    return isNegation
}

function checkCpu(info: Pick<PackageInfo, 'cpu'>, arch = process.arch) {
    if (!info.cpu) {
        return
    }

    let isNegation = false
    for (const cpu of info.cpu) {
        if (cpu.startsWith('!')) {
            isNegation = true
            if (arch === cpu.slice(1)) {
                return false
            }
        } else if (arch === cpu) {
            return true
        }
    }

    return isNegation
}

async function createIndexFromLockFile(
    fs: Fs,
    packagesDir: string,
    workingDirectory: string,
    packageLock: Awaited<ReturnType<typeof getNearestPackageLock>>
) {    
    const packages: Record<string, NpmPackageInfo> = {}
    const indexed = new Set<string>()
    const pendingIndexes = new Map<string, Promise<[string, NpmPackageInfo] | undefined>>()

    async function indexPackageLock(packageLock: Awaited<ReturnType<typeof getNearestPackageLock>>) {
        if (indexed.has(packageLock.directory)) {
            return
        }

        indexed.add(packageLock.directory)

        const entries = await Promise.all(Object.keys(packageLock.data.packages).map(indexEntry))
        for (const [k, v] of entries.filter(isNonNullable)) {
            packages[k] = v
        }

        const copied = new Map<string, Promise<void>>()
        await Promise.all(entries.filter(isNonNullable).map(([k, v]) => copyPackage(k, v)))

        // Just so we don't redownload things we've already seen
        function copyPackage(absPath: string, info: NpmPackageInfo) {
            // Only copy packages from a registry
            if (!info.resolved || !info.integrity || !info.version) {
                return
            }

            const qualifiedName = `${info.name}-${info.version}`
            const dest = path.resolve(packagesDir, 'npm', qualifiedName)
            if (absPath === dest) {
                return
            }

            if (copied.has(dest)) {
                return copied.get(dest)
            }

            const packagePath = path.resolve(dest, 'package.json') 

            copied.set(dest, (async function () {
                if (await fs.fileExists(packagePath)) {
                    return
                }

                // TODO: delete anything that exists here?
                throw new Error(`cp not implemented for fs`)
                // await fs.cp(absPath, dest, { recursive: true })
            })())
        }

        function indexEntry(key: string): Promise<[string, NpmPackageInfo] | undefined> {
            const value = packageLock.data.packages[key]
            if (!value) {
                throw new Error(`Package lock entry not found: ${key}`)
            }

            const absPath = path.resolve(packageLock.directory, key)
            if (pendingIndexes.has(absPath)) {
                return pendingIndexes.get(absPath)!
            }

            const p = inner()
            pendingIndexes.set(absPath, p)

            return p
    
            async function inner(): Promise<[string, NpmPackageInfo] | undefined> {
                if (value.link) {
                    if (value.resolved === undefined) {
                        throw new Error(`Found unresolved linked package: ${key}`)
                    }

                    const entry = await indexEntry(value.resolved)
                    if (!entry) {
                        // throw new Error(`Missing package.json file: ${key}`) 
                        return
                    }

                    const lockFile = await getNearestPackageLock(fs, entry[0])
                    if (lockFile.directory !== packageLock.directory) {
                        await indexPackageLock(lockFile)
                    }
        
                    return [absPath, entry[1]]
                }
        
                const packageJson = await getPackageJson(fs, absPath, false)
                if (!packageJson) {
                    // throw new Error(`Missing package.json file: ${key}`)
                    return
                }

                return [absPath, {
                    name: packageJson.data.name,
                    directory: packageJson.directory,
                    packageFile: packageJson.data,
                    resolved: value.resolved,
                    integrity: value.integrity,
                    version: value.version ?? packageJson.data.version,
                }]
            }
        }
    }

    await indexPackageLock(packageLock)

    return Object.fromEntries(Object.entries(packages).map(([k, v]) => [path.relative(workingDirectory, k), v] as const))
}

export type PackageResolver = ReturnType<typeof createPackageResolver>
function createPackageResolver(
    fs: Fs & SyncFs,
    workingDirectory: string,
    moduleResolver: ModuleResolver,
    packages: Record<string, NpmPackageInfo>,
    packageIds?: Map<SourceInfo, string>
) {

    function findEntryFromPath(absPath: string): NpmPackageInfo | undefined {
        const entry = packages[absPath]
        if (entry) {
            return entry
        }

        const parentDir = path.dirname(absPath)
        if (parentDir !== absPath) {
            return findEntryFromPath(parentDir)
        }
    }

    function findEntryFromSpecifier(name: string, prefix: string): NpmPackageInfo | undefined {
        const suffix = path.join('node_modules', name)
        const target = path.resolve(prefix, suffix)
        const entry = packages[target]
        if (entry) {
            return entry
        }

        const parentDir = path.dirname(prefix)
        if (parentDir !== prefix) {
            return findEntryFromSpecifier(name, parentDir)
        }
    }


    function resolveExport(packageJson: { directory: string; data: Pick<PackageJson, 'name' | 'exports' | 'main' | 'module'> }, absPath: string) {
        const p = path.extname(absPath) === '' ? `${absPath}.js` : absPath
        const exports = packageJson?.data.exports

        if (typeof exports !== 'object' || !exports) {
            throw new Error(`Package is missing exports: ${packageJson?.directory}`)
        }

        const p2 = fs.fileExistsSync(path.resolve(absPath, 'index.js')) 
            ? path.resolve(absPath, 'index.js') 
            : p

        const inverted = Object.fromEntries(Object.entries(exports).map(x => x.reverse()).map(x => [path.resolve(packageJson.directory, x[0] as any), x[1]]))
        const res = inverted[p2]
        if (!res) {
            const mainPath = packageJson.data.main ? path.resolve(packageJson.directory, packageJson.data.main) : undefined
            if (mainPath === p2) {
                getLogger().log(`Using "main" export for package: ${packageJson.directory}`)

                return packageJson.data.name
            }

            throw new Error(`No module export found for module "${absPath}" in package ${packageJson.data.name}`)
        }

        return path.posix.join(packageJson.data.name, res as any)
    }

    const mapCache = new Map<NpmPackageInfo, PackageInfo>() // Used to maintain reference equality
    function mapEntry(entry: NpmPackageInfo): PackageInfo | undefined {
        if (!entry.version) {
            return
        }

        if (mapCache.has(entry)) {
            return mapCache.get(entry)
        }

        const type: PackageInfo['type'] = entry.packageFile.synapse ? 'spr' : 'npm'

        const result = {
            type,
            name: entry.name,
            version: entry.version,
            resolved: entry.resolved ? {
                url: entry.resolved,
                integrity: entry.integrity,
            } : undefined,
        }

        mapCache.set(entry, result)

        return result
    }

    const lookupCache = new Map<string, LookupResult>() // Used to maintain reference equality
    function reverseLookup(specifier: string, location?: string, virtualId?: string): LookupResult {
        const key = `${location}::${specifier}`
        if (lookupCache.has(key)) {
            return lookupCache.get(key)!
        }

        if (virtualId) {
            const sourceNode = moduleResolver.getSource(virtualId)
            const source = sourceNode?.source
            if (source && packageIds?.has(source)) {
                if (isRelativeSpecifier(specifier) && source.type === 'package') {
                    if (sourceNode.subpath) {
                        return {
                            module: `${source.data.name}/${sourceNode.subpath}`,
                            packageId: packageIds.get(source)!,
                        }
                    } else {
                        // Falls through
                    }
                } else {
                    return {
                        module: specifier,
                        packageId: packageIds.get(source)!,
                    }
                }
            }
        }

        const result = worker()
        lookupCache.set(key, result)

        return result

        function worker() {
            const lookupDir = location !== undefined
                ? path.dirname(path.resolve(workingDirectory, location)) 
                : workingDirectory

            if (specifier.startsWith(providerPrefix)) {
                const info = moduleResolver.resolveProvider(specifier, lookupDir)
                const packageInfo: PackageInfo = {
                    type: 'synapse-provider',
                    name: info.name,
                    version: info.version,
                    resolved: {
                        url: info.source,
                    }
                }

                return { 
                    module: specifier,
                    packageInfo,
                    location: info.location,
                }
            }

            if (isRelativeSpecifier(specifier) || path.isAbsolute(specifier)) {
                const resolved = path.resolve(lookupDir, specifier)
                const inversedGlobals = moduleResolver.getInverseGlobalsMap()
                if (inversedGlobals[resolved]) {
                    return { module: inversedGlobals[resolved] }
                }

                if (path.extname(resolved) === '' && inversedGlobals[resolved + '.js']) {
                    return { module: inversedGlobals[resolved + '.js'] }
                }

                const packageEntry = findEntryFromPath(resolved)
                if (packageEntry === undefined) {
                    if (specifier.endsWith('.zig')) {
                        // XXX: temporary hack to "unwrap" the module info
                        const stubName = `${resolved}.js`
                        const p = getProgramFs().getPointerSync(stubName)
                        const { hash, storeHash } = p.resolve()
                        const m = getDataRepository().getMetadata(hash, storeHash)
                        const d = Object.entries(m.dependencies!)[0]
                        
                        return { module: toDataPointer(`pointer:${d[0]}:${d[1][0]}`) }
                    }
                    throw new Error(`Missing package entry: ${resolved} [resolving ${specifier} from ${location}]`)
                }

                const module = resolveExport({ directory: packageEntry.directory, data: packageEntry.packageFile }, resolved)
                const packageInfo = mapEntry(packageEntry)
                if (!packageInfo) {
                    return { module }
                }

                return {
                    module,
                    packageInfo,
                    // dependencies: getDependencies(packageEntry),
                    // location: packageEntry.directory,
                }
            }

            // Bare specifier
            const components = getSpecifierComponents(specifier)
            const name = components.name
            const packageEntry = findEntryFromSpecifier(name, lookupDir)
            if (packageEntry === undefined) {
                // XXX: let it fail at bundle time
                // TODO: this reverse loopup logic is largely outdated and likely can be removed
                // We can attach any relevant serialization info during deserialization and/or resolution
                // return { module: specifier }

                throw new Error(`Missing package entry: ${name} from ${lookupDir}`)
            }

            const packageInfo = mapEntry(packageEntry)
            if (!packageInfo) {
                return { module: specifier }
            }

            return {
                module: specifier,
            }
        }
    }

    return { reverseLookup }
}

function getPackageDest(packagesDir: string, info: PackageInfo) {
    if (info.type === 'file') {
        const location = info.resolved?.url
        if (!location) {
            throw new Error(`Found file package without a resolved file path: ${info.name}`)
        }

        return location
    }

    if (info.type === 'synapse-provider') {
        const source = info.resolved!.url

        return path.resolve(packagesDir, info.type, source, `${info.name}-${info.version}`)
    }

    const type = info.type ?? 'npm'
    const qualifiedName = type === 'spr'
        ? `${info.name}/${info.resolved!.integrity!.slice('sha256:'.length, 'sha256:'.length + 10)}`
        : `${info.name}-${info.version}`
    
    return path.resolve(packagesDir, type, qualifiedName)
}

async function _getProviderGenerator() {
    const tfPath = await getTerraformPath()

    return createProviderGenerator(getFs(), providerRegistryHostname, tfPath)
}

interface PackageInstallerParams {
    readonly fs?: Fs & SyncFs
    readonly packagesDir?: string
    getProviderGenerator?: () => Promise<ReturnType<typeof createProviderGenerator>>
    target?: Partial<QualifiedBuildTarget>
    getGlobalsHash?: (spec: string) => string | undefined
}

type PackageInstaller = ReturnType<typeof createPackageInstaller>

export function createPackageInstaller(params?: PackageInstallerParams) {
    const {
        target,
        getGlobalsHash,
        fs = getFs(), 
        getProviderGenerator = memoize(_getProviderGenerator),
        packagesDir = getPackageCacheDirectory(),
    } = params ?? {}

    const resolvedTarget = resolveBuildTarget(target)
    const nodePlatform = toNodePlatform(resolvedTarget.os)
    const nodeArch = toNodeArch(resolvedTarget.arch)
 
    const repo = getDataRepository(fs)
    const packageDownloads = new Map<string, Promise<PackageInstallResult>>()
    const mappingCacheDir = path.resolve(getGlobalCacheDirectory(), 'import-maps')

    function ensurePackage(info: PackageInfo) {
        if (info.resolved?.isStubPackage) {
            return { type: 'skipped', reason: 'stub package' } as PackageInstallResult
        }

        const type = info.type ?? 'npm'
        const url = info.resolved?.url || (info.type === 'spr' ? info.resolved?.integrity : undefined)
        if (!url) {
            return { type: 'err', reason: new Error(`Missing download url`) } as const
        }

        if (checkOs(info, nodePlatform) === false || checkCpu(info, nodeArch) === false) {
            // getLogger().debug(`Skipping package "${info.name}" due to os or cpu requirements`)
            getLogger().emitPackageProgressEvent({ phase: 'download', package: url, done: true, skipped: true })

            return { type: 'skipped', reason: 'incompatible cpu or os' } as PackageInstallResult
        }

        const dest = getPackageDest(packagesDir, info)
        if (packageDownloads.has(dest)) {
            return packageDownloads.get(dest)!
        }

        const pending = (async function (): Promise<PackageInstallResult> {
            try {
                const res = await maybeDownload()
                getLogger().emitPackageProgressEvent({ phase: 'download', package: url, done: true, cached: res.cacheHit })

                return { type: 'ok', name: info.name, destination: res.dest, cacheHit: res.cacheHit }
            } catch (e) {
                return { type: 'err', reason: e as Error }
            }
        })()

        packageDownloads.set(dest, pending)

        return pending
    
        async function maybeDownload() {
            if (await fs.fileExists(dest)) {
                return { cacheHit: true, dest }
            }

            if (type !== 'file') {
                getLogger().debug(`Downloading package "${info.name}-${info.version}"`)
            }
    
            switch (type) {
                case 'jsr':
                case 'npm':
                    await downloadNpmPackage(info, dest)
                    break
                case 'github':
                    await downloadGitHubPackage(info, dest)
                    break
                case 'spr':
                    await downloadSynapsePackage(info, dest)
                    break
                case 'synapse-provider':
                    await downloadSynapseProvider(info, dest)
                    break
                case 'synapse-tool':
                    await downloadToolPackage(info, dest)
                    break
                case 'file':
                    break
            }

            return { cacheHit: false, dest }
        }
    }

    async function downloadToolPackage(info: PackageInfo, dest = getPackageDest(packagesDir, info)) {
        const url = info.resolved!.url!
        const data = await fetchData(url)
        await extractToDir(data, dest, path.extname(url) as any)

        return dest
    }

    async function downloadSynapseProvider(info: PackageInfo, dest = getPackageDest(packagesDir, info)) {
        const name = info.name
        const source = info.resolved!.url
        const version = info.version
    
        const generator = await getProviderGenerator()
        await generator.generate({ name, source, version }, dest)

        return dest
    }


    async function downloadNpmPackage(info: PackageInfo, dest: string) {
        await getNpmPackageRepo().maybeDownloadPackage(info.resolved!.url, dest)  
    }

      // TODO: return skipped/failed packages back to the caller
      async function resolvePackageManifest(manifest: TerraformPackageManifest): Promise<Record<number, FlatImportMap>> {
        const maps: Record<number, FlatImportMap> = {}

        getLogger().emitInstallEvent({
            phase: 'download',
            packages: Object.values(manifest.packages).map(v => v.resolved!.url),
        } as any)

        const packages = Object.fromEntries(
            await Promise.all(Object.entries(manifest.packages).map(async ([k, v]) => [k, await ensurePackage(v)] as const))
        )

        const failed = Object.entries(packages).filter(([k, v]) => v.type === 'err').map(([k, v]) => {
            const pkg = manifest.packages[k]

            return new Error(`Failed to install package "${pkg.name}-${pkg.version}"`, { 
                cause: (v as PackageInstallResult & { type: 'err' }).reason 
            })
        })

        if (failed.length > 0) {
            throw new AggregateError(failed)
        }

        manifest.dependencies[-1] = manifest.roots

        for (const [k, v] of Object.entries(manifest.dependencies)) {
            maps[k as any] ??= {}
            for (const [k2, v2] of Object.entries(v)) {
                const r = packages[v2.package]
                const pkg = manifest.packages[v2.package]

                if (!r) {
                    if (!pkg) {
                        throw new Error(`Missing package with id: ${v2.package}`)
                    }
                    throw new Error(`Missing package: ${pkg.name}-${pkg.version}`)
                }

                // Dead code, only done to appease CFA
                if (r.type === 'err') {
                    throw r.reason
                }

                if (r.type === 'skipped') {
                    getLogger().debug(`Skipped package "${pkg.name}-${pkg.version}":`, r.reason)
                    continue
                }

                maps[k as any][k2] = {
                    mapping: v2.package,
                    location: r.destination,
                    versionConstraint: v2.versionConstraint,
                    source: { type: 'package', data: pkg },
                }
            }
        }

        return maps
    }

    async function createImportMap(manifest: TerraformPackageManifest, maps?: Record<number, FlatImportMap>): Promise<ImportMap2> {
        const resolved = maps ?? await resolvePackageManifest(manifest)
        const trees = new Map<string, ImportMap2[string]>()
        const maps2: Record<number, ImportMap2> = {}
        function resolveTree(tree = manifest.roots, id = -1): ImportMap2 {
            const map: ImportMap2 = maps2[id] ??= {}
            const m = resolved[id]
            for (const [k, v] of Object.entries(tree)) {
                const o = m[k]
                if (!o) {
                    // This can happen when skipping a package download
                    continue
                }

                const pkgId = typeof v === 'number' ? v : v.package
                const key = String(pkgId)
                if (trees.has(key)) {
                    map[k] = trees.get(key)!
                } else {
                    map[k] = { 
                        location: o.location,
                        source: { type: 'package', data: manifest.packages[pkgId] },
                    }
                    trees.set(key, map[k])

                    const deps = manifest.dependencies[pkgId]
                    if (deps) {
                        (map[k] as Mutable<ImportMap2[string]>).mapping = resolveTree(deps, o.mapping)
                    }
                }
            }
            return map
        }
        return resolveTree()
    }

    const hasher = createHasher()
    const importMaps = new Map<string, Promise<ImportMap2>>()
    const getCachedMap = keyedMemoize(async (fileName: string) => JSON.parse(await fs.readFile(fileName, 'utf-8')))

    function getImportMap(deps: TerraformPackageManifest) {
        const key = hasher.hash(deps)
        if (importMaps.has(key)) {
            return importMaps.get(key)!
        }

        const dest = path.resolve(mappingCacheDir, key)
        const result = worker()
        importMaps.set(key, result)

        return result

        async function worker(): Promise<ImportMap2> {
            try {
                const data = await getCachedMap(dest)

                return createImportMap(deps, data)
            } catch (e) {
                if ((e as any).code !== 'ENOENT') {
                    getLogger().warn('Evicting invalid import from cache due to error:', e)

                    importMaps.delete(key)
                    getCachedMap.delete(dest)
                    await fs.deleteFile(dest)
                }

                const m = await resolvePackageManifest(deps)
                const [r] = await Promise.all([
                    createImportMap(deps, m),
                    fs.writeFile(dest, JSON.stringify(m))
                ])

                return r
            }
        }
    }

    async function resolveProviderConfig(provider: ProviderConfig): Promise<PackageInfo> {
        const generator = await getProviderGenerator()
        const resolved = await generator.resolveProvider(provider)

        return {
            name: resolved.name,
            type: 'synapse-provider',
            version: resolved.version,
            resolved: {
                url: resolved.source,
            }
        }
    }

    async function installSynapseProvider(provider: ProviderConfig) {
        const info = await resolveProviderConfig(provider)
        const res = await ensurePackage(info)
        if (res?.type !== 'ok') {
            throw res?.reason ?? new Error(`Failed to install provider "${provider.name}"`)
        }

        return {
            info,
            destination: res.destination,
        }
    }

    async function installProviderTypes(dir: string, pkgs: Record<string, string>) {
        getLogger().log(`Installing types`)
        const gen = await getProviderGenerator()
        await gen.installTypes(pkgs, dir)
    }

    async function downloadPackage(name: string, type: PackageInfo['type']) {
        if (type === 'synapse-provider') {
            await installSynapseProvider({ name })
        } else {
            throw new Error(`Not implemented: ${type}`)
        }
    }

    async function getPublishedMappings(name: string, pointer: string): Promise<[string, ImportMap2[string]] | undefined> {
        const { hash, storeHash } = getPointerComponents(pointer)
        if (!storeHash) {
            getLogger().warn(`Ignoring old published file: ${name}`)            
            return
        }

        return [`${pointerPrefix}${hash}`, {
            source: { type: 'artifact', data: { hash: hash, metadataHash: storeHash } },
            location: `${pointerPrefix}${storeHash}:${hash}`,
            locationType: 'module',
            mapping: await getPointerMappings(hash, storeHash),
        }]
    }
    
    async function getPublishedMappings2(name: string, pointer: string): Promise<[string, ImportMap2[string]] | undefined> {
        const { hash, storeHash } = getPointerComponents(pointer)
        if (!storeHash) {
            getLogger().warn(`Ignoring old published file: ${name}`)            
            return
        }

        const m = await getPointerMappings(hash, storeHash)
        if (!m) {
            return
        }

        return Object.entries(m)[0]
    }

    async function getPointerEntry(hash: string, storeHash: string): Promise<ImportMap<SourceInfo>[string]> {
        return {
            source: { type: 'artifact', data: { hash, metadataHash: storeHash } },
            location: `${pointerPrefix}${storeHash}:${hash}`,
            locationType: 'module',
            mapping: await getPointerMappings(hash, storeHash),
        }
    }

    const pointerMappings = new Map<string, ImportMap<SourceInfo> | undefined | Promise<ImportMap<SourceInfo> | undefined>>()
    function getPointerMappings(hash: string, storeHash: string) {
        const cacheKey = `${storeHash}:${hash}`
        if (pointerMappings.has(cacheKey)) {
            return pointerMappings.get(cacheKey)
        }

        const p = _getPointerMappings(hash, storeHash)
        pointerMappings.set(cacheKey, p)

        return p
    }

    async function _getPointerMappings(hash: string, storeHash: string) {
        const cacheKey = `${storeHash}:${hash}`
        const m = await repo.getMetadata2(hash, storeHash)
        if (!m.dependencies && !m.packageDependencies) {
            pointerMappings.set(cacheKey, undefined)

            return
        }

        const mapping: ImportMap2 = {}
        pointerMappings.set(cacheKey, mapping)

        const deps: Promise<[k: string, v: ImportMap<SourceInfo>[string]]>[] = []
        if (m.dependencies) {
            for (const [k, v] of Object.entries(m.dependencies)) {
                for (const k2 of v) {
                    const spec = `${pointerPrefix}${k2}`
                    if (!isNullHash(k)) {
                        deps.push(getPointerEntry(k2, k).then(m => [spec, m]))
                        continue
                    }

                    mapping[spec] = {
                        source: { type: 'artifact', data: { hash: k2, metadataHash: k }},
                        location: `${pointerPrefix}${k}:${k2}`,
                        locationType: 'module',
                    }
                }
            }
        }    

        const [pkgDeps, resolvedDeps] = await Promise.all([
            m.packageDependencies ? getImportMap(m.packageDependencies) : undefined,
            Promise.all(deps)
        ])

        if (pkgDeps) {
            for (const [k, v] of Object.entries(pkgDeps)) {
                mapping[k] = v
            }    
        }

        for (const [k, v] of resolvedDeps) {
            mapping[k] = v
        }

        return mapping
    }

    const hashedPointers = new Map<string, string>()
    function getHashWithDeps(target: string) {
        if (hashedPointers.has(target)) {
            return hashedPointers.get(target)!
        }

        const pointer = coerceToPointer(target)
        const { storeHash, hash } = pointer.resolve()
        if (isNullHash(storeHash)) {
            hashedPointers.set(target, hash)
            return hash
        }

        const key = `${storeHash}:${hash}`
        const ambient = repo.getMetadata(hash, storeHash).ambientDependencies
        const mappings = pointerMappings.get(key)
        if (!mappings && !ambient) {
            hashedPointers.set(target, hash)
            return hash
        }

        const deps: Record<string, string> = {}
        if (mappings) {
            for (const [k, v] of Object.entries(mappings)) {
                if (v.locationType === 'package') {
                    if (v.source?.type === 'package' && v.source.data.packageHash) {
                        deps[k] = v.source.data.packageHash
                    }
                } else {
                    deps[k] = getHashWithDeps(v.location)
                }
            }    
        }

        if (ambient && getGlobalsHash) {
            for (const d of ambient) {
                const r = getGlobalsHash(d)
                if (r) {
                    deps[d] = r
                }
            }
        }

        // TODO: we need to add something to certain objects (e.g. API route refs)
        // in order to track indirect dependencies
    
        const sorted = sortRecord(deps)
        const hashed = getHash(JSON.stringify(sorted) + hash)
        hashedPointers.set(target, hashed)
    
        return hashed
    }    

    return {
        getImportMap,
        installProviderTypes,
        downloadPackage,

        getPublishedMappings,
        getPublishedMappings2,
        getPointerMappings,
        getHashWithDeps,
    }
}

async function loadSynapsePackage(repo: DataRepository, pkgDir: string, snapshot: Snapshot, k: string, v: NpmPackageInfo) {
    // TODO: symlinked packages that are not overriden need to dump their `.d.ts` files

    const targets: TargetsFile = {}
    const published: Record<string, string> = {}
    const runtimeModules: Snapshot['moduleManifest'] = {}
    const pointers: Record<string, Record<string, string>> = {}

    if (snapshot.targets) {
        for (const [k2, v2] of Object.entries(snapshot.targets)) {
            const targetModule = k2.startsWith('./') ? path.resolve(pkgDir, k2) : k2
            targets[targetModule] = v2
        }
    }

    if (snapshot.moduleManifest) {
        for (const [k, v] of Object.entries(snapshot.moduleManifest)) {
            runtimeModules[k] = {
                types: undefined,
                ...v,
                path: path.resolve(pkgDir, v.path),
            }
        }
    }

    if (snapshot.published) {
        for (const [k, v] of Object.entries(snapshot.published)) {
            const [storeHash, hash] = v.split(':')
            if (!hash) {
                throw new Error(`Malformed pointer: ${v}`)
            }
            published[path.resolve(pkgDir, k)] = createPointer(hash, storeHash)
        }
    }

    if (snapshot.pointers) {
        for (const [k, v] of Object.entries(snapshot.pointers)) {
            pointers[path.resolve(pkgDir, k)] = v
        }
    }

    // We apply the mount _relative_ to the target directory
    const store = snapshot.store ?? (await repo.getBuildFs(snapshot.storeHash))
    const spec = v.specifier ?? v.name

    return {
        spec,
        store,
        targets,
        pointers,
        published,
        runtimeModules,
    }
}        
    
function getPackages(installation: Pick<InstallationAttributes, 'packages'>, workingDir = getWorkingDir()) {
    return Object.fromEntries(Object.entries(installation.packages).map(([k, v]) => {
        return [path.resolve(workingDir, k), {
            ...v,
            directory: path.resolve(workingDir, v.directory),
        }] as const
    }))
}

const getSnapshot = keyedMemoize(loadSnapshot)

export async function loadTypes() {
    const workingDirectory = getWorkingDir()
    const installation = await getInstallationCached(getProgramFs())
    const types: Record<string, TypesFileData> = {}
    const runtimeModules: Record<string, string> = {}
    const packages = installation?.packages

    if (!packages) {
        getLogger().warn(`No packages installed, type generation may not be correct`)

        return { types, runtimeModules }
    }

    for (const [k, v] of Object.entries(packages)) {
        const pkgDir = path.resolve(workingDirectory, v.directory)
        const installedDir = path.resolve(workingDirectory, k)
        if (v.types) {
            const runtimeManifest = v.snapshot?.moduleManifest
            if (runtimeManifest) {
                for (const [k, v] of Object.entries(runtimeManifest)) {
                    runtimeModules[k] = resolveRelative(installedDir, v.path).replace(/\.js$/, '.d.ts')
                }
            }
    
            types[installedDir] = v.types
            continue
        }

        if (!v.packageFile.synapse || pkgDir === workingDirectory) {
            continue
        }

        const snapshot = v.snapshot ?? await getSnapshot(pkgDir)
        if (!snapshot) {
            // throw new Error(`Missing build artifacts for package: ${k}`) 
            getLogger().debug(`No snapshot found for "${k}"`)
            continue
        }

        if (snapshot.types) {
            types[installedDir] = snapshot.types
        }

        if (snapshot.moduleManifest) {
            for (const [k, v] of Object.entries(snapshot.moduleManifest)) {
                runtimeModules[k] = resolveRelative(installedDir, v.path).replace(/\.js$/, '.d.ts')
            }
        }
    }

    return { types, runtimeModules }
}

interface DeferredTargets {
    readonly specifier: string
    readonly data: TargetsFile    
}

export function resolveDeferredTargets(moduleResolver: ModuleResolver, targets: DeferredTargets[]): TargetsFile {
    const res: TargetsFile = {}
    for (const t of targets) {
        // TODO: implement importer
        const entrypoint = moduleResolver.resolveVirtual(t.specifier)

        for (const [k, v] of Object.entries(t.data)) {
            for (const symbolInfo of Object.values(v)) {
                for (const [targetName, mapping] of Object.entries(symbolInfo)) {
                    if (isRelativeSpecifier(mapping.moduleSpecifier)) {
                        symbolInfo[targetName] = {
                            ...symbolInfo[targetName],
                            moduleSpecifier: moduleResolver.resolveVirtual(mapping.moduleSpecifier, entrypoint),
                        }
                    }
                }
            }

            if (!res[k]) {
                res[k] = v
                continue
            }

            for (const spec of Object.keys(v)) {
                if (!res[k][spec]) {
                    res[k][spec] = v[spec]
                    continue
                }

                for (const target of Object.keys(v[spec])) {
                    res[k][spec][target] = v[spec][target]
                }
            }
        }
    }

    // Final target resolution
    for (const [k, v] of Object.entries(res)) {
        res[moduleResolver.resolve(k)] = v
    }    

    return res
}


function getPointerComponents(pointer: string): { hash: string; storeHash?: string } {
    if (isDataPointer(pointer)) {
        return pointer.resolve()
    }

    if (pointer.startsWith(pointerPrefix)) {
        pointer = pointer.slice(pointerPrefix.length)
    }

    const [storeHash, hash] = pointer.split(':')
    if (!hash) {
        return { hash: storeHash }
    }

    return { hash, storeHash }
}


// JSR
// https://npm.jsr.io
// jsr:@luca/cases -> @jsr/luca__cases
// NOTE: All requests to the JSR registry API must be made with an Accept header that does not include text/html, and requests must not specify Sec-Fetch-Dest: document. When fetching with Accept: text/html, the registry may return an HTML page with a rendered version of the underlying data.

const installations = new Map<Pick<Fs, 'readFile'>, ReturnType<typeof getInstallation>>()
function getInstallationCached(fs: Pick<Fs, 'readFile'>) {
    if (installations.has(fs)) {
        return installations.get(fs)!
    }

    const res = getInstallation(fs)
    installations.set(fs, res)

    return res
}

export type PackageService = Awaited<ReturnType<typeof createPackageService>>
export async function createPackageService(moduleResolver: ModuleResolver, repo = getDataRepository(), programFs: Pick<Fs, 'readFile'> & Pick<JsonFs, 'readJson'> = getProgramFs()) {
    const workingDirectory = getWorkingDir()

    const fs = getFs()

    const globalsHashes = new Map<string, string>()
    const getGlobalsHash = (spec: string) => globalsHashes.get(spec)

    const installer = createPackageInstaller({
        fs,
        getGlobalsHash,
        getProviderGenerator: memoize(async () => {
            const tfPath = await getTerraformPath()

            return createProviderGenerator(fs, providerRegistryHostname, tfPath)
        })
    })

    function registerRuntimeMapping(modules: NonNullable<Snapshot['moduleManifest']>, dir: string) {
        const _resolved: [string, string][] = []
        for (const [k, v] of Object.entries(modules)) {
            globalsHashes.set(k, v.hash)
            _resolved.push([k, path.resolve(dir, v.path)])
        }

        const resolved = Object.fromEntries(_resolved)
        moduleResolver.registerGlobals(resolved)
        getLogger().debug(`Registered globals`, resolved)
    }

    async function maybeGetTsPathMappings() {
        const tsConfig = await getResolvedTsConfig(programFs)
        if (!tsConfig?.options.paths) {
            return
        }

        const mappings = await getTsPathMappings(workingDirectory)
        if (!mappings) {
            return
        }

        const rootDir = tsConfig.options.rootDir || workingDirectory

        const importMap: ImportMap2 = {}
        for (const [k, v] of Object.entries(mappings)) {
            importMap[k] = {
                locationType: 'module',
                location: getOutputFilename(rootDir, tsConfig.options, v),
            }
        }

        return importMap
    }

    async function loadProgramState() {
        const [installation, infraMappings, currentPointers, tsPathMappings] = await Promise.all([
            getInstallationCached(programFs),
            readInfraMappings(programFs),
            readPointersFile(programFs),
            maybeGetTsPathMappings(),
        ])

        return {
            installation,
            infraMappings,
            currentPointers,
            tsPathMappings,
        }
    }

    async function _loadIndex() {
        const { installation, infraMappings, currentPointers, tsPathMappings } = await loadProgramState()
        if (!installation?.packages) {
            throw new Error(`No packages installed`)
        }

        if (tsPathMappings) {
            moduleResolver.registerMapping(tsPathMappings, workingDirectory)
        }

        const runtimeModules: NonNullable<Snapshot['moduleManifest']> = {}

        const packageIds = installation.importMap?.sources
            ? new Map(Object.entries(installation.importMap.sources).filter(x => !!x[1]).map(x => [x[1], x[0]] as const))
            : undefined

        const rootMapping = installation.importMap?.mappings['#root']
        if (installation.importMap) {
            const expanded = expandImportMap(installation.importMap)
            moduleResolver.registerMapping(expanded, workingDirectory)
        }

        const infraFiles = Object.fromEntries(
            Object.entries(infraMappings).map(([k, v]) => [path.resolve(workingDirectory, k), path.resolve(workingDirectory, v)])
        )

        const packages = runTask('get', 'packages (index)', () => getPackages(installation), 1)
        const stores: Record<string, ReadonlyBuildFs> = {}
        const pointers: Record<string, Record<string, string>> = {}

        const deferredTargets: DeferredTargets[] = []

        if (currentPointers) {
            for (const [k, v] of Object.entries(currentPointers)) {
                pointers[path.resolve(workingDirectory, k)] = v
            }
        }

        async function setupSynapsePkg(k: string, v: (typeof packages)[string]) {
            // FIXME: won't work correctly for nested `spr` packages
            function getPkgDir() {
                if (!v.specifier || !rootMapping || !rootMapping[v.specifier]) {
                    return v.directory
                }

                const loc = installation!.importMap!.locations[rootMapping[v.specifier]]
                if (!loc) {
                    return v.directory
                }

                return loc.location
            }

            const pkgDir = getPkgDir()
            const snapshot = v.snapshot ?? await getSnapshot(pkgDir)
            if (!snapshot) {
                // throw new Error(`Missing build artifacts for package: ${k}`) 
                getLogger().debug(`No snapshot found for "${k}"`)
                return
            }

            const res = await loadSynapsePackage(repo, pkgDir, snapshot, k, v)
            stores[path.relative(workingDirectory, pkgDir)] = res.store

            for (const [k, v] of Object.entries(res.pointers)) {
                pointers[k] = v
            }

            function maybeMapNestedPointers(storeHash: string, hash: string, pointers: Record<string, string>) {
                if (isNullHash(storeHash)) {
                   return pointers
                }

                const metadata = repo.getMetadata(hash, storeHash)
                if (!metadata.name) {
                    return pointers
                }

                const name = `${metadata.name}::` // The prefix is defined in `src/static-solver/compiler.ts`
                const prefixed: Record<string, string> = {}
                for (const [k, v] of Object.entries(pointers)) {
                    if (k.startsWith(name)) {
                        prefixed[k.slice(name.length)] = v
                    }
                }

                return prefixed
            }

            for (const [k, v] of Object.entries(res.published)) {
                const mappings = await registerPointerDependencies(v, k)

                // We need to bind the original pointer mappings to any exported objects
                if (mappings) {
                    const sourcePointers = pointers[k.replace(/.js$/, '.infra.js')]
                    function bindMappings(mappings: ImportMap2) {
                        for (const [k, v] of Object.entries(mappings)) {
                            const source = v.source
                            if (source?.type === 'artifact' && sourcePointers) {
                                const mapped = maybeMapNestedPointers(source.data.metadataHash, source.data.hash, sourcePointers)
                                pointers[`pointer:${source.data.metadataHash}:${source.data.hash}`] = mapped
                            }

                            if (v.mapping) {
                                bindMappings(v.mapping)
                            }
                        }
                    }

                    bindMappings(mappings)
                }
            }

            for (const [k, v] of Object.entries(res.runtimeModules)) {
                if (runtimeModules[k] && runtimeModules[k].path !== v.path) {
                    // throw new Error(`Conflicting runtime module found for "${k}": ${resolved} conflicts with ${runtimeModules[k].path}`)
                } else {
                    runtimeModules[k] = v as any
                }
            }

            deferredTargets.push({
                specifier: res.spec,
                data: res.targets,
            })
        }

        const p: Promise<void>[] = []
        for (const [k, v] of Object.entries(packages)) {
            if ((!v.isSynapsePackage && !v.packageFile.synapse) || path.resolve(workingDirectory, v.directory) === workingDirectory) {
                continue
            }

            p.push(runTask('synapse-pkg', k, () => setupSynapsePkg(k, v), 1).catch(e => {
                throw new Error(`Failed to load package "${k}"`, { cause: e })
            }))
        }

        await Promise.all(p)

        registerRuntimeMapping(runtimeModules, workingDirectory)
        const pkgResolver = createPackageResolver(
            fs,
            workingDirectory,
            moduleResolver,
            packages,
            packageIds as Map<SourceInfo, string>
        )

        const runtimeMappings = Object.fromEntries(Object.entries(runtimeModules).map(([k, v]) => [k, path.resolve(workingDirectory, v.path)]))

        return { stores, packages, infraFiles, pkgResolver, pointers, runtimeMappings, deferredTargets, importMap: installation.importMap }
    }

    async function registerPointerDependencies(pointer: string, name?: string) {
        if (!isDataPointer(pointer)) {
            throw new Error(`Not implemented: ${pointer}`)
        }
    
        if (name) {
            const mapping = await installer.getPublishedMappings2(name, pointer)
            if (mapping) {
                moduleResolver.registerMapping(Object.fromEntries([mapping]))
                // getLogger().debug(`Registered published import map for module "${name}":`, pointer)
            }

            return mapping?.[1]?.mapping
        }

        const { hash, storeHash } = pointer.resolve()
        const mapping = await installer.getPointerMappings(hash, storeHash)
        if (mapping) {
            moduleResolver.registerMapping(mapping, pointer)
            // getLogger().debug('Registered import map for module:', pointer, Object.keys(mapping))
        }
    }

    return {
        getPublishedMappings: installer.getPublishedMappings,
        getPublishedMappings2: installer.getPublishedMappings2,
        downloadPackage: installer.downloadPackage,
        getImportMap: installer.getImportMap,
        getHashWithDeps: installer.getHashWithDeps,
        loadIndex: () => runTask('', 'loadIndex', _loadIndex, 1),
        registerPointerDependencies,
    }
}

type PackageInstallResult = {
    type: 'ok'
    name: string
    destination: string
    cacheHit: boolean
} | {
    type: 'err'
    reason: Error
} | {
    type: 'skipped'
    reason: string
}

// `browser`? `react-native`?
const partialPackageKeys = ['name', 'main', 'bin', 'bundledDependencies', 'optionalDependencies', 'dependencies', 'exports', 'module', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'synapse', 'type', 'scripts'] as const
const lifecycleScripts = ['postinstall']

type PartialPackageJson = Pick<PackageJson, (typeof partialPackageKeys)[number]>

function prunePkgJsonScripts(pkgScripts: Record<string, string>): Record<string, string> | undefined {
    let didAdd = false
    const res: any = {}
    for (const k of lifecycleScripts) {
        res[k] = pkgScripts[k]
        didAdd ||= !!pkgScripts[k]
    }
    return didAdd ? res : undefined
}

function prunePkgJson(pkg: PackageJson): PartialPackageJson {
    const res: any = {}
    for (const k of partialPackageKeys) {
        res[k] = pkg[k]
        if (k === 'scripts' && res[k]) {
            res[k] = prunePkgJsonScripts(res[k])
        }
    }
    return res
}

export interface NpmPackageInfo {
    readonly name: string
    readonly version?: string
    readonly directory: string
    readonly packageFile: PartialPackageJson
    readonly resolved?: string
    readonly integrity?: string

    // Synapse only
    readonly types?: TypesFileData
    readonly specifier?: string
    readonly snapshot?: Snapshot

    // readonly hasInstallScript?: boolean
}

interface LookupResult { 
    readonly module: string
    readonly packageId?: string

    // old
    readonly location?: string
    readonly packageInfo?: PackageInfo
    readonly dependencies?: DependencyTree
    readonly versionConstraint?: string
}

interface FlatImportMap {
    [specifier: string]: {
        readonly location: string
        readonly mapping?: number
        readonly source?: SourceInfo
        readonly versionConstraint: string
    }
}

// This omits any nodes that _are not_ in `keys`
export function pruneManifest(manifest: TerraformPackageManifest, keys: Iterable<string>): TerraformPackageManifest {
    const m: TerraformPackageManifest = { roots: {}, dependencies: {}, packages: {} }

    function insert(id: number, stack: number[] = []) {
        if (id in m.packages) return

        const pkg = m.packages[id] = manifest.packages[id]
        const pkgDeps = (pkg as any).dependencies
        const pkgPeerDeps = (pkg as any).peers
        const nestedDeps = manifest.dependencies[id]

        if (nestedDeps) {
            m.dependencies[id] = nestedDeps

            for (const v of Object.values(nestedDeps)) {
                insert(v.package, [...stack, id])
            }
        }

        const deps = { ...pkgDeps, ...pkgPeerDeps }
        for (const k of Object.keys(deps)) {
            // for (let i = stack.length - 1; i >= 0; i--) {
            //     const peers = manifest.dependencies[stack[i]]
            // }
            if (manifest.roots[k]) {
                m.roots[k] = manifest.roots[k]
                insert(m.roots[k].package)
            }
        }
    }

    for (const k of keys) {
        const r = manifest.roots[k]
        if (r === undefined || k in m.roots) continue

        m.roots[k] = manifest.roots[k]
        insert(m.roots[k].package)
    }

    return m
}
