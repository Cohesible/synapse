import ts from 'typescript'
import * as path from 'node:path'
import * as assert from 'node:assert'
import * as zlib from 'node:zlib'
import * as fs from 'node:fs/promises'
import * as child_process from 'node:child_process'
import * as util from 'node:util'
import * as crypto from 'node:crypto'
// import type { CompiledChunk } from './artifacts'
import { SourceMapHost, emitChunk } from './static-solver/utils'
import { SourceMapV3 } from './runtime/sourceMaps'
import type { Fs, SyncFs } from './system'
import { homedir } from 'node:os'

interface ObjectLiteralInput {
    [key: string]: Literal | Literal[]
}

type Literal = boolean | string | number | ts.Expression | ObjectLiteralInput | undefined
type NonNullableLiteral = NonNullable<Literal> | Literal[]

export function isNode(obj: unknown): obj is ts.Node {
    return (
        !!obj && typeof obj === 'object' && 
        typeof (obj as any).kind === 'number' &&
        typeof (obj as any).flags === 'number'
    )
}

const dataPointer = Symbol.for('synapse.pointer')
function renderObject(o: any, factory = ts.factory): ts.Expression {
    if (o === null) {
        return factory.createNull()
    }

    if (Array.isArray(o)) {
        return createArrayLiteral(factory, o)
    }

    if (o[dataPointer]) {
        return factory.createStringLiteral(o.ref, true)
    }

    if (!isNode(o)) {
        return createObjectLiteral(o, factory)
    }

    return o as ts.Expression
}

export function createLiteral(v: Literal | Literal[], factory = ts.factory): ts.Expression {
    switch (typeof v) {
        case 'undefined':
            return factory.createIdentifier('undefined')
        case 'string':
            return factory.createStringLiteral(v, true)
        case 'number':
            if (v < 0) {
                return factory.createPrefixUnaryExpression(
                    ts.SyntaxKind.MinusToken,
                    factory.createNumericLiteral(-v),
                )
            }
            return factory.createNumericLiteral(v)
        case 'boolean':
            return v ? factory.createTrue() : factory.createFalse()
        case 'object':
            return renderObject(v)
    }

    throw new Error(`invalid value: ${v}`)
}

export function createArrayLiteral(factory: ts.NodeFactory, arr: Literal[]): ts.ArrayLiteralExpression {
    const elements: ts.Expression[] = []
    for (let i = 0; i < arr.length; i++) {
        const e = arr[i]
        if (e === undefined) {
            elements.push(factory.createOmittedExpression())
        } else {
            elements.push(createLiteral(e, factory))
        }
    }

    return factory.createArrayLiteralExpression(elements, true)
}

export function createObjectLiteral(obj: ObjectLiteralInput, factory = ts.factory): ts.ObjectLiteralExpression {
    const assignments = Object.entries(obj).map(([k, v]) => {
        if (typeof v === 'undefined') return
        // TODO: only use string literal key if the ident contains invalid characters
        // const key = factory.createIdentifier(k)
        const key = factory.createStringLiteral(k)
        const val = createLiteral(v, factory)
        
        return factory.createPropertyAssignment(key, val)
    }).filter(isNonNullable)

    return factory.createObjectLiteralExpression(assignments, true)
}

export function createPropertyAssignment(factory: ts.NodeFactory, key: string, value: NonNullableLiteral) {
    // TODO: only use string literal key if the ident contains invalid characters
    // const key = factory.createIdentifier(k)

    return factory.createPropertyAssignment(
        factory.createStringLiteral(key), 
        createLiteral(value, factory)
    )
}

export function createConstAssignment(factory: ts.NodeFactory, name: string, initializer: ts.Expression) {
    return factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            factory.createIdentifier(name),
            undefined,
            undefined,
            initializer
          )],
          ts.NodeFlags.Const
        )
    )      
}

export function prependStatements(factory: ts.NodeFactory, sourceFile: ts.SourceFile, ...statements: ts.Statement[]) {
    return factory.updateSourceFile(sourceFile, [
        ...statements,
        ...sourceFile.statements,
    ])
}

export function createEnvVarAccess(factory: ts.NodeFactory, key: string | ts.Expression) {
    return factory.createElementAccessExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier("process"),
          factory.createIdentifier("env")
        ),
        typeof key === 'string' ? factory.createStringLiteral(key) : key
      )
}

export function reduceAccessExpressionOld(factory: ts.NodeFactory, node: ts.Expression): ts.Expression[] {
    if (ts.isElementAccessExpression(node)) {
        return [
            ...reduceAccessExpressionOld(factory, node.expression),
            node.argumentExpression
        ]
    } else if (ts.isPropertyAccessExpression(node)) {
        return [
            ...reduceAccessExpressionOld(factory, node.expression),
            factory.createStringLiteral(node.name.text)
        ]
    } else if (ts.isNonNullExpression(node)) {
        return reduceAccessExpressionOld(factory, node.expression)
    }

    return [node]
}

// doesn't reduce into string lits
export function splitExpression(node: ts.Expression): ts.Expression[] {
    if (ts.isElementAccessExpression(node)) {
        return [
            ...splitExpression(node.expression),
            node.argumentExpression
        ]
    } else if (ts.isPropertyAccessExpression(node)) {
        return [
            ...splitExpression(node.expression),
            node.name 
        ]
    } else if (ts.isNonNullExpression(node)) {
        return splitExpression(node.expression)
    } else if (ts.isParenthesizedExpression(node)) {
        return splitExpression(node.expression)
    }

    return [node]
}

export function isNonNullable<U>(val: U): val is NonNullable<U> {
    return val !== undefined && val !== null
}

export function getImportSymbol(node: ts.Node, importDecl: ts.ImportDeclaration, typeChecker: ts.TypeChecker) {
    const sym = typeChecker.getSymbolAtLocation(node)
    if (!sym) {
        return
    }
    assert.ok(importDecl.importClause, 'Missing import clause')
    const name = importDecl.importClause.name
    if (name) {
        const nameSym = typeChecker.getSymbolAtLocation(name)
        if (sym === nameSym) {
            return nameSym
        }
    }
    const bindings = importDecl.importClause.namedBindings
    if (bindings) {
        if (ts.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
                const id = binding.propertyName ?? binding.name
                const bindingSym = typeChecker.getSymbolAtLocation(id) 
                if (sym === bindingSym) {
                    return bindingSym
                }
            }
        } else {
            const bindingSym = typeChecker.getSymbolAtLocation(bindings.name) 
            if (sym === bindingSym) {
                return bindingSym
            }
        }
    }
}

export function parseFqnOfSymbol(sym: ts.Symbol, typeChecker: ts.TypeChecker) {
    const fqn = typeChecker.getFullyQualifiedName(sym)
    const match = fqn.match(/(?:"(?<module>.+?)")?(?:\.(?<name>.+))?/)
    const { name, module } = match?.groups ?? {}

    if (!name && !module) {
        if (sym.valueDeclaration || sym.declarations) {
            // failOnNode(`Failed to match FQN of symbol (${fqn})`, sym.valueDeclaration)
            return { name: fqn, module: undefined }
        } else {
            throw new Error( `Failed to match FQN: ${fqn}`)
        }
    }

    return { name, module }
}

