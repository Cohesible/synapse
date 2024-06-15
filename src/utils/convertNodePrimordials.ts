import ts from 'typescript'
import * as path from 'node:path'
import { glob } from './glob'
import { getFs, isCancelled, throwIfCancelled } from '../execution'
import { Symbol, createGraphCompiler, getRootSymbol, printNodes } from '../static-solver'
import { Mutable, failOnNode, getNodeLocation, getNullTransformationContext } from '../utils'
import { runCommand } from './process'
import { getLogger } from '..'

interface Mappings {
    instanceFields: Record<string, string>
    staticFields: Record<string, string>
    instanceGet: Record<string, string>
    instanceSet: Record<string, string>
    transforms?: Record<string, Matcher>
}

interface Matcher {
    readonly symbolName?: string
    readonly matchType: ts.SyntaxKind | (ts.SyntaxKind | string)[]
    readonly fn: (n: ts.Node) => ts.Node
}

function createAliasTransform(name: string): Matcher {
    return {
        matchType: ts.SyntaxKind.Identifier,
        fn: () => ts.factory.createIdentifier(name),
    }
}

function createPromiseMapper(name: string): Matcher {
    return {
        matchType: ts.SyntaxKind.CallExpression,
        fn: (n: ts.Node) => {
            if (!ts.isCallExpression(n)) {
                failOnNode('Not a call expression', n)
            }

            const t = ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('Promise'),
                name
            )

            const arg = n.arguments.length === 2
                ? ts.factory.createCallExpression(
                    ts.factory.createPropertyAccessExpression(
                        n.arguments[0],
                        'map'
                    ),
                    undefined,
                    [n.arguments[1]]
                )
                : n.arguments[0]

            return ts.factory.createCallExpression(
                t,
                undefined,
                [arg]
            )
        },
    }
}

function createIterTransform(): Matcher {
    return {
        matchType: [ts.SyntaxKind.NewExpression],
        fn: (node: ts.Node) => {
            if (ts.isNewExpression(node)) {
                return node.arguments![0]
            }

            if (ts.isSpreadElement(node) && ts.isNewExpression(node.expression)) {
                return ts.factory.updateSpreadElement(node, node.expression.arguments![0])
            }

            if (!ts.isForOfStatement(node)) {
                failOnNode('wrong node', node)
            }

            if (!ts.isNewExpression(node.expression) || !node.expression.arguments) {
                failOnNode('wrong node', node)
            }

            return ts.factory.updateForOfStatement(
                node,
                node.awaitModifier,
                node.initializer,
                node.expression.arguments[0],
                node.statement,
            )
        },
    }
}

function Identity(): Matcher {
    return {
        matchType: ts.SyntaxKind.Identifier,
        fn: n => n,
    }
}

function SetAccessorReplacer(prop: string, symbolName?: string): Matcher {
    return {
        symbolName,
        matchType: ts.SyntaxKind.CallExpression,
        fn: (n: ts.Node) => {
            if (!ts.isCallExpression(n)) {
                failOnNode('Not a call expression', n)
            }

            return ts.factory.createAssignment(
                ts.factory.createPropertyAccessExpression(
                    n.arguments[0],
                    prop,
                ),
                n.arguments[1],
            )
        }
    }
}

function GetAccessorReplacer(prop: string, symbolName?: string): Matcher {
    return {
        symbolName,
        matchType: [ts.SyntaxKind.CallExpression, 'expression'],
        fn: (n: ts.Node) => {
            if (!ts.isCallExpression(n)) {
                failOnNode('Not a call expression', n)
            }

            return ts.factory.createPropertyAccessExpression(
                n.arguments[0],
                prop,
            )
        }
    }
}

function KnownSymbolReplacer(name: string) {
    return {
        matchType: ts.SyntaxKind.Identifier,
        fn: (n: ts.Node) => {
            return ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('Symbol'),
                `Symbol.${name}`
            )
        }
    }
}

function SymbolReplacer(name: string) {
    return {
        matchType: ts.SyntaxKind.Identifier,
        fn: (n: ts.Node) => {
            return ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier('Symbol'),
                    'for',
                ),
                undefined,
                [ts.factory.createStringLiteral(name)]
            )
        }
    }
}

