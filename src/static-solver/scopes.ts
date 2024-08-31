import ts from 'typescript'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { failOnNode, getNodeLocation, isNonNullable } from './utils'
import { getLogger } from '../logging'
import { Mutable, isDeclared } from '../utils'


export interface Symbol {
    readonly id: number
    readonly name: string
    readonly references: ts.Expression[]
    readonly declaration?: ts.Node
    readonly members: Map<string | Symbol, Symbol>
    readonly parent?: Symbol
    readonly parentScope?: Scope
    readonly computed?: boolean
    readonly transient?: boolean // Used for "fake" symbols
    readonly argSymbol?: Symbol
    readonly isDeclared?: boolean // Checks for the `declare` keyword

    // These fields are used to simplify lookups of associated nodes
    readonly importClause?: ts.ImportClause
    readonly variableDeclaration?: ts.VariableDeclaration
}

export interface Scope {
    readonly id: number
    readonly node: ts.Node
    readonly symbol?: Symbol // Not all scopes have an associated symbol
    readonly thisSymbol?: Symbol
    readonly staticThisSymbol?: Symbol
    readonly dependencies: Set<Symbol>
    readonly parent?: Scope
    readonly declarations: Map<string, Symbol>
    readonly subscopes: Set<Scope>

    // TODO: implement this to conditionally exclude code during synthesis
    // readonly condition?: ts.Expression

    // Any call-like expression on external symbols are side-effects
    // Any assignment/mutation to external symbols are side-effects
    // readonly sideEffects: ts.Node[]
}

export interface RootScope extends Scope {
    readonly symbols: Map<ts.Node, Symbol>
}

function isSymbol(obj: unknown): obj is Symbol {
    return (!!obj && typeof obj === 'object' && 'id' in obj && 'name' in obj)
}

function isStaticDeclaration(node: ts.Node) {
    return ts.canHaveModifiers(node) && ts.getModifiers(node)?.find(x => x.kind === ts.SyntaxKind.StaticKeyword)
}

export function getRootSymbol(sym: Symbol): Symbol {
    while (sym.parent !== undefined) sym = sym.parent

    return sym
}

export function getRootAndSuccessorSymbol(sym: Symbol): [Symbol, Symbol?] {
    let successor: Symbol | undefined
    while (sym.parent !== undefined) {
        successor = sym
        sym = sym.parent
    }

    return [sym, successor]
}

// Object literals have a class-like scope with a fixed receiver

export function isScopeNode(node: ts.Node) {
    switch (node.kind) {
        case ts.SyntaxKind.Block:
        case ts.SyntaxKind.CaseBlock:
        // case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.SourceFile:
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.Constructor:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.EnumDeclaration:
        case ts.SyntaxKind.ClassExpression:
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.FunctionDeclaration:
            return true
    }
}

// These are the only scopes that _might_ have symbol associated with them
function isNameableScopeNode(node: ts.Node) {
    switch (node.kind) {
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.EnumDeclaration:
        case ts.SyntaxKind.ClassExpression:
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.FunctionDeclaration:
            return true
    }
}

type FunctionLike =
    | ts.ArrowFunction
    | ts.AccessorDeclaration 
    | ts.FunctionExpression 
    | ts.FunctionDeclaration 
    | ts.MethodDeclaration 
    | ts.ConstructorDeclaration

function isFunctionLike(node: ts.Node): node is FunctionLike {
    switch (node.kind) {
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.Constructor:
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.FunctionDeclaration:
            return true
    }

    return false
}

export function isDeclaration(node: ts.Node) {
    switch (node.kind) {
        // Ignore overloads
        case ts.SyntaxKind.FunctionDeclaration:
            return (node as any).body !== undefined

        case ts.SyntaxKind.Parameter:
        case ts.SyntaxKind.Constructor:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.VariableDeclaration:
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.ImportDeclaration:
        case ts.SyntaxKind.EnumDeclaration:
            return true
    }
}

function isTransientSymbolNode(node: ts.Node) {
    switch (node.kind) {
        case ts.SyntaxKind.Block:
        case ts.SyntaxKind.HeritageClause:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.SourceFile:
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.Constructor:
        case ts.SyntaxKind.ImportDeclaration:
            return true

        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.VariableDeclaration:
        case ts.SyntaxKind.ClassExpression:
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.FunctionDeclaration:
            if (!(node as any).name || !ts.isIdentifier((node as any).name)) {
                return true
            }
    }
}

let scopeCount = 0

