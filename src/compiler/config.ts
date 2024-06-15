import ts from 'typescript'
import * as path from 'node:path'
import { Fs, JsonFs } from '../system'
import { CompilerOptions } from './host'
import { glob } from '../utils/glob'
import { getLogger, runTask } from '..'
import { getBuildTargetOrThrow, getFs, getSelfPathOrThrow, isSelfSea } from '../execution'
import { PackageJson, getPreviousPkg } from '../pm/packageJson'
import { getProgramFs } from '../artifacts'
import { getWorkingDir } from '../workspaces'
import { getHash, makeRelative, memoize, resolveRelative, throwIfNotFileNotFoundError } from '../utils'
import { readKeySync } from '../cli/config'

interface ParsedConfig {
    readonly cmd: Pick<ts.ParsedCommandLine, 'options' | 'fileNames' | 'raw'>
    readonly files: string[]
    readonly rootDir: string
    readonly sourceHash: string
    readonly include?: string[]
    readonly exclude?: string[]
    readonly previousOptions?: ts.CompilerOptions
}

// TODO:
// substitute `${configDir}` in `tsconfig.json`
// https://devblogs.microsoft.com/typescript/announcing-typescript-5-5-beta/#the-configdir-template-variable-for-configuration-files

// "moduleDetection": "force",
// "moduleResolution": "bundler",
// "allowImportingTsExtensions": true,
// "verbatimModuleSyntax": true,
// "noEmit": true,

function getDefaultTsConfig(targetFiles: string[]) {
    return {
        include: targetFiles,
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          resolveJsonModule: true,
          sourceMap: true,
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
          alwaysStrict: true,
          forceConsistentCasingInFileNames: true,
        },
    }
}

function getTsConfigFromText(configText: string | void, fileName: string, targetFiles?: string[]) {
    if (!configText) {
        getLogger().debug(`No tsconfig.json, using default`)

        return getDefaultTsConfig(targetFiles ?? ['*'])
    }
    const parseResult = ts.parseConfigFileTextToJson(fileName, configText)
    if (parseResult.error) {
        // TODO: output the error better, does `typescript` have a way to do this? (yes it does)
        throw Object.assign(new Error('Failed to parse "tsconfig.json"'), parseResult.error)
    }

    return parseResult.config
}

// Settings that affect the interpretation of source code need to be directly
// supported by us, otherwise things just break. Best to fail early.
const notSupportedOptions = [
    'paths',
    'baseUrl',
    'rootDirs',
]

// These settings don't affect how the user might have written their program
// So we can still compile, the results just might not be what the user expects
// Either because we override settings, or because we simply ignore them
const notSupportedWarningOptions = [
    'noEmit',
    'plugins',
    'outFile',
    'importHelpers',
]

