// Notes:
// The super.property syntax can be used inside a static block to reference static properties of a super class.
// class A { static foo = 'bar' }; class B extends A { static { getTerminalLogger().log(super.foo); } }

// Private properties with the same name within different classes are entirely different and do not 
// interoperate with each other. See them as external metadata attached to each instance, managed by the class.

// Private fields/methods are basically non-serializable without modifying the source code.
// This is because the constructor _must_ be called for initialization to happen

export const moveable = Symbol.for('__moveable__')
const moveableStr = `@@${moveable.description as '__moveable__'}` as const

export const fqn = Symbol.for('__fqn__')
const pointerSymbol = Symbol.for('synapse.pointer')

// async not supported yet
export const serializeSymbol = Symbol.for('__serialize__')

export interface ExternalValue {
    readonly id?: number | string
    readonly hash?: string
    readonly location?: string
    readonly module: string // Not present with `reflection`
    readonly valueType?: 'function' | 'reflection' | 'object' | 'resource' | 'regexp' | 'binding' | 'data-pointer' | 'bound-function'
    readonly captured?: any[] // If present, the module export will be invoked using these as args
    readonly export?: string
    readonly parameters?: any[] // Used to invoke a ctor or function
    readonly operations?: ReflectionOperation[] // Only applicable to `reflection`
    readonly symbols?: Record<string, any>
    readonly packageInfo?: PackageInfo // Only used for `reflection` type right now
    readonly decorators?: any[]

    // Refers to the values of a bound function
    readonly boundTarget?: any
    readonly boundThisArg?: any
    readonly boundArgs?: any[]

    // For reference bindings
    readonly key?: string
    readonly value?: number | string
}

export interface PackageInfo {
    readonly type: 'npm' | 'cspm' | 'synapse-provider' | 'file' | 'jsr' | 'synapse-tool' | 'spr' | 'github'
    readonly name: string
    readonly version: string
    readonly packageHash?: string // Only relevant for `synapse`
    readonly os?: string[]
    readonly cpu?: string[]
    readonly bin?: string | Record<string, string>
    readonly resolved?: {
        readonly url: string
        readonly integrity?: string
        readonly isStubPackage?: boolean
        readonly isSynapsePackage?: boolean
    }
}

export interface DependencyTree {
    [name: string]: {
        readonly location: string
        readonly packageInfo: PackageInfo
        readonly versionConstraint: string
        readonly dependencies?: DependencyTree
        readonly optional?: boolean
    }
}

interface RegExpValue extends ExternalValue {
    readonly valueType: 'regexp'
    readonly source: string
    readonly flags: string
}

interface DataPointerValue extends ExternalValue {
    readonly valueType: 'data-pointer'
    readonly hash: string
    readonly storeHash: string
}

export interface SerializedObject {
    readonly id: string | number
    readonly valueType: 'object'
    readonly properties?: Record<string, any>
    readonly descriptors?: Record<string, any>
    readonly privateFields?: any[]
    readonly prototype?: any // Object.prototype by default
    readonly constructor?: any
}

export interface ResourceValue {
    readonly id: string | number
    readonly valueType: 'resource'
    readonly value: any
}

interface GetOperation {
    readonly type: 'get'
    readonly property: string // can be a symbol?
}

interface ConstructOperation {
    readonly type: 'construct'
    readonly args: any[]
    // `newTarget` is only needed if we try to construct a derived class given the base ctor
}

interface ApplyOperation {
    readonly type: 'apply'
    readonly args: any[]
    readonly thisArg?: any
}

interface ImportOperation {
    readonly type: 'import'
    readonly module: string
    readonly location?: string

    readonly packageInfo?: PackageInfo
    readonly dependencies?: DependencyTree
}

interface GlobalOperation {
    readonly type: 'global'
}

export type ReflectionOperation = GetOperation | ConstructOperation | ApplyOperation | ImportOperation | GlobalOperation

export type DataPointer = string & {
    readonly ref: string
    readonly hash: string;
    readonly [pointerSymbol]: true
    resolve(): { hash: string; storeHash: string }
    isResolved(): boolean
    isContainedBy(storeId: string): boolean
}

const pointerPrefix = 'pointer:'

function createPointer(hash: string, storeHash: string): DataPointer {
    function resolve() {
        return { hash, storeHash }
    }

    const ref = `${pointerPrefix}${hash}`

    return Object.assign(ref, {
        ref,
        hash,
        resolve,
        isResolved: () => true,
        isContainedBy: (storeId: string) => false,
        [pointerSymbol]: true as const,
    })
}


interface ModuleLoader {
    loadModule: (specifier: string, importer?: string) => any
}

