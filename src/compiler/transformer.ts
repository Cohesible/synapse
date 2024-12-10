import ts from 'typescript'
import * as path from 'node:path'
import { createObjectLiteral, failOnNode, isExported, splitExpression, isRelativeSpecifier, getNodeLocation, printNodes, createVariableStatement, isSymbolAssignmentLike } from '../utils'
import { createGraphCompiler, createImporterExpression, createStaticSolver } from '../static-solver'
import type { Scope } from '../runtime/modules/core' // must be a type import!
import { parseDirectives } from '../runtime/sourceMaps'
import { getLogger } from '../logging'
import { SchemaFactory } from './validation'
import { ResourceTypeChecker } from './resourceGraph'

// THINGS TO DO
// 1. Rewrite certain expressions/statements to work as config (must be dynamic! best to minimize rendered configuration)
//   * Control flow (if, while, etc.)
//   * Iterables


export const getFqnComponents = (sym: string) => {
    const [_, module, name] = sym.match(/"(.*)"(?:\.(.*))?/) ?? []
    if (!module && !name) {
        throw new Error(`Failed to get FQN of symbol: ${sym}`)
    }

    if (!name) {
        return { module, name: '__default' } // This is a default export!
    }
    
    return { name, module }
}

type FQN = `"${string}".${string}` | `"${string}"`

function getFqn(graphCompiler: ReturnType<typeof createGraphCompiler>, node: ts.Node): FQN | undefined {
    const origin = node.getSourceFile()?.fileName
    if (!origin) {
        return
    }

    const sym = graphCompiler.getSymbol(node)
    if (!sym) {
        return
    }

    if (sym.parent && sym.parent.declaration) {
        const parentFqn = getFqn(graphCompiler, sym.parent.declaration)
        if (!parentFqn) {
            return
        }

        return `${parentFqn}.${sym.name}` as FQN
    }

    if (sym.importClause) {
        const moduleSpec = (sym.importClause.parent.moduleSpecifier as ts.StringLiteral).text
        const resolved = isRelativeSpecifier(moduleSpec) ? path.resolve(path.dirname(origin), moduleSpec) : moduleSpec

        // Default import
        const parent = sym.declaration?.parent
        if (parent === sym.importClause) {
            return `"${resolved.replace(/\.(t|j)sx?$/, '')}".default`
        }

        if (parent && ts.isImportSpecifier(parent)) {
            const name = parent.propertyName ?? parent.name

            return `"${resolved.replace(/\.(t|j)sx?$/, '')}".${name.text}`
        }

        return `"${resolved.replace(/\.(t|j)sx?$/, '')}"`
    } else if (sym.declaration && isExported(sym.declaration)) {
        return `"${origin.replace(/\.(t|j)sx?$/, '')}".${sym.name}`
    }
}

function isExternalImport(graphCompiler: ReturnType<typeof createGraphCompiler>, node: ts.Node) {
    const sym = graphCompiler.getSymbol(node)
    if (!sym) {
        return false
    }

    if (sym.parent && sym.parent.declaration) {
        return isExternalImport(graphCompiler, sym.parent.declaration)
    }

    if (sym.importClause) {
        const moduleSpec = (sym.importClause.parent.moduleSpecifier as ts.StringLiteral).text

        return !isRelativeSpecifier(moduleSpec) // XXX: this is not entirely accurate
    }

    return false
}

const coreModuleName = 'synapse:core'
const testModuleName = 'synapse:test'

export function getCoreImportName(graphCompiler: ReturnType<typeof createGraphCompiler>, node: ts.Node) {
    const fqn = getFqn(graphCompiler, ts.getOriginalNode(node))
    if (!fqn) {
        return
    }

    const { module, name } = getFqnComponents(fqn)
    if (module === coreModuleName) {
        return name
    }
}

function getSymbolFqnComponents(graphCompiler: ReturnType<typeof createGraphCompiler>, node: ts.Node) {
    const fqn = getFqn(graphCompiler, node)
    if (!fqn) {
        return
    }

    return getFqnComponents(fqn)
}