function createDependencyGraph() {
    // We track symbols per-file to ensure that ids stay consistent when the file doesn't change
    let symbolCount = 0

    const stack: Scope[] = []

    function createSymbol(name: string, declaration: ts.Node | undefined, computed?: boolean): Symbol {
        return {
            id: symbolCount++,
            name,
            computed,
            references: [],
            declaration,
            members: new Map(),
        }
    }

    function getScopeName(node: ts.Node): string {
        if (ts.isIdentifier(node)) {
            return node.text
        }

        if (ts.isStringLiteral(node)) {
            return node.text
        }

        if (ts.isPropertyName(node)) {
            if (ts.isComputedPropertyName(node)) {
                return '__computed'
            }

            return node.text // bug? handle numeric literals differently?
        }

        if (ts.isVariableDeclaration(node) ||  ts.isParameter(node)) {
            if (!ts.isIdentifier(node.name)) {
                return `__bindingPattern_${symbolCount}` // XXX
                //failOnNode('Binding pattern not implemented', node.name)
            }

            return getScopeName(node.name)
        }

        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
            if (node.name) {
                return getScopeName(node.name)
            }

            return `__anonymousFunction_${symbolCount}`
        }

        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            if (node.name) {
                return getScopeName(node.name)
            }

            return `__anonymousClass_${symbolCount}`
        }

        if (ts.isEnumDeclaration(node)) {
            return getScopeName(node.name)
        }

        if (ts.isConstructorDeclaration(node)) {
            return '__constructor'
        }

        if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
            return getScopeName(node.name)
        }

        if (ts.isForStatement(node)) {
            return `__forStatement_${symbolCount}`
        }

        if (ts.isForOfStatement(node)) {
            return `__forOfStatement_${symbolCount}`
        }

        if (ts.isBlock(node) || ts.isCaseBlock(node)) {
            return `__block_${symbolCount}`
        }

        if (ts.isSourceFile(node)) {
            return node.fileName
        }

        if (ts.isNamespaceImport(node)) {
            return node.name.text
        }

        if (ts.isObjectLiteralExpression(node)) {
            return `__object_${symbolCount}`
        }

        if (ts.isHeritageClause(node)) {
            return `super`
        }

        if (ts.isGetAccessor(node)) {
            return `__get_${getScopeName(node.name)}`
        }

        if (ts.isSetAccessor(node)) {
            return `__set_${getScopeName(node.name)}`
        }

        if (ts.isBindingElement(node)) {
            return getScopeName(node.name)
        }

        failOnNode('Not supported', node)
    }

    const symbols = new Map<ts.Node, Symbol>()

    function addReference(node: ts.Expression, symbol: Symbol) {
        if (symbol.declaration === node || (symbol.declaration as any)?.name === node) {
            symbols.set(node, symbol)
            return
        }

        symbol.references.push(node)
        symbols.set(node, symbol)
    }

    function isPrimaryExpressionLike(node: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.PropertyAccessExpression:
            case ts.SyntaxKind.ElementAccessExpression:
            case ts.SyntaxKind.ParenthesizedExpression:
                return true
        }
    }

    function getStatements(node: ts.Node): readonly ts.Statement[] | undefined {
        switch (node.kind) {
            case ts.SyntaxKind.Block:
                return (node as ts.Block).statements
            // case ts.SyntaxKind.IfStatement:
            //     return (node as ts.IfStatement).elseStatement 
            //         ? [(node as ts.IfStatement).thenStatement, (node as ts.IfStatement).elseStatement!] 
            //         : [(node as ts.IfStatement).thenStatement] 
            case ts.SyntaxKind.ForStatement:
            case ts.SyntaxKind.ForOfStatement:
                return getStatements((node as ts.ForStatement | ts.ForOfStatement).statement) // BUG: I think this misses expression statements
            case ts.SyntaxKind.SourceFile:
                return (node as ts.SourceFile).statements
            case ts.SyntaxKind.Constructor:
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.FunctionDeclaration:
                return (node as ts.FunctionDeclaration).body?.statements
            case ts.SyntaxKind.CaseBlock:
                return (node as ts.CaseBlock).clauses.flatMap(c => c.statements)
            case ts.SyntaxKind.ArrowFunction:
                return ts.isBlock((node as ts.ArrowFunction).body) 
                    ? ((node as any).body as ts.Block).statements 
                    : undefined
        }
    }

    function getDeclarations(node: ts.Node): ts.Node[]  | undefined {
        const declarations: ts.Node[] = []
        const statements = getStatements(node)
        if (!statements) {
            if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                for (const e of node.members) {
                    if (isDeclaration(e)) {
                        declarations.push(e)
                    }
                }

                return declarations
            } else if (ts.isArrowFunction(node)) {
                return [...node.parameters]
            }

            return
        }

        if (ts.isFunctionLike(node)) {
            declarations.push(...node.parameters)
        }

        if (ts.isForStatement(node) || ts.isForOfStatement(node)) {
            if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
                declarations.push(...node.initializer.declarations)
            }
        }

        for (const s of statements) {
            if (isDeclaration(s)) {
                declarations.push(s)
            } else if (ts.isVariableStatement(s)) {
                declarations.push(...s.declarationList.declarations)
            }
        }

        return declarations
    }

    function addMember(target: Symbol, key: string | Symbol, value: Symbol) {
        target.members.set(key, value)
        ;(value as Mutable<Symbol>).parent = target
    }

    function createThisSymbol(scope: Scope, val: ts.Node, isStatic?: boolean) {
        const sym = createSymbol('this', val)
        ;(sym as Mutable<Symbol>).parentScope = scope

        const target = isStatic ? scope.symbol! : getPrototypeSymbol(scope.symbol!)
        for (const [k, v] of target.members) {
            const member = createSymbol(v.name, v.declaration)
            addMember(sym, k, member)
        }

        return sym
    }

    function getThisSymbol() {
        let isStatic = false
        for (let i = stack.length - 1; i >= 0; i--) {
            const scope = stack[i]
            const val = scope.symbol?.declaration
            if (val && isStaticDeclaration(val)) {
                isStatic = true
                continue
            }

            if (val === undefined || (!ts.isClassDeclaration(val) && !ts.isFunctionDeclaration(val) && !ts.isClassExpression(val) && !ts.isFunctionExpression(val))) {
                continue
            }

            if (isStatic) {
                if (scope.staticThisSymbol !== undefined) {
                    return scope.staticThisSymbol
                }

                const sym = createThisSymbol(scope, val, true)
                ;(scope as Mutable<Scope>).staticThisSymbol = sym

                return sym
            }

            if (scope.thisSymbol !== undefined) {
                return scope.thisSymbol
            }

            const sym = createThisSymbol(scope, val, false)
            ;(scope as Mutable<Scope>).thisSymbol = sym

            return sym
        }

        return createGlobalSymbol('this')
    }

    function findSymbol(name: string): Symbol | undefined {
        for (let i = stack.length - 1; i >= 0; i--) {
            const scope = stack[i].symbol?.declaration
            if (scope && (ts.isClassDeclaration(scope) || ts.isClassExpression(scope))) continue

            const symbol = stack[i].declarations.get(name)
            if (symbol !== undefined) {
                return symbol
            }
        }
    }

    function getPrototypeSymbol(sym: Symbol) {
        if (sym.members.has('prototype')) {
            return sym.members.get('prototype')!
        }

        const proto = createSymbol('prototype', undefined)
        sym.members.set('prototype', proto)
        ;(proto as Mutable<Symbol>).parent = sym

        return proto
    }

    const scopeCache = new Map<ts.Node, Scope>()

    function getScope(node: ts.Node): Scope {
        if (scopeCache.has(node)) {
            return scopeCache.get(node)!
        }

        const dependencies = new Set<Symbol>()
        const declarations = new Map<string, Symbol>()
        const parentScope = stack[stack.length - 1]

        const scope: Scope = {
            id: scopeCount++,
            node,
            declarations,
            dependencies,
            subscopes: new Set(),
            parent: parentScope,
        }

        parentScope.subscopes.add(scope)
        scopeCache.set(node, scope)

        if (!isNameableScopeNode(node)) {
            // if (node.kind === ts.SyntaxKind.IfStatement) {
            //     ;(scope as Mutable<Scope>).condition = (node as ts.IfStatement).expression
            // }

            return scope
        }

        const symbol = bindSymbol(node, scope, ts.isClassElement(node))
        ;(scope as Mutable<Scope>).symbol = symbol

        if (isDeclared(node)) {
            ;(symbol as Mutable<Symbol>).isDeclared = true
        }

        if (parentScope) {
            const parentSym = parentScope.symbol
            const parentVal = parentSym?.declaration

            if (parentVal && (ts.isClassDeclaration(parentVal) || ts.isClassExpression(parentVal))) {
                const targetSym = isStaticDeclaration(node) ? parentSym : getPrototypeSymbol(parentSym)
                addMember(targetSym, symbol.name, symbol)
            }
        }

        return scope
    }

    function bindVariableDeclaration(decl: ts.VariableDeclaration) {
        const symbols = ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)
            ? visitBindingPattern(decl.name)
            : [bindSymbol(decl)]

        for (const sym of symbols) {
            (sym as Mutable<Symbol>).variableDeclaration = decl
        }
    }

    function visitParameterDeclaration(decl: ts.ParameterDeclaration, parent: ts.Node) {
        if (ts.isParameterPropertyDeclaration(decl, parent)) {
            const classScope = stack[stack.length - 2]
            const symbol = bindSymbol(decl, classScope, true)            
            addMember(getPrototypeSymbol(classScope.symbol!), symbol.name, symbol)
        }

        if (ts.isIdentifier(decl.name)) {
            bindSymbol(decl)
        } else {
            visitBindingPattern(decl.name, true)
        }
    }

    function bindPropertyDeclaration(decl: ts.PropertyDeclaration, scope: Scope) {
        const parentSym = scope.symbol!
        const targetSym = isStaticDeclaration(decl) ? parentSym : getPrototypeSymbol(parentSym)

        if (!ts.isComputedPropertyName(decl.name)) {
            const symbol = bindSymbol(decl, scope, true)
            addMember(targetSym, symbol.name, symbol)

            return
        }

        const symbol = visitExpression(decl.name.expression)
        if (!symbol) {
            failOnNode(`No symbol found for computed property name`, decl.name)
        }

        // XXX
        // parentSym.members.set(symbol, symbol)
    }

    function visitScopeNode(node: ts.Node) {
        const scope = getScope(node)
        stack.push(scope)

        // init declarations first
        const declarations = getDeclarations(node)
        if (declarations) {
            for (const decl of declarations) {
                if (ts.isImportDeclaration(decl)) {
                    visitImportDeclaration(decl)
                } else if (ts.isVariableDeclaration(decl)) {
                    bindVariableDeclaration(decl)
                } else if (ts.isParameter(decl)) {
                    visitParameterDeclaration(decl, node)
                } else if (ts.isPropertyDeclaration(decl)) {
                    bindPropertyDeclaration(decl, scope)
                } else {
                    if (ts.isMethodDeclaration(decl)) {
                        if (ts.isComputedPropertyName(decl.name)) {
                            visitExpression(decl.name.expression)
                        }
                    }
                    const child = getScope(decl) // XXX
                }
            }
        }

        if (isFunctionLike(node)) {
            for (const param of node.parameters) {
                if (param.initializer) {
                    visit(param.initializer)
                }
            }

            // Example case for why this is needed:
            // `(a, b) => (id, ref) => b(id, ref, a)`
            if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
                visit(node.body)
            } else {
                node.body?.forEachChild(visit)
            }
        } else {
            // XXX: we add a fake scope for the heritage clause so it can be extracted more easily
            const superClass = ts.isClassLike(node) 
                ? node.heritageClauses?.find(x => x.token === ts.SyntaxKind.ExtendsKeyword)
                : undefined

            if (superClass) {
                const s = getScope(superClass)
                stack.push(s)
                superClass.types.forEach(visit)
                stack.pop()
                if ((node as ts.ClassDeclaration | ts.ClassExpression).name) {
                    visit((node as ts.ClassDeclaration | ts.ClassExpression).name!)
                }
                ;(node as ts.ClassDeclaration | ts.ClassExpression).members.forEach(visit)
                stack.pop()

                return
            }

            node.forEachChild(visit)
        }

        stack.pop()!
    }

    function isTypeNode(node: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.HeritageClause:
                return (node as ts.HeritageClause).token === ts.SyntaxKind.ImplementsKeyword
            
            case ts.SyntaxKind.Parameter:
                return (node as ts.ParameterDeclaration).name.kind === ts.SyntaxKind.Identifier &&
                    ((node as ts.ParameterDeclaration).name as ts.Identifier).text === 'this'

            case ts.SyntaxKind.VariableStatement:
            case ts.SyntaxKind.ClassDeclaration:
            case ts.SyntaxKind.ModuleDeclaration:
                return !!ts.getModifiers(node as ts.ClassDeclaration | ts.VariableStatement | ts.ModuleDeclaration)
                    ?.find(m => m.kind === ts.SyntaxKind.DeclareKeyword)

            case ts.SyntaxKind.Constructor:
            case ts.SyntaxKind.MethodDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
                return (node as ts.FunctionDeclaration | ts.MethodDeclaration | ts.ConstructorDeclaration).body === undefined

            case ts.SyntaxKind.ImportDeclaration:
                return !!(node as ts.ImportDeclaration).importClause?.isTypeOnly
            
            case ts.SyntaxKind.ImportEqualsDeclaration:
                return (node as ts.ImportEqualsDeclaration).isTypeOnly

            case ts.SyntaxKind.ExportDeclaration:
                return (node as ts.ExportDeclaration).isTypeOnly
            
            case ts.SyntaxKind.ImportSpecifier:
            case ts.SyntaxKind.ExportSpecifier:
                return (node as ts.ImportSpecifier | ts.ExportSpecifier).isTypeOnly
            
            case ts.SyntaxKind.PropertySignature:
            case ts.SyntaxKind.ConstructorType:
            case ts.SyntaxKind.MappedType:
            case ts.SyntaxKind.ConditionalType:
            case ts.SyntaxKind.TypeLiteral:
            case ts.SyntaxKind.FunctionType:
            case ts.SyntaxKind.TypeAliasDeclaration:
            case ts.SyntaxKind.InterfaceDeclaration:
            case ts.SyntaxKind.TypeQuery:
            case ts.SyntaxKind.TypeOperator:
            case ts.SyntaxKind.TypeReference:
            case ts.SyntaxKind.TypePredicate:
            case ts.SyntaxKind.TypeParameter:
                return true
        }

        return false
    }

    function visitIdentifier(node: ts.Identifier) {
        if (ts.isJsxAttribute(node.parent) && node.parent.name === node) {
            return
        }

        // BIG HACK
        // We're exploiting the fact that lowercase tags are intrinsic instead of fixing the real problem
        if ((ts.isJsxOpeningElement(node.parent) || ts.isJsxClosingElement(node.parent) || ts.isJsxSelfClosingElement(node.parent)) && node.parent.tagName === node && node.text.toLowerCase() === node.text) {
            return
        }

        const name = node.text

        for (let i = stack.length - 1; i >= 0; i--) {
            const sym = findSymbol(name)

            if (sym) {
                addReference(node, sym)

                return sym
            }
        }

        const globalSym = createGlobalSymbol(name)
        addReference(node, globalSym)

        return globalSym
    }

    function visitThisExpression(node: ts.ThisExpression) {
        const thisSymbol = getThisSymbol()

        addReference(node, thisSymbol)

        return thisSymbol
    }

    function getMemberSymbol(target: Symbol, member: string | Symbol): Symbol {
        if (target.members.has(member)) {
            return target.members.get(member)!
        }

        const name = typeof member === 'string' ? member : printSymbol(member)
        const memberSym = createSymbol(name, undefined, typeof member !== 'string')
        target.members.set(member, memberSym)

        return Object.assign(memberSym, { 
            parent: target,
            argSymbol: typeof member !== 'string' ? member : undefined
        })
    }

    function visitPropertyAccessExpression(node: ts.PropertyAccessExpression): Symbol | undefined {
        const sym = visitExpression(node.expression)
        if (!sym) {
            return
        }

        const name = node.name.text
        const memberSymbol = getMemberSymbol(sym, name)
        addReference(node, memberSymbol)

        return memberSymbol
    }

    function visitElementAccessExpression(node: ts.ElementAccessExpression): Symbol | undefined {
        const sym = visitExpression(node.expression)
        const nameSym = visitExpression(node.argumentExpression)
        if (!sym || !nameSym) {
            return sym ?? nameSym
        }

        const memberSymbol = getMemberSymbol(sym, nameSym)
        addReference(node, memberSymbol)

        return memberSymbol
    }

    function visitCallExpression(node: ts.CallExpression) {
        const target = visitExpression(node.expression)
        const args = node.arguments.map(visitExpression)

        // if (target && isSymbol(target)) {
        //     const graph = isSymbol(target)
        //         ? getGraphFromSymbol(target)
        //         : target

        //     if (graph) {
        //         graph.sideEffects.push(node)
        //     }

        //     symbols.set(node, target)
        // }

        return undefined
    }

    function visitNewExpression(node: ts.NewExpression) {
        const target = visitExpression(node.expression)
        const args = node.arguments?.map(visitExpression) ?? []

        // if (target && !isSymbolWithinCurrentGraph(target)) {
        //     const graph = isSymbol(target)
        //         ? getGraphFromSymbol(target)
        //         : target

        //     if (graph) {
        //         graph.sideEffects.push(node)
        //     }
        // }
    
        return undefined
    }

    function visitEnumMember(node: ts.EnumMember) {
        if (!ts.isIdentifier(node.name)) {
            failOnNode('Not implemented', node)
        }

        const currentScope = stack[stack.length - 1]
        const memberSymbol = createSymbol(node.name.text, node)
        currentScope.symbol!.members.set(node.name.text, Object.assign(memberSymbol, {
            parent: currentScope.symbol
        }))

        return memberSymbol
    }

    function visitBinaryExpression(node: ts.BinaryExpression) {
        const left = visitExpression(node.left)
        const right = visitExpression(node.right)

        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.EqualsToken:
            case ts.SyntaxKind.PlusEqualsToken: 
            case ts.SyntaxKind.MinusEqualsToken:
            case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
            case ts.SyntaxKind.AsteriskEqualsToken:
            case ts.SyntaxKind.SlashEqualsToken:
            case ts.SyntaxKind.PercentEqualsToken:
            case ts.SyntaxKind.AmpersandEqualsToken:
            case ts.SyntaxKind.BarEqualsToken:
            case ts.SyntaxKind.CaretEqualsToken:
            case ts.SyntaxKind.LessThanLessThanEqualsToken:
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
            case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
            case ts.SyntaxKind.BarBarEqualsToken:
            case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
            case ts.SyntaxKind.QuestionQuestionEqualsToken: {
                // const target = isSymbol(left) ? getGraphFromSymbol(left) : left
                // if (target && target !== stack[stack.length - 1]) {
                //     target.sideEffects.push(node)
                // }
            }        
        }
    
        return undefined
    }

    function maybeAddDependency(node: ts.Node, sym: Symbol) {
        const parent = node.parent
        if (isPrimaryExpressionLike(parent)) {
            return
        }

        const currentScope = stack[stack.length - 1]
        // This is a terminal node, add it to the dependency graph
        if (currentScope.symbol !== sym) {
            currentScope.dependencies.add(sym)
        }

        // Check for any computed symbols in intermediate expressions
        let currentSym: Symbol | undefined = sym
        while (currentSym !== undefined) {
            const argSymbol = currentSym.computed ? currentSym.argSymbol : undefined
            if (argSymbol) {
                if (currentScope.symbol !== argSymbol) {
                    currentScope.dependencies.add(argSymbol)
                }
            }
            currentSym = currentSym.parent
        }
    }

    // Expressions should result in a graph or symbol
    function visitExpression(node: ts.Expression): Symbol | undefined {
        if (isTypeNode(node)) {
            return
        }

        if (isScopeNode(node)) {
            return void visitScopeNode(node)
        }

        function fn(): Symbol | undefined {
            switch (node.kind) {
                case ts.SyntaxKind.Identifier:
                    return visitIdentifier(node as ts.Identifier)
                case ts.SyntaxKind.ThisKeyword:
                    return visitThisExpression(node as ts.ThisExpression)
                case ts.SyntaxKind.PropertyAccessExpression:
                    return visitPropertyAccessExpression(node as ts.PropertyAccessExpression)
                case ts.SyntaxKind.ElementAccessExpression:
                    return visitElementAccessExpression(node as ts.ElementAccessExpression)
                case ts.SyntaxKind.CallExpression:
                    return visitCallExpression(node as ts.CallExpression)
                case ts.SyntaxKind.NewExpression:
                    return visitNewExpression(node as ts.NewExpression)
                case ts.SyntaxKind.BinaryExpression:
                    return visitBinaryExpression(node as ts.BinaryExpression)
                case ts.SyntaxKind.AwaitExpression:
                case ts.SyntaxKind.ParenthesizedExpression:
                    return visitExpression((node as ts.ParenthesizedExpression).expression)
                default:
                    node.forEachChild(visit)
            }    
        }

        const symbol = fn()
        if (symbol !== undefined) {
            maybeAddDependency(node, symbol)

            return symbol
        }
    }

    function createGlobalSymbol(name: string) {        
        const currentScope = stack[stack.length - 1]
        const symbol = createSymbol(name, undefined)
        stack[0].declarations.set(name, symbol)
        currentScope.dependencies.add(symbol)
        ;(symbol as Mutable<Symbol>).parentScope = stack[0]

        return symbol
    }

    function visitImportDeclaration(node: ts.ImportDeclaration) {
        const clause = node.importClause
        if (!clause) {
            // side-effect inducing
            return
        }

        function bindWithClause(node: ts.Node) {
            const sym = bindSymbol(node)
            ;(sym as Mutable<Symbol>).importClause = clause
        }

        const bindings = clause.namedBindings
        if (bindings) {
            if (ts.isNamespaceImport(bindings)) {
                bindWithClause(bindings.name)
            } else {
                bindings.elements.forEach(e => {
                    bindWithClause(e.name)
                })
            }
        }

        if (clause.name) {
            bindWithClause(clause.name)
        }
    }

    function bindSymbol(node: ts.Node, parentScope = stack[stack.length - 1], isClassElement = false) {
        const name = getScopeName(node)
        const symbol = createSymbol(name, node)
        symbols.set(node, symbol)
        ;(symbol as Mutable<Symbol>).parentScope = parentScope
        if (!isClassElement) {
            stack[stack.length - 1].declarations.set(name, symbol)
        }

        return symbol
    }

    function visitBindingPattern(node: ts.BindingPattern, visitInitializer = false) {
        const symbols: Symbol[] = []
        for (const element of node.elements) {
            if (!ts.isBindingElement(element)) {
                continue
            }

            if (ts.isIdentifier(element.name)) {
                symbols.push(bindSymbol(element))

                if (visitInitializer && element.initializer) {
                    visitExpression(element.initializer)
                }
            } else {
                visitBindingPattern(element.name, visitInitializer)
            }
        }

        return symbols
    }

    function visitCatchClause(node: ts.CatchClause) {
        if (!node.variableDeclaration) {
            return visitScopeNode(node.block)
        }

        const scope = getScope(node.block)
        stack.push(scope)
        bindSymbol(node.variableDeclaration)
        node.block.forEachChild(visit)
        stack.pop()
    }

    function visitExportDeclaration(node: ts.ExportDeclaration) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
            return
        }

        for (const spec of node.exportClause.elements) {
            // We only want to add a symbol for the local identifier
            const localIdent = spec.propertyName ?? spec.name
            visitExpression(localIdent)
        }
    }

    function visit(node: ts.Node) {
        if (isTypeNode(node)) {
            return
        }

        if (isScopeNode(node)) {
            // XXX: this leaks the symbols into the outer scope. We're assuming that the method decl is apart of an object literal exp.
            if (node.kind === ts.SyntaxKind.MethodDeclaration && (node as any).name.kind === ts.SyntaxKind.ComputedPropertyName && node.parent.kind === ts.SyntaxKind.ObjectLiteralExpression) {
                visitExpression((node as any).name.expression)
            }

            return void visitScopeNode(node)
        }

        if (ts.isPropertyAssignment(node)) {
            if (ts.isComputedPropertyName(node.name)) {
                visitExpression(node.name.expression)
            }

            return void visit(node.initializer)
        }

        if (ts.isPropertyDeclaration(node)) {
            return node.initializer ? void visit(node.initializer) : void 0
        }

        if (ts.isExpression(node)) {
            return void visitExpression(node)
        }

        if (ts.isExpressionStatement(node)) {
            return void visitExpression(node.expression)
        }

        if (ts.isEnumMember(node)) {
            return void visitEnumMember(node)
        }

        if (ts.isCatchClause(node)) {
            return void visitCatchClause(node)
        }

        if (ts.isExportDeclaration(node)) {
            return void visitExportDeclaration(node)
        }

        if (ts.isLabeledStatement(node)) {
            return void visit(node.statement)
        }

        // Skip labels
        if (ts.isBreakOrContinueStatement(node)) {
            return
        }

        // This will be visited earlier
        if (ts.isImportDeclaration(node)) {
            return
        }

        node.forEachChild(visit)
    }

    return (s: ts.Node) => {
        stack.push({
            symbols,
            symbol: createSymbol('__global', undefined),
            declarations: new Map(),
            dependencies: new Set(),
            subscopes: new Set(),
        } as RootScope)

        visitScopeNode(s)

        return stack.pop()! as RootScope
    }
}

