import ts, { factory, isCallExpression } from 'typescript'
import { SourceMapHost, createVariableStatement, emitChunk, extract, failOnNode, getNodeLocation, getNullTransformationContext, isNonNullable, printNodes } from './utils'
import { isAssignmentExpression, Symbol, Scope, createGraphOmitGlobal, getContainingScope, unwrapScope, getSubscopeDfs, getReferencesInScope, getRootSymbol, RootScope, createGraph, getSubscopeContaining, getImmediatelyCapturedSymbols, getRootAndSuccessorSymbol, printSymbol } from './scopes'
import { createObjectLiteral, createPropertyAssignment, createSymbolPropertyName, createSyntheticComment, hashNode, memoize, removeModifiers } from '../utils'
import { SourceMapV3 } from '../runtime/sourceMaps'
import { liftScope } from './scopes'
import { ResourceTypeChecker } from '../compiler/resourceGraph'
import { throwIfCancelled, CancelError } from '../execution'

function isSuperCallExpressionStatement(node: ts.Statement) {
    return (
        ts.isExpressionStatement(node) && 
        ts.isCallExpression(node.expression) && 
        node.expression.expression.kind === ts.SyntaxKind.SuperKeyword
    )
}

function createMovablePropertyName(factory = ts.factory) {
    return createSymbolPropertyName('__moveable__', factory)
}

function createSerializationData(
    targetModule: string,
    captured: ts.Expression[],
    factory = ts.factory,
    moduleType: 'esm' | 'cjs'
) {
    const filename = moduleType === 'cjs'
        ? factory.createIdentifier('__filename')
        : factory.createPropertyAccessExpression(
            factory.createPropertyAccessExpression(factory.createIdentifier('import'), 'meta'),
            'filename'
        )

    const moduleExpression = factory.createCallExpression(
        factory.createIdentifier('__getPointer'),
        undefined,
        [
            filename,
            factory.createStringLiteral(targetModule)
        ]
    )

    return createObjectLiteral({
        valueType: 'function',
        module: moduleExpression,
        captured,
    }, factory)
}

function createModuleFunction(
    serializationData: ts.Expression,
    factory = ts.factory,
) {
    return factory.createArrowFunction(
        undefined, 
        undefined, 
        [], 
        undefined, 
        undefined,
        factory.createBlock([
            factory.createReturnStatement(serializationData)
        ], true)
    )
}

function addModuleSymbolToFunction(
    node: ts.FunctionDeclaration,
    serializationData: ts.Expression,
    factory = ts.factory,
) {
    if (!node.name) {
        failOnNode('Expected name', node)
    }

    const access = factory.createElementAccessExpression(
        factory.createIdentifier(node.name.text),
        createMovablePropertyName(factory)
    )

    return factory.createExpressionStatement(
        factory.createAssignment(
            access,
            createModuleFunction(serializationData, factory)
        )
    )
}

function addModuleSymbolToMethod(
    node: ts.MethodDeclaration, 
    serializationData: ts.Expression,
    factory = ts.factory,
) {
    if (!node.name) {
        failOnNode('Expected name', node)
    }

    if (ts.isPrivateIdentifier(node.name)) {
        failOnNode('Cannot serialize private methods', node.name)
    }

    const className = ts.isClassLike(node.parent) ? node.parent.name : undefined
    if (!className) {
        failOnNode('Expected class name', node.parent)
    }

    const classIdent = factory.createIdentifier(className.text)
    const accessExp = ts.isIdentifier(node.name) 
        ? factory.createPropertyAccessExpression(classIdent, node.name)
        : factory.createElementAccessExpression(
            factory.createIdentifier(className.text),
            ts.isComputedPropertyName(node.name) ? node.name.expression : node.name
        )
    const access = factory.createElementAccessExpression(
        accessExp,
        createMovablePropertyName(factory)
    )

    return factory.createExpressionStatement(
        factory.createAssignment(
            access,
            createModuleFunction(serializationData, factory)
        )
    )
}

function createAssignExpression(target: ts.Expression, value: ts.Expression, factory = ts.factory) {
    return factory.createCallExpression(
        factory.createPropertyAccessExpression(
            factory.createIdentifier('Object'),
            'assign'
        ),
        undefined,
        [target, value]
    )
}

function addModuleSymbolToFunctionExpression(
    node: ts.FunctionExpression | ts.ArrowFunction, 
    serializationData: ts.Expression,
    factory = ts.factory,
) {
    const fn = factory.createArrowFunction(
        undefined, 
        undefined, 
        [], 
        undefined, 
        undefined,
        factory.createParenthesizedExpression(serializationData)
    )

    return createAssignExpression(node, factory.createObjectLiteralExpression([
        factory.createPropertyAssignment(
            factory.createComputedPropertyName(
                createSymbolPropertyName('__moveable__', factory)
            ),
            fn
        )
    ]), factory)
}


interface Scopes {
    readonly calls: (ts.NewExpression | ts.CallExpression)[] // | TaggedTemplateExpression | Decorator | InstanceofExpression
    readonly classes: (ts.ClassDeclaration | ts.ClassExpression | ts.ObjectLiteralExpression)[]
    readonly methods: (ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration)[]
    readonly functions: (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.ConstructorDeclaration)[]
    readonly assignments: (ts.VariableDeclaration | ts.PropertyAssignment | ts.PropertyDeclaration)[]

    readonly throws: ts.ThrowStatement[]
}

function getScopeType(node: ts.Node): keyof Scopes | undefined {
    switch (node.kind) {
        case ts.SyntaxKind.NewExpression:
        case ts.SyntaxKind.CallExpression:
            return 'calls'

        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.ClassExpression:
        case ts.SyntaxKind.ObjectLiteralExpression:
            return 'classes'
    
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
            return 'methods'

        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.Constructor:
            return 'functions'

        case ts.SyntaxKind.Parameter:
        case ts.SyntaxKind.VariableDeclaration:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.PropertyAssignment:
            return 'assignments'

        case ts.SyntaxKind.ThrowStatement:
            return 'throws'
    }
}

export type ScopeTracker = ReturnType<typeof createScopeTracker>
export function createScopeTracker() {
    type ScopesWithKey = { [P in keyof Scopes]: [Scopes[P][number], keyof Scopes][] }

    const scopes: Scopes = {
        calls: [],
        classes: [],
        methods: [],
        functions: [],
        assignments: [],

        throws: [],
    }

    function getScope<T extends keyof Scopes>(key: T, pos = -1): Scopes[T][number] | undefined {
        return scopes[key].at(pos)
    }

    function getScopes<T extends (keyof Scopes)[]>(...keys: T): Readonly<Scopes[T[number]][number][]> {
        return Array.from(iterateScopes.apply(undefined, keys))
    }

    function* iterateScopes<T extends (keyof Scopes)[]>(...keys: T): Generator<Scopes[T[number]][number], void, undefined> {
        if (keys.length === 1) {
            return yield* scopes[keys[0]]
        }

        const s = new Map(keys.map(k => [k, -1]))
        for (let i = keyScope.length - 1; i >= 0; i--) {
            const k = keyScope[i]
            const j = s.get(k)
            if (!j) continue

            yield scopes[k].at(j)!
            s.set(k, j - 1)
        }
    }

    const keyScope: (keyof Scopes)[] = []
    function enter<T, U extends ts.Node = ts.Node>(node: U, fn: (node: U) => T): T {
        const type = getScopeType(node)
        if (type === undefined) {
            return fn(node)
        }

        // keys.push(type)
        const arr = scopes[type] as ts.Node[]
        arr.push(node)
        keyScope.push(type)

        const result = fn(node)
        arr.pop()
        keyScope.pop()

        return result
    }

    function dump() {
        const stack = getScopes(...(Object.keys(scopes) as any))
        const lines: string[] = []
        for (let i = 0; i < stack.length; i++) {
            lines.push(`${getNodeLocation(stack[i])} [${keyScope[i]}]`)
        }
        return lines
    }

    return { enter, getScope, getScopes, iterateScopes, dump }
}

// - jsx(type, props, key)
// - jsxs(type, props, key)
// - jsxDEV(type, props, key, __source, __self)

const assetsName = '__synapse_assets__'

function createAssetAccess(assetName: string, factory = ts.factory) {
    return factory.createElementAccessExpression(
        factory.createIdentifier(assetsName),
        factory.createStringLiteral(assetName)
    )
}

export function createImporterExpression(moduleType: 'cjs' | 'esm', factory = ts.factory) {
    if (moduleType === 'cjs') {
        return factory.createIdentifier('__filename')
    }

    return factory.createPropertyAccessExpression(
        factory.createPropertyAccessExpression(
            factory.createIdentifier('import'),
            'meta'
        ),
        'filename'
    )
}

function createAssetCallExpression(target: ts.Expression) {
    return ts.factory.createCallExpression(
        ts.factory.createIdentifier('__createAsset'),
        [],
        [target, ts.factory.createIdentifier('__filename')]
    )
}

