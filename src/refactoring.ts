import type { TerraformSourceMap, Symbol, TfJson } from './runtime/modules/terraform'
import { createMinHeap, createTrie, isNonNullable, keyedMemoize, levenshteinDistance } from './utils'
import { getLogger } from './logging'
import { parseModuleName } from './templates'
import { TfState } from './deploy/state'

interface Node<T = unknown> {
    readonly value: T
    readonly children: Node<T>[]
}

interface TypedNode<T = unknown, U extends string = string> extends Node<T> {
    readonly type: U
    readonly children: TypedNode<any>[]
    readonly parents?: TypedNode<any>[]
}

function createNode<T>(value: T, children: Node<T>[] = []): Node<T> {
    return { value, children } 
}

function createTypedNode<T, U extends string>(type: U, value: T): TypedNode<T, U> {
    return { type, value, children: [], parents: [] } 
}

// Zhang-Shasha algorithm for computing the edit distance between trees
// Reference implementation: https://github.com/timtadh/zhang-shasha/blob/master/zss/compare.py

interface RemoveOperation<T extends TypedNode> {
    readonly type: 'remove'
    readonly node: T
}

interface InsertOperation<T extends TypedNode> {
    readonly type: 'insert'
    readonly node: T
}

interface UpdateOperation<T extends TypedNode> {
    readonly type: 'update'
    readonly left: T
    readonly right: T
}

interface MatchOperation<T extends TypedNode> {
    readonly type: 'match'
    readonly left: T
    readonly right: T
}

type Operation<T extends TypedNode> = 
    | RemoveOperation<T>
    | InsertOperation<T>
    | UpdateOperation<T>
    | MatchOperation<T>

function createAnnotatedTree<T extends TypedNode>(root: T) {
    const lmds: number[] = [] // left-most descendents
    const nodes: T[] = [] // post-order enumeration

    const ids: number[] = []
    const keyroots: Record<number, number> = {}
    const stack: [T, number[]][] = [[root, []]]
    const pstack: [[T, number], number[]][] = []

    //We need this when re-using nodes
    //This isn't technically correct because it allows for DAGs instead of trees
    // const visited = new Set<T>() 
    // visited.add(root)

    let j = 0
    while (stack.length > 0) {
        const [n, anc] = stack.pop()!
        const nid = j
        for (const c of n.children) {
            // if (!visited.has(c as T)) {
            //     const a = [nid, ...anc]
            //     stack.push([c as T, a])
            //     visited.add(c as T)
            // }
            const a = [nid, ...anc]
            stack.push([c as T, a])
        }
        pstack.push([[n, nid], anc])
        j += 1
    }

    let i = 0
    const tempLmds: Record<number, number> = {}
    while (pstack.length > 0) {
        const [[n, nid], anc] = pstack.pop()!
        nodes.push(n)
        ids.push(nid)

        let lmd: number
        if (n.children.length === 0) {
            lmd = i
            for (const a of anc) {
                if (!(a in tempLmds)) {
                    tempLmds[a] = i
                } else {
                    break
                }
            }
        } else {
            lmd = tempLmds[nid]
        }
        lmds.push(lmd)
        keyroots[lmd] = i
        i += 1
    }

    return {
        root,
        ids,
        lmds,
        nodes,
        keyroots: Array.from(new Set(Object.values(keyroots))).sort((a, b) => a - b),
    }
}

// LD bounds:
// * The Levenshtein distance between two strings is no greater than the sum of their Levenshtein distances from a third string 

interface CostFunctions<T extends TypedNode> {
    insert(value: T): number
    update(oldValue: T, newValue: T): number
    remove(value: T): number
}

function editDistance<T extends TypedNode>(oldTree: T, newTree: T, costFn: CostFunctions<T>) {
    const a = createAnnotatedTree(oldTree)
    const b = createAnnotatedTree(newTree)

    const sizeA = a.nodes.length
    const sizeB = b.nodes.length

    const treeDists: number[][] = []
    const operations: Operation<T>[][][] = []

    for (let i = 0; i < sizeA; i++) {
        treeDists[i] = []
        operations[i] = []

        for (let j = 0; j < sizeB; j++) {
            treeDists[i][j] = 0
            operations[i][j] = []
        }
    }

    for (const i of a.keyroots) {
        for (const j of b.keyroots) {
            treedist(i, j)
        }
    }

    return {
        cost: treeDists.at(-1)!.at(-1)!,
        operations: operations.at(-1)!.at(-1)!,
    }

    function treedist(i: number, j: number) {
        const al = a.lmds
        const bl = b.lmds
        const an = a.nodes
        const bn = b.nodes

        const m = i - al[i] + 2
        const n = j - bl[j] + 2

        const fd: number[][] = []
        const partialOps: Operation<T>[][][] = []
        for (let i2 = 0; i2 < m; i2++) {
            fd[i2] = []
            partialOps[i2] = []
            for (let j2 = 0; j2 < n; j2++) {
                fd[i2][j2] = 0
                partialOps[i2][j2] = []
            }
        }

        const ioff = al[i] - 1
        const joff = bl[j] - 1

        for (let x = 1; x < m; x++) {
            const node = an[x + ioff]
            fd[x][0] = fd[x - 1][0] + costFn.remove(node)
            partialOps[x][0] = [
                ...partialOps[x - 1][0], 
                { type: 'remove', node }
            ]
        }

        for (let y = 1; y < n; y++) {
            const node = bn[y + joff]
            fd[0][y] = fd[0][y - 1] + costFn.insert(node)
            partialOps[0][y] = [
                ...partialOps[0][y - 1], 
                { type: 'insert', node }
            ]
        }

        for (let x = 1; x < m; x++) {
            for (let y = 1; y < n; y++) {
                const node1 = an[x + ioff]
                const node2 = bn[y + joff]

                if (al[i] === al[x + ioff] && bl[j] === bl[y + joff]) {
                    const costs = [
                        fd[x - 1][y] + costFn.remove(node1),
                        fd[x][y - 1] + costFn.insert(node2),
                        fd[x - 1][y - 1] + costFn.update(node1, node2),
                    ]

                    fd[x][y] = Math.min(...costs)
                    const minIndex = costs.indexOf(fd[x][y])

                    if (minIndex === 0) {
                        partialOps[x][y] = [
                            ...partialOps[x - 1][y], 
                            { type: 'remove', node: node1 }
                        ]
                    } else if (minIndex === 1) {
                        partialOps[x][y] = [
                            ...partialOps[x][y - 1], 
                            { type: 'insert', node: node2 }
                        ]
                    } else {
                        const opType: 'match' | 'update' = fd[x][y] === fd[x - 1][y - 1] ? 'match' : 'update'
                        partialOps[x][y] = [
                            ...partialOps[x - 1][y - 1], 
                            { type: opType, left: node1, right: node2 }
                        ]
                    }

                    operations[x + ioff][y + joff] = partialOps[x][y]
                    treeDists[x + ioff][y + joff] = fd[x][y]
                } else {
                    const p = al[x + ioff] - 1 - ioff
                    const q = bl[y + joff] - 1 - joff
                    const costs = [
                        fd[x - 1][y] + costFn.remove(node1),
                        fd[x][y - 1] + costFn.insert(node2),
                        fd[p][q] + treeDists[x + ioff][y + joff]
                    ]

                    fd[x][y] = Math.min(...costs)
                    const minIndex = costs.indexOf(fd[x][y])

                    if (minIndex === 0) {
                        partialOps[x][y] = [
                            ...partialOps[x - 1][y], 
                            { type: 'remove', node: node1 }
                        ]
                    } else if (minIndex === 1) {
                        partialOps[x][y] = [
                            ...partialOps[x][y - 1], 
                            { type: 'insert', node: node2 }
                        ]
                    } else {
                        partialOps[x][y] = [
                            ...partialOps[p][q], 
                            ...operations[x + ioff][y + joff]
                        ]
                    }
                }
            }
        }
    }
}

