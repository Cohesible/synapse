import ts from 'typescript'
import * as path from 'node:path'
import { getFs } from '../execution'
import { RenderableError, colorize, dim, printLine, stripAnsi } from '../cli/ui'
import { ClassifiedSpan, getClassifications, getLanguageService } from './classifier'
import { getLogger } from '..'
import { AsyncResource } from 'async_hooks'
import { getWorkingDir } from '../workspaces'

interface SourceLocation {
    readonly line: number       // 1-indexed
    readonly column: number     // 1-indexed
    readonly fileName: string

    // For highlighting/marking text ranges
    readonly length?: number

    // Text describing the problem/solution/reason etc.
    readonly annotation?: string
}

interface Diagnostic {
    // readonly code: number
    readonly severity: 'warning' | 'error'
    readonly message: string
    readonly sources?: SourceLocation[]
}

function getNodeLocation(node: ts.Node, annotation?: string): SourceLocation {
    const sf = node.getSourceFile()
    if (!sf) {
        return {
            line: 0,
            column: 0,
            length: node.end - node.pos,
            annotation,
            fileName: 'unknown',
        }
    }

    const pos = node.pos + node.getLeadingTriviaWidth(sf)
    const lc = sf.getLineAndCharacterOfPosition(pos)

    return {
        annotation,
        line: lc.line + 1,
        column: lc.character + 1,
        fileName: sf.fileName,
        length: node.end - pos,
    }
}

interface FormatDiagnosticOptions {
    readonly workingDir?: string
    readonly showSource?: boolean
}

interface FormatSnippetOptions {
    context?: number
    maxWidth?: number
    colorizer?: (text: string, line: number, col: number) => string
}

function getSourceSnippet(source: SourceLocation, text: string, opt: FormatSnippetOptions = {}) {
    const {
        context = 1, 
        maxWidth = Math.min(80, process.stdout.columns), 
        colorizer
    } = opt

    const lines = text.split(/\r?\n/)
    const lineStart = Math.max(1, source.line - context)
    const selection = lines.slice(lineStart - 1, source.line)
    if (selection.length === 0) {
        return []
    }

    const truncationSymbol = '...'
    const gutterBorder= `| `
    const gutterWidth = String(source.line).length + gutterBorder.length

    // TODO: prefer discarding whitespace instead of centering
    const screenOffset = (source.column - 1) >= maxWidth
        ? (source.column - 1) - Math.floor(maxWidth / 2)
        : 0

    function formatLine(text: string, lineNumber: number) {
        const lineNumberText = String(lineNumber).padStart(gutterWidth - gutterBorder.length, ' ')
        const gutter = lineNumber === source.line
            ? `${lineNumberText}${dim(gutterBorder)}`
            : dim(`${lineNumberText}${gutterBorder}`)

        function withColor(text: string) {
            if (!colorizer) return text

            return colorizer(text, lineNumber - 1, screenOffset)
        }

        // TODO: don't add truncation marker if it's just whitespace
        if (text.length + gutterWidth >= maxWidth) {
            const truncated = text.slice(0, maxWidth - (gutterWidth + truncationSymbol.length))

            return `${gutter}${withColor(truncated)}${dim(truncationSymbol)}`
        }

        return `${gutter}${withColor(text)}`
    }

    const formatted = selection
        .map(t => t.slice(screenOffset))
        .map((t, i) => formatLine(t, i + lineStart))

    function makeFooter() {
        const len = source.length ?? 1
        const squiggles = colorize('brightRed', '~'.repeat(len).padStart(gutterWidth + (source.column - screenOffset) + len-1, ' '))
        if (source.annotation) {
            return `${squiggles} ${colorize('brightRed', source.annotation)}`
        }

        return squiggles
    }

    return [
        ...formatted,
        makeFooter(),
    ]
}

const controlKeywords = [
    'await',
    'import',
    'export',
    'from',
    'switch',
    'case',
    'return',
    'break',
    'continue',
    'if',
    'else',
    'throw',
    'for',
    'default',
]