type AssetsMap = Map<string, { literal: ts.Expression }>

function renderAssets(assets: AssetsMap) {
    const entries = [...assets].map(([k, v]) => [k, createAssetCallExpression(v.literal)] as const)

    return createObjectLiteral({
        ...Object.fromEntries(entries),
        [assetsName]: true,
    })
}

// TODO: support this:
// /** @jsxImportSource preact */

// Also this I guess:
// /** @jsx h */
// /** @jsxFrag Fragment */
// import { h, Fragment } from 'preact'

function transformJsx(
    node: ts.Node, 
    jsxImport: ts.Identifier,
    assets: AssetsMap,
    factory = ts.factory
) {
    const jsxExp = factory.createPropertyAccessExpression(jsxImport, 'jsx')
    const jsxsExp = factory.createPropertyAccessExpression(jsxImport, 'jsxs')
    const fragmentExp = factory.createPropertyAccessExpression(jsxImport, 'Fragment')
    const staticChildren = new WeakMap<ts.Expression, boolean>()

    const tagStack: (ts.StringLiteral | ts.Identifier)[] = []

    function isInImgTag() {
        return tagStack[tagStack.length - 1]?.text === 'img'
    }
    
    function getType(node: ts.JsxTagNameExpression) {
        if (ts.isIdentifier(node)) {
            if (node.text.charAt(0).toUpperCase() === node.text.charAt(0)) {
                return node
            } else {
                return factory.createStringLiteral(node.text)
            }
        } 

        if (ts.isPropertyAccessExpression(node)) {
            failOnNode('TODO', node)

            // const member = node.name.text
            // if (!ts.isIdentifier(node.expression)) {
            //     failOnNode('Not implemented', node.expression)
            // }

            // return factory.createStringLiteral(`${node.expression.text}.${member}`)
        }

        failOnNode('Not implemented', node)
    }

    function getProperty(node: ts.JsxAttributeLike): [string, ts.Expression] | ts.Expression {
        if (ts.isJsxSpreadAttribute(node)) {
            return node.expression
        }

        if (!ts.isIdentifier(node.name)) {
            failOnNode('Not implemented', node)
        }

        if (!node.initializer) {
            return [node.name.text, factory.createTrue()]
        }

        if (node.name.text === 'src' && ts.isStringLiteral(node.initializer) && isInImgTag() && (node.initializer.text.startsWith('./') || node.initializer.text.startsWith('../'))) {
            return [node.name.text, transformAsset(node.initializer)]
        }

        if (node.name.text === 'style' && ts.isJsxExpression(node.initializer)) {
            if (node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
                return [node.name.text, transformInlineStyle(node.initializer.expression)]
            }
        }

        return [node.name.text, visitAttributeValue(node.initializer)]
    }

    function transformInlineStyle(node: ts.ObjectLiteralExpression) {
        const props = node.properties.map(p => {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'background') {
                if (ts.isStringLiteral(p.initializer)) {
                    const transformed = maybeTransformUrl(p.initializer)
                    if (transformed) {
                        return factory.updatePropertyAssignment(p, p.name, transformed)
                    }
                }
            }

            return p
        })

        return factory.updateObjectLiteralExpression(node, props)
    }

    function maybeTransformUrl(node: ts.StringLiteral) {
        const urlIndex = node.text.indexOf('url(')
        if (urlIndex !== -1) {
            const start = urlIndex + 5
            const endIndex = node.text.indexOf(')', start)
            if (endIndex !== -1) {
                const url = node.text.slice(start, endIndex - 1)
                if (url.startsWith('./') || url.startsWith('../')) {
                    assets.set(url, { literal: factory.createStringLiteral(url) })

                    return factory.createTemplateExpression(
                        factory.createTemplateHead(node.text.slice(0, start)),
                        [
                            factory.createTemplateSpan(
                                createAssetAccess(url, factory),
                                factory.createTemplateTail(node.text.slice(endIndex - 1))
                            )
                        ]
                    )
                }
            }
        }
    }

    function transformAsset(node: ts.StringLiteral): ts.Expression {
        const literal = node.text
        assets.set(literal, { literal: node })

        return createAssetAccess(literal, factory)
    }

    function visitAttributes(node: ts.JsxAttributes) {
        const props = node.properties.map(getProperty)
        const keyIndex = props.findIndex(v => Array.isArray(v) && v[0] === 'key')
        const key = keyIndex !== -1 ? (extract(props, keyIndex) as [string, ts.Expression])[1] : undefined

        const attributes = props.map(v => {
            if (Array.isArray(v)) {
                return createPropertyAssignment(factory, v[0], v[1])
            }

            return factory.createSpreadAssignment(v)
        })

        return { key, attributes }
    }

    interface VNodeProps {
        key?: ts.Expression
        children?: ts.Expression
        attributes?: ts.ObjectLiteralElementLike[]
    }

    function createVNode(type: ts.Expression, props?: VNodeProps) {
        const key = props?.key
        const elements = props?.attributes ?? []
        if (props?.children) {
            elements.push(createPropertyAssignment(factory, 'children', props.children))
        }

        const attrExp = factory.createObjectLiteralExpression(elements, true)
        const isStaticChildren = props?.children && staticChildren.get(props?.children)

        return factory.createCallExpression(
            isStaticChildren ? jsxsExp : jsxExp,
            undefined,
            !key ? [type, attrExp] : [type, attrExp, key]
        )
    }

    function visitChildren(children: ts.NodeArray<ts.JsxChild>): ts.Expression | undefined {
        const mapped = children
            .filter(c => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces))
            .filter(c => !(ts.isJsxExpression(c) && !c.expression))
            .map(c => {
                if (ts.isJsxText(c)) {
                    return factory.createStringLiteral(c.text)
                }

                return visitAttributeValue(c)
            })

        if (mapped.length === 0) {
            return
        }

        if (mapped.length === 1) {
            return visitExpression(mapped[0])
        }

        const result = factory.createArrayLiteralExpression(mapped.map(visitExpression), true)
        staticChildren.set(result, true)

        return result
    }

    function visitAttributeValue(node: ts.JsxAttributeValue): ts.Expression {
        if (ts.isStringLiteral(node)) {
            return node
        }

        if (ts.isJsxExpression(node)) {
            if (!node.expression) {
                failOnNode('Empty expression', node)
            }

            return visitExpression(node.expression)
        }

        if (ts.isJsxFragment(node)) {
            return visitJsxFragment(node)
        }

        if (ts.isJsxSelfClosingElement(node)) {
            return visitJsxSelfClosingElement(node)
        }

        return visitJsxElement(node)
    }

    function visitJsxFragment(node: ts.JsxFragment) {
        const children = visitChildren(node.children)

        return createVNode(fragmentExp, children ? { children } : undefined)
    }

    function visitJsxSelfClosingElement(node: ts.JsxSelfClosingElement): ts.Expression {
        const type = getType(node.tagName)
        tagStack.push(type)
        const attributes = visitAttributes(node.attributes)
        tagStack.pop()

        return createVNode(type, attributes)
    }

    function visitJsxElement(node: ts.JsxElement): ts.Expression {
        const type = getType(node.openingElement.tagName)
        tagStack.push(type)
        const attributes = visitAttributes(node.openingElement.attributes)
        const children = visitChildren(node.children)
        tagStack.pop()

        return createVNode(type, children ? { ...attributes, children } : attributes)
    }

    function visitExpression(node: ts.Expression): ts.Expression {
        return visit(node) as ts.Expression
    }

    const context = getNullTransformationContext()

    function visit(node: ts.Node): ts.Node {
        if (ts.isJsxElement(node)) {
            return visitJsxElement(node)
        }
        if (ts.isJsxSelfClosingElement(node)) {
            return visitJsxSelfClosingElement(node)
        }
        if (ts.isJsxFragment(node)) {
            return visitJsxFragment(node)
        }
        if (ts.isJsxExpression(node)) {
            if (!node.expression) {
                failOnNode('Empty expression', node)
            }

            return visit(node.expression)
        }

        return ts.visitEachChild(node, visit, context)
    }

    return visit(node)
}

function createJsxRuntime(options: ts.CompilerOptions, factory = ts.factory) {
    const importSource = options.jsxImportSource ?? 'react'

    function createImportDecl(spec: string) {
        const ident = factory.createIdentifier('import_jsx_runtime')
        const decl = factory.createImportDeclaration(
            undefined,
            factory.createImportClause(
                false, 
                undefined, 
                factory.createNamespaceImport(ident)
            ),
            factory.createStringLiteral(spec)
        )

        return { ident, decl }
    }

    switch (options.jsx) {
        case ts.JsxEmit.ReactJSX:
            return createImportDecl(`${importSource}/jsx-runtime`)
        default:
            throw new Error(`JSX emit kind not implemented: ${options.jsx}`)
    }
}