interface SymbolNodeValue extends Symbol {
    id: number
    resources: Resource[]
}

type ResourceNode = TypedNode<Resource, 'resource'>
export type SymbolNode = TypedNode<SymbolNodeValue, 'symbol'>
type FileNode = TypedNode<{ id: number; fileName: string }, 'file'>
type RootNode = TypedNode<{ }, 'root'>

type SymbolGraphNode = 
    | RootNode
    | FileNode
    | SymbolNode
    | ResourceNode

const configCache = new Map<Resource, string>()
function getConfigStr(r: Resource) {
    if (configCache.has(r)) {
        return configCache.get(r)!
    }
    
    const str = JSON.stringify(r.config)
    configCache.set(r, str)

    return str
}

function createSimilarityHost() {
    const jsonSizeCache = new Map<any, number>()
    const jsonDistCache = new Map<any, Map<any, number>>()

    const ldCache = new Map<string, number>()
    function ld(a: string, b: string) {
        const k = `${a}:${b}`
        const c = ldCache.get(k)
        if (c !== undefined) {
            return c
        }

        const d = levenshteinDistance(a, b)
        ldCache.set(k, d)
        ldCache.set(`${b}:${a}`, d)

        return d
    }

    function getSize(obj: any) {
        if (jsonSizeCache.has(obj)) {
            return jsonSizeCache.get(obj)!
        }

        const r = jsonSize(obj)
        jsonSizeCache.set(obj, r)

        return r
    }

    function getDist(a: any, b: any) {
        const cached = jsonDistCache.get(a)?.get(b)
        if (cached !== undefined) {
            return cached
        }

        const r = jsonDist(a, b)
        if (!jsonDistCache.has(a)) {
            jsonDistCache.set(a, new Map())
        }
        if (!jsonDistCache.has(b)) {
            jsonDistCache.set(b, new Map())
        }
        jsonDistCache.get(a)!.set(b, r)
        jsonDistCache.get(b)!.set(a, r)

        return r
    }

    function jsonSize(obj: any): number {
        if (typeof obj === 'string') {
            return obj.length
        }

        if (typeof obj === 'number') {
            return String(obj).length
        }

        if (typeof obj === 'boolean' || obj === null) {
            return 1
        }

        if (typeof obj === 'undefined') {
            return 0
        }

        if (Array.isArray(obj)) {
            return obj.reduce((a, b) => a + getSize(b), 0)
        }

        let s = 0
        for (const [k, v] of Object.entries(obj)) {
            s += k.length + getSize(v)
        }
        
        return s
    }

    function jsonDist(a: any, b: any): number {
        if (typeof a !== typeof b) {
            return getSize(a) + getSize(b)
        }

        if (a === null || b === null) {
            if (a === null && b === null) {
                return 0
            }

            return getSize(a) + getSize(b)
        }

        if (typeof a === 'string') {
            return ld(a, b)
        }

        if (typeof a === 'number') {
            return ld(String(a), String(b))
        }

        if (typeof a === 'boolean') {
            return a === b ? 0 : 1
        }

        if (Array.isArray(a) || Array.isArray(b)) {
            if (!(Array.isArray(a) && Array.isArray(b))) {
                return getSize(a) + getSize(b)
            }

            const m = Math.min(a.length, b.length)
            let i = 0
            let s = 0
            for (; i < m; i++) {
                s += getDist(a[i], b[i])
            }

            const j = Math.max(a.length, b.length)
            const c = a.length > b.length ? a : b
            for (; i < j; i++) {
                s += getSize(c[j])
            }

            return s
        }

        // This is a naive solution. A better solution would find the best matching key (tree edit distance)
        let s = 0
        for (const [k, v] of Object.entries(a)) {
            if (v === undefined) continue

            const u = b[k]
            if (u !== undefined) {
                s += getDist(v, u)
            } else {
                s += k.length 
            }
        }

        for (const [k, u] of Object.entries(b)) {
            if (u !== undefined && (!(k in a) || a[k] === undefined)) {
                s += k.length
            }
        }

        return s
    }

    return { ld, getSize, getDist }
}

export interface ResolvedScope {
    isNewExpression?: boolean
    callSite: Symbol
    assignment?: Symbol
    namespace?: Symbol[]
}

export function getRenderedStatementFromScope(scope: ResolvedScope): string {
    const nameParts = [scope.callSite.name]
    if (scope.namespace) {
        nameParts.unshift(...scope.namespace.map(n => n.name))
    }

    const exp = `${scope.isNewExpression ? 'new ' : ''}${nameParts.join('.')}`
    const name = scope.assignment !== undefined 
        ? `${scope.assignment.name} = ${exp}` 
        : exp

    return name
}

export function getKeyFromScopes(scopes: ResolvedScope[]) {
    if (scopes.length === 0) {
        throw new Error('No scopes provided')
    }

    const parts: string[] = []
    for (const s of scopes) {
        if (s.assignment) {
            parts.push(s.assignment.name)
        }
        if (s.namespace) {
            parts.push(...s.namespace.map(x => x.name))
        }
        parts.push(s.callSite.name)
    }

    return parts.join('--')

    //const moduleName = scopes[0].callSite.fileName

    //return `${moduleName}_${parts.join('--')}`
}

