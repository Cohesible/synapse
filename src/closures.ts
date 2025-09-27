import ts from 'typescript'
import * as path from 'node:path'
import { Optimizer, SerializerHost, createPointerMapper, createSerializerHost, createTranspiler, getModuleDeps, getNpmDeps, renderFile } from './bundler'

import type { ExternalValue } from './runtime/modules/serdes'
import type { BundleOptions } from './runtime/modules/lib'

import { getLogger } from './logging'
import { BuildFsFragment, toFs } from './artifacts'
import { DeploymentContext } from './deploy/server'
import {  coerceToPointer, extractPointers, isDataPointer, pointerPrefix } from './build-fs/pointers'
import { getBuildTargetOrThrow, getFs } from './execution'
import { BuildTarget, toProgramRef } from './workspaces'
import { loadBuildState } from './deploy/session'
import { Mutable, getHash, makeExecutable, memoize } from './utils'
import { optimizeSerializedData } from './optimizer'
import { which } from './utils/process'
import { compileZigDirect } from './zig/compile'
import { resolveBuildTarget } from './build/builder'

function replaceGlobals(captured: any, globals: any) {
    if (typeof globals !== 'object' || globals === null) {
        getLogger().log('Globals was not an object', globals)

        return captured
    }

    // Just in case it gets serialized
    if (moveableStr in globals) {
        globals = globals[moveableStr]['properties']
    }

    function visit(obj: any): any {
        if (obj && typeof obj === 'object') {
            if (isDataPointer(obj)) {
                return obj
            }

            for (const [k, v] of Object.entries(obj)) {
                if (k === moveableStr && typeof v === 'object' && !!v) {
                    const desc = v as any
                    if (desc.valueType === 'reflection' && desc.operations[0].type === 'global' && desc.operations.length >= 2) {
                        const target = desc.operations[1]
                        if (target.type === 'get') {
                            const prop = target.property
                            const replacement = globals[prop]
                            if (replacement) {
                                obj[k] = replacement[moveableStr]
                            }
                        }
                    }
                }

                if (obj[k] === v) {
                    obj[k] = replaceGlobals(v, globals)
                }
            }
        }

        return obj
    }

    return visit(captured)
}

const moveableStr = '@@__moveable__'

export interface InternalBundleOptions extends BundleOptions { 
    readonly bundled?: boolean
    readonly moduleTarget?: 'esm' | 'cjs'

    readonly isModule?: boolean
    readonly lazyLoad?: string[]
    // TODO: combine with `lazyLoad`
    readonly lazyLoad2?: string[]

    readonly includeAssets?: boolean


    readonly minify?: boolean
    readonly minifyKeepWhitespace?: boolean
    readonly runtimeExecutable?: string
    readonly sea?: boolean

    /** 
     * @experimental not well tested
     */
    readonly useOptimizer?: boolean

    readonly extraBuiltins?: string[]
}

// TODO: compiler options should be stored in the template
function getCompilerOptions(workingDirectory: string, outputDirectory?: string): ts.CompilerOptions {
    const configFilename = path.join(workingDirectory, 'tsconfig.json')
    const config = ts.sys.readFile(configFilename)
    if (!config) {
        getLogger().log(`No tsconfig.json file found in "${workingDirectory}", using default options`)

        return {
            sourceMap: true,
            alwaysStrict: true,
            rootDir: workingDirectory,
            target: ts.ScriptTarget.ES2020,
            outDir: outputDirectory ?? workingDirectory,
        }
    }

    const res = ts.parseConfigFileTextToJson(configFilename, config)
    if (!res.config) {
        throw new (Error as any)('Bad tsconfig', { cause: res.error })
    }

    const cmd = ts.parseJsonConfigFileContent(res.config, ts.sys, workingDirectory, undefined, configFilename)

    return cmd.options
}