// TODO: put this cache somewhere else so it can be cleared during `watch`
const directivesCache = new Map<ts.Node, Record<string, string> | undefined>()
function parseHeaderDirectives(node: ts.Node) {
    if (!node) {
        return
    }

    const sf = node.getSourceFile()
    if (!sf) {
        return
    }

    if (directivesCache.has(node)) {
        return directivesCache.get(node)!
    }

    const text = sf.getFullText()
    const comments = ts.getLeadingCommentRanges(text, node.pos)
    if (!comments) {
        directivesCache.set(node, undefined)

        return
    }

    const lines = comments
        .filter(c => c.kind === ts.SyntaxKind.SingleLineCommentTrivia)
        .map(c => text.slice(c.pos, c.end))

    const result = parseDirectives(lines)
    directivesCache.set(node, result)

    return result
}

export function getModuleBindingId(sourceFile: ts.SourceFile) {
    const directives = parseHeaderDirectives(sourceFile)
    if (!directives) {
        return
    }

    return directives['moduleId']
}

export function getTransformDirective(sourceFile: ts.SourceFile) {
    const directives = parseHeaderDirectives(sourceFile)
    if (!directives) {
        return
    }

    return directives['transform']
}

export function getResourceDirective(node: ts.Node) {
    const directives = parseHeaderDirectives(node)
    if (!directives) {
        return
    }

    return directives['resource']
}

export function getCallableDirective(node: ts.Node) {
    const directives = parseHeaderDirectives(node)
    if (!directives) {
        return
    }

    return directives['callable']
}