const createSourcefile = () => ts.factory.createSourceFile([], ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None)

export function printNodes(nodes: readonly ts.Node[], source = nodes[0].getSourceFile() ?? createSourcefile(), options?: ts.PrinterOptions) {
    const printer = ts.createPrinter(options)
    const result = nodes.map(n => printer.printNode(ts.EmitHint.Unspecified, n, source))

    return result.join('\n')
}

export function createSyntheticComment(text: string) {
    return {
        text,
        pos: -1,
        end: -1,
        hasLeadingNewline: true,
        hasTrailingNewLine: true,
        kind: ts.SyntaxKind.SingleLineCommentTrivia,
    } as const
}

export function getRootDeclarationNames(text: string): string[] {
    const sf = ts.createSourceFile('index.ts', text, ts.ScriptTarget.ES2020)
    const names: string[] = []
    for (const s of sf.statements) {
        if ((ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) && s.name && ts.isIdentifier(s.name)) {
            names.push(s.name.text)
        } else if (ts.isVariableStatement(s)) {
            for (const decl of s.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    names.push(decl.name.text)
                }
                // Not doing binding patterns
            }
        }
    }
    return names
}

export function getSymbolOfLastIdent(exp: ts.Expression, typeChecker: ts.TypeChecker) {
    const idents = splitExpression(exp)
    const termIdent = idents.pop()
    if (!termIdent) {
        return
    }

    return typeChecker.getSymbolAtLocation(termIdent)
}


export function getExpressionSymbols(exp: ts.Expression, typeChecker: ts.TypeChecker) {
    const idents = splitExpression(exp)

    return idents.map(n => typeChecker.getSymbolAtLocation(n))
}

export function createVariableStatement(name: string | ts.Identifier, exp: ts.Expression, modifiers?: ts.ModifierSyntaxKind[], factory = ts.factory) {
    const modifierTokens = modifiers?.map(m => factory.createModifier(m))
    const decl = factory.createVariableDeclaration(name, undefined, undefined, exp)

    return factory.createVariableStatement(
        modifierTokens,
        factory.createVariableDeclarationList([decl], ts.NodeFlags.Const)
    )
}

const importCache = new Map<ts.SourceFile, Map<ts.Symbol, ts.ImportDeclaration>>()
export function getImports(source: ts.SourceFile, typeChecker: ts.TypeChecker) {
    if (importCache.has(source)) {
        return importCache.get(source)!
    }

    // FIXME: source is `undefined`
    const importDeclarations = source?.statements.filter(ts.isImportDeclaration) ?? []
    const importedSymbols = new Map<ts.Symbol, ts.ImportDeclaration>()
    importDeclarations.forEach(decl => {
        for (const sym of getExports(decl, typeChecker)) {
            importedSymbols.set(sym, decl)
        }
    })

    importCache.set(source, importedSymbols)

    return importedSymbols
}

export function getExports(decl: ts.ImportDeclaration, typeChecker: ts.TypeChecker) {
    const moduleSym = typeChecker.getSymbolAtLocation(decl.moduleSpecifier)
    // XXX: assert.ok(moduleSym)
    // This can cause bundling to strip out things incorrectly!!!!
    if (!moduleSym) {
        return []
    }

    const bindings = decl.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
        const s = typeChecker.getSymbolAtLocation(bindings.name)

        if (s) {
            return [s, ...typeChecker.getExportsOfModule(moduleSym)]
        }
    }

    return typeChecker.getExportsOfModule(moduleSym)
}

export function appendParameter(exp: ts.NewExpression, param: ts.Expression, factory = ts.factory) {
    return factory.updateNewExpression(
        exp,
        exp.expression,
        exp.typeArguments,
        [...(exp.arguments ?? []), param]
    )
}

export function resolveAlias(sym: ts.Symbol, typeChecker: ts.TypeChecker): ts.Symbol {
    if (sym.flags & ts.SymbolFlags.Alias) {
        return typeChecker.getAliasedSymbol(sym)
    }

    return sym
}

export type TypedSymbol<T extends ts.Node = ts.Node> = ts.Symbol & { readonly valueDeclaration: T }
export function isSymbolOfType<T extends ts.Node>(
    sym: ts.Symbol | undefined, 
    fn: (node: ts.Node) => node is T
): sym is TypedSymbol<T> {
    return !!sym?.valueDeclaration && fn(sym.valueDeclaration)
}

function getScopeNode(node: ts.Node) {
    const parent = ts.findAncestor(node, p => {
        switch (p.kind) {
            case ts.SyntaxKind.SourceFile:
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
                return true

            case ts.SyntaxKind.Block:
                if (p.parent.kind === ts.SyntaxKind.IfStatement) {
                    return true
                }
        }

        return false
    })
    if (!parent) {
        failOnNode(`No enclosing element found`, node)
    }

    return parent
}

function getNameForThis(node: ts.Node) {
    const parent = ts.findAncestor(node, p => {
        switch (p.kind) {
            case ts.SyntaxKind.ClassExpression:
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.FunctionDeclaration:
                return true

            // case ts.SyntaxKind.GetAccessor:
            // case ts.SyntaxKind.SetAccessor:
            // case ts.SyntaxKind.MethodDeclaration:
            //     if (p.parent.kind === ts.SyntaxKind.ObjectLiteralExpression) {
            //         return true
            //     }

            default:
                return false
        }
    })

    if (!parent) {
        failOnNode(`Failed to get container declaration`, node)
    }

    // TODO: search for a name for the object literal
    // switch (parent.kind) {
    //     case ts.SyntaxKind.GetAccessor:
    //     case ts.SyntaxKind.SetAccessor:
    //     case ts.SyntaxKind.MethodDeclaration:
    //         return getName(parent.parent)
    // }

    return getName(parent)
}

// doesn't handle aliased identifiers yet
export function getName(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node)) {
        return node.text
    }

    // We could use the string literal 'this' instead of finding the containing decl.
    // Although this could be problematic when child classes override parent methods.
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
        return getNameForThis(node)
    }

    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        // if (!ts.isIdentifier(node.name)) {
        //     failOnNode(`Could not get name of node`, node)
        // }

        return getName(node.name)
    }

    if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        if (!node.name || !ts.isIdentifier(node.name)) {
            failOnNode(`Could not get name of declaration node`, node)
        }

        return getName(node.name)
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const parts = splitExpression(node.expression)
        const names = parts.map(getName).filter(isNonNullable)

        return names.join('--')
    }

    if (ts.isConstructorDeclaration(node)) {
        const parent = ts.findAncestor(node, ts.isClassDeclaration)
        if (!parent) {
            failOnNode('No class declaration found for constructor', node)
        }

        return getName(parent)!
    }

    if (ts.isPropertyAccessExpression(node)) {
        return [getName(node.expression), getName(node.name)].join('--')
    }

    if (ts.isFunctionExpression(node)) {
        if (node.name) {
            return getName(node.name)
        }

        return '__anonymous'
    }

    if (ts.isClassExpression(node)) {
        if (node.name) {
            return getName(node.name)
        }

        return '__anonymous'
    }

    if (ts.isExpressionWithTypeArguments(node)) {
        const parent = ts.findAncestor(node, ts.isClassDeclaration)
        if (!parent) {
            failOnNode('No class declaration found for extends clause', node)
        }

        return getName(parent)
    }

    if (ts.isObjectLiteralElement(node)) {
        if (!node.name) {
            return
        }

        return getName(node.name)
    }

    if (ts.isGetAccessorDeclaration(node)) {
        return getName(node.name)
    }

    if (node.kind === ts.SyntaxKind.SuperKeyword) {
        const parent = ts.findAncestor(node, ts.isClassDeclaration)
        const superClass = parent ? getSuperClassExpressions(parent)?.pop() : undefined
        if (!superClass) {
            failOnNode('No class declaration found when using `super` keyword', node)
        }

        return getName(superClass)
    }
}