function createDataTable(captured: any) {
    const table: Record<string | number, ({ id: number | string } & ExternalValue)> = {}

    function visit(val: any): any {
        if (Array.isArray(val)) {
            return val.map(visit)
        }

        if (typeof val !== 'object' || !val) {
            return val
        }

        if (isDataPointer(val)) {
            return val
        }

        const result: Record<string, any> = {}
        for (const [k, v] of Object.entries(val)) {
            if (k !== moveableStr || typeof v !== 'object' || !v) {
                result[k] = visit(v)
                continue
            }

            const desc = v as any
            if (typeof desc['id'] === 'number' || typeof desc['id'] === 'string') {
                const id = desc['id']
                table[id] ??= visit(v)
                result[k] = { id }
            } else {
                result[k] = visit(v)
            }
        }
    
        return result
    }

    return {
        table,
        captured: visit(captured),
    }
}

function stripIndirectRefs(obj: ReturnType<typeof createDataTable>) {
    const table: Record<string | number, ExternalValue> = {}
    for (const [k, v] of Object.entries(obj.table)) {
        if (!v.symbols?.['synapse.indirectRefs']) {
            table[k] = v
            continue
        }

        table[k] = {
            ...v,
            symbols: {
                ...v.symbols,
                'synapse.indirectRefs': undefined,
            }
        }
    }

    return table
}

export function normalizeSymbolIds(obj: ReturnType<typeof createDataTable>, includeMapping = false) {
    if (!isDeduped(obj)) {
        return obj
    }

    if (isNormalized(obj)) {
        return obj
    }

    let boundSymbols = 0
    let unboundSymbols = 0
    const symbolMapping = new Map<number | string, string>()

    function getId(symbolId: number | string) {
        const mapped = symbolMapping.get(symbolId)
        if (mapped) {
            return mapped
        }

        const isBound = typeof symbolId === 'string' && symbolId.startsWith('b:') 
        const id = isBound ? `b:${boundSymbols}` : `${unboundSymbols}`
        if (isBound) {
            boundSymbols += 1
        } else {
            unboundSymbols += 1
        }

        symbolMapping.set(symbolId, id)

        return id
    }

    const result = applySymbolMappings(obj, getId)

    return {
        ...result,
        __isNormalized: true,
        mapping: includeMapping ? Object.fromEntries([...symbolMapping].map(([k, v]) => [v, k])) : undefined,
    }
}

function applySymbolMappings(obj: ReturnType<typeof createDataTable>, getId: (symbolId: string | number) => string) {
    function visit(val: any): any {
        if (typeof val !== 'object' || val === null) {
            return val
        }

        if (Array.isArray(val)) {
            return val.map(visit)
        }

        if (isDataPointer(val)) {
            return val
        }

        const result: Record<string, any> = {}
        for (const [k, v] of Object.entries(val)) {
            if (k !== moveableStr || typeof v !== 'object' || v === null) {
                result[k] = visit(v)
                continue
            }

            const desc = v as any
            if (typeof desc['id'] === 'number' || typeof desc['id'] === 'string') {
                result[k] = { id: getId(desc['id']) }
            } else {
                result[k] = visit(v)
            }
        }
    
        return result
    }

    const table: Record<string, ({ id: string } & ExternalValue)> = {}
    for (const [k, v] of Object.entries(obj.table)) {
        const mapped = getId(k)
        if (typeof v === 'object' && v !== null && 'id' in v) {
            v.id = mapped
            if (v.valueType === 'binding') {
                if (typeof v.valueType === 'object') {
                    throw new Error(`Found unexpected object in late binding value: ${JSON.stringify(v.valueType)} [at key ${k}]`)
                }
                ;(v as Mutable<typeof v>).value = getId(v.value!)
                table[mapped] = v as any
                continue
            }    
        }

        table[mapped] = visit(v)
    }

    return {
        ...obj,
        table,
        captured: visit(obj.captured),
    }
}

function denormalizeSymbolIds(obj: ReturnType<typeof createDataTable> & { mapping?: Record<string, string> }) {
    const mapping = obj.mapping
    if (!mapping) {
        return obj
    }

    function getId(symbolId: number | string) {
        return mapping![symbolId] ?? symbolId
    }

    return {
        ...applySymbolMappings(obj, getId),
        mapping: undefined,
    }
}

