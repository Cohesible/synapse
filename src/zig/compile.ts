import * as path from 'node:path'
import * as builder from '../build/builder'
import * as github from '../utils/github'
import { runCommand } from "../utils/process"
import { getLogger } from '../logging'
import { getGlobalCacheDirectory, getGlobalZigBuildDir, getTempZigBuildDir, getWorkingDir } from '../workspaces'
import { getFs, getSelfPathOrThrow } from '../execution'
import { ensureDir, getHash, keyedMemoize, makeRelative, memoize, sortRecord, throwIfNotFileNotFoundError } from '../utils'
import { ResolvedProgramConfig, getOutputFilename } from '../compiler/config'
import { getProgramFs, NativeModule } from '../artifacts'
import { AstRoot, ExportedFn, generateTsZigBindings, getExportedFunctions, getImportedModulesFromFile, hasModuleRegistration, renderNode } from './ast'
import { getFileHasher } from '../compiler/incremental'
import { getJsLibPath, getZigPath, registerZigProvider } from './installer'
import { getZigImports } from '../compiler/entrypoints'
import { toAbsolute } from '../build-fs/pointers'
import { extractFileFromZip, listFilesInZip } from '../utils/tar'
import { getCurrentPkg } from '../pm/packageJson'

// FIXME: ReferenceError: Cannot access 'synDirName' before initialization
const getZigCacheDir = () => path.resolve(getGlobalCacheDirectory(), 'zig')

function getOutFile(target: string, rootDir: string, outDir?: string, suffix = '', triplet?: string) {
    const workingDir = getWorkingDir()

    const relPath = path.relative(rootDir, target)
    const outfile = path.resolve(outDir ?? rootDir, relPath).replace(/\.zig$/, suffix)
    const rel = makeRelative(workingDir, outfile)

    if (triplet) {
        return {
            absolute: path.resolve(getTempZigBuildDir(), triplet, rel),
            relative: rel,
        } 
    }

    return {
        absolute: !outDir ? path.resolve(getTempZigBuildDir(), rel) : outfile,
        relative: rel,
    }
}

function renderStub(binaryPath: string) {
    return `
module.exports.main = function main(...args) {
    const child_process = require('node:child_process')
    const proc = child_process.spawn('${binaryPath}', args)

    const stdout = []
    const stderr = []
    proc.stdout?.on('data', chunk => stdout.push(chunk))
    proc.stderr?.on('data', chunk => stderr.push(chunk))

    function getResult(chunks, parse = false) {
        const buf = Buffer.concat(chunks)
        const str = buf.toString('utf-8')

        return parse ? JSON.parse(str) : str
    }

    return new Promise((resolve, reject) => {
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
            if (code !== 0) {
                const err = Object.assign(
                    new Error(\`Non-zero exit code: \${code} [signal \${signal}]\`), 
                    { code, stdout: getResult(stdout), stderr: getResult(stderr) }
                )

                reject(err)
            } else {
                resolve(getResult(stdout, true))
            }
        })
    })
}    
`
}

interface CompileCache {
    files: Record<string, { hash: string; deps?: string[]; isJsImported?: boolean; needsRegistration?: boolean }>
}

const cacheName = `[#compile-zig]__zig-cache__.json`

let compileCache: Promise<CompileCache>|  CompileCache | undefined
function getCache(): Promise<CompileCache> | CompileCache {
    return compileCache ??= getProgramFs().readJson(cacheName).catch(e => {
        throwIfNotFileNotFoundError(e)

        return { files: {} }
    })
}

async function setCache(data: CompileCache): Promise<void> {
    compileCache = data
    await getProgramFs().writeJson(cacheName, data)
}

async function clearCacheEntry(fileName: string) {
    const p = path.relative(getWorkingDir(), path.resolve(getWorkingDir(), fileName))

    const cache = await getCache()
    if (!cache.files[p]) {
        return
    }

    delete cache.files[p]
    await setCache(cache)
}

