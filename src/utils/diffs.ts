import { DataPointer, isDataPointer, maybeConvertToPointer } from '../build-fs/pointers'
import { colorize, print, printLine } from '../cli/ui'
import { arrayEditDistance, levenshteinDistance } from '../utils'

function renderKey(key: PropertyKey) {
    if (typeof key === 'string') {
        return `${key}:`
    } else if (typeof key === 'number') {
        return `<${key}>`
    }

    if (key.description) {
        return `[@@${key.description}]:`
    }

    return `[unique symbol]:`
}

const renderHashWidth = 12
function renderHash(h: string) {
    return h.slice(0, renderHashWidth)
}

export function showJsonDiff(diff: JsonDiff, depth = 0, key?: PropertyKey): void {
    const printWithIndent = (s: string, showKey = true, d = depth) => {
        const withKey = key && showKey ? `${renderKey(key)} ${s}` : s
        printLine(`${'  '.repeat(d)}${withKey}`)
    }

    switch (diff.kind) {
        case 'none':
        case 'reference':
            if (depth === 0) {
                printLine('No differences')
            } else if (diff.kind === 'reference') {
                // printWithIndent('[ref]')
            } else {
                printWithIndent('[none]')
            }
            return

        case 'type':
            printWithIndent(`[type] ${colorize('red', diff.left)} ${colorize('green', diff.right)}`)
            return
        
        case 'value':
            switch (diff.type) {
                case 'string':
                    printWithIndent(`${colorize('red', diff.left)} ${colorize('green', diff.right)}`)
                    return

                case 'pointer':
                    if (diff.metadata.kind !== 'none') {
                        const metadataDiff = `[metadata: ${colorize('red', renderHash(diff.metadata.left))} ${colorize('green', renderHash(diff.metadata.right))}]`
                        if (diff.left.hash === diff.right.hash) {
                            printWithIndent(metadataDiff)
                        } else {
                            printWithIndent(`${metadataDiff} ${colorize('red', renderHash(diff.left.hash))} ${colorize('green', renderHash(diff.right.hash))}`)
                        }
                    } else {
                        printWithIndent(`${colorize('red', renderHash(diff.left.hash))} ${colorize('green', renderHash(diff.right.hash))}`)
                    }
                    return    

                case 'symbol':
                case 'bigint':
                case 'number':
                case 'boolean':
                case 'function':
                    printWithIndent(`${colorize('red', String(diff.left))} ${colorize('green', String(diff.right))}`)
                    return

                case 'array':
                    printWithIndent('[')
                    for (let i = 0; i < diff.diff.length; i++) {
                        const d = diff.diff[i]
                        if (d.kind === 'none') continue

                        if (d.kind === 'type') {
                            if (d.left === 'undefined' && diff.length.kind === 'value' && diff.length.left < diff.length.right) {
                                printWithIndent(renderInsert(`<${i}> ${d.right}`),  false, depth + 1)
                            } else if (d.right === 'undefined' && diff.length.kind === 'value' && diff.length.right < diff.length.left) {
                                printWithIndent(renderRemove(`<${i}> ${d.left}`), false, depth + 1)
                            } else {
                                showJsonDiff(d, depth + 1, i)
                            }
                        } else {
                            showJsonDiff(d, depth + 1, i)
                        }
                    }
                    printWithIndent(']', false)
                    return

                case 'object': {
                    printWithIndent('{')
                    let inserts = 0
                    let deletions = 0
                    for (const d of diff.diff) {
                        if (d[0].kind === 'arrangment') {
                            if (d[0].order.left === -1) { // added
                                if (d[0].value.kind !== 'none') {
                                    throw new Error(`Key diff not implemented: ${d[0].value.kind}`)
                                }
                                inserts += 1
                                printWithIndent(renderInsert(`<${d[0].order.right}> ${d[0].value.value}:`), false, depth + 1)
                            } else if (d[0].order.right === -1) { // removed
                                if (d[0].value.kind !== 'none') {
                                    throw new Error(`Key diff not implemented: ${d[0].value.kind}`)
                                }
                                deletions += 1
                                printWithIndent(renderRemove(`<${d[0].order.left}> ${d[0].value.value}:`), false, depth + 1)
                            } else {
                                if (d[0].value.kind !== 'none') {
                                    throw new Error(`Key diff not implemented: ${d[0].value.kind}`)
                                }

                                // Don't show the order diff if it's accounted for by inserts/deletions
                                if (d[0].order.left + inserts === d[0].order.right - deletions) {
                                    showJsonDiff(d[1], depth + 1, `${d[0].value.value}`)
                                } else {
                                    const orderDiff = `<${colorize('red', String(d[0].order.left))} -> ${colorize('green', String(d[0].order.right))}>`
                                    if (d[1].kind === 'none' || d[1].kind === 'reference') {
                                        printWithIndent(`${orderDiff} ${d[0].value.value}: [same value]`, false, depth + 1)
                                    } else {
                                        showJsonDiff(d[1], depth + 1, `${orderDiff} ${d[0].value.value}`)
                                    }
                                }
                            }

                            continue
                        }

                        if (d[0].kind !== 'none') {
                            throw new Error(`Key diff not implemented: ${d[0].kind}`)
                        }

                        if (d[1].kind === 'none') continue

                        showJsonDiff(d[1], depth + 1, d[0].value)
                    }
                    printWithIndent('}', false)
                }
            }
    }
}

