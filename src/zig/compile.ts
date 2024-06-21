import * as path from 'node:path'
import * as builder from '../build/builder'
import { runCommand } from "../utils/process"
import { getLogger } from '..'
import { getGlobalCacheDirectory, getRootDir } from '../workspaces'
import { getFs } from '../execution'
import { ensureDir, throwIfNotFileNotFoundError } from '../utils'
import { ResolvedProgramConfig, getOutputFilename } from '../compiler/config'
import { getProgramFs } from '../artifacts'
import { ExportedFn, generateTsZigBindings } from './ast'
import { getFileHasher } from '../compiler/incremental'
import { getZigPath, registerZigProvider } from './installer'
import { downloadNodeLib } from '../cli/buildInternal'

// FIXME: ReferenceError: Cannot access 'synDirName' before initialization
const getZigCacheDir = () => path.resolve(getGlobalCacheDirectory(), 'zig')

function getOutFile(target: string, outDir?: string, suffix = '') {
    const fileName = target.replace(/\.zig$/, suffix)
    if (!outDir) {
        return fileName
    }

    const rootDir = getRootDir()
    const rel = path.relative(rootDir, fileName)

    return path.resolve(outDir, rel)
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
    files: Record<string, { hash: string }>
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

type CompileTarget = 'wasm' | 'exe' | 'dylib' | 'wasm-obj'

function renderWasmStub(relPath: string, bindings: ExportedFn[]) {
    return `
const isSea = !!process.env.BUILDING_SEA

let inst
function getInst() {
    if (inst) {
        return inst
    }
    
    if (isSea) {
        const source = require('raw-sea-asset:./${relPath}');
        const typedArray = new Uint8Array(source.buffer);
        const wasmModule = new WebAssembly.Module(typedArray);

        return inst = new WebAssembly.Instance(wasmModule, { env: {} })
    }

    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.resolve(__dirname, '${relPath}'));
    const typedArray = new Uint8Array(source);
    
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
    if (isSea) {
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

        return;
    }

    const p = require('node:path').resolve(__dirname, '${relPath}');
    process.dlopen(module, p);
    didInit = true;
}

${bindings.map(b => {
    return `
module.exports['${b.name}'] = function (${b.params.map(p => p.name).join(', ')}) {
    init();

    return module.exports['${b.name}'](${b.params.map(p => p.name).join(', ')})
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

    await runZig(targetFile, outfile, ['build-exe', targetFile, '-target', 'x86_64-windows', '-O', 'ReleaseFast'])

    return outfile
}

function getHostTarget(opt: ResolvedProgramConfig) {
    const parts = opt.csc.hostTarget?.split('-')
    const os = parts?.[0]
    const arch = parts?.[1]

    return builder.resolveBuildTarget({
        os: os ? os as any : undefined,
        arch: arch ? arch as any : undefined,
    })
}

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
        case 'darwin':
            parts.push('macos')
            break

        case 'linux':
        case 'windows':
            parts.push(target.os)
            break

        default:
            throw new Error(`OS not implemented: ${target.os}`)
    }

    return parts.join('-')
}

export async function compileZig(file: string, opt: ResolvedProgramConfig, target: CompileTarget = 'wasm') {    
    const c = await getCache()
    const hash = await getFileHasher().getHash(file)
    if (c.files[file]?.hash === hash) {
        return
    }

    const bindings = await generateTsZigBindings(file)
    if (bindings.isModule) {
        target = 'dylib'
    }

    const exports = bindings.exportedFunctions.map(fn => `--export=${fn.name}`)

    let cmd: string
    switch (target) {
        case 'dylib':
            cmd = 'build-lib'
            break
        case 'wasm-obj':
            cmd = 'build-obj'
            break
        case 'wasm':
        case 'exe':
            cmd = 'build-exe'
            break
    }

    let extname: string | undefined
    switch (target) {
        case 'wasm-obj':
            extname = '.o'
            break
        case 'dylib':
            extname = '.node'
            break
        case 'wasm':
            extname = '.wasm'
            break
    }

    // Can be `const` for non-wasm builds
    let outfile = getOutFile(file, opt.tsc.cmd.options.outDir, extname)

    const args = [cmd, file]
    const hostTarget = getHostTarget(opt)

    if (target === 'wasm' || target === 'wasm-obj') {
        args.push('-target', 'wasm32-freestanding-musl')
        args.push('-O', 'ReleaseFast')
    }

    if (target === 'dylib') {
        args.push('-dynamic', '-fallow-shlib-undefined')
        args.push('-O', 'ReleaseFast')

        args.push('-target', toZigTarget(hostTarget))
        if (hostTarget.os === 'windows') {
            // need to link against a `.lib` file for Windows
            const libPath = await downloadNodeLib()
            if (libPath) {
                args.push(libPath)
            }

            // TODO: using the hook requires the `delayload` MSVC feature e.g. `/delayload node.exe`
            // const hookPath = await buildLoadHook()
            // args.push(hookPath)
        }
    }

    if (target === 'wasm') {
        args.push('-fno-entry', ...exports)
    }

    await runZig(file, outfile, args)

    if (bindings.exportedFunctions.length > 0 || bindings.isModule) {
        const wasmOutfile = outfile.replace(/\.o$/, '.wasm')
        const stubText = target === 'wasm' || target === 'wasm-obj'
            ? renderWasmStub(path.basename(wasmOutfile), bindings.exportedFunctions) 
            : target === 'exe' ? renderStub(outfile) : renderDylibStub(path.basename(outfile), bindings.exportedFunctions)
    
        if (target === 'wasm-obj') {
            await runCommand('wasm-ld', ['-S', '--no-entry', ...exports, '-o', wasmOutfile, outfile, '--initial-memory=7340032'])
    
            if (!opt.csc.noInfra) {
                const b = await getFs().readFile(wasmOutfile)
                await getProgramFs().writeFile(`[#compile]${wasmOutfile}`, b)
            }
    
            outfile = wasmOutfile
        }

        if (target === 'dylib' || target === 'wasm') {
            if (!opt.csc.noInfra) {
                const b = await getFs().readFile(outfile)
                await getProgramFs().writeFile(`[#compile]${outfile}`, b)
            }
        }
    
        const stubName = getOutputFilename(opt.tsc.rootDir, opt.tsc.cmd.options, file.replace(/\.zig$/, '.zig.ts'))
        if (opt.csc.noInfra) {
            await getFs().writeFile(stubName, stubText)
        } else {
            await getProgramFs().writeFile(`[#compile]${stubName}`, stubText)
            await getProgramFs().writeFile(bindings.typeDefinition.name, bindings.typeDefinition.text)
        }

        await getFs().writeFile(bindings.typeDefinition.name, bindings.typeDefinition.text)
    }

    c.files[file] = {
        ...c.files[file],
        hash,
    }

    await setCache(c)

    return outfile
}