export type SymbolGraph = ReturnType<typeof createSymbolGraph>
export function createSymbolGraph(sourceMap: TerraformSourceMap, resources: Record<string, any>) {
    let idCounter = 0
    let resourceIdCounter = 0

    const nodes = new Map<number, SymbolNode>()
    const resourceToNode = new Map<string, SymbolNode>() // Top scope
    const symbolMap = new Map<Symbol, SymbolNode>()

    type Scope = { isNewExpression?: boolean; callSite: number; assignment?: number; namespace?: number[] }

    function resolveScope(scope: Scope): ResolvedScope {
        return {
            callSite: sourceMap.symbols[scope.callSite],
            namespace: scope.namespace?.map(id => sourceMap.symbols[id]),
            assignment: scope.assignment ? sourceMap.symbols[scope.assignment] : undefined,
            isNewExpression: scope.isNewExpression,
        }
    }

    function createSymbolNode(scope: Scope) {
        const id = scope.callSite

        return createTypedNode('symbol', {
            ...sourceMap.symbols[id],
            id: idCounter++, 
            resources: [],
            // FIXME: don't clobber the original name
            // Might need to add a separate field
            name: getRenderedStatementFromScope(resolveScope(scope)),
        })
    }

    function getSymbolNode(scope: Scope) {
        const id = scope.callSite
        if (nodes.has(id)) {
            return nodes.get(id)!
        }

        const node = createSymbolNode(scope)
        if (scope.assignment !== undefined) {
            symbolMap.set(sourceMap.symbols[scope.assignment], node)
        } else {
            symbolMap.set(sourceMap.symbols[scope.callSite], node)
        }

        nodes.set(id, node)
        
        return node
    }

    function getCallsites(resource: string) {
        const scopes = sourceMap.resources[resource]?.scopes
        if (!scopes) {
            return
        }

        return scopes.map(s => sourceMap.symbols[s.callSite]) 
    }

    for (const [k, v] of Object.entries(sourceMap.resources)) {
        if (v.scopes.length === 0) {
            // This only happens for generated "export" files
            getLogger().warn(`Resource "${k}" has no scopes`)
            continue
        }

        const [rType, ...rest] = k.split('.', 2)
        const rName = rest.join('.')
        const config = resources[k]
        if (!config) {
            throw new Error(`Missing resource in source map: ${k}`)
        }

        const r: Resource = {
            id: resourceIdCounter++,
            type: rType,
            subtype: rType === 'synapse_resource' ? config.type : undefined,
            name: rName,
            config: { ...config, type: undefined },
            scopes: v.scopes.map(resolveScope),
            fileName: '',
        }

        const n = getSymbolNode(v.scopes[0])
        n.value.resources.push(r)
        resourceToNode.set(k, n)
    }

    const root = createTypedNode('root', {})

    for (let i = 0; i < sourceMap.symbols.length; i++) {
        const node = nodes.get(i)
        if (!node || node.value.resources.length === 0) continue

        root.children.push(node as any)
        if (!node.parents!.includes(root)) {
            node.parents!.push(root)
        }

        node.value.resources.sort((a, b) => getConfigStr(a).length - getConfigStr(b).length)
    }

    root.children.sort((a, b) => {
        const d = (a as SymbolNode).value.fileName.localeCompare((b as SymbolNode).value.fileName)
        if (d === 0) {
            return (a as SymbolNode).value.name.localeCompare((b as SymbolNode).value.name)
        }
        return d
    })

    function getSymbols() {
        return root.children as SymbolNode[]
    }

    function findSymbolFromResourceKey(key: string) {
        return resourceToNode.get(key)
    }

    function isInternalResource(key: string) {
        const type = getResourceType(key)
        if (type.kind === 'synapse') {
            return true
        }
    
        return false
    }

    function getResourceType(key: string): { kind: 'terraform' | 'synapse' | 'custom', name: string } {
        const parts = key.split('.')
        const type = parts[0] === 'data' ? parts[1] : parts[0]
        const csType = type === 'synapse_resource' ? resources[key]?.type : undefined
        if (!csType) {
            return { kind: 'terraform', name: type }
        }
    
        const userType = (csType === 'Example' || csType === 'ExampleData' || csType === 'Custom' || csType === 'CustomData') 
            ? resources[key].input.type.split('--').at(-2) 
            : undefined

        if (!userType) {
            return { kind: 'synapse', name: csType }
        }

        return { kind: 'custom', name: userType }
    }

    function getTestInfo(key: string) {
        const config = getConfig(key)
        if (!config) {
            return
        }

        const moduleName = (config as any).module_name
        if (!moduleName || typeof moduleName !== 'string') {
            return
        }

        const parsed = parseModuleName(moduleName)
        if (parsed.testSuiteId === undefined) {
            return
        }

        return { fileName: parsed.fileName, testSuiteId: parsed.testSuiteId }
    }

    function hasResource(key: string) {
        return resourceToNode.has(key)
    }

    function shallowMatchSymbolNodes(name: string, fileName?: string) {
        const nodes: SymbolNode[] = []
        for (const [k, v] of symbolMap) {
            if (k.name === name && (!fileName || k.fileName === fileName)) {
                nodes.push(v)
            }
        }

        return nodes
    }

    function matchSymbolNodes(name: string, fileName?: string) {
        const segments = name.split('/')
        const root = shallowMatchSymbolNodes(segments[0], fileName)
        if (segments.length === 1 || root.length !== 1) {
            return root
        }        

        const node = root[0]
        const next = segments[1]
        const resources: Resource[] = []
        for (const r of node.value.resources) {
            if (r.scopes[1]?.assignment?.name === next || r.scopes[1]?.callSite.name === next) {
                resources.push(r)
            }
        }

        if (resources.length === 0) {
            return []
        }

        const newNode: SymbolNode = {
            children: [],
            type: 'symbol',
            value: {
                id: -1,
                ...resources[0].scopes[1].assignment!,
                resources,
            },
        }

        return [newNode]
    }

    function getConfig(key: string): object | undefined {
        return resources[key]
    }

    return {
        getConfig,
        getSymbols,
        hasResource,
        findSymbolFromResourceKey,
        isInternalResource,
        getResourceType,
        matchSymbolNodes,
        getTestInfo,

        getCallsites,
    }
}

export function createSymbolGraphFromTemplate(template: TfJson) {
    const newSourceMap = template['//']?.sourceMap
    if (!newSourceMap) {
        throw new Error(`No new source map found`)
    }

    const newResources: Record<string, any> = {}
    for (const [k, v] of Object.entries(template.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            const id = `${k}.${k2}`
            newResources[id] = v2
        }
    }

    return createSymbolGraph(newSourceMap, newResources)
}

// Used for combining the most recently compiled template vs. the last deployed one
export type MergedGraph = ReturnType<typeof createMergedGraph>
export function createMergedGraph(graph: SymbolGraph, oldGraph?: SymbolGraph) {
    function getSymbol(r: string) {
        const symbol = graph.findSymbolFromResourceKey(r)
        if (symbol) {
            return symbol
        }

        const oldSymbol = oldGraph?.findSymbolFromResourceKey(r)
        if (!oldSymbol) {
            throw new Error(`Missing symbol for resource: ${r}`)
        }

        if (oldSymbol.value.id < 1000) {
            oldSymbol.value.id += 1000 // XXX: no need to explain
        }

        return oldSymbol
    }

    function getResourceType(r: string) {
        if (graph.hasResource(r)) {
            return graph.getResourceType(r)
        }

        return oldGraph?.getResourceType(r)
    }

    function isInternalResource(r: string) {
        if (graph.hasResource(r)) {
            return graph.isInternalResource(r)
        }

        return oldGraph?.isInternalResource(r)
    }

    function isTestResource(r: string) {
        const config = graph.getConfig(r) ?? oldGraph?.getConfig(r)
        if (!config || !('module_name' in config) || typeof config.module_name !== 'string') {
            return
        }

        const parsed = parseModuleName(config.module_name)

        return parsed.testSuiteId !== undefined
    }

    function hasSymbol(r: string) {
        return graph.hasResource(r) || oldGraph?.hasResource(r)
    }

    function listSymbols() {
        return [
            ...graph.getSymbols(),
            ...(oldGraph?.getSymbols() ?? []),
        ]
    }

    function getCallsites(r: string) {
        return graph.getCallsites(r) ?? oldGraph?.getCallsites(r)
    }

    function getConfig(r: string) {
        return graph.getConfig(r) ?? oldGraph?.getConfig(r)
    }

    return {
        getConfig,
        hasSymbol,
        getSymbol,
        getResourceType,
        isInternalResource,
        isTestResource,
        listSymbols,
        getCallsites,
    }
}


interface Resource {
    readonly id: number
    readonly type: string
    readonly name: string
    readonly config: any
    readonly subtype?: string
    readonly scopes: ResolvedScope[]
    readonly fileName: string
}

// Goal: minimize # of ops for a given deploy
// Cost is determined by the LD between the last deployed config vs. now

function getResourceKey(r: Resource) {
    const t = r.subtype ? `${r.type}.${r.subtype}` : r.type

    return `${t}.${r.name}`
}


function printNode(node: SymbolGraphNode) {
    switch (node.type) {
        case 'file':
            return `[file] ${node.value.fileName}`
        case 'symbol':
            return `[symbol] ${node.value.name} (id: ${node.value.id}; rc: ${node.value.resources.length})`
        case 'resource':
            return `[resource] ${getResourceKey(node.value)}`

        case 'root':
            return ''
    }
}

function printNodeRecursive(node: SymbolGraphNode, showResources = false, depth = 0, stack: SymbolGraphNode[] = []): string[] {
    const lines: string[] = []
    lines.push(`${'  '.repeat(depth)}${printNode(node)}`)
    stack.push(node)

    for (const c of node.children) {
        if (stack.includes(c as SymbolGraphNode)) {
            throw new Error(`Cycle detected: ${[...stack, c as SymbolGraphNode].map(n => printNode(n)).join(' --> ')}`)
        }
        if (!showResources && c.type === 'resource') continue
        lines.push(...printNodeRecursive(c as SymbolGraphNode, showResources, depth + 1, stack))
    }

    stack.pop()!

    return lines
}

