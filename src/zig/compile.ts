import * as path from 'node:path'
import * as builder from '../build/builder'
import * as github from '../utils/github'
import { runCommand } from "../utils/process"
import { getLogger } from '../logging'
import { getGlobalCacheDirectory, getGlobalZigBuildDir, getTempZigBuildDir, getWorkingDir } from '../workspaces'
import { getFs } from '../execution'
import { ensureDir, getHash, keyedMemoize, makeRelative, memoize, sortRecord, throwIfNotFileNotFoundError } from '../utils'
import { ResolvedProgramConfig, getOutputFilename } from '../compiler/config'
import { getProgramFs, NativeModule } from '../artifacts'
import { ExportedFn, generateTsZigBindings, getImportedModulesFromFile } from './ast'
import { getFileHasher } from '../compiler/incremental'
import { getJsLibPath, getZigPath, registerZigProvider } from './installer'
import { getZigImports } from '../compiler/entrypoints'
import { toAbsolute } from '../build-fs/pointers'
import { extractFileFromZip, listFilesInZip } from '../utils/tar'

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
    files: Record<string, { hash: string; deps?: string[] }>
}

const cacheName = `[#compile-zig]__zig-cache__.json`

async function getCache(): Promise<CompileCache> {
    return getProgramFs().readJson(cacheName).catch(e => {
        throwIfNotFileNotFoundError(e)

        return { files: {} }
    })
}

async function setCache(data: CompileCache): Promise<void> {
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

    async function _visit(f: string) {
        const absPath = path.resolve(workingDir, f)
        const relPath = path.relative(workingDir, absPath)

        const hash = await hasher.getHash(absPath)
        if (cache.files[relPath]?.hash === hash) {
            let didChange = false
            for (const d of cache.files[relPath].deps ?? []) {    
                if (await visit(d)) {
                    didChange = true
                }
            }    

            return didChange
        }

        const deps = await getImportedModulesFromFile(absPath)
        for (const d of deps) {
            await visit(d)
        }

        if (!cache.files[relPath]) {
            cache.files[relPath] = { hash }
        } else {
            cache.files[relPath].hash = hash
        }

        cache.files[relPath].deps = deps.size > 0 ? [...deps] : undefined

        return true
    }

    const visit = keyedMemoize(_visit)

    const changed = new Set<string>()
    for (const f of zigFiles) {
        if (await visit(f)) {
            changed.add(f)
        }
    }

    if (changed.size > 0) {
        await setCache(cache)
    }

    return {
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
        return inst = { exports: require('./${relPath}') };
    }
    
    const source = require('raw-sea-asset:./${relPath}');
    const typedArray = new Uint8Array(source.buffer);
    const wasmModule = new WebAssembly.Module(typedArray);

    return inst = new WebAssembly.Instance(wasmModule, { env: {} });
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
    while (mem[i] !== 0 && i < mem.byteLength) i++;

    const arr = mem.subarray(p, i)
    return Buffer.from(arr).toString('utf-8')
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

    const path = require('node:path');
    if (!isSea) {
        const p = path.resolve(__dirname, '${relPath}');
        process.dlopen(module, p);
        didInit = true;

        return;
    }

    const source = require('raw-sea-asset:./${relPath}');
    const synapseInstall = process.env.SYNAPSE_INSTALL ?? path.resolve(require('node:os').homedir(), '.synapse');
    const name = process.platform === 'win32' ? source.hash + '.synapse' : source.hash
    const dest = path.resolve(synapseInstall, 'cache', 'dlls', name);
    const fs = require('node:fs');
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, new Uint8Array(source.buffer));
    }

    process.dlopen(module, dest);
    didInit = true;
}

module.exports['__esModule'] = true;