// TODO: does not handle the "extends" target changing
async function getTsConfig(
    fs: Fs, 
    workingDirectory: string, 
    targetFiles?: string[],
    fileName = path.resolve(workingDirectory, 'tsconfig.json'), 
    sys = ts.sys, 
): Promise<ParsedConfig> {
    const [text, previousConfig] = await Promise.all([
        getFs().readFile(fileName, 'utf-8').catch(throwIfNotFileNotFoundError),
        getResolvedTsConfig()
    ])

    const sourceHash = text ? getHash(text) : ''

    function parse() {
        const config = getTsConfigFromText(text, fileName, targetFiles)
        const cmd = ts.parseJsonConfigFileContent(config, sys, workingDirectory, undefined, fileName)
        if (cmd.errors.length > 0) {
            // TODO: output the error better, does `typescript` have a way to do this? (yes it does)
            //     ts.formatDiagnostic(d, {})
            throw Object.assign(new Error('Failed to parse "tsconfig.json"'), cmd.errors)
        }
    
        cmd.options.composite ??= true
        cmd.options.alwaysStrict ??= true
        cmd.options.sourceMap ??= true
        cmd.options.skipLibCheck ??= true
    
        if (cmd.options.composite === false) {
            throw new Error('Programs cannot be compiled with `composite` set to `false`')
        }
    
        for (const k of notSupportedWarningOptions) {
            // TODO: warning
        }
    
        const notSupported = notSupportedOptions.filter(k => !!cmd.options[k])
        if (notSupported.length > 0) {
            throw new Error(`The following tsconfig.json options are not supported (yet): ${notSupported.join(', ')}`)
        }
    
        const rootDir = cmd.options.rootDir
            ? path.resolve(workingDirectory, cmd.options.rootDir)
            : workingDirectory
    
        cmd.options.rootDir = rootDir

        const hasTsx = !!cmd.fileNames.find(f => f.endsWith('.tsx'))
        if (hasTsx && cmd.options.jsx === undefined) {
            cmd.options.jsx = ts.JsxEmit.ReactJSX
        }

        return cmd
    }

    const isCached = previousConfig?.sourceHash === sourceHash
    const cmd: ParsedConfig['cmd'] = isCached
        ? { options: previousConfig.options, fileNames: [], raw: { include: previousConfig.include, exclude: previousConfig.exclude } }
        : parse()

    // TODO: fail early if a file is outside of the root directory
    const exclude = cmd.raw?.exclude ?? ['node_modules']
    const files = await runTask('glob', 'tsc-files', () => glob(fs, workingDirectory, cmd.raw?.include ?? ['*'], exclude), 1)
    if (isCached) {
        cmd.fileNames = files
    }
    
    // `include` and `exclude` are only for caching
    return { 
        cmd, 
        files, 
        rootDir: cmd.options.rootDir!, 
        sourceHash, 
        include: cmd.raw?.include, 
        exclude: cmd.raw?.exclude,
        previousOptions: previousConfig?.options,
    }
}

function replaceFileExtension(opt: ts.CompilerOptions, fileName: string) {
    return opt.jsx === ts.JsxEmit.Preserve
        ? fileName.replace(/\.t(sx?)$/, `.j$1`)
        : fileName.replace(/\.tsx?$/, `.js`)
}

export function getOutputFilename(rootDir: string, opt: ts.CompilerOptions, fileName: string) {
    const relPath = path.relative(rootDir, fileName)
    if (relPath.startsWith('..')) {
        throw new Error(`File "${fileName}" is outside of the root directory`)
    }

    const resolved = path.resolve(opt.outDir ?? rootDir, relPath)

    return replaceFileExtension(opt, resolved)
}

export function getInputFilename(rootDir: string, opt: ts.CompilerOptions, fileName: string) {
    const outDir = opt.outDir ?? rootDir
    if (!fileName.startsWith(outDir) || !fileName.endsWith('.js')) {
        return fileName
    }

    const resolved = path.resolve(rootDir, path.relative(outDir, fileName))

    return resolved.replace(/\.js$/, '.ts') // XXX: incorrect, source could have been `.tsx`
}

export interface ResolvedProgramConfig {
    readonly tsc: ParsedConfig
    readonly csc: CompilerOptions
    readonly pkg?: PackageJson
    readonly compiledEntrypoints?: string[]
}

// Discovers all potential entrypoints to a package via:
// * `bin`
// * `main`
// * `module`
// * `exports`
function getEntrypointPatterns(pkg: PackageJson) {
    const entrypoints: string[] = []

    if (pkg.main) {
        entrypoints.push(pkg.main)
    }

    if (pkg.module) {
        entrypoints.push(pkg.module)
    }

    if (pkg.bin) {
        if (typeof pkg.bin === 'string') {
            entrypoints.push(pkg.bin)
        } else {
            for (const v of Object.values(pkg.bin)) {
                entrypoints.push(v)
            }
        }
    }

    if (pkg.exports) {
        // TODO: handle all cases
        if (typeof pkg.exports === 'string') {
            entrypoints.push(pkg.exports)
        } else if (typeof pkg.exports === 'object') {
            for (const [k, v] of Object.entries(pkg.exports)) {
                if (!k.startsWith('.') || typeof v !== 'string') {
                    continue
                }

                entrypoints.push(v)
            }
        }
    }

    return entrypoints
}