// function printTree(g: ReturnType<typeof createSymbolGraph>) {
//     getLogger().raw(printNodeRecursive(g.root).join('\n'))
// }


function isSameType(r1: Resource, r2: Resource) {
    return r1.type === r2.type && r1.subtype === r2.subtype
}

function getTypeKey(r: Resource) {
    return r.subtype ? `${r.type}.${r.subtype}` : r.type
}

function createTokenizer(mappings: Record<string, string>) {
    const trie = createTrie<string>()
    for (const [k, v] of Object.entries(mappings)) {
        trie.insert(k, v)
    }

    function mapString(s: string): string[] {
        const r: string[] = []
        let t = trie.createIterator()
        let j = 0
        let k = 0
        for (let i = 0; i < s.length; i++) {
            const n = t.next(s[i])
            if (n.done) {
                i -= j
                j = 0
                t = trie.createIterator()
            } else if (n.value) {
                r.push(s.slice(k, i - j))
                r.push(n.value)
                j = 0
                k = i + 1
                t = trie.createIterator()
            } else {
                j += 1
            }
        }
        if (r.length === 0) {
            return [s]
        }
        if (k !== s.length) {
            r.push(s.slice(k))
        }
        return r
    }

    return { mapString }
}

export function normalizeConfigs(config: TfJson) {
    const maps = {
        data: new Map<string, string>(),
        locals: new Map<string, string>(),
        resources: new Map<string, string>(),
        providers: new Map<string, string>(),
        modules: new Map<string, string>(),
    }

    function getMapping(type: keyof typeof maps, key: string) {
        const m = maps[type]
        if (m.has(key)) {
            return m.get(key)!
        }

        const x = `${m.size.toString().padStart(7, '0')}`
        m.set(key, x)

        return x
    }

    const mappings: Record<string, string> = {}
    for (const [k, v] of Object.entries(config.locals ?? {})) {
        const m = getMapping('locals', k)
        mappings[`local.${k}`] = `local.${m}`
        if (k.startsWith('o_')) {
            const id = k.slice(2)
            mappings[`"${id}"`] = `"${m}"`
        }
    }

    for (const [k, v] of Object.entries(config.data ?? {})) {
        for (const [k2, _] of Object.entries(v)) {
            const n = `${k}.${k2}`
            const m = getMapping('data', n)
            mappings[`data.${n}`] = `data.${m}`
        }
    }

    for (const [k, v] of Object.entries(config.resource ?? {})) {
        for (const [k2, c] of Object.entries(v)) {
            if (c.module_name && typeof c.module_name === 'string') {
                const [name, fragment] = c.module_name.split('#')
                const m = getMapping('modules', name)
                c.module_name = fragment ? `${m}#${fragment}` : m
            }
            const n = `${k}.${k2}`
            const m = getMapping('resources', n)
            mappings[n] = m
        }
    }

    for (const [k, v] of Object.entries(config.provider ?? {})) {
        for (const p of v) {
            const alias = p.alias
            if (!alias) continue

            const n = `${k}.${alias}`
            const m = getMapping('providers', n)
            mappings[n] = m
        }
    }

    // XXX: this string fragment is very very common
    mappings['${jsonencode({"Version" = "2012-10-17", "Statement" = [{"Effect" = "Allow", "Action" = '] = '__IAM_POLICY_FRAGMENT__'

    const tokenizer = createTokenizer(mappings)

    function visit(c: any): any {
        if (typeof c === 'string') {
            return tokenizer.mapString(c)
        }

        if (Array.isArray(c)) {
            return c.map(visit)
        }

        if (typeof c !== 'object' || !c) {
            return c
        }

        const o: any = {}
        for (const [k, v] of Object.entries(c)) {
            o[k] = visit(v)
        }
        return o
    }

    for (const [k, v] of Object.entries(config.resource ?? {})) {
        for (const [k2, c] of Object.entries(v)) {
            const type = c.type
            v[k2] = visit(c)
            if (type !== undefined) {
                v[k2].type = type
            }
        }
    }
    
    return config
}


function printOp(op: Operation<SymbolGraphNode>) {
    switch (op.type) {
        case 'insert':
        case 'remove':
            return `[${op.type}] ${printNode(op.node)}`
        case 'match':
        case 'update':
            return `[${op.type}] ${printNode(op.left)} -> ${printNode(op.right)}`
    }
}