async function _getZigCompilationGraph(roots: string[], workingDir: string) {
    const zigFiles = new Set<string>()
    const zigImportingFiles = new Set<string>()

    async function addZigImports(f: string) {
        const imports = await getZigImports(makeRelative(workingDir, f))
        if (!imports || imports.length === 0) {
            return
        }

        const dir = path.dirname(f)
        for (const p of imports) {
            zigFiles.add(path.resolve(dir, p))
        }

        zigImportingFiles.add(f)
    }

    await Promise.all(roots.map(addZigImports))

    if (zigFiles.size === 0) {
        return
    }

    const hasher = getFileHasher()
    const cache = await getCache()

    const stack: string[] = []

    async function _visit(f: string) {
        const absPath = path.resolve(workingDir, f)
        const relPath = makeRelative(workingDir, absPath)

        stack.push(absPath)

        const hash = await hasher.getHash(absPath)
        if (cache.files[relPath]?.hash === hash) {
            let didChange = false
            for (const d of cache.files[relPath].deps ?? []) {    
                if (!stack.includes(d) && await visit(d)) {
                    didChange = true
                }
            }    

            stack.pop()

            return didChange
        }

        const { ast, deps } = await getImportedModulesFromFile(absPath)
        asts.set(absPath, ast)

        for (const d of deps) {
            if (!stack.includes(d)) {
                await visit(d)
            }
        }

        if (!cache.files[relPath]) {
            cache.files[relPath] = { hash }
        } else {
            cache.files[relPath].hash = hash
        }

        cache.files[relPath].deps = deps.size > 0 
            ? [...deps].map(d => makeRelative(workingDir, d)) 
            : undefined

        cache.files[relPath].isJsImported = zigFiles.has(f) ? true : undefined

        if (cache.files[relPath].isJsImported && getExportedFunctions(ast).filter(x => x.isModuleExport).length > 0 && !hasModuleRegistration(ast)) {
            cache.files[relPath].needsRegistration = true
        } else {
            cache.files[relPath].needsRegistration = undefined
        }

        stack.pop()
        return true
    }

    const visit = keyedMemoize(_visit)
    const changed = new Set<string>()
    const asts = new Map<string, AstRoot>()

    for (const f of zigFiles) {
        if (await visit(f)) {
            changed.add(f)
        }
    }

    if (changed.size > 0) {
        await setCache(cache)
    }

    return {
        asts,
        files: cache.files,
        changed,
        zigImportingFiles,
    }
}

const graphs = new Map<ReturnType<typeof getProgramFs>, ReturnType<typeof _getZigCompilationGraph>>()
export function getZigCompilationGraph(roots: string[], workingDir: string) {
    const fs = getProgramFs()
    if (graphs.has(fs)) {
        return graphs.get(fs)!
    }

    const res = _getZigCompilationGraph(roots, workingDir)
    graphs.set(fs, res)
    
    return res
}

type CompileTarget = 'wasm' | 'exe' | 'dylib'

function renderWasmStub(relPath: string, bindings: ExportedFn[]) {
    return `
const isSea = !!process.env.BUILDING_SEA

let inst
function getInst() {
    if (inst) {
        return inst
    }

    if (!isSea) {
        return inst = { exports: require('./${relPath}') }
    }
    
    const source = require('raw-sea-asset:./${relPath}')
    const typedArray = new Uint8Array(source.buffer)
    const wasmModule = new WebAssembly.Module(typedArray)

    return inst = new WebAssembly.Instance(wasmModule, { env: {} })
}

function allocCString(str) {
    const b = Buffer.from(str)
    const p = inst.exports.alloc(b.byteLength + 1)
    const mem = new Uint8Array(inst.exports.memory.buffer)
    for (let i = 0; i < b.byteLength; i++) {
        mem[p + i] = b[i]
    }
    mem[p + b.byteLength] = 0
    return p
}

function readCString(p) {
    let i = p
    const mem = new Uint8Array(inst.exports.memory.buffer)
    while (i < mem.byteLength && mem[i] !== 0) i++

    const arr = mem.subarray(p, i)
    const result = Buffer.from(arr).toString('utf-8')
    inst.exports.free_ptr(p, i - p)

    return result
}

${bindings.map(b => {
    const callParams = b.params.map(p => {
        if (p.type === 'string') {
            return `allocCString(${p.name})`
        }
        // TODO: handle signs + widths
        if (p.type === 'number') {
            return p.name
        }

        throw new Error(`Not implemented: ${p.type}`)
    })

    const rt = b.returnType === 'string' ? `readCString(res)` : 'res'

    return `
module.exports['${b.name}'] = function (${b.params.map(p => p.name).join(', ')}) {
    const res = getInst().exports['${b.name}'](${callParams.join(', ')})

    return ${rt}
}
`
}).join('\n')}
`
}