function getNameWithDecl(node: ts.Node): string {
    const baseName = getName(node)
    if (!baseName) {
        failOnNode('No name', node)
    }

    const parent = ts.findAncestor(node, p => {
        switch (p.kind) {
            case ts.SyntaxKind.PropertyAssignment:
            case ts.SyntaxKind.PropertyDeclaration:
            case ts.SyntaxKind.VariableDeclaration:
                return true

            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.ExpressionStatement:
                return 'quit'
        }

        return false
    })

    const parentName = parent ? getName(parent) : undefined
    if (parentName !== undefined) {
        return [parentName, baseName].join('--')
    }

    // This is an anonymous instantiation
    return baseName
}

// Which nodes should be named?
// `CallExpression` and `NewExpression` (instantiations)
// `VariableDeclaration` and `PropertyDeclaration` (assignments)
//
// Anonymous instantiations of the same type within the same scope must be numbered
// according to their order of appearance moving from top to bottom
//
// These are only qualified w.r.t to a single instantiation scope


const cachedNames = new Map<ts.Node, string>()
const scopeNames = new Map<ts.Node, Set<string>>()
export function getInstantiationName(node: ts.Node) {
    node = ts.getOriginalNode(node)

    if (cachedNames.has(node)) {
        return cachedNames.get(node)!
    }

    const name = getNameWithinScope(node)
    cachedNames.set(node, name)

    return name

    function getNameWithinScope(node: ts.Node) {
        // Variable statements/declarations must be unique within a scope
        if (ts.isVariableStatement(node)) {
            return getName(node.declarationList.declarations[0])!
        } else if (ts.isVariableDeclaration(node)) {
            return getName(node)!
        } else if (ts.isClassDeclaration(node)) {
            return getName(node)!
        } else if (ts.isPropertyDeclaration(node)) {
            return getName(node)!
        }
    
        const scope = ts.getOriginalNode(getScopeNode(node))
        const name = getNameWithDecl(node)
        if (!scopeNames.has(scope)) {
            scopeNames.set(scope, new Set())
        }
        const currentNames = scopeNames.get(scope)!

        // we only need to do this with anonymous instantiations
        // if there is a variable or property decl then this is unncessary
        let maybeName = name
        let count = 0
        while (currentNames.has(`${maybeName}${count === 0 ? '' : `_${count}`}`)) count++

        const finalName = `${maybeName}${count === 0 ? '' : `_${count}`}`
        currentNames.add(finalName)

        return finalName
    }
}

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

export function getSuperClassExpressions(node: ts.ClassDeclaration) {
    return node.heritageClauses?.filter(c => c.token === ts.SyntaxKind.ExtendsKeyword)
        .map(c => [...c.types])
        .reduce((a, b) => a.concat(b), [])
        .map(t => t.expression)
}


export function getModuleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): ts.StringLiteral {
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
        failOnNode('No module specifier found', node)
    }
    
    return node.moduleSpecifier
}

// a little hacky but it works
export function getModuleQualifedName(node: ts.Node, typeChecker: ts.TypeChecker, rootDir: string) {
    if (!ts.isExpression(node)) {
        failOnNode('Not an expression', node)
    }

    const sym = typeChecker.getSymbolAtLocation(node)
    if (!sym) {
        failOnNode(`No symbol found`, node)
    }

    const imports = getImports(node.getSourceFile(), typeChecker)
    const importDecl = imports.get(sym) ?? imports.get(resolveAlias(sym, typeChecker))
    if (importDecl) {
        const modSpec = (importDecl.moduleSpecifier as ts.StringLiteral).text

        return `"${modSpec}".${sym.name}`
    }

    const fqn = typeChecker.getFullyQualifiedName(resolveAlias(sym, typeChecker))
    const [_, location, name] = fqn.match(/"(.*)"\.(.*)/) ?? []
    if (!location || !name) {
        failOnNode(`Not module-scoped: ${fqn}`, node)
    }

    const moduleSegment = location.match(/.*\/node_modules\/(.*)/)?.[1]
    if (!moduleSegment) {
        if (location.startsWith(rootDir)) {
            return `"${path.relative(rootDir, location)}".${name}`
        }

        failOnNode(`Did not find module segment: ${location}`, node)
    }


    const segments = moduleSegment.split('/')

    failOnNode(`Not implemented: ${segments}`, node)
}

export function isExported(node: ts.Node) {
    return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.find(m => m.kind === ts.SyntaxKind.ExportKeyword)
}

export function isDeclared(node: ts.Node) {
    return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.find(m => m.kind === ts.SyntaxKind.DeclareKeyword)
}

export function isSymbolAssignmentLike(node: ts.Node) {
    return ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)
}

// Handles these cases:
// * Properties e.g. { <name>: <node> }
// * Functions e.g. <node function <name> { ... }>
// * Classes e.g. <node class <name> { ... }>
// * Variable declarations e.g. [const|let|var] <name> = <node> 
// * Inheritance e.g. `<name> extends <node>
export function inferName(node: ts.Node): string | undefined {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        return node.text
    }

    // if (isAssignmentLike(node)) {
    //     return inferName(node.name)
    // }

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        if (!node.name) {
            return 'default'
        }

        return inferName(node.name)
    }

    if (ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
        if (node.name) {
            return inferName(node.name)
        }

        return inferName(node.parent)
    }

    if (ts.isArrowFunction(node)) {
        return inferName(node.parent)
    }

    if (node.parent && isSymbolAssignmentLike(node.parent)) {
        const name = node.parent.name
        if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name)) {
            return name.text
        }

        // TODO: bindings, computed names
        return
    }

    if (node.parent?.parent && ts.isHeritageClause(node.parent.parent)) {
        const name = node.parent.parent.parent.name
        if (!name) {
            return 'default'
        }

        return name.text
    }

    if (node.parent.kind === ts.SyntaxKind.ParenthesizedExpression) {
        return inferName(node.parent)
    }
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

export async function ensureDir(dir: string) {
    try {
        await fs.mkdir(dir, { recursive: true })
    } catch(e) {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
    }
}