export function resolveValue(
    value: any,
    moduleLoader: ModuleLoader,
    dataTable: Record<string | number, any> = {},
    context = globalThis,
    preserveId = false
): any {
    function loadFunction(val: any, params: any[]) {
        switch (params.length) {
            case 1:     return val(params[0])
            case 2:     return val(params[0], params[1])
            case 3:     return val(params[0], params[1], params[2])
            case 4:     return val(params[0], params[1], params[2], params[3])
            default:    return val(...params)
        }
    }

    function loadValueFromExports(desc: ExternalValue, exports: any): any {
        const exported = desc.export 
            ? exports[desc.export] 
            : 'default' in exports ? exports.default : exports // XXX: this 'default' check is for backwards compat

        if (desc.captured) {
            if (desc.captured instanceof Promise) {
                return desc.captured.then(args => loadFunction(exported, args))
            }
            return loadFunction(exported, desc.captured)
        }

        return exported
    }

    function reflectionWorker(operation: ReflectionOperation, operand?: any) {
        if (operand === undefined && operation.type !== 'import' && operation.type !== 'global') {
            throw new Error(`Bad operation, expected import or global to initialize operand: ${JSON.stringify(operation, undefined, 4)}`)
        }

        switch (operation.type) {
            case 'global':
                return context
            case 'import':
                return moduleLoader.loadModule(operation.module, operation.location)
            case 'get':
                return operand[operation.property]

                // We need to serialize the receiver for this to work correctly
                // return Reflect.get(operand, operation.property)
            case 'apply': 
                return Reflect.apply(operand, operation.thisArg, operation.args)
            case 'construct':
                return Reflect.construct(operand, operation.args)
            default:
                throw new Error(`Unhandled operation: ${JSON.stringify(operation, undefined, 4)}`)
        }
    }

    function handleReflection(operations: ReflectionOperation[]) {
        let operand: any

        for (const op of operations) {
            if (operand instanceof Promise) {
                operand = operand.then(x => reflectionWorker(op, x))
            } else {
                operand = reflectionWorker(op, operand)
            }
        }

        return operand
    }

    const deserialize = Symbol.for('deserialize')
    function createObject(prototype: any, properties: any, descriptors: any, privateFields: any, constructor: any) {
        const proto = prototype !== undefined 
            ? prototype
            : constructor === undefined
                ? Object.prototype
                : constructor.prototype

        const obj = Object.create(proto ?? null, descriptors)
        if (properties !== undefined) {
            Object.assign(obj, properties) // Careful: this triggers `set` accessors, better to map as descriptors?
        }

        if (constructor !== undefined) {
            obj.constructor = constructor
        }

        if (privateFields !== undefined && deserialize in obj) {
            obj[deserialize]({ __privateFields: privateFields })
        }

        return obj
    }

    function loadObject(desc: SerializedObject): any {
        const proto = desc.prototype
        const props = desc.properties
        const privateFields = desc.privateFields
        const descriptors = desc.descriptors
        const constructor = Object.getOwnPropertyDescriptor(desc, 'constructor')?.value

        const all = [proto, props, descriptors, privateFields, constructor] as [any, any, any, any, any]
        if (all.some(x => x instanceof Promise)) {
            return Promise.all(all).then(args => createObject(...args))
        }

        return createObject(...all)
    }

    function loadValue(desc: ExternalValue, exports: any): any {
        if (desc.valueType === 'function' && desc.parameters) {
            const params = desc.parameters
            const f = loadValueFromExports(desc, exports)
            if (f instanceof Promise) {
                return f.then(fn => loadFunction(fn, params))
            }

            return loadFunction(f, params)
        }

        return loadValueFromExports(desc, exports)
    }

    const resolveCache = new Map<number | string, any>()
    const objectCache = new Map<any, any>() // Used for re-hydrating refs of the form `{ id: number | string }`
    const lateBindings = new Map<number | string, { key: string; value: string | number | { [moveableStr]: { id: number | string } } }>()

    function resolve(o: any): any {
        if (typeof o !== 'object' || o === null) {
            return o
        }

        if (objectCache.has(o)) {
            return objectCache.get(o)!
        }

        if (Array.isArray(o)) {
            let isPromise = false
            const a = o.map(x => {
                const e = resolve(x)
                isPromise ||= e instanceof Promise

                return e
            })

            const p = isPromise ? Promise.all(a) : a
            objectCache.set(o, p)

            return p
        }

        if (o[pointerSymbol]) {
            return o
        }

        const payload = o[moveableStr] as ExternalValue | undefined
        if (payload === undefined) {
            let isPromise = false
            const r: Record<string, any> = {}
            objectCache.set(o, r)

            for (const [k, v] of Object.entries(o)) {
                r[k] = resolve(v)
                isPromise ||= r[k] instanceof Promise
            }

            return !isPromise ? r : (async function () {
                for (const [k, v] of Object.entries(r)) {
                    r[k] = await v
                }
                return r
            })()
        }

        delete o[moveableStr]

        function resolveWorker(payload: ExternalValue) {
            // No value type means we're nested or are a reference
            if (!payload.valueType) {
                return resolve(payload)
            }

            const id = payload.id
            if (id !== undefined && resolveCache.has(id)) {
                return resolveCache.get(id)
            }

            const val = resolveValueType()

            if (id !== undefined) {
                resolveCache.set(id, val)
            }

            return val

            function resolveValueType() {
                switch (payload.valueType) {
                    case 'resource': {
                        const value = (payload as any).value!
                        const normalized = normalizeTerraform(value)
                        // XXX: do not re-hydrate captured values in a bundle
                        if (typeof normalized === 'object' && !!normalized && 'id' in normalized && 'location' in normalized && 'source' in normalized && 'state' in normalized && 'captured' in normalized) {
                            normalized.captured = ''
                        }
        
                        return resolve(normalized)
                    }

                    case 'regexp': {
                        const desc = payload as RegExpValue
    
                        return new RegExp(desc.source, desc.flags)
                    }

                    case 'object':
                        return loadObject(payload as SerializedObject)

                    case 'reflection':
                        return handleReflection(payload.operations!)

                    case 'binding':
                        lateBindings.set(payload.id!, { key: payload.key!, value: payload.value! })

                        return {}

                    case 'data-pointer':
                        return createPointer((payload as DataPointerValue).hash, (payload as DataPointerValue).storeHash)

                    case 'bound-function':
                        return payload.boundTarget!.bind(payload.boundThisArg, ...payload.boundArgs!)
                }

                const module = typeof payload.module === 'object' || payload.module.startsWith(pointerPrefix)
                    ? payload.module 
                    : `${pointerPrefix}${payload.module}`

                const mod = moduleLoader.loadModule(module, payload.location)    
                const val = mod instanceof Promise
                    ? mod.then(exports => loadValue(payload, exports))
                    : loadValue(payload, mod)

                return val
            }
        }

        function finalize(payload: any) {
            const result = resolveWorker(payload)
            objectCache.set(o, result)

            const symbols = resolve(payload.symbols)
            if (result instanceof Promise) {
                const r2 = result.then(x => addSymbols(x, payload, symbols, preserveId, context))
                // BUG: `resolve(payload.symbols)` could get a stale result if it's dependent on `o`
                objectCache.set(o, r2)

                return r2
            }
    
            return addSymbols(result, payload, symbols, preserveId, context)
        }

        const isReference = payload.id !== undefined && payload.valueType === undefined
        const resolvedPayload = resolve(isReference ? dataTable[payload.id] : payload)
        if (resolvedPayload instanceof Promise) {
            return resolvedPayload.then(finalize)
        }

        return finalize(resolvedPayload)
    }

    const resolved = resolve(value)

    // Fulfill late bindings
    for (const [k, v] of lateBindings.entries()) {
        const obj = resolveCache.get(k)
        if (!obj) {
            throw new Error('Expected late bound object to exist')
        }

        const val = (typeof v.value === 'number' || typeof v.value === 'string')
            ? { [moveableStr]: dataTable[v.value] }
            : v.value

        obj[v.key] = resolve(val)
    }

    return resolved
}