// What do I want to know?
// Given a function/module/class, determine:
// 1. The permissions required to execute the code
// 2. The resources required to execute the code
// 3. The symbolic dependencies

// var a, b;
// var e = {foo: 5, bar: 6, baz: ['Baz', 'Content']};
// var arr = [];
// ({baz: [arr[0], arr[3]], foo: a, bar: b} = e);
// getTerminalLogger().log(a + ',' + b + ',' + arr);	// displays: 5,6,Baz,,,Content
// [a, b] = [b, a];		// swap contents of a and b


// isSourceFileDefaultLibrary(file: SourceFile): boolean;

const refInScopeCache = new Map<string, ts.Node[]>()
export function getReferencesInScope(symbol: Symbol, scope: Scope) {
    const key = `${scope.id}:${symbol.id}`
    if (refInScopeCache.has(key)) {
        return refInScopeCache.get(key)!
    }

    const result: ts.Node[] = []

    function isInScope(node: ts.Node) {
        if (ts.findAncestor(node, n => n === scope.node)) {
            return true
        }

        return false
    }

    for (const ref of symbol.references) {
        if (isInScope(ref)) {
            result.push(ref)
        }
    }

    refInScopeCache.set(key, result)

    return result
}

/** Checks if `b` is contained by `a` */
function isSubscope(a: Scope, b: Scope) {
    let c: Scope | undefined = b

    do {
        if (a === c) return true
        c = c.parent
    } while (c !== undefined)

    return false
}

