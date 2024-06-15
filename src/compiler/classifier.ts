import ts from 'typescript'
import * as path from 'node:path'
import { resolveProgramConfig } from './config'
import { getFs } from '../execution'
import { getWorkingDir } from '../workspaces'
import { Mutable, memoize } from '../utils'

const semanticTokenTypes = [
    'class',
    'enum',
    'interface',
    'namespace',
    'typeParameter',
    'type',
    'parameter',
    'variable',
    'enumMember',
    'property',
    'function',
    'member',
] as const

type SemanticTokenType = (typeof semanticTokenTypes)[number]

function getSemanticTokenType(n: number) {
    return semanticTokenTypes[(n >> 8) - 1] as SemanticTokenType
}

export interface ClassifiedSpan {
    readonly start: number
    readonly length: number
    readonly syntacticType: ts.ClassificationType
    readonly semanticType?: SemanticTokenType
    readonly modifiers?: TokenModifiers
}

interface TokenModifiers {
    readonly declaration?: boolean
    readonly static?: boolean
    readonly async?: boolean
    readonly readonly?: boolean
    readonly defaultLibrary?: boolean
    readonly local?: boolean
}

function getModifiers(n: number): TokenModifiers {
    const masked = n & 255

    return {
        declaration: !!(masked & (1 << 0)),
        static: !!(masked & (1 << 1)),
        async: !!(masked & (1 << 2)),
        readonly: !!(masked & (1 << 3)),
        defaultLibrary: !!(masked & (1 << 4)),
        local: !!(masked & (1 << 5)),
    }
}

async function createLanguageServiceHost() {
    const fs = getFs()
    const config = await resolveProgramConfig()

    const copy = { ...config.tsc.cmd.options, lib: ['lib.es5.d.ts'], types: [] }

    const files: Record<string, { version: number }> = {}
    for (const f of config.tsc.cmd.fileNames) {
        files[f] = { version: 0 }
    }

    const servicesHost: ts.LanguageServiceHost = {
        getScriptFileNames: () => config.tsc.cmd.fileNames,
        getScriptVersion: fileName => files[fileName]?.version.toString(),
        getScriptSnapshot: fileName => {
          if (!fs.fileExistsSync(fileName)) {
            return undefined
          }
    
          return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName).toString())
        },
        getCurrentDirectory: () => process.cwd(),
        getCompilationSettings: () => copy,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
    }

    return servicesHost
}

// function enhanceSpans(typeChecker: ts.TypeChecker, sf: ts.SourceFile, spans: ClassifiedSpan[]) {
//     function findNode(pos: number, end: number, parent: ts.Node = sf): ts.Node | undefined {
//         return parent.forEachChild(n => {
//             if (n.pos === pos - n.getLeadingTriviaWidth() && n.end === end) {
//                 return n
//             }

//             return findNode(pos, end, n)
//         })
//     }

//     for (const s of spans) {
//         if (s.semanticType === 'function' || s.semanticType === 'type') continue

//         const node = findNode(s.start, s.start + s.length)
//         if (!node) continue

//         switch (node.kind) {
//             case ts.SyntaxKind.BooleanKeyword:
//             case ts.SyntaxKind.StringKeyword:
//             case ts.SyntaxKind.NumberKeyword:
//                 ;(s as Mutable<typeof s>).semanticType = 'type'
//                 continue
//         }

//         if (node.kind === ts.SyntaxKind.UndefinedKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
//             const isTypeNode = ts.findAncestor(node, p => ts.isTypeNode(p))
//             if (isTypeNode) {
//                 ;(s as Mutable<typeof s>).semanticType = 'type'
//             }

//             continue
//         }

//         if (ts.isIdentifier(node) && (node.text === 'undefined' || node.text === 'null')) {
//             ;(s as Mutable<typeof s>).semanticType = undefined
//             ;(s as Mutable<typeof s>).syntacticType = ts.ClassificationType.keyword
//             continue
//         }

//         const type = typeChecker.getTypeAtLocation(node)
//         if (type.getCallSignatures().length > 0) {
//             ;(s as Mutable<typeof s>).semanticType = 'function'
//             continue
//         }
//     }

//     return spans
// }

export const getLanguageService = memoize(async () => {
    const host = await createLanguageServiceHost()

    return ts.createLanguageService(host)
})

function getClassifiedSpans(service: ts.LanguageService, sf: ts.SourceFile, span = ts.createTextSpan(0, sf.text.length)) {
    const spans = new Map<string, ClassifiedSpan>()

    function getSpan(start: number, length: number): ClassifiedSpan {
        const key = `${start}:${length}`
        if (spans.has(key)) {
            return spans.get(key)!
        }

        const s: ClassifiedSpan = {
            start,
            length,
            syntacticType: ts.ClassificationType.text,
        }
        spans.set(key, s)

        return s
    }

    const syntactic = service.getEncodedSyntacticClassifications(
        sf.fileName,
        span,
    )

    for (let i = 0; i < syntactic.spans.length; i += 3) {
        const s = getSpan(syntactic.spans[i], syntactic.spans[i+1])
        ;(s as Mutable<ClassifiedSpan>).syntacticType = syntactic.spans[i+2]
    }

    const semantic = service.getEncodedSemanticClassifications(
        sf.fileName,
        span,
        ts.SemanticClassificationFormat.TwentyTwenty,
    )

    for (let i = 0; i < semantic.spans.length; i += 3) {
        const s = getSpan(semantic.spans[i], semantic.spans[i+1])
        ;(s as Mutable<ClassifiedSpan>).modifiers = getModifiers(semantic.spans[i+2])
        ;(s as Mutable<ClassifiedSpan>).semanticType = getSemanticTokenType(semantic.spans[i+2])
    }

    return [...spans.values()].sort((a, b) => a.start - b.start)
}

interface Position {
    readonly line: number
    readonly column: number
}

interface Range {
    readonly start: Position | number
    readonly end: Position | number
}

export async function getClassifications(fileName: string, range?: Range) {
    const s = await getLanguageService()
    const p = s.getProgram()
    if (!p) {
        throw new Error(`No program found`)
    }

    const rp = path.resolve(getWorkingDir(), fileName)
    const sf = p.getSourceFile(rp)
    if (!sf) {
        throw new Error(`Missing source file: ${rp}`)
    }

    const lines = sf.getLineStarts()

    function getOffset(p: Position | number) {
        if (typeof p === 'number') {
            return p
        }

        const line = Math.min(p.line, lines.length - 1)
        const eol = line === lines.length - 1 
            ? sf!.getEnd()-1
            : lines[line+1]-1

        return Math.min(p.column + lines[line], eol)
    }

    if (range) {
        const start = getOffset(range.start)
        const end = getOffset(range.end)

        return {
            sourceFile: sf,
            spans: getClassifiedSpans(s, sf, ts.createTextSpan(start, end - start)),
            getOffset,
        }
    }

    return {
        sourceFile: sf,
        spans: getClassifiedSpans(s, sf),
        getOffset,
    }
}
