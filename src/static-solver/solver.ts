import ts from 'typescript'
import * as assert from 'node:assert'
import { failOnNode, getNodeLocation } from './utils'
import { getLogger } from '../logging'
import { isNode } from '../utils'

function isExported(node: ts.Node) {
    return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.find(m => m.kind === ts.SyntaxKind.ExportKeyword)
}

function isUsing(node: ts.VariableStatement) {
    return (node.declarationList.flags & ts.NodeFlags.Using) === ts.NodeFlags.Using ||
        (node.declarationList.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing
}

type SubstitutionFunction = (node: ts.Node) => any

const internalBrand = Symbol('internalFunction')
const uninitialized = Symbol('uninitialized') 
const evaluatorSymbol = Symbol('lazyEvaluator')
const typeSymbol = Symbol('type')
const unionSymbol = Symbol('union')

const unknown = String('*')

export function isInternalFunction(fn: (...args: any[]) => unknown): fn is typeof fn & { [internalBrand]: InternalFunctionData } {
    return (typeof fn === 'function' || (typeof fn === 'object' && fn !== null)) && internalBrand in fn
}

interface InternalFunctionData {
    getSource: () => string
}

export function createInternalFunction<T extends Function>(fn: T, getSource?: () => string): T {
    return ((fn as any)[internalBrand] = { getSource }, fn)
}

export function getSourceCode(fn: any) {
    if (isInternalFunction(fn)) {
        return fn[internalBrand].getSource()
    }

    return fn.toString()
}

export function isUnknown(val: any): val is typeof unknown {
    if (val === unknown) {
        return true
    }

    if (typeof val !== 'object' || val === null) {
        return false
    }

    // If the LHS is an assignment where the key is unknown, we're essentially
    // assigning to all possible keys. Likewise, if the value is unknown, we're
    // assigning all possible values. When both are unknown, we can consider
    // the destination symbol to have an unknown value.
    //
    // We only check this for objects because functions are still callable
    // despite having totally unknown properties.

    return val[unknown] === unknown
}

export function createUnknown() {
    return unknown
}

export function wrapType(type: ts.TypeNode) {
    return { [typeSymbol]: type }
}

export function createUnion<T>(values: Iterable<T> | (() => Iterable<T>)) {
    if (typeof values === 'function') {
        return { 
            [unionSymbol]: true, 
            [Symbol.iterator]: values,
        }

    }

    return { [unionSymbol]: true, [Symbol.iterator]: values[Symbol.iterator].bind(values) }
}

// Simple test case

// let yielded = 0
// function* foo() {
//     for (let i = 0; i < 5; i++) {
//         yield i
//         yielded += 1
//     }
// }

// const cached = createCachedUnion(foo)

// const pairs: [number, number][] = []
// for (const i of cached) {
//     for (const j of cached) {
//         pairs.push([i, j])
//     }
// }

// const expected: typeof pairs = []
// for (let i = 0; i < 5; i++) {
//     for (let j = 0; j < 5; j++) {
//         expected.push([i, j])
//     }
// }
//
// expectEqual(yielded, 5)
// expectEqual(pairs.length, 25)
// expectEqual(pairs, expected)

function createCachedUnion<T>(values: () => Iterable<T>) {
    const cached: T[] = []
    let iter: Iterable<T>

    function* gen() {
        if (!iter) {
            iter = values()
        }

        yield* cached
        for (const v of iter) {
            cached.push(v)
            const len = cached.length
            yield v

            // Play catch-up
            if (cached.length !== len) {
                for (let i = len; i < cached.length; i++) {
                    yield cached[i]
                }
            }
        }
    }

    return { [unionSymbol]: true, [Symbol.iterator]: gen }
}

type Union = ({ [unionSymbol]: true; source?: Iterable<any> } & Iterable<any>)
export function isUnion(val: unknown): val is Union {
    return typeof val === 'object' && !!val && unionSymbol in val
}

function lazy<T extends any[], U>(fn: (...args: T) => U): ((...args: T) => U) & { [evaluatorSymbol]: any } {
    return ((fn as any)[evaluatorSymbol] = true, fn as any)
}

function isLazy(val: any): val is ((...args: any[]) => any) & { [evaluatorSymbol]: any } {
    return !!val && typeof val === 'function' && evaluatorSymbol in val
}

export function evaluate(val: any): any {
    if (!!val) {
        if (typeof val === 'function' && evaluatorSymbol in val) {
            return evaluate(val())
        } else if (isUnion(val)) {
            const mapped = Array.from(dedupeUnknown(val)).map(evaluate)
            if (mapped.length === 1) {
                return mapped[0]
            }

            if (mapped.length === 0) {
                return createUnknown()
            }

            return createUnion(mapped)
        }
    }

    return val
}

function* dedupeUnknown(union: Union) {
    let didYieldUnknown = false
    for (const val of union) {
        if (isUnknown(val)) {
            if (didYieldUnknown) {
                continue
            }
            didYieldUnknown = true
        }
        yield val
    }
}

class _Array extends Array {
    join(sep: any) {
        if (this.some(x => isUnknown(x) || x === uninitialized)) {
            return createUnknown() as any
        }

        return super.join(sep)
    }

    splice(start: number, deleteCount?: number, items?: any[]) {
        if (isUnknown(start) || isUnknown(deleteCount)) {
            return [createUnknown()] as any[]
        }

        return !items ? super.splice(start, deleteCount) : super.splice(start, deleteCount!, items)
    }
}

export function createStaticSolver(
    substitute?: SubstitutionFunction
) {    
    // XXX: only used to check for recursion
    const callStack: [node: ts.Node, args: any[]][] = []

    function createSolver(
        state = new Map<string, any>(),
        context?: SubstitutionFunction,
        isConditionalExecution?: boolean
    ): { solve: (node: ts.Node) => any, getState: () => Map<string, any>, printState: () => void } {
        function getExports() {
            const val = state.get('exports')
            if (val !== undefined) {
                return val
            }

            const newVal = {}
            state.set('exports', newVal)

            return newVal
        }

        function printState(s = state) {
            for (const [k, v] of s.entries()) {
                if (isLazy(v)) {
                    getLogger().log(`${k}: [lazy]`)
                } else {
                    const val = typeof v === 'object' ? JSON.stringify(v) : typeof v === 'symbol' ? `[${v.description}]` : v
                    getLogger().log(`${k}: ${val}`)
                }
            }
        }   

        function getSubstitute(node: ts.Node): any {
            return evaluate(fn())

            function fn() {
                if (ts.isIdentifier(node)) {
                    if (state.has(node.text)) {
                        return state.get(node.text)
                    }
                } else if (node.kind === ts.SyntaxKind.ThisKeyword && state.has('this')) {
                    return state.get('this')
                }
    
                if (context) {
                    const sub = context(node)
                    if (sub === node) {
                        failOnNode(`Found recursive call`, node)
                    }
    
                    return isNode(sub) ? solve(sub) : sub
                }
    
                return unknown
            }
        }
    
        function solvePropertyName(node: ts.PropertyName) {
            if (ts.isComputedPropertyName(node)) {
                const solved = solve(node.expression)
    
                // XXX
                return typeof solved === 'string' ? solved : undefined
            }
    
            return node.text
        }

        function solveMemberName(node: ts.MemberName) {
            return node.text
        }

        function solveObjectLiteral(node: ts.ObjectLiteralExpression) {
            const result: Record<string, any> = {}
            for (const v of node.properties) {
                if (ts.isSpreadAssignment(v)) {
                    const val = solve(v.expression)
                    if (isUnknown(val)) {
                        return val
                    }

                    if (isUnion(val)) {
                        return unknown
                    }

                    if (val !== uninitialized) {
                        if (typeof val !== 'object' && typeof val !== 'undefined') {
                            // TODO: need to do CFA in the containing declaration to determine
                            // if this is a compiler bug or a user bug. The value might not be an
                            // object if the spread expression is guarded by a `typeof` check
                            // failOnNode(`Expected an object, got type "${typeof val}"`, node)
                            return unknown
                        } else {
                            Object.assign(result, val)
                        }
                    }
                } else {
                    if (ts.isMethodDeclaration(v) || ts.isAccessor(v)) {
                        throw new Error('method/accessor decl not supported')
                    }
                    if (ts.isShorthandPropertyAssignment(v)) {
                        result[v.name.text] = solve(v.name)
                    } else {
                        if (ts.isComputedPropertyName(v.name)) {
                            const val = solve(v.name.expression)
                            result[val] = solve(v.initializer)
                        } else {
                            result[v.name.text] = solve(v.initializer)
                        }
                    }
                }
            }
    
            return result
        }
        
        function solveIdentifier(node: ts.Identifier): any {
            if (node.text === 'undefined') {
                return undefined
            }

            return getSubstitute(node)
        }
    
        function solveThisKeyword(node: ts.Node): any {
            return getSubstitute(node)
        }
    
        function access(target: any, arg: any, questionDotToken = false): any {
            if (isUnknown(target)) {
                return unknown
            }

            if (isUnion(target)) {
                return createUnion(function* () {
                    for (const t of target) {
                        yield access(t, arg, questionDotToken)
                    }
                })
            }

            if (isUnion(arg)) {
                return createUnion(function* () {
                    for (const key of arg) {
                        yield access(target, key, questionDotToken)
                    }
                })
            }

            if (isUnknown(arg)) {
                if (isLazy(target)) {
                    return lazy(() => createUnion(Object.values(target())))
                } else {
                    return target ? createUnion(Object.values(target)) : undefined
                }
            }

            // FIXME: how to make sure we don't evaluate blocks before var init (TDZ?)
            return target?.[arg]

            if (questionDotToken) {
                return target?.[arg]
            } else {
                return target[arg]
            }
        }

        function solvePropertyAccess(node: ts.PropertyAccessExpression): any {
            assert.ok(!ts.isPrivateIdentifier(node.name))
            const target = solve(node.expression)

            return access(target, node.name.text, !!node.questionDotToken)
        }  

        function solveElementAccessExpression(node: ts.ElementAccessExpression): any {
            const target = solve(node.expression)
            const arg = solve(node.argumentExpression)

            return access(target, arg, !!node.questionDotToken)
        }  
    
        function getThisArg(exp: ts.CallExpression): any {
            // TODO: handle `(x.foo)()`
            if (ts.isPropertyAccessExpression(exp.expression) || ts.isElementAccessExpression(exp.expression)) {
                return solve(exp.expression.expression)
            }
        }

        // TODO: merge w/ InterfaceDeclaration
        function solveClassDeclarationOrExpression(node: ts.ClassDeclaration | ts.ClassExpression): any {
            // TODO: static members
            const ctor = node.members.find(ts.isConstructorDeclaration)
            const fields = node.members.filter(ts.isPropertyDeclaration)
            const methods = node.members.filter(ts.isMethodDeclaration)
            const heritage = node.heritageClauses?.filter(x => x.token === ts.SyntaxKind.ExtendsKeyword).map(x => x.types[0].expression)[0]
            const proto: any = {}
    
            const c = createInternalFunction(function (this: any, ...args: any[]) {
                let thisArg = this
                thisArg ??= {}

                if (heritage) {
                    const fn = solve(heritage)
                    if (typeof fn === 'function') {
                        thisArg = fn.call(thisArg, ...args) ?? thisArg
                    } else {
                        if (fn !== unknown) {
                            failOnNode(`Super class was not a function`, heritage)
                        }
                    }
                }

                //thisArg.constructor = c

                // methods...
                for (const [k, v] of Object.entries(proto)) {
                    thisArg[k] = v
                }

                for (const f of fields) {
                    // These don't have the correct scope?
                    const name = solvePropertyName(f.name)
                    if (name !== undefined) {
                        thisArg[name] = f.initializer ? solve(f.initializer) : undefined
                    }
                }

                if (ctor != undefined) {
                    const fn = solve(ctor)
                    if (typeof fn === 'function') {
                        thisArg = fn.call(thisArg, ...args) ?? thisArg
                    } else {
                        if (fn !== unknown) {
                            failOnNode(`Constructor was not a function`, ctor)
                        }
                    }
                }

                return thisArg
            }, () => node.getText(node.getSourceFile()))

            for (const m of methods) {
                if (m.modifiers?.find(x => x.kind === ts.SyntaxKind.StaticKeyword)) {
                    // TODO: handle static
                } else {
                    const name = solvePropertyName(m.name)
                    if (name !== undefined) {
                        if (typeof name !== 'string') {
                            failOnNode(`Name is not a string`, m)
                        }
                        proto[name] = solveFunctionLikeDeclaration(m)
                    }
                }
            }

            if (node.name) {
                Object.defineProperty(c, 'name', {
                    value: node.name.text,
                    configurable: true,
                })
            }
            
            c.prototype = proto

            return c
        }
    
        function solveArguments(nodes: ts.Expression[] | ts.NodeArray<ts.Expression> = []) {
            const results: any[] = []
            for (const n of nodes) {
                if (ts.isSpreadElement(n)) {
                    const val = solve(n.expression)
                    if (isUnknown(val)) {
                        results.push(unknown)
                    } else if (val) {
                        results.push(...val)
                    }
                } else {
                    results.push(solve(n))
                }
            }

            return results
        }

        // XXX: only used for recursion
        function callWithStack(...args: Parameters<typeof call>): any {
            if (callStack.length > 50) {
                return createUnknown()
            }

            const isRecursive = !!callStack.find(f => f[0] === args[0] && f[1].map((e, i) => e === args[3][i]).reduce((a, b) => a && b, true))
            if (isRecursive) {
                return createUnknown()
            }

            callStack.push([args[0], args[3]])
            const res = call(...args)
            callStack.pop()

            return res
        }

        function call(source: ts.Node, fn: any, thisArg: any, args: any[]): any {
            if (isUnion(fn)) {
                return createCachedUnion(function* () {
                    for (const f of fn) {
                        if (isUnknown(f)) {
                            yield f
                            // failOnNode('Found unknown symbol in union', source)
                        } else {
                            yield callWithStack(source, f, thisArg, args)
                        }
                    }
                })
            }

            if (isUnion(thisArg)) {
                return createCachedUnion(function* () {
                    for (const t of thisArg) {
                        if (isUnknown(t)) {
                            yield t
                        } else {
                            yield callWithStack(source, fn, t, args)
                        }
                    }
                }) 
            }

            if (typeof fn !== 'function') {
                // This is mostly to handle `.then` or `.catch`
                // Whether or not a function truly returns a Promise is not always statically known
                if (!fn) {
                    return createUnknown()
                }

                failOnNode(`Not a function (type: ${typeof fn}): ${fn}`, source)
            }

            if (ts.isNewExpression(source)) {
                return Reflect.construct(fn, args) // TODO: `new.target`
            } else {
                return fn.call(thisArg, ...args)
            }
        }

        function solveCallExpression(node: ts.CallExpression) {
            const args = solveArguments(node.arguments)
            const thisArg = getThisArg(node)
            const fn = solve(node.expression)
            if (isUnknown(fn) || isUnknown(thisArg) || !fn) {
                return unknown
            }

            return callWithStack(node, fn, thisArg, args)
        }

        function solveNewExpression(node: ts.NewExpression) {
            const args = solveArguments(node.arguments)
            const fn = solve(node.expression)
            if (isUnknown(fn)) {
                return unknown
            }

            return callWithStack(node, fn, {}, args)
        }

        function solveSuperExpression(node: ts.SuperExpression) {
            return unknown
        }

        function solveBindingName(node: ts.BindingName) {
            if (ts.isIdentifier(node)) {
                return node.text
            } else {
                failOnNode('Not implemented', node)
            }
        }

        const usingStateKey = '__usingState__'
        function getUsingState() {
            if (!state.has(usingStateKey)) {
                state.set(usingStateKey, [])
            }

            return state.get(usingStateKey)! as any[]
        }

        function solveUsingState() {
            if (!state.has(usingStateKey)) {
                return
            }

            for (const r of getUsingState().map(evaluate)) {
                if (isUnknown(r)) continue

                if (Symbol.dispose in r) {
                    r[Symbol.dispose]()
                } else if (Symbol.asyncDispose in r) {
                    r[Symbol.asyncDispose]()
                } else {
                    throw new Error(`Missing dispose method in resource`)
                }
            }
        }

        function setLazyState(name: string, isExported: boolean, fn: () => any) {
            const result = lazy(() => {
                const val = fn()
                state.set(name, val)
                if (isExported) {
                    getExports()[name] = val
                }
                return val
            })
            state.set(name, result)
            if (isExported) {
                getExports()[name] = result
            }
            
            return result
        }

        function solveExpressionStatement(node: ts.ExpressionStatement) {
            const exp = node.expression
            if (ts.isBinaryExpression(exp) && (exp.operatorToken.kind === ts.SyntaxKind.EqualsToken || exp.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
                const left = exp.left
                const right = exp.right

                if (ts.isPropertyAccessExpression(left)) {
                    const target = solve(left.expression)
                    if (isUnknown(target) || isUnion(target) || target === undefined) {
                        return
                    }
                    if (typeof target !== 'object' && typeof target !== 'function') {
                        failOnNode(`Not an object: ${target}`, node)
                    }
                    const memberName = solveMemberName(left.name)
                    if (typeof memberName !== 'string') {
                        failOnNode(`Not a string: ${memberName}`, node)
                    }

                    if (isConditionalExecution) {
                        if (exp.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
                            if (target[memberName] !== null && target[memberName] !== undefined) {
                                return
                            }
                        }

                        if (!isUnion(target[memberName])) {
                            target[memberName] = createUnion([solve(right)])
                        } else {
                            target[memberName] = createUnion([...target[memberName], solve(right)])
                        }

                        return
                    }

                    if (exp.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
                        target[memberName] ??= solve(right)
                    } else {
                        target[memberName] = solve(right)
                    }
                } else if (ts.isIdentifier(left)) {
                    // if (!state.has(left.text)) {
                    //     const val = solve(left)
                    //     if (val === undefined) {
                    //         failOnNode(`Identifier "${left.text}" has not been declared`, node)
                    //     }
                    // }
                    // FIXME: this only sets the scoped state?
                    if (exp.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
                        state.set(left.text, evaluate(state.get(left.text)) ?? solve(right))
                    } else {
                        state.set(left.text, solve(right))
                    }
                } else if (ts.isObjectBindingPattern(left)) {
                    const rightVal = solve(right)
                    for (const element of left.elements) {
                        const localName = solveBindingName(element.name)
                        const targetName = element.propertyName ? solvePropertyName(element.propertyName) : localName
                        if (!targetName) {
                            failOnNode('No target name', left)
                        }

                        if (isUnknown(rightVal)) {
                            state.set(localName, unknown)
                        } else {
                            const val = rightVal?.[targetName] ?? (element.initializer ? solve(element.initializer) : unknown)
                            state.set(localName, val)
                        }
                    }
                } else if (ts.isElementAccessExpression(left)) {
                    const target = solve(left.expression)
                    const arg = solve(left.argumentExpression)

                    if (isUnknown(target) || isUnion(target) || target === undefined) {
                        return
                    }

                    if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
                        failOnNode(`Not an object: ${target}`, node)
                    }

                    if (exp.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
                        target[arg] ??= solve(right)
                    } else {
                        target[arg] = solve(right)
                    }
                }
            } else {
                // XXX: used to dump logs
                if (ts.isCallExpression(exp) && ts.isPropertyAccessExpression(exp.expression) && ts.isIdentifier(exp.expression.expression) && exp.expression.expression.text === 'console') {
                    evaluate(solve(exp))
                } else {
                    setLazyState(`__expression:${node.pos}`, false, () => solve(exp))
                }
            }
        }

        function getProp(val: any, prop: string | number) {
            if (isUnknown(val)) {
                return val
            }

            if (val === undefined) {
                return unknown
            }

            return val[prop]
        }

        function solveBindingPattern(node: ts.BindingPattern, lazyGet: () => any, isExported: boolean) {
            for (let i = 0; i < node.elements.length; i++) {
                const element = node.elements[i]
                if (ts.isBindingElement(element)) {
                    if (ts.isIdentifier(element.name)) {
                        const name = element.name.text
                        setLazyState(name, isExported, () => getProp(lazyGet(), name))
                    } else {
                        solveBindingPattern(element.name, () => getProp(lazyGet(), i), isExported)
                    }
                }
            }
        }

        function solveStatement(node: ts.Statement) {
            if (ts.isClassDeclaration(node)) {
                if (!node.name) {
                    failOnNode('No name', node)
                }
                setLazyState(node.name.text, isExported(node), () => solve(node))
            } else if (ts.isFunctionDeclaration(node)) {
                if (!node.name) {
                    failOnNode('No name', node)
                }
                setLazyState(node.name.text, isExported(node), () => solve(node))
            } else if (ts.isVariableStatement(node)) {
                const solver = createSolver(undefined, getSubstitute)

                // XXX: only handles 1 decl
                let init: any
                const decl = node.declarationList.declarations[0]
                const getVal = () => init ??= solver.solve(decl.initializer!)
                if (ts.isIdentifier(decl.name)) {
                    if (decl.initializer) {
                        setLazyState(decl.name.text, isExported(node), getVal)
                    } else {
                        state.set(decl.name.text, uninitialized)
                    }
                } else {
                    solveBindingPattern(decl.name, getVal, isExported(node))
                }

                if (isUsing(node)) {
                    getUsingState().push(lazy(getVal))
                } 
            } else if (ts.isExpressionStatement(node)) {
                solveExpressionStatement(node)
            } else if (ts.isReturnStatement(node)) {
                const ret = node.expression ? solve(node.expression) : undefined

                return evaluate(ret)
            } else if (ts.isImportDeclaration(node)) {
                const res = solve(node)
                if (res !== undefined) {
                    for (const [k, v] of Object.entries(res)) {
                        // FIXME: this doesn't reset the lazy eval
                        state.set(k, v)
                    }
                }
            } else if (ts.isExportDeclaration(node)) {
                const res = solveExportDeclaration(node)
                if (res !== undefined) {
                    const exports = getExports()
                    for (const [k, v] of Object.entries(res)) {
                        exports[k] = v
                    }
                }
            } else if (ts.isIfStatement(node)) {
                // BUG: we need to differentiate user-space `undefined` from our own
                const res = solveIfStatement(node)
                if (res !== undefined) {
                    return res
                }
            } else if (ts.isForOfStatement(node)) {
                solveForOfStatement(node)
            } else if (ts.isForStatement(node)) {
                solveForStatement(node)
            } else if (ts.isWhileStatement(node)) {
                // BUG: we need to differentiate user-space `undefined` from our own
                const res = solveWhileStatement(node)
                if (res !== undefined) {
                    return res
                }
            } else if (ts.isTryStatement(node)) {
                const res = solveTryStatement(node)
                if (res !== undefined) {
                    return res
                }
            } else if (ts.isSwitchStatement(node)) {
                solveSwitchStatement(node)
            }
        }

        function solveBlock(node: ts.Block) {
            try {
                for (const statement of node.statements) {
                    const val = solveStatement(statement)
                    if (val !== undefined) {
                        return val
                    }
                }
            } finally {
                solveUsingState()
            }
        }

        type FunctionLikeDeclaration = ts.ConstructorDeclaration | ts.FunctionDeclaration | ts.MethodDeclaration
        type FunctionLikeExpression = ts.ArrowFunction | ts.FunctionExpression
        function solveFunctionLikeDeclaration(target: FunctionLikeDeclaration | FunctionLikeExpression) {
            if (!target.body) {
                return function () {
                    if (target.type) {
                        return wrapType(target.type)
                    }

                    return unknown
                }
            }

            const isGenerator = !!target.asteriskToken

            return createInternalFunction(function (this: any, ...args: any[]) {
                const scopedState = new Map<string, any>()
                scopedState.set('this', this)
                if (isGenerator) {
                    scopedState.set('__generatorState__', [])
                }

                function resolveParam(p: ts.ParameterDeclaration, i: number) {
                    if (p.dotDotDotToken) {
                        return args.slice(i)
                    }

                    const init = p.initializer ? solve(p.initializer) : createUnknown()

                    return i >= args.length ? init : args[i]
                }

                target.parameters.forEach((p, i) => {
                    const resolved = resolveParam(p, i)
                    // getTerminalLogger().log(getNodeLocation(target), actualArgs)

                    if (!ts.isIdentifier(p.name)) {
                        for (const element of p.name.elements) {
                            if (ts.isBindingElement(element)) {
                                if (!ts.isIdentifier(element.name)) {
                                    failOnNode(`Not an identifier: ${p.name.kind}`, element.name)
                                }
                                if (isUnknown(resolved)) {
                                    scopedState.set(element.name.text, createUnknown())
                                } else {
                                    scopedState.set(element.name.text, resolved[element.name.text])
                                }
                            } else {
                                failOnNode(`Not an identifier: ${p.name.kind}`, element)
                            }
                        }
                    } else {
                        scopedState.set(p.name.text, resolved)
                    }
                })

                const solver = createSolver(scopedState, getSubstitute)
                const result = solver.solve(target.body!)

                // XXX: eval the entire body even if we don't reference anything directly
                //
                // We often want the side effects produced by a function call for the purpose
                // of permissions analysis. The alternative is to return side-effect producing
                // expressions apart of the call convention
                for (const [k, v] of scopedState.entries()) {
                    evaluate(v)
                }

                if (isGenerator) {
                    return scopedState.get('__generatorState__')
                }

                return result
            }, () => target.getText(target.getSourceFile()))
        }

        function solveImportDeclaration(node: ts.ImportDeclaration) {
        }

        function solveExportDeclaration(node: ts.ExportDeclaration) {
        }

        function solveRegularExpressionLiteral(node: ts.RegularExpressionLiteral) {
            return node.text
        }

        function solveTemplateExpression(node: ts.TemplateExpression) {
            const parts: any[] = []
            parts.push(node.head.text)

            for (const span of node.templateSpans) {
                const exp = solve(span.expression)
                if (isUnknown(exp)) {
                    return unknown
                }

                parts.push(exp)
                parts.push(span.literal.text)
            }

            function substituteUnion(parts: any[]): any {
                const unionIdx = parts.findIndex(isUnion)
                if (unionIdx === -1) {
                    return parts.map(String).join('')
                }

                const head = parts.slice(0, unionIdx)

                return createUnion(function* () {
                    for (const part of parts[unionIdx]) {
                        if (isUnknown(part)) {
                            yield part
                        } else {
                            yield substituteUnion([...head, part, ...parts.slice(unionIdx + 1)])
                        }
                    }
                })
            }

            return substituteUnion(parts)
        }


        function solveBinaryExpression(node: ts.BinaryExpression) {
            const left = solve(node.left)
            const right = solve(node.right)

            if (isUnknown(left) || isUnknown(right)) {
                return unknown
            }

            // TODO: this only happens from `try/catch` atm
            if (left === uninitialized || right === uninitialized) {
                return unknown
            }

            switch (node.operatorToken.kind) {
                case ts.SyntaxKind.BarBarToken:
                    return left || right
                case ts.SyntaxKind.PlusToken:
                    return left + right
                case ts.SyntaxKind.LessThanToken:
                    return left < right
                case ts.SyntaxKind.QuestionQuestionToken:
                    return left ?? right
            }

            return unknown
        }

        function solveScopedState(target: ts.Node) {
            const scopedState = new Map<string, any>()
            const solver = createSolver(scopedState, getSubstitute)
            solver.solve(target)
            // XXX: eval the entire body even if we don't reference anything directly
            for (const [k, v] of scopedState.entries()) {
                evaluate(v)
            }
        }

        // CONTROL FLOW
        function solveIfStatement(node: ts.IfStatement) {
            const cond = solve(node.expression)

            solveScopedState(node.thenStatement)
            if (node.elseStatement) {
                solveScopedState(node.elseStatement)
            }
        }

        function solveSwitchStatement(node: ts.SwitchStatement) {
            const exp = solve(node.expression)
            for (const clause of node.caseBlock.clauses) {
                const ret = solveCaseOrDefaultClause(clause, exp)
                if (ret !== undefined) {
                    return ret
                }
            }
        }

        function isSubset(a: any, b: any) {
            if (isUnknown(b)) {
                return true
            }

            if (isUnion(a)) {
                if (!isUnion(b)) {
                    return false
                }

                const s = new Set(b)
                for (const v of a) {
                    if (!s.has(v)) {
                        return false
                    }
                }

                return true
            }

            if (!isUnion(b)) {
                return a === b
            }

            for (const v of b) {
                if (a === v) {
                    return true
                }
            }

            return false
        }

        function solveCaseOrDefaultClause(node: ts.CaseOrDefaultClause, exp: any) {
            const val = ts.isCaseClause(node) ? solve(node.expression) : uninitialized
            // TODO: only execute the block if `val` is a subset of `exp`
            // We need to be careful with this due to lazy evaluation

            const scopedState = new Map<string, any>()
            const solver = createSolver(scopedState, getSubstitute, true)

            for (const statement of node.statements) {
                solver.solve(statement)
            }

            // XXX: eval the entire body even if we don't reference anything directly
            for (const [k, v] of scopedState.entries()) {
                evaluate(v)
            }
        }

        function solveConditionalExpression(node: ts.ConditionalExpression) {
            const cond = solve(node.condition)
            const whenTrue = solve(node.whenTrue)
            const whenFalse = solve(node.whenFalse)

            if (isUnknown(cond) || isUnion(cond)) {
                return unknown
            }

            return cond ? whenTrue : whenFalse
        }

        function solvePrefixUnaryExpression(node: ts.PrefixUnaryExpression) {
            const val = solve(node.operand)
            if (isUnknown(val)) {
                return unknown
            }

            switch (node.operator) {
                case ts.SyntaxKind.PlusToken:
                    return +val
                case ts.SyntaxKind.MinusToken:
                    return -val
                case ts.SyntaxKind.ExclamationToken:
                    return !val
            }

            failOnNode(`Not implemented: ${node.operator}`, node)
        }

        function solveArrayLiteralExpression(node: ts.ArrayLiteralExpression) {
            const result: any[] = []
            for (const e of node.elements) {
                if (ts.isSpreadElement(e)) {
                    const val = solve(e.expression)
                    if (isUnknown(val)) {
                        return unknown
                    } else {
                        if (isUnion(val)) {
                            // XXX: NOT CORRECT, this should return a union
                            for (const x of val) {
                                if (x && !isUnknown(x)) {
                                    result.push(...x)
                                } else {
                                    result.push(x)
                                }
                            }
                        } else if (val) {
                            result.push(...val)
                        }
                    }
                } else {
                    const val = solve(e)
                    if (isUnion(val)) {
                        // XXX: not correct, we should be returning a union
                        result.push(...val)
                    } else {
                        result.push(val)
                    }
                }
            }

            return Object.setPrototypeOf(result, _Array.prototype)
        }

        function solveTypeofExpression(node: ts.TypeOfExpression) {
            const val = solve(node.expression)
            if (isUnknown(val)) {
                return val
            }

            return typeof val
        }

        // ERROR HANDLING
        function solveTryStatement(node: ts.TryStatement) {
            solveScopedState(node.tryBlock)
            if (node.catchClause) {
                // TODO: solve variable decl
                solveScopedState(node.catchClause.block)
            }
            if (node.finallyBlock) {
                solveScopedState(node.finallyBlock)
            }
        }

        // CONTROL FLOW
        function solveWhileStatement(node: ts.WhileStatement) {
            const scopedState = new Map<string, any>()
            const solver = createSolver(scopedState, getSubstitute)
            solver.solve(node.statement)

            // TODO: we could simulate evaluation of the loop with iteration and/or time bounds

            // XXX: eval the entire body even if we don't reference anything directly
            for (const [k, v] of scopedState.entries()) {
                evaluate(v)
            }
        }

        // CONTROL FLOW
        function solveForOfStatement(node: ts.ForOfStatement) {
            if (!ts.isVariableDeclarationList(node.initializer)) {
                // TODO
                return unknown
            }

            const val = solve(node.expression)
            const decl = node.initializer.declarations[0]
            
            if (ts.isIdentifier(decl.name)) {
                // TODO: this needs to convert iterables to unions, not just arrays
                const mapped = isUnion(val) ? createUnion(function* () {
                    for (const v of val) {
                        if (Array.isArray(v)) {
                            yield createUnion(v)
                        } else {
                            yield v
                        }
                    }
                }) : Array.isArray(val) ? createUnion(val) : val

                const scopedState = new Map<string, any>()
                scopedState.set(decl.name.text, mapped)

                const solver = createSolver(scopedState, getSubstitute)
                solver.solve(node.statement)

                // XXX: eval the entire body even if we don't reference anything directly
                for (const [k, v] of scopedState.entries()) {
                    evaluate(v)
                }
            }

            if (ts.isArrayBindingPattern(decl.name)) {
                const scopedState = new Map<string, any>()
                for (let i = 0; i < decl.name.elements.length; i++) {
                    const n = decl.name.elements[i]
                    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
                        if (isUnknown(val)) {
                            scopedState.set(n.name.text, unknown)
                        } else {
                            scopedState.set(n.name.text, createUnion(function* () {
                                for (const x of val) {
                                    if (isUnknown(x)) {
                                        yield x
                                    } else {
                                        yield x[i]
                                    }
                                }
                            }))
                        }
                    }
                }

                const solver = createSolver(scopedState, getSubstitute)
                solver.solve(node.statement)

                // XXX: eval the entire body even if we don't reference anything directly
                for (const [k, v] of scopedState.entries()) {
                    evaluate(v)
                }
            }

            return unknown // TODO
        }

        function solveForStatement(node: ts.ForStatement) {
            if (!node.initializer || !ts.isVariableDeclarationList(node.initializer)) {
                // TODO
                return unknown
            }
            const decl = node.initializer.declarations[0]
            if (ts.isIdentifier(decl.name) && decl.initializer) {
                const scopedState = new Map<string, any>()
                scopedState.set(decl.name.text, solve(decl.initializer))
                // getTerminalLogger().log('iterator', decl.name.text)
                const solver = createSolver(scopedState, getSubstitute)
                solver.solve(node.statement)

                // XXX: eval the entire body even if we don't reference anything directly
                for (const [k, v] of scopedState.entries()) {
                    evaluate(v)
                }
            }

            return unknown // TODO
        }

        function solveDeleteExpression(node: ts.DeleteExpression) {
            if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
                const target = solve(node.expression.expression)
                if (isUnknown(target)) {
                    return unknown
                }

                if (ts.isPropertyAccessExpression(node.expression)) {
                    delete target[node.expression.name.text]
                } else {
                    const key = solve(node.expression.argumentExpression)
                    if (isUnknown(key)) {
                        return unknown
                    }
                    delete target[key]
                }
            }

            return unknown
        }

        function solveYieldExpression(node: ts.YieldExpression) {
            if (node.expression) {
                const val = solve(node.expression)
                const genState = state.get('__generatorState__') // XXX
                if (genState) {
                    genState.push(val)
                }
            }
        }

        function solveSourceFile(node: ts.SourceFile) {
            for (const statement of node.statements) {
                solveStatement(statement)
            }
        }

        // TODO: VoidExpression
        function solve(node: ts.Node): any {
            try {
                const val = ts.isImportDeclaration(node)
                    ? fn()
                    : substitute?.(node) ?? fn()

                return val
            } catch (e) {
                failOnNode(((e as any).message + '\n' + (e as any).stack?.split('\n').slice(1).join('\n')).slice(0, 2048), node)
            }

            function fn () {
                if (node.kind === ts.SyntaxKind.NullKeyword) {
                    return null
                } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
                    return true
                } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
                    return false
                } else if (ts.isVoidExpression(node)) {
                    return (solve(node.expression), undefined) // FIXME: use symbol for `undefined`
                } else if (node.kind === ts.SyntaxKind.SuperKeyword) {
                    return solveSuperExpression(node as ts.SuperExpression)
                } else if (ts.isStringLiteral(node)) {
                    return node.text
                } else if (ts.isNumericLiteral(node)) {
                    return Number(node.text)
                } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
                    return node.text
                } else if (ts.isArrayLiteralExpression(node)) {
                    return solveArrayLiteralExpression(node)
                } else if (ts.isAwaitExpression(node)) {
                    return solve(node.expression)
                } else if (ts.isAsExpression(node)) {
                    return solve(node.expression)
                } else if (ts.isSatisfiesExpression(node)) {
                    return solve(node.expression)
                } else if (ts.isNonNullExpression(node)) {
                    return solve(node.expression)
                } else if (ts.isParenthesizedExpression(node)) {
                    return solve(node.expression)
                } else if (ts.isYieldExpression(node)) {
                    return solveYieldExpression(node)
                } else if (ts.isDeleteExpression(node)) {
                    return solveDeleteExpression(node)
                } else if (ts.isTypeOfExpression(node)) {
                    return solveTypeofExpression(node)
                } else if (ts.isPrefixUnaryExpression(node)) {
                    return solvePrefixUnaryExpression(node)
                } else if (ts.isRegularExpressionLiteral(node)) {
                    return solveRegularExpressionLiteral(node)
                } else if (ts.isTemplateExpression(node)) {
                    return solveTemplateExpression(node)
                } else if (ts.isImportDeclaration(node)) {
                    return solveImportDeclaration(node)
                } else if (ts.isTaggedTemplateExpression(node)) {
                    return unknown // XXX
                } else if (ts.isObjectLiteralExpression(node)) {
                    return solveObjectLiteral(node)
                } else if (ts.isIdentifier(node)) {
                    return solveIdentifier(node)
                } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
                    return solveThisKeyword(node)
                } else if (ts.isBinaryExpression(node)) {
                    return solveBinaryExpression(node)
                } else if (ts.isPropertyAccessExpression(node)) {
                    return solvePropertyAccess(node)
                } else if (ts.isElementAccessExpression(node)) {
                    return solveElementAccessExpression(node)
                } else if (ts.isClassDeclaration(node)) {
                    return solveClassDeclarationOrExpression(node)
                } else if (ts.isClassExpression(node)) {
                    return solveClassDeclarationOrExpression(node)
                } else if (ts.isCallExpression(node)) {
                    return solveCallExpression(node)
                } else if (ts.isNewExpression(node)) {
                    return solveNewExpression(node)
                } else if (ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
                    return solveFunctionLikeDeclaration(node)
                } else if (ts.isFunctionExpression(node)) {
                    return solveFunctionLikeDeclaration(node)
                } else if (ts.isPropertyName(node)) {
                    return solvePropertyName(node)
                } else if (ts.isForOfStatement(node)) {
                    return solveForOfStatement(node)
                } else if (ts.isForStatement(node)) {
                    return solveForStatement(node)
                } else if (ts.isIfStatement(node)) {
                    return solveIfStatement(node)
                } else if (ts.isSwitchStatement(node)) {
                    return solveSwitchStatement(node)
                } else if (ts.isBlock(node)) {
                    return solveBlock(node)
                } else if (ts.isSourceFile(node)) {
                    return solveSourceFile(node)
                } else if (ts.isStatement(node)) {
                    return solveStatement(node)
                } else if (ts.isConditionalExpression(node)) {
                    return solveConditionalExpression(node)
                }

                if (ts.isWhileStatement(node)) {
                    return
                }

                // TODO
                if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
                    return
                }

                failOnNode('Not implemented', node)
            }
        }

        return { solve, getState: () => state, printState }
    }

    function findNodeByName(node: ts.Node, name: string): ts.Node | undefined {
        if (ts.isIdentifier(node) && node.text === name) {
            if (ts.isClassDeclaration(node.parent)) {
                return node.parent
            }
        }

        return node.forEachChild(n => findNodeByName(n, name))
    }

    function createInstance(node: ts.ClassDeclaration, ...args: any[]) {
        const solver = createSolver()
        solver.solve(ts.findAncestor(node, ts.isSourceFile)!)
        const ctor = solver.solve(node)
        const instance = ctor.call({}, ...args)
        if (isUnknown(instance)) {
            return unknown
        }

        return new Proxy(instance, {
            get: (target, prop, recv) => {
                const val = Reflect.get(target, prop, recv)
                if (typeof val === 'function') {
                    return (...args: any[]) => val.call(instance, ...args)
                }

                return val
            }
        })
    }

    function invoke(node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction, thisArg: any, ...args: any[]) {
        const solver = createSolver()
        solver.solve(ts.findAncestor(node, ts.isSourceFile)!) // FIXME: figure out how to avoid this

        const fn = solver.solve(node)

        return fn.call(thisArg, ...args)
    }

    return {
        ...createSolver(),
        createSolver,
        createInstance,
        invoke,
    }
}