export type ResourceTransformer = ReturnType<typeof createTransformer>
export function createTransformer(
    context: ts.TransformationContext, 
    graphCompiler: ReturnType<typeof createGraphCompiler>,
    schemaFactory: SchemaFactory,
    resourceTypeChecker: ResourceTypeChecker
) {
    const factory = context.factory
    const bindings = new Map<FQN, Binding[]>()
    const staticSolver = createStaticSolver()
    const scopeSymbolProvider = createSymbolProvider(graphCompiler.moduleType)
    const assignmentCache = new Map<ts.Node, Scope['assignmentSymbol'] | undefined>()
    const needsValidationImport = new Map<ts.Node, any>()
    const sourceDeltas = new Map<ts.Node, { line: number; column: number }>()

    let deltas: { line: number; column: number } | undefined

    function visit(node: ts.Node): ts.Node {
        if (ts.isCallExpression(node)) {
            const importName = getCoreImportName(graphCompiler, node.expression)
            if (importName === 'addTarget' && node.arguments.length === 3) {
                const [targetNode, replacementNode, targetNameNode] = node.arguments
                const targetFqn = getFqn(graphCompiler, ts.getOriginalNode(targetNode))
                if (!targetFqn) {
                    failOnNode('No symbol found for target', targetNode)
                }
    
                const replacementFqn = getFqn(graphCompiler, ts.getOriginalNode(replacementNode))
                if (!replacementFqn) {
                    // FIXME: clarify that the symbol must be exported?
                    failOnNode('No exported symbol found for replacement', replacementNode)
                }
    
                const target = staticSolver.solve(targetNameNode)
                if (typeof target !== 'string') {
                    failOnNode('Expected target name to be a string', targetNameNode)
                }

                if (!bindings.has(targetFqn)) {
                    bindings.set(targetFqn, [])
                }

                bindings.get(targetFqn)!.push({ 
                    target, 
                    replacement: replacementFqn,
                })
    
                return context.factory.createNotEmittedStatement(node)
            } else if (importName === 'defineResource' || importName === 'defineDataSource') {
                const n = ts.getOriginalNode(node)  
                const name = inferName(n)
                if (!name) {
                    failOnNode('Failed to infer resource type identifier', n)
                }

                const symbol = scopeSymbolProvider.getIdentSymbol(name, deltas)

                return createConfigurationClass(
                    node,
                    { symbol, namespace: undefined, declarationScope: undefined, assignmentSymbol: undefined, isNewExpression: undefined },
                    context.factory
                )
            } else if (importName === 'check') {
                needsValidationImport.set(ts.getOriginalNode(node).getSourceFile(), true)

                return schemaFactory.addValidationSchema(node, factory)
            } else if (importName === 'schema') {
                return schemaFactory.replaceWithSchema(node, factory)
            } else if (importName === 'asset') {
                return factory.updateCallExpression(
                    node,
                    factory.createIdentifier('__createAsset'),
                    undefined,
                    [node.arguments[0], createImporterExpression(graphCompiler.moduleType)]
                )
            }
        }

        if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
            const original = ts.getOriginalNode(node)

            if (
                !original.parent ||
                node.expression.kind === ts.SyntaxKind.SuperKeyword ||
                node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                node.expression.kind === ts.SyntaxKind.ParenthesizedExpression || // TODO: enable this
                getModuleBindingId(original.getSourceFile()) ||
                isInThrowStatement(node)
            ) {
                return ts.visitEachChild(node, visit, context)
            }
            // if (getLibImportName(graphCompiler, node.expression) === 'Bundle' && node.arguments) {
            //     const sym = graphCompiler.getSymbol(node.arguments[0])
            //     if (sym !== undefined) {
            //         resourceTypeChecker?.checkForResourceInstantiations(sym)
            //     }
            // }

            const isInBindFunction = ts.findAncestor(original, n => ts.isCallExpression(n) && 
                ['bindModel', 'bindObjectModel', 'bindFunctionModel'].includes(getCoreImportName(graphCompiler, n.expression) ?? ''))

            if (isInBindFunction) {
                return ts.visitEachChild(node, visit, context)
            }

            const symbolComponents = getSymbolFqnComponents(graphCompiler, getRootTarget(original))

            // `singleton` needs access to scope info
            const isSingleton = symbolComponents?.module === coreModuleName && symbolComponents.name === 'singleton'
            const canAddScope = (
                isSingleton || 
                !symbolComponents || 
                (symbolComponents.module === testModuleName 
                    ? !symbolComponents.name.startsWith('expect') 
                    : symbolComponents.module !== coreModuleName)
            )
            if (canAddScope) {
                const declarationScope = isSingleton ? getDeclarationScope(original, scopeSymbolProvider) : undefined

                if (deltas) {
                    const { symbol, namespace } = getSymbolForSourceMap(original, scopeSymbolProvider, deltas)

                    return wrapScope(
                        // Keep the shape the same as in the non-deltas case
                        { symbol, namespace, declarationScope, assignmentSymbol: undefined, isNewExpression: undefined },
                        ts.visitEachChild(node, visit, context),
                        isAsync(node),
                        context.factory
                    )
                }

                const { symbol, namespace } = getSymbolForSourceMap(original, scopeSymbolProvider)
                const assignmentSymbol = getAssignmentSymbol(original, scopeSymbolProvider, assignmentCache)
                const isNewExpression = node.kind === ts.SyntaxKind.NewExpression ? true : undefined
                // const ty = resourceTypeChecker.getNodeType((original as ts.CallExpression | ts.NewExpression).expression)

                return wrapScope(
                    { symbol, namespace, declarationScope, assignmentSymbol, isNewExpression },
                    ts.visitEachChild(node, visit, context),
                    isAsync(node),
                    context.factory
                )
            }
        }

        return ts.visitEachChild(node, visit, context)
    }

    function visitSourceFile(sourceFile: ts.SourceFile) {
        const transformed = ts.visitEachChild(sourceFile, visit, context)

        if (needsValidationImport.get(sourceFile)) {
            return ts.factory.updateSourceFile(
                transformed,
                [
                    schemaFactory.createValidateDeclaration(),
                    ...sourceFile.statements,
                ]
            )
        }

        return transformed
    }

    // We don't include the symbols for infra chunks because they contain line/column numbers
    // which are directly influenced by surrounding code. This causes churn when changing a file.
    // We'll have to make the positions relative to the chunk, and then somehow transform them
    // back during synthesis. The easiest way is probably attaching a line delta to the chunk's metadata
    function visitAsInfraChunk(node: ts.Node) {
        const original = ts.getOriginalNode(node)
        const sf = original.getSourceFile()
        const pos = original.pos + original.getLeadingTriviaWidth(sf)
        const lc = sf.getLineAndCharacterOfPosition(pos)
        deltas = { line: lc.line, column: lc.character }
        sourceDeltas.set(original, deltas)
        const r = visit(node)
        deltas = undefined
        
        return r
    }

    return { 
        visit, 
        visitSourceFile,
        visitAsInfraChunk,
        bindings,
        getReflectionTransformer: () => createReflectionTransformer(graphCompiler, schemaFactory),
        getDeltas: (node: ts.Node) => sourceDeltas.get(node),
    }
}

