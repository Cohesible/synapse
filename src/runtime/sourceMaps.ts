import { getLogger } from '../logging'
import { isNonNullable } from '../utils'

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function encodeVlqBase64(vlqs: number[]) {
    return vlqs.map(n => base64Alphabet[n]).join('')
}

const base64Map = Object.fromEntries(base64Alphabet.split('').map((c, i) => [c, i]))

function decodeVlqBase64(vlq: string) {
    const result: number[] = []
    for (let i = 0; i < vlq.length; i++) {
        result.push(base64Map[vlq[i]])
    }
    return result
}

export function encodeVlq(n: number): number[] {
    if (n === 0) return [n]

    let val = Math.abs(n)
    const result: number[] = []
    while (val > 0) {
        let x = 0
        if (result.length === 0) {
            x |= (val & 0xF) << 1
            x |= n >= 0 ? 0 : 1
            val >>>= 4
        } else {
            x = val & 0x1F
            val >>>= 5
        }

        x |= val > 0 ? 0x20 : 0
        result.push(x)
    }

    return result
}

export function decodeVlq(vlq: number[]): number[] {
    const result: number[] = []
    let val: number | undefined = undefined
    let isNegative = false
    let offset = 0
    for (let i = 0; i < vlq.length; i++) {
        if (val === undefined) {
            val = (vlq[i] >>> 1) & 0xF
            isNegative = (vlq[i] & 0x1) === 1
            offset = 4
        } else {
            val |= (vlq[i] & 0x1F) << offset
            offset += 5
        }

        if ((vlq[i] & 0x20) === 0) {
            result.push(isNegative ? -val : val)
            val = undefined
            offset = 0
        }
    }

    if (val !== undefined) {
        throw new Error(`Malformed VLQ array did not terminate: ${vlq}`)
    }

    return result
}

export function decodeMappings(mappings: string) {
    let prevSourceIdx = 0, prevSourceLine = 0, prevSourceColumn = 0, prevNameIdx = 0

    const res: MappingSegment[] = []
    const lines = mappings.split(';')
    for (let i = 0; i < lines.length; i++) {
        let prevColumn = 0
        const segments = lines[i].split(',')
        for (let j = 0; j < segments.length; j++) {
            const segment = segments[j]
            if (!segment) continue

            const decoded = decodeVlq(decodeVlqBase64(segment))
            if (decoded.length === 0) {
                throw new Error(`Malformed source mapping: ${segment}`)
            }

            const fromColumn = decoded[0] + prevColumn
            prevColumn = fromColumn

            if (decoded.length === 1) {
                res.push({
                    fromLine: i,
                    toLine: i,
                    fromColumn,
                    toColumn: 0, // Not sure if these mappings are ever relevant
                })
            } else if (decoded.length >= 4) {
                const sourceIndex = decoded[1] + prevSourceIdx
                const toLine = decoded[2] + prevSourceLine
                const toColumn = decoded[3] + prevSourceColumn
                const symbolIndex = decoded.length >= 5 ? decoded[4] + prevNameIdx : undefined
                prevSourceIdx = sourceIndex
                prevSourceLine = toLine
                prevSourceColumn = toColumn
                prevNameIdx = symbolIndex ?? prevNameIdx

                res.push({
                    fromLine: i,
                    toLine,
                    fromColumn,
                    toColumn,
                    sourceIndex,
                    symbolIndex,
                })
            }
        }
    }

    return res
}

export interface SourceMapV3 {
    version: 3
    file?: string
    sourceRoot?: string
    sources: string[]
    sourcesContent?: string[]
    names: string[]
    mappings: string
}

// from = generated
// to = original

interface Mapping {
    fromLine: number // zero-based 
    toLine: number
    fromColumn: number
    toColumn: number
}

interface MappingSegment extends Mapping {
    sourceIndex?: number
    symbolIndex?: number
}

export function toInline(sourcemap: SourceMapV3) {
    const encoded = Buffer.from(JSON.stringify(sourcemap), 'utf-8').toString('base64')

    return `//# sourceMappingURL=data:application/json;base64,${encoded}`
}