type ClauseReplacement = [clause: ts.HeritageClause, ident: ts.Identifier] | undefined

function addDeserializeConstructor(
    node: ts.ClassExpression | ts.ClassDeclaration,
    clauseReplacement: ClauseReplacement,
    factory: ts.NodeFactory
) {
    const descIdent = factory.createIdentifier('desc')
    const tag = createSymbolPropertyName('deserialize', factory)
    const fields = node.members.filter(isPrivateField)
    const privateFieldsIdent = factory.createIdentifier('__privateFields')
    const privateFields = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            privateFieldsIdent,
            undefined,
            undefined,
            factory.createCallExpression(
                factory.createPropertyAccessExpression(
                    factory.createPropertyAccessExpression(descIdent, '__privateFields'),
                    'pop'
                ),
                undefined,
                []
            )
            )],
          ts.NodeFlags.Const
        )
    )

    const callSuper = factory.createExpressionStatement(
        factory.createCallChain(
            factory.createElementAccessExpression(factory.createSuper(), tag),
            factory.createToken(ts.SyntaxKind.QuestionDotToken),
            undefined,
            [descIdent]
        )
    )

    const hasSuper = !!node.heritageClauses?.find(c => c.token === ts.SyntaxKind.ExtendsKeyword)?.types?.[0]?.expression
    const preamble = hasSuper ? [callSuper, privateFields] : [privateFields]

    const method = factory.createMethodDeclaration(
        undefined,
        undefined,
        factory.createComputedPropertyName(tag),
        undefined,
        undefined,
        [factory.createParameterDeclaration(undefined, undefined, descIdent)],
        undefined,
        factory.createBlock([
            ...preamble,
            ...fields.map(decl => factory.createExpressionStatement(factory.createAssignment(
                factory.createPropertyAccessExpression(
                    factory.createThis(), 
                    factory.createIdentifier(getMappedPrivateName(node, decl.name)),
                ),
                factory.createElementAccessExpression(
                    privateFieldsIdent,
                    factory.createStringLiteral(decl.name.text, true)
                )
            )))
        ], true)
    )

    const transformed = transformPrivateMembers(node, getNullTransformationContext())
    const heritageClauses = !clauseReplacement ? undefined : node.heritageClauses?.map(c => {
        if (ts.getOriginalNode(c) === ts.getOriginalNode(clauseReplacement[0])) {
            const clauseExp = factory.createExpressionWithTypeArguments(clauseReplacement[1], [])

            return factory.updateHeritageClause(c, [clauseExp])
        }

        return c
    })

    const props: ClassProps = {
        members: [...transformed.members, method],
        heritageClauses: heritageClauses,
    }

    return updateClass(transformed, props, factory)
}

function isAssignedTo(node: ts.Node) {
    if (ts.isBinaryExpression(node.parent)) {
        return isAssignmentExpression(node.parent) && node.parent.left === node
    }
}

function isConstantVariableDecl(sym: Symbol & { variableDeclaration: ts.VariableDeclaration }) {
    // Treat other bindings as constant (`var` is largely ignored)
    if (!(sym.variableDeclaration.parent.flags & ts.NodeFlags.Let)) {
        return true
    }

    // No initializer implies not constant
    if (!sym.variableDeclaration.initializer) {
        return false
    }

    // `for (let i = ...)`
    if (sym.variableDeclaration.parent.parent.kind === ts.SyntaxKind.ForStatement) {
        // `for` loops bind symbols uniquely per-iteration
        for (const exp of sym.references) {
            if (isAssignedTo(exp)) {
                return false
            }
        }

        return true
    }

    // TODO: check if `let` can be converted to `const`

    return false
}

function getPrivateAccessExpressionSymbol(sym: Symbol): Symbol | undefined {
    if (!sym.parent) {
        return
    }

    if (!sym.name.startsWith('#')) {
        return getPrivateAccessExpressionSymbol(sym.parent)
    }

    const ref = sym.references[0]
    if (!ref || !ts.isPropertyAccessExpression(ref) || !ts.isPrivateIdentifier(ref.name)) {
        return
    }

    return sym
}

interface SymbolMapping {
    identifier: ts.Identifier
    bound?: boolean
    isDefault?: boolean
    lateBound?: boolean
    moduleSpec?: string
    replacementStack?: ts.Expression[]
}

const replacementStacks = new Map<Symbol, ts.Expression[]>()

function rewriteCapturedSymbols(
    scope: Scope, 
    captured: Symbol[], 
    globals: Symbol[],
    circularRefs: Set<Symbol>,
    runtimeTransformer?: (node: ts.Node) => ts.Node,
    infraTransformer?: (node: ts.Node, depth: number) => ts.Node,
    depth = 0,
    factory = ts.factory
) {
    const refs = new Map<Symbol, ts.Node[]>(
        [...captured, ...globals].map(c => [c, getReferencesInScope(c, scope)]),
    )

    // Any symbol that is reassigned cannot be directly replaced
    // TODO: call expressions with a `this` target cannot be captured directly
    // The binding should probably be applied to all symbols unless we know the original
    // declaration was `const`
    const reduced = new Map<Symbol, ts.Node[]>()
    const boundSymbols = new Set<Symbol>()
    const defaultImports = new Set<Symbol>()
    for (const [sym, nodes] of refs.entries()) {
        if (circularRefs.has(sym) && !sym.parent) {
            boundSymbols.add(sym)
            reduced.set(sym, nodes)
        } else if (!sym.parent && sym.references.some(isAssignedTo)) {
            boundSymbols.add(sym)
            reduced.set(sym, nodes)
        } else if (sym.parent && sym.parent.references.some(isAssignedTo)) {
            // The first check is to handle this case:
            // ```ts
            // const c = []
            // function f(u, v) {
            //     const a = c[u.value.id] ??= []
            //     a[v.value.id] = r
            // }
            // ```
            // 
            // Right now this logic will always choose to bind `c`
            // 
            // The symbol `a[v.value.id]` should be ignored because it's local
            // to the scope. The only symbol we care about is `c[u.value.id]`
            //
            // Because the argument is computed _and_ local to the scope, we
            // cannot bind `c[u.value.id]`
            
            if (sym.parent.computed && sym.parent.parent) {
                boundSymbols.add(sym.parent.parent)
                reduced.set(sym.parent.parent, getReferencesInScope(sym.parent.parent, scope))
            } else {
                boundSymbols.add(sym.parent)
                reduced.set(sym.parent, getReferencesInScope(sym.parent, scope))
            }
        } else if (sym.variableDeclaration && !isConstantVariableDecl(sym as Symbol & { variableDeclaration: ts.VariableDeclaration })) {
            boundSymbols.add(sym)
            reduced.set(sym, nodes)
        } else {
            const privateExp = getPrivateAccessExpressionSymbol(sym)
            if (privateExp) {
                reduced.set(privateExp, getReferencesInScope(privateExp, scope))

                continue
            }

            const root = getRootSymbol(sym)

            const importClause = root.importClause
            if (!importClause) {
                reduced.set(root, getReferencesInScope(root, scope))

                continue
            }

            // Don't split up the module if we reference it directly
            if (refs.has(root)) {
                reduced.set(root, getReferencesInScope(root, scope))
                const name = importClause.name
                if (name?.text === sym.name) {
                    defaultImports.add(sym)
                }

                continue
            }

            const bindings = importClause.namedBindings
            if (!bindings) {
                reduced.set(root, getReferencesInScope(root, scope))

                continue
            }

            if (!ts.isNamespaceImport(bindings)) {
                reduced.set(root, getReferencesInScope(root, scope))

                continue
            }

            // Symbol is from a module, let's reduce it
            let didReduce = false
            for (const [name, member] of root.members.entries()) {
                const nodes = getReferencesInScope(member, scope)
                if (nodes.length > 0) {
                    reduced.set(member, nodes)
                    didReduce = true
                }
            }
            if (!didReduce) {
                reduced.set(root, getReferencesInScope(root, scope))
            }
        }
    }

    // Map all symbols to a valid identifier. Root symbols can be used as-is
    const idents = new Map<Symbol, SymbolMapping>()
    for (const sym of reduced.keys()) {
        if (!replacementStacks.has(sym)) {
            replacementStacks.set(sym, [])
        }

        const isBound = boundSymbols.has(sym)
        const isThis = sym.name === 'this'
        const text = (sym.parent || isBound) ? `__${idents.size}` : isThis ? '__thisArg' : sym.name
        idents.set(sym, {
            identifier: factory.createIdentifier(text),
            bound: isBound,
            isDefault: defaultImports.has(sym),
            lateBound: circularRefs.has(sym),
            // moduleSpec,
            replacementStack: replacementStacks.get(sym),
        })
    }

    const replacements = new Map<ts.Node, ts.Node>()
    for (const [sym, nodes] of reduced) {
        const { identifier, bound } = idents.get(sym)!
        const newNode = bound 
            ? factory.createPropertyAccessExpression(identifier, sym.name)
            : identifier

        replacementStacks.get(sym)![depth] = newNode

        for (const n of nodes) {
            // We don't need to replace equivalent nodes
            const isShorthand = ts.isShorthandPropertyAssignment(n.parent)
            if (!isShorthand && ts.isIdentifier(n) && newNode === identifier && newNode.text === n.text) {
                continue
            }
 
            const exp = isShorthand 
                ? factory.createPropertyAssignment(n.parent.name, cloneNode(newNode) as ts.Expression)
                : cloneNode(newNode)

            ts.setTextRange(exp, n)
            ts.setSourceMapRange(exp, n)

            replacements.set(n, exp)
        }
    }

    const inner = scope.node

    try {
        const node = runtimeTransformer?.(inner) ?? inner
        const infraNode = infraTransformer?.(inner, depth + 1) ?? inner
        if (replacements.size === 0) {
            return { node, infraNode, parameters: idents }
        }

        // Replace all non-root references with the identifier
        const context = getNullTransformationContext()
        function visit(node: ts.Node): ts.Node {
            return replacements.get(node) ?? ts.visitEachChild(node, visit, context)
        }

        return {
            node: visit(node),
            // TODO: this doesn't need to be recursive
            infraNode: visit(infraNode), // TODO: can be made more efficient. We are creating orphaned files atm
            parameters: idents,
        }
    } catch (e) {
        if (e instanceof CancelError) {
            throw e
        }
        throw new Error(`Failed to rewrite symbols at: ${getNodeLocation(scope.node)}`, { cause: e })
    }
}