function greedilyMatchLines(l1: string[], l2: string[]) {
    const m = new Map<string, number[]>()
    for (let i = 0; i < l1.length; i++) {
        if (!m.has(l1[i])) {
            m.set(l1[i], [])
        }
        m.get(l1[i])!.push(i)
    }

    const pairs: [number, number][] = []
    for (let i = 0; i < l2.length; i++) {
        const arr = m.get(l2[i])
        if (!arr || arr.length === 0) continue

        pairs.push([arr.shift()!, i])
    }

    return pairs
}

function diffLine(a: string, b: string) {
    const r = arrayEditDistance(a.split(''), b.split(''), {
        update: (a, b) => 2,
    })

    for (const op of r.ops) {
        switch (op[0]) {
            case 'insert':
                print(colorize('green', op[1]))
                break
            case 'remove':
                print(colorize('red', op[1]))
                break
            case 'noop':
                print(op[1])
                break
            case 'update':
                throw new Error('Should not happen')
        }
    }
}

export function diffLines(a: string, b: string) {
    const l1 = a.split('\n')
    const l2 = b.split('\n')

    const pairs = greedilyMatchLines(l1, l2)

    for (const i of pairs.map(x => x[0]).sort((a, b) => a - b).reverse()) {
        l1.splice(i, 1)
    }

    for (const i of pairs.map(x => x[1]).sort((a, b) => a - b).reverse()) {
        l2.splice(i, 1)
    }

    const r = arrayEditDistance(l1, l2, {
        insert: a => a.length,
        remove: b => b.length,
        update: (a, b) => levenshteinDistance(a, b),
        // update: (a, b) => a.length + b.length,
    })

    if (r.ops.length === 0) {
        printLine(colorize('paleGreen', 'Files are the same'))
        return
    }

    for (const op of r.ops) {
        switch (op[0]) {
            case 'insert':
                printLine(renderInsert(op[1]))
                break
            case 'remove':
                printLine(renderRemove(op[1]))
                break
            case 'update':
                diffLine(op[1], op[2])
                printLine()
                break
        }
    }
}

type PrimitiveType = 'object' | 'symbol' | 'number' | 'string' | 'undefined' | 'bigint' | 'function' | 'boolean'
type ExtendedType = PrimitiveType | 'array' | 'null' | 'pointer'

interface JsonNoDiff {
    readonly kind: 'none'
    readonly value: any
}

interface JsonReferenceDiff {
    readonly kind: 'reference'
    readonly type: 'object' | 'array' // or function
    readonly left: any
    readonly right: any
}

interface JsonTypeDiff {
    readonly kind: 'type'
    readonly left: ExtendedType
    readonly right: ExtendedType
    readonly leftValue: any
    readonly rightValue: any
}

interface JsonPrimitiveValueDiff<T = any> {
    readonly kind: 'value'
    readonly type: Exclude<ExtendedType, 'null' | 'undefined' | 'object' | 'array'>
    readonly left: T
    readonly right: T
}

interface JsonStructuredValueDiff<T = any> {
    readonly kind: 'value'
    readonly diff: T
}

interface JsonArrangementDiff {
    readonly kind: 'arrangment'
    readonly order: JsonNumberDiff
    readonly value: Exclude<JsonDiff, JsonTypeDiff>
}

type JsonKeyDiff = JsonNoDiff | JsonStringDiff | JsonNumberDiff | JsonSymbolDiff | JsonTypeDiff | JsonArrangementDiff

interface JsonObjectDiff extends JsonStructuredValueDiff<[key: JsonKeyDiff, value: JsonDiff][]> {
    readonly type: 'object'
}

interface JsonArrayDiff extends JsonStructuredValueDiff<JsonDiff[]> {
    readonly type: 'array'
    readonly length: JsonNoDiff | JsonNumberDiff
}

interface JsonStringDiff extends JsonPrimitiveValueDiff<string> {
    readonly type: 'string'
}

interface JsonNumberDiff extends JsonPrimitiveValueDiff<number> {
    readonly type: 'number'
}

interface JsonBigintDiff extends JsonPrimitiveValueDiff<bigint> {
    readonly type: 'bigint'
}

interface JsonBooleanDiff extends JsonPrimitiveValueDiff<boolean> {
    readonly type: 'boolean'
}

interface JsonSymbolDiff extends JsonPrimitiveValueDiff<symbol> {
    readonly type: 'symbol'
}