function getIdentifierLikeText(node: IdentifierLike) {
    switch (node.kind) {
        case ts.SyntaxKind.ThisKeyword:
            return 'this'
        case ts.SyntaxKind.SuperKeyword:
            return 'super'

        case ts.SyntaxKind.Identifier:
        case ts.SyntaxKind.PrivateIdentifier:
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
            return node.text
    }
}

function getDeclarationScope(node: ts.Node, symbolProvider: ReturnType<typeof createSymbolProvider>): NonNullable<Scope['symbol']>[] {
    const nodes: IdentifierLike[] = []

    let n = node.parent
    while (n) {
        switch (n.kind) {
            case ts.SyntaxKind.NewExpression:
            case ts.SyntaxKind.CallExpression:
                // TODO: needs to unwrap unary expressions
                if ((n as ts.CallExpression).arguments.find(x => x === node)) {
                    failOnNode('Cannot have declaration scope key in a call argument', node)
                }
                break
            
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.ClassExpression:
                if ((n as ts.ClassDeclaration).name) {
                    nodes.push((n as ts.ClassDeclaration).name!)
                }
                break

            case ts.SyntaxKind.VariableDeclaration:
            case ts.SyntaxKind.PropertyDeclaration:
            case ts.SyntaxKind.PropertyAssignment: {
                const name = (n as ts.PropertyDeclaration | ts.PropertyAssignment | ts.VariableDeclaration).name
                if (ts.isIdentifier(name)) {
                    nodes.push(name)
                }
                break
            }

            case ts.SyntaxKind.Parameter:
                if (ts.isParameterPropertyDeclaration(n, n.parent)) {
                    nodes.push(n.name)
                }
                break
        }

        n = n.parent
    }

    return nodes.map(n => symbolProvider.getIdentSymbol(n)).reverse()
}

// Handles these cases:
// * Properties e.g. { <name>: <node> }
// * Functions e.g. <node function <name> { ... }>
// * Classes e.g. <node class <name> { ... }>
// * Variable declarations e.g. [const|let|var] <name> = <node> 
// * Inheritance e.g. `<name> extends <node>
export function inferName(node: ts.Node): IdentifierLike | undefined {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        return node
    }

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
        if (node.name) {
            return node.name
        }
    }

    if (ts.isArrowFunction(node)) {
        return inferName(node.parent)
    }

    if (node.parent && isSymbolAssignmentLike(node.parent)) {
        const name = node.parent.name
        if (isIdentifierLike(name)) {
            return name
        }

        // TODO: bindings, computed names
        return
    }

    if (node.parent?.parent && ts.isHeritageClause(node.parent.parent)) {
        const name = node.parent.parent.parent.name
        if (name) {
            return name
        }
    }

    if (node.parent.kind === ts.SyntaxKind.ParenthesizedExpression) {
        return inferName(node.parent)
    }
}

function createSymbolProvider(mode: 'cjs' | 'esm' = 'cjs') {
    const cache = new Map<ts.Node, Scope['symbol']>()

    const virtualIdNode = mode === 'cjs'
        ? ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier('module'),
            '__virtualId'
        )
        : ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('import'),
                'meta'
            ),
            '__virtualId'
        )

    function getIdentSymbol(node: IdentifierLike, deltas?: { line: number; column: number }) {
        if (cache.has(node)) {
            if (deltas) {
                const cached = cache.get(node)!

                return {
                    ...cached,
                    line: cached.line - deltas.line,
                    column: cached.column - deltas.column,
                }
            }

            return cache.get(node)!
        }

        const sf = node.getSourceFile()
        const pos = node.pos + node.getLeadingTriviaWidth(sf)
        const lc = sf.getLineAndCharacterOfPosition(pos)
        const sym: Scope['symbol'] = {
            name: getIdentifierLikeText(node),
            line: lc.line,
            column: lc.character,
            fileName: virtualIdNode as any,
        }

        cache.set(node, sym)

        if (deltas) {
            return {
                ...sym,
                line: sym.line - deltas.line,
                column: sym.column - deltas.column,
            }
        }

        return sym
    }

    return { getIdentSymbol }
}

function isInThrowStatement(node: ts.Node) {
    return !!ts.findAncestor(node, p => {
        if (ts.isStatement(p)) {
            return !ts.isThrowStatement(p) ? 'quit' : true
        }

        return false
    })
}