export function createGraphSolver(
    newResources: Record<string, any>,
    newSourceMap: TerraformSourceMap,
    oldResources: Record<string, any>,
    oldSourceMap: TerraformSourceMap,
    newDeps: Record<string, Set<string>>,
    oldDeps: Record<string, Set<string>>,
) {
    const g1 = createSymbolGraph(newSourceMap, newResources)
    const g2 = createSymbolGraph(oldSourceMap, oldResources)

    const { ld, getSize, getDist } = createSimilarityHost()

    const resourceIndex = new Map<SymbolGraphNode, Record<string, Resource[]>>()
    function getResourceGroups(n: SymbolNode) {
        if (resourceIndex.has(n)) {
            return resourceIndex.get(n)!
        }

        const o: Record<string, Resource[]> = {}
        for (const r of n.value.resources ?? []) {
            const t = getTypeKey(r)
            const a = o[t] ??= []
            a.push(r)
        }
        resourceIndex.set(n, o)

        return o
    }


    // Assumption: all resources have the same type
    function getLowerBoundResources(g1: Resource[], g2: Resource[]) {
        const l1 = g1.map(x => getSize(x.config)).sort()
        const l2 = g2.map(x => getSize(x.config)).sort()
        const m = Math.min(g1.length, g2.length)
        let i = 0
        let upper = 0
        let lower = 0
        for (; i < m; i++) {
            upper += Math.max(l1[i], l2[i])
            lower += Math.abs(l1[i] - l2[i])
        }

        const rem = (l1.length > l2.length ? l1 : l2).slice(i).reduce((a, b) => a + b, 0)
        upper += rem
        lower += rem

        return lower / upper
    }

    function getLowerBoundResourcesSymbol(a: SymbolNode, b: SymbolNode) {
        const g1 = getResourceGroups(a)
        const g2 = getResourceGroups(b)
        let c = 0

        for (const [k, v] of Object.entries(g1)) {
            const o = g2[k]
            if (o === undefined) {
                c += v.length
            } else {
                c += getLowerBoundResources(v, o)
            }
        }

        for (const [k, v] of Object.entries(g2)) {
            if (!(k in g1)) {
                c += v.length
            }
        }

        const lb = c / (a.value.resources.length + b.value.resources.length)
        if (lb > 1 || Number.isNaN(lb)) {
            throw new Error(`Bad lower bound: ${lb}`)
        }

        return lb
    }


    function compareSymbolDeps(a: SymbolNode, b: SymbolNode) {
        const g1 = getResourceGroups(a)
        const g2 = getResourceGroups(b)
    }

    function compareResource(newResource: Resource, oldResource: Resource, excludedNew: Set<string>, excludedOld: Set<string>) {
        const nd = newDeps[`${newResource.type}.${newResource.name}`]
        const od = oldDeps[`${oldResource.type}.${oldResource.name}`]
    }

    function matchResources(oldResources: Resource[], newResources: Resource[]) {
        const r1 = oldResources!.map(x => createTypedNode('resource', x))
        const r2 = newResources!.map(x => createTypedNode('resource', x))
        const matches = findSimplePaths(
            (u, openSet) => {
                const sizeU = getSize(u.value.config)

                let m = Infinity
                let o: typeof u | undefined
                for (const v of openSet) {
                    const sizeV = getSize(v.value.config)
                    const delta = sizeU - sizeV
                    if (o && Math.abs(delta) >= m) {
                        // if (delta > 0) {
                        //     break
                        // }
                        continue
                    }

                    const d = getDist(u.value.config, v.value.config)
                    if (d === 0) {
                        return [d, v]
                    }
                    if (d < m) {
                        m = d
                        o = v
                    }
                }

                return [m, o]
            },
            r1,
            r2
        )

        return matches
    }


    function matchResourcesByGroup(oldSymbol: SymbolNode, newSymbol: SymbolNode) {
        const matches: Record<string, { score: number; from: Resource; to: Resource }[]> = {}
        const g1 = getResourceGroups(oldSymbol)
        const g2 = getResourceGroups(newSymbol)

        const visited = new Set<string>()
        for (const [k, v] of Object.entries(g1)) {
            const v2 = g2[k]
            if (v2) {
                visited.add(k)
                matches[k] = matchResources(v, v2).map(x => ({ score: x[0], from: x[1].value, to: x[2].value }))
            }
        }

        for (const [k, v] of Object.entries(g2)) {
            if (visited.has(k)) continue
            const v2 = g1[k]
            if (v2) {
                matches[k] = matchResources(v, v2).map(x => ({ score: x[0], from: x[2].value, to: x[1].value }))
            }
        }

        return matches
    }

    function resourceGroupDist(oldResources: Resource[], newResources: Resource[]) {
        const z = matchResources(oldResources, newResources)

        let tc = 0
        const seenOld = new Set<Resource>()
        const seenNew = new Set<Resource>()
        for (const [cc, oldNode, newNode] of z) {
            tc += cc
            seenOld.add(oldNode.value)
            seenNew.add(newNode.value)
        }

        const sizeOld = oldResources.length
        const sizeNew = newResources.length
        if ((sizeNew - seenNew.size) > 0 && seenOld.size !== sizeOld) {
            throw new Error('Invariant broken')
        }

        if ((sizeOld - seenOld.size) > 0 && seenNew.size !== sizeNew) {
            throw new Error('Invariant broken')
        }

        const m = Math.min(sizeOld, sizeNew)
        if (z.length !== m) {
            throw new Error(`Invariant broken: ${z.length} !== ${m}`)
        }


        tc += oldResources.filter(x => !seenOld.has(x)).map(x => getSize(x.config)).reduce((a, b) => a + b, 0)
        tc += newResources.filter(x => !seenNew.has(x)).map(x => getSize(x.config)).reduce((a, b) => a + b, 0)

        // Matching the smallest values is treated as the worst-case scenario because
        // our goal is to find the best possible matches, _not_ minimize the total cost
        const l1 = oldResources.map(x => getSize(x.config)).sort((a, b) => a - b)
        const l2 = newResources.map(x => getSize(x.config)).sort((a, b) => a - b)
        let i = 0
        let t = 0
        for (; i < m; i++) {
            t += Math.max(l1[i], l2[i])
        }
        t += (l1.length > l2.length ? l1 : l2).slice(i).reduce((a, b) => a + b, 0)

        const total = tc / t
        if (total > 1) {
            throw new Error(`Total must be less than 1: ${total} > 1 (${tc} / ${t})`)
        }

        return total * (l1.length + l2.length)
    }

    function symbolResourceDiff(a: SymbolNode, b: SymbolNode) {
        let c = 0
        const g1 = getResourceGroups(a)
        const g2 = getResourceGroups(b)

        for (const [k, v] of Object.entries(g1)) {
            const v2 = g2[k]
            if (v2) {
                c += resourceGroupDist(v, v2)
            } else {
                c += v.length
            }
        }

        for (const [k, v] of Object.entries(g2)) {
            if (!(k in g1)) {
                c += v.length
            }
        }

        // const m = a.value.resources.length + b.value.resources.length
        // if (c > m) {
        //     throw new Error(`Bad total: ${c} [maxLength: ${m}]`)
        // }

        return c
    }

    const ldn = keyedMemoize((a: string, b: string) => {
        const d = ld(a, b)
        
        return d / Math.max(a.length, b.length)
    })

    function symbolNameDiff(a: SymbolNode, b: SymbolNode) {
        const ndn = ldn(a.value.name, b.value.name)
        const fdn = ldn(a.value.fileName, b.value.fileName)

        return (ndn / 2) + (fdn / 2)
    }

    function groupByFile<T extends Node<{ id: number; name: string; fileName: string }>>(nodes: Iterable<T>) {
        const m = new Map<string, T[]>()

        for (const n of nodes) {
            if (!m.has(n.value.fileName)) {
                m.set(n.value.fileName, [])
            }
            m.get(n.value.fileName)!.push(n)
        }
    
        for (const arr of m.values()) {
            arr.sort((a, b) => a.value.name.localeCompare(b.value.name))
        }

        return m
    }

    const symbolDiffCache = new Map<string, number>()
    function symbolDiff(a: SymbolNode, b: SymbolNode) {
        const k = `${a.value.id}:${b.value.id}`
        if (symbolDiffCache.has(k)) {
            return symbolDiffCache.get(k)!
        }

        const d = symbolResourceDiff(a, b)
        const m = a.value.resources.length + b.value.resources.length
        if (d > m) {
            throw new Error(`Bad math: ${d} > ${m}`)
        }

        const c = (((1 + symbolNameDiff(a, b)) * (1 + (d / m))) - 1) / 3
        symbolDiffCache.set(k, c)

        return c
    }

    interface Key {
        next(m: number, n: number): Key
        next(m: number, n: number | undefined): Key
        next(m: number | undefined, n: number): Key
        toString(): string
    }

    function createPosKey(): Key {
        const keys: Record<string, Key> = {}

        function inner(posM: number[], posN: number[], str = ''): Key {
            function next(m: number | undefined, n: number | undefined) {
                const nPosM = m !== undefined ? [...posM, m].sort() : posM
                const nPosN = n !== undefined ? [...posN, n].sort() : posN
                const k = `${nPosM.join('.')}:${nPosN.join('.')}`
               
                return keys[k] ??= inner(nPosM, nPosN, k)
            }

            function toString() {
                return str
            }

            return { next, toString }
        }

        return inner([], [])
    }

    function findSimplePaths<T extends Node<{ id: number; name: string; fileName: string }>>(
        getBestDist: (u: T, openSet: Iterable<T>, byFile: T[], minScore?: number) => readonly [number, T | undefined],
        oldSymbols: T[], 
        newSymbols: Iterable<T>
    ) {
        interface State {
            pairs: [cost: number, old: T, new: T][]
            rem: T[]
            openSet: Set<T>
            score: number
            fScore: number
            key: Key
        }

        const pq = createMinHeap<State>((a, b) => {
            const d = a.fScore - b.fScore
            if (d === 0) {
                return a.rem.length - b.rem.length
            }
            return d
        })

        const openSet = new Set(newSymbols)
        const maxMatches = Math.min(oldSymbols.length, openSet.size)
        pq.insert({
            pairs: [],
            rem: [...oldSymbols],
            openSet,
            score: 0,
            fScore: maxMatches,
            key: createPosKey(),
        })

        const scores = new Map<string, number>()
        const byFile = groupByFile(openSet)

        while (true) {
            const s = pq.extract()
            if (s.pairs.length === maxMatches) {
                return s.pairs
            }

            const u = s.rem[0]
            const bf = byFile.get(u.value.fileName)?.filter(y => s.openSet.has(y)) ?? []
            const r = getBestDist(u, s.openSet, bf)
            if (!r[1]) {
                throw new Error(`No matches: ${u}`)
            }

            const os = new Set(s.openSet)
            os.delete(r[1])

            const rem = s.rem.slice(1)
            const ns = s.score + r[0] + 1
            const k = s.key.toString()
            const ls = scores.get(k)
            if (ls !== undefined && ns >= ls) {
                continue
            }

            scores.set(k, ns)

            // if (r[0] > 0 && !greedy) {
            //     lowerBounds![u.value.id] = r[0]
            //     const fScore = s.score + (maxMatches - s.pairs.length) + r[0] + lb
            //     pq.insert({ ...s, rem: [...rem, u], fScore })
            //     bounds.set(k, lowerBounds!)
            // }

            pq.insert({
                rem,
                score: ns,
                openSet: os,
                pairs: [...s.pairs, [r[0], u, r[1]]],
                fScore: ns + (maxMatches - (s.pairs.length + 1)),
                key: s.key.next(u.value.id, r[1].value.id),
            })
        }
    }

    function createEstimator(f1: SymbolNode[], f2: Iterable<SymbolNode>) {
        const counts: Record<string, number> = {}
        let total = 0
        for (const f of f1) {
            for (const [k, v] of Object.entries(getResourceGroups(f))) {
                counts[k] = (counts[k] ?? 0) + v.length
                total += v.length
            }
        }
        for (const f of f2) {
            for (const [k, v] of Object.entries(getResourceGroups(f))) {
                counts[k] = (counts[k] ?? 0) - v.length
                total += v.length
            }
        }

        function next(n: SymbolNode | undefined, o: SymbolNode | undefined) {
            const z = { ...counts }
            if (n) {
                for (const [k, v] of Object.entries(getResourceGroups(n))) {
                    z[k] = (z[k] ?? 0) - v.length
                }
            }
            if (o) {
                for (const [k, v] of Object.entries(getResourceGroups(o))) {
                    z[k] = (z[k] ?? 0) + v.length
                }
            }

            return Object.values(z).reduce((a, b) => a + Math.abs(b), 0)
        }

        function getTotal() {
            return total
        }

        return { next, getTotal }
    }

    function checkSymbols(symbols: SymbolNode[]) {
        for (const s of symbols) {
            if (s.value.resources.length === 0) {
                throw new Error(`Symbol has no resources: ${printNode(s)}`)
            }
        }
    }

    function findSymbolMatches(oldSymbols: SymbolNode[], newSymbols: SymbolNode[]) {
        checkSymbols(oldSymbols)
        checkSymbols(newSymbols)

        interface State {
            currentNodes?: [SymbolNode, SymbolNode]
            ops: Operation<SymbolNode>[],
            rem: SymbolNode[]
            openSet: Set<SymbolNode>
            score: number
            fScore: number
            key: Key
        }

        const pq = createMinHeap<State>((a, b) => {
            const d = a.fScore - b.fScore
            if (d === 0) {
                return a.rem.length - b.rem.length
            }
            return d
        })

        // `u` goes with `oldSymbols` (rem)

        function findPerfectMatches(u: SymbolNode, byFile: SymbolNode[]) {
            const matches: [SymbolNode, SymbolNode][] = []
            for (const v of byFile) {
                if (v.value.name !== u.value.name) continue

                const lb = getLowerBoundResourcesSymbol(u, v)
                if (lb !== 0) continue

                const d = symbolDiff(u, v)
                if (d === 0) {
                    matches.push([u, v])
                }
            }

            return matches
        }

        function findBestMatches(rem: SymbolNode[], openSet: Iterable<SymbolNode>) {
            const scores: [number, SymbolNode, SymbolNode][] = []

            for (const u of rem) {
                for (const v of openSet) {
                    const m = scores[v.value.id]?.[0] ?? Infinity
                    const lb = getLowerBoundResourcesSymbol(u, v)
                    if (lb === 1 || (lb / 3) > m) {
                        continue
                    }

                    const nd = symbolNameDiff(u, v)
                    if ((nd / 3) > m) {
                        continue
                    }
    
                    const d = symbolDiff(u, v)
                    if (d <= m) {
                        scores[v.value.id] = [d, u, v]
                    }
                }
            }

            return scores
        }

        function findBestInsertMatches(rem: SymbolNode[], openSet: Iterable<SymbolNode>) {
            const scores: [number, SymbolNode, SymbolNode][] = []

            for (const v of openSet) {
                for (const u of rem) {
                    const m = scores[u.value.id]?.[0] ?? Infinity
                    const lb = getLowerBoundResourcesSymbol(u, v)
                    if (lb === 1 || (lb / 3) > m) {
                        continue
                    }

                    const nd = symbolNameDiff(u, v)
                    if ((nd / 3) > m) {
                        continue
                    }
    
                    const d = symbolDiff(u, v)
                    if (d <= m) {
                        scores[u.value.id] = [d, u, v]
                    }
                }
            }

            return scores
        }

        function getInitial() {
            const rem: SymbolNode[] = []
            const openSet = new Set(newSymbols)
            const byFile = groupByFile(openSet)
            const ops: Operation<SymbolNode>[] = []

            for (const u of oldSymbols) {
                const matches = findPerfectMatches(u, byFile.get(u.value.fileName)?.filter(x => openSet.has(x)) ?? [])
                if (matches.length === 0) {
                    rem.push(u)
                    continue
                }

                if (matches.length > 1) {
                    const first = matches.shift()!
                    openSet.delete(first[1])
                    ops.push({ type: 'match', left: u, right: first[1] })
                    // getLogger().log('perfect match (dupe)', printNode(u), printNode(first[1]))
                    continue
                }

                const [_, v] = matches[0]
                openSet.delete(v)
                ops.push({ type: 'match', left: u, right: v })
                // getLogger().log('perfect match', u.value.id, v.value.id)
            }

            const imbalance = rem.length - openSet.size

            if (imbalance > 0) {
                const w = findBestMatches(rem, openSet).filter(x => x !== undefined).sort((a, b) => b[0] - a[0])
                const missing = rem.filter(x => !w.find(y => y[1] === x))

                function remove(n: SymbolNode) {
                    const idx = rem.indexOf(n)
                    ops.push({ type: 'remove', node: rem.splice(idx, 1)[0] })
                }

                for (let i = 0; i < imbalance; i++) {
                    if (missing.length > 0) {
                        remove(missing.shift()!)
                    } else {
                        const m = w.shift()!
                        remove(m[1])
                    }
                }
            }

            if (imbalance < 0) {
                const w = findBestInsertMatches(rem, openSet).filter(x => x !== undefined).sort((a, b) => b[0] - a[0])
                const missing = [...openSet].filter(x => !w.find(y => y[2] === x))

                function insert(n: SymbolNode) {
                    ops.push({ type: 'insert', node: n })
                    openSet.delete(n)
                }

                for (let i = 0; i < Math.abs(imbalance); i++) {
                    if (missing.length > 0) {
                        insert(missing.shift()!)
                    } else {
                        const m = w.shift()!
                        insert(m[2])
                    }
                }
            }

            return {
                ops,
                rem,
                openSet,
                score: 0,
                fScore: rem.length,
                key: createPosKey(),
            }
        }

        const scores = new Map<string, number>()
        const initial = getInitial()
        pq.insert(initial)

        while (true) {
            const s = pq.extract()
            const opsLeft = s.rem.length
            if (opsLeft === 0) {
                return s.ops
            }

            // getLogger().log(s.ops.length - initial.ops.length, s.score, s.fScore, pq.length)

            if (s.currentNodes) {
                const [u, v] = s.currentNodes

                const d = symbolDiff(u, v)

                const ns = s.score + d + 1
                const nextKey = s.key.next(u.value.id, v.value.id)
                const k = nextKey.toString()
                const ls = scores.get(k)
                if (ls === undefined || ns < ls) {
                    scores.set(k, ns)

                    const rem = s.rem.slice(1)
                    const openSet = new Set(s.openSet)
                    openSet.delete(v)

                    // Not entirely accurate
                    const isMatch = (
                        u.value.name === v.value.name && 
                        u.value.fileName === v.value.fileName && 
                        u.value.resources.length === v.value.resources.length
                    )

                    pq.insert({
                        rem,
                        ops: [...s.ops, { 
                            type: !isMatch ? 'update' : 'match', 
                            left: u, 
                            right: v
                        }],
                        openSet,
                        score: ns,
                        fScore: ns + (opsLeft - 1) * 2, // We defer expanding paired nodes
                        key: nextKey,
                    })
                }

                continue
            }

            const u = s.rem[0]
            const g1 = getResourceGroups(u)
            const c: Record<string, number> = {}
            for (const [k, v] of Object.entries(g1)) {
                c[k] = v.length
            }

            const est = createEstimator(s.rem, s.openSet)

            for (const v of s.openSet) {
                const g2 = getResourceGroups(v)
                const cd = { ...c }
                for (const [k, v] of Object.entries(g2)) {
                    cd[k] = (cd[k] ?? 0) - v.length
                }

                const m = u.value.resources.length + v.value.resources.length
                const rh = Object.values(cd).reduce((a, b) => a + Math.abs(b), 0) / m
                if (rh !== 1) {
                    const nd = symbolNameDiff(u, v)
                    const h2 = (((1 + nd) * (1 + rh)) - 1) / 3
                    const h3 = est.next(u, v) / ((est.getTotal() - m) || 1)

                    pq.insert({
                        ...s,
                        currentNodes: [u, v],
                        fScore: s.score + (h2 + (h3 / 3) + opsLeft),
                    })
                }
            }
        }
    }

    function solve() {
        return findSymbolMatches(g2.getSymbols(), g1.getSymbols())
    }

    return {
        solve,
        matchResourcesByGroup,
    }
}