const getCloneNode = memoize(function () {
    if (!('cloneNode' in ts.factory)) {
        throw new Error('"cloneNode" is missing from the typescript module')
    }

    return ts.factory.cloneNode as (node: ts.Node) => ts.Node
})

function cloneNode(node: ts.Node): ts.Node {
    return getCloneNode()(node)
}


// Perf notes
//
// Benchmarking was done using this function:
// ```ts
// function benchmark(fn: () => string) {
//     let x: bigint = 0n
//     const start = Date.now()
//     for (let i = 0; i < 100_000_000; i++) {
//         x += BigInt(fn().length)
//     }
//
//     return Date.now() - start
// }
//
// For the following cases:
//   a - val => val where val = 'foo' (baseline)
//   b - val => val[0] where val = ['foo'] 
//   c - val => val.c where val = { c: 'foo' }
//
// Functions were constructed as closures e.g. `const y = (b => () => b[0]); const b = x(['foo'])`
//
// Results:
//   * SpiderMonkey
//      a - 2874ms
//      b - 2963ms
//      c - 2950ms
//   * V8
//      a - 436ms
//      b - 194ms (!!!)
//      c - 438ms
//
// Conclusion: using arrays for bindings is preferred on V8

function getBindingName(target: ts.Expression) {
    if (!ts.isPropertyAccessExpression(target)) {
        failOnNode('Expected a property access expression', target)
    }

    // if (!ts.isIdentifier(target.name)) {
    //     failOnNode('Not an identifier', target.name)
    // }

    return target.name
}

// This impl. doesn't work correctly in "scoped" cases. It's only kept around because
// it handles capturing symbols that don't have a corresponding declaration/statement
function renderLegacyBoundSymbol(symbol: Symbol, target: ts.Expression, lateBound = false, factory = ts.factory) {
    const assignment = ts.isIdentifier(target) 
        ? factory.createShorthandPropertyAssignment(target)
        : factory.createPropertyAssignment(getBindingName(target), target)

    return factory.createObjectLiteralExpression([
        assignment,
        factory.createPropertyAssignment(
            factory.createComputedPropertyName(createSymbolPropertyName('symbolId', factory)),
            createObjectLiteral({
                id: symbol.id,
                origin: factory.createIdentifier('__filename'),
                lateBound,
            }, factory)
        )
    ])
}

function renderBoundSymbol(symbol: Symbol, target: ts.Expression, lateBound = false, factory = ts.factory) {
    if (symbol.name.includes('.')) {
        const message = `Unexpected symbol "${symbol.name}" [computed: ${symbol.computed}]`
        const decl = symbol.declaration ?? symbol.parent?.declaration
        if (decl) {
            failOnNode(message, decl)
        }
        throw new Error(message)
    }

    const assignment = ts.isIdentifier(target) 
        ? factory.createShorthandPropertyAssignment(target)
        : factory.createPropertyAssignment(getBindingName(target), target)

    const elements: ts.ObjectLiteralElementLike[] = [assignment]
    if (lateBound) {
        elements.push(factory.createPropertyAssignment(
            factory.createComputedPropertyName(createSymbolPropertyName('symbolId', factory)),
            createObjectLiteral({
                id: symbol.id, // This id is local to the _module_ !!!
                origin: factory.createIdentifier('__filename'),
                lateBound,
            }, factory)
        ))
    }

    const objExp = factory.createObjectLiteralExpression(elements)

    const symName = `__symbol${symbol.id}`
    const tmpDecl = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(symName)
        ], ts.NodeFlags.Let)
    )

    const lazyFn = factory.createArrowFunction(undefined, undefined, [], undefined, undefined, factory.createBinaryExpression(
        factory.createIdentifier(symName),
        ts.SyntaxKind.QuestionQuestionEqualsToken,
        objExp
    ))

    const fnName = `__getSymbol${symbol.id}`
    const lazyFnDecl = createVariableStatement(fnName, lazyFn)

    return {
        statements: [tmpDecl, lazyFnDecl],
        expression: factory.createCallExpression(factory.createIdentifier(fnName), undefined, []),
    }
}

function getMappedSymbolExpression(
    symbol: Symbol, 
    replacementStack: ts.Expression[] = [],
    depth = 0
) {
    if (replacementStack && depth > 0) {
        // It's probably ok to just check for `mapping.replacementStack[depth - 1]`
        for (let i = depth - 1; i >= 0; i--) {
            if (replacementStack[i]) {
                if (i !== depth - 1) {
                    throw new Error(`Nope: ${i} !== ${depth - 1}`)
                }
                return replacementStack[i]
            }
        }

        // return replacementStack[depth - 1]
    }

    if (!symbol.parent) {
        return factory.createIdentifier(symbol.name)
    }

    return cloneNode(symbol.references[0]!) as ts.Expression
}

function renderConstSymbol(symbol: Symbol, mapping: Omit<SymbolMapping, 'identifier'>, depth = 0, printDebug = false) {
    const exp = getMappedSymbolExpression(symbol, mapping.replacementStack, depth)
    if (printDebug) {
        const rootSym = getRootSymbol(symbol)
        const location = rootSym.declaration ? getNodeLocation(rootSym.declaration) : undefined
        if (location) {
            ts.setSyntheticLeadingComments(exp, [createSyntheticComment(` ${location}`)])
        }    
    }

    return exp
}

function createExportedDefaultFunction(
    parameters: ts.ParameterDeclaration[],
    block: ts.Block, 
    moduleType: 'cjs' | 'esm' = 'cjs'
) {
    if (moduleType === 'esm') {
        return factory.createFunctionDeclaration(
            [
                factory.createModifier(ts.SyntaxKind.ExportKeyword),
                factory.createModifier(ts.SyntaxKind.DefaultKeyword),
            ],
            undefined,
            undefined, // factory.createIdentifier(name),
            undefined,
            parameters,
            undefined,
            block
        )
    }

    return factory.createExportAssignment(undefined, true, factory.createFunctionExpression(
        [],
        undefined,
        undefined, // factory.createIdentifier(name),
        undefined,
        parameters,
        undefined,
        block
    ))
}

export interface CompiledFile {
    readonly sourceNode: ts.Node
    readonly name: string
    readonly source: string
    readonly path: string
    readonly data: string
    readonly infraData: string
    readonly infraDeps?: string[]
    readonly parameters: [Symbol, SymbolMapping][]
    readonly assets?: AssetsMap
    readonly sourcesmaps?: {
        readonly runtime: SourceMapV3
        readonly infra: SourceMapV3
    }
    // These are the names of all artifacts referenced by the source
    // readonly artifactDependencies: string[]
}

// const cache = new Map<string, ts.Node>()
// const nodeIds = new Map<ts.Node, number>()
// const getNodeId = (node: ts.Node) => {
//     if (nodeIds.has(node)) {
//         return nodeIds.get(node)!
//     }

//     const id = nodeIds.size
//     nodeIds.set(node, id)

//     return id
// }

// const getNodeCacheKey = (node: ts.Node, depth: number) => {
//     const id = getNodeId(ts.getOriginalNode(node))

//     return `${id}-${depth}`
// }