${bindings.map(b => {
    return `
module.exports['${b.name}'] = function (${b.params.filter(x => x.name !== 'this').map(x => x.name).join(', ')}) {
    if (didInit) throw new Error('${b.name} did not initialize');

    init();

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
    const { fileURLToPath } = require('node:url');
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const p = path.resolve(__dirname, '${relPath}');
    process.dlopen(module, p);
    didInit = true;
    bind();
}

function bind() {
    ${bindings.map(b => `module.exports['${b.name}'] = module.exports['${b.name}'].bind(module.exports);`).join('\n')}
}

${bindings.map(b => {
    return `
export function ${b.name}(${b.params.map(mapParamName).join(', ')}) {
    init();

    return module.exports['${b.name}'](${b.params.map(mapParamName).join(', ')})
}
`
}).join('\n')}
`
}

registerZigProvider()

async function runZig(file: string, outfile: string, args: string[]) {
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
            `Failed to compile "${file}"`,
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

const getJsLibPathCached = memoize(getJsLibPath)

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

async function getPerModuleArgs(target: 'wasm' | 'dylib' | 'exe', exported: string[], hostTarget: builder.QualifiedBuildTarget, debug?: boolean, canAddNodeLib = true) {
    const args: string[] = []
    if (target === 'wasm') {
        args.push('-target', 'wasm32-freestanding-musl')
        if (!debug) {
            args.push('-O', 'ReleaseFast')
        }
        args.push('-fno-entry', ...exported)
    }

    if (target === 'dylib') {
        args.push('-dynamic', '-fallow-shlib-undefined')
        if (!debug) {
            args.push('-O', 'ReleaseFast')
        }

        args.push('-target', toZigTarget(hostTarget))
        if (hostTarget.os === 'windows' && canAddNodeLib) {
            // need to link against a `.lib` file for Windows
            const libPath = await downloadNodeLib()
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

interface ZigCompileOptions {
    readonly debug?: boolean
    readonly outDir?: string
    readonly rootDir?: string
    readonly hostTarget?: builder.QualifiedBuildTarget
}

export async function compileZigDirect(file: string, opt?: ZigCompileOptions) {    
    const bindings = await generateTsZigBindings(file)
    const target: CompileTarget = bindings.isModule ? 'dylib' : 'wasm'

    if (bindings.exportedFunctions.length === 0 && !bindings.isModule) {
        throw new Error('Nothing to compile')
    }

    const exported = bindings.exportedFunctions.map(fn => `--export=${fn.name}`)
    const hasJsModule = bindings.importedModules.find(m => m.specifier === 'js')
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

    const getArgs = (addLib?: boolean) => getPerModuleArgs(target, exported, hostTarget, opt?.debug, addLib)

    const builtinFilename = await writeSynapseBuiltin({
        features: {
            fast_calls: false,
            threadpool_schedule: false,
            slightly_faster_buffers: false,
        }
    })

    if (!shouldUseJsLib) {
        args.push(file, ...await getArgs())
    } else {
        args.push(...await getArgs(false))
        args.push('--dep', 'js')
        args.push(`-Mmain=${file}`)

        args.push(...await getArgs())

        args.push('--dep', 'synapse_builtin')
        args.push(`-Mjs=${jsLibPath}`)

        args.push(`-Msynapse_builtin=${builtinFilename}`)
    }

    await runZig(file, outfile.absolute, args)
    
    const compiled = await getFs().readFile(outfile.absolute)

    return {
        compiled,
        stub: renderDylibStubNoSea(path.basename(outfile.relative), bindings.exportedFunctions),
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

    return `pub const features = ${renderObject(params.features)};\n`
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

async function compileZig(file: string, opt: ResolvedProgramConfig, target: CompileTarget = 'wasm') {    
    const bindings = await generateTsZigBindings(file)
    if (bindings.isModule) {
        target = 'dylib'
    }

    // There's nothing to bind to
    if (bindings.exportedFunctions.length === 0 && !bindings.isModule) {
        return
    }

    const exported = bindings.exportedFunctions.map(fn => `--export=${fn.name}`)
    const hasJsModule = bindings.importedModules.find(m => m.specifier === 'js')
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

    const getArgs = (addLib?: boolean) => getPerModuleArgs(target, exported, hostTarget, opt.csc.debug, addLib)

    const builtinFilename = await writeSynapseBuiltin({
        features: {
            fast_calls: true,
            threadpool_schedule: false,
            slightly_faster_buffers: false,
        }
    })

    if (!shouldUseJsLib) {
        args.push(file, ...await getArgs())
    } else {
        args.push(...await getArgs(false))
        args.push('--dep', 'js')
        args.push(`-Mmain=${file}`)

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

export async function compileAllZig(files: string[], config: ResolvedProgramConfig) {
    // TODO: see if Zig plays nice with parallel execution
    for (const f of files) {
        const res = await compileZig(f, config).catch(async err => {
            await clearCacheEntry(f)

            throw err
        })

        if (res) {
            getLogger().log('Compiled zig file', res)
        }
    }
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