export async function getImportMap(ctx: Pick<DeploymentContext, 'packageManifest' | 'packageService'>, table: Record<string | number, ExternalValue>) {
    const manifest = ctx.packageManifest
    const npmDeps = getNpmDeps(table, manifest)
    if (Object.keys(npmDeps.roots).length > 0) {
        return ctx.packageService.getImportMap(npmDeps)
    }
}

function getPackageDependencies(ctx: DeploymentContext, table: Record<string | number, ExternalValue>) {
    const manifest = ctx.packageManifest
    const npmDeps = getNpmDeps(table, manifest)
    if (Object.keys(npmDeps.roots).length > 0) {
        return npmDeps
    }
}

function getAmbientDependencies(ctx: DeploymentContext, table: Record<string | number, ExternalValue>) {
    const result = new Set<string>()
    for (const k of getModuleDeps(table)) {
        if (!ctx.packageManifest.roots[k]) {
            result.add(k)
        }
    }
    return result.size > 0 ? Array.from(result) : undefined
}

const findRuntimeExecutable = memoize(async () => {
    const hasNode = await which('node').then(r => true, e => false)
    if (hasNode) {
        return 'node'
    }
    return 'synapse'
})

function createSeaCode() {
    return `
if (!require('node:v8').startupSnapshot.isBuildingSnapshot()) {
    throw new Error("We're building an SEA but we're not building a snapshot")
}
require('node:v8').startupSnapshot.setDeserializeMainFunction(() => {
    return main(...process.argv.slice(2))
})
`.trim()
}

export async function bundleExecutable(
    bt: BuildTarget,
    target: string,
    outfile = target,
    workingDirectory = bt.workingDirectory,
    opt?: InternalBundleOptions
) {
    const { mountedFs, resolver, repo } = await loadBuildState(bt)

    const importDecl = opt?.moduleTarget === 'esm'
        ? `import { main } from './${path.basename(target)}'`
        : `const { main } = require('./${path.basename(target)}')`


    async function getBanner() {
        if (opt?.sea) {
            return ''
        }

        const runtimeExecutable = opt?.runtimeExecutable ?? await findRuntimeExecutable()

        return `#!/usr/bin/env ${runtimeExecutable}`
    }

    const entrypoint = opt?.sea ? createSeaCode() : 'main(...process.argv.slice(2))'
    const contents = [
        await getBanner(),
        importDecl,
        entrypoint,
    ].join('\n')

    // XXX: pretty hacky
    const emitFs = await repo.getRootBuildFs(`${toProgramRef(bt)}-emit`)
    const optimizer = opt?.useOptimizer ? createOptimizer({
        readDataSync: repo.readDataSync,
        writeDataSync: (data) => emitFs.root.writeDataSync(data),
    }) : undefined

    const serializerHost = createSerializerHost(emitFs.root, undefined, optimizer)
    ;(serializerHost as SerializerHost).nativeCompiler = createNativeCompiler(
        workingDirectory, 
        getCompilerOptions(workingDirectory), 
        opt,
    )

    const transpiler = createTranspiler(mountedFs, resolver, {})

    const sourceFileName = path.resolve(workingDirectory, target).replace('.js', '.bundled.js')
    const res = await transpiler.transpile(
        sourceFileName,
        contents,
        outfile,
        { workingDirectory, bundleOptions: { ...opt, serializerHost: serializerHost, bundled: true } }
    )

    await getFs().writeFile(outfile, res.result.contents)
    await makeExecutable(outfile)

    const assets = serializerHost.getAssets()

    return { assets, outfile }
}

export async function bundlePkg(
    target: string,
    workingDirectory: string,
    outfile: string,
    opt?: InternalBundleOptions
) {
    const bt = getBuildTargetOrThrow()
    const { mountedFs, repo, resolver } = await loadBuildState(bt)

    const transpiler = createTranspiler(mountedFs, resolver, {})

    // XXX: pretty hacky
    const emitFs = await repo.getRootBuildFs(`${toProgramRef(bt)}-emit`)
    const serializerHost = createSerializerHost(emitFs.root)
    const sourceFileName = path.resolve(workingDirectory, target)
    const res = await transpiler.transpile(
        sourceFileName,
        await mountedFs.readFile(sourceFileName),
        outfile,
        { workingDirectory, bundleOptions: { ...opt, serializerHost, bundled: true } }
    )

    await getFs().writeFile(outfile, res.result.contents)

    const assets = serializerHost.getAssets()

    return { assets }
}