function mapParamName(p: { name: string }) {
    if (p.name === 'this') {
        return '_this'
    }

    return p.name
}

// This makes things a bit more flexible (but slower)
function renderDylibStub(relPath: string, bindings: ExportedFn[]) {
    return `
const isSea = !!process.env.BUILDING_SEA

let didInit = false
function init() {
    if (didInit) {
        return
    }

    const path = require('node:path')
    if (!isSea) {
        const p = path.resolve(__dirname, '${relPath}')
        process.dlopen(module, p)
        didInit = true

        return
    }

    const source = require('raw-sea-asset:./${relPath}')
    const synapseInstall = process.env.SYNAPSE_INSTALL ?? path.resolve(require('node:os').homedir(), '.synapse')
    const name = process.platform === 'win32' ? source.hash + '.synapse' : source.hash
    const dest = path.resolve(synapseInstall, 'cache', 'dlls', name)
    const fs = require('node:fs')
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, new Uint8Array(source.buffer))
    }

    process.dlopen(module, dest)
    didInit = true
}

module.exports['__esModule'] = true

${bindings.map(b => {
    return `
module.exports['${b.name}'] = function (${b.params.filter(x => x.name !== 'this').map(x => x.name).join(', ')}) {
    if (didInit) throw new Error('${b.name} did not initialize')

    init()

    return module.exports['${b.name}'](${b.params.filter(x => x.name !== 'this').map(x => x.name).join(', ')})
}
`
}).join('\n')}
`
}

function renderDylibStubNoSea(relPath: string, bindings: ExportedFn[]) {
    return `
const module = { exports: {} }

let didInit = false
function init() {
    if (didInit) {
        return
    }

    const path = require('node:path');
    let dir = typeof __dirname !== 'undefined' ? __dirname : undefined
    if (!dir) {
        const { fileURLToPath } = require('node:url')
        const __filename = fileURLToPath(import.meta.url)
        dir = path.dirname(__filename)
    }

    const p = path.resolve(dir, '${relPath}')
    process.dlopen(module, p)
    didInit = true
    bind()
}

function bind() {
    ${bindings.map(b => `module.exports['${b.name}'] = module.exports['${b.name}'].bind(module.exports);`).join('\n')}
}

${bindings.map(b => {
    return `
export function ${b.name}(${b.params.map(mapParamName).join(', ')}) {
    init()

    return module.exports['${b.name}'](${b.params.map(mapParamName).join(', ')})
}
`
}).join('\n')}
`
}

registerZigProvider()

async function runZig(sourcefile: string, outfile: string, args: string[]) {
    args.push(`-femit-bin=${outfile}`)
    args.push('--global-cache-dir', getZigCacheDir())

    await ensureDir(path.dirname(outfile))
    await ensureDir(getZigCacheDir()) 

    getLogger().debug(`running zig command:`, args)

    const zigPath = await getZigPath()
    const out = await runCommand(zigPath, args).catch(e => {
        if (!(e as any).stderr) {
            throw e
        }

        const errors: string[] = (e as any).stderr.split('\n')
        const msg = [
            `Failed to compile "${sourcefile}"`,
            ...errors.map(e => `  ${e}`)
        ].join('\n')
        throw new Error(msg)
    })

    if (out.trim()) {
        getLogger().warn(out.trim())
    }
}

