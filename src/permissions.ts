import ts from 'typescript'
import { createStaticSolver, createUnknown, isUnion, isUnknown, isInternalFunction, getSourceCode, evaluate as evaluateUnion } from './static-solver'
import { getLogger, LogLevel } from './logging'
import { dedupe, memoize, wrapWithProxy } from './utils'
import { getArtifactOriginalLocation } from './runtime/loader'
import { ExternalValue } from './runtime/modules/serdes'
import { isProxy } from './loader'

export function isModuleExport(node: ts.Node): node is ts.ExpressionStatement & { expression: ts.BinaryExpression } {
    if (!ts.isExpressionStatement(node)) {
        return false
    }

    const exp = node.expression
    if (!ts.isBinaryExpression(exp) || exp.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return false
    }

    return (
        ts.isPropertyAccessExpression(exp.left) && 
        exp.left.name.text === 'exports' && 
        ts.isIdentifier(exp.left.expression) && 
        exp.left.expression.text === 'module'
    )
}

export function createSolver(substitute?: (node: ts.Node) => any) {
    const MockNumber = new Proxy(Number, {
        apply: (target, thisArg, args) => {
            if (args.some(a => isUnknown(a) || isUnion(a))) {
                return args[0]
                // return new Proxy({}, {
                //     get: (_, p) => {
                //         if (p === Symbol.toPrimitive) {
                //             return (hint?: string) => {
                //                 if (hint === 'number') {
                //                     return NaN
                //                 } else {
                //                     return '*'
                //                 }
                //             }
                //         }
                //     }
                // })
            }

            return (target as any).apply(thisArg, args)
        },
    })

    class MockPromise {
        static all(args: any[]) {
            return args
        }
    }

    const MockObject = new Proxy({}, {
        get: (target, prop, recv) => {
            if (prop === 'assign') {
                return function assign(target: any, ...sources: any[]) {
                    if (isUnknown(target)) {
                        return target
                    }

                    if (target === undefined) {
                        return createUnknown()
                    }
    
                    return Object.assign(target, ...sources)
                }
            }

            if (prop === 'entries') {
                return function entries(target: any) {
                    if (isUnknown(target) || isUnion(target)) {
                        return [[createUnknown(), createUnknown()]]
                    }

                    // XXX: not technically correct
                    if (!target) {
                        return [[createUnknown(), createUnknown()]]
                    }

                    return Object.entries(target)
                }
            }

            if (prop === 'values') {
                return function values(target: any) {
                    if (isUnknown(target) || isUnion(target)) {
                        return Object.assign([createUnknown()], {
                            splice: (start: number, count: number) => {
                                return [createUnknown()]
                            },
                        })
                    }

                    if (!target) {
                        return createUnknown()
                    }

                    // XXX: using the derived value is not always correct
                    // The only time we can return an empty array is if we can guarantee that nothing
                    // would be assigned to the target object
                    const values = Object.values(target)
                    if (values.length === 0) {
                        return Object.assign([createUnknown()], {
                            splice: (start: number, count: number) => {
                                return [createUnknown()]
                            },
                        })
                    }

                    return values
                }
            }

            if (prop === 'keys') {
                return function keys(target: any) {
                    if (!target) {
                        return createUnknown()
                    }
                    if (isUnknown(target)) {
                        return [target]
                    }

                    return Object.keys(target)
                }
            }

            if (prop === 'getPrototypeOf') {
                return function getPrototypeOf(target: any) {
                    if (!target) {
                        return createUnknown()
                    }
                    if (isUnknown(target)) {
                        return target
                    }

                    return Object.getPrototypeOf(target)
                }
            }

            // if (prop === 'create') {
            //     return function create(val: any, desc?: Record<PropertyKey, PropertyDescriptor>) {
            //         if (isUnknown(val) || isUnknown(desc)) {
            //             return createUnknown()
            //         }

            //         return desc ? Object.create(val, desc) : Object.create(val)
            //     }
            // }

            return createUnknown()
        }
    })

    const getSymEvalLogger = memoize(() => {
        function logEvent(level: LogLevel, ...args: any[]) {
            const mapped = args.map(a => {
                if (isInternalFunction(a)) {
                    return getSourceCode(a) + ' [wrapped]'
                }

                if (isUnknown(a)) {
                    return '[unknown]'
                }

                if (isUnion(a)) {
                    return '[union]'
                }

                return a
            })

            return getLogger().emitSynthLogEvent({
                level,
                args: mapped,
                source: 'symEval',
            })
        }

        const m = (level: LogLevel) => (...args: any[]) => logEvent(level, args)

        const logMethods = {
            log: m(LogLevel.Info),
            warn: m(LogLevel.Warn),
            error: m(LogLevel.Error),
            debug: m(LogLevel.Debug),
            trace: m(LogLevel.Trace),
        }

        return wrapWithProxy(console, logMethods)
    })

    const solver = createStaticSolver(node => {
        if (ts.isIdentifier(node) && node.text === 'require') {
            return (id: string) => {
                return createUnknown()
            }
        }

        if (ts.isIdentifier(node)) {
            switch (node.text) {
                case 'Array':
                    return Array
                case 'Number':
                    return MockNumber
                case 'Promise':
                    return MockPromise
                case 'Object':
                    return MockObject
                // case 'Symbol':
                //     return Symbol
                case 'console':
                    return getSymEvalLogger()
                case 'JSON':
                    return {
                        parse: (o: any) => {
                            return createUnknown()
                        },
                        stringify: (val: any, replacer?: any, space?: any) => { // INCORRECT
                            if (isUnion(val)) {
                                evaluateUnion(val)
                            }

                            return createUnknown()
                        },
                    }
            }
        }

        return substitute?.(node)
    })

    return solver
}