// These fields will have an additional `Apply` mapping
const varargsMethods = new Set([
    'ArrayOf',
    'ArrayPrototypePush',
    'ArrayPrototypeUnshift',
    'MathHypot',
    'MathMax',
    'MathMin',
    'StringFromCharCode',
    'StringFromCodePoint',
    'StringPrototypeConcat',
    'TypedArrayOf',
])

const intrinsics = [
    'AggregateError',
    'Array',
    'ArrayBuffer',
    'BigInt',
    'BigInt64Array',
    'BigUint64Array',
    'Boolean',
    'DataView',
    'Date',
    'Error',
    'EvalError',
    'FinalizationRegistry',
    'Float32Array',
    'Float64Array',
    'Function',
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'Map',
    'Number',
    'Object',
    'RangeError',
    'ReferenceError',
    'RegExp',
    'Set',
    'String',
    'Symbol',
    'SyntaxError',
    'TypeError',
    'URIError',
    'Uint16Array',
    'Uint32Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'WeakMap',
    'WeakRef',
    'WeakSet',

    'Promise',
]

// TODO: primordials[fallback] -> globalThis[fallback]
// IMPORTANT: `lib/buffer.js` suffers a perf regression without pre-binding `fill`
// const Fill = Uint8Array.prototype.fill.call.bind(Uint8Array.prototype.fill)
// TypedArrayGetToStringTag(value)
// TODO: customize build system to only build the executable
// Object.prototype.toString.call(val2);
// ReferenceError: StringPrototypePadStart is not defined -> String.prototype.padStart.call.bind(String.prototype.padStart)
// case kWebCryptoCipherDecrypt: {
//     const slice = ArrayBuffer.isView(data) ?
//         TypedArrayPrototypeSlice : ArrayBufferPrototypeSlice;

// ErrorPrototypeToString

// `lib/internal/error_serdes.js:83`
// const ObjectPrototypeToString = Object.prototype.toString.call.bind(Object.prototype.toString)


// This is currently missed
// (ctx.showHidden ?
// ObjectPrototypeHasOwnProperty :
// ObjectPrototypePropertyIsEnumerable)

// function arrayBufferViewTypeToIndex(abView) {
//     const type = abView.toString();
// Needs to use `const ObjectPrototypeToString = Object.prototype.toString.call.bind(Object.prototype.toString);`

// lib/internal/assert/assertion_error.js:381
// Object.defineProperty(this, 'name', {
//     __proto__: null, // <-- this is needed ???
//     value: 'AssertionError [ERR_ASSERTION]',
//     enumerable: false,
//     writable: true,
//     configurable: true
// });

// node:internal/util/comparisons:240
//             if (!val2.propertyIsEnumerable(key)) {
//                       ^

// TypeError: val2.propertyIsEnumerable is not a function
// const ObjectPrototypePropertyIsEnumerable = Object.prototype.propertyIsEnumerable.call.bind(Object.prototype.propertyIsEnumerable);

//     if (stringified.startsWith('class') && stringified.endsWith('}')) {
//     const neverIndex = (map[kSensitiveHeaders] || emptyArray).map(StringPrototypeToLowerCase);
//   actual: TypeError: oneLineNamedImports.replace is not a function

// val1.valueOf is not a function


// The behavior of `net.Socket` close event is different

//     const stringified = value.toString();
//     if (stringified.startsWith('class') && stringified.endsWith('}')) {
//      FunctionPrototypeToString =  Function.prototype.toString.call.bind(Function.prototype.toString)

// const NumberPrototypeValueOf = Number.prototype.valueOf.call.bind(Number.prototype.valueOf)
// const StringPrototypeValueOf = String.prototype.valueOf.call.bind(String.prototype.valueOf)
// const BooleanPrototypeValueOf = Boolean.prototype.valueOf.call.bind(Boolean.prototype.valueOf)
// const BigIntPrototypeValueOf = BigInt.prototype.valueOf.call.bind(BigInt.prototype.valueOf)
// const SymbolPrototypeValueOf = Symbol.prototype.valueOf.call.bind(Symbol.prototype.valueOf)