function getChildrenDeps(scope: Scope, excluded: Scope[] = []): Symbol[] {
    const deps: Symbol[] = []
    for (const v of scope.subscopes) {
        if (excluded.includes(v)) continue

        deps.push(
            ...v.dependencies,
            ...getChildrenDeps(v, excluded)
        )
    }

    return deps
}

export function getContainingScope(symbol: Symbol): Scope {
    const scope = getRootSymbol(symbol).parentScope
    if (!scope) {
        if (symbol.declaration) {
            failOnNode('Symbol is not apart of a graph', symbol.declaration)
        }

        throw new Error(`Symbol is not apart of a graph: ${symbol.name}`)
    }

    return scope
}


export function getImmediatelyCapturedSymbols(scope: Scope, excluded: Scope[] = []) {
    if (!scope.node) { // Global scope
        return []
    }

    const symbols: Symbol[] = []
    const deps = [...getChildrenDeps(scope, excluded), ...scope.dependencies]
    for (const d of deps) {
        if (!isSubscope(scope, getContainingScope(d))) {
            symbols.push(d)
        }
    }

    return symbols
}

export function isAssignmentExpression(node: ts.BinaryExpression) {
    switch (node.operatorToken.kind) {
        case ts.SyntaxKind.EqualsToken:
        case ts.SyntaxKind.PlusEqualsToken: 
        case ts.SyntaxKind.MinusEqualsToken:
        case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
        case ts.SyntaxKind.AsteriskEqualsToken:
        case ts.SyntaxKind.SlashEqualsToken:
        case ts.SyntaxKind.PercentEqualsToken:
        case ts.SyntaxKind.AmpersandEqualsToken:
        case ts.SyntaxKind.BarEqualsToken:
        case ts.SyntaxKind.CaretEqualsToken:
        case ts.SyntaxKind.LessThanLessThanEqualsToken:
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
        case ts.SyntaxKind.BarBarEqualsToken:
        case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        case ts.SyntaxKind.QuestionQuestionEqualsToken:
            return true
    }

    return false
}