export function detectRefactors(
    newResources: Record<string, any>,
    newSourceMap: TerraformSourceMap,
    oldResources: Record<string, any>,
    oldSourceMap: TerraformSourceMap,
    newDeps: Record<string, Set<string>>,
    oldDeps: Record<string, Set<string>>,
) {
    const moves = new Map<string, { to: string; fromSymbol: Symbol; toSymbol: Symbol }>()
    const gs = createGraphSolver(newResources, newSourceMap, oldResources, oldSourceMap, newDeps, oldDeps)
    const ops = gs.solve()

    for (const op of ops) {
        if (op.type === 'match' || op.type === 'update') {
            const m = gs.matchResourcesByGroup(op.left, op.right)
            for (const g of Object.values(m)) {
                for (const m of g) {
                    const from = `${m.from.type}.${m.from.name}`
                    const to = `${m.to.type}.${m.to.name}`

                    if (from !== to) {
                        const p = moves.get(from)?.to
                        if (p !== undefined && p !== to) {
                            throw new Error(`Detected conflict for resource "${from}": ${p} !== ${to} [${op.type} ${printNode(op.left)}, ${printNode(op.right)}]`)
                        }
                        moves.set(from, {
                            to,
                            fromSymbol: op.left.value,
                            toSymbol: op.right.value,
                        })
                    }
                }
            }
        } else {
            getLogger().log('Extra op', printOp(op))
        }
    }

    return [...moves.entries()].map(([k, v]) => ({ from: k, to: v.to, fromSymbol: v.fromSymbol, toSymbol: v.toSymbol }))
}