export async function writeFile(name: string, data: string) {
    await ensureDir(path.dirname(name))
    await fs.writeFile(name, data, 'utf-8')
}

// For debugging
export function showArtifact({ name, data }: { name: string; data: any }) {
    const runtime = Buffer.from(data.runtime, 'base64').toString('utf-8')
    const infra = Buffer.from(data.infra, 'base64').toString('utf-8')

    return [
        `// START - ${name}`,
        '',
        `// ${data.source} - runtime`,
        runtime,
        `// ${data.source} - infrastructure`,
        infra,
        '',
        '// END'
    ].join('\n')
}

export function hashNode(node: ts.Node) {
    const original = ts.getOriginalNode(node)
    const text = original.getText(original.getSourceFile())

    return getHash(text).slice(16)
}

export interface MemoziedFunction<T> {
    (): T
    clear(): void
    readonly cached: boolean
}

export function memoize<T>(fn: () => T): MemoziedFunction<T> {
    let didCall = false
    let result: T | undefined

    function clear() {
        didCall = false
        result = undefined
    }

    return createFunction(() => {
        if (didCall) {
            return result!
        }

        didCall = true
        return (result = fn())
    }, {
        cached: { get: () => didCall },
        clear: { value: clear },
    })
}

type FromMap<T extends PropertyDescriptorMap> = { [P in keyof T]: T[P] extends TypedPropertyDescriptor<infer U> ? U : never }

function createFunction<T extends Function, U extends PropertyDescriptorMap>(fn: T, props: U): T & FromMap<U> {
    return Object.defineProperties(fn, props) as any
}

export interface KeyedMemoziedFunction<T, K extends string[]> {
    (...keys: K): T
    delete(...keys: K): boolean
    keys(): IterableIterator<K>
}

export function keyedMemoize<T, K extends string[] = string[]>(fn: (...keys: K) => T): KeyedMemoziedFunction<T, K> {
    const results = new Map<string, T>()
    const mapped = new Map<string, K>()

    function getKey(keys: K) {
        const key = keys.join('|')
        mapped.set(key, keys)

        return key
    }

    function deleteEntry(...keys: K) {
        const key = getKey(keys)
        mapped.delete(key)

        return results.delete(key)
    }

    return createFunction(
        (...keys: K) => {
            const key = getKey(keys)
            if (results.has(key)) {
                return results.get(key)!
            }

            const val = fn.apply(undefined, keys)
            results.set(key, val)

            return val
        }, 
        { 
            delete: { value: deleteEntry },
            keys: { value: () => mapped.values() },
        }
    )
}

// if (val instanceof Promise) {
//     const withCatch = val.catch(e => {
//         results.delete(key)
//         throw e
//     }) as typeof val
//     results.set(key, withCatch)

//     return withCatch
// }

export async function batch<T>(jobs: Iterable<Promise<T>>, maxJobs = 5): Promise<T[]> {
    let counter = 0
    let hasNext = true
    const running = new Map<number, Promise<{ id: number; result: T }>>()
    const iter = jobs[Symbol.iterator]()
    const results: T[] = []

    while (true) {
        while (hasNext && running.size < maxJobs) {
            const job = iter.next()
            if (job.done) {
                hasNext = false
            } else {
                const id = counter++
                running.set(id, job.value.then(result => ({ id, result })))
            }
        }

        if (running.size === 0) {
            break
        }

        const completed = await Promise.any(running.values())
        running.delete(completed.id)
        results.push(completed.result)
    }

    return results
}

export function createSymbolPropertyName(symbol: string, factory = ts.factory) {
    return factory.createCallExpression(
        factory.createPropertyAccessExpression(
            factory.createPropertyAccessExpression(
                factory.createIdentifier('globalThis'),
                'Symbol'
            ),
            'for'
        ),

        undefined,
        [factory.createStringLiteral(symbol)]
    )
}

export function removeModifiers(node: ts.Statement, modifiers: ts.ModifierSyntaxKind[], factory = ts.factory) {
    if (!ts.canHaveModifiers(node)) {
        return node
    }

    const filteredModifiers = ts.getModifiers(node)?.filter(x => !modifiers.includes(x.kind))
    if (filteredModifiers?.length === ts.getModifiers(node)?.length) {
        return node
    }

    if (ts.isClassDeclaration(node)) {
        return factory.updateClassDeclaration(
            node,
            filteredModifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members
        )
    }

    if (ts.isFunctionDeclaration(node)) {
        return factory.updateFunctionDeclaration(
            node,
            filteredModifiers,
            node.asteriskToken,
            node.name,
            node.typeParameters,
            node.parameters,
            node.type,
            node.body
        )
    }

    if (ts.isVariableStatement(node)) {
        return factory.updateVariableStatement(
            node,
            filteredModifiers,
            node.declarationList
        )
    }

    if (ts.isEnumDeclaration(node)) {
        return factory.updateEnumDeclaration(
            node,
            filteredModifiers,
            node.name,
            node.members,
        )
    }

    if (ts.isTypeAliasDeclaration(node)) {
        return factory.updateTypeAliasDeclaration(
            node,
            filteredModifiers,
            node.name,
            node.typeParameters,
            node.type
        )
    }

    if (ts.isInterfaceDeclaration(node)) {
        return factory.updateInterfaceDeclaration(
            node,
            filteredModifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members
        )
    }

    failOnNode('Unhandled node', node)
}

export interface AmbientDeclarationFileResult {
    id: string
    text: string
    sourcemap: SourceMapV3
}

export function toAmbientDeclarationFile(moduleId: string, sourceFile: ts.SourceFile): { id: string; text: string }
export function toAmbientDeclarationFile(moduleId: string, sourceFile: ts.SourceFile, sourceMapHost: SourceMapHost, transformSpecifier?: (spec: string, importer: string) => string): AmbientDeclarationFileResult
export function toAmbientDeclarationFile(moduleId: string, sourceFile: ts.SourceFile, sourceMapHost?: SourceMapHost, transformSpecifier?: (spec: string, importer: string) => string) {
    const statements = sourceFile.statements
        .map(s => removeModifiers(s, [ts.SyntaxKind.DeclareKeyword]))
        .map(s => {
            if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) {
                return s
            }

            const spec = (s.moduleSpecifier as ts.StringLiteral | undefined)?.text
            if (!spec || !isRelativeSpecifier(spec)) {
                return s
            }

            const transformed = transformSpecifier?.(spec, sourceFile.fileName)
            if (!transformed) {
                return s
            }

            if (ts.isExportDeclaration(s)) {
                return ts.factory.updateExportDeclaration(
                    s, 
                    s.modifiers,
                    false,
                    s.exportClause,
                    ts.factory.createStringLiteral(transformed, true),
                    s.assertClause
                ) 
            }

            return ts.factory.updateImportDeclaration(
                s, 
                s.modifiers, 
                s.importClause,
                ts.factory.createStringLiteral(transformed, true),
                s.assertClause
            )
        })

    const decl = ts.factory.createModuleDeclaration(
        [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
        ts.factory.createStringLiteral(moduleId, true),
        ts.factory.createModuleBlock(statements)
    )

    const sf = ts.factory.updateSourceFile(sourceFile, [decl], true)
    if (!sourceMapHost) {
        const text = printNodes(sf.statements, sf, { removeComments: false })

        return { id: moduleId, text }
    }

    // TODO: map the module specifier to the first line of the source file
    // Apparently the sourcemaps emitted by `tsc` don't do this so not a big deal
    const { text, sourcemap } = emitChunk(sourceMapHost, sf, undefined, { emitSourceMap: true })

    return { id: moduleId, text, sourcemap }
}

