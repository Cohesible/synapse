import * as path from 'node:path'
import * as url from 'node:url'
import { Fs, SyncFs } from '../system'
import { SourceMapParser, createSourceMapParser, isSourceOrigin } from '../runtime/loader'

interface CallFrame {
    readonly url: string
    readonly scriptId: string
    readonly lineNumber: number
    readonly columnNumber: number
    readonly functionName: string
}

interface CpuProfileNode {
    readonly id: number
    readonly callFrame: CallFrame
    readonly hitCount: number
    readonly children?: CpuProfileNode['id'][]
    readonly positionTicks?: {
        readonly line: number
        readonly ticks: number
    }[]
}

interface CpuProfile {
    readonly nodes: CpuProfileNode[]
    readonly startTime: number
    readonly endTime: number
    readonly samples: number[]
    readonly timeDeltas: number[]
}

interface ProfileOptions {
    readonly name?: string // filename
    readonly interval?: number // in microseconds (default: 1000)
}

export function getCommandLineOptions(opt?: ProfileOptions) {
    const args = ['--cpu-prof']

    if (opt?.name) {
        args.push('--cpu-prof-name', opt.name)
    }

    if (opt?.interval) {
        args.push('--cpu-prof-interval', String(opt.interval))
    }

    return args
}

interface ParsedCallFrame extends Omit<CallFrame, 'url'> {
    readonly url?: URL
    readonly originalFrame: CallFrame
}

interface ParsedNode extends Omit<CpuProfileNode, 'callFrame'> {
    readonly callFrame: ParsedCallFrame
}

function applyRootMappings(fileName: string, rootMappings?: Record<string, string>): string {
    if (!rootMappings) {
        return fileName
    }

    for (const [k, v] of Object.entries(rootMappings)) {
        if (fileName.startsWith(k)) {
            return `${v}${fileName.slice(k.length)}`
        }
    }

    return fileName
}

function getSourceMap(sourcemapParser: SourceMapParser, frame: CallFrame) {
    if (!frame.url) {
        return
    }
    
    const frameUrl = tryParseUrl(frame.url)
    if (frameUrl.protocol !== 'file:') {
        return
    }

    const fileName = url.fileURLToPath(frameUrl.href)

    return sourcemapParser.tryParseSourcemap(fileName, true)
}

function tryParseUrl(url: string) {
    try {
        return new URL(url)
    } catch (err) {
        return new URL(`pointer:${url}`)
    }
}

function parseCallFrame(sourcemapParser: SourceMapParser, frame: CallFrame, rootMappings?: Record<string, string>): ParsedCallFrame {
    if (!frame.url) {
        return { ...frame, url: undefined, originalFrame: frame }
    }

    const frameUrl = tryParseUrl(frame.url)
    const parsed = { ...frame, url: frameUrl, originalFrame: frame }
    if (frameUrl.protocol !== 'file:') {
        return parsed
    }

    // TODO: if `lineNumber` is 0 and `columnNumber` is 11 then it's _probably_ a file being loaded
    // We should represent that somehow

    const fileName = url.fileURLToPath(frameUrl.href)
    const sourcemap = sourcemapParser.tryParseSourcemap(fileName, true)
    if (!sourcemap) {
        return parsed
    }

    // This is probably an import
    if (frame.lineNumber === 0 && frame.columnNumber === 0 && !frame.functionName) {
        // XXX: `findByEntry` doesn't work in this case so we have to infer
        const sources = sourcemap.payload.sources
        if (sources.length === 0 || sources.length > 1) {
            return parsed
        }

        const originalFile = applyRootMappings(path.resolve(path.dirname(fileName), sources[0]), rootMappings)

        return {
            ...parsed,
            url: url.pathToFileURL(originalFile),
            functionName: '(import)',
        }
    }

    const mapping = sourcemap.findOrigin(frame.lineNumber + 1, frame.columnNumber + 1)
    if (!isSourceOrigin(mapping)) {
        return parsed
    }

    const originalFile = applyRootMappings(path.resolve(path.dirname(fileName), mapping.fileName), rootMappings)

    return {
        ...parsed,
        url: url.pathToFileURL(originalFile),
        lineNumber: mapping.lineNumber - 1,
        columnNumber: mapping.columnNumber - 1,
        functionName: mapping.name ?? frame.functionName,
    }
}

function parseNode(sourcemapParser: SourceMapParser, node: CpuProfileNode, rootMappings?: Record<string, string>): ParsedNode {
    const positionTicks = node.positionTicks ? (function () { 
        const sourcemap = getSourceMap(sourcemapParser, node.callFrame)
        if (!sourcemap) {
            return node.positionTicks!
        }

        return node.positionTicks!.map(p => {
            const mapping = sourcemap.findOrigin(p.line + 1, node.callFrame.columnNumber + 1)
            if (!isSourceOrigin(mapping)) {
                return p
            }        

            return {
                line: mapping.lineNumber - 1,
                ticks: p.ticks,
            }
        })
    })() : undefined

    return {
        ...node,
        positionTicks,
        callFrame: parseCallFrame(sourcemapParser, node.callFrame, rootMappings),
    }
}