// function isEqualBoxedPrimitive(val1, val2) {
//     if (isNumberObject(val1)) {
//         return isNumberObject(val2) &&
//             Object.is(NumberPrototypeValueOf(val1), NumberPrototypeValueOf(val2));
//     }
//     if (isStringObject(val1)) {
//         return isStringObject(val2) &&
//             StringPrototypeValueOf(val1) === StringPrototypeValueOf(val2);
//     }
//     if (isBooleanObject(val1)) {
//         return isBooleanObject(val2) &&
//             BooleanPrototypeValueOf(val1) === BooleanPrototypeValueOf(val2);
//     }
//     if (isBigIntObject(val1)) {
//         return isBigIntObject(val2) &&
//             BigIntPrototypeValueOf(val1) === BigIntPrototypeValueOf(val2);
//     }
//     if (isSymbolObject(val1)) {
//         return isSymbolObject(val2) &&
//             SymbolPrototypeValueOf(val1) === SymbolPrototypeValueOf(val2);
//     }

// /opt/homebrew/opt/node@21/bin/node ./benchmark/compare2.js --old /opt/homebrew/bin/node --filter buffer-base64 buffers
// ./benchmark/compare2.js --old /opt/homebrew/opt/node/bin/node --filter multi-buffer dgram

function RegExpStringMethodReplacer(methodName: string): Matcher {
    return {
        matchType: ts.SyntaxKind.CallExpression,
        fn: (n) => {
            assertCallExpression(n)

            const args = methodName === 'replace'
                ? [n.arguments[0], n.arguments[2] ?? ts.factory.createStringLiteral('')] // Not providing a 2nd arg is a bug, `inspect.js` has this bug
                : [n.arguments[0], ...n.arguments.slice(2)]

            return ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(n.arguments[1], methodName),
                undefined,
                args
            )
        },
    }
}

function assertCallExpression(n: ts.Node): asserts n is ts.CallExpression {
    if (!ts.isCallExpression(n)) {
        failOnNode('Not a call expression', n)
    }
}

function propertyAccess(target: ts.Expression | string, member: string) {
    const t = typeof target === 'string' ? ts.factory.createIdentifier(target) : target

    return ts.factory.createPropertyAccessExpression(t, member)
}