function createOptimizer(fs: { readDataSync: (hash: string) => Uint8Array; writeDataSync: (data: Uint8Array) => string }): Optimizer {
    return (table, captured) => {
        return optimizeSerializedData(table, captured, (p) => {
            const abs = coerceToPointer(p)
            const obj = JSON.parse(Buffer.from(fs.readDataSync(abs.hash)).toString())
            if (obj.kind === 'deployed') {
                return ts.createSourceFile(abs.hash, '', ts.ScriptTarget.Latest, true)
            }
    
            const data = Buffer.from(obj.runtime, 'base64')
            return ts.createSourceFile(abs.hash, data.toString('utf-8'), ts.ScriptTarget.Latest, true)
        }, fs.writeDataSync)
    }
}

function createNativeCompiler(workingDirectory: string, tsOptions: ts.CompilerOptions, opt?: InternalBundleOptions) {
    const systemTarget = resolveBuildTarget()
    const _arch = opt?.arch ?? systemTarget.arch
    const arch = _arch === 'arm64' ? 'aarch64' : _arch
            
    return (fileName: string) => {
        return compileZigDirect(fileName, {
            isSea: opt?.sea,
            rootDir: tsOptions.rootDir ?? workingDirectory,
            outDir: tsOptions.outDir,
            hostTarget: {
                arch,
                os: opt?.os ?? systemTarget.os,
                libc: opt?.libc ?? systemTarget.libc,
                endianness: opt?.endianness ?? systemTarget.endianness,
            }
        })
    }
}

function gatherPointerDeps(data: { captured: any; table: Record<string | number, any> }) {
    const set = new Set<string>()
    for (const v of Object.values(data.table)) {
        if (v?.valueType === 'function') {
            if (isDataPointer(v.module)) {
                set.add(v.module)
            } else if (v.module.startsWith(pointerPrefix)) {
                set.add(v!.module.slice(pointerPrefix.length))
            }
        } else if (v?.valueType === 'resource') {
            // This is only necessary because we don't automatically treat all data pointers
            // serialized within the data as dependencies. 
            if (typeof v.value === 'object' && !!v.value && moveableStr in v.value) {
                if (v.value[moveableStr]?.valueType === 'reflection') {
                    const ops = v.value[moveableStr].operations
                    if (ops[0].type === 'import') {
                        set.add(ops[0].module)
                    }
                }
            }
        }
    }

    return Array.from(set)
}

function pruneDefineResourceCalls(data: { captured: any; table: Record<string | number, any> }) {
    for (const [k, v] of Object.entries(data.table)) {
        if (typeof v === 'object' && v?.valueType === 'reflection') {
            let ops = v.operations
            if (!Array.isArray(ops)) {
                ops = data.table[ops.id]
            }

            if (ops.length !== 3) continue

            const resolved = ops.map((x: any) => moveableStr in x ? data.table[x[moveableStr].id] : x)
            if (resolved[0].type !== 'import' || resolved[0].module !== 'synapse:core') continue
            if (resolved[1].type !== 'get' || resolved[1].property !== 'defineResource') continue
            if (resolved[2].type !== 'apply') continue

            data.table[k] = null
        }
    }
}