async function buildLoadHook() {
     // TODO: this file would need to be included in the app package
    const targetFile = path.resolve('src', 'zig', 'win32', 'load-hook.zig')
    const outfile = path.resolve('dist', 'load-hook.obj')

    await runZig(targetFile, outfile, ['build-obj', targetFile, '-target', 'x86_64-windows'])

    return outfile
}

export async function buildWindowsShim() {
    const targetFile = path.resolve('src', 'zig', 'win32', 'shim.zig')
    const outfile = path.resolve('dist', 'shim.exe')

    await runZig(targetFile, outfile, ['build-exe', targetFile, '-target', 'x86_64-windows', '-O', 'ReleaseSmall'])

    return outfile
}

function getHostTarget(opt: Pick<ResolvedProgramConfig, 'csc'>) {
    const parts = opt.csc.hostTarget?.split('-')
    const os = parts?.[0]
    const arch = parts?.[1]

    return builder.resolveBuildTarget({
        os: os ? os as any : undefined,
        arch: arch ? arch as any : undefined,
    })
}

// Run `zig targets` to see a list
function toZigTarget(target: builder.QualifiedBuildTarget) {
    const parts: string[] = []

    switch (target.arch) {
        case 'x64':
            parts.push('x86_64')
            break

        case 'aarch64':
            parts.push(target.arch)
            break

        default:
            throw new Error(`Architecture not implemented: ${target.arch}`)
    }

    switch (target.os) {
        case 'darwin': {
            const target = process.env.MACOSX_DEPLOYMENT_TARGET
            parts.push(`macos${target ? `.${target}` : ''}`)
            break
        }

        case 'linux':
        case 'windows':
            parts.push(target.os)
            break

        default:
            throw new Error(`OS not implemented: ${target.os}`)
    }

    if (target.os === 'linux') {
        // Zig normally defaults to 'musl'
        const libc = target.libc ?? 'native'
        parts.join(libc)
    }

    return parts.join('-')
}

const getJsLibPathCached = memoize(async () => {
    // XXX: use a file in the source tree when building `synapse`
    const pkg = await getCurrentPkg()
    if (pkg?.data.name === 'synapse') {
        return path.resolve(pkg.directory, 'src/zig/lib/js.zig')
    }

    return getJsLibPath()
})

// TODO: compile test binaries using `--test-no-exec`

export async function passthroughZig(args: string[]) {
    const hostTargetIndex = args.indexOf('--use-host-target')
    if (hostTargetIndex !== -1) {
        const hostTarget = getHostTarget({ csc: {} })
        args.splice(hostTargetIndex, 1, '-target', toZigTarget(hostTarget))
    }

    const zigPath = await getZigPath()
    await runCommand(zigPath, args, { stdio: 'inherit' })
}

async function getPerModuleArgs(
    target: 'wasm' | 'dylib' | 'exe', 
    exported: string[], 
    hostTarget: builder.QualifiedBuildTarget, 
    optimizationMode?: ZigCompileOptions['optimizationMode'], 
    canAddNodeLib = true
) {
    const args: string[] = []
    if (target === 'wasm') {
        args.push('-target', 'wasm32-freestanding-musl')
        if (optimizationMode) {
            args.push('-O', optimizationMode)
        }
        args.push('-fno-entry', ...exported)
    }

    if (target === 'dylib') {
        args.push('-dynamic', '-fallow-shlib-undefined')
        if (optimizationMode) {
            args.push('-O', optimizationMode)
        }

        args.push('-target', toZigTarget(hostTarget))
        if (hostTarget.os === 'windows' && canAddNodeLib) {
            // need to link against a `.lib` file for Windows
            const libPath = await getNodeLib()
            if (libPath) {
                args.push(libPath, '-lc')
            }

            // TODO: using the hook requires the `delayload` MSVC feature e.g. `/delayload node.exe`
            // const hookPath = await buildLoadHook()
            // args.push(hookPath)
        }
    }

    return args
}