function printLink(frame: ParsedCallFrame, line?: number, workingDirectory?: string) {
    if (!frame.url) {
        return
    }

    const lineNumber = (line ?? frame.lineNumber) + 1
    const columnNumber = line !== undefined ? 1 : frame.columnNumber + 1
    const fileName = frame.url.protocol === 'file:' ? url.fileURLToPath(frame.url) : frame.url.href
    const rel = workingDirectory && fileName.startsWith(workingDirectory) ? path.relative(workingDirectory, fileName) : fileName

    return `${rel}:${lineNumber}:${columnNumber}`
}

function printNode(node: ParsedNode, workingDirectory?: string) {
    const link = printLink(node.callFrame, undefined, workingDirectory)
    const name = node.callFrame.functionName

    return `${name ? name : '(anonymous)'}${link ? ` ${link}` : ''}`
}

export async function loadCpuProfile(fs: Fs & SyncFs, fileName: string, workingDirectory: string, rootMappings?: Record<string, string>) {
    const sourcemapParser = createSourceMapParser(fs, undefined, workingDirectory)
    const data: CpuProfile = JSON.parse(await fs.readFile(path.resolve(workingDirectory, fileName), 'utf-8'))
    const duration = data.endTime - data.startTime // nanoseconds
    const totalSamples = data.samples.reduce((a, b) => a + b, 0)

    const nodes = new Map(data.nodes.map(n => [n.id, parseNode(sourcemapParser, n, rootMappings)] as const))

    const totalHits = new Map<number, number>()
    function getTotalHits(node: ParsedNode) {
        if (totalHits.has(node.id)) {
            return totalHits.get(node.id)!
        }

        let t = node.hitCount
        if (node.children) {
            for (const id of node.children) {
                t += getTotalHits(nodes.get(id)!)
            }
        }

        totalHits.set(node.id, t)

        return t
    }

    const byFile = new Map<string, ParsedNode[]>()
    for (const n of nodes.values()) {
        if (n.callFrame.url?.protocol !== 'file:') {
            continue
        }

        const p = url.fileURLToPath(n.callFrame.url)
        if (!byFile.has(p)) {
            byFile.set(p, [])
        }
        
        byFile.get(p)!.push(n)
    }

    const filesOnly = true
    const ignoreNodeModules = true

    // Groups all nodes by their callsite
    const groupedNodes = new Map<string, ParsedNode[]>()
    for (const n of nodes.values()) {
        if (filesOnly && n.callFrame.url?.protocol !== 'file:') {
            continue
        }
        if (ignoreNodeModules && n.callFrame.url?.pathname.includes('node_modules')) {
            continue
        }

        const l = printLink(n.callFrame)
        if (!l) {
            continue
        }

        if (!groupedNodes.has(l)) {
            groupedNodes.set(l, [])
        }
        
        groupedNodes.get(l)!.push(n)
    }

    const seen = new Set<number>()
    let hitsSum = 0

    const r: [total: number, self: number, node: ParsedNode][] = []

    for (const [k, v] of groupedNodes.entries()) {
        const deduped = new Set<number>()
        function visit(n: ParsedNode) {
            deduped.add(n.id)
            if (n.children) {
                for (const id of n.children) {
                    visit(nodes.get(id)!)
                }
            }
        }

        v.forEach(visit)

        let t = 0
        for (const id of deduped) {
            const hits = nodes.get(id)!.hitCount
            t += hits
            if (!seen.has(id)) {
                hitsSum += hits
                seen.add(id)
            }
        }

        const self = v.reduce((a, b) => a + b.hitCount, 0)

        r.push([t, self, v[0]])
    }

    const sortedByTotal = [...r].sort((a, b) => (b[0] - a[0]))
    const sortedBySelf = [...r].sort((a, b) => (b[1] - a[1]))

    const toPercentage = (hits: number) => Math.floor((hits / hitsSum) * 10000) / 100
    const topN = 50

    function printResult(x: (typeof r)[number]) {
        return `${toPercentage(x[0])}% ${toPercentage(x[1])}% ${printNode(x[2], workingDirectory)}`
    }
 
    return [
        'Sorted by total',
        ...sortedByTotal.slice(0, topN).map(printResult),
        '---------------------',
        'Sorted by self',
        ...sortedBySelf.slice(0, topN).map(printResult)
    ]
}

// This is to get the WS URL for Inspector
// http://host:port/json/list