// Transforms all entrypoints to use the expected output file
// This allows you to write something like "src/cli/index.ts" in `package.json` instead of the output file
function resolvePackageEntrypoints(pkg: PackageJson, dir: string, rootDir: string, opt: ts.CompilerOptions) {
    const res = { ...pkg }
    const compiledEntrypoints = new Set<string>()
    
    function resolve(p: string) {
        const resolved = resolveRelative(dir, p)
        if (opt.outDir && resolved.startsWith(opt.outDir)) {
            return p
        }

        const sourceFile = path.resolve(dir, p)
        const outfile = getOutputFilename(rootDir, opt, sourceFile)
        if (sourceFile !== outfile) {
            compiledEntrypoints.add(sourceFile)
        }

        return `./${makeRelative(dir, outfile)}`
    }

    if (res.main) {
        res.main = resolve(res.main)
    }

    if (res.module) {
        res.module = resolve(res.module)
    }

    if (res.types) {
        if (typeof res.types === 'string' ) {
            res.types = resolve(res.types)
        }
    }

    if (res.bin) {
        if (typeof res.bin === 'string') {
            res.bin = resolve(res.bin)
        } else {
            // MUTATES
            for (const [k, v] of Object.entries(res.bin)) {
                res.bin[k] = resolve(v)
            }
        }
    }

    if (res.exports) {
        // TODO: handle all cases
        if (typeof res.exports === 'string') {
            res.exports = resolve(res.exports)
        } else if (typeof res.exports === 'object') {
            for (const [k, v] of Object.entries(res.exports)) {
                if (!k.startsWith('.') || typeof v !== 'string') {
                    continue
                }

                res.exports[k] = resolve(v)
            }
        }
    }

    return {
        packageJson: res,
        compiledEntrypoints: [...compiledEntrypoints].map(x => makeRelative(dir, x)),
    }
}