function createExtras() {

    const extras: Partial<Mappings> = {
        staticFields: {
            PromiseResolve: 'Promise.resolve',
            PromiseReject: 'Promise.reject',
    
        },
        instanceFields: {
            SafeStringPrototypeSearch: 'search',
            SafePromisePrototypeFinally: 'finally',
        },
        transforms: {
            hardenRegExp: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    if (n.arguments.length === 0) {
                        failOnNode('Expected at least 1 argument', n)
                    }
                    return n.arguments[0]
                },
            },
    
            ObjectPrototypeHasOwnProperty: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    return ts.factory.updateCallExpression(
                        n,
                        ts.factory.createPropertyAccessExpression(
                            ts.factory.createIdentifier('Object'),
                            'hasOwn'
                        ),
                        undefined,
                        n.arguments
                    )
                },
            },
    
            SafePromiseAny: createPromiseMapper('any'),
            SafePromiseAll: createPromiseMapper('all'),
            SafePromiseRace: createPromiseMapper('race'),
            SafePromiseAllReturnVoid: createPromiseMapper('all'),
            SafePromiseAllReturnArrayLike: createPromiseMapper('all'),
            SafePromiseAllSettledReturnVoid: createPromiseMapper('allSettled'),
    
            SafeSet: createAliasTransform('Set'),
            SafeMap: createAliasTransform('Map'),
            SafeWeakRef: createAliasTransform('WeakRef'),
            SafeWeakSet: createAliasTransform('WeakSet'),
            SafeWeakMap: createAliasTransform('WeakMap'),
            SafeFinalizationRegistry: createAliasTransform('FinalizationRegistry'),
            MainContextError: createAliasTransform('Error'),
    
            SafeStringIterator: createIterTransform(),
            SafeArrayIterator: createIterTransform(),
            
            RegExpPrototypeSymbolReplace: RegExpStringMethodReplacer('replace'),
            RegExpPrototypeSymbolSplit:  RegExpStringMethodReplacer('split'),
            RegExpPrototypeSymbolSearch:  RegExpStringMethodReplacer('search'),
    
            SymbolDispose: SymbolReplacer('dispose'),
            SymbolAsyncDispose: SymbolReplacer('Symbol.asyncDispose'),
            SymbolIterator: KnownSymbolReplacer('iterator'),
            SymbolAsyncIterator: KnownSymbolReplacer('asyncIterator'),
            SymbolHasInstance: KnownSymbolReplacer('hasInstance'),
    
            // This overrides the default because we rarely want to call the instance method directly
            FunctionPrototypeSymbolHasInstance: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    return ts.factory.createCallExpression(
                        propertyAccess(
                            ts.factory.createElementAccessExpression(
                                propertyAccess('Function', 'prototype'),
                                propertyAccess('Symbol', 'hasInstance')
                            ),
                            'call'
                        ),
                        undefined,
                        n.arguments
                    )
                },
            },
    
            // `buffer.js` uses this as a "super" call so we can't call the instance method
            TypedArrayPrototypeFill: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    return ts.factory.createCallExpression(
                        propertyAccess(propertyAccess(propertyAccess('Uint8Array', 'prototype'), 'fill'), 'call'),
                        undefined,
                        n.arguments
                    )
                }
            },
    
            // `arguments.slice` isn't valid
            ArrayPrototypeSlice: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    if (n.arguments.length > 0 && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === 'arguments') {          
                        return ts.factory.createCallExpression(
                            propertyAccess(propertyAccess(propertyAccess('Array', 'prototype'), 'slice'), 'call'),
                            undefined,
                            n.arguments
                        )
                    }

                    return transformMethod(n, 'slice')
                }
            },

            TypedArrayPrototypeGetSymbolToStringTag: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    return ts.factory.createElementAccessExpression(
                        n.arguments[0],
                        propertyAccess('Symbol', 'toStringTag')
                    )
                }
            },
    
            // func => Function.prototype.call.bind(func)
            uncurryThis: {
                matchType: ts.SyntaxKind.CallExpression,
                fn: (n: ts.Node) => {
                    assertCallExpression(n)
    
                    return ts.factory.createCallExpression(
                        propertyAccess(
                            propertyAccess(
                                propertyAccess('Function', 'prototype'),
                                'call'
                            ),
                            'bind'
                        ),
                        undefined,
                        n.arguments,
                    )
                }
            },
    
            IteratorPrototype: {
                matchType: ts.SyntaxKind.Identifier,
                fn: () => {
                    const factory = ts.factory
                    return factory.createCallExpression(
                        factory.createPropertyAccessExpression(
                          factory.createIdentifier("Reflect"),
                          factory.createIdentifier("getPrototypeOf")
                        ),
                        undefined,
                        [factory.createCallExpression(
                          factory.createPropertyAccessExpression(
                            factory.createIdentifier("Reflect"),
                            factory.createIdentifier("getPrototypeOf")
                          ),
                          undefined,
                          [factory.createCallExpression(
                            factory.createElementAccessExpression(
                              factory.createPropertyAccessExpression(
                                factory.createIdentifier("Array"),
                                factory.createIdentifier("prototype")
                              ),
                              factory.createPropertyAccessExpression(
                                factory.createIdentifier("Symbol"),
                                factory.createIdentifier("iterator")
                              )
                            ),
                            undefined,
                            []
                          )]
                        )]
                      )
                },
            },
    
            AsyncIteratorPrototype: {
                matchType: ts.SyntaxKind.Identifier,
                fn: () => {
                    const factory = ts.factory
                    return factory.createCallExpression(
                        factory.createPropertyAccessExpression(
                          factory.createIdentifier("Reflect"),
                          factory.createIdentifier("getPrototypeOf")
                        ),
                        undefined,
                        [factory.createPropertyAccessExpression(
                          factory.createCallExpression(
                            factory.createPropertyAccessExpression(
                              factory.createIdentifier("Reflect"),
                              factory.createIdentifier("getPrototypeOf")
                            ),
                            undefined,
                            [factory.createFunctionExpression(
                              [factory.createToken(ts.SyntaxKind.AsyncKeyword)],
                              factory.createToken(ts.SyntaxKind.AsteriskToken),
                              undefined,
                              undefined,
                              [],
                              undefined,
                              factory.createBlock(
                                [],
                                false
                              )
                            )]
                          ),
                          factory.createIdentifier("prototype")
                        )]
                      )                  
                },
            }
    
            // deprecated
            // escape: Identity(),
            // eval: Identity(),
            // unescape: Identity(),
    
            // IteratorPrototype:  Reflect.getPrototypeOf(primordials.ArrayIteratorPrototype);
        }
    }

    return extras
}