// TODO(perf): increases total compile time by around 5-10%
function getAssignmentSymbol(node: ts.Node, symbolProvider: ReturnType<typeof createSymbolProvider>, cache: Map<ts.Node, Scope['assignmentSymbol'] | undefined>) {
    if (cache.has(node)) {
        return cache.get(node)
    }

    const ancestor = ts.findAncestor(node, p => {
        if (!p.parent) {
            return 'quit'
        }

        if (isSymbolAssignmentLike(p.parent) && p.parent.initializer === p) {
            return true
        }

        if (ts.isStatement(p.parent)) {
            return 'quit'
        }

        return false
    })

    if (!ancestor) {
        cache.set(node, undefined)
        return
    }

    const decl = ancestor.parent as ts.VariableDeclaration | ts.PropertyAssignment | ts.PropertyDeclaration
    if (ts.isIdentifier(decl.name)) {
        const sym = symbolProvider.getIdentSymbol(decl.name)
        cache.set(node, sym)

        return sym
    } else {
        cache.set(node, undefined)
    }
}

// TODO: expand this to "computed" identifiers
type IdentifierLike = ts.Identifier | ts.PrivateIdentifier | ts.StringLiteralLike | ts.ThisExpression | ts.SuperExpression

function isIdentifierLike(node: ts.Node): node is IdentifierLike {
    switch (node.kind) {
        case ts.SyntaxKind.ThisKeyword:
        case ts.SyntaxKind.SuperKeyword:
        case ts.SyntaxKind.Identifier:
        case ts.SyntaxKind.PrivateIdentifier:
        case ts.SyntaxKind.StringLiteral:
        case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
            return true
        
        default: return false
    }
}

type TfSymbol = NonNullable<Scope['symbol']>
function getSymbolForSourceMap(
    node: ts.Node, 
    symbolProvider: ReturnType<typeof createSymbolProvider>,
    deltas?: { line: number; column: number }
): { symbol?: TfSymbol; namespace?: TfSymbol[] } {
    if (!(node as any).expression) {
        return {}
    }

    const expressions = splitExpression((node as ts.CallExpression | ts.NewExpression).expression).filter(isIdentifierLike)
    if (expressions.length === 0) {
        return {}
    }

    const lastExp = expressions.pop()!

    return {
        symbol: symbolProvider.getIdentSymbol(lastExp, deltas),
        namespace: expressions.length > 0 ? expressions.map(exp => symbolProvider.getIdentSymbol(exp, deltas)) : undefined,
    }
}

export interface Binding {
    readonly target: string
    readonly replacement: FQN
}

function createConfigurationClass(
    node: ts.CallExpression, 
    typeScope: Scope,
    factory = ts.factory
) {
    const callExp = factory.updateCallExpression(
        node,
        node.expression,
        node.typeArguments,
        [
            ...node.arguments,
            createObjectLiteral(typeScope as any)
        ]
    )

    return callExp
}

function isAsync(node: ts.Node): boolean {
    // Most common case
    if (node.kind === ts.SyntaxKind.CallExpression || node.kind === ts.SyntaxKind.NewExpression) {
        const exp = node as ts.CallExpression | ts.NewExpression
        if (isAsync(exp.expression)) {
            return true
        }

        if (exp.arguments) {
            for (let i = 0; i < exp.arguments.length; i++) {
                if (isAsync(exp.arguments[i])) {
                    return true
                }
            }
        }

        return false
    }

    if (ts.isAwaitExpression(node)) {
        return true
    }

    if (
        ts.isClassExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) || 
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
    ) {
        return false
    }

    return node.forEachChild(isAsync) ?? false
}

function getRootTarget(node: ts.Node): ts.Node {
    if (ts.isCallExpression(node)) {
        return getRootTarget(node.expression)
    }

    if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
            return node
        }

        return getRootTarget(node.expression)
    }

    if (ts.isIdentifier(node)) {
        return node
    }

    return node
}

function runWithContext(args: ts.Expression[], factory = ts.factory) {
    return factory.createCallExpression(
        factory.createIdentifier('__scope__'),
        undefined,
        args
    )
}

// foo(await bar())
// __scope__(foo, await bar())
// __scope__(foo, await __scope__(bar))

// x.y.z()
// __scope__(x.y.z.bind(x.y))