function mapScope(scope: { callSite: number; assignment?: number; namespace?: number[] }, sourcemap: TerraformSourceMap) {
    return {
        callSite: sourcemap.symbols[scope.callSite],
        assignment: scope.assignment ? sourcemap.symbols[scope.assignment] : undefined,
        namespace: scope.namespace ? scope.namespace.map(x => sourcemap.symbols[x]) : undefined,
    }
}

function mapScopes(sourcemap: TerraformSourceMap) {
    return Object.fromEntries(Object.entries(sourcemap.resources).map(([k, v]) => [k, v.scopes.map(x => mapScope(x, sourcemap))]))
}


// A "resource symbol" is composed of multiple identifiers that form
// the origin point for one or more resources.
interface ResourceSymbol {
    readonly id: number
    readonly pos: number
    readonly name: string
    readonly fileName: string
    readonly resources: Resource[]
    readonly namespace?: { readonly name: string; readonly pos: number }[]
    readonly assignment?: { readonly name: string; readonly pos: number }
}

export function renderSymbolLocation(sym: Pick<Symbol, 'line' | 'column' | 'fileName'>, includePosition = false) {
    const pos = `:${sym.line + 1}:${sym.column + 1}`

    return `${sym.fileName}${includePosition ? pos : ''}`
}

export function renderSymbol(sym: Symbol, includeFileName = true, includePosition = false) {
    const suffix = includeFileName ? ` ${renderSymbolLocation(sym, includePosition)}` : ''

    return `${sym.name}${suffix}`
}

export function evaluateMoveCommands(template: TfJson, state: TfState) {
    const commands = template['//']?.moveCommands
    if (!commands || commands.length === 0) {
        return
    }

    const resources: Record<string, Record<string, any>> = {}
    for (const [k, v] of Object.entries(template.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            const byType = resources[k2] ??= {}
            byType[k] = v2
        }
    }

    function findResources(params: { prefix: string; suffix: string; types: string[]; middle?: string }) {
        const matched: TfState['resources'] = []
        for (const r of state.resources) {
            if (!r.name.startsWith(params.prefix) || !r.name.endsWith(params.suffix)) {
                continue
            }

            if (params.middle) {
                const sliced = r.name.slice(params.prefix.length, -params.suffix.length)
                if (!sliced.includes(params.middle)) {
                    continue
                }
            }

            if (params.types.includes(r.type)) {
                matched.push(r)
            }
        }

        return matched
    }

    const conflictedTo = new Set<string>()
    const conflictedFrom = new Set<string>()

    const moved: { from: string; to: string }[] = []
    for (const cmd of commands) {
        const matchedTemplates: Record<string, Record<string, any>> = {}
        for (const [k, v] of Object.entries(resources)) {
            if (k.startsWith(cmd.scope) && !conflictedTo.has(k)) {
                matchedTemplates[k] = v
            }
        }

        function getPrefixAndSuffix(key: string) {
            if (cmd.type === 'fixup') {
                const parts = cmd.scope.split('--')
                const index = -3
                if (parts.at(index) !== cmd.name) {
                    throw new Error(`Invalid fixup: ${cmd.name} in scope ${cmd.scope}`)
                }

                const prevScope = parts.slice(0, index).concat(parts.slice(index + 1, -1)).join('--')

                return {
                    prefix: prevScope,
                    suffix: key.slice(cmd.scope.length),
                }
            }

            if (cmd.name.startsWith('this.')) {
                const [module, ...rem] = cmd.scope.split('_') 
                const scope = rem.join('_')

                const parts = scope.split('--')
                const middle = [parts.at(-2), cmd.name.slice('this.'.length)].join('--')
                if (parts.length === 2) {
                    return {
                        prefix: module + '_',
                        middle,
                        suffix: key.slice(cmd.scope.length),
                    }
                }

                return {
                    prefix: module + '_' + parts.slice(0, -2).join('--'),
                    middle,
                    suffix: key.slice(cmd.scope.length),
                }
            }

            const prevScope = [...cmd.scope.split('--').slice(0, -1), cmd.name].join('--')

            return {
                prefix: prevScope,
                suffix: key.slice(cmd.scope.length),
            }
        }

        for (const [k, v] of Object.entries(matchedTemplates)) {
            const matchedResources = findResources({
                ...getPrefixAndSuffix(k),
                types: Object.keys(v),
            })

            for (const r of matchedResources) {
                if (conflictedFrom.has(`${r.type}.${r.name}`)) continue

                // This can happen if we already create a new resource instead of moving it
                if (state.resources.find(x => x.type === r.type && x.name === k)) continue

                const from = `${r.type}.${r.name}`
                const to = `${r.type}.${k}`
                if (from === to) continue

                const conflicts: number[] = []
                for (let i = 0; i < moved.length; i++) {
                    if ((moved[i].from === from || moved[i].to === to) && !(moved[i].from === from && moved[i].to === to)) {
                        conflicts.push(i)
                    }
                }

                if (conflicts.length > 0) {
                    getLogger().debug(`skipping refactor match due conflicting move: ${from} ---> ${to}`)

                    for (const index of conflicts.reverse()) {
                        const { from, to } = moved[index]
                        conflictedFrom.add(from)
                        conflictedTo.add(to)
                        moved.splice(index, 1)
                    }

                    continue
                }

                moved.push({ from, to })
            }
        }
    }

    return moved
}

