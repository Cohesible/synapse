import ts from 'typescript'
import * as path from 'node:path'
import { escapeRegExp, failOnNode, isRelativeSpecifier, keyedMemoize, makeRelative, memoize, resolveRelative, throwIfNotFileNotFoundError } from '../utils'
import { ResolvedProgramConfig } from './config'
import { getFs } from '../execution'
import { getLogger } from '../logging'
import { getFileHasher } from './incremental'
import { getProgramFs } from '../artifacts'
import { JsonFs } from '../system'
import { getWorkingDir } from '../workspaces'

// The "entrypoint" mechanic is primarily used to ease onboarding.
//
// Synapse doesn't require an entrypoint because distributed applications
// are, generally speaking, always running. There's nothing to start.
//
// Most programmers will not be comfortable with this concept. When they
// run a program, they expect some code will be executed and then, usually, stop.
// That's how it's been for 100 years or so. And, for many applications, that's
// how it will continue to be.
//
// So instead of trying to teach users a new way of thinking right away, we'll
// gradually introduce them to new ideas by first starting with familiar ones.
// 
// For Synapse, declaring a `main` function is interpretted as "create an executable"
// We can do this without the user explicitly requesting an executable because
// it's a purely additive feature. The distributed application does not change.

// A function is potentially a executable entrypoint if:
// * Named `main`
// * Exported
// * Is assignable to this signature:
// ```ts
// (...args: string[]) => Promise<number | void> | number | void
// ```
// 
// Contrary to many other conventions, `main` will _not_ be called with
// the targeted executable as `args[0]`. And, in contrast to NodeJS,
// `args[1]` will _not_ contain the target script.
//
// In other words, `args` is equal to `process.argv.slice(2)`.
//
// Reasoning behind this decision:
// * The first two arguments in `process.argv` establish a context and 
//   generally aren't as relevant to applications as the remaining args
//
// * `process.argv` is still available if truly needed, and many alternatives are also available:
//     * `argv[0]` has "resolved" substitutes e.g. `process.execPath`
//     * `argv[1]` can be replaced with `__filename` or `import.meta.filename` in most cases
//
// Motivation for using the varargs signature:
// * Better expresses how the application will be called
// * Allows for establishing basic program expectations
//
// For example, a simple program that only takes two inputs can be written as:
// ```ts
// export function main(a: string, b: string) { ... }
// ```
//
// Which means this program must _never_ be invoked with anything less than two parameters.
// 

type Main = (...args: string[]) => Promise<number | void> | number | void 

export function isMainFunction(node: ts.FunctionDeclaration, getTypeChecker?: () => ts.TypeChecker) {
    if (node.name?.text !== 'main') {
        return false
    }

    const mods = ts.getModifiers(node)
    if (!mods?.find(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        return false
    }

    if (!getTypeChecker) {
        return true
    }

    const typeChecker = getTypeChecker()
    const sig = typeChecker.getSignatureFromDeclaration(node)
    if (!sig) {
        getLogger().debug(`Skipped node due to missing signature`)
        return false
    }

    const params = sig.getParameters()
    for (const p of params) {
        const decl = p.valueDeclaration
        if (!decl) {
            failOnNode(`Missing parameter value declaration: ${p.name}`, node)
        }

        if (!ts.isParameter(decl)) {
            failOnNode(`Not a parameter`, decl)
        }

        const type = typeChecker.getTypeOfSymbol(p)
        if (decl.dotDotDotToken) {
            // TODO: support tuples?
            // if (!typeChecker.isArrayType(type)) {
            //     getLogger().debug(`Skipped node due to missing signature`)
            //     // failOnNode('Not an array type', decl)
            //     return false
            // }

            const elementType = type.getNumberIndexType()
            if (!elementType) {
                getLogger().debug(`Skipped node due to missing element type`)

                // failOnNode('Expected an element type', decl)
                return false
            }

            if (!typeChecker.isTypeAssignableTo(typeChecker.getStringType(), elementType.getNonNullableType())) {
                // failOnNode('Not a string type', decl)
                return false
            }
        } else {
            if (!typeChecker.isTypeAssignableTo(typeChecker.getStringType(), type.getNonNullableType())) {
                // failOnNode('Not a string type', decl)
                return false
            }
        }
    }

    return true
}

export function hasMainFunction(sf: ts.SourceFile, getTypeChecker?: () => ts.TypeChecker) {
    const statements = sf.statements
    const len = statements.length
    for (let i = 0; i < len; i++) {
        // Duplicated `name` check to avoid function call
        const s = statements[i]
        if (s.kind !== ts.SyntaxKind.FunctionDeclaration || (s as ts.FunctionDeclaration).name?.text !== 'main') continue

        if (isMainFunction(s as ts.FunctionDeclaration, getTypeChecker)) {
            return true
        }
    }

    return false
}

// Module helpers

const synapseScheme = 'synapse:'
const providerScheme = 'synapse-provider:'
export function findProviderImports(sourceFile: ts.SourceFile) {
    const providers = new Set<string>()
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const spec = (statement.moduleSpecifier as ts.StringLiteral).text
            if (spec.startsWith(providerScheme)) {
                providers.add(spec.slice(providerScheme.length))
            }
        }
    }
    return providers
}