function getFastFnName(name: string) {
    const isQuoted = name.startsWith('@"') && name.endsWith('"')
    const rawName = isQuoted ? name.slice(2, -1) : name

    return isQuoted ? `@"${rawName}__fast"` : `${rawName}__fast`
}

function isFastFnName(name: string) {
    const isQuoted = name.startsWith('@"') && name.endsWith('"')
    const rawName = isQuoted ? name.slice(2, -1) : name

    return rawName.endsWith('__fast')
}

function createFastFnDecl(fn: ExportedFn) {
    const params = fn.params.map(p => `${p.name}: ${renderNode(p.typeNode)}`)
    const recv = `__recv: *@import("js").Receiver`
    params.unshift(recv)

    return `
pub fn ${getFastFnName(fn.name)}(${params.join(', ')}) ${renderNode(fn.returnTypeNode)} {
    _ = __recv;
    return ${fn.name}(${fn.params.map(p => p.name).join(', ')});
}
`.trim()
}

export async function preprocessZigModules(roots: string[], workingDir = getWorkingDir()) {
    const graph = await getZigCompilationGraph(roots, workingDir)
    if (!graph) {
        return
    }

    const tmpdir = getTempZigBuildDir()

    async function doCopy(f: string, needsRegistration = false) {
        const absPath = path.resolve(workingDir, f)
        const dest = path.resolve(tmpdir, f)

        if (!needsRegistration) {
            const data = await getFs().readFile(absPath, 'utf-8')

            return await getFs().writeFile(dest, data)
        }

        function getGeneratedCode() {
            const registration = `comptime { @import("js").registerModule(@This()); }`
            const ast = graph!.asts.get(absPath)
            if (!ast) {
                throw new Error(`Missing ast for file: ${f}`)
            }

            const exported = getExportedFunctions(ast)
            const funcNames = new Set(exported.map(x => x.name))
            const decls = exported
                .filter(fn => !isFastFnName(fn.name) && !funcNames.has(getFastFnName(fn.name)))
                .map(fn => createFastFnDecl(fn))

            return [
                ...decls,
                registration,
            ].join('\n')
        }

        const data = await getFs().readFile(absPath, 'utf-8')
        const withCodegen = `${data}\n${getGeneratedCode()}`
        await getFs().writeFile(dest, withCodegen)
    }

    const visited = new Set<string>()
    const promises: Promise<void>[] = []

    function visit(f: string) {
        if (visited.has(f)) return
        visited.add(f)

        const relPath = makeRelative(workingDir, f)
        const info = graph!.files[relPath]
        promises.push(doCopy(relPath, info?.needsRegistration))

        if (info?.deps) {
            for (const d of info.deps) {
                visit(path.resolve(workingDir, d))
            }
        }
    }

    for (const f of graph.changed) {
        visit(f)
    }

    await Promise.all(promises)

    return graph
}

interface ZigCompileOptions {
    readonly outDir?: string
    readonly rootDir?: string
    readonly isSea?: boolean
    readonly hostTarget?: builder.QualifiedBuildTarget
    readonly optimizationMode?: 'Debug' | 'ReleaseSafe' | 'ReleaseFast' | 'ReleaseSmall'
}

