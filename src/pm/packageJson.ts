import * as path from 'node:path'
import { homedir } from 'node:os'
import { getLogger } from '..'
import { getPreviousProgramFs, getProgramFs } from '../artifacts'
import { Fs, readDirectorySync } from '../system'
import { getHash, throwIfNotFileNotFoundError, tryReadJson } from '../utils'
import { SynapseConfiguration, getWorkingDir } from '../workspaces'
import { getBuildTarget, getFs } from '../execution'
import { providerPrefix } from '../runtime/loader'

export interface PackageJson {
    readonly os?: string[]
    readonly cpu?: string[]
    readonly name: string
    readonly type?: 'module'
    readonly main?: string
    readonly files?: string[]
    readonly bin?: string | Record<string, string>
    readonly types?: string | Record<string, string> // TODO: can this be an object?
    readonly module?: string
    readonly version?: string
    readonly private?: boolean
    readonly exports?: any // PackageExport
    readonly imports?: Record<string, any> // Value is the same as exports
    readonly browser?: Record<string, string>
    readonly scripts?: Record<string, string>
    readonly workspaces?: string[]
    readonly engines?: Record<string, string> & { node?: string }
    readonly dependencies?: Record<string, string>
    readonly devDependencies?: Record<string, string>
    readonly peerDependencies?: Record<string, string>
    readonly bundledDependencies?: Record<string, string>
    readonly optionalDependencies?: Record<string, string>
    readonly optionalDevDependencies?: Record<string, string>
    readonly peerDependenciesMeta?: Record<string, { optional?: boolean }>
    readonly synapse?: {
        readonly config?: SynapseConfiguration
        readonly tools?: Record<string, string>
        readonly dependencies?: Record<string, string>
        readonly providers?: Record<string, string>
        readonly binaryDependencies?: Record<string, string>
        readonly devTools?: Record<string, string>
    }
}

const packageJsonCache = new Map<string, { directory: string; data: PackageJson } | undefined>()

export interface ResolvedPackage {
    readonly data: PackageJson
    readonly directory: string
}

export async function getPackageJson(fs: Fs, dir: string, recursive = true, stopAt?: string): Promise<ResolvedPackage | undefined> {
    const key = `${dir}:${recursive}`
    if (packageJsonCache.has(key)) {
        return packageJsonCache.get(key)!
    }

    let result: { directory: string; data: PackageJson } | undefined
    try {
        const data = JSON.parse(await fs.readFile(path.resolve(dir, 'package.json'), 'utf-8')) as PackageJson
        result = { directory: dir, data }
    } catch (e) {
        throwIfNotFileNotFoundError(e)

        if (!recursive || path.dirname(dir) === (dir ?? stopAt)) {
            result = undefined
        } else {
            result = await getPackageJson(fs, path.dirname(dir), recursive, stopAt)
        }
    } 

    packageJsonCache.set(key, result)

    return result
}

export async function getImmediatePackageJsonOrThrow(dir = getWorkingDir()) {
    const fs = getFs()
    const pkg = await getPackageJson(fs, dir)
    if (!pkg) {
        throw new Error(`No "package.json" found: ${dir}`)
    }
    return pkg
}

const previousPkgs = new WeakMap<Pick<Fs, 'writeFile'> | Pick<Fs, 'readFile'>, PackageJson | undefined>()
const cachedPkgs = new WeakMap<Pick<Fs, 'writeFile'> | Pick<Fs, 'readFile'>, PackageJson | undefined>()
export function setCompiledPkgJson(compiled: PackageJson, fs: Pick<Fs, 'writeFile' | 'readFile'> = getProgramFs()) {
    cachedPkgs.set(fs, compiled)
    if (previousPkgs.has(fs)) {
        return fs.writeFile(`[#packages]package.json`, JSON.stringify(compiled))
    }

    return fs.readFile('[#packages]package.json')
        .catch(() => {})
        .then(d => previousPkgs.set(fs, d ? JSON.parse(Buffer.from(d).toString()) : undefined))
        .then(() => fs.writeFile(`[#packages]package.json`, JSON.stringify(compiled)))
}

export function resetCompiledPkgJson(fs: Pick<Fs, 'writeFile'> = getProgramFs()) {
    const prev = previousPkgs.get(fs)

    return prev && fs.writeFile(`[#packages]package.json`, JSON.stringify(prev))
}

export function getCompiledPkgJson(fs: Pick<Fs, 'readFile'> = getProgramFs()): Promise<PackageJson | undefined> | PackageJson | undefined {
    if (cachedPkgs.has(fs)) {
        return cachedPkgs.get(fs)
    }

    return tryReadJson<PackageJson>(fs, `package.json`)
        .then(val => {
            if (!previousPkgs.has(fs)) {
                previousPkgs.set(fs, val)
            }
            cachedPkgs.set(fs, val)

            return val
        })
}

export async function getCurrentPkg() {
    const cwd = getBuildTarget()?.workingDirectory ?? process.cwd()
    const compiled = await getCompiledPkgJson()
    if (compiled) {
        return { directory: cwd, data: compiled }
    }

    return getPackageJson(getFs(), cwd, false)
}