// XXX: must be a function, otherwise `Symbol.asyncDispose` won't be initialized
function getAsyncDispose(): typeof Symbol.asyncDispose {
    if (!Symbol.asyncDispose) {
        const asyncDispose = Symbol.for('Symbol.asyncDispose')
        Object.defineProperty(Symbol, 'asyncDispose', { value: asyncDispose, enumerable: true })
    }

    return Symbol.asyncDispose
}

export function isErrorLike(o: unknown): o is Error {
    return !!o && typeof o === 'object' && typeof (o as any).name === 'string' && typeof (o as any).message === 'string'
}

interface LockInfo {
    readonly id: string
    readonly timestamp: Date
}

const locks = new Map<string, LockInfo | Promise<LockInfo | undefined>>()
// Very dumb lock, do not use for anything important
export async function acquireFsLock(filePath: string, maxLockDuration = 10_000) {
    const id = crypto.randomUUID()
    const lockFilePath = `${filePath}.lock`

    async function _readLock() {
        try {
            const data = JSON.parse(await fs.readFile(lockFilePath, 'utf-8'))

            return {
                id: data.id,
                timestamp: new Date(data.timestamp),
            }
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
        }
    }

    function readLock() {
        if (locks.has(lockFilePath)) {
            return locks.get(lockFilePath)!
        }

        const p = _readLock()
        locks.set(lockFilePath, p)

        return p
    }

    async function refreshLock() {
        const d = new Date()
        const data = JSON.stringify({ id, timestamp: d.toISOString() })
        await fs.writeFile(lockFilePath, data, { flag: 'w' })
        locks.set(lockFilePath, { id, timestamp: d })
    }

    async function setLock(d: Date, isExpired?: boolean) {
        try {
            const data = JSON.stringify({ id, timestamp: d.toISOString() })
            await fs.writeFile(lockFilePath, data, { flag: isExpired ? 'w' : 'wx' })
            const d2 = await _readLock()
            if (d2?.id === id && d2.timestamp.getTime() === d.getTime()) {
                return { id, timestamp: d }
            } else {
                locks.delete(lockFilePath)
            }
        } catch (e) {
            if ((e as any).code !== 'EEXIST') {
                throw e
            }
        }
    }

    function checkLock(lock?: LockInfo) {
        const isExpired = lock && lock.timestamp.getTime() + maxLockDuration <= Date.now()
        if (isExpired === false) {
            return false
        }
    
        const d = new Date()
        const p = setLock(d, isExpired)
        locks.set(lockFilePath, p)

        return p.then(x => x?.id === id)
    }

    function tryAcquire() {
        const lockTimestamp = readLock()
        if (lockTimestamp instanceof Promise) {
            return lockTimestamp.then(checkLock)
        }

        return checkLock(lockTimestamp)
    }

    async function lock() {
        if (!(await tryAcquire())) {
            await new Promise<void>((resolve, reject) => {
                async function fn() {
                    try {
                        if (await tryAcquire()) {
                            resolve()
                        } else {
                            setTimeout(fn, 10)
                        }
                    } catch (e) {
                        reject(e)
                    }
                }

                setTimeout(fn, 10)
            })
        }

        return {
            [getAsyncDispose()]: unlock
        }
    }

    async function unlock() {
        await fs.rm(lockFilePath, { force: true })
        locks.delete(lockFilePath)
    }

    await fs.mkdir(path.dirname(lockFilePath), { recursive: true })

    return lock()
}

interface TrieNode<T = unknown> {
    value?: T
    readonly children: Record<string, TrieNode<T>>
}

function createTrieNode<T>(value?: T): TrieNode<T> {
    return { value, children: {} }
}

export function createTrie<T, K extends Iterable<string> = string>() {
    const root = createTrieNode<T>()

    function get(key: K): T | undefined {
        let node = root
        for (const k of key) {
            node = node.children[k]
            if (!node) return
        }
        return node.value
    }

    function insert(key: K, value: T) {
        let node = root
        for (const k of key) {
            node = node.children[k] ??= createTrieNode()
        }
        node.value = value
    }

    function* traverse(key: K) {
        let node = root

        for (const k of key) {
            node = node.children[k]
            if (!node) break
            yield [k, node.value] as const
        }
    }

    function ancestor(key: K) {
        const keys: string[] = []
        let result: T | undefined
        for (const [k, v] of traverse(key)) {
            keys.push(k)
            result = v === undefined ? result : v
        }
        return result !== undefined ? [keys, result] as const : undefined
    }

    function keys(key?: K) {
        let node = root
        if (key) {
            for (const k of key) {
                node = node.children[k]
                if (!node) {
                    throw new Error(`Missing node at key part: ${k} [${key}]`)
                }
            }
        }

        return Object.keys(node.children)
    }

    function createIterator() {
        let node = root

        function next(key: string) {
            node = node?.children[key]
            if (!node) {
                return { done: true, value: undefined }
            }

            return { done: false, value: node.value }
        }

        return { next }
    }

    return { get, insert, traverse, keys, ancestor, createIterator }
}


export function createHasher() { 
    const hashCache = new WeakMap<object, string>()

    function hash(o: object) {
        if (hashCache.has(o)) {
            return hashCache.get(o)!
        }

        const hash = getHash(JSON.stringify(o))
        hashCache.set(o, hash)

        return hash
    }

    return { hash }
}

interface BSTNode<K, V> {
    readonly key: K
    value: V
    left?: BSTNode<K, V>
    right?: BSTNode<K, V>
    parent?: BSTNode<K, V>
}

function createBSTNode<K, V>(key: K, value: V): BSTNode<K, V> {
    return { key, value }
}