// Rules:
// 1. Any symbol on the LHS of an assignment operation must be decomposed and passed by reference
//     * Mutation of variables shared between multiple functions cannot be captured without transforming it into a binding
// 2. Computed symbols can only be captured in their entirety if they are constant
// 3. References to private members result in an indivisible function. Additional bindings need to be added to make the function divisible.

// TODO: add annotations to methods so they can be captured

// Transforms a graph into a function declaration that passes in captured symbols by argument
// Function/class declarations are placed inside, and stateful declarations are made into arguments

export function liftScope(scope: Scope, capturedGlobals?: string[], excluded: Scope[] = []) {
    const capturedSymbols = new Set<Symbol>()
    const globals = new Set<Symbol>()

    const captured = getImmediatelyCapturedSymbols(scope, excluded)
    for (const c of captured) {
        const rootSym = getRootSymbol(c)
        const val = rootSym.declaration
        if (val === undefined) {
            if (capturedGlobals && capturedGlobals.includes(rootSym.name)) {
                globals.add(rootSym)
            } else {
                // outerScopes.add(rootScope)
            }
            continue
        }

        capturedSymbols.add(c)
    }

    return { 
        globals: Array.from(globals),
        captured: Array.from(capturedSymbols), 
    }
}

export function unwrapScope(scope: Scope): ts.Node | undefined {
    const decl = scope.symbol?.declaration
    if (decl && ts.isHeritageClause(decl)) {
        return decl.types[0].expression
    }

    return decl
}