function isClassElementModifier(modifier: ts.ModifierLike) {
    switch (modifier.kind) {
        case ts.SyntaxKind.StaticKeyword:
        case ts.SyntaxKind.PublicKeyword:
        case ts.SyntaxKind.PrivateKeyword: 
        case ts.SyntaxKind.ProtectedKeyword:
            return true
    }

    return false
}

function convertMethodToFunction(node: ts.MethodDeclaration) {
    const name = ts.factory.createIdentifier('__fn')
    const modifiers = node.modifiers?.filter(x => !isClassElementModifier(x))

    return ts.factory.createFunctionDeclaration(
        modifiers,
        node.asteriskToken,
        name,
        undefined,
        node.parameters,
        undefined,
        node.body
    )
}

// DUPLICATED IN `resourceGraph.ts`
function getImportName(sym: Symbol, clause: ts.ImportClause) {
    const parent = sym.declaration?.parent
    if (parent === clause) {
        return 'default'
    }

    if (parent && ts.isImportSpecifier(parent)) {
        const name = parent.propertyName ?? parent.name

        return name.text
    }
}

// DUPLICATED IN `resourceGraph.ts`
function resolveModuleSpecifier(node: ts.Node) {
    const moduleSpec = (node as ts.StringLiteral).text
    
    return {
        specifier: moduleSpec,
    }
}

// DUPLICATED IN `resourceGraph.ts`
function getNameComponents(sym: Symbol): { specifier?: string; name?: string } {
    if (sym.parent) {
        const parentFqn = getNameComponents(sym.parent)

        return {
            ...parentFqn,
            name: parentFqn.name ? `${parentFqn.name}.${sym.name}` : sym.name,
        }
    }

    if (sym.importClause) {
        const { specifier } = resolveModuleSpecifier(sym.importClause.parent.moduleSpecifier)
        const name = getImportName(sym, sym.importClause)

        return { specifier, name }
    }

    return { name: sym.name }
}

export function getModuleType(opt: ts.ModuleKind | undefined): 'cjs' | 'esm' {
    switch (opt) {
        case ts.ModuleKind.ES2015:
        case ts.ModuleKind.ES2020:
        case ts.ModuleKind.ES2022:
        case ts.ModuleKind.ESNext:
            return 'esm'

        case undefined: // TODO: default to `esm`
        case ts.ModuleKind.Node16:
        case ts.ModuleKind.NodeNext:
        case ts.ModuleKind.CommonJS:
            return 'cjs'

        default:
            throw new Error(`Module kind not supported: ${opt}`) // FIXME: make this user friendly
    }
}

export function createGraphCompiler(
    sourceMapHost: SourceMapHost,
    compilerOptions: ts.CompilerOptions, 
    moduleType = getModuleType(compilerOptions.module)
) {
    const rootGraphs = new Map<ts.SourceFile, RootScope>()
    const compiled = new Map<string, Map<string, CompiledFile>>()
    const emitSourceMap = !!compilerOptions.sourceMap

    const dependencyStack: string[][] = []

    function getGraph(node: ts.SourceFile) {
        if (rootGraphs.has(node)) {
            return rootGraphs.get(node)!
        }

        const graph = createGraph(node)
        rootGraphs.set(node, graph)

        return graph
    }

    function getSymbol(node: ts.Node) {
        const graph = getGraph(node.getSourceFile())

        return graph.symbols.get(node)
    }

    function isDeclared(node: ts.Node) {
        return !!getSymbol(ts.getOriginalNode(node))?.isDeclared
    }

    function getJsxRuntime() {
        return createJsxRuntime(compilerOptions)
    }

    const capturedSymbols = new Map<Symbol, Symbol[]>()
    function getCaptured(sym: Symbol): Symbol[] {
        if (capturedSymbols.has(sym)) {
            return capturedSymbols.get(sym)!
        }

        const scope = getContainingScope(sym)
        if (!scope.node) {
            const r: Symbol[] = []
            capturedSymbols.set(sym, r)

            return r
        }

        const captured = getImmediatelyCapturedSymbols(scope)
        capturedSymbols.set(sym, captured)

        return captured
    }

    const dependencies = new Map<Symbol, Set<Symbol>>()
    function getAllDependencies(sym: Symbol): Set<Symbol> {
        if (dependencies.has(sym)) {
            return dependencies.get(sym)!
        }

        const deps = new Set<Symbol>()
        dependencies.set(sym, deps)
        for (const s of getCaptured(sym)) {
            deps.add(s)
            getAllDependencies(s).forEach(c => deps.add(c))
        }

        return deps
    }

    function getCaptured2(node: ts.Node) {
        const sourceFile = ts.getOriginalNode(node).getSourceFile()
        const graph = getSubscopeContaining(getGraph(sourceFile), sourceFile)
        const targetGraph = getSubscopeDfs(graph, node)
        if (!targetGraph) {
            failOnNode('No graph found', node)
        }
        if (targetGraph === graph) {
            failOnNode('Got source file graph', node)
        }

        const { captured } = liftScope(targetGraph)

        return captured
    }

    function isCircularReference(currentSymbol: Symbol, nextSymbol: Symbol) {
        return getAllDependencies(nextSymbol).has(currentSymbol)
    }

    function liftNode(
        node: ts.Node, 
        factory: ts.NodeFactory, 
        runtimeTransformer?: (node: ts.Node) => ts.Node,
        infraTransformer?: (node: ts.Node, depth: number) => ts.Node,
        clauseReplacement: ClauseReplacement = undefined,
        jsxRuntime?: ts.Identifier,
        excluded: ts.Node[] = [],
        depth = 0
    ) {
        const sourceFile = ts.getOriginalNode(node).getSourceFile()
        const graph = getSubscopeContaining(getGraph(sourceFile), sourceFile)
        //const immediateEnclosingScope = ts.findAncestor(node, n => (ts.isSourceFile(n) || ts.isFunctionDeclaration(n)) && n !== node)
        //const parentGraph = immediateEnclosingScope === sourceFile ? graph : getSubgraphContaining(graph, immediateEnclosingScope!)
        const targetGraph = getSubscopeDfs(graph, node)
        if (!targetGraph) {
            failOnNode('No graph found', node)
        }
        if (targetGraph === graph) {
            failOnNode('Got source file graph', node)
        }

        const { globals, captured } = liftScope(
            targetGraph, 
            [], // ['console']
            excluded.map(n => ts.getOriginalNode(n)).map(n => getSubscopeDfs(graph, n)!)
        )

        // process.stdout.write(`${globals.length}, ${captured.length}\n`)
        const extracted: ts.Node[] = []

        const circularRefs = !targetGraph.symbol 
            ? new Set<Symbol>() 
            : new Set(captured.filter(s => isCircularReference(targetGraph.symbol!, s)))

        const rewritten = rewriteCapturedSymbols(
            targetGraph,
            captured,
            globals,
            circularRefs,
            runtimeTransformer,
            infraTransformer,
            depth,
            factory
        )

        if (clauseReplacement) {
            rewritten.parameters.set({ name: clauseReplacement[1].text } as any, { identifier: clauseReplacement[1] })
        }

        if (jsxRuntime) {
            rewritten.parameters.set({ name: jsxRuntime.text } as any, { identifier: jsxRuntime })
        }

        // Symbols are sorted by the # of parents first followed by their
        // symbol id as a proxy for their position
        //
        // TODO: rename all identifiers to use their symbol id
        function compareSymbols(a: Symbol, b: Symbol): number {
            if (!a.parent && !b.parent) {
                return a.id - b.id
            } else if (a.parent && !b.parent) {
                return 1
            } else if (!a.parent && b.parent) {
                return -1
            }

            return compareSymbols(a.parent!, b.parent!) || (a.id - b.id)
        }

        // The order of the parameters matters (obviously...) so we convert the map to 
        // an array to ensure that the parameters are always read in the same order
        const parameters = [...rewritten.parameters.entries()].sort((a, b) => compareSymbols(a[0], b[0]))

        function finalize(node: ts.Node) {
            if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                return addDeserializeConstructor(node, clauseReplacement, factory)
            }

            if (ts.isMethodDeclaration(node)) {
                return convertMethodToFunction(node)
            }
    
            return ts.isVariableDeclaration(node) ? node.initializer! : node
        }

        const assets: AssetsMap = new Map()

        function createClosure(body: ts.Node) {
            const finalized = finalize(jsxRuntime ? transformJsx(body, jsxRuntime, assets, factory) : body)
            const withoutModifiers = (ts.isFunctionDeclaration(finalized) || ts.isClassDeclaration(finalized))
                ? removeModifiers(finalized, [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword], factory)
                : factory.createReturnStatement(finalized as ts.Expression)

            ts.setSourceMapRange(withoutModifiers, targetGraph!.node)    

            const statements = ts.isFunctionDeclaration(finalized) || ts.isClassDeclaration(finalized)
                ? [
                    withoutModifiers,
                    factory.createReturnStatement(finalized.name) // TODO: handle `export default class/function`
                ]
                : [withoutModifiers]

            const block = factory.createBlock(statements, true)
            // note: values that are exclusively used during instantiation do not need to be captured for 
            // serialization/deserialization of class instances
            const params = parameters.map(c => factory.createParameterDeclaration(undefined, undefined, c[1].identifier))
            if (assets.size > 0) {
                params.push(factory.createParameterDeclaration(undefined, undefined, factory.createIdentifier(assetsName)))
            }

            return [
                ...extracted,
                createExportedDefaultFunction(params, block, moduleType)
            ]
        }

        if (rewritten.node === rewritten.infraNode) {
            return { 
                extracted: createClosure(rewritten.node), 
                parameters,
                assets: assets.size > 0 ? assets : undefined,
            }
        }

        return { 
            extracted: createClosure(rewritten.node), 
            extractedInfra: createClosure(rewritten.infraNode),
            parameters,
            assets: assets.size > 0 ? assets : undefined,
        }
    }

    const consumers: ((file: CompiledFile) => Promise<void> | void)[] = []
    function onEmitFile(consumer: (file: CompiledFile) => Promise<void> | void) {
        consumers.push(consumer)
    }

    function emitFile(file: CompiledFile) {
        for (const consumer of consumers) {
            consumer(file)
        }
    }

    function compileNode(
        name: string, 
        node: ts.Node, 
        factory: ts.NodeFactory,
        runtimeTransformer?: (node: ts.Node) => ts.Node,
        infraTransformer?: (node: ts.Node, depth: number) => ts.Node,
        clauseReplacement: ClauseReplacement = undefined,
        jsxRuntime?: ts.Identifier,
        excluded: ts.Node[] = [],
        depth = 0
    ) {
        const sourceFile = node.getSourceFile()
        if (!sourceFile) {
            failOnNode('Missing source file', node)
        }

        let chunks = compiled.get(sourceFile.fileName)
        if (!chunks) {
            chunks = new Map()
            compiled.set(sourceFile.fileName, chunks)
        }

        let res = chunks.get(name)
        if (!res) {
            if (depth > 0) {
                dependencyStack[dependencyStack.length - 1].push(name)
            }
    
            // `doCompile` pops the stack
            dependencyStack.push([])

            const chunk = doCompile()
            chunks.set(name, chunk)
            emitFile(chunk)
            
            res = chunk
        }

        return {
            captured: res.parameters,
            assets: res.assets,
        }

        function doCompile() {
            const { extracted, extractedInfra, parameters, assets } = liftNode(node, factory, runtimeTransformer, infraTransformer, clauseReplacement, jsxRuntime, excluded, depth)
            const outfile = sourceFile.fileName.replace(/\.(t|j)(sx?)$/, `-${name}.$1$2`)

            const result = emitChunk(sourceMapHost, sourceFile, extracted as ts.Statement[], { emitSourceMap }) 
            const resultInfra = extractedInfra === undefined 
                ? result
                : emitChunk(sourceMapHost, sourceFile, extractedInfra as ts.Statement[], { emitSourceMap })

            return {
                sourceNode: ts.getOriginalNode(node),
                name,
                source: sourceFile.fileName,
                path: outfile,
                data: result.text,
                infraData: resultInfra.text,
                parameters,
                assets,
                infraDeps: dependencyStack.pop(),
                sourcesmaps: emitSourceMap ? {
                    runtime: result.sourcemap!,
                    infra: resultInfra.sourcemap!,
                } : undefined,
            }
        }
    }

    return { getSymbol, getJsxRuntime, liftNode, compileNode, compiled, onEmitFile, isDeclared, getAllDependencies, getCaptured2, moduleType }
}