export function createBST<K, V>(compareFn?: (a: K, b: K) => number) {
    type Node = BSTNode<K, V>
    let root: Node | undefined
    const cmp = compareFn ?? ((a, b) => a < b ? -1 : a > b ? 1 : 0)

    function search(key: K): Node | undefined {
        let x = root
        while (x) {
            const d = cmp(key, x.key)
            if (d === 0) {
                break
            } else if (d < 0) {
                x = x.left
            } else {
                x = x.right
            }
        }

        return x
    }

    function insert(key: K, value: V) {
        let y: Node | undefined
        let x = root
        while (x) {
            y = x
            const d = cmp(key, x.key)
            if (d === 0) {
                x.value = value
                return
            } else if (d < 0) {
                x = x.left
            } else {
                x = x.right
            }
        }

        const z = createBSTNode(key, value)
        z.parent = y
        if (!y) {
            root = z
        } else if (cmp(z.key, y.key) < 0) {
            y.left = z
        } else {
            y.right = z
        }
    }

    function min(n: Node): Node {
        while (n.left) {
            n = n.left
        }
        return n
    }

    function successor(n: Node): Node | undefined {
        if (n.right) {
            return min(n.right)
        }

        let y = n.parent
        while (y && n === y.parent) {
            n = y
            y = y.parent
        }
        return y
    }

    function remove(key: K): V | undefined {
        const n = search(key)
        if (!n) {
            return
        }

        if (!n.left) {
            shiftNodes(n, n.right)
        } else if (!n.right) {
            shiftNodes(n, n.left)
        } else {
            const s = successor(n)!
            if (s.parent !== n) {
                shiftNodes(s, s.right)
                s.right = n.right
                s.right.parent = s
            }
            shiftNodes(n, s)
            s.left = n.left
            s.left.parent = s
        }

        return n.value
    }

    function shiftNodes(x: Node, y: Node | undefined) {
        if (!x.parent) {
            root = y
        } else if (x === x.parent.left) {
            x.parent.left = y
        } else {
            x.parent.right = y
        }
        if (y) {
            y.parent = x.parent
        }
    }

    function find(key: K): V | undefined {
        return search(key)?.value
    }
    
    return {
        find,
        insert,
        remove,
    }
}

export function createMinHeap<T>(compareFn?: (a: T, b: T) => number, initArray: T[] = []) {
    const a = initArray
    const cmp = compareFn ?? ((a, b) => a < b ? -1 : a > b ? 1 : 0)

    function swap(i: number, j: number) {
        const tmp = a[i]
        a[i] = a[j]
        a[j] = tmp
    }

    function insert(element: T) {
        a.push(element)
        siftUp(a.length - 1)
    }

    function extract(): T {
        if (a.length === 0) {
            throw new Error('Empty')
        }

        const v = a[0]
        const u = a.pop()!

        if (a.length > 0) {
            a[0] = u
            minHeapify(0)
        }

        return v
    }

    function siftUp(i: number): void {
        if (i === 0) {
            return
        }

        const j = Math.floor((i - 1) / 2)
        if (cmp(a[i], a[j]) < 0) {
            swap(i, j)
            siftUp(j)
        }
    }

    function minHeapify(i: number) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        if (left < a.length && cmp(a[left], a[smallest]) < 0) {
            smallest = left
        }
        if (right < a.length && cmp(a[right], a[smallest]) < 0) {
            smallest = right
        }
        if (smallest !== i) {
            swap(i, smallest)
            minHeapify(smallest)
        }
    }

    return { 
        insert,
        extract,
        get length() {
            return a.length
        }
    }
}

interface LockData {
    readonly type: 'read' | 'write'
    readonly callback?: () => void
    acquired?: boolean
}

export function createRwMutex() {
    let idCounter = 0
    const data = new Map<number, LockData>()

    function getAcquired() {
        return [...data.values()].filter(v => v.acquired)
    }

    function release(id: number) {
        if (!data.has(id)) {
            return
        }

        const lastLockType = data.get(id)!.type
        data.delete(id)

        const readers = getAcquired().filter(x => x.type === 'read')
        let nextLockType = readers.length === 0 ? 'write' : lastLockType

        for (const l of data.values()) {
            if (l.acquired) continue

            if (nextLockType === 'write' || l.type === 'read') {
                l.acquired = true
                l.callback?.()
                if (l.type === 'write') {
                    break
                }
                nextLockType = 'read'
            }
        }
    }

    function acquire(type: 'read' | 'write') {
        const id = idCounter++
        const acquired = getAcquired()
        const incompatibleLocks = type === 'read' 
            ? acquired.filter(x => x.type === 'write') 
            : acquired

        const l = { dispose: () => release(id) }

        if (incompatibleLocks.length > 0) {
            return new Promise<{ dispose: () => void }>((resolve, reject) => {
                const lock: LockData = {
                    type,
                    callback: () => resolve(l),
                }
                data.set(id, lock)
            })
        }

        const lock: LockData = {
            type,
            acquired: true,
        }

        data.set(id, lock)

        return Promise.resolve(l)
    }

    function lockRead() {
        return acquire('read')
    }

    function lockWrite() {
        return acquire('write')
    }

    return { lockRead, lockWrite }
}

interface FileHasherCache {
    [file: string]: { 
        hash: string
        mtime: number
        checkTime?: number
    }
}

interface FileHasherCacheWithTime {
    files: FileHasherCache
    mtime?: number
}

// This is should ideally only be used for source files
export function createFileHasher(fs: Pick<Fs, 'readFile' | 'writeFile' | 'deleteFile' | 'stat'>, cacheLocation: string) {
    // We use a single timestamp to represent the entire session
    let checkTime = Date.now()
    const location = path.resolve(cacheLocation, 'files.json')

    async function loadCache(): Promise<FileHasherCache> {
        const data = await fs.readFile(location, 'utf-8').catch(throwIfNotFileNotFoundError)
        if (!data) {
            return {}
        }

        try {
            return JSON.parse(data)
        } catch (e) {
            // It seems like every JSON parse error contains "JSON" in the message
            if (!(e instanceof SyntaxError) || !e.message.includes('JSON')) {
                throw e
            }

            await fs.deleteFile(location)

            return {}
        }
    }

    function pruneOldEntries(files: FileHasherCache) {
        // 1 week covers a good amount of frequently-used files
        // Per-program caches wouldn't need a time-based eviction policy
        const threshold = 7 * 24 * 60 * 60 * 1000
        for (const key of Object.keys(files)) {
            if (files[key].checkTime !== checkTime && (checkTime - (files[key].checkTime ?? 0) > threshold)) {
                delete files[key]
            }
        }

        return files
    }

    async function saveCache(data: FileHasherCache) {
        const files = pruneOldEntries(data)

        // We're not concerned with clobbering concurrent writes
        // This cache is currently global for simplicity, but it can easily be
        // narrowed to per-project or per-program.
        await fs.writeFile(location, JSON.stringify(files))
    }

    const getCache = memoize(loadCache)

    async function _getHash(fileName: string) {
        const { hash } = await checkFile(fileName)

        return hash
    }

    async function checkFile(fileName: string) {
        const cache = await getCache()
        const cached = cache[fileName]
        if (cached?.checkTime === checkTime) {
            return { hash: cached.hash }
        }

        const stat = await fs.stat(fileName).catch(async e => {
            delete cache[fileName]
            throw e
        })

        // TODO: try rounding `mtime`?
        if (cached && cached.mtime === stat.mtimeMs) {
            cached.checkTime = checkTime

            return { hash: cached.hash }
        }

        const data = await fs.readFile(fileName)
        const hash = getHash(data)
        cache[fileName] = { mtime: stat.mtimeMs, hash, checkTime }

        return { hash }
    }

    async function flush() {
        if (getCache.cached) {
            await saveCache(await getCache())
            getCache.clear()
        }

        checkTime = Date.now()
    }

    return { 
        getHash: _getHash, 
        checkFile, 
        flush,
        [Symbol.asyncDispose]: flush,
    }
}