interface Move {
    from: string
    to: string 
}

export interface MoveWithSymbols {
    from: string
    to: string
    fromSymbol: Symbol
    toSymbol: Symbol
}

function getMoveWithSymbols(move: Move, oldGraph: SymbolGraph, newGraph: SymbolGraph) {
    const fromSymbol = oldGraph.findSymbolFromResourceKey(move.from)?.value
    const toSymbol = newGraph.findSymbolFromResourceKey(move.to)?.value
    if (!fromSymbol || !toSymbol) {
        return
    }

    if (renderSymbol(fromSymbol) !== renderSymbol(toSymbol)) {
        return {
            ...move,
            fromSymbol,
            toSymbol,
        }
    }

    const from = fromSymbol.resources.find(r => `${r.type}.${r.name}` === move.from)
    const to = toSymbol.resources.find(r => `${r.type}.${r.name}` === move.to)
    if (!from || !to) {
        return
    }

    const minLen = Math.min(from.scopes.length, to.scopes.length)
    for (let i = 1; i < minLen; i++) {
        const fromScope = from.scopes[i]
        const toScope = to.scopes[i]

        const fromName = getRenderedStatementFromScope(fromScope) 
        const toName = getRenderedStatementFromScope(toScope) 
        if (fromScope.callSite.fileName === toScope.callSite.fileName && fromName === toName) {
            continue
        }

        return {
            ...move,
            fromSymbol: { ...fromScope.callSite, name: fromName, column: fromScope.assignment?.column ?? fromScope.callSite.column },
            toSymbol: { ...toScope.callSite, name: toName, column: toScope.assignment?.column ?? toScope.callSite.column }
        }
    }
}

export function getMovesWithSymbols(moves: Move[], oldGraph: SymbolGraph, newGraph: SymbolGraph) {
    const result: MoveWithSymbols[] = []
    for (const m of moves) {
        const move = getMoveWithSymbols(m, oldGraph, newGraph)
        if (move) {
            result.push(move)
        }
    }
    return result
}

// Segments are delimited by `/` and describe named scopes
// `@` is used for ambiguous instance selection e.g. `foo@1` specifies the 2nd occurrence of `foo`

function parseSymbolRefSegment(segment: string) {
    // TODO: figure out escaping rules to work well with shells
    const scanner = createJsonPathScanner(segment)
    const scanned = Array.from(scanner.scan())
    if (scanned.length === 0) {
        throw new Error(`Failed to parse resource ref segment: ${segment}`)
    }

    const [name, selection] = scanned[0].split('@')

    if (selection && isNaN(Number(selection))) {
        throw new Error(`Not a number: ${selection}`)
    }

    return {
        name,
        selection: selection ? Number(selection) : undefined,
        accessors: scanned.slice(1),
    }
}

function parseSymbolRef(ref: string) {
    let filename: string | undefined
    let quote: '"' | "'" | undefined
    const segments: any[] = []

    let j = 0
    for (let i = 0; i < ref.length; i++) {
        if (quote) {
            if (ref[i] === quote) {
                quote = undefined
            }

            continue
        }

        if (ref[i] === '#' && filename === undefined) {
            filename = ref.slice(0, i)
            j = i + 1
        } else if (ref[i] === '/' && filename !== undefined) {
            segments.push(parseSymbolRefSegment(ref.slice(j, i)))
            j = i + 1
        } else if (ref[i] === '"' || ref[i] === "'") {
            quote = ref[i] as any
        } else if (i === ref.length - 1 && filename === undefined) {
            filename = ''
            i = 0
        }
    }

    if (j !== ref.length) {
        segments.push(parseSymbolRefSegment(ref.slice(j)))
    }

    return {
        filename,
        segments,
    }
}

// copied from `synapse:http`
function createJsonPathScanner(expression: string) {
    let pos = 0

    // This state is entered when encountering a '['
    function parseElementKey() {
        const c = expression[pos]
        if (c === "'" || c === '"') {
            for (let i = pos + 1; i < expression.length; i++) {
                if (expression[i] === c) {
                    if (expression[i + 1] !== ']') {
                        throw new Error(`Expected closing bracket at position ${pos}`)
                    }

                    const token = expression.slice(pos + 1, i)
                    pos = i + 2

                    return token
                }
            }
        } else {
            if ((c < '0' || c > '9') && c !== '-') {
                throw new Error(`Expected a number or - at position ${pos}`)
            }

            for (let i = pos + 1; i < expression.length; i++) {
                const c = expression[i]
                if (c  === ']') {
                    const token = expression.slice(pos, i)
                    pos = i + 1

                    return token
                }

                if (c < '0' || c > '9') {
                    throw new Error(`Expected a number at position ${pos}`)
                }
            }
        }

        throw new Error(`Malformed element access at position ${pos}`)
    }

    function parseIdentifer() {
        for (let i = pos; i < expression.length; i++) {
            const c = expression[i]
            if (c === '[' || c === '.') {
                const token = expression.slice(pos, i)
                pos = i

                return token
            }
        }

        const token = expression.slice(pos)
        pos = expression.length

        return token
    }

    function* scan() {
        if (pos === expression.length) {
            return
        }

        while (pos < expression.length) {
            const c = expression[pos]
            if (c === '[') {
                pos += 1
    
                yield parseElementKey()
            } else if (c === '.') {
                pos += 1
    
                yield parseIdentifer()
            } else {
                yield parseIdentifer()
            }
        }
    }

    return { scan }
}

// TODO:
// Implement heuristics for detecting "splits" and "merges"
//
// Example of a "split":
//
// --- OLD CODE ---
//
// function foo() {
//     const x = new Bar()
//     // do stuff with `x`
// }
//
// --- NEW CODE ---
//
// const x = new Bar()
// foo(x)
//
// function foo(x: Bar) {
//     // do stuff with `x`
// }
//
// ----------------
//
// The above is a very common type of refactor when 
// wanting to share code. In this case we wanted to make
// `foo` more modular by extracting out an instantiation
//
//
//
// Example of a "merge":
//
// --- OLD CODE ---
//
// const x = new Bar()
// const y = new Baz(x)
// const z = foobar(x, y)
//
// --- NEW CODE ---
//
// function createFoobar() {
//     const x = new Bar()
//     const y = new Baz(x)
//     
//     return foobar(x, y)
// }
// 
// const z = createFoobar()
//
// ----------------
//
// This type of refactor is commonly used to hide intermediate
// steps that were needed to create what the caller wanted
//