export async function compileZigDirect(file: string, opt?: ZigCompileOptions) {    
    const bindings = await generateTsZigBindings(file)

    const exportedModuleFunctions = bindings.exportedFunctions.filter(x => x.isModuleExport)
    const isInternalModule = !!bindings.importedModules.find(x => x.specifier === './lib/js.zig') // XXX: temporary
    const needsRegistration = exportedModuleFunctions.length > 0 && !bindings.isModule && !isInternalModule
    if (needsRegistration) {
        bindings.isModule = true
    }

    const target: CompileTarget = bindings.isModule ? 'dylib' : 'wasm'

    if (bindings.exportedFunctions.length === 0 && !bindings.isModule) {
        throw new Error('Nothing to compile')
    }

    const exported = bindings.exportedFunctions.map(fn => `--export=${fn.name}`)
    const hasJsModule = bindings.importedModules.find(m => m.specifier === 'js') || needsRegistration
    const jsLibPath = hasJsModule ? await getJsLibPathCached() : undefined
    const shouldUseJsLib = !!jsLibPath

    let cmd: string
    switch (target) {
        case 'dylib':
            cmd = 'build-lib'
            break
        case 'wasm':
            cmd = 'build-exe'
            break
    }

    let extname: string | undefined
    switch (target) {
        case 'dylib':
            extname = '.node'
            break
        case 'wasm':
            extname = '.wasm'
            break
    }

    const rootDir = opt?.rootDir ?? getWorkingDir()
    const hostTarget = opt?.hostTarget ?? builder.resolveBuildTarget()
    const triplet = `${hostTarget.arch}-${hostTarget.os}-${hostTarget.libc ?? 'native'}`
    const outfile = getOutFile(file, rootDir, opt?.outDir, extname, triplet)

    const args = [cmd]

    const optMode = opt?.optimizationMode ?? (process.env.SYNAPSE_ENV?.includes('production') ? 'ReleaseFast' : undefined)
    const getArgs = (addLib?: boolean) => getPerModuleArgs(target, exported, hostTarget, optMode, addLib)

    const builtinFilename = await writeSynapseBuiltin({
        features: {
            fast_calls: false,
            threadpool_schedule: false,
            slightly_faster_buffers: false,
        }
    })

    const processedFile = await maybeGetProcessedFilePath(file)

    if (!shouldUseJsLib) {
        args.push(file, ...await getArgs())
    } else {
        args.push(...await getArgs(false))
        args.push('--dep', 'js')
        args.push(`-Mmain=${processedFile}`)

        args.push(...await getArgs())

        args.push('--dep', 'synapse_builtin')
        args.push(`-Mjs=${jsLibPath}`)

        args.push(`-Msynapse_builtin=${builtinFilename}`)
    }

    await runZig(file, outfile.absolute, args)
    
    const compiled = await getFs().readFile(outfile.absolute)

    return {
        compiled,
        stub: opt?.isSea
            ? renderDylibStub(path.basename(outfile.relative), bindings.exportedFunctions)
            : renderDylibStubNoSea(path.basename(outfile.relative), bindings.exportedFunctions),
    }
}

interface Features {
    fast_calls: boolean
    threadpool_schedule: boolean
    slightly_faster_buffers: boolean // lol
}

interface SynapseBuiltinParams {
    readonly features: Features
}

function renderSynapseBuiltin(params: SynapseBuiltinParams) {
    function renderObject(obj: Record<string, any>) {
        const fields = getFields(obj)
        if (fields.length === 0) {
            return `.{}`
        }

        return `.{ ${fields.map(s => `${s}`).join(',')} }`
    }

    function renderArray(obj: any[]) {
        return `.{ ${obj.map(renderVal).join(', ')} }`
    }

    function getFields(obj: Record<string, any>) {
        const fields: string[] = []
        for (const [k, v] of Object.entries(sortRecord(obj))) {
            if (v !== undefined) {
                fields.push(`.${k} = ${renderVal(v)}`)
            }
        }

        return fields
    }

    function renderVal(v: any): string {
        switch (typeof v) {
            case 'string':
                return `"${v}"`
            case 'number':
                return `${v}`
            case 'boolean':
                return `${v}`

            case 'object':
                if (v === null) {
                    return `${v}`
                } else if (Array.isArray(v)) {
                    return renderArray(v)
                }

                return renderObject(v)

            default:
                throw new Error(`Invalid type: ${typeof v}`)
        }
    }

    const lines: string[] = []
    for (const [k, v] of Object.entries(params)) {
        lines.push(`pub const ${k} = ${renderObject(v)};`)
    }

    lines.push('')

    return lines.join('\n')
}

