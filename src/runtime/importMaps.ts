import { getLogger } from '../logging'
import { Mutable } from '../utils'
import { PackageInfo } from './modules/serdes'

function _showImportMap(m: ImportMap, printSourceInfo?: (source: SourceInfo) => string) {
    function render(map: ImportMap, depth = 0) {
        for (const [k, v] of Object.entries(map)) {
            const source = v.source ? printSourceInfo?.(v.source) : undefined
            getLogger().log(`${'  '.repeat(depth)}${depth ? '|__ ' : ''}${k}${source ? ` - ${source}` : ''}`)
            if (v.mapping) {
                render(v.mapping, depth + 1)
            }
        }
    }
    render(m)
}


export function showImportMap(m: ImportMap) {
    _showImportMap(m, printSource)
}

function printSource(info: SourceInfo) {
    const type = info.type
    switch (type) {
        case 'package':
            return info.data.version
        case 'artifact':
            return info.data.metadataHash
    }

    throw new Error(`Unsupported source type: ${type}`)
}

interface PointerInfo {
    hash: string
    metadataHash: string
}

export type SourceInfo = {
    readonly type: 'package'
    readonly data: PackageInfo
} | {
    readonly type: 'artifact'
    readonly data: PointerInfo
}

export interface ImportMap {
    [specifier: string]: {
        readonly source?: SourceInfo
        readonly mapping?: ImportMap
        readonly location: string
        readonly locationType?: 'module' | 'package'
    }
}

function _hoistImportMap(mapping: ImportMap, getKey: (source: SourceInfo) => string, stack: ImportMap[] = []): ImportMap {
    // Import maps can include cycles which we can simply ignore
    //
    // Hoisting is applied bottom-up, guaranteeing we'll visit any 
    // detected cycles after visiting all non-cyclical dependencies

    const shouldSkip = new Set<ImportMap>()
    for (const [k, v] of Object.entries(mapping)) {
        if (!v.mapping) continue

        if (stack.includes(v.mapping)) {
            shouldSkip.add(v.mapping)
        } else {
            _hoistImportMap(v.mapping, getKey, [...stack, v.mapping])
        }
    }

    const roots = new Set<string>(Object.keys(mapping))
    const candidates = new Map<string, ImportMap[]>()

    for (const [k, v] of Object.entries(mapping)) {
        if (!v.mapping || shouldSkip.has(v.mapping)) continue

        for (const spec of Object.keys(v.mapping)) {
            if (roots.has(spec)) {
                continue
            }

            const l = candidates.get(spec) ?? []
            l.push(v.mapping)
            candidates.set(spec, l)
        }
    }

    for (const [k, v] of candidates.entries()) {
        const groups: Record<string, ImportMap[]> = {}
        for (const m of v) {
            const source = m[k].source
            if (source) {
                const g = groups[getKey(source)] ??= []
                g.push(m)
            }
        }

        const bestGroup = Object.entries(groups).sort((a, b) => b[1].length - a[1].length).pop()
        if (bestGroup) {
            mapping[k] = bestGroup[1][0][k]
            for (const g of bestGroup[1]) {
                delete g[k]
            }
        }
    }

    return mapping
}

function getKeyFromSource(source: SourceInfo) {
    switch (source.type) {
        case 'package':
            return `${source.data.name}-${source.data.version}`
        case 'artifact':
            return `${source.data.hash}-${source.data.metadataHash}`
    }
}

export function hoistImportMap(mapping: ImportMap): ImportMap {
    function pruneDuplicates(mapping: ImportMap) {
        const roots = new Set(Object.keys(mapping))
        for (const k of roots) {
            const v = mapping[k]
            if (!v.mapping) continue
            pruneDuplicates(v.mapping)

            for (const spec of Object.keys(v.mapping)) {
                if (!roots.has(spec)) continue
                const s1 = v.mapping[spec].source
                const s2 = mapping[spec].source
                if (s1 && s2 && getKeyFromSource(s1) === getKeyFromSource(s2)) {
                    delete v.mapping[spec]
                }
            }
        }
        return mapping
    }

    return pruneDuplicates(_hoistImportMap(mapping, getKeyFromSource))
}