async function mergeNestedResources(
    buildFs: BuildFsFragment,
    data: { captured: any; table: Record<string | number, any>; mapping?: Record<string, string> }
) {
    const reversedMappings = data.mapping ? Object.fromEntries(Object.entries(data.mapping).map(([k, v]) => [v, k])) : undefined

    for (const [k, v] of Object.entries(data.table)) {
        if (typeof v !== 'object' && v?.valueType !== 'resource') continue
        if (typeof v.value !== 'object' || !v.value || !(moveableStr in v.value)) continue
        if (v.value[moveableStr]?.valueType !== 'reflection') continue

        const ops = v.value[moveableStr].operations
        if (ops[0].type !== 'import') continue

        const data2 = await buildFs.readData2(ops[0].module)
        const data3 = denormalizeSymbolIds(data2)
        let canMerge = true

        const mapping: Record<string, string> = {}
        const included: string[] = []

        for (const [k2, v2] of Object.entries(data3.table)) {
            const unmapped = reversedMappings?.[k2]
            if (unmapped) {
                // It's still possible for unrelated objects to end up with the same id
                // TODO: generate prefixed ids grouped by value type to minimize collisions
                if (v2.valueType !== data.table[unmapped].valueType) {
                    canMerge = false
                    break
                }

                mapping[k2] = unmapped 
                continue
            }

            const o = data.table[k2]
            if (!o) {
                included.push(k2)
                continue
            }

            canMerge = false
            break
        }

        if (canMerge) {
            const data4 = denormalizeSymbolIds({ ...data3, mapping })
            data.table[k] = {
                id: k,
                valueType: 'object',
                properties: data4.captured,
            }

            for (const k of included) {
                data.table[k] = data4.table[k]
            }
        }
    }
}

export function prepareDeployedModule(
    ctx: DeploymentContext,
    data: { captured: any; table: Record<string | number, any> },
    bundled?: boolean,
) {
    const dependencies = gatherPointerDeps(data)
    const packageDependencies = !bundled ? getPackageDependencies(ctx, data.table) : undefined

    const ambientDependencies = getAmbientDependencies(ctx, data.table)
    // const data2 = normalizeSymbolIds(data, true)
    // const data3 = extractPointers({ ...data2, mapping: undefined })
    const data3 = extractPointers(data)
    const datafile = {
        kind: 'deployed' as const,
        table: data3[0].table,
        captured: data3[0].captured,
    }

    return {
        datafile,
        metadata: { dependencies, packageDependencies, pointers: data3[1], ambientDependencies },
    }
}

