import * as path from 'node:path'
import { createTrie, isWindows } from '../utils'
import { ImportMap, SourceInfo } from './importMaps'
import { suite, test, expectEqual } from 'synapse:test'

type LocationType = 'module' | 'package'

interface Mapping {
    readonly virtualLocation: string
    readonly physicalLocation: string
    readonly locationType?: LocationType
}

export interface MapNode {
    readonly location: string
    readonly locationType?: LocationType
    readonly mappings: Record<string, Mapping>
    readonly source?: SourceInfo
}

export function createLookupTable() {
    const sep = path.sep
    const isWin = isWindows()
    const trie = createTrie<MapNode, string[]>()
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
        if (isWin) {
            location = location[0] === '\\' ? location : `\\${location}`
        }

        const cached = locationKeys.get(location)
        if (cached !== undefined) {
            return cached
        }

        const segments = location.split(sep)
        const trimmed = location.endsWith(sep) ? segments.slice(-1) : segments
        locationKeys.set(location, trimmed)

        return trimmed
    }

    function updateNode(key: string[], map: ImportMap, location: string, rootKey = key, locationType?: LocationType, source?: SourceInfo, visited = new Set<ImportMap>) {
        if (visited.has(map)) return
        visited.add(map)

        const mappings = trie.get(key)?.mappings ?? {}
        trie.insert(key, { location, locationType, mappings, source })

        for (const [k, v] of Object.entries(map)) {
            const ck = getMapKey(v)
            const key = [...rootKey, ck]
            const virtualLocation = key.join(sep)
            locationKeys.set(virtualLocation, key)
            mappings[k] = {
                virtualLocation,
                physicalLocation: v.location,
                locationType: v.locationType,
            }

            // Sift the mapping upwards to simulate node
            // TODO: this is only needed because of `specifier` in `getSourceWithRemainder`
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
        const stack = trie.traverseAll(getLocationKey(location))

        while (stack.length > 0) {
            const v = stack.pop()!.mappings[specifier]
            if (v) {
                return v
            }
        }
    }

    function resolve(location: string) {
        const key = getLocationKey(location)
        const stack: (MapNode | undefined)[] = []
        for (const v of trie.traverse(key)) {
            stack.push(v)
        }

        const last = stack.pop()
        if (!last || last.location === sep) {
            return location
        }

        // We add 1 because we popped the stack
        const suffix = key.slice(stack.length + 1)
        if (last.locationType === 'module' && suffix.length > 0) {
            return [path.dirname(last.location), ...suffix].join(sep)
        }

        return [last.location, ...suffix].join(sep)
    }

    function registerMapping(map: ImportMap, location: string = sep) {
        const key = getLocationKey(location)
        updateNode(key, map, location)
    }

    function getSource(location: string) {
        const key = getLocationKey(location)
        const stack: (MapNode | undefined)[] = []
        for (const v of trie.traverse(key)) {
            stack.push(v)
        }

        return stack[stack.length - 1]
    }

    function getSourceWithRemainder(location: string) {
        const key = getLocationKey(location)
        const stack = trie.traverseAll(key)

        const node = stack[stack.length - 1]
        if (!node) {
            return
        }

        let specifier: string | undefined
        let virtualLocation: string | undefined
        if (stack.length > 1) {
            const prior = stack[stack.length - 2].mappings
            for (const k of Object.keys(prior)) {
                if (prior[k].physicalLocation === node.location) {
                    specifier = k
                    virtualLocation = prior[k].virtualLocation
                    break
                }
            }
        }

        return {
            node,
            specifier,
            remainder: virtualLocation ? location.slice(virtualLocation.length + 1) : undefined, 
        }
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

    return { lookup, resolve, registerMapping, getSource, getSourceWithRemainder, inspect }
}

// FIXME: build needs to ignore this
// suite('lookup table', () => {
//     interface PointerMapping {
//         readonly type: 'pointer'
//         readonly hash: string
//         readonly metadataHash: string
//         readonly mappings?: Record<string, MappingFragment>
//     }
    
//     interface PackageMapping {
//         readonly type: 'package'
//         readonly dir: string
//         readonly mappings?: Record<string, MappingFragment>
//     }
    
//     type MappingFragment = PointerMapping | PackageMapping
    
//     function renderFragment(f: MappingFragment): ImportMap[string] {
//         const mapping = f.mappings ? renderMappings(f.mappings) : undefined
//         switch (f.type) {
//             case 'pointer':
//                 return {
//                     location: `pointer:${f.metadataHash}:${f.hash}`,
//                     locationType: 'module',
//                     mapping,
//                 }
//             case 'package':
//                 return {
//                     location: f.dir,
//                     locationType: 'package',
//                     mapping,
//                 }
//         }
//     }
    
//     function renderMappings(m: Record<string, MappingFragment>): ImportMap {
//         return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, renderFragment(v)]))
//     }
    
//     function makePointerMapping(hash: string, metadataHash: string, mappings?: Record<string, MappingFragment>): PointerMapping {
//         return { type: 'pointer', hash, metadataHash, mappings }
//     }
    
//     function makePackageMapping(dir: string, mappings?: Record<string, MappingFragment>): PackageMapping {
//         return { type: 'package', dir, mappings }
//     }

//     function setupTable() {
//         const cwd = path.resolve()
//         const t = createLookupTable()
    
//         t.registerMapping(renderMappings({
//             'pointer:1': makePointerMapping('1', '100', {
//                 'pointer:2': makePointerMapping('2', '100', {
//                     'test': makePackageMapping(cwd)
//                 })
//             })
//         }))
    
//         const x1 = t.lookup('pointer:1', cwd)
//         expectEqual(x1?.physicalLocation, 'pointer:100:1')
    
//         const x2 = t.lookup('pointer:2', x1.virtualLocation)
//         expectEqual(x2?.physicalLocation, 'pointer:100:2')
    
//         const x3 = t.lookup('test', x2.virtualLocation)
//         expectEqual(x3?.physicalLocation, cwd)

//         return { t, cwd, x1, x2, x3 }
//     }

//     test('root mappings (pointer)', () => {
//         setupTable()
//     })

//     test('resolve virtual package', () => {
//         const { t, cwd, x3 } = setupTable()

//         const pkgFile = path.join(x3.virtualLocation, 'dist', 'x.js')
//         const x4 = t.resolve(pkgFile)
//         expectEqual(x4, path.join(cwd, 'dist', 'x.js'))

//         const s = t.getSourceWithRemainder(pkgFile)
//         expectEqual(s?.node.location, cwd)
//         expectEqual(s.remainder, path.join('dist', 'x.js'))
//         expectEqual(s.specifier, 'test')
//     })

//     test('resolve non-root', () => {
//         const cwd = path.resolve()
//         const t = createLookupTable()
    
//         t.registerMapping(renderMappings({
//             'test': makePackageMapping(path.resolve(cwd, 'x1'))
//         }), path.join(cwd, 'd1'))
    
//         t.registerMapping(renderMappings({
//             'test': makePackageMapping(path.resolve(cwd, 'x2'))
//         }), path.join(cwd, 'd2'))

//         expectEqual(t.lookup('test', cwd), undefined)

//         const x1 = t.lookup('test', path.join(cwd, 'd1'))
//         expectEqual(x1?.physicalLocation, path.resolve(cwd, 'x1'))

//         const x2 = t.lookup('test', path.join(cwd, 'd2'))
//         expectEqual(x2?.physicalLocation, path.resolve(cwd, 'x2'))

//         // Nested check
//         expectEqual(
//             t.lookup('test', path.join(cwd, 'd2', 'a'))?.physicalLocation, 
//             path.resolve(cwd, 'x2')
//         )

//         const nested = path.join(x2.virtualLocation, 'foo', 'bar')
//         expectEqual(t.resolve(nested), path.resolve(cwd, 'x2', 'foo', 'bar'))
//     })


//     test('merging', () => {
//         const cwd = path.resolve()
//         const t = createLookupTable()
    
//         t.registerMapping(renderMappings({
//             'test1': makePackageMapping(path.resolve(cwd, 'x1'))
//         }), cwd)
    
//         t.registerMapping(renderMappings({
//             'test2': makePackageMapping(path.resolve(cwd, 'x2'))
//         }), cwd)

//         expectEqual(t.lookup('test', cwd), undefined)

//         const x1 = t.lookup('test1', cwd)
//         expectEqual(x1?.physicalLocation, path.resolve(cwd, 'x1'))

//         const x2 = t.lookup('test2', cwd)
//         expectEqual(x2?.physicalLocation, path.resolve(cwd, 'x2'))
//     })
// })