// new Foo(await bar())
// __scope__(Reflect.construct.bind(Reflect, Foo, [await bar()]))
// __scope__(Reflect.construct.bind(Reflect, Foo, [await __scope__(bar)])

function bindNewExpression(node: ts.NewExpression) {
    const reflectIdent = ts.factory.createIdentifier('Reflect')
    const args = [reflectIdent, node.expression]
    if (node.arguments) {
        args.push(ts.factory.createArrayLiteralExpression(node.arguments))
    }

    return ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(reflectIdent, 'construct'),
            'bind'
        ),
        undefined,
        args,
    )
}

function unwrapParentheses(node: ts.Expression) {
    if (ts.isParenthesizedExpression(node)) {
        return unwrapParentheses(node.expression)
    }

    return node
}

function bindCallExpression(node: ts.CallExpression) {
    const unwrapped = unwrapParentheses(node.expression)
    const thisArg = (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped))
        ? unwrapped.expression
        : undefined

    if (!thisArg) {
        return ts.factory.updateCallExpression(
            node,
            ts.factory.createPropertyAccessExpression(
                ts.factory.createParenthesizedExpression(node.expression), 
                'bind'
            ),
            undefined,
            [ts.factory.createVoidZero(), ...node.arguments]
        )
    }

    // You have to use a temp var in this case
    // (_ = x.y, _.z.bind(_))

    const tmpVarIdent = ts.factory.createIdentifier('_')
    const tmpVar = ts.factory.createAssignment(tmpVarIdent, thisArg)
    const targetFn = ts.isPropertyAccessExpression(unwrapped) 
        ? ts.factory.updatePropertyAccessExpression(
            unwrapped,
            tmpVarIdent,
            unwrapped.name,
        ) 
        : ts.factory.updateElementAccessExpression(
            unwrapped as ts.ElementAccessExpression,
            tmpVarIdent,
            (unwrapped as ts.ElementAccessExpression).argumentExpression,
        )

    const bindExp = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(targetFn, 'bind'),
        undefined,
        [tmpVar, ...node.arguments]
    )

    return ts.factory.createParenthesizedExpression(
        ts.factory.createCommaListExpression([tmpVar, bindExp])
    )
}

function wrapScope(
    scope: Scope,
    node: ts.NewExpression | ts.CallExpression,
    isAsync = false,
    factory = ts.factory
) {
    const wrapped = runWithContext([
        createObjectLiteral(scope as any, factory),
        factory.createArrowFunction(
            isAsync ? [factory.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined,
            undefined,
            [],
            undefined,
            undefined,
            node
        )
    ], factory)

    return isAsync ? factory.createAwaitExpression(wrapped) : wrapped
}

export function hasTraceDirective(node: ts.Node) {
    const sf = ts.getOriginalNode(node).getSourceFile()
    if (!sf) {
        return
    }

    const text = sf.getFullText(sf)
    const comments = ts.getLeadingCommentRanges(text, node.pos)
    if (!comments) {
        return
    }

    const lines = comments
        .filter(c => c.kind === ts.SyntaxKind.SingleLineCommentTrivia)
        .map(c => text.slice(c.pos, c.end))

    const result = parseDirectives(lines)

    return result['trace']
}

function createStubFactory(moduleName: string) {
    function createFunc(block: ts.Block, params: ts.ParameterDeclaration[] = []) {
        return ts.factory.createFunctionExpression(
            undefined,
            undefined,
            undefined,
            undefined,
            params,
            undefined,
            block
        )
    }

    function createThrow(message: string) {
        return ts.factory.createThrowStatement(
            ts.factory.createNewExpression(
                ts.factory.createIdentifier('Error'),
                undefined,
                [ts.factory.createStringLiteral(message)]
            )
        )
    }

    // This enables the (rough) equivalent of an "allow-undefined-symbols" option available in most linkers
    // Of course this operates more so at the library level rather than individual symbols
    //
    // We only need to add this because the synth loader checks for this property before serializing.
    const moduleIdOverride = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier('Symbol'),
            'for'
        ),
        undefined,
        [ts.factory.createStringLiteral('moduleIdOverride')]
    )

    const get = createFunc(ts.factory.createBlock([
        ts.factory.createIfStatement(
            ts.factory.createStrictEquality(ts.factory.createIdentifier('prop'), moduleIdOverride),
            ts.factory.createReturnStatement()
        )
    ]), [
        ts.factory.createParameterDeclaration(undefined, undefined, '_'),
        ts.factory.createParameterDeclaration(undefined, undefined, 'prop')
    ])

    const errorMessage = `Module "${moduleName}" has not been deployed`
    const proxyFunctions: { [P in keyof ProxyHandler<any>]: ts.FunctionExpression | ts.ArrowFunction } = {
        get,
        set: createFunc(ts.factory.createBlock([createThrow(errorMessage)])),
        apply: createFunc(ts.factory.createBlock([createThrow(errorMessage)])),
        construct: createFunc(ts.factory.createBlock([createThrow(errorMessage)])),
    }

    const body = ts.factory.createBlock([
        ts.factory.createReturnStatement(
            ts.factory.createNewExpression(
                ts.factory.createIdentifier('Proxy'),
                undefined,
                [
                    createFunc(ts.factory.createBlock([])),
                    createObjectLiteral(proxyFunctions)
                ]
            )
        )
    ])

    return ts.factory.createFunctionDeclaration(undefined, undefined, 'createStub', undefined, [], undefined, body)
}

