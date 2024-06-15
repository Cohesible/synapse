import ts from 'typescript'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { SourceMapV3, toInline, findSourceMap } from '../runtime/sourceMaps'
import { SourceMap } from 'node:module'

// FIXME: delete this file?

export function getNodeLocation(node: ts.Node) {
    const sf = node.getSourceFile()
    if (!sf) {
        return
    }

    const pos = node.pos + node.getLeadingTriviaWidth(sf)
    const lc = sf.getLineAndCharacterOfPosition(pos)

    return `${sf.fileName}:${lc.line + 1}:${lc.character + 1}`
}

export function failOnNode(message: string, node: ts.Node, showSourceWhenMissing = true): never {
    node = ts.getOriginalNode(node)
    const location = getNodeLocation(node)
    if (!location && showSourceWhenMissing) {
        throw new Error(`${message} [kind: ${node.kind}]\n${printNodes([node])}`)
    }

    throw new Error(`${message} [kind: ${node.kind}] (${location ?? 'missing source file'})`)
}        


const createSourcefile = () => ts.factory.createSourceFile([], ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None)

type PrinterOptions = ts.PrinterOptions & { emitSourceMap?: boolean; sourceMapRootDir?: string; inlineSourceMap?: boolean; handlers?: ts.PrintHandlers }

interface EmitChunk {
    readonly text: string
    readonly sourcemap?: SourceMapV3
}

export function emitChunk(host: SourceMapHost, sourceFile: ts.SourceFile, statements?: ts.Statement[], opt?: PrinterOptions): EmitChunk
export function emitChunk(host: SourceMapHost, sourceFile: ts.SourceFile, statements: ts.Statement[], opt: PrinterOptions & { emitSourceMap: true }): Required<EmitChunk>
export function emitChunk(host: SourceMapHost, sourceFile: ts.SourceFile, statements?: ts.Statement[], opt: PrinterOptions = {}) {
    const updated = statements ? ts.factory.updateSourceFile(sourceFile, statements) : sourceFile
    const rootDir = host.getCurrentDirectory()
    const generator = opt.emitSourceMap
        ? createSourceMapGenerator(host, path.relative(rootDir, sourceFile.fileName), undefined, rootDir, {})
        : undefined

    const writer = createTextWriter()
    const handlers = opt.handlers
    delete opt.handlers

    const printer = ts.createPrinter({ inlineSourceMap: true, ...opt } as any, handlers) as ts.Printer & { 
        writeFile: (sourceFile: ts.SourceFile, writer: TextWriter, generator?: SourceMapGenerator) => void 
    }

    printer.writeFile(updated, writer, generator)

    return {
        text: writer.getText(),
        sourcemap: generator?.toJSON(),
    }
}

// return + '\n\n' + toInline(sourcemap)

export function printNodes(nodes: ts.Node[], source = nodes[0]?.getSourceFile() ?? createSourcefile(), options?: PrinterOptions) {
    const printer = ts.createPrinter(options)
    const result = nodes.map(n => printer.printNode(ts.EmitHint.Unspecified, n, source))

    return result.join('\n')
}

export function isNonNullable<U>(val: U): val is NonNullable<U> {
    return val !== undefined && val !== null
}

export function createVariableStatement(name: string | ts.Identifier, exp: ts.Expression, modifiers?: ts.ModifierSyntaxKind[], factory = ts.factory) {
    const modifierTokens = modifiers?.map(m => factory.createModifier(m))
    const decl = factory.createVariableDeclaration(name, undefined, undefined, exp)

    return factory.createVariableStatement(
        modifierTokens,
        factory.createVariableDeclarationList([decl], ts.NodeFlags.Const)
    )
}

interface ObjectLiteralInput {
    readonly [key: string]: Literal | Literal[]
}

type Literal = string | number | boolean | ts.Expression | ObjectLiteralInput | undefined

export function getModuleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): ts.StringLiteral {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
        failOnNode('No module specifier found', node)
    }
    
    return node.moduleSpecifier
}

function getUtil(): typeof import('node:util') {
    return require('node:util')
}

export function getNullTransformationContext(): ts.TransformationContext {
    if (!('nullTransformationContext' in ts)) {
        const inspected = getUtil().inspect(ts, { 
            colors: false, 
            showHidden: true, 
            compact: true, 
            depth: 1,
            sorted: true,
        })

        throw new Error(`No transformation context found. Current exports: ${inspected}`)
    }

    return (ts as any).nullTransformationContext
}

// Not correct
interface TextWriter {
    write(str: string): void
    getLine(): number
    getColumn(): number
    getText(): string
}

function createTextWriter(): TextWriter {
    if (!('createTextWriter' in ts)) {
        throw new Error(`No text writer found`)
    }

    return (ts as any).createTextWriter('\n')
}

// Not correct
interface SourceMapGenerator {
    addMapping(...args: unknown[]): unknown
    addSource(fileName: string): number
    toJSON(): SourceMapV3
}

export interface SourceMapHost {
    getCurrentDirectory(): string
    getCanonicalFileName: (fileName: string) => string
}

function createSourceMapGenerator(host: SourceMapHost, fileName: string, sourceRoot: string | undefined, sourcesDirectoryPath: string, opt: any): SourceMapGenerator {
    if (!('createSourceMapGenerator' in ts)) {
        throw new Error(`No source map generator found`)
    }

    return (ts as any).createSourceMapGenerator(host, fileName, sourceRoot, sourcesDirectoryPath, opt)
}

export function extract<T>(arr: T[], index: number): T {
    const v = arr[index]
    arr[index] = arr[arr.length - 1]
    arr.length -= 1

    return v
}