export function isParameter(scope: Scope): boolean {
    const val = unwrapScope(scope)
    if (val === undefined) {
        return false
    }

    return ts.isParameter(val)
}

export function getSubscopeDfs(scope: Scope, node: ts.Node): Scope | undefined {
    for (const g of scope.subscopes.values()) {
        const n = getSubscopeDfs(g, node)
        if (n) return n
    }

    if (ts.findAncestor(node, n => n === scope.node)) {
        return scope
    }

    return
}

export function getSubscopeContaining(scope: Scope, node: ts.Node) {
    for (const g of scope.subscopes.values()) {
        if (ts.findAncestor(node, n => n === g.node)) {
            return g
        }
    }

    failOnNode('No subscope found', node)
}

export function createGraph(node: ts.Node): RootScope {
    return createDependencyGraph()(node)
}

export function createGraphOmitGlobal(node: ts.Node): Scope {
    return getSubscopeContaining(createDependencyGraph()(node), node)
}

export function printSymbol(symbol: Symbol): string {
    if (!symbol.parent) {
        return symbol.name
    }

    if (symbol.computed) {
        return `${printSymbol(symbol.parent)}[${symbol.name}]`
    }

    return `${printSymbol(symbol.parent)}.${symbol.name}`
}

export function printDependencies(scope: Scope) {
    return [...scope.dependencies].map(printSymbol).join(', ')
}