export interface FlatImportMap {
    readonly sources: Record<string, SourceInfo | undefined>    // ID -> SourceInfo
    readonly mappings: Record<string, Record<string, string> >  // ID -> (spec -> ID)
    readonly locations: Record<string, {                        // ID -> file(s)
        readonly location: string
        readonly locationType?: 'module' | 'package'
    }> 
}

function _flattenImportMap(mapping: ImportMap, getKey: (source: SourceInfo) => string, collapse?: boolean): FlatImportMap {
    const sources: FlatImportMap['sources'] = {}
    const mappings: FlatImportMap['mappings'] = {}
    const locations: FlatImportMap['locations'] = {}

    const unknowns = new Map<ImportMap[string], string>()
    const encodedIds = new Map<string, string>()

    function getUnknownSourceId(n: ImportMap[string]) {
        if (unknowns.has(n)) {
            return unknowns.get(n)!
        }

        const newId = `unknown-${unknowns.size}`
        unknowns.set(n, newId)

        return newId
    }

    const uniqueIds = new Map<any, string>()
    function getId(n: ImportMap[string]) {
        if (!collapse) {
            if (uniqueIds.has(n)) {
                return uniqueIds.get(n)!
            }
            uniqueIds.set(n, `${uniqueIds.size+1}`)
            return uniqueIds.get(n)!
        }

        if (!n.source) {
            return getUnknownSourceId(n)
        }

        return getKey(n.source)
    }
    
    // Makes the import map smaller on disk
    function getEncodedId(n: ImportMap[string]) {
        const id = getId(n)
        if (encodedIds.has(id)) {
            return encodedIds.get(id)!
        }

        const encoded = `${encodedIds.size}`
        encodedIds.set(id, encoded)

        return encoded
    }

    function addMapping(parentId: string, spec: string, id: string) {
        const m = mappings[parentId] ??= {}
        m[spec] = id
    }

    function visit(mapping: ImportMap, currentId: string) {
        for (const [k, v] of Object.entries(mapping)) {
            const id = getEncodedId(v)
            addMapping(currentId, k, id)

            if (!(id in locations)) {
                sources[id] = v.source
                locations[id] = { location: v.location, locationType: v.locationType }

                if (v.mapping) {
                    visit(v.mapping, id)
                }
            }
        }
    }
    
    visit(mapping, '#root')

    return { sources, mappings, locations }
}

function _expandImportMap(mapping: FlatImportMap): ImportMap {
    if (Object.keys(mapping.mappings).length === 0) {
        return {}
    }

    const expanded = new Map<string, ImportMap[string]>()

    function expand(id: string): ImportMap[string] {
        if (expanded.has(id)) {
            return expanded.get(id)!
        }

        const l = mapping.locations[id]
        if (!l) {
            throw new Error(`Missing import: ${id}`)
        }

        const r: Mutable<ImportMap[string]> = {
            location: l.location,
            locationType: l.locationType,
            source: mapping.sources[id],
        }

        expanded.set(id, r)

        const m = mapping.mappings[id]
        if (m) {
            const inner: ImportMap = r.mapping = {}
            for (const [k, v] of Object.entries(m)) {
                inner[k] = expand(v)
            }
        }

        return r
    }

    const root = mapping.mappings['#root']
    if (!root) {
        throw new Error(`Missing root mapping`)
    }

    const res: ImportMap = {}
    for (const [k, v] of Object.entries(root)) {
        res[k] = expand(v)
    }

    return res
}

export function flattenImportMap(mapping: ImportMap, collapse = true) {
    return _flattenImportMap(mapping, getKeyFromSource, collapse)
}

export function expandImportMap(mapping: FlatImportMap) {
    return _expandImportMap(mapping)
}