export async function bundleClosure(
    ctx: DeploymentContext,
    buildFs: BuildFsFragment,
    source: string, // TODO: rename to `source`, make optional
    captured: any, 
    globals: any, 
    workingDirectory: string,
    outputDirectory: string,
    opt?: InternalBundleOptions
) {
    if (opt?.platform !== 'browser') {
        captured = replaceGlobals(captured, globals)
    }

    const bundled = opt?.bundled ?? true
    const isArtifact = !bundled && !opt?.destination
    const extname = opt?.moduleTarget === 'esm' ? '.mjs' : '.cjs'

    // TODO: normalize all symbol ids, store a mapping in metadata so it can be reversed
    // This is somewhat similar to position-independent code
    //
    // For custom resource handlers it should be ok to map the symbols without storing anything
    const data = createDataExport(captured)
    if (opt?.isModule) {
        data.table = stripIndirectRefs(data)
    }

    // We have to do this before we render because rendering currently mutates to serialize
    const dependencies = gatherPointerDeps(data)
    const packageDependencies = !bundled ? getPackageDependencies(ctx, data.table) : undefined

    const ambientDependencies = getAmbientDependencies(ctx, data.table)

    if (opt?.isModule) {
        if (!opt.publishName) {
            throw new Error(`Expected module to have a publish name`)
        }

        const data3 = extractPointers(normalizeSymbolIds(data))
        const datafile = {
            kind: 'deployed' as const,
            table: data3[0].table,
            captured: data3[0].captured,
        }

        const p = await buildFs.writeData2(datafile, { source, dependencies, packageDependencies, pointers: data3[1], ambientDependencies })
        const text = `module.exports = require('${p}');`

        return {
            extname,
            location: await buildFs.writeFile(opt.publishName, text, { dependencies: [p] }),
        }
    }

    // TODO: implement hash tree for integrity checks against the 'data' files 

    async function saveArtifact(data: Uint8Array, name?: string, source?: string, pointers?: any) {
        const p = await buildFs.writeData(data, { name, source, dependencies, packageDependencies, pointers, ambientDependencies })
        if (opt?.publishName) {
            if (!isArtifact) {
                return buildFs.writeFile(opt.publishName, data)
            }

            const text = `module.exports = require('${p}');`
            await buildFs.writeFile(opt.publishName, text, { dependencies: [p] })

            return p
        }

        return p
    }

    const compilerOptions = getCompilerOptions(workingDirectory, outputDirectory)
    const outDir = compilerOptions.outDir ?? workingDirectory
    const dest = opt?.destination ?? source.replace(/\.(?:t|j)(sx?)$/, '-bundled.j$1')
    const outfile = path.resolve(outDir, dest)

    if (isArtifact) {
        const name = outfile ? path.relative(workingDirectory, outfile) : undefined
        // await mergeNestedResources(buildFs, data)
        const data3 = extractPointers(normalizeSymbolIds(data))

        const datafile = {
            kind: 'deployed' as const,
            table: data3[0].table,
            captured: data3[0].captured,
        }

        if (!opt?.publishName) {
            return {
                extname,
                location: await buildFs.writeData2(datafile, { source, dependencies, packageDependencies, pointers: data3[1], ambientDependencies })
            }
        }

        const artifactData = Buffer.from(JSON.stringify(datafile), 'utf-8')

        return {
            extname,
            location: await saveArtifact(artifactData, name, source, data3[1]),
        }
    }

    // TODO: we should still add `packageDependencies` even when bundled if modules were marked external
    const importMap = bundled ? await getImportMap(ctx, data.table) : undefined
    const moduleResolver = ctx.createModuleResolver()
    if (importMap) {
        getLogger().debug('Registering import map for bundling', Object.keys(importMap))
        moduleResolver.registerMapping(importMap)
    }

    compilerOptions.alwaysStrict ??= true    

    // FIXME: emit source map separately and attach it as metadata to the artifact instead of inlining
    const transpiler = createTranspiler(
        toFs(workingDirectory, buildFs, ctx.fs), 
        moduleResolver,
        compilerOptions,
    )

    const optimizer = opt?.useOptimizer ? createOptimizer(buildFs) : undefined
    const serializerHost = opt?.includeAssets ? createSerializerHost(buildFs, 'backend-bundle', optimizer) : createPointerMapper()
    if (opt?.includeAssets) {
        (serializerHost as SerializerHost).nativeCompiler = createNativeCompiler(workingDirectory, compilerOptions, opt)
    }

    const sourceFile = renderFile(data, opt?.platform, bundled, opt?.immediatelyInvoke, undefined, isArtifact, serializerHost)
    const sourceFileName = outfile.replace(/\.(?:m)?j(sx?)$/, '.t$1')

    const res = await transpiler.transpile(
        sourceFileName,
        sourceFile,
        outfile,
        { 
            workingDirectory, 
            bundleOptions: { 
                ...opt, 
                bundled, 
                serializerHost, 
                minifyKeepWhitespace: opt?.minify ?? true,
            },
        }
    )    

    const pointer = await saveArtifact(
        res.result.contents,
        path.relative(workingDirectory, outfile),
        source,
    )

    const assets = opt?.includeAssets ? (serializerHost as ReturnType<typeof createSerializerHost>).getAssets() : undefined

    if (opt?.destination === undefined) {
        return {
            assets,
            extname,
            location: pointer, 
        }
    }

    return {
        assets,
        extname,
        location: outfile,
    }
}

export function isDeduped(obj: any): obj is { captured: any; table: Record<string | number, any> } {
    return typeof obj === 'object' && !!obj && obj['__isDeduped']
}

export function isNormalized(obj: any): obj is ReturnType<typeof createDataTable> & { __isNormalized: true } {
    return typeof obj === 'object' && !!obj && obj['__isNormalized']
}

export function createDataExport(captured: any) {
    if (isDeduped(captured)) {
        return captured
    }

    const deduped = createDataTable(captured)

    return {
        table: deduped.table,
        captured: deduped.captured,
    }
}