function isMatch(n: ts.Node, matcher: Matcher, getSymbol: (n: ts.Node) => Symbol | undefined): boolean {
    if (!Array.isArray(matcher.matchType)) {
        return n.kind === matcher.matchType
    }

    let c: any = n
    for (const p of matcher.matchType) {
        if (typeof p === 'string') {
            if (!(p in c)) return false
            c = c[p]
            if (!c) return false
        } else {
            if (c.kind !== p) return false
        }
    }

    if (matcher.symbolName) {
        const sym = getSymbol(c)
        if (sym?.name !== matcher.symbolName) {
            return false
        }
        
        const init = sym.variableDeclaration?.initializer
        if (!init || !(ts.isIdentifier(init) && init.text === 'primordials')) {
            return false
        }

    }

    return true
}

function transformMethod(n: ts.Node, v: string) {
    assertCallExpression(n)

    return ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(
            n.arguments[0],
            v,
        ),
        undefined,
        [...n.arguments.slice(1)]
    )
}

function isProtoNull(prop: ts.ObjectLiteralElementLike) {
    if (!ts.isPropertyAssignment(prop)) {
        return false
    }

    return (
        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) && 
        prop.name.text === '__proto__' && 
        prop.initializer.kind === ts.SyntaxKind.NullKeyword
    )
}

// `for ... in` is >10x faster if the object wasn't created with `__proto__: null`
// Allocating the object is also faster, but it's only correct if the object is never
// used as an ad hoc map
//
// Only tested for v8
//
// Usages of `<k> in <obj>` can be broken, particularly when `k` isn't constant
// In this case we end up evaluating `true` if the key is on `Object.prototype`
// which isn't what we want for ad hoc maps. In these cases it's best to declare
// a null-proto object factory and use that, example:
// `const CreateObj = Object.create.bind(Object.create, null)`
// 
// If initializers are needed, then we can do this:
// `const CreateObjInit = Object.setPrototypeOf.bind(Object.setPrototypeOf)`
// `CreateObjInit({ foo: 'bar' }, null)`
// 
// Although using `__proto__` directly is a bit faster in this case
//

function createSelfBound(exp: ts.Expression, ...args: ts.Expression[]) {
    const bind = ts.factory.createPropertyAccessExpression(exp, 'bind')

    return ts.factory.createCallExpression(bind, undefined, [exp, ...args])
}

const statementsMap = new Map<ts.SourceFile, Set<ts.Statement>>()
function hoistStatement(sf: ts.SourceFile, stmt: ts.Statement) {
    const statements = statementsMap.get(sf) ?? new Set()
    statementsMap.set(sf, statements)
    statements.add(stmt)
}

function nullProtoFactory(ident: ts.Identifier) {
    return ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
            [
                ts.factory.createVariableDeclaration(
                    ident,
                    undefined,
                    undefined,
                    createSelfBound(
                        ts.factory.createPropertyAccessExpression(
                            ts.factory.createIdentifier('Object'),
                            'create'
                        ),
                        ts.factory.createNull()
                    )
                ),
            ],
            ts.NodeFlags.Const
        )
    )
}

const didAddNullProto = new Set<ts.SourceFile>()
function getNullProtoFactory(sf: ts.SourceFile) {
    const ident = ts.factory.createIdentifier('CreateNullProtoObject')
    if (didAddNullProto.has(sf)) {
        return ident
    }

    didAddNullProto.add(sf)
    hoistStatement(sf, nullProtoFactory(ident))
    return ident
}

function removeProtoNull(node: ts.ObjectLiteralExpression) {
    const filtered = node.properties.filter(p => !isProtoNull(p))
    if (filtered.length === node.properties.length) {
        return node
    }

    if (filtered.length === 0) {
        return ts.factory.createCallExpression(
            getNullProtoFactory(ts.getOriginalNode(node).getSourceFile()),
            undefined,
            []
        )
    }

    return ts.factory.updateObjectLiteralExpression(
        node,
        filtered,
    )
}