interface StatementUpdate {
    readonly before?: ts.Statement[]
    readonly after?: ts.Statement[]
}

function* updateStatements(
    statements: ts.Statement[] |  ts.NodeArray<ts.Statement>, 
    updates: Map<ts.Statement, StatementUpdate[]>
) {
    for (const node of statements) {
        const updateToApply = updates.get(ts.getOriginalNode(node) as ts.Statement)
        const before = updateToApply?.reduce((a, b) => a.concat(b.before ?? []), [] as ts.Statement[])
        const after = updateToApply?.reduce((a, b) => a.concat(b.after ?? []), [] as ts.Statement[])

        if (before) {
            yield* before
        }

        yield node

        if (after) {
            yield* after
        }
    }
}

function getFirstStatementOfParent(child: ts.Node) {
    const parent = child.parent
    if ((ts.isSourceFile(parent) || ts.isBlock(parent)) && parent.statements.length > 0) {
        return parent.statements[0]
    } 

    failOnNode('Parent does not have any statements', child)
}

function getAnonymousFunctionName(node: ts.ArrowFunction | ts.FunctionExpression) {
    if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name)) {
        const name = node.parent.name.text
        if (node.parent.parent.flags & ts.NodeFlags.Const) { // Is this even correct????
            return name
        }

        return `${name}_${hashNode(node).slice(0, 16)}`
    }

    if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name)) {
        const name = node.parent.name.text

        return `${name}_${hashNode(node).slice(0, 16)}`
    } 
    
    return `function_${hashNode(node).slice(0, 16)}`
}

export function createRuntimeTransformer(
    compiler: ReturnType<typeof createGraphCompiler>,
    resourceTypeChecker?: ResourceTypeChecker
): (node: ts.Node) => ts.Node {
    const context = getNullTransformationContext()

    function visitCallExpression(node: ts.CallExpression) {
        const sym = node.expression.getSourceFile() ? compiler.getSymbol(node.expression) : undefined
        if (!sym) {
            return ts.visitEachChild(node, visit, context)
        }

        const callableMember = resourceTypeChecker?.getCallableMemberName(sym)
        if (!callableMember) {
            return ts.visitEachChild(node, visit, context)
        }

        return factory.updateCallExpression(
            node,
            factory.createPropertyAccessExpression(node.expression, callableMember),
            node.typeArguments,
            node.arguments.map(visit) as ts.Expression[],
        )
    }

    function visit(node: ts.Node): ts.Node {
        if (ts.isCallExpression(node)) {
            return visitCallExpression(node)
        }

        if (ts.isImportDeclaration(node)) {
            const spec = (node.moduleSpecifier as ts.StringLiteral).text
            if (spec.endsWith('.zig')) {
                return ts.factory.updateImportDeclaration(
                    node,
                    node.modifiers,
                    node.importClause,
                    ts.factory.createStringLiteral(spec.replace(/\.zig$/, '.zig.js')),
                    undefined,
                )
            }
        }

        return ts.visitEachChild(node, visit, context)
    }

    return visit
}