// Example Azure role for reading data from the Storage service:
// {
//     "assignableScopes": [
//       "/"
//     ],
//     "description": "Allows for read access to Azure File Share over SMB",
//     "id": "/subscriptions/{subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/aba4ae5f-2193-4029-9191-0cb91df5e314",
//     "name": "aba4ae5f-2193-4029-9191-0cb91df5e314",
//     "permissions": [
//       {
//         "actions": [],
//         "notActions": [],
//         "dataActions": [
//           "Microsoft.Storage/storageAccounts/fileServices/fileshares/files/read"
//         ],
//         "notDataActions": []
//       }
//     ],
//     "roleName": "Storage File Data SMB Share Reader",
//     "roleType": "BuiltInRole",
//     "type": "Microsoft.Authorization/roleDefinitions"
// }

const unproxy = Symbol.for('unproxy')
const moveable = Symbol.for('__moveable__')
const moveable2 = Symbol.for('__moveable__2')
const permissions = Symbol.for('synapse.permissions')
const unproxyParent = Symbol.for('unproxyParent')
const expressionSym = Symbol.for('expression')

function createCachedSubstitute(getCacheKey: (template: any, args: any[], thisArg?: any) => string) {
    const cachedEvals = new Map<string, any>()

    function substitute(template: any, args: any[], thisArg?: any) {
        const key = getCacheKey(template, args, thisArg)
        if (cachedEvals.has(key)) {
            return cachedEvals.has(key)
        }

        const val = _substitute(template, args, thisArg)
        cachedEvals.set(key, val)

        return val
    }

    function _substitute(template: any, args: any[], thisArg?: any): any {
        if (Array.isArray(template)) {
            template.forEach(v => substitute(v, args, thisArg))
    
            return createUnknown()
        } else if (typeof template === 'function') {
            return template.apply(thisArg, args)
        } else if (typeof template === 'object' && !!template) {
            for (const [k, v] of Object.entries(template)) {
                substitute(v, args, thisArg)
            }
    
            return createUnknown()
        } else {
            return String(template)
        }
    }

    return {
        substitute,
        clearCache: () => cachedEvals.clear(),
    }
}

function getModel(o: any): SymEvalBinding | undefined {
    if (!o) return

    if (Object.prototype.hasOwnProperty.call(o, permissions)) {
        const model = o[permissions]
        if (model.type === 'class' || model.type === 'object' || model.type === 'function') {
            return model
        }
    }
}

