import * as path from 'node:path'
import { isBuiltin } from 'node:module'
import { SyncFs } from '../system'
import { getSpecifierComponents, resolveBareSpecifier, resolvePrivateImport } from '../pm/packages'
import { createTrie, isRelativeSpecifier, keyedMemoize, throwIfNotFileNotFoundError } from '../utils'
import { ImportMap, SourceInfo } from './importMaps'
import { PackageJson } from '../pm/packageJson'
import { isDataPointer } from '../build-fs/pointers'
import { getLogger } from '../logging'

const pointerPrefix = 'pointer:'
export const synapsePrefix = 'synapse:'
export const providerPrefix = 'synapse-provider:'

type LocationType = 'module' | 'package'

interface Mapping {
    readonly virtualLocation: string
    readonly physicalLocation: string
    readonly locationType?: LocationType
}

export interface MapNode<T = unknown> {
    readonly location: string
    readonly locationType?: LocationType
    readonly mappings: Record<string, Mapping>
    readonly source?: T
}

function createLookupTable<T = unknown>() {
    const trie = createTrie<MapNode<T>, string[]>()
    const keys = new Map<ImportMap[string], string>()

    function getMapKey(map: ImportMap[string]) {
        if (keys.has(map)) {
            return keys.get(map)!
        }

        const k = `__vp${keys.size}`
        keys.set(map, k)

        return k
    }

    const locationKeys = new Map<string, string[]>()
    function getLocationKey(location: string): string[] {
        const cached = locationKeys.get(location)
        if (cached !== undefined) {
            return cached
        }

        const segments = location.split(path.sep)
        const trimmed = location.endsWith(path.sep) ? segments.slice(-1) : segments
        locationKeys.set(location, trimmed)

        return trimmed
    }

    function updateNode(key: string[], map: ImportMap<T>, location: string, rootKey = key, locationType?: LocationType, source?: T, visited = new Set<ImportMap<T>>) {
        if (visited.has(map)) return
        visited.add(map)

        const mappings = trie.get(key)?.mappings ?? {}
        trie.insert(key, { location, locationType, mappings, source })

        for (const [k, v] of Object.entries(map)) {
            const ck = getMapKey(v)
            const key = [...rootKey, ck]
            const virtualLocation = key.join(path.sep)
            locationKeys.set(virtualLocation, key)
            mappings[k] = {
                virtualLocation,
                physicalLocation: v.location,
                locationType: v.locationType,
            }

            // Sift the mapping upwards to simulate node (TODO: is this still needed?)
            if (key !== rootKey) {
                const m = trie.get(rootKey)?.mappings
                if (m && !m[k]) {
                    m[k] = mappings[k]
                }
            }

            updateNode(key, v.mapping ?? {}, v.location, rootKey, v.locationType, v.source, new Set([...visited]))
        }
    }

    function lookup(specifier: string, location: string): Mapping | undefined {
        const key = getLocationKey(location)
        const stack: (readonly [string, MapNode | undefined])[] = []
        for (const n of trie.traverse(key)) {
            stack.push(n)
        }

        while (stack.length > 0) {
            const [k, m] = stack.pop()!
            const v = m?.mappings[specifier]
            if (v) {
                return v
            }
        }
    }

    function resolve(location: string) {
        const key = getLocationKey(location)
        const stack: (MapNode | undefined)[] = []
        for (const [k, v] of trie.traverse(key)) {
            stack.push(v)
        }

        const last = stack.pop()
        if (!last || last.location === '/') {
            return location
        }

        // We add 1 because we popped the stack
        const suffix = key.slice(stack.length + 1)
        if (last.locationType === 'module' && suffix.length > 0) {
            return [path.dirname(last.location), ...suffix].join(path.sep)
        }

        return [last.location, ...suffix].join(path.sep)
    }

    function registerMapping(map: ImportMap<T>, location: string = '/') {
        const key = getLocationKey(location)
        updateNode(key, map, location)
    }

    function getSource(location: string) {
        const key = getLocationKey(location)
        const stack: (MapNode<T> | undefined)[] = []
        for (const [k, v] of trie.traverse(key)) {
            stack.push(v)
        }

        return stack[stack.length - 1]
    }

    function inspect() {
        function visit(key?: string[], value?: MapNode, depth = 0) {
            for (const k of trie.keys(key)) {
                const nk = key ? [...key, k] : [k]
                const value = trie.get(nk)
                console.log(`${' '.repeat(depth + 1)} -- ${k} -- ${value?.location}`)

                visit(nk, value, depth + 1)
            }
        }

        visit()
    }

    return { lookup, resolve, registerMapping, getSource, inspect }
}

