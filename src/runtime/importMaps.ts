import { getLogger } from '../logging'
import { Mutable } from '../utils'
import { PackageInfo } from './modules/serdes'

function _showImportMap<T>(m: ImportMap<T>, printSourceInfo?: (source: T) => string) {
    function render(map: ImportMap<T>, depth = 0) {
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


export function showImportMap(m: ImportMap<SourceInfo>) {
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

export type SourceInfo = {
    readonly type: 'package'
    readonly data: PackageInfo
} | {
    readonly type: 'artifact'
    readonly data: { hash: string; metadataHash: string }
}

export interface ImportMap<T = unknown> {
    [specifier: string]: {
        readonly source?: T
        readonly mapping?: ImportMap<T>
        readonly location: string
        readonly locationType?: 'module' | 'package'
    }
}

function _hoistImportMap<T>(mapping: ImportMap<T>, getKey: (source: T) => string, stack: ImportMap<T>[] = []): ImportMap<T> {
    // Import maps can include cycles which we can simply ignore
    //
    // Hoisting is applied bottom-up, guaranteeing we'll visit any 
    // detected cycles after visiting all non-cyclical dependencies

    const shouldSkip = new Set<ImportMap<T>>()
    for (const [k, v] of Object.entries(mapping)) {
        if (!v.mapping) continue

        if (stack.includes(v.mapping)) {
            shouldSkip.add(v.mapping)
        } else {
            _hoistImportMap(v.mapping, getKey, [...stack, v.mapping])
        }
    }

    const roots = new Set<string>(Object.keys(mapping))
    const candidates = new Map<string, ImportMap<T>[]>()

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
        const groups: Record<string, ImportMap<T>[]> = {}
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

export function hoistImportMap(mapping: ImportMap<SourceInfo>): ImportMap<SourceInfo> {
    function pruneDuplicates(mapping: ImportMap<SourceInfo>) {
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

export interface FlatImportMap<T = unknown> {
    readonly sources: Record<string, T | undefined>             // ID -> T
    readonly mappings: Record<string, Record<string, string> >  // ID -> (spec -> ID)
    readonly locations: Record<string, {                        // ID -> file(s)
        readonly location: string
        readonly locationType?: 'module' | 'package'
    }> 
}

function _flattenImportMap<T>(mapping: ImportMap<T>, getKey: (source: T) => string, collapse?: boolean): FlatImportMap<T> {
    const sources: FlatImportMap<T>['sources'] = {}
    const mappings: FlatImportMap<T>['mappings'] = {}
    const locations: FlatImportMap<T>['locations'] = {}

    const unknowns = new Map<ImportMap<T>[string], string>()
    const encodedIds = new Map<string, string>()

    function getUnknownSourceId(n: ImportMap<T>[string]) {
        if (unknowns.has(n)) {
            return unknowns.get(n)!
        }

        const newId = `unknown-${unknowns.size}`
        unknowns.set(n, newId)

        return newId
    }

    const uniqueIds = new Map<any, string>()
    function getId(n: ImportMap<T>[string]) {
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
    function getEncodedId(n: ImportMap<T>[string]) {
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

    function visit(mapping: ImportMap<T>, currentId: string) {
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

function _expandImportMap<T>(mapping: FlatImportMap<T>): ImportMap<T> {
    if (Object.keys(mapping.mappings).length === 0) {
        return {}
    }

    const expanded = new Map<string, ImportMap<T>[string]>()

    function expand(id: string): ImportMap<T>[string] {
        if (expanded.has(id)) {
            return expanded.get(id)!
        }

        const l = mapping.locations[id]
        if (!l) {
            throw new Error(`Missing import: ${id}`)
        }

        const r: Mutable<ImportMap<T>[string]> = {
            location: l.location,
            locationType: l.locationType,
            source: mapping.sources[id],
        }

        expanded.set(id, r)

        const m = mapping.mappings[id]
        if (m) {
            const inner: ImportMap<T> = r.mapping = {}
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

    const res: ImportMap<T> = {}
    for (const [k, v] of Object.entries(root)) {
        res[k] = expand(v)
    }

    return res
}

export function flattenImportMap(mapping: ImportMap<SourceInfo>, collapse = true) {
    return _flattenImportMap(mapping, getKeyFromSource, collapse)
}

export function expandImportMap(mapping: FlatImportMap<SourceInfo>) {
    return _expandImportMap(mapping)
}