// TODO: this can be made more efficient by using `parsed.files`
async function resolveEntrypoints(dir: string, patterns: string[], parsed: ParsedConfig) {
    const resolvedPatterns = patterns.map(p => {
        const rel = path.relative(
            dir,
            getInputFilename(parsed.rootDir, parsed.cmd.options, path.resolve(dir, p))
        )

        return rel.replace(/\/([^\/*]*\*[^\/*]*\/?)/, '/**/$1')
    })

    // Match `.tsx` as well
    if (parsed.cmd.options.jsx !== undefined) {
        for (const p of resolvedPatterns) {
            const alt = p.replace(/\.ts$/, '.tsx')
            if (p !== alt) {
                resolvedPatterns.push(alt)
            }
        }
    }

    return await glob(getFs(), dir, resolvedPatterns, ['node_modules'])
}

async function resolvePackage(pkg: PackageJson, dir: string, parsed: ParsedConfig) {
    const compiled = resolvePackageEntrypoints(pkg, dir, parsed.rootDir, parsed.cmd.options)

    return { pkg: compiled.packageJson, compiledEntrypoints: compiled.compiledEntrypoints }
    // const patterns = getEntrypointPatterns(pkg)
    // if (patterns.length === 0) {
    //     return { pkg: compiled }
    // }

    // const entrypoints = await resolveEntrypoints(dir, patterns, parsed)

    // return { pkg: compiled, entrypoints }
}

// Creates a package.json file for one-off scripts/experiments/etc.
// This isn't exposed to the user
function createSyntheticPackage(opt?: CompilerOptions, targetFiles?: string[]) {
    return {
        pkg: {
            "synapse": opt?.deployTarget ? {
                "config": {
                  "target": opt.deployTarget,
                },
            } : undefined
        } as PackageJson,
        compiledEntrypoints: undefined as string[] | undefined
    }
}

// Merged left to right (lower -> higher precedence)
function mergeConfigs<T>(...configs: (T | undefined)[]): Partial<T> {
    const res: Partial<T> = {}
    for (const c of configs) {
        if (!c) continue

        for (const [k, v] of Object.entries(c)) {
            if (v !== undefined) {
                res[k as keyof T] = v as any
            }
        }
    }

    return res
}

export async function resolveProgramConfig(opt?: CompilerOptions, targetFiles?: string[], fs = getFs()): Promise<ResolvedProgramConfig> {
    patchTsSys()

    const bt = getBuildTargetOrThrow()
    const [parsed, pkg, previousPkg] = await Promise.all([
        runTask('resolve', 'tsconfig', () => getTsConfig(fs, bt.workingDirectory, targetFiles), 5),
        getFs().readFile(path.resolve(bt.workingDirectory, 'package.json'), 'utf-8').then(JSON.parse).catch(throwIfNotFileNotFoundError),
        getPreviousPkg()
    ])

    const resolvedPkg = pkg !== undefined
        ? await runTask('resolve', 'pkg', () => resolvePackage(pkg, bt.workingDirectory, parsed), 5) 
        : createSyntheticPackage(opt, targetFiles)

    const deployTarget = opt?.deployTarget ?? (previousPkg?.synapse?.config?.target ?? 'local')
    if (deployTarget) {
        const p = resolvedPkg.pkg as any
        const s = p.synapse ??= {}
        s.config ??= {}
        s.config.target ??= deployTarget
    }

    const pkgConfig: CompilerOptions = {
        ...resolvedPkg?.pkg.synapse?.config,
        deployTarget: resolvedPkg?.pkg.synapse?.config?.target,
    }

    const cscOpt: CompilerOptions = {
        includeJs: true,
        generateExports: true,
        excludeProviderTypes: true,
        ...mergeConfigs(pkgConfig, opt), 
    }

    if (cscOpt.stripInternal) {
        parsed.cmd.options.stripInternal = true
    }

    async function getTypeDirs() {
        const typesDir = path.resolve(bt.workingDirectory, 'node_modules', '@types')

        try {
            const dirs = (await fs.readDirectory(typesDir)).filter(f => f.type === 'directory')
    
            return dirs.map(f => f.name).filter(n => n !== 'synapse-providers')
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            return parsed.cmd.options.types
        }    
    }
    
    parsed.cmd.options.types ??= cscOpt.excludeProviderTypes ? await getTypeDirs() : undefined
    parsed.cmd.options.declaration ??= !!cscOpt.sharedLib ? true : undefined

    // By default, we'll only include the bare minimum libs to speed-up program init time
    // Normally `tsc` would include `lib.dom.d.ts` but that file is pretty big
    //
    // We can use `noLib` if we use our own type checker and/or provide our own type defs
    const maybeNeedsDeclaration = parsed.cmd.options.declaration || (resolvedPkg.compiledEntrypoints?.length ?? 0) > 0
    if (!maybeNeedsDeclaration) {
        parsed.cmd.options.noLib = true
        getLogger().log('Using "noLib" for compilation')
    } else {
        parsed.cmd.options.lib ??= libFromTarget(ts.ScriptTarget.ES5)
    }

    const config: ResolvedProgramConfig = {
        tsc: parsed,
        csc: cscOpt,
        pkg: resolvedPkg.pkg,
        compiledEntrypoints: resolvedPkg.compiledEntrypoints,
    }

    // Not awaited intentionally
    saveResolvedConfig(bt.workingDirectory, config)

    getLogger().emitResolveConfigEvent({ config })

    return config
}

const tsOptionsFileName = `[#compile/config]__tsoptions__.json`
const tsOptionsPathKeys =  ['baseUrl', 'configFilePath', 'rootDir', 'outDir'] // This isn't all of them. Update as-needed.

interface ResolvedTsConfig {
    readonly version: string // `tsc` version
    readonly options: ts.CompilerOptions
    readonly sourceHash: string
    readonly include?: string[]
    readonly exclude?: string[]
}

function makeObjRelative<T extends Record<string, any>>(from: string, obj: T, keys: (keyof T)[]): T {
    const set = new Set(keys)
    const copied = { ...obj } as any

    for (const [k, v] of Object.entries(copied)) {
        if (!set.has(k)) continue

        if (typeof v === 'string') {
            copied[k] = path.relative(from, v)
        } else if (Array.isArray(v)) {
            copied[k] = v.map(x => path.relative(from, x))
        }
    }

    return copied
}

// in-place is OK
function resolveObjRelative<T extends Record<string, any>>(from: string, obj: T, keys: (keyof T)[]): T {
    const set = new Set(keys)
    const mut = obj as any

    for (const [k, v] of Object.entries(obj)) {
        if (!set.has(k)) continue

        if (typeof v === 'string') {
            mut[k] = path.resolve(from, v)
        } else if (Array.isArray(v)) {
            mut[k] = v.map(x => path.resolve(from, x))
        }
    }

    return mut
}


async function saveResolvedConfig(workingDir: string, config: ResolvedProgramConfig) {
    const resolved: ResolvedTsConfig = {
        version: ts.version,
        options: makeObjRelative(workingDir, config.tsc.cmd.options, tsOptionsPathKeys),
        sourceHash: config.tsc.sourceHash,
        include: config.tsc.include,
        exclude: config.tsc.exclude,
    }

    await getProgramFs().writeJson(tsOptionsFileName, resolved)
}

export async function getResolvedTsConfig(fs: Pick<JsonFs, 'readJson'> = getProgramFs(), workingDir = getWorkingDir()): Promise<ResolvedTsConfig | undefined> {
    const unresolved: ResolvedTsConfig | undefined = await fs.readJson(tsOptionsFileName).catch(throwIfNotFileNotFoundError)
    if (!unresolved) {
        return
    }

    return {
        version: unresolved.version,
        options: resolveObjRelative(workingDir, unresolved.options, tsOptionsPathKeys),
        sourceHash: unresolved.sourceHash,
        include: unresolved.include,
        exclude: unresolved.exclude,
    }
}

// Only returns different keys
function shallowDiff<T extends Record<string, any>>(a: T, b: T, keys?: Set<keyof T>): Set<(keyof T)> {
    const diff = new Set<keyof T>()
    if (!keys) {
        keys = new Set([...Object.keys(a), ...Object.keys(b)])
    }

    for (const k of keys) {
        const valA = a[k]
        const valB = b[k]
        const type = typeof valA
        if (type !== typeof valB) continue

        if (type !== 'object') {
            if (valA !== valB) {
                diff.add(k)
            }
        } else if (Array.isArray(valA)) {
            if (valA.length !== valB.length) continue

            valA.sort()
            valB.sort()

            for (let i = 0; i < valA.length; i++) {
                if (valA[i] !== valB[i]) {
                    diff.add(k)
                    break
                }
            }
        }

        // TODO: objects
    }

    return diff
}

// TODO: there's more keys that need to be added 
const invalidationKeys = new Set([
    'target',
    'module',
    'outDir',
    'jsx',
    'declaration',
    'stripInternal',
    'declarationMap',
])

// TODO: some changes don't need recompilation
// for example disabling `declaration` can be handled entirely at the emit phase
export function shouldInvalidateCompiledFiles(tsc: ParsedConfig) {
    const prev = tsc.previousOptions
    if (!prev) {
        return false
    }

    const cur = tsc.cmd.options
    const changed = shallowDiff(cur, prev, new Set(invalidationKeys))
    if (changed.size === 0) {
        return false
    }

    getLogger().log('Changed tsconfig keys', changed)
    return true
}

// We exclude the DOM type def automatically unless explicitly added in `lib`
function libFromTarget(target: ts.ScriptTarget) {
    switch (target) {
        case ts.ScriptTarget.ESNext:
            return ['lib.esnext.d.ts']
        case ts.ScriptTarget.ES2022:
            return ['lib.es2022.d.ts']
        case ts.ScriptTarget.ES2021:
            return ['lib.es2021.d.ts']
        case ts.ScriptTarget.ES2020:
            return ['lib.es2020.d.ts']
        case ts.ScriptTarget.ES2019:
            return ['lib.es2019.d.ts']
        case ts.ScriptTarget.ES2018:
            return ['lib.es2018.d.ts']
        case ts.ScriptTarget.ES2017:
            return ['lib.es2017.d.ts']
        case ts.ScriptTarget.ES2016:
            return ['lib.es2016.d.ts']
        case ts.ScriptTarget.ES2015: // same thing as ES6
            return ['lib.es2015.d.ts']
        case ts.ScriptTarget.ES5:
            return ['lib.es5.d.ts']
    }
}

const patchTsSys = memoize(() => {
    // The filepath returned by `getExecutingFilePath` doesn't need to exist
    const libDir = readKeySync('typescript.libDir')
    if (typeof libDir === 'string') {
        ts.sys.getExecutingFilePath = () => path.resolve(libDir, 'cli.js')

        return
    }

    if (!isSelfSea()) {
        return
    }

    const selfPath = getSelfPathOrThrow()
    ts.sys.getExecutingFilePath = () => path.resolve(selfPath, '..', '..', 'dist', 'cli.js')
})

