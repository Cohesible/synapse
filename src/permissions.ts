import ts from 'typescript'
import { AsyncLocalStorage, AsyncResource } from 'async_hooks'
import { Fn, isElement, isGeneratedClassConstructor, isOriginalProxy, isRegExp } from './runtime/modules/terraform'
import { createStaticSolver, createUnknown, getFunctionLength, isUnion, isUnknown, isInternalFunction, getSourceCode, evaluate as evaluateUnion } from './static-solver'
import { getLogger } from './logging'
import { dedupe } from './utils'
import { getArtifactOriginalLocation } from './runtime/loader'

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


    const solver = createStaticSolver((node, scope) => {
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
                    return new Proxy(console, {
                        get: (target, prop, recv) => {
                            if (prop === 'log' || prop === 'warn' || prop === 'error') {
                                return (...args: any[]) => {
                                    getLogger().log('permissions logger:', ...args.map(a => {
                                        if (isInternalFunction(a)) {
                                            return getSourceCode(a) + ' [wrapped]'
                                        }

                                        return a
                                    }))
                                }
                            }

                            return target[prop as keyof typeof console]
                        },
                    })
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

const original = Symbol.for('original')
const unproxy = Symbol.for('unproxy')
const moveable = Symbol.for('__moveable__')
const moveable2 = Symbol.for('__moveable__2')
const permissions = Symbol.for('synapse.permissions')
const unproxyParent = Symbol.for('unproxyParent')
const expressionSym = Symbol.for('expression')

function isProxy(o: any, checkPrototype = false) {
    return !!o && ((checkPrototype && unproxy in o) || !!Reflect.getOwnPropertyDescriptor(o, moveable2))
}

function substitute(template: any, args: any[], addStatement: (s: any) => void, thisArg?: any, context?: any): any {
    if (typeof template === 'string') {
        let result = template

        const matched: boolean[] = []
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            const regexp = new RegExp(`\\{${i}\\.([A-Za-z0-9]+)\\}`, 'g')
            result = result.replace(regexp, (_, prop) => {
                matched[i] = true
                // TODO: unions
                if (isUnknown(arg[prop]) || isUnion(arg[prop])) {
                    return '*'
                } 
                return arg[prop] ?? '*'
            })
        }

        // ARGS2
        for (let i = 0; i < args.length; i++) {
            if (matched[i]) continue
            const arg = args[i]
            const regexp = new RegExp(`\\{${i}}`, 'g')
            result = result.replace(regexp, (_) => {
                matched[i] = true
                if (isUnknown(arg)) {
                    return '*'
                } 
                return arg ?? '*'
            })
        }

        // ARGS3
        // BIG HACK
        for (let i = 0; i < args.length; i++) {
            if (matched[i]) continue
            const arg = args[i]
            const regexp = new RegExp(`[^$]\\{([^\{\}]*)${i}\\.([A-Za-z0-9]+)([^\{\}]*)\\}`, 'g')
            result = result.replace(regexp, (_, $1, $2, $3) => {
                matched[i] = true
                if (isUnknown(arg) || isUnknown(arg[$2])) {
                    return '*'
                } 
                return `\{${$1}${arg[$2].toString().replace(/^\{/, '').replace(/\}$/, '')}${$3}\}`
            })
        }

        if (context) {
            if (original in context) {
                context = context[original]
            }

            // FIXME: `replace` thinks these are functions and tries to call them
            result = result.replace(/\{context\.Partition\}/g, context.partition.toString())
            result = result.replace(/\{context\.Region\}/g, context.regionId.toString())
            result = result.replace(/\{context\.Account\}/g, context.accountId.toString())
        }

        return result
    } else if (Array.isArray(template)) {
        // XXX: ugly hack, need to clean-up the permissions API
        if (typeof template[0] === 'string') {
            return template.map(v => substitute(v, args, addStatement, thisArg, context))
        }

        template.forEach(v => substitute(v, args, addStatement, thisArg, context))

        return createUnknown()
    } else if (typeof template === 'function') {
        if (context && original in context) {
            context = context[original]
        }

        const $context = Object.create(context ?? null, { 
            addStatement: { value: addStatement },
            createUnknown: { value: createUnknown },
        })

        const thisArgWithCtx = Object.create(thisArg ?? null, {
            $context: { value: $context }
        })

        return template.apply(thisArgWithCtx, args)
    } else if (typeof template === 'object' && !!template) {
        const result: any = {}
        for (const [k, v] of Object.entries(template)) {
            result[k] = substitute(v, args, addStatement, thisArg, context)
        }

        addStatement(result)

        return createUnknown()
    } else {
        return String(template)
    }
}

function getModel(o: any): PermissionsBinding | undefined {
    if (!o) return

    if (Object.prototype.hasOwnProperty.call(o, permissions)) {
        const model = o[permissions]
        if (model.type === 'class' || model.type === 'object' || model.type === 'function') {
            return model
        }
    }
}

export function createPermissionsBinder() {
    // Does two things:
    // 1. Loads in any models discovered
    // 2. Infers the "permissions signature" of statements



    function createCapturedSolver(
        getSourceFile: (fileName: string) => ts.SourceFile
    ) {
        const resolveCache = new Map<any, any>()
        const ctx = new AsyncLocalStorage<{ statements: any[]; canCache?: boolean }>()

        // Can probably cache most things now
        function skipCache() {
            const store = ctx.getStore()
            if (store !== undefined) {
                store.canCache = false
            }
        }

        function getStatements() {
            return ctx.getStore()?.statements ?? []
        }

        function addStatement(s: any) {
            s.Effect ??= 'Allow'
            getStatements().push(s)
        }

        function evaluate(target: any, getContext: (target: any) => any, globals?: { console?: any }, args: any[] = [], thisArg?: any) {
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
                const factory = (...args: any[]) => fn.call([decl], undefined, ...args)
                factoryFunctions.set(fileName, factory)

                return factory
            }

            function createFunction(model: FunctionPermissionsBinding['call'], t: any) {
                skipCache()

                return function (...args: any[]) {
                    return substitute(model, args, addStatement, t, getContext(t))
                }
            }

            function createInstance(model: ObjectPermissionsBinding['methods'] | ClassPermissionsBinding['methods'], t: any) {
                skipCache()

                const proto = {} as Record<string, any>
                for (const [k, v] of Object.entries(model)) {
                    proto[k] = function (...args: any[]) {
                        return substitute(v, args, addStatement, t, getContext(t))
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

            function createStubFromModel(model: PermissionsBinding, obj: any) {
                if (model.type === 'class') {
                    return function (...args: any[]) { 
                        if (model.$constructor) {
                            const t = thisArg ?? obj
                            substitute(model.$constructor, args, addStatement, t, getContext(t))
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

                const _ctx = { canCache: true, statements: getStatements() }
                ctx.run(_ctx, resolveProperties)

                if (!_ctx.canCache) {
                    skipCache()
                    resolveCache.delete(o)
                }

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

                                const _ctx = { canCache: true, statements: getStatements() }
                                const val = ctx.run(_ctx, () => resolve(o[k]))

                                if (_ctx.canCache) {
                                    didResolve = true
                                    currentVal = val
                                }

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

            function resolve(o: any): any {
                if ((typeof o !== 'object' && typeof o !== 'function') || !o) {
                    return o
                }

                if (resolveCache.has(o)) {
                    return resolveCache.get(o)
                }

                const _ctx = { canCache: true, statements: getStatements() }
                const res = ctx.run(_ctx, inner)

                if (_ctx.canCache) {
                    resolveCache.set(o, res)
                } else {
                    skipCache()
                }

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

                        if (typeof o[moveable] === 'function') {
                            const val = o[moveable]()
                            if (val.valueType === 'function') {
                                return invokeCaptured(val.module, resolve(substituteGlobals(val.captured)))
                            } else if (val.valueType === 'reflection') {
                                return createUnknown()   
                            }
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

                    if (typeof o[moveable] === 'function') {
                        const val = o[moveable]()
                        if (val.valueType === 'function') {
                            return invokeCaptured(val.module, resolve(substituteGlobals(val.captured)))
                        } else if (val.valueType === 'reflection') {
                            return createUnknown()   
                        }
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
                skipCache() // We'll keep a separate cache for re-hydrated factory functions
        
                return getFactoryFunction(fileName)(...captured)
            }
    
            const statements: any[] = []
            try {
                ctx.run({ statements }, () => {
                    const fn = resolve(target)
                    call(fn, args)
                })    
            } catch (e) {
                const module = (typeof target === 'object' || typeof target === 'function')
                    ? target?.[moveable]?.().module
                    : undefined

                if (module) {
                    const location = getArtifactOriginalLocation(module)
                    if (location) {
                        throw new Error(`Failed to solve permissions for target: ${location}`, { cause: e })
                    }
                }

                throw new Error(`Failed to solve permissions for target: ${require('node:util').inspect(target)}`, { cause: e })
            }

            return dedupe(statements.flat(100))
        }

        return { evaluate }
    }

    function call(fn: any, args: any[]) {
        if (isUnknown(fn)) {
            return
        }

        if (isUnion(fn)) {
            for (const f of fn) {
                call(f, args)
            }

            return
        }

        if (isInternalFunction(fn)) {
            fn.call([], undefined, ...args)
        } else {
            fn.call(undefined, ...args)
        }
    }

    return { createCapturedSolver }
}

// STUB
type Model = any

// TODO: come up with better name
// The logic is being used for permissions but is perfectly usuable for any kind of binding


interface ObjectPermissionsBinding {
    type: 'object'
    methods: Record<string, Model>
}

interface ClassPermissionsBinding {
    type: 'class'
    methods: Record<string, Model>
    $constructor?: Model
}

interface FunctionPermissionsBinding {
    type: 'function'
    call: Model
}

type PermissionsBinding = ObjectPermissionsBinding | ClassPermissionsBinding | FunctionPermissionsBinding