interface DepProps {
    pattern: string
    dev?: boolean
}

export interface DepsDiff {
    readonly added?: Record<string, DepProps>
    readonly removed?: Record<string, DepProps>
    readonly changed?: Record<string, { from: Partial<DepProps>; to: Partial<DepProps> }>
}

function gatherDeps(pkg: Pick<PackageJson, 'dependencies' | 'devDependencies'>): Record<string, DepProps> {
    const deps: Record<string, DepProps> = {}
    if (pkg.dependencies) {
        for (const [k, v] of Object.entries(pkg.dependencies)) {
            deps[k] = { pattern: v }
        }
    }

    if (pkg.devDependencies) {
        for (const [k, v] of Object.entries(pkg.devDependencies)) {
            deps[k] = { pattern: v, dev: true }
        }
    }

    return deps
}

export function getPreviousPkg(fs = getProgramFs()) {
    if (previousPkgs.has(fs)) {
        return previousPkgs.get(fs)
    }

    return getPreviousProgramFs().then(fs => fs ? getCompiledPkgJson(fs) : undefined)
}

async function diffDeps(): Promise<DepsDiff | undefined> {
    const [current, previous] = await Promise.all([
        getCompiledPkgJson(),
        getPreviousPkg(),
    ])

    return diffPkgDeps(current, previous)
}

export function diffPkgDeps(
    current?: Pick<PackageJson, 'dependencies' | 'devDependencies'>,
    previous?: Pick<PackageJson, 'dependencies' | 'devDependencies'>
): DepsDiff | undefined {
    if (!current && !previous) {
        return
    }

    const currentDeps = current ? gatherDeps(current) : undefined
    const previousDeps = previous ? gatherDeps(previous) : undefined

    if (currentDeps && !previousDeps) {
        return { added: currentDeps }
    }

    if (!currentDeps && previousDeps) {
        return { removed: previousDeps }
    }

    function diffProps(v: DepProps, p: DepProps) {
        const devChanged = p.dev !== v.dev
        const patternChanged = v.pattern !== p.pattern
        if (!devChanged && !patternChanged) {
            return
        }

        return {
            from: {
                dev: devChanged ? p.dev : undefined,
                pattern: patternChanged ? p.pattern : undefined,
            },
            to: {
                dev: devChanged ? v.dev : undefined,
                pattern: patternChanged ? v.pattern : undefined,
            },
        }
    }

    const changed = new Map<string, { from: Partial<DepProps>; to: Partial<DepProps> }>()
    const result: DepsDiff = { added: {}, removed: {} }
    for (const [k, v] of Object.entries(currentDeps!)) {
        const p = previousDeps![k]
        if (!p) {
            result.added![k] = v
            continue
        }

        const change = diffProps(v, p)
        if (change) {
            changed.set(k, change)
        }
    }

    for (const [k, v] of Object.entries(previousDeps!)) {
        if (changed.has(k)) continue

        const c = currentDeps![k]
        if (!c) {
            result.removed![k] = v
        }
    }

    return {
        ...result,
        changed: Object.fromEntries(changed),
    }
}

function isEmptyObject(obj?: Record<string, any>) {
    return !obj || Object.keys(obj).length === 0
}

function isEmptyDiff(diff: DepsDiff) {    
    return isEmptyObject(diff.added) && isEmptyObject(diff.removed) && isEmptyObject(diff.changed)
}

export async function runIfPkgChanged<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
    const diff = await diffDeps()
    if (diff && isEmptyDiff(diff)) {
        return
    }

    getLogger().debug('Package has changed, checking installation', diff)

    return fn()
}

// Git URLs
// <protocol>://[<user>[:<password>]@]<hostname>[:<port>][:][/]<path>[#<commit-ish> | #semver:<semver>]