export function createSerializer(
    compiler: ReturnType<typeof createGraphCompiler>,
    resourceTypeChecker?: ResourceTypeChecker
) {
    const names = new Set<string>()
    const nameMap = new Map<ts.Node, string>()
    function getUniqueName(node: ts.Node, name: string) {
        if (nameMap.has(node)) {
            return nameMap.get(node)!
        }

        let count = 0
        const getName = () => count === 0 ? name : `${name}_${count}`
        while (names.has(getName())) count++

        const result = getName()
        names.add(result)
        nameMap.set(node, result)
    
        return result
    }

    // This function will re-compile any emitted files to include serialization data
    function createInfraTransformer(name: string, innerTransformer?: (node: ts.Node) => ts.Node): (node: ts.Node, depth: number) => ts.Node {
        const context = getNullTransformationContext()

        return (node, depth) => {
            throwIfCancelled()

            const isJsx = !!ts.getOriginalNode(node).getSourceFile().fileName.match(/\.(t|j)sx$/)
            const jsxRuntime = isJsx ? compiler.getJsxRuntime() : undefined
            const transformer = createTransformer(context, innerTransformer, name, jsxRuntime?.ident, depth)

            // First transform adds the '__moveable__' symbol
            // Second transform deals with `__scope__`

            const withMoveable = ts.visitEachChild(node, transformer.visit, context)

            return innerTransformer?.(withMoveable) ?? withMoveable
        }
    }

    const runtimeTransformer = createRuntimeTransformer(compiler, resourceTypeChecker)

    function createTransformer(
        context = getNullTransformationContext(), 
        innerTransformer?: (node: ts.Node) => ts.Node,
        namePrefix?: string,
        jsxRuntime?: ts.Identifier,
        depth = 0
    ) {
        // Only set for jsx currently
        let markedForUseServer: Set<ts.Node> | undefined

        // statements to add _after_ the target node
        const updates = new Map<ts.Statement, StatementUpdate[]>()
        function addStatementUpdate(node: ts.Statement, update: StatementUpdate) {
            if (!updates.has(node)) {
                updates.set(node, [])
            }
            updates.get(node)!.push(update)
        }

        // Why is this prefixed `hoist` when it doesn't hoist anything?
        function hoistSerializationData(node: ts.FunctionDeclaration, name: string, captured: ts.Expression[]) {
            const serializationData = createSerializationData(name, captured, context.factory, compiler.moduleType)
            addStatementUpdate(ts.getOriginalNode(node) as ts.Statement, {
                after: [addModuleSymbolToFunction(node, serializationData, context.factory)]
            })
        }

        function hoistMethodSerializationData(node: ts.MethodDeclaration, name: string, captured: ts.Expression[]) {
            const serializationData = createSerializationData(name, captured, context.factory, compiler.moduleType)
            addStatementUpdate(ts.getOriginalNode(node).parent as ts.Statement, {
                after: [addModuleSymbolToMethod(node, serializationData, context.factory)]
            })
        }

        function addUseServerSymbol(node: ts.FunctionDeclaration | ts.VariableDeclaration) {
            const sym = createSymbolPropertyName('synapse.useServer', context.factory)

            function createAssignment(ident: ts.Identifier) {
                return context.factory.createExpressionStatement(
                    context.factory.createAssignment(
                        context.factory.createElementAccessExpression(ident, sym),
                        context.factory.createTrue(),
                    )
                )
            }

            if (node.kind === ts.SyntaxKind.VariableDeclaration) {
                const statement = ts.getOriginalNode(node as ts.VariableDeclaration).parent.parent as ts.Statement
                addStatementUpdate(statement, {
                    after: [createAssignment((node as ts.VariableDeclaration).name as ts.Identifier)]
                })
            } else {
                const statement = ts.getOriginalNode(node) as ts.Statement
                addStatementUpdate(statement, {
                    after: [createAssignment((node as ts.FunctionDeclaration).name as ts.Identifier)]
                })
            }
        }

        const boundSymbolExpressions = new Map<Symbol, ts.Expression>()
        function renderSymbol(symbol: Symbol, mapping: SymbolMapping, depth: number) {
            if (!mapping.bound) {
                return renderConstSymbol(symbol, mapping, depth)
            }

            if (boundSymbolExpressions.has(symbol)) {
                return boundSymbolExpressions.get(symbol)!
            }

            const exp = getMappedSymbolExpression(symbol, mapping.replacementStack, depth)
            const transforms = renderBoundSymbol(symbol, exp, mapping.lateBound)
            if (!symbol.declaration) {
                const fallback = renderLegacyBoundSymbol(symbol, exp, mapping.lateBound)
                boundSymbolExpressions.set(symbol, fallback)
                //throw new Error(`Missing symbol declaration: ${symbol.name}`)
                return fallback
            }

            const statement = ts.isVariableDeclaration(symbol.declaration) 
                ? symbol.declaration.parent.parent
                : symbol.declaration

            if (!ts.isStatement(statement)) {
                const fallback = renderLegacyBoundSymbol(symbol, exp, mapping.lateBound)
                boundSymbolExpressions.set(symbol, fallback)
                // failOnNode('Not a statement', statement)
                return fallback
            }

            boundSymbolExpressions.set(symbol, transforms.expression)

            addStatementUpdate(ts.getOriginalNode(statement) as ts.Statement, {
                after: transforms.statements,
            })

            return transforms.expression
        }

        function renderCapturedSymbols(mappings: [Symbol, SymbolMapping][], assets?: AssetsMap) {
            const base = mappings.map(([x, v]) => renderSymbol(x, v, depth))
            if (assets) {
                base.push(renderAssets(assets))
            }

            return base
        }    

        // FIXME: if an external class is used for deserialization and is also embedded into a module export
        // then `instanceof` won't work between "moved" instances and instantiations within the export
        //
        // Isolating every declaration is one way to solve this
        function extractClassDeclaration(node: ts.ClassDeclaration) {
            node = ts.getOriginalNode(node) as ts.ClassDeclaration
            const name = getName(node)

            // XXX: visit heritage clauses first
            nameStack.push(name)
            node.heritageClauses?.forEach(visit)
            nameStack.pop()

            const clauseReplacement = Array.from(mappedClauses.entries())
                .map(([k, v]) => [k, v.ident] as NonNullable<ClauseReplacement>)
                .find(c => node.heritageClauses?.includes(ts.getOriginalNode(c[0]) as any))
        
            const excluded = clauseReplacement ? [clauseReplacement[0]] : undefined

            return {
                ...compiler.compileNode(name, node, context.factory, runtimeTransformer, createInfraTransformer(name, innerTransformer), clauseReplacement, jsxRuntime, excluded, depth),
                clauseReplacement,
            }
        }

        const nameStack: string[] = namePrefix ? [namePrefix] : []
        function getName(node: ts.Node) {
            if (node.kind === ts.SyntaxKind.SuperKeyword) {
                return nameStack.length === 0 ? 'super' : `${nameStack[nameStack.length - 1]}::super`
            }

            const original = ts.getOriginalNode(node) as ts.ClassDeclaration | ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
            const name = original.name?.text ?? getAnonymousFunctionName(node as any)

            if (nameStack.length === 0) {
                return getUniqueName(original, name)
            }

            return getUniqueName(original, `${nameStack[nameStack.length - 1]}::${name}`)
        }

        function getRelativeName(name: string) {
            if (!namePrefix) {
                return name
            }

            return name.slice(`${namePrefix}::`.length)
        }

        const visited = new Map<ts.Node, ts.Node>()
        function visit(node: ts.Node): ts.Node {
            const key = ts.getOriginalNode(node)
            if (visited.has(key)) {
                return visited.get(key)!
            }

            const result = transform()
            visited.set(key, result)

            return result

            function transform() {
                if (ts.isClassDeclaration(node)) {
                    return visitClassDeclaration(node)
                }
    
                if (ts.isHeritageClause(node)) {
                    return visitHeritageClause(node)
                }
    
                if (ts.isFunctionDeclaration(node)) {
                    return visitFunctionDeclaration(node)
                }

                // if (ts.isMethodDeclaration(node)) {
                //     return visitMethodDeclaration(node)
                // }
    
                if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
                    return visitArrowFunctionOrExpression(node)
                }
    
                if (ts.isBlock(node)) {
                    return visitBlock(node)
                }
    
                if (ts.isSourceFile(node)) {
                    return visitSourceFile(node)
                }

                // The type is implied
                if (markedForUseServer?.has(node)) {
                    addUseServerSymbol(node as ts.VariableDeclaration)     
                }
        
                return ts.visitEachChild(node, visit, context)
            }
        }

        function visitClassDeclaration(node: ts.ClassDeclaration) {
            if (compiler.isDeclared(node)) {
                return node
            }

            const r = extractClassDeclaration(node)
            const name = getName(node)
            nameStack.push(name)
            const visitedClass = ts.visitEachChild(node, visit, context)
            nameStack.pop()

            return addSerializerSymbolToClass(
                visitedClass,
                createSerializationData(
                    getRelativeName(name),
                    renderCapturedSymbols(r.captured, r.assets),
                    factory,
                    compiler.moduleType,
                ),
                r.clauseReplacement,
                context,
            )
        }

        function visitMethodDeclaration(node: ts.MethodDeclaration) {
            const name = getName(node)
            const r = compiler.compileNode(name, node, context.factory, runtimeTransformer, createInfraTransformer(name, innerTransformer), undefined, jsxRuntime, undefined, depth)
            hoistMethodSerializationData(node, getRelativeName(name), renderCapturedSymbols(r.captured, r.assets))

            nameStack.push(name)
            const res = ts.visitEachChild(node, visit, context)
            nameStack.pop()

            return res
        }

        function visitArrowFunctionOrExpression(node: ts.ArrowFunction | ts.FunctionExpression) {
            // if (!compiler.canSerialize(node)) {
            //     return node
            // }

            const name = getName(node)
            const r = compiler.compileNode(name, node, context.factory, runtimeTransformer, createInfraTransformer(name, innerTransformer), undefined, jsxRuntime, undefined, depth)

            nameStack.push(name)
            const visitedFn = ts.visitEachChild(node, visit, context)
            nameStack.pop()

            return addModuleSymbolToFunctionExpression(
                visitedFn,
                createSerializationData(
                    getRelativeName(name),
                    renderCapturedSymbols(r.captured, r.assets),
                    factory,
                    compiler.moduleType,
                ),
                context.factory,
            )
        }

        function visitFunctionDeclaration(node: ts.FunctionDeclaration) {
            // Overload
            if (!node.body) {
                return node
            }

            if (markedForUseServer?.has(node)) {
                addUseServerSymbol(node)
            }

            const name = getName(node)
            const r = compiler.compileNode(name, node, context.factory, runtimeTransformer, createInfraTransformer(name, innerTransformer), undefined, jsxRuntime, undefined, depth)
            hoistSerializationData(node, getRelativeName(name), renderCapturedSymbols(r.captured, r.assets))

            nameStack.push(name)
            const res = ts.visitEachChild(node, visit, context)
            nameStack.pop()

            return res
        }

        function visitBlock(node: ts.Block) {
            node = ts.visitEachChild(node, visit, context)

            return context.factory.updateBlock(
                node,
                Array.from(updateStatements(node.statements, updates)),
            )
        }

        const mappedClauses = new Map<ts.HeritageClause, { ident: ts.Identifier, res: ts.HeritageClause }>()
        function visitHeritageClause(node: ts.HeritageClause) {
            if (mappedClauses.has(node)) {
                return mappedClauses.get(node)!.res
            }

            if (node.token !== ts.SyntaxKind.ExtendsKeyword || !isCallExpression(getInnerExp(node.types[0]))) {
                return ts.visitEachChild(node, visit, context)
            }

            const name = getName(ts.factory.createSuper()).replaceAll('::', '_')
            const ident = ts.factory.createIdentifier(name)
            const updatedExp = visit(node.types[0].expression)
            if (!ts.isExpression(updatedExp)) {
                failOnNode('Not an expression', updatedExp)
            }

            const statement = ts.findAncestor(node, ts.isStatement)
            if (!statement) {
                failOnNode('Node is not apart of a statement', node)
            }

            const decl = createVariableStatement(ident, updatedExp)
            addStatementUpdate(statement, { before: [decl] })

            const res = factory.updateHeritageClause(
                node,
                [factory.updateExpressionWithTypeArguments(node.types[0], ident, undefined)]
            )

            mappedClauses.set(node, { ident, res })

            return res
        }

        function visitSourceFile(node: ts.SourceFile) {
            const isJsx = !!node.fileName.match(/\.(t|j)sx$/)
            if (isJsx) {
                const runtime = compiler.getJsxRuntime()
                jsxRuntime = runtime.ident
                if (node.statements.length > 0) {
                    addStatementUpdate(node.statements[0], {
                        before: [runtime.decl]
                    })
                }
                markedForUseServer = resourceTypeChecker?.getMarkedNodes(node)
            }

            node = ts.visitEachChild(node, visit, context)
            const statements = Array.from(updateStatements(node.statements, updates))

            return context.factory.updateSourceFile(
                node,
                statements,
                node.isDeclarationFile,
                node.referencedFiles,
                node.typeReferenceDirectives,
                node.hasNoDefaultLib,
                node.libReferenceDirectives
            )
        }

        return { visit }
    }

    function transform(node: ts.Node) {
        const result = ts.transform(node, [c => createTransformer(c).visit])

        return printNodes(result.transformed)
    }

    return { createTransformer, transform }
}