export async function makeExecutable(fileName: string) {
    await fs.chmod(fileName, 0o755)
}

export async function linkBin(existingPath: string, newPath: string) {
    await ensureDir(path.dirname(newPath))
    await fs.unlink(newPath).catch(e => {
        if ((e as any).code !== 'ENOENT') {
            throw e
        }
    })
    await fs.symlink(existingPath, newPath, 'file')
    await makeExecutable(newPath)
}

function filterObject(obj: Record<string, any>, fn: (v: any) => boolean) {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => fn(v)))
}

export function splitObject<
    T extends Record<string, any>, 
    U extends T[keyof T]
>(obj: T, fn: (val: T[keyof T]) => val is U): { left: Record<string, U>; right: Record<string, Exclude<T[keyof T], U>> } {
    return {
        left: filterObject(obj, fn),
        right: filterObject(obj, v => !fn(v)),
    }
}

export function escapeRegExp(pattern: string) {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// SLOW!!!
export function dedupe(statements: any[]) {
    return Object.values(Object.fromEntries(statements.map(s => [JSON.stringify(s), s])))
}

export function getCiType(): 'github' | undefined {
    const env = process.env

    if (env['CI'] && env['GITHUB_REPOSITORY']) {
        return 'github'
    }
}

export function isWindows() {
    return process.platform === 'win32'
}

// TERM_PROGRAM=vscode
// TERM_PROGRAM_VERSION=1.87.2

const knownVscEnvVars = [
    'VSCODE_GIT_ASKPASS_NODE',
    'VSCODE_GIT_ASKPASS_MAIN',
    'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
    'VSCODE_GIT_IPC_HANDLE',
    'VSCODE_INJECTION',
]

export function isRunningInVsCode() {
    return process.env['TERM_PROGRAM'] === 'vscode'
}

export function replaceWithTilde(filePath: string) {
    const dir = homedir()
    if (filePath.startsWith(dir)) {
        return filePath.replace(dir, '~')
    }

    return filePath
}

export function gzip(data: string | ArrayBuffer) {
    return new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(data, (err, res) => err ? reject(err) : resolve(res))
    })
}

export function gunzip(data: string | ArrayBuffer) {
    return new Promise<Buffer>((resolve, reject) => {
        zlib.gunzip(data, (err, res) => err ? reject(err) : resolve(res))
    })
}

export function isRelativeSpecifier(spec: string) {
    if (spec[0] !== '.') {
        return false
    }

    if (!spec[1] || spec[1] === '/') {
        return true
    }

    if (spec[1] !== '.') {
        return false
    }

    return !spec[2] || spec[2] === '/'
}

// `localeCompare` calls `new Intl.Collator` which can take a bit of time to create

export function strcmp(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).sort((a, b) => strcmp(a[0], b[0])))
}

export function filterRecord<T>(record: Record<string, T>, fn: (k: string, v: T) => boolean): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([k, v]) => fn(k, v)))
}

export function throwIfNotFileNotFoundError(err: unknown): asserts err is Error & { code: 'ENOENT' } {
    if (util.types.isNativeError(err) && (err as any).code !== 'ENOENT') {
        throw err
    }
}

export async function tryReadJson<T>(fs: Pick<Fs, 'readFile'>, fileName: string) {
    try {
        return JSON.parse(await fs.readFile(fileName, 'utf8')) as T
    } catch (e) {
        throwIfNotFileNotFoundError(e)
    }
}

export function tryReadJsonSync<T>(fs: Pick<SyncFs, 'readFileSync'>, fileName: string) {
    try {
        return JSON.parse(fs.readFileSync(fileName, 'utf8')) as T
    } catch (e) {
        throwIfNotFileNotFoundError(e)
    }
}

export type Mutable<T> = { -readonly [P in keyof T]: T[P] }

// Terraform stores attributes with `_` instead of json so we need to normalize them
export const capitalize = (s: string) => s ? s.charAt(0).toUpperCase().concat(s.slice(1)) : s
export const uncapitalize = (s: string) => s ? s.charAt(0).toLowerCase().concat(s.slice(1)) : s

export function toSnakeCase(str: string) {
    const pattern = /[A-Z]/g
    const parts: string[] = []

    let lastIndex = 0
    let match: RegExpExecArray | null
    while (match = pattern.exec(str)) {
        parts.push(str.slice(lastIndex, match.index))    
        lastIndex = match.index
    }

    if (lastIndex !== str.length) {
        parts.push(str.slice(lastIndex, str.length))    
    }

    return parts.map(uncapitalize).join('_')
}

const defaultHashEncoding: 'base64' | 'base64url' | 'hex' | 'binary' | 'none' = 'hex' // Case-insensitive file systems make hex a better choice
export function getHash(data: string | Buffer | Uint8Array, enc?: 'base64' | 'base64url' | 'hex' | 'binary', alg?: 'sha256' | 'sha512'): string
export function getHash(data: string | Buffer | Uint8Array, enc: 'none', alg?: 'sha256' | 'sha512'): Buffer
export function getHash(data: string | Buffer | Uint8Array, enc = defaultHashEncoding, alg: 'sha256' | 'sha512' = 'sha256') {
    if ('hash' in crypto) {
        return (crypto as any).hash(alg, data, enc === 'none' ? 'buffer' : enc)
    }

    const hash = (crypto as any).createHash(alg).update(data)
    return enc !== 'none' ? hash.digest(enc) : hash.digest()
}

export function getArrayHash(data: (string | Buffer | Uint8Array)[], enc: 'hex' = 'hex', alg: 'sha256' | 'sha512' = 'sha256') {
    const hash = crypto.createHash(alg)
    hash.update(`__array${data.length}__`)
    for (let i = 0; i < data.length; i++) {
        hash.update(data[i])
    }
    return hash.digest(enc)
}

export async function tryFindFile(fs: Pick<Fs, 'readFile'>, fileName: string, startDir: string, endDir?: string) {
    try {
        return {
            data: await fs.readFile(path.resolve(startDir, fileName)),
            directory: startDir,
        }
    } catch (e) {
        if ((e as any).code !== 'ENOENT') {
            throw e // TODO: add lookup stack
        }

        const nextDir = path.dirname(startDir)
        if (nextDir === endDir || nextDir === startDir) {
            return
        }

        return tryFindFile(fs, fileName, nextDir, endDir)
    }
}

type Proxied<T> = { [P in keyof T]+?: T[P] }

// Very simple wrapper. Can easily be bypassed through property descriptors
export function wrapWithProxy<T extends object | Function>(target: T, proxied: Proxied<T>): T {
    const s = new Set<PropertyKey>([...Object.keys(proxied), ...Object.getOwnPropertySymbols(proxied)])

    function get(t: any, prop: PropertyKey, recv: any): any {
        if (s.has(prop)) {
            return proxied[prop as keyof T]
        }

        return Reflect.get(t, prop, recv)
    }

    return new Proxy(target, { get })
}