export function createSourceMapGenerator() {
    const groups = new Map<number, Mapping[]>()

    function addMapping(mapping: Mapping) {
        const line = mapping.fromLine
        if (!groups.has(line)) {
            groups.set(line, [])
        }

        const group = groups.get(mapping.fromLine)!
        group.push(mapping)
    }

    function generate(sourceFileName: string): SourceMapV3 {
        const lines = Array.from(groups.keys()).sort()
        if (lines.length === 0) {
            return { version: 3, sources: [sourceFileName], names: [], mappings: '' }
        }

        const lastLine = lines[lines.length - 1]

        let mappings = ''
        let prevSourceIdx = 0, prevSourceLine = 0, prevSourceColumn = 0, prevNameIdx = 0
        for (let i = 0; i < lastLine; i++) {
            const g = groups.get(i)
            if (!g) {
                mappings += ';'
                continue
            }

            let prevColumn = 0
            const segs: string[] = []
            for (const segment of g) {
                const column = segment.fromColumn - prevColumn
                const sourceLine = segment.toLine - prevSourceLine
                const sourceColumn = segment.toColumn - prevSourceColumn
                const vlqs = [
                    ...encodeVlq(column),
                    0, // sourceIdx
                    ...encodeVlq(sourceLine),
                    ...encodeVlq(sourceColumn),
                ]

                prevColumn = segment.fromColumn
                prevSourceLine = segment.toLine
                prevSourceColumn = segment.toColumn
                segs.push(`${encodeVlqBase64(vlqs)}`)
            }
            mappings += `${segs.join(',')};`
        }

        return {
            version: 3,
            sources: [sourceFileName],
            names: [],
            mappings,
        }
    }

    return { addMapping, generate }
}

export function parseDirectives(lines: string[]) {
    const directives = lines
        .map(l => l.match(/^\/\/#\s*([\w]+)\s*=\s*([^\s]+)/))
        .filter(isNonNullable)
        .map(c => [c[1], c[2]] as const)

    return Object.fromEntries(directives)
}

function findFooterDirective(contents: string) {
    const idx = contents.lastIndexOf('//#')
    if (idx === -1) {
        return
    }

    return contents.slice(idx + 3).trim()
}

interface InlineResult {
    readonly type: 'inline'
    readonly data: SourceMapV3
}

interface ReferenceResult {
    readonly type: 'reference'
    readonly location: string
}

type ParseResult = InlineResult | ReferenceResult

function parseSourceMap(directive: string): ParseResult | undefined {
    const url = /^sourceMappingURL=(.*)/.exec(directive)?.[1]
    if (!url) {
        return
    }

    if (url.startsWith('data:')) {
        const [type, data] = url.slice(5).split(',', 2)
        const [contentType, encoding = 'utf-8'] = type.split(';', 2)
        if (contentType !== 'application/json') {
            getLogger().log('Not implemented:', directive)
            return
        }
    
        if (encoding !== 'utf-8' && encoding !== 'base64') {
            getLogger().log('Not implemented:', directive)
            return
        }

        const parsed = JSON.parse(Buffer.from(data, 'base64').toString('utf-8')) as SourceMapV3
    
        return { type: 'inline', data: parsed }
    }

    return { type: 'reference', location: url }
}

export function findSourceMap(fileName: string, contents: string) {
    const directive = findFooterDirective(contents)
    if (!directive) {
        return
    }

    const result = parseSourceMap(directive)
    if (result?.type === 'inline') {
        return result.data
    } else if (result?.type === 'reference') {
        const baseUrl = new URL(`file:${fileName}`)

        return new URL(result.location, baseUrl)
    }
}

export function dumpMappings(sourcemap: SourceMapV3) {
    const mappings = decodeMappings(sourcemap.mappings)
    
    for (const m of mappings) {
        console.log(`${m.fromLine}:${m.fromColumn} -> ${m.toLine}:${m.toColumn}`)
    }
}

export function mergeSourcemaps(oldMap: SourceMapV3, newMap: SourceMapV3): SourceMapV3 {
    const merged = createSourceMapGenerator()
    const oldMappings = decodeMappings(oldMap.mappings)
    const index: Record<number, MappingSegment[]> = {}

    for (const m of oldMappings) {
        const arr = index[m.fromLine] ??= []
        arr.push(m)
    }

    function getPosition(segment: MappingSegment) {
        const mapping = index[segment.toLine]?.find(m => m.fromColumn === segment.toColumn)

        if (mapping) {
            return {
                ...segment,
                toLine: mapping.toLine, 
                toColumn: mapping.toColumn,
            }
        }
    }

    for (const segment of decodeMappings(newMap.mappings)) {
        const m = getPosition(segment)
        if (m) {
            merged.addMapping(m)
        }
    }

    return merged.generate(oldMap.sources[0])
}