function parsePkgRequest(r: string): { name: string; version?: string; scheme?: string } {
    const match = r.match(/^(?<scheme>[a-z]+:)?(?<name>@?[^@:\s]+)(?<version>@[^@\s:\/]+)?(?<commitish>#[0-9a-zA-Z\/\-]+)?$/) // Version constraint is fairly broad
    if (!match?.groups) {
        throw new Error(`Bad parse: ${r}`)
    }

    const name = match.groups.name
    const scheme = match.groups.scheme?.slice(0, -1)

    // GitHub e.g. `user/repo#feature/branch`
    // This is the same format used by `npm`
    if (!scheme && name.includes('/') && !name.startsWith('@')) { 
        if (isProbablyFilePath(name)) {
            return { name }
        }

        return { name, version: match.groups.commitish?.slice(1), scheme: 'github' }
    }

    // FIXME: module specifiers should be able to include a scheme
    return { name, version: match.groups.version?.slice(1), scheme: match.groups.scheme?.slice(0, -1) }
}

function isProbablyFilePath(name: string) {
    return name.startsWith('..') || name.startsWith('~') || name.startsWith('./') || name.startsWith('/') // TODO: windows backslash?
}

export function resolveFileSpecifier(spec: string, workingDir = getWorkingDir()) {
    const absPath = path.resolve(workingDir, spec.replace('~', homedir()))
    const pkg = getFs().readFileSync(path.resolve(absPath, 'package.json'), 'utf-8')
    if (!pkg) {
        throw new Error(`Not a package: ${absPath}`)
    }
    
    return {
        specifier: JSON.parse(pkg).name ?? path.basename(absPath),
        location: `file:${path.relative(workingDir, absPath)}`,
    }
}

export function parsePackageInstallRequests(requests: string[]): Record<string, string> {
    const result: Record<string, string> = {}
    for (const r of requests) {
        const p = parsePkgRequest(r)
        if (p.scheme === 'file' || isProbablyFilePath(p.name)) {
            const resolved = resolveFileSpecifier(p.name)
            result[resolved.specifier] = resolved.location
            continue
        }

        if (p.scheme && p.scheme !== 'npm') {
            throw new Error(`Not implemented: ${p.scheme}`)
        }

        result[p.name] = p.version ?? 'latest'
    }
    return result
}

// https://github.com/oven-sh/bun/issues/3107
function detectIndentLevel(jsonText: string) {
    const firstNewLine = jsonText.indexOf('\n')
    if (firstNewLine === -1) {
        return 0
    }

    const secondNewLine = jsonText.indexOf('\n', firstNewLine)
    const secondLine = jsonText.slice(firstNewLine+1, secondNewLine === -1 ? jsonText.length : secondNewLine)

    // meh
    let indent = 0
    loop: for (let i = 0; i < secondLine.length; i++) {
        switch (secondLine[i]) {
            case '\t':
                indent += 4
                continue
            case ' ':
                indent += 1
                continue
            
            default:
                break loop
        }
    }

    return indent
}

export function createSynapseProviderRequirement(name: string, constraint: string) {
    return [`${providerPrefix}${name}`, `spr:_provider-${name}:${constraint}`] as const
}

export function isFileUrl(version: string) {
    return !!version.startsWith('file:')
}

export function getRequired(pkg: Partial<PackageJson>, includeOptional = true, includeDev = false, includeWorkspaces = false, includeSynapse = true) {
    let isEmpty = true
    const required: Record<string, string> = {}
    const optional = new Set<string>()

    if (pkg.optionalDependencies) {
        for (const [k, v] of Object.entries(pkg.optionalDependencies)) {
            if (includeOptional) {
                required[k] = v
                isEmpty = false
            } else {
                optional.add(k)
            }
        }
    }

    // if (pkg.peerDependenciesMeta) {
    //     for (const [k, v] of Object.entries(pkg.peerDependenciesMeta)) {
    //         if (v.optional && includeOptional) {
    //             optional.add(k)
    //         }
    //     }
    // }

    if (pkg.synapse?.providers && includeSynapse) {
        for (const [k, v] of Object.entries(pkg.synapse.providers)) {
            const [name, pattern] = createSynapseProviderRequirement(k, v)
            required[name] = pattern
            isEmpty = false
        }
    }

    if (pkg.synapse?.dependencies && includeSynapse) {
        for (const [k, v] of Object.entries(pkg.synapse.dependencies)) {
            required[k] = `spr:${v}`
            isEmpty = false
        }
    }

    if (pkg.dependencies) {
        for (const [k, v] of Object.entries(pkg.dependencies)) {
            if (!optional.has(k) && !isFileUrl(v)) {
                required[k] = v
                isEmpty = false
            }
        }
    }

    if (includeDev && pkg.devDependencies) {
        for (const [k, v] of Object.entries(pkg.devDependencies)) {
            if (!optional.has(k) && !isFileUrl(v)) {
                required[k] = v
                isEmpty = false
            }
        }
    }

    if (pkg.workspaces && includeWorkspaces) {
        for (const [k, v] of Object.entries(resolveWorkspaces(pkg.workspaces))) {
            required[k] = v
            isEmpty = false
        }
    }

    return isEmpty ? undefined : required
}


export function resolveWorkspaces(workspaces: string[], workspaceRootDir?: string) {
    const result: Record<string, string> = {}

    function resolve(dir: string) {
        const resolved = resolveFileSpecifier(dir, workspaceRootDir)
        result[resolved.specifier] = resolved.location
    }

    for (const v of workspaces) {
        const isPattern = v.endsWith('*') || v.endsWith('/')
        if (!isPattern) {
            //             throw new Error(`Pattern not implemented: "${v}". A workspace pattern must end with "*"`)

            resolve(v)
            continue
        }

        const absPath = path.resolve(workspaceRootDir ?? getWorkingDir(), v)
        const files = readDirectorySync(v.endsWith('/') ? absPath : path.dirname(absPath))
        const base = v.endsWith('/') ? '' : path.basename(v).slice(0, -1)
        for (const f of files) {
            if (f.type !== 'directory') continue
            if (!f.name.startsWith(base)) continue

            resolve(path.resolve(v.endsWith('/') ? absPath : v.slice(0, -1), f.name))
        }
    }

    return result
}