// EDIT-DISTANCE UTILS

// Wagner–Fischer algorithm
export function levenshteinDistance(a: string, b: string) {
    if (a === b) {
        return 0
    } else if (!a) {
        return b.length
    } else if (!b) {
        return a.length
    }

    const m = a.length + 1
    const n = b.length + 1

    const dists: number[][] = []
    for (let i = 0; i < m; i++) {
        dists[i] = []
        for (let j = 0; j < n; j++) {
            dists[i][j] = 0
        }
    }

    for (let i = 1; i < m; i++) {
        dists[i][0] = i
    }

    for (let j = 1; j < n; j++) {
        dists[0][j] = j
    }

    for (let i = 1; i < m; i++) {
        for (let j = 1; j < n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dists[i][j] = Math.min(
                dists[i - 1][j] + 1,
                dists[i][j - 1] + 1,
                dists[i - 1][j - 1] + cost,
            )
        }
    }

    return dists[a.length][b.length]
}

interface CostFunctions<T> {
    remove: (left: T) => number
    insert: (right: T) => number
    update: (left: T, right: T) => number
}

type InsertOp<T> = ['insert', T]
type UpdateOp<T> = ['update', T, T]
type RemoveOp<T> = ['remove', T]
type NoOp<T> = ['noop', T, T]

type EditOp<T> =
    | InsertOp<T>
    | UpdateOp<T>
    | RemoveOp<T>
    | NoOp<T>

export function arrayEditDistance<T>(a: T[], b: T[], costs: Partial<CostFunctions<T>>) {
    // if (a === b) {
    //     return 0
    // } else if (!a) {
    //     return b.length
    // } else if (!b) {
    //     return a.length
    // }

    const m = a.length + 1
    const n = b.length + 1
    const dists: number[][] = []
    const ops: EditOp<T>[][][] = []
    const { remove, insert, update } = costs

    for (let i = 0; i < m; i++) {
        dists[i] = []
        ops[i] = []
        for (let j = 0; j < n; j++) {
            dists[i][j] = 0
            ops[i][j] = []
        }
    }

    for (let i = 1; i < m; i++) {
        const left = a[i - 1]
        dists[i][0] = !remove ? i : dists[i - 1][0] + remove(left)
        ops[i][0] = [...ops[i - 1][0], ['remove', left]]
    }

    for (let j = 1; j < n; j++) {
        const right = b[j - 1]
        dists[0][j] = !insert ? j : dists[0][j - 1] + insert(right)
        ops[0][j] = [...ops[0][j - 1], ['insert', right]]
    }

    for (let i = 1; i < m; i++) {
        for (let j = 1; j < n; j++) {
            const left = a[i - 1]
            const right = b[j - 1]
            const c = [
                dists[i - 1][j] + (remove ? remove(left) : 1),
                dists[i][j - 1] + (insert ? insert(right) : 1),
                dists[i - 1][j - 1] + (left === right ? 0 : update ? update(left, right) : 1),
            ]

            const m = dists[i][j] = Math.min(c[0], c[1], c[2])

            switch (c.indexOf(m)) {
                case 0:
                    ops[i][j] = [...ops[i - 1][j], ['remove', left]]
                    break
                case 1:
                    ops[i][j] = [...ops[i][j - 1], ['insert', right]]
                    break
                case 2:
                    ops[i][j] = [...ops[i - 1][j - 1], [left === right ? 'noop' : 'update', left, right]]
                    break
            }
        }
    }

    return {
        ops: ops[a.length][b.length],
        score: dists[a.length][b.length],
    }
}


// We only need to determine a unique name for a resource when the program is ran to
// generate the infrastructure configuration. Before that, names can be represented
// symbolically.
///
// Goals
// * Names are unique within their scope
// * Creating names is deterministic
// * Changing the basic program structure should not change the names
//   * That is, changing the program surrounding a resource declaration should not change its name
//
// Resource name algorithm
// 1. Determine the scope (i.e. the parent node)
//   a) PropertyDeclaration, VariableDeclaration
//     * If destructuring, treat this as an 'anonymous' variable
//   b) ClassDeclaration, FunctionDeclaration, FunctionExpression, ClassExpression
//   c) ArrowFunction (similar to FunctionExpression)
//   d) ForStatement
//   e) IfStatement (`else` block is distinct from the primary block)
//   f) SourceFile (root scope for a JS module but not application)
// 2. Within the scope, give the resource a unique name
//   a) Handle collisions by appending a count based off order of appeareance e.g. `R_1`, `R_2`, etc. 
// 


// Examples
// 
// ```ts
// class X {}
// const y = new X()
// ```
//
// After refactoring to
// ```ts
// class X {}
// const y = foo()
// function foo() {
//     return new X()
// }
// ```
// Ideally, we should interpret this as the _same_ program because it _is_ the same
// once executed. We need to perform a "scope relaxation" phase after qualifying all
// names
//
// Following the above example:
// ```ts
// class R1 {}
// class R2 {}
// const x = foo()
// const y = foo()
// const z = { a: foo(), b: foo() }
// function foo() {
//     const x = new R2()
//     return new R1()
// }
// ```
//
// When looking at only the `foo` block we would see this:
// * foo/x/R2 (R2)
// * foo/R1   (R1)
// 
// At the top level we can describe the resources like so:
// * x/R1   (R1)
// * x/R2   (R2)
// * y/R1   (R1)
// * y/R2   (R2)
// * z/a/R1 (R1)
// * z/a/R2 (R2)
// * z/b/R1 (R1)
// * z/b/R2 (R2)
//
// Open question: should only variable/property names be used when deriving the path?
// Open question: will path contraction cause unexpected retention of resources?
//  * Probably not. If path contraction results in the same names then at worse the resource will updated


// Only clones:
// * enumerable string props
// * array, maps, and sets
export function deepClone<T>(val: T, visited = new Map<any, any>()): T {
    // Doesn't handle bound functions
    if (typeof val === 'function') {
        return val
    }

    if (typeof val !== 'object' || !val) {
        return val
    }

    if (visited.has(val)) {
        return visited.get(val)
    }

    if (Array.isArray(val)) {
        const arr: any = []
        visited.set(val, arr)
        for (let i = 0; i < val.length; i++) {
            arr[i] = deepClone(val[i], visited)
        }

        return arr as T
    }

    if (val instanceof Map) {
        return new Map(val.entries()) as T
    }

    if (val instanceof Set) {
        return new Set(val.values()) as T
    }

    const res = {} as any
    visited.set(val, res)
    for (const [k, v] of Object.entries(val)) {
        res[k] = deepClone(v, visited)
    }

    return res as T
}

export function makeRelative(from: string, to: string) {
    const result = path.relative(from, to)
    if (process.platform !== 'win32') {
        return result
    }
    return result.replaceAll('\\', '/')
}

export function resolveRelative(from: string, to: string) {
    const result = path.resolve(from, to)
    if (process.platform !== 'win32') {
        return result
    }
    return result.replaceAll('\\', '/')
}