export function createCapturedSolver(
    getSourceFile: (fileName: string) => ts.SourceFile,
    getTerraform: () => typeof import('./runtime/modules/terraform')
) {
    const resolveCache = new Map<any, any>()

    const solver = createSolver()
    const factoryFunctions = new Map<string, (...args: any[]) => any>()
    function getFactoryFunction(fileName: string) {
        if (factoryFunctions.has(fileName)) {
            return factoryFunctions.get(fileName)!
        }

        const sf = getSourceFile(fileName)
        const decl = sf.statements.find(ts.isFunctionDeclaration) ?? sf.statements.find(isModuleExport)?.expression.right
        if (!decl) {
            throw new Error(`No export found: ${fileName}`)
        }

        const fn = solver.createSolver().solve(decl)
        const factory = (...args: any[]) => fn.call(undefined, ...args)
        factoryFunctions.set(fileName, factory)

        return factory
    }

    const ids = new Map<any, number>()
    function getValueId(obj: any): number {
        const _id = ids.get(obj)
        if (_id !== undefined) {
            return _id
        }

        if (typeof obj === 'object' && obj !== null) {
            const proto = Object.getPrototypeOf(obj)
            if (proto === Object.prototype) {
                const id = getValueId(JSON.stringify(obj))
                ids.set(obj, id)

                return id
            }
        }

        const id = ids.size
        ids.set(obj, id)

        return id
    }

    function getCacheKey(template: any, args: any[], thisArg?: any) {
        const argKeys = args.map(getValueId)
        argKeys.push(getValueId(thisArg))
        argKeys.push(getValueId(template))

        return argKeys.join(':')
    }

    const { substitute, clearCache } = createCachedSubstitute(getCacheKey)

    function evaluate(target: any, globals?: { console?: any }, args: any[] = [], thisArg?: any) {
        clearCache()

        function createFunction(model: FunctionSymEvalBinding['call'], t: any) {
            return function (this: any, ...args: any[]) {
                return substitute(model, args, t)
            }
        }

        function createInstance(model: ObjectSymEvalBinding['methods'] | ClassSymEvalBinding['methods'], t: any) {
            const proto = {} as Record<string, any>
            for (const [k, v] of Object.entries(model)) {
                proto[k] = function (this: any, ...args: any[]) {
                    return substitute(v, args, t)
                }
            }

            return proto
        }

        function createTree(model: any, t: any) {
            if (model.type === 'function') {
                return createFunction(model.call, t)
            }

            if (model.type !== 'container') {
                return function () { return createInstance(model.methods, t) }
            }

            const res: Record<string, any> = {}
            for (const [k, v] of Object.entries(model.properties)) {
                if (typeof v !== 'object' || v === null) {
                    throw new Error(`Unexpected permissions binding: ${v}`)
                }

                if ((v as any).type) {
                    res[k] = createTree(v, t)
                }
            }

            return Object.assign(resolveObject(t), res)
        }

        function createStubFromModel(model: SymEvalBinding, obj: any) {
            if (model.type === 'class') {
                return function (this: any, ...args: any[]) { 
                    if (model.$constructor) {
                        substitute(model.$constructor, args, this ?? obj)
                    }

                    return createInstance(model.methods, obj)
                }
            } else if (model.type === 'object') {
                return createInstance(model.methods, obj)
            } else if (model.type === 'function') {
                return createFunction(model.call, obj)
            }
        }

        function getBaseObject(o: any) {
            if (!o.constructor || Object.getPrototypeOf(o) === null) {
                return Object.create(null)
            } else if (o.constructor.name === 'Object') {
                return {}
            }

            const ctor = resolve(o.constructor)
            if (ctor && !isUnknown(ctor)) {
                return Object.create(ctor.prototype, {
                    constructor: {
                        value: ctor,
                        enumerable: true,
                        configurable: true,
                    }
                })
            }

            return createUnknown()
        }

        function resolveObject(o: any) {
            const resolved = getBaseObject(o)
            resolveCache.set(o, resolved) // This cache is probably redundant with the heavy caching in `resolveProperties`

            if (isUnknown(resolved)) {
                return resolved
            }

            resolveProperties()

            return resolved

            function resolveProperties() {
                // Lazily-evaluate every enumerable property
                for (const k of Object.keys(o)) {
                    let currentVal: any
                    let didResolve = false
                    Object.defineProperty(resolved, k, {
                        get: () => {
                            if (didResolve) {
                                return currentVal
                            }

                            const val = resolve(o[k])

                            didResolve = true
                            currentVal = val

                            return val
                        },
                        set: (nv) => {
                            didResolve = true
                            currentVal = nv
                        },
                        configurable: true,
                        enumerable: true,
                    })
                }    
            }
        }

        const { isOriginalProxy, isGeneratedClassConstructor, isRegExp } = getTerraform()

        function resolve(o: any): any {
            if ((typeof o !== 'object' && typeof o !== 'function') || !o) {
                return o
            }

            if (resolveCache.has(o)) {
                return resolveCache.get(o)
            }

            const res = inner()
            resolveCache.set(o, res)

            return res

            function inner() {
                if (expressionSym in o) {
                    if (!isOriginalProxy(o) || !o.constructor || isGeneratedClassConstructor(o.constructor)) {
                        return o
                    }
                }
                    
                if (Array.isArray(o)) {
                    return o.map(resolve)
                }

                if (isProxy(o)) {
                    const unproxied = o[unproxy]
                    const ctor = unproxied.constructor
                    if (ctor) {
                        const ctorM = getModel(ctor[unproxy])
                        if (ctorM && ctorM.type === 'class') {
                            return createInstance(ctorM.methods, unproxied)
                        }
                    }

                    const p = o[unproxyParent]
                    const pm = getModel(p)
                    if (pm) {
                        return createStubFromModel(pm, unproxied)
                    }

                    if (ctor && typeof ctor[moveable] === 'function') {
                        const resolved = resolveObject(unproxied)
                        const model = getModel(ctor)

                        if (model && model.type !== 'function') {
                            // Merges the model into the current object
                            const partial = createInstance(model.methods, unproxied)

                            return Object.assign(resolved, partial)
                        }

                        if (isOriginalProxy(unproxied)) {
                            return new Proxy(resolved, {
                                get: (target, prop, recv) => {
                                    if (Reflect.has(target, prop)) {
                                        return target[prop]
                                    }

                                    return unproxied[prop]
                                }
                            })
                        }

                        return resolved
                    }

                    const opm = getModel(unproxied)
                    if (opm !== undefined) {
                        return createStubFromModel(opm, unproxied)
                    }

                    const fromDesc = maybeResolveDescription(o)
                    if (fromDesc !== undefined) {
                        return fromDesc
                    }

                    const x = o[moveable2]()
                    if (x?.valueType === 'reflection') {
                        return createUnknown()
                    }

                    return resolve(unproxied)
                }

                const m = getModel(o)
                if (m) {
                    return createStubFromModel(m, o)
                }

                const ctor = o.constructor
                const ctorModel = ctor ? getModel(ctor) : undefined
                if (ctorModel && ctorModel.type !== 'function') {
                    const partial = createInstance(ctorModel.methods, o)
                    return Object.assign(resolveObject(o), partial)
                }

                if (isUnion(o)) {
                    return o
                }

                const perms = o[permissions]
                if (perms) {
                    if (perms.type === 'container') {
                        return createTree(perms, o)
                    }

                    return createStubFromModel(perms, o)
                }

                const fromDesc = maybeResolveDescription(o)
                if (fromDesc !== undefined) {
                    return fromDesc
                }

                if (isRegExp(o)) {
                    return o
                }

                if (typeof o === 'object') {
                    return resolveObject(o)
                }
    
                return createUnknown()
            }
        }

        function maybeResolveDescription(o: any): any | undefined {
            if (typeof o[moveable] !== 'function') {
                return
            }

            const desc: ExternalValue = o[moveable]()
            switch (desc.valueType) {
                case 'reflection':
                    return createUnknown()
                case 'function':
                    return invokeCaptured(desc.module, resolve(substituteGlobals(desc.captured!)))
                case 'bound-function': {
                    const fn = resolve(desc.boundTarget!)
                    if (typeof fn !== 'function') {
                        return
                    }

                    const resolvedArgs = [desc.boundThisArg, ...desc.boundArgs!].map(resolve) as [any, ...any[]]

                    return fn.bind(resolvedArgs[0], ...resolvedArgs.slice(1))
                }
            }
        }

        function substituteGlobals(captured: any[]) {
            if (!globals) {
                return captured
            }

            return captured.map(c => {
                if ((typeof c === 'object' || typeof c === 'function') && !!c && typeof c[moveable2] === 'function') {
                    const desc = c[moveable2]()
                    if (desc.operations && desc.operations[0].type === 'global') {
                        const target = desc.operations[1]
                        if (target && target.type === 'get') {
                            return globals[target.property as keyof typeof globals] ?? c
                        }
                    }
                }

                return c
            })
        }
        
        function invokeCaptured(fileName: string, captured: any[]): any {
            return getFactoryFunction(fileName)(...captured)
        }

        function getLocation(target: any) {
            const module = (typeof target === 'object' || typeof target === 'function')
                ? target?.[moveable]?.().module
                : undefined

            if (module) {
                return getArtifactOriginalLocation(module)
            }
        }

        try {
            const fn = resolve(target)

            return call(fn, args, thisArg)
        } catch (e) {
            const location = getLocation(target)
            if (location) {
                throw new Error(`Failed to solve permissions for target: ${location}`, { cause: e })
            }

            throw new Error(`Failed to solve permissions for target: ${require('node:util').inspect(target)}`, { cause: e })
        }
    }

    return { evaluate }
}

function call(fn: any, args: any[], thisArg?: any) {
    if (isUnknown(fn)) {
        return fn
    }

    // TODO: return a union, need to expose an API for working with unions
    if (isUnion(fn)) {
        for (const f of fn) {
            call(f, args, thisArg)
        }

        return
    }

    return fn.call(thisArg, ...args)
}

// STUB
type Model = any

interface ObjectSymEvalBinding {
    type: 'object'
    methods: Record<string, Model>
}

interface ClassSymEvalBinding {
    type: 'class'
    methods: Record<string, Model>
    $constructor?: Model
}

interface FunctionSymEvalBinding {
    type: 'function'
    call: Model
}

type SymEvalBinding = ObjectSymEvalBinding | ClassSymEvalBinding | FunctionSymEvalBinding