export function generateModuleStub(tscRootDir: string, graphCompiler: ReturnType<typeof createGraphCompiler>, sf: ts.SourceFile) {
    const exports: string[] = []
    for (const s of sf.statements) {
        if (!isExported(s)) {
            continue
        }
    
        if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
                const sym = graphCompiler.getSymbol(d)
                if (sym) {
                    exports.push(sym.name)
                }
            }
        } else {
            const sym = graphCompiler.getSymbol(s)
            if (sym) {
                exports.push(sym.name)
            }
        }
    }

    if (exports.length === 0) {
        return sf
    }

    const moduleName = path.relative(tscRootDir, sf.fileName)
    const stubFactory = createStubFactory(moduleName)
    const statements: ts.Statement[] = []
    for (const name of exports) {
        statements.push(
            createVariableStatement(
                name, 
                ts.factory.createCallExpression(stubFactory.name!, undefined, undefined),
                [ts.SyntaxKind.ExportKeyword]
            ),
        )
    }

    return ts.factory.updateSourceFile(
        sf,
        [stubFactory, ...statements],
    )
}

function createReflectionTransformer(
    graphCompiler: ReturnType<typeof createGraphCompiler>,
    schemaFactory: SchemaFactory
): ts.PrintHandlers {
    function onEmitNode(hint: ts.EmitHint, node: ts.Node, emitCallback: (hint: ts.EmitHint, node: ts.Node) => void) {
        if (!ts.isCallExpression(node)) {
            return emitCallback(hint, node)
        }

        const importName = getCoreImportName(graphCompiler, node.expression)
        if (importName) {
            console.log(getNodeLocation(node), importName)
        }

        if (importName === 'check') {
            // needsValidationImport.set(ts.getOriginalNode(node).getSourceFile(), true)

            return schemaFactory.addValidationSchema(node)
        } else if (importName === 'schema') {
            return ts.factory.createCallExpression(
                ts.factory.createIdentifier('foo'),
                undefined, [] 
            )
            // return schemaFactory.replaceWithSchema(node)
        }

        return emitCallback(hint, node)
    }

    function isEmitNotificationEnabled(node: ts.Node) {
        return node.kind === ts.SyntaxKind.CallExpression
    }

    function substituteNode(hint: ts.EmitHint, node: ts.Node): ts.Node {
        if (!ts.isCallExpression(node)) {
            return node
        }

        const importName = getCoreImportName(graphCompiler, node.expression)
        if (importName === 'check') {
            // needsValidationImport.set(ts.getOriginalNode(node).getSourceFile(), true)

            return schemaFactory.addValidationSchema(node)
        } else if (importName === 'schema') {
            // Updating the call expression is a hack. Emitting the literal directly didn't work
            return ts.factory.updateCallExpression(
                node,
                ts.factory.createPropertyAccessExpression(
                    ts.factory.createCallExpression(
                        ts.factory.createIdentifier('require'),
                        undefined,
                        [ts.factory.createStringLiteral('')], // TODO
                    ),
                    '__schema'
                ),
                undefined,
                [schemaFactory.replaceWithSchema(node)]
            )
        }

        return node
    }

    return {
        // onEmitNode
        substituteNode,
    }
}