async function writeSynapseBuiltin(params: SynapseBuiltinParams) {
    const text = renderSynapseBuiltin(params)
    const fileName = path.resolve(getGlobalZigBuildDir(), 'synapse_builtin', getHash(text))
    await getFs().writeFile(fileName, text, { flag: 'wx' }).catch(e => {
        if ((e as any).code !== 'EEXIST') {
            throw e
        }
    })

    return fileName
}

async function maybeGetProcessedFilePath(file: string) {
    const relPath = makeRelative(getWorkingDir(), file)
    const processed = path.resolve(getTempZigBuildDir(), relPath)
    const cache = await getCache()
    if (cache.files[relPath]?.needsRegistration) {
        return processed
    }

    return file
}

async function compileZig(file: string, opt: ResolvedProgramConfig, target: CompileTarget = 'wasm', sourceHash?: string) {    
    const bindings = await generateTsZigBindings(file)

    const exportedModuleFunctions = bindings.exportedFunctions.filter(x => x.isModuleExport)
    const isInternalModule = !!bindings.importedModules.find(x => x.specifier === './lib/js.zig') // XXX: temporary
    const needsRegistration = exportedModuleFunctions.length > 0 && !bindings.isModule && !isInternalModule
    if (needsRegistration) {
        bindings.isModule = true
    }

    if (bindings.isModule) {
        target = 'dylib'
    }

    // There's nothing to bind to
    if (bindings.exportedFunctions.length === 0 && !bindings.isModule) {
        return
    }

    const exported = bindings.exportedFunctions.map(fn => `--export=${fn.name}`)
    const hasJsModule = bindings.importedModules.find(m => m.specifier === 'js') || needsRegistration
    const jsLibPath = hasJsModule ? await getJsLibPathCached() : undefined
    const shouldUseJsLib = !!jsLibPath

    let cmd: string
    switch (target) {
        case 'dylib':
            cmd = 'build-lib'
            break
        case 'wasm':
        case 'exe':
            cmd = 'build-exe'
            break
    }

    let extname: string | undefined
    switch (target) {
        case 'dylib':
            extname = '.node'
            break
        case 'wasm':
            extname = '.wasm'
            break
    }

    const rootDir = opt.tsc.rootDir
    const hostTarget = getHostTarget(opt)
    const outfile = getOutFile(file, rootDir, opt.tsc.cmd.options.outDir, extname)

    const args = [cmd]

    const optMode = process.env.SYNAPSE_ENV?.includes('production') ? 'ReleaseFast' : undefined
    const getArgs = (addLib?: boolean) => getPerModuleArgs(target, exported, hostTarget, optMode, addLib)

    const builtinFilename = await writeSynapseBuiltin({
        features: {
            fast_calls: false,
            threadpool_schedule: false,
            slightly_faster_buffers: false,
        }
    })

    const processedFile = await maybeGetProcessedFilePath(file)

    if (!shouldUseJsLib) {
        args.push(processedFile, ...await getArgs())
    } else {
        args.push(...await getArgs(false))
        args.push('--dep', 'js')
        args.push(`-Mmain=${processedFile}`)

        args.push(...await getArgs())

        args.push('--dep', 'synapse_builtin')
        args.push(`-Mjs=${jsLibPath}`)

        args.push(`-Msynapse_builtin=${builtinFilename}`)
    }

    await runZig(file, outfile.absolute, args)

    const stubText = target === 'wasm'
        ? renderWasmStub(path.basename(outfile.relative.replace(/\.o$/, '.wasm')), bindings.exportedFunctions) 
        : target === 'exe' 
            ? renderStub(outfile.relative) 
            : renderDylibStub(path.basename(outfile.relative), bindings.exportedFunctions)

    const promises: Promise<unknown>[] = []
    if (target === 'dylib' || target === 'wasm') {
        if (!opt.csc.noInfra) {
            promises.push(
                getFs().readFile(outfile.absolute).then(
                    data => getProgramFs().writeFile(`[#compile]${outfile.relative}`, data)
                )
            )
        }
    }

    const stubName = getOutputFilename(opt.tsc.rootDir, opt.tsc.cmd.options, file.replace(/\.zig$/, '.zig.ts'))
    if (opt.csc.noInfra) {
        promises.push(getFs().writeFile(stubName, stubText))
    } else {
        // TODO: this can be concurrent with Zig compilation as long as we rollback if it fails
        if (!shouldUseJsLib) {
            promises.push(
                getProgramFs().writeFile(`[#compile]${stubName}`, stubText),
                getProgramFs().writeFile(bindings.typeDefinition.name, bindings.typeDefinition.text),
            )
        } else {
            const source = makeRelative(opt.tsc.rootDir, file)
            const outfile = makeRelative(opt.tsc.rootDir, stubName)
            const m: NativeModule = {
                kind: 'native-module',
                binding: Buffer.from(stubText).toString('base64'),
                bindingLocation: outfile,
                sourceName: source,
                sourceHash,
            }

            async function writeStub() {
                const p = await getProgramFs().writeData('[#compile]', Buffer.from(JSON.stringify(m), 'utf-8'))
                const req = `module.exports = require('${toAbsolute(p)}')`

                return getProgramFs().writeFile(`[#compile]${stubName}`, req, {
                    metadata: { dependencies: [p] }
                })
            }

            promises.push(
                writeStub(),
                getProgramFs().writeFile(bindings.typeDefinition.name, bindings.typeDefinition.text),
            )
        }
    }

    promises.push(getFs().writeFile(bindings.typeDefinition.name, bindings.typeDefinition.text))

    // We need to retain the source code for cross-arch and/or OS builds at deploy-time
    if (shouldUseJsLib) {
        // TODO: collect the source code of depenencies as well
        promises.push(
            getFs().readFile(file).then(d => getProgramFs().writeFile(`[#compile-zig]${file}`, d))
        )
    }

    await Promise.all(promises)

    return {
        zigOutfile: outfile,
        jsOutfile: stubName,
    }
}