function getScopeSymbol(scope: Scope) {
    while (!scope.symbol && scope.parent) {
        scope = scope.parent
    }

    if (!scope.symbol) {
        throw new Error(`No scope found with symbol starting from scope: ${scope}`)
    }

    return scope.symbol
}

function printGraph(scope: Scope, maxDepth = Infinity, hideAmbient = false, depth = 0) {
    if (depth >= maxDepth) return

    const print = (s: string) => getLogger().log(`${'  '.repeat(depth)}${s}`)
    // const immediateDeps = [...graph.dependencies, ...getChildrenDeps(graph)]
    const deps = printDependencies(scope)
    const sym = getScopeSymbol(scope)
    const val = sym.declaration
    const isAmbient = val=== undefined

    if (isAmbient && hideAmbient && depth > 0) return

    if (!isAmbient && ts.isParameter(val)) {
        print('<Parameter> ' + sym.name + (deps ? ` [${deps}]` : ''))
    } else {
        print(sym.name + (isAmbient ? '*' : '') + (deps ? ` [${deps}]` : ''))
    }

    for (const [k, v] of scope.subscopes.entries()) {
        printGraph(v, maxDepth, hideAmbient, depth + 1)
    }
}

export function createGraphFromText(fileName: string, text: string) {
    const sourceFile = ts.createSourceFile(fileName, text, { languageVersion: ts.ScriptTarget.ES2020 }, true)
    
    return createDependencyGraph()(sourceFile)
}

export function createGraphFromFile(sourceFile: ts.SourceFile) {    
    return createDependencyGraph()(sourceFile)
}

// Kahn's algorithm
// e[0] is from
// e[1] is to
export function topoSort<T>(edges: [T, T][]) {
    const l: T[] = []
    const s = Array.from(getRootNodes(edges))

    while (s.length > 0) {
        const n = s.pop()!
        l.push(n)

        for (const m of extractEdges(n, edges)) {
            if (!edges.find(e => e[1] === m)) {
                s.push(m)
            }
        }
    }

    if (edges.length !== 0) {
        throw new Error('Cycle detected')
    }

    return l
}

function* extractEdges<T>(n: T, edges: [T, T][]) {
    for (let i = edges.length - 1; i >= 0; i--) {
        if (n === edges[i][0]) {
            yield edges.splice(i, 1)[0][1]
        }
    }
}

function* getRootNodes<T>(edges: [T, T][]) {
    const nodes = new Set<T>()
    const inc = new Set<T>()

    for (const e of edges) {
        nodes.add(e[0])
        nodes.add(e[1])
        inc.add(e[1])
    }

    for (const n of nodes) {
        if (!inc.has(n)) {
            yield n
        }
    }
}