function createMatchers(mappings: Mappings, extras = createExtras()): Matcher[] {
    const m: Matcher[] = []

    function getKey<T extends keyof Mappings>(k: T): NonNullable<Mappings[T]> {
        return {
            ...mappings[k],
            ...extras[k],
        } as any
    }

    // Custom transforms have higher priority
    for (const [k, v] of Object.entries(getKey('transforms'))) {
        const matchType = Array.isArray(v.matchType) ? v.matchType : [v.matchType]
        if (matchType[matchType.length - 1] === ts.SyntaxKind.CallExpression || matchType[matchType.length - 1] === ts.SyntaxKind.NewExpression) {
            matchType.push('expression')
        }

        if (matchType[0] === ts.SyntaxKind.ForOfStatement) {
            m.push({
                symbolName: v.symbolName ?? k,
                // ...new <Foo>()
                matchType: [ts.SyntaxKind.SpreadElement, 'expression', ts.SyntaxKind.NewExpression, 'expression'],
                fn: v.fn,
            })
        }

        m.push({
            symbolName: v.symbolName ?? k,
            matchType,
            fn: v.fn,
        })
    }

    // These should all be methods
    for (const [k, v] of Object.entries(getKey('instanceFields'))) {
        m.push({
            symbolName: k,
            matchType: [ts.SyntaxKind.CallExpression, 'expression'],
            fn: n => transformMethod(n, v),
        })

        if (varargsMethods.has(k)) {
            m.push({
                symbolName: `${k}Apply`,
                matchType: [ts.SyntaxKind.CallExpression, 'expression'],
                fn: n => {
                    if (!ts.isCallExpression(n)) {
                        failOnNode('Not a call expression', n)
                    }

                    if (ts.isArrayLiteralExpression(n.arguments[1])) {
                        return ts.factory.createCallExpression(
                            ts.factory.createPropertyAccessExpression(
                                n.arguments[0],
                                v,
                            ),
                            undefined,
                            n.arguments[1].elements
                        )
                    }
    
                    // Could also do `.apply()`
                    return ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                            n.arguments[0],
                            v,
                        ),
                        undefined,
                        [ts.factory.createSpreadElement(n.arguments[1])]
                    )
                }
            })    
        }
    }

    // E.g. `Reflect.apply`
    for (const [k, v] of Object.entries(getKey('staticFields'))) {
        const parts = v.split('.')

        m.push({
            symbolName: k,
            matchType: ts.SyntaxKind.Identifier,
            fn: n => {
                return ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier(parts[0]),
                    parts[1]
                )
            }
        })

        if (varargsMethods.has(k)) {
            m.push({
                symbolName: `${k}Apply`,
                matchType: [ts.SyntaxKind.CallExpression, 'expression'],
                fn: n => {
                    if (!ts.isCallExpression(n)) {
                        failOnNode('Not a call expression', n)
                    }

                    if (ts.isArrayLiteralExpression(n.arguments[0])) {
                        return ts.factory.createCallExpression(
                            ts.factory.createPropertyAccessExpression(
                                ts.factory.createIdentifier(parts[0]),
                                parts[1]
                            ),
                            undefined,
                            n.arguments[0].elements
                        )
                    }
    
                    return ts.factory.createCallExpression(
                        ts.factory.createPropertyAccessExpression(
                            ts.factory.createIdentifier(parts[0]),
                            parts[1]
                        ),
                        undefined,
                        [ts.factory.createSpreadElement(n.arguments[0])]
                    )
                }
            })    
        }
    }

    for (const [k, v] of Object.entries(getKey('instanceGet'))) {
        m.push(GetAccessorReplacer(v, k))
    }

    for (const [k, v] of Object.entries(getKey('instanceSet'))) {
        m.push(SetAccessorReplacer(v, k))
    }

    return m
}

function groupMatchers(matchers: Matcher[]) {
    // Only groups 1 level deep
    const m = new Map<ts.SyntaxKind, Matcher[]>()
    function getGroup(t: ts.SyntaxKind) {
        if (!m.has(t)) {
            m.set(t, [])
        }

        return m.get(t)!
    }

    for (const x of matchers) {
        const mt = x.matchType
        if (!Array.isArray(mt)) {
            getGroup(mt).push({ ...x, matchType: [] })
            continue
        }

        if (typeof mt[0] === 'string') {
            throw new Error('Not expected?')
        }

        getGroup(mt[0]).push({ ...x, matchType: mt.slice(1) })
    }

    return m
}