export interface PatchedPackage {
    readonly name: string
    // readonly version?: string
    readonly files: Record<string, (contents: string) => string>
}

export type ModuleTypeHint =  'cjs' | 'esm' | 'native' | 'pointer' | 'builtin' | 'json' | 'sea-asset' | 'wasm'

// Module resolution has two phases:
// 1. Determine the _virtual_ file that a specifier + location maps to
// 2. Resolve the virtual file to a location on disk to get its contents

// Virtual files represent a specific instantiation of a module. Two files may have the
// exact same source code but have different import maps. So they must be treated as 
// separate entities.

export type ModuleResolver = ReturnType<typeof createModuleResolver>
export function createModuleResolver(fs: Pick<SyncFs, 'readFileSync' | 'fileExistsSync'>, workingDirectory: string, includeTs = false) {
    const lookupTable = createLookupTable<SourceInfo>()
    const globals: Record<string, string> = {}
    const resolvedSubpaths = new Map<string, string>()

    const getPackage = keyedMemoize(function (dir: string): { data: PackageJson, filePath: string } {
        const filePath = path.resolve(dir, 'package.json')
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

        return { data, filePath }
    })

    const packageMap = new Map<string, string>()
    function getCurrentPackage(location: string) {
        try {
            return getPackage(location)
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            const next = path.dirname(location)
            if (next !== location) {
                return getCurrentPackage(next)
            }

            throw e
        }
    }

    function resolveProvider(specifier: string, importer: string) {
        const res = lookupTable.lookup(specifier, importer)
        if (!res) {
            throw new Error(`Failed to resolve provider: ${specifier} [${importer ?? workingDirectory}]`)
        }

        const resolved = res.physicalLocation
        const pkg = path.resolve(resolved, 'package.json')
        const pkgData = JSON.parse(fs.readFileSync(pkg, 'utf-8'))

        return {
            location: resolved,
            module: path.resolve(resolved, pkgData.exports['.']),
            name: pkgData.name,
            source: pkgData.source,
            version: pkgData.version,
        }
    }

    function resolveRelative(specifier: string, location: string) {
        const extname = path.extname(specifier)
        const absPath = path.resolve(location, specifier)

        if (extname === '.js' || extname === '.json') { // TODO: .cjs/.mjs ??
            return absPath
        }

        const candidates = [
            `${absPath}${path.sep}index.js`,
            `${absPath}${path.sep}index.json`,
            absPath
        ]

        if (includeTs) {
            if (extname === '.ts') {
                return absPath
            }

            candidates.unshift(`${absPath}${path.sep}index.ts`)
        }
    
        if (specifier !== '.') {
            candidates.unshift(`${absPath}.infra.js`) // XXX: needed when not compiling with `--include-js`
            candidates.unshift(`${absPath}.json`)
            candidates.unshift(`${absPath}.js`)
            // candidates.unshift(`${absPath}.node`)

            if (includeTs) {
                candidates.unshift(`${absPath}.ts`)
            }
        }

        for (const p of candidates) {
            if (fs.fileExistsSync(p)) {
                // handles relative self-referential imports
                if (p === absPath && !extname) {
                    try {
                        const pkg = getPackage(absPath)
                        if (pkg.data.main) {
                            return path.resolve(absPath, pkg.data.main)
                        }
                    } catch {}
                }
                return p
            }
        }

        if (extname === '.node' || extname === '.wasm') {
            return absPath
        }

        throw new Error(`Failed to resolve module: ${specifier} [importer: ${location}]`)
    }

    function resolveWorker(specifier: string, importer?: string, mode: 'cjs' | 'esm' = 'cjs'): string | [fileName: string, typeHint: ModuleTypeHint] {
        if (isBuiltin(specifier)) {
            return specifier
        }

        if (globals[specifier]) {
            return specifier
        }

        if (specifier.startsWith(pointerPrefix)) {
            if (isDataPointer(specifier)) {
                return [specifier, 'pointer']
            }

            const res = lookupTable.lookup(specifier, importer ?? workingDirectory)
            if (res !== undefined) {
                return res.virtualLocation
            }

            return specifier
        }

        const getLocation = () => importer ? path.dirname(lookupTable.resolve(importer)) : workingDirectory

        if (specifier.startsWith(providerPrefix)) {
            // FIXME: there _might_ be a really weird race condition where metadata is lost on pointers when coming from TF (?)
            // Looking up the specifier inside the working dir means we failed to resolve specifiers from metadata
            const res = lookupTable.lookup(specifier, importer ?? workingDirectory) ?? lookupTable.lookup(specifier, workingDirectory)
            if (!res) {
                throw new Error(`Failed to resolve provider: ${specifier} [${importer ?? workingDirectory}]`)
            }

            const resolved = res.physicalLocation
            const pkg = path.resolve(resolved, 'package.json')
            const pkgData = JSON.parse(fs.readFileSync(pkg, 'utf-8'))

            return path.resolve(resolved, pkgData.exports['.'])
        }

        if (isRelativeSpecifier(specifier)) {
            if (!importer) {
                return resolveRelative(specifier, getLocation())
            }

            if (globals[importer]) {
                return resolveRelative(specifier, path.dirname(globals[importer]))
            }
    
            const resolvedImporter = lookupTable.resolve(importer)
            const filePath = path.dirname(resolvedImporter)
            const res = resolveRelative(specifier, filePath)
            const rel = path.relative(filePath, res)

            return path.join(path.dirname(importer), rel)
        }

        const components = getSpecifierComponents(specifier)
        const key = components.scheme ? `${components.scheme}:${components.name}` : components.name
        const res = lookupTable.lookup(key, importer ?? workingDirectory)
        if (res !== undefined) {
            const filePath = res.physicalLocation
            if (res.locationType === 'module') {
                return filePath
            }

            const pkg = getPackage(filePath)
            packageMap.set(pkg.filePath, res.virtualLocation) // Only used for private subpath imports
            resolvePatches(pkg)

            const rel = resolveBareSpecifier(specifier, pkg.data, mode)
            const absPath = resolveRelative(rel.fileName, filePath)
            const virtualId = path.join(res.virtualLocation, path.relative(filePath, absPath))
            if (components.export) {
                resolvedSubpaths.set(virtualId, components.export)
            }

            return [virtualId, rel.moduleType]
        }

        if (specifier[0] === '#') {
            const filePath = lookupTable.resolve(getLocation())
            const pkg = getCurrentPackage(filePath)
            const rel = resolvePrivateImport(specifier, pkg.data, mode)
            const absPath = resolveRelative(rel.fileName, filePath)
            const virtualId = path.join(packageMap.get(pkg.filePath) ?? path.dirname(pkg.filePath), path.relative(filePath, absPath))

            return [virtualId, rel.moduleType]
        }

        if (path.isAbsolute(specifier)) {
            return specifier
        }

        getLogger().debug(`failed to resolve ${specifier} from ${importer}`)

        if (importer?.startsWith(pointerPrefix)) {
            return nodeModulesResolve(workingDirectory, specifier, components, mode)
        }

        return nodeModulesResolve(getLocation(), specifier, components, mode)
    }

    const pkgCache: Record<string, ReturnType<typeof getPackage>> = {}
    function findPkg(dir: string, name: string) {
        const key = `${dir}:${name}`
        const cached = pkgCache[key]
        if (cached) {
            return cached
        }
    
        const pkgPath = path.resolve(dir, 'node_modules', name)

        try {
            return pkgCache[key] = getPackage(pkgPath)
        } catch (e) {
            throwIfNotFileNotFoundError(e)

            const next = path.dirname(dir)
            if (next !== dir) {
                return findPkg(next, name)
            }

            // TODO: add stack
            throw new Error(`Failed to resolve package: ${name}`)
        }
    }

    function nodeModulesResolve(dir: string, specifier: string, components: ReturnType<typeof getSpecifierComponents>, mode: 'cjs' | 'esm' = 'cjs'): [fileName: string, typeHint: ModuleTypeHint] {
        const pkg = findPkg(dir, components.name)
        const rel = resolveBareSpecifier(specifier, pkg.data, mode)
        const absPath = resolveRelative(rel.fileName, path.dirname(pkg.filePath))

        return [absPath, rel.moduleType]
    }

    function resolveVirtual(specifier: string, importer?: string, mode: 'cjs' | 'esm' = 'cjs') {
        try {
            const resolved = resolveWorker(specifier, importer, mode)

            return typeof resolved === 'string' ? resolved : resolved[0]
        } catch (e) {
            throw Object.assign(
                new Error(`Failed to resolve ${specifier} from ${importer} [mode: ${mode}]`, { cause: e }),
                { code: 'MODULE_NOT_FOUND' } // node compat
            )
        }
    }

    function resolveVirtualWithHint(specifier: string, importer?: string, mode: 'cjs' | 'esm' = 'cjs') {
        try {
            return resolveWorker(specifier, importer, mode)
        } catch (e) {
            throw Object.assign(
                new Error(`Failed to resolve ${specifier} from ${importer} [mode: ${mode}]`, { cause: e }),
                { code: 'MODULE_NOT_FOUND' } // node compat
            )
        }
    }

    function getFilePath(id: string) {
        if (globals[id]) {
            return globals[id]
        }

        return lookupTable.resolve(id)
    }

    function resolve(specifier: string, importer?: string) {
        return getFilePath(resolveVirtual(specifier, importer))
    }

    const patches = new Map<string, PatchedPackage>()
    const resolved = new Set<string>()
    const resolvedPatches = new Map<string, PatchedPackage['files'][string]>()
    function getPatchFn(resolvedPath: string) {
        return resolvedPatches.get(resolvedPath)
    }    

    function registerPatch(patch: PatchedPackage) {
        if (patches.has(patch.name)) {
            throw new Error(`Patch already registered for package: ${patch.name}`)
        }
        
        patches.set(patch.name, patch)
    }

    function resolvePatches(pkg: ReturnType<typeof getPackage>) {
        const patch = patches.get(pkg.data.name)
        if (!patch || resolved.has(pkg.filePath)) {
            return
        }

        for (const [k, v] of Object.entries(patch.files)) {
            const resolved = path.resolve(path.dirname(pkg.filePath), k)
            resolvedPatches.set(resolved, v)
        }

        resolved.add(pkg.filePath)
    }

    function registerGlobals(mapping: Record<string, string>) {
        for (const [k, v] of Object.entries(mapping)) {
            if (globals[k] && globals[k] !== v) {
                throw new Error(`Conflicting global module mapping for "${k}": ${v} [new] !== ${globals[k]} [existing]`)
            }
            globals[k] = v
        }
    }

    function getInverseGlobalsMap() {
        return Object.fromEntries(Object.entries(globals).map(e => e.reverse())) as Record<string, string>
    }

    function getSource(location: string): (MapNode<SourceInfo> & { subpath?: string }) | undefined {
        const source = lookupTable.getSource(location)
        if (!source) {
            return
        }

        const subpath = resolvedSubpaths.get(location)
        if (subpath) {
            return Object.assign({ subpath }, source)
        }

        return source
    }

    return { 
        resolve,
        resolveVirtual, 
        resolveVirtualWithHint,
        resolveProvider,
        getFilePath,
        registerMapping: lookupTable.registerMapping,

        // PATCHING
        registerPatch,
        getPatchFn,

        // GLOBAL SPECIFIERS
        registerGlobals,
        getInverseGlobalsMap,

        // MISC
        getSource,
    }
}

export function createImportMap(map: Record<string, string>, prefix: string = ''): ImportMap {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [`${prefix}${k}`, { location: v, versionConstraint: '*' }] as const))
}