function findInterestingSpecifiers(sf: ts.SourceFile, resolveBareSpecifier: (spec: string) => string | undefined) {
    const zig = new Set<string>()
    const bare = new Set<string>()
    for (const s of sf.statements) {
        if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) continue
        if (!s.moduleSpecifier) continue

        const spec = (s.moduleSpecifier as ts.StringLiteral).text
        if (isRelativeSpecifier(spec)) {
            if (s.kind === ts.SyntaxKind.ImportDeclaration && spec.endsWith('.zig')) {
                zig.add(spec)
            }
            continue
        }

        const r = resolveBareSpecifier(spec)
        if (!r) {
            bare.add(spec)
        }
    }

    return { bare, zig }
}

function createSpecifierResolver(cmd: Pick<ts.ParsedCommandLine, 'options' | 'fileNames'>, dir: string) {
    const baseUrl = cmd.options.baseUrl
    const paths = cmd.options.paths
    const resolveDir = baseUrl ?? dir
    const files = new Set(cmd.fileNames)
    const fs = getFs()

    function resolvePaths(paths: Record<string, string[]>) {
        const r: [string | RegExp, string[]][] = []

        const getPrefixLength = keyedMemoize((s: string) => {
            const idx = s.indexOf('*')

            return idx === -1 ? s.length : idx
        })

        const entries = Object.entries(paths)
            .filter(([k, v]) => v.length > 0)
            .sort((a, b) => getPrefixLength(b[0]) - getPrefixLength(a[0]))

        for (const [k, v] of entries) {
            const index = getPrefixLength(k)
            const resolved = v.map(x => path.resolve(resolveDir, x))
            if (index === k.length) {
                r.push([k, resolved])
                continue
            }

            const left = escapeRegExp(k.slice(0, index))
            const right = escapeRegExp(k.slice(index + 1))
            const pattern = new RegExp(`^${left}${'(.*)'}${right}$`)
            r.push([pattern, resolved])
        }

        return r
    }

    const getResolvedPaths = memoize(() => paths ? resolvePaths(paths) : [])
    const perFile = new Set<string>()
    const mappings = new Map<string, string | undefined>()

    function resolveBareSpecifier(spec: string) {
        if (!baseUrl && !paths) {
            return
        }

        if (mappings.has(spec)) {
            const m = mappings.get(spec)
            if (m) {
                perFile.add(spec)
            }
            return m
        }

        if (baseUrl) {
            const p = path.resolve(baseUrl, spec)
            const withExt = path.extname(p) === '' ? `${p}.ts` : p // FIXME
            if (files.has(withExt)) {
                perFile.add(spec)
                mappings.set(spec, withExt)
                return withExt
            }
        }

        const patterns = getResolvedPaths()
        for (const [pattern, locations] of patterns) {
            if (typeof pattern === 'string') {
                if (pattern !== spec) continue
                for (const l of locations) {
                    const withExt = path.extname(l) === '' ? `${l}.ts` : l // FIXME
                    if (files.has(withExt) || fs.fileExistsSync(withExt)) {
                        perFile.add(spec)
                        mappings.set(spec, withExt)
                        return withExt
                    }
                }
                continue
            }

            const m = spec.match(pattern)
            if (!m) continue

            const wildcard = m[1]
            for (const l of locations) {
                const p = l.replace('*', wildcard)
                const withExt = path.extname(p) === '' ? `${p}.ts` : p // FIXME
                if (files.has(withExt) || fs.fileExistsSync(withExt)) {
                    perFile.add(spec)
                    mappings.set(spec, withExt)
                    return withExt
                }
            }
        }

        mappings.set(spec, undefined)
    }

    function getPerFileMappings() {
        if (perFile.size === 0) {
            return
        }

        const keys = [...perFile]
        perFile.clear()

        return Object.fromEntries(keys.map(k => [k, makeRelative(resolveDir, mappings.get(k)!)]))
    }

    return { mappings, resolveBareSpecifier, getPerFileMappings }
}