export async function transformNodePrimordials(targets?: string[]) {
    const cwd = process.cwd()
    const mappingsPath = path.resolve(cwd, 'mappings.json')
    const mappings: Mappings = JSON.parse(await getFs().readFile(mappingsPath, 'utf-8'))
    const matchers = createMatchers(mappings)
    const groups = groupMatchers(matchers)

    const targetFiles = await glob(getFs(), cwd, ['lib/**/*.js'])
    const testTargets = targets?.map(s => path.resolve(cwd, 'lib', s) + '.js')

    for (const filePath of targetFiles) {
        if (testTargets && testTargets.length > 0 && testTargets.indexOf(filePath) === -1) continue

        const text = await getFs().readFile(filePath, 'utf-8')
        const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true)
        const r = doMap(sf, groups)
        if (r && r !== sf) {
            const printer = ts.createPrinter()
            await getFs().writeFile(filePath, printer.printFile(r))
        }
    }
}

function doMap(sf: ts.SourceFile, groups: Map<ts.SyntaxKind, Matcher[]>) {
    if (sf.fileName.endsWith('primordials.js')) {
        return
    }

    const g = createGraphCompiler({} as any, {})
    const ctx = getNullTransformationContext()

    function getUnaliasedSymbol(n: ts.Node): Symbol | undefined {
        const s = g.getSymbol(n)
        if (s?.declaration && ts.isBindingElement(s.declaration) && s.declaration.propertyName && ts.isIdentifier(s.declaration.propertyName)) {
            ;(s as Mutable<Symbol>).name = s.declaration.propertyName.text
        }
        return s
    }

    throwIfCancelled()

    function visit(node: ts.Node): ts.Node {
        if (ts.isVariableStatement(node)) {
            const decl = node.declarationList.declarations[0]
            if (decl.initializer && ts.isIdentifier(decl.initializer) && decl.initializer.text === 'primordials') {
                if (!ts.isIdentifier(decl.name)) {
                    if (ts.isObjectBindingPattern(decl.name)) {
                        for (const x of decl.name.elements) {
                            if (!ts.isIdentifier(x.name)) {

                            }
                        }
                    } else {

                    }
                }

                return ts.factory.createNotEmittedStatement(node)
            }

            if (ts.isIdentifier(decl.name) && decl.name.text === 'MainContextError') {
                return ts.factory.createNotEmittedStatement(node)
            }
        }

        if (ts.isObjectLiteralExpression(node)) {
            const pruned = removeProtoNull(node)
            if (pruned.kind === ts.SyntaxKind.CallExpression) {
                return pruned
            }
            return ts.visitEachChild(pruned, visit, ctx)
        }

        const matchers = groups.get(node.kind)
        if (!matchers) {
            return ts.visitEachChild(node, visit, ctx)
        }

        for (const m of matchers) {
            if (isMatch(node, m, getUnaliasedSymbol)) {
                return m.fn(ts.visitEachChild(node, visit, ctx))
            }
        }

        return ts.visitEachChild(node, visit, ctx)
    }

    const transformed = ts.visitEachChild(sf, visit, ctx)
    const extraStatements = statementsMap.get(sf)
    if (extraStatements) {
        return ts.factory.updateSourceFile(
            transformed,
            [
                ...transformed.statements.slice(0, 1), // `"use strict";`
                ...extraStatements,
                ...transformed.statements.slice(1),
            ]
        )
    }

    return transformed
}

async function parseGitTree(tree: string) {
    const r = await runCommand('git', ['ls-tree', tree])
    const objects = r.split('\n').map(l => {
        const [mode, type, hash, ...rest] = l.split(' ')
        const name = rest.join(' ').trim() // Not sure if names can have spaces or not

        return { mode, type: type as 'blob' | 'tree', hash, name }
    })

    return objects
}

async function catBlob(hash: string) {
    const b = await runCommand('git', ['cat-file', 'blob', hash], { encoding: 'none' }) as any as Buffer

    return b
}