// TODO: primitive types are treated as keywords
const primitives = ['number', 'string', 'boolean', 'symbol', 'bigint', 'null']

function colorizeSpan(text: string, span: ClassifiedSpan): string {
    if (span.semanticType) {
        switch (span.semanticType) {
            case 'function':
                return colorize('paleYellow', text)

            case 'type':
            case 'typeParameter':
            case 'class':
                return colorize('brightGreen', text)

            case 'member':
            case 'property':
            case 'parameter':
            case 'variable':
                if (span.modifiers?.readonly) {
                    return colorize('brightCyan', text)
                }
                return colorize('paleCyan', text)
        }
    }

    switch (span.syntacticType) {
        case ts.ClassificationType.comment:
            return colorize('commentGreen', text)

        case ts.ClassificationType.keyword:
            if (controlKeywords.includes(text)) {
                return colorize('brightPurple', text)
            }

            return colorize('brightBlue', text)

        case ts.ClassificationType.stringLiteral:
            if (text.startsWith('/') && text.endsWith('/')) { // TODO: flags
                return colorize('red', text) // regexp literal
            }
            return colorize('orange2', text)

        case ts.ClassificationType.numericLiteral:
            return colorize('paleGreen', text)

        case ts.ClassificationType.identifier:
            return colorize('paleCyan', text)


    }

    return text
}

function colorizeText(text: string, spans: ClassifiedSpan[]): string {
    for (let i = spans.length - 1; i >= 0; i--) {
        const s = spans[i]
        const end = s.start + s.length
        text = text.slice(0, s.start) + colorizeSpan(text.slice(s.start, end), s) + text.slice(end)
    }

    return text
}

function formatDiagnostic(diag: Diagnostic, opt?: FormatDiagnosticOptions) {

}

function maybeGetBetterNode(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
        return node.name
    }

    if (ts.isVariableDeclaration(node)) {
        return node.name
    }

    return node
}

async function renderSnippets(locations: NodeOrSource[], context = 2) {
    if (locations.length === 0) {
        return
    }

    const mapped = locations.map(n => isSourceLocation(n) ? n : annotateNode(n, ''))

    for (let i = 0; i < mapped.length; i++) {
        const location = mapped[i]
        const previous = mapped[i-1]

        let ctx = context
        if (previous?.fileName === location.fileName) {
            if ((location.line - context) <= previous.line && location.line >= previous.line) {
                ctx = location.line - previous.line - 1
            }
        } else {
            printLine(`${path.relative(getWorkingDir(), location.fileName)}:${location.line}:${location.column}`)
        }

        const classifications = await getClassifications(location.fileName, { 
            start: { line: location.line - (ctx + 1), column: 0 }, 
            end: { line: location.line, column: 0 } 
        })


        const text = classifications.sourceFile.getFullText()
        const snippet = getSourceSnippet(location, text, { context: ctx, colorizer: (text, line, column) => {
            const pos = classifications.getOffset({ line, column })
            const spans = classifications.spans
                .filter(s => s.start + s.length >= pos && s.start <= pos + text.length)
                .map(s => ({ ...s, start: s.start - pos }))

            return colorizeText(text, spans)
        }})

        for (const l of snippet) {
            printLine(l)
        }
    }
}

export function annotateNode(node: ts.Node, message: string): SourceLocation {
    return getNodeLocation(maybeGetBetterNode(ts.getOriginalNode(node)), message)
}

type NodeOrSource = ts.Node | SourceLocation

function isSourceLocation(obj: NodeOrSource): obj is SourceLocation {
    return 'line' in obj && 'column' in obj && 'fileName' in obj
}

export function compilerError(message: string, ...locations: NodeOrSource[]): never {
    const fn = AsyncResource.bind(async () => {
        await renderSnippets(locations)
        printLine()
        printLine(colorize('brightRed', `ERROR `) + colorize('brightWhite', `${message}`))
    })

    throw new RenderableError(message, fn)
}