export async function findAllBareSpecifiers(config: ResolvedProgramConfig, host: ts.CompilerHost) {
    const bare = new Set<string>()
    const workingDir = getWorkingDir()
    const resolver = createSpecifierResolver(config.tsc.cmd, workingDir)
    const target = config.tsc.cmd.options.target ?? ts.ScriptTarget.Latest
    const hasher = getFileHasher()
    const incremental = config.csc.incremental
    const [hashes, previousSpecs] = await Promise.all([
        Promise.all(config.tsc.cmd.fileNames.map(async f => [f, await hasher.getHash(f)])),
        !incremental ? undefined : getSpecData(),
    ])

    const specs = previousSpecs ?? {}
    for (const [f, h] of hashes) {
        const relPath = makeRelative(workingDir, f)
        if (specs[relPath]?.hash === h) {
            specs[relPath].specs.forEach(s => bare.add(s))
            continue
        }

        // We're probably double parsing files. Not sure if the
        // standalone compiler host does any caching.
        const sf = host.getSourceFile(f, target, err => getLogger().error(err))
        if (!sf) {
            continue
        }

        const results = findInterestingSpecifiers(sf, resolver.resolveBareSpecifier)
        specs[relPath] = { 
            hash: h, 
            specs: [...results.bare], 
            mappings: resolver.getPerFileMappings(), 
            zigImports: results.zig.size > 0 ? [...results.zig] : undefined,
        }

        for (const d of results.bare) {
            bare.add(d)
        }
    }

    await saveSpecData(specs)

    return bare
}

const specsFileName = `[#sources]__bareSpecifiers__.json`

// `mappings` and `specs` will likely have many duplicate elements across all files
// need to add a fast way to encode/decode
interface SpecDataElement {
    readonly hash: string
    readonly specs: string[]
    readonly mappings?: Record<string, string>
    readonly zigImports?: string[]
}

const specDataCache = new Map<Pick<JsonFs, 'writeJson'>, Record<string, SpecDataElement>>()

async function saveSpecData(data: Record<string, SpecDataElement>, fs: Pick<JsonFs, 'writeJson'> = getProgramFs()) {
    await fs.writeJson(specsFileName, data)
    specDataCache.set(fs, data)
}

async function getSpecData(fs: Pick<JsonFs, 'readJson'> = getProgramFs()) {
    return await fs.readJson<Record<string, SpecDataElement>>(specsFileName).catch(throwIfNotFileNotFoundError)
}

const _getSpecData = memoize(() => {
    const fs = getProgramFs()
    if (specDataCache.has(fs)) {
        return specDataCache.get(fs)!
    }
    return getSpecData(fs)
})

export async function getZigImports(relPath: string) {
    return (await _getSpecData())?.[relPath]?.zigImports
}

function getPerFilePathMappings(data: Record<string, SpecDataElement>, workingDir: string, resolveDir: string) {
    const result: Record<string, Record<string, string>> = {}
    for (const [k, v] of Object.entries(data)) {
        if (!v.mappings) continue

        const perFile: Record<string, string> = result[resolveRelative(workingDir, k)] = {}
        for (const [spec, relPath] of Object.entries(v.mappings)) {
            perFile[spec] = resolveRelative(resolveDir, relPath)
        }
    }

    return result
}

function getDedupedPathMappings(data: Record<string, SpecDataElement>, resolveDir: string) {
    const result: Record<string, string> = {}
    for (const v of Object.values(data)) {
        if (!v.mappings) continue

        for (const spec of Object.keys(v.mappings)) {
            result[spec] ??= path.resolve(resolveDir, v.mappings[spec])
        }
    }

    return result
}

export async function getTsPathMappings(resolveDir: string) {
    const data = await _getSpecData()
    if (!data) {
        return
    }

    return getDedupedPathMappings(data, resolveDir)
}

// export async function getAllBareSpecifiers() {
//     const data = await _getSpecData()
//     if (!data) {
//         return
//     }

//     const specs = new Set<string>()
//     for (const v of Object.values(data)) {
//         v.specs.forEach(spec => specs.add(spec))
//     }

//     return specs
// }