export async function compileAllZig(graph: NonNullable<Awaited<ReturnType<typeof getZigCompilationGraph>>>, config: ResolvedProgramConfig) {
    // TODO: see if Zig plays nice with parallel execution
    const workingDir = getWorkingDir()
    for (const f of graph.changed) {
        const hash = graph.files[makeRelative(workingDir, f)].hash
        const res = await compileZig(f, config, undefined, hash).catch(async err => {
            await clearCacheEntry(f)

            throw err
        })

        if (res) {
            getLogger().log('Compiled zig file', res)
        }
    }
}

async function getNodeLib() {
    if (process.env.SYNAPSE_USE_PRIVATE_NODE_LIB) {
        return downloadNodeLib('Cohesible', 'synapse-node-private')
    }

    {
        const dest = path.resolve('dist', 'node.lib')
        if (await getFs().fileExists(dest)) {
            return dest
        }
    }

    const dest = path.resolve(getSelfPathOrThrow(), '..', 'node.lib')
    if (await getFs().fileExists(dest)) {
        return dest
    }
    return downloadNodeLib()
}

export async function downloadNodeLib(owner = 'Cohesible', repo = 'node', parentDir = '.') {
    const dest = path.resolve(parentDir, 'dist', 'node.lib')
    if (await getFs().fileExists(dest)) {
        return dest
    }

    const assetName = 'node-lib-windows-x64'

    async function downloadAndExtract(url: string) {
        const archive = await github.fetchData(url, undefined, true)
        const files = await listFilesInZip(archive)
        if (files.length === 0) {
            throw new Error(`Archive contains no files: ${url}`)
        }
    
        const file = await extractFileFromZip(archive, files[0])
        await getFs().writeFile(dest, file)
        getLogger().log('Downloaded node.lib to', dest)

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