interface JsonFunctionDiff extends JsonPrimitiveValueDiff<Function> {
    readonly type: 'function'
}

interface JsonPointerDiff extends JsonPrimitiveValueDiff<DataPointer> {
    readonly type: 'pointer'
    readonly metadata: JsonNoDiff | JsonStringDiff
}

type JsonDiff = 
    | JsonNoDiff
    | JsonReferenceDiff
    | JsonPointerDiff
    | JsonTypeDiff 
    | JsonObjectDiff
    | JsonArrayDiff
    | JsonStringDiff
    | JsonNumberDiff
    | JsonBigintDiff
    | JsonBooleanDiff
    | JsonSymbolDiff
    | JsonFunctionDiff

function getExtendedType(o: any): ExtendedType {
    if (o === null) {
        return 'null'
    } else if (Array.isArray(o)) {
        return 'array'
    } else if (isDataPointer(o)) {
        return 'pointer'
    }

    return typeof o
}

function jsonObjectDiff(a: any, b: any): JsonObjectDiff | JsonReferenceDiff {
    const diff: [key: JsonKeyDiff, value: JsonDiff][] = []
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    const orderA = Object.fromEntries(keysA.map((k, i) => [k, i]))
    const orderB = Object.fromEntries(keysB.map((k, i) => [k, i]))
    // A new key in A that appears last should not come before a new key in B that appears first
    // Not sure if this works as intended
    const getSortOrder = (k: string) => orderB[k] ?? orderA[k]
    const keys = new Set([...keysA, ...keysB].sort((a, b) => getSortOrder(a) - getSortOrder(b)))
    for (const k of keys) {
        const x = orderA[k] ?? -1
        const y = orderB[k] ?? -1
        const orderDiff = jsonDiff(x, y)
        const kDiff: JsonKeyDiff = orderDiff.kind !== 'none'
            ? { kind: 'arrangment', order: orderDiff as JsonNumberDiff, value: { kind: 'none', value: k } }
            : { kind: 'none', value: k}

        diff.push([kDiff, jsonDiff(a[k], b[k])])
    }

    if (diff.every(d => d[0].kind === 'none' && (d[1].kind === 'none' || d[1].kind === 'reference'))) {
        return { kind: 'reference', type: 'object', left: a, right: b }
    }

    return {
        kind: 'value',
        type: 'object',
        diff,
    }
}

function jsonArrayDiff(a: any[], b: any[]): JsonArrayDiff | JsonReferenceDiff {
    const maxLength = Math.max(a.length, b.length)
    const diff: JsonDiff[] = Array(maxLength)
    const length = jsonDiff(a.length, b.length) as JsonArrayDiff['length']
    for (let i = 0; i < maxLength; i++) {    
        diff[i] = jsonDiff(a[i], b[i])
    }

    if (diff.every(d => d.kind === 'none' || d.kind === 'reference') && length.kind === 'none') {
        return { kind: 'reference', type: 'array', left: a, right: b }
    }

    return {
        kind: 'value',
        type: 'array',
        diff,
        length,
    }
}

function jsonPointerDiff(a: DataPointer, b: DataPointer): JsonPointerDiff | JsonNoDiff {
    if (a.isResolved() && b.isResolved()) {
        const l = a.resolve()
        const r = b.resolve()
        if (l.hash === r.hash) {
            if (l.storeHash !== r.storeHash) {
                return {
                    kind: 'value',
                    type: 'pointer',
                    left: a,
                    right: b,
                    metadata: jsonDiff(l.storeHash, r.storeHash) as JsonStringDiff,
                }
            }
            return { kind: 'none', value: l }
        }
    }

    return {
        kind: 'value',
        type: 'pointer',
        left: a,
        right: b,
        metadata: { kind: 'none', value: '' }, // wrong
    }
}

export function jsonDiff(a: any, b: any): JsonDiff {
    if (a === b) {
        return { kind: 'none', value: a }
    }

    // We only do this because reading "raw" objects won't deserialize pointers
    a = maybeConvertToPointer(a)
    b = maybeConvertToPointer(b)

    const left = getExtendedType(a)
    const right = getExtendedType(b)

    if (left !== right) {
        return {
            kind: 'type',
            left,
            right,
            leftValue: a,
            rightValue: b,
        }
    }

    switch (left) {
        case 'symbol':
        case 'bigint':
        case 'number':
        case 'string':
        case 'boolean':
        case 'function':
            return { kind: 'value', type: left, left: a, right: b }

        case 'pointer':
            return jsonPointerDiff(a, b)

        case 'array':
            return jsonArrayDiff(a, b)

        case 'object':
            return jsonObjectDiff(a, b)

        case 'null':
        case 'undefined':
            throw new Error(`Primitive types possibly from different realms: ${a} !== ${b}`)
    }
}

export function renderInsert(s: string) {
    return colorize('green', `+ ${s}`)
}

export function renderRemove(s: string) {
    return colorize('red', `- ${s}`)
}