function getInnerExp(node: ts.Expression): ts.Expression {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isExpressionWithTypeArguments(node)) {
        return getInnerExp(node.expression)
    }

    return node
}

function getMappedPrivateName(
    node: ts.ClassDeclaration | ts.ClassExpression,
    memberName: ts.PrivateIdentifier,
    baseName = node.name ? `__${node.name.text}` : `__` // TODO: check super classes for private members
) {
    return `${baseName}${memberName.text.replace(/^#/, '_')}`
}

// Private methods will not work with `Reflect.construct`
function transformPrivateMembers(
    node: ts.ClassDeclaration | ts.ClassExpression,
    context: ts.TransformationContext
) {
    const methods = node.members.filter(isPrivateMethod)
    const fields = node.members.filter(isPrivateField)

    const mapped = new Map<string, string>()
    for (const m of [...methods, ...fields]) {
        mapped.set(m.name.text, getMappedPrivateName(node, m.name))
    }

    function visit(node: ts.Node): ts.Node {
        if (ts.isPrivateIdentifier(node)) {
            const newName = mapped.get(node.text)
            if (newName) {
                return context.factory.createIdentifier(newName)
            }
        }

        return ts.visitEachChild(node, visit, context)
    }


    return ts.visitEachChild(node, visit, context)
}

interface ClassProps {
    members?: ts.ClassElement[]
    heritageClauses?: ts.HeritageClause[]
}

function updateClass(node: ts.ClassDeclaration | ts.ClassExpression, props: ClassProps, factory = ts.factory) {
    if (ts.isClassDeclaration(node)) {
        return factory.updateClassDeclaration(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            props.heritageClauses ?? node.heritageClauses,
            props.members ?? node.members,
        )
    } else {
        return factory.updateClassExpression(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            props.heritageClauses ?? node.heritageClauses,
            props.members ?? node.members,
        )
    }
}

function addSerializerSymbolToClass(
    node: ts.ClassDeclaration | ts.ClassExpression,
    serializationData: ts.Expression,
    clauseReplacement: [clause: ts.HeritageClause, ident: ts.Identifier] | undefined,
    context: ts.TransformationContext,
) {
    const factory = context.factory
    const serializeSymbol = createSymbolPropertyName('serialize')
    const moveableSymbol = createSymbolPropertyName('__moveable__')

    const privateFields = Object.fromEntries(getPrivateFields(node).map(n => [
        (n.name! as ts.PrivateIdentifier).text,
        factory.createPropertyAccessExpression(
            factory.createThis(),
            (n.name! as ts.PrivateIdentifier).text
        )
    ]))

    const ident = factory.createIdentifier("__privateFields")
    const init = factory.createBinaryExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier("desc"),
          ident
        ),
        factory.createToken(ts.SyntaxKind.QuestionQuestionEqualsToken),
        factory.createArrayLiteralExpression(
          [],
          false
        )
    )
    const assignment = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            ident,
            undefined,
            undefined,
            init
            )],
          ts.NodeFlags.Const
        )
    )

    const push = factory.createCallExpression(
        factory.createPropertyAccessExpression(
            ident,
            'push'
        ),
        undefined,
        [createObjectLiteral(privateFields, factory)]
    )

    const description = {
        __privateFields: ident,
    }

    // Private members will live on a stack
    // Top of the stack will have private fields for the base class
    // Each constructor pops the stack before returning

    const superClassExp = node.heritageClauses?.find(c => c.token === ts.SyntaxKind.ExtendsKeyword)?.types?.[0]?.expression

    const resultIdent = factory.createIdentifier('result')
    const result = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            resultIdent,
            undefined,
            undefined,
            factory.createObjectLiteralExpression(
                [
                    ...createObjectLiteral(description, factory).properties,
                    factory.createSpreadAssignment(
                        factory.createIdentifier('desc')
                    )
                ],
                true
            )
            )],
          ts.NodeFlags.Const
        )
    )


    const serialize = factory.createMethodDeclaration(
        // [factory.createToken(ts.SyntaxKind.StaticKeyword)],
        undefined,
        undefined,
        factory.createComputedPropertyName(serializeSymbol),
        undefined,
        undefined,
        [factory.createParameterDeclaration(undefined, undefined, 'desc', undefined, undefined, createObjectLiteral({}, factory))],
        undefined,
        factory.createBlock([
            assignment,
            factory.createExpressionStatement(push),
            result,
            superClassExp !== undefined
                ? factory.createReturnStatement(
                    factory.createBinaryExpression(
                        factory.createCallChain(
                            factory.createElementAccessExpression(
                                factory.createSuper(),
                                serializeSymbol
                            ),
                            factory.createToken(ts.SyntaxKind.QuestionDotToken),
                            undefined,
                            [resultIdent]
                        ),
                        factory.createToken(ts.SyntaxKind.QuestionQuestionToken),
                        resultIdent
                    )
                )
                : factory.createReturnStatement(resultIdent)
        ], true)
    )

    
    const move = factory.createMethodDeclaration(
        [factory.createToken(ts.SyntaxKind.StaticKeyword)],
        undefined,
        factory.createComputedPropertyName(moveableSymbol),
        undefined,
        undefined,
        [],
        undefined,
        factory.createBlock([
            factory.createReturnStatement(serializationData)
        ], true)
    )

    const heritageClauses = !clauseReplacement ? undefined : node.heritageClauses?.map(c => {
        if (ts.getOriginalNode(c) === ts.getOriginalNode(clauseReplacement[0])) {
            const clauseExp = factory.createExpressionWithTypeArguments(clauseReplacement[1], [])

            return factory.updateHeritageClause(c, [clauseExp])
        }

        return c
    })

    const props: ClassProps = {
        members: [...node.members, serialize, move],
        heritageClauses: heritageClauses,
    }

    return updateClass(node, props, factory)
}

function getPrivateFields(node: ts.ClassDeclaration | ts.ClassExpression) {
    return node.members.filter(isPrivateField)
}

function isPrivateField(node: ts.ClassElement): node is ts.PropertyDeclaration & { name: ts.PrivateIdentifier }  {
    return !!node.name && ts.isPrivateIdentifier(node.name) && ts.isPropertyDeclaration(node)
}

function isPrivateMethod(node: ts.ClassElement): node is ts.MethodDeclaration & { name: ts.PrivateIdentifier } {
    return !!node.name && ts.isPrivateIdentifier(node.name) && ts.isMethodDeclaration(node)
}