export const objectId = Symbol.for('synapse.objectId')

// The current impl. of symbols fails to handle unregistered symbols
// Well-known symbols provided by v8 e.g. Symbol.iterator are not in
// the global symbol registry, so this statement is true:
// Symbol.for('Symbol.iterator') !== Symbol.iterator
function hydrateSymbol(name: string, globals = globalThis) {
    if (name.startsWith('Symbol.')) {
        const prop = name.slice('Symbol.'.length)
        if ((globals.Symbol as any)[prop]) {
            return (globals.Symbol as any)[prop]
        }
    }

    return Symbol.for(name)
}

function addSymbols(obj: any, payload: any, symbols?: any, preserveId?: boolean, globals = globalThis) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
        return obj
    }

    // FIXME: the re-hydration procedure is not symmetric unless we add a proxy here
    // (but this might not be problematic)
    if (!Object.isExtensible(obj)) {
        return obj
    }

    if (symbols !== undefined) {
        delete symbols['synapse.objectId'] // This symbol is meant to be transient

        const hydratedSymbols = Object.fromEntries(
            Object.entries(symbols).map(([k, v]) => [hydrateSymbol(k, globals), v])
        )

        Object.assign(obj, hydratedSymbols)
    }

    if (preserveId) {
        return Object.assign(obj, { [objectId]: payload.id })
    }

    // Don't add the payload back unless it's a function or a binding
    const isBinding = typeof payload.id === 'string' && payload.id.startsWith('b:')
    if (payload.valueType !== 'function' && !isBinding) {
        return obj
    }

    if (isBinding) {
        return Object.assign(obj, {
            [Symbol.for("symbolId")]: {
                // `id` will be re-generated if this object gets serialized again
            }
        })
    }

    return Object.assign(obj, { [moveable]: () => ({ ...payload, id: undefined }) })
}

// Terraform stores attributes with `_` instead of json so we need to normalize them
const capitalize = (s: string) => s ? s.charAt(0).toUpperCase().concat(s.slice(1)) : s
function normalize(str: string) {
    const [first, ...rest] = str.split('_')

    return [first, ...rest.map(capitalize)].join('')
}

export function normalizeTerraform(obj: any): any {
    if (typeof obj !== 'object' || !obj) {
        return obj
    }

    if (Array.isArray(obj)) {
        return obj.map(normalizeTerraform)
    }

    if (obj[pointerSymbol]) {
        return obj
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
        // Don't normalize everything
        if (k === moveableStr) {
            res[k] = v
        } else {
            res[normalize(k)] = normalizeTerraform(v)
        }
    }

    return res
}

