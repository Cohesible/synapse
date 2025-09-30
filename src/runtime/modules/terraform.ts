//@internal
//# moduleId = synapse:terraform

module.exports[Symbol.for('moduleIdOverride')] = 'synapse:terraform'

// --------------------------------------------------------------- //
// ------------------------- TERRAFORM --------------------------- //
// --------------------------------------------------------------- //

// https://developer.hashicorp.com/terraform/language/syntax/json#expression-mapping

interface Entity {
    readonly name: string
    readonly type: string
    readonly kind: TerraformElement['kind']
}

const enum ExpressionKind {
    Reference,
    PropertyAccess,
    ElementAccess,
    Call,
    Add,
    Literal,
    Serialize,
    BareReference,
}

interface Expression {
    readonly kind: ExpressionKind
}

interface ReferenceExpression extends Expression {
    readonly kind: ExpressionKind.Reference
    readonly target: Entity
}

interface CallExpression extends Expression {
    readonly kind: ExpressionKind.Call
    readonly target: string
    readonly arguments: any[]
}

interface SerializeExpression extends Expression {
    readonly kind: ExpressionKind.Serialize
    readonly arguments: [target: any]
    readonly serializer: Serializer
}

interface PropertyAccessExpression extends Expression {
    readonly kind: ExpressionKind.PropertyAccess
    readonly expression: Expression
    readonly member: string
}

interface ElementAccessExpression extends Expression {
    readonly kind: ExpressionKind.ElementAccess
    readonly expression: Expression
    readonly element: Expression
}

interface Literal extends Expression {
    readonly kind: ExpressionKind.Literal
    readonly value: any
}

interface BinaryExpression extends Expression {
    readonly lhs: Expression
    readonly rhs: Expression
}

interface BareReference extends Expression {
    readonly kind: ExpressionKind.BareReference 
    readonly target: ReferenceExpression | PropertyAccessExpression | ElementAccessExpression
}

// const asyncFnProto = Object.getPrototypeOf((async function() {}))

// FIXME: this cannot be trapped/captured
// const hasOwnProperty = Object.prototype.hasOwnProperty

function isNonNullObjectLike(o: any) {
    return (typeof o === 'object' || typeof o === 'function') && !!o
}

function isCustomSerializeable(o: object | Function) {
    if (moveable in o || isRegExp(o)) {
        return true
    }

    if (o.constructor && moveable in o.constructor) {
        return true
    }

    if (expressionSym in o) {
        if (!isOriginalProxy(o) || !o.constructor || isGeneratedClassConstructor(o.constructor)) {
            return true
        }
    }

    return false
}

function unwrapProxy(o: any): any {
    return globalFunctions.unwrapProxy(o)
}

function isJsonSerializeable(o: any, visited = new Set<any>()): boolean {
    switch (typeof o) {
        case 'symbol':
        case 'bigint':
            return false

        case 'boolean':
        case 'string':
        case 'number':
        case 'undefined':
            return true

        case 'object':
            if (o === null) {
                return true
            }
            // falls thru
        case 'function':
            if (visited.has(o)) {
                return false
            }
            visited.add(o)

            if (typeof o === 'function') {
                return isCustomSerializeable(o)
            }

            if (Array.isArray(o) || isCustomSerializeable(o)) {
                return true
            }

            if (!isObjectOrNullPrototype(Object.getPrototypeOf(o))) {
                return false
            }

            // This is somewhat lossy as we should only attempt to serialize 'simple' descriptors (value + writable + enumerable + configurable)
            for (const desc of Object.values(Object.getOwnPropertyDescriptors(o))) {
                if (desc.get || desc.set || !isJsonSerializeable(desc.value, visited)) {
                    return false
                }
            }

            return true
    }
}

const TypedArray = Object.getPrototypeOf(Uint8Array)

function isObjectOrNullPrototype(proto: any) {
    return proto === Object.prototype || proto === null || proto.constructor?.name === 'Object'
}

export function isGeneratedClassConstructor(o: any) {
    if (Object.hasOwn(o, terraformClassKey)) {
        return true
    }

    const proto = Object.getPrototypeOf(o)
    if (proto && Object.hasOwn(proto, terraformClassKey)) {
        return true
    }

    return false
}

export function isOriginalProxy(o: any) {
    return (o as any)[originalSym]
}

const knownSymbols: symbol[] = [Symbol.iterator, Symbol.asyncIterator]
if (Symbol.dispose) {
    knownSymbols.push(Symbol.dispose)
}
if (Symbol.asyncDispose) {
    knownSymbols.push(Symbol.asyncDispose)
}

const permissions = Symbol.for('synapse.permissions')
const browserImpl = Symbol.for('synapse.browserImpl')
const objectId = Symbol.for('synapse.objectId')
const indirectRefs = Symbol.for('synapse.indirectRefs')
export const stubWhenBundled = Symbol.for('synapse.stubWhenBundled')

const symbolId = Symbol.for('symbolId') // Used to track references when capturing
const serializeableSymbols = new Set([permissions, browserImpl, objectId, stubWhenBundled, indirectRefs, ...knownSymbols])
const reflectionType = Symbol.for('reflectionType')

function getSymbols(o: any) {
    const symbols = Object.getOwnPropertySymbols(o).filter(s => s.description).filter(s => serializeableSymbols.has(s))

    return symbols.length > 0 ? Object.fromEntries(symbols.map(s => [s.description!, o[s]])) : undefined
}

function decomposeObject(o: any, keys = new Set(Object.keys(o))): any {
    const props = Object.getOwnPropertyNames(o)
    const descriptors = Object.getOwnPropertyDescriptors(o)

    // If the object isn't unwrapped then you can get weird cases of self-references
    const actualProperties = Object.fromEntries(
        props.filter(k => keys.has(k)).map(k => [k, unwrapProxy(o)[k]])
    )

    // `prototype` is read-only for functions!!!
    // THIS DOESN'T WORK CORRECTLY
    const includePrototype = (typeof o === 'function' && isNonNullObjectLike(o.prototype) && Object.keys(o.prototype).length > 0)
    const actualDescriptors = Object.fromEntries(
        Object.entries(descriptors)
            .filter(([k]) => (keys.has(k) && !props.includes(k)) || (includePrototype && k === 'prototype'))
    )

    const prototypeSlot = Object.getPrototypeOf(o)

    return {
        __constructor: o.constructor?.name !== 'Object' ? o.constructor : undefined,
        __prototype: !isObjectOrNullPrototype(prototypeSlot) ? prototypeSlot : undefined,
        properties: Object.keys(actualProperties).length > 0 ? actualProperties : undefined,
        descriptors: Object.keys(actualDescriptors).length > 0 ? actualDescriptors : undefined,
        symbols: getSymbols(o),
    }
}

const pointerSymbol = Symbol.for('synapse.pointer')
type DataPointer = string & { hash: string; [pointerSymbol]: true; resolve(): { hash: string; storeHash: string } }
function isDataPointer(h: string): h is DataPointer {
    return typeof h === 'object' && pointerSymbol in h
}

export function isRegExp(o: any): o is RegExp {
    return o instanceof RegExp || (typeof o === 'object' && !!o && 'source' in o && Symbol.match in o)
}

type Ref = { [tableRefSym]: () => any }

interface Context {
    readonly moduleId: string
    readonly testContext?: any
    readonly dataTable: Record<string, any>
}

const serializeableResourceClasses = new Set([
    'Asset',
    'Test',
    'TestSuite',
    'Closure',
    'Custom',
    'CustomData',
])

function createLocalReference(name: string): Expression {
    return createRefExpression({ kind: 'resource', type: 'local', name })
}

function createRefExpression(target: Entity): Expression {
    const exp: ReferenceExpression = {
        kind: ExpressionKind.Reference,
        target,
    }
    ;(exp as any)[expressionSym] = exp

    return exp
}


const enum SerializationFlags {
    None = 0,
    Moveable = 1 << 0,
    Array = 1 << 1,
}

interface SerializationData {
    readonly encoded: any
    readonly flags: SerializationFlags
    readonly deps: string[]
    readonly idOverride: string | undefined
}

const tableRefSym = Symbol('tableRef')

export function createSerializer(
    serialized: State['serialized'] = new Map(), 
    tables: State['tables'] = new Map()
) {
    const moduleIds = new Map<string, number>() // Used to track reference bindings per-module

    const objectTable = new Map<any, { id: string; ref: Ref, ctx: Context; refCount: number }>()

    const crypto = require('node:crypto')
    const hashes = new Map<string, string>()
    function getHash(ctx: Context, kind: 'table' | 'object') {
        const prefix = `${kind}:${ctx.moduleId}:${ctx.testContext?.id ?? ''}`
        if (hashes.has(prefix)) {
            return hashes.get(prefix)!
        }

        const hash = crypto.hash('sha1', prefix, 'hex').slice(0, 16)
        hashes.set(prefix, hash)

        return hash
    }

    const idTable = new Map<string, number>()
    function generateId(ctx: Context, kind: 'table' | 'object') {
        const prefix = getHash(ctx, kind)
        const count = (idTable.get(prefix) ?? 0) + 1
        idTable.set(prefix, count)

        // TODO: we should mark `prefix` for deduplication when serializing
        // This would significantly reduce the size of the string table
        return `${prefix}_${count}`                
    }

    const depsStack: Set<string>[] = []
    function addDep(id: string, ctx: Context) {
        if (depsStack.length > 0) {
            depsStack[depsStack.length - 1].add(id)
        } else {
            ctx.dataTable[id] = createLocalReference(id)
        }
    }

    // Used for debugging
    const serializeStack: any[] = []
    class SerializationError extends Error {
        public readonly serializeStack = [...serializeStack]
    }

    function getTable(ctx: Context) {
        if (tables.has(ctx)) {
            return tables.get(ctx)!.ref
        }

        const name = generateId(ctx, 'table')
        const ref = createLocalReference(name)
        tables.set(ctx, { name, ref })

        return ref
    }

    function incRefCount(o: any, ctx: Context) {
        if (!objectTable.has(o)) {
            throw new Error(`Object was never registered: ${o}`)
        }

        const info = objectTable.get(o)!
        addDep(info.id, ctx)

        // Self-reference, we have to inline a reference here instead of using the ref counter
        // 
        // This means the current object is no longer directly serializeable without the
        // object being self-referenced included in its serialization
        // if (scopes.includes(id)) {
        //     return { [`@@${moveable.description!}`]: { id, valueType: 'reference' } }
        // }

        info.refCount += 1

        return info.ref
    }

    function getId(obj: any, ctx: Context) {
        if (objectTable.has(obj)) {
            throw new Error(`Unexpected duplicate "getId" call`)
        }

        // IMPORTANT: the `id` is determined when the object is first serialized
        // as opposed to when the object is created (the ideal). In most situations
        // this works fine, though it's still possible to see unexpected changes.

        const id = generateId(ctx, 'object')
        const ref = getInternalRef(id)
        objectTable.set(obj, { id, ref, ctx, refCount: 1 })
        addDep(id, ctx)

        return { id, ref }
    }

    function getInternalRef(id: string, lateBound = false) {
        function resolve() {
            const info = serialized.get(id)!

            if (lateBound) {
                return info.data.idOverride ?? id
            }

            const flags = info.data.flags

            // TODO: potentially inline this
            if (flags & SerializationFlags.Moveable) {
                return { [`@@${moveable.description!}`]: { id: info.data.idOverride ?? id } }
            }

            if (info.refCount <= 1) {
                return info.data.encoded
            }

            // This is an itsy bitsy hack to force multiple references to an array to be shared
            if (flags & SerializationFlags.Array) {
                return { [`@@${moveable.description!}`]: { id } }
            }

            return createLocalReference(id)
        }

        return { [tableRefSym]: resolve }
    }

    function getLateBoundRef(o: any) {
        if (!objectTable.has(o)) {
            throw new Error(`Object was never registered: ${o}`)
        }

        const { id } = objectTable.get(o)!

        return getInternalRef(id, true)
    }

    function addData(id: string, val: any, data: SerializationData) {
        if (serialized.has(id)) {
            throw new Error(`Object was created more than once`)
        }

        serialized.set(id, {
            data,
            element: {
                name: id,
                kind: 'resource' as const,
                type: 'local',
                state: data.encoded,  
            } as TerraformElement,
            get refCount() {
                return objectTable.get(val)!.refCount
            }
        })    
    }

    function withContext(ctx: Context) {
        function peekReflectionType(obj: any) {
            if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) {
                return
            }
    
            return obj[reflectionType]
        }
    
        function serializeObject(obj: any): any {
            const unproxied = peekReflectionType(obj) === 'global' ? obj : unwrapProxy(obj)
            if (objectTable.has(unproxied)) {    
                return incRefCount(unproxied, ctx)
            }
    
            const { id, ref } = getId(unproxied, ctx)

            depsStack.push(new Set())
            serializeStack.push(obj)

            let flags = SerializationFlags.Moveable
            let idOverride: string | undefined

            addData(id, unproxied, {
                encoded: serializeData(),
                flags,
                deps: Array.from(depsStack.pop()!),
                idOverride,
            })
    
            serializeStack.pop()

            return ref
    
            function serializeData(): any {
                if (Array.isArray(obj)) {
                    flags = SerializationFlags.Array

                    return obj.map(serialize)
                }
    
                if (isRegExp(obj)) {
                    return {
                        id,
                        valueType: 'regexp',
                        source: obj.source,
                        flags: obj.flags,
                    }
                }
    
                if (isElement(obj) && obj[internalState].type === 'synapse_resource') {
                    const subtype = obj[internalState].state.type
    
                    if (serializeableResourceClasses.has(subtype)) {
                        const exp = (obj as any)[expressionSym]
                        if (exp.kind === ExpressionKind.Reference) {
                            const val = (obj as any)[classOutputSym]

                            // Dervived classes of `ConstructClass`
                            if (obj.constructor && !isGeneratedClassConstructor(obj.constructor) && !isObjectOrNullPrototype(Object.getPrototypeOf(obj))) {
                                // Force the value into the data table.
                                //
                                // This is needed when custom resources serialize execution 
                                // state, which cannot easily be known ahead of time.
                                const properties = serialize(val)
                                
                                return {
                                    id,
                                    valueType: 'object',
                                    properties, // FIXME: doesn't handle extra props
                                    constructor: serialize(obj.constructor),
                                }
                            }
        
                            flags = SerializationFlags.None
        
                            return val
                        }
                    }
                }
    
                // TODO: maybe fail on any reflection ops over `synapse:*`
                // the built-in modules aren't serializeable although maybe they should be?
                // right now it only causes problems if a different version of the runtime is used
                // so another solution is to automatically grab the correct package version
    
                if (expressionSym in obj) {
                    const exp = (obj as any)[expressionSym]
                    if (exp.kind == ExpressionKind.Call) { // Maybe not needed
                        flags = SerializationFlags.None
    
                        return obj
                    }
    
                    if (exp.kind === ExpressionKind.Reference) {
                        const entity = exp.target as InternalState
                        if (entity.kind === 'provider') {
                            // // This is a super class
                            // if (obj.constructor && !Object.prototype.hasOwnProperty(terraformClass)) {
    
                            // }
    
                            // FIXME: generalize this pattern instead of hard-coding
                            if (entity.type === 'aws') {
                                return obj.roleArn ? { roleArn: obj.roleArn } : {}
                            }
    
                            console.log(`Unable to serialize entity of kind "provider": ${entity.type}.${entity.name}`)
                            flags = SerializationFlags.None
                            
                            // We'll dump the provider's config anyway...
                            return {} // { ...obj }
                        }
                    }
    
                    // XXX: resource fields from Terraform need to be mapped
                    return {
                        id,
                        valueType: 'resource',
                        value: obj,
                    }
                }
    
                const desc = resolveMoveableDescription(obj)
                if (desc?.type === 'direct') {
                    return serializeObjectLiteral({ ...desc.data, id })
                }
    
                if (typeof obj.constructor === 'function') {
                    const ctorDesc = resolveMoveableDescription(obj.constructor)
    
                    if (ctorDesc?.type === 'direct') {
                        return serializeFullObject(id, obj)
                    }
                }
    
                // This is a best-effort serialization...
                if (desc?.type === 'reflection') {
                    return serializeObjectLiteral({ ...desc.data, id })
                }
    
                if (isJsonSerializeable(obj)) {
                    if (symbolId in obj) {
                        const desc = obj[symbolId]
                        const boundId = getBoundSymbolId(id, desc)
                        idOverride = boundId

                        if (desc.lateBound) {
                            const key = Object.keys(obj)[0]
                            const unproxied = peekReflectionType(obj[key]) === 'global' 
                                ? obj[key]
                                : unwrapProxy(obj[key])
    
                            serialize(unproxied)
                            const ref = getLateBoundRef(unproxied)
    
                            return {
                                id: boundId,
                                valueType: 'binding',
                                value: ref,
                                key,
                            }
                        }
    
                        return serializeFullObject(boundId, obj)
                    }
    
                    return serializeFullObject(id, obj)
                }
    
                if (typeof obj === 'function') {
                    if (obj === Object) {
                        return {
                            id,
                            valueType: 'reflection',
                            operations: [
                                { type: 'global' },
                                { type: 'get', property: 'Object' }
                            ]
                        }
                    }
    
                    if (obj === Uint8Array) {
                        return {
                            id,
                            valueType: 'reflection',
                            operations: [
                                { type: 'global' },
                                { type: 'get', property: 'Uint8Array' }
                            ]
                        }
                    }
    
                    if (obj === TypedArray) {
                        return {
                            id,
                            valueType: 'reflection',
                            operations: [
                                { type: 'global' },
                                { type: 'get', property: 'Object' },
                                { type: 'get', property: 'getPrototypeOf' },
                                { type: 'apply', args: [serialize(Uint8Array)] }
                            ]
                        }
                    }

                    throw new SerializationError(`Failed to serialize function: ${obj.toString()}`)
                }
    
                if (obj instanceof Map) {
                    return {
                        id,
                        valueType: 'reflection',
                        operations: [
                            { type: 'global' },
                            { type: 'get', property: 'Map' },
                            { type: 'construct', args: [Array.from(obj.entries()).map(serialize)] },
                        ]
                    }
                }
    
                if (obj instanceof Set) {
                    return {
                        id,
                        valueType: 'reflection',
                        operations: [
                            { type: 'global' },
                            { type: 'get', property: 'Set' },
                            { type: 'construct', args: [Array.from(obj.values())] },
                        ]
                    }
                }
    
                if (obj instanceof Uint8Array) {
                    return {
                        id,
                        valueType: 'reflection',
                        operations: [
                            { type: 'global' },
                            { type: 'get', property: 'Uint8Array' },
                            { type: 'construct', args: [Array.from(obj.values())] },
                        ]
                    }
                }

                // Serialized WeakMaps and WeakSets will drop all entries
                if (obj instanceof WeakMap) {
                    return {
                        id,
                        valueType: 'reflection',
                        operations: [
                            { type: 'global' },
                            { type: 'get', property: 'WeakMap' },
                            { type: 'construct', args: [] },
                        ]
                    }
                }

                if (obj instanceof WeakSet) {
                    return {
                        id,
                        valueType: 'reflection',
                        operations: [
                            { type: 'global' },
                            { type: 'get', property: 'WeakSet' },
                            { type: 'construct', args: [] },
                        ]
                    }
                }

                return serializeFullObject(id, obj)
            }
        }
    
        function resolveMoveableDescription(obj: any) {
            const symbols = getSymbols(obj)
            const direct = typeof obj[moveable] === 'function' ? obj[moveable]() : undefined
            const reflection = typeof obj[moveable2] === 'function' ? obj[moveable2]() : undefined
    
            if ((!direct && reflection)) {
                const desc = symbols ? { symbols, ...reflection } : reflection
    
                return { type: 'reflection' as const, data: desc }
            }
    
            if (direct) {
                const desc = symbols ? { symbols, ...direct } : direct
    
                return { type: 'direct' as const, data: desc }
            }
        }
    
        function serializeObjectLiteral(obj: any) {
            if (!obj) {
                return
            }

            // `Object.keys` is the fastest way to iterate over an object in v8
            // For whatever reason, it also appears to make `Object.entries` faster
            // after v8 optimizes the code.
            const r: any = {}
            for (const k of Object.keys(obj)) {
                r[k] = serialize(obj[k])
            }
            return r
        }
    
        function serializeFullObject(id: number | string, obj: any) {
            const decomposed = decomposeObject(obj)
    
            // Note: `prototype` refers to [[prototype]] here
            const ctor = decomposed.__constructor ?? decomposed.__prototype?.constructor
            if (ctor && moveable in ctor) {
                delete decomposed['__prototype']
                ;(decomposed as any).__constructor = ctor
            }
    
            const finalDesc = typeof obj[serializeSym] === 'function'
                ? obj[serializeSym](decomposed) 
                : decomposed

            return {
                id,
                valueType: 'object',
                properties: serializeObjectLiteral(finalDesc.properties),
                constructor: serialize(finalDesc.__constructor),
                prototype: serialize(finalDesc.__prototype),
                descriptors: serializeObjectLiteral(finalDesc.descriptors),
                privateFields: serialize(finalDesc.privateFields),
                symbols: serializeObjectLiteral(finalDesc.symbols),
            }
        }
    
        function getBoundSymbolId(id: number | string, desc: { id?: number; origin?: string }) {
            // This object was rehydrated, use the reference id
            if (!desc.id || !desc.origin) {
                return `b:${id}`
            }
    
            if (!moduleIds.has(desc.origin)) {
                moduleIds.set(desc.origin, moduleIds.size)
            }
    
            const moduleId = moduleIds.get(desc.origin)!
    
            return 'b:' + (desc.id << 8) + (moduleId & 0xFF) // TODO: make this better
        }
    
        function serializeSymbol(obj: symbol) {
            // COPY-PASTED
            if (objectTable.has(obj)) {
                return incRefCount(obj, ctx)
            }
    
            const desc = obj.description
            if (!desc) {
                throw new SerializationError(`Unable to capture symbol without a description: ${obj.toString()}`)
            }
    
            const { id, ref } = getId(obj, ctx)
    
            const thisArg = {
                valueType: 'reflection',
                operations: [
                    { type: 'global' },
                    { type: 'get', property: 'Symbol' }
                ]
            }

            depsStack.push(new Set())
    
            addData(id, obj, {
                encoded: {
                    id,
                    valueType: 'reflection',
                    operations: [
                        ...thisArg.operations,
                        { type: 'get', property: 'for' },
                        { type: 'apply', args: [desc], thisArg }
                    ]
                },
                flags: SerializationFlags.Moveable,
                deps: Array.from(depsStack.pop()!),
                idOverride: undefined,
            })
    
            return ref
        }
    
        function serialize(obj: any): any {
            switch (typeof obj) {
                case 'object':
                    if (obj === null || isDataPointer(obj)) {
                        return obj
                    }

                    // falls thru
                case 'function':
                    return serializeObject(obj)
    
                case 'symbol':
                    return serializeSymbol(obj)
    
                default:
                    return obj
            }
        }
    
        return { serialize, getTable: () => getTable(ctx) }
    }

    return { 
        withContext,
        serialized,
        tables,
    }
}

interface Serializer {
    serialize: (obj: any) => any
    getTable: () => Expression
}

function createEntityProxy(original: any, state: InternalState, mappings?: Record<string, string>) {
    return createProxy({
        kind: ExpressionKind.Reference,
        target: state,
    } as any, state, mappings, original)
}

export const internalState = Symbol.for('internalState')
const expressionSym = Symbol.for('expression')
const mappingsSym = Symbol.for('mappings')
export const moveable = Symbol.for('__moveable__')
const moveable2 = Symbol.for('__moveable__2')

export const originalSym = Symbol.for('original')
const serializeSym = Symbol.for('serialize')

interface TerraformElementBase {
    readonly name: string
    readonly type: string
    readonly state: any
    readonly module: string
    readonly mappings?: Record<string, any>
}

interface TerraformResourceElement extends TerraformElementBase {
    readonly kind: 'resource'
}

interface TerraformDataSourceElement extends TerraformElementBase {
    readonly kind: 'data-source'
}

interface TerraformLocalElement extends TerraformElementBase {
    readonly kind: 'local'
}

interface TerraformProviderElement extends TerraformElementBase{
    readonly kind: 'provider'
    readonly source: string
    readonly version: string
}

export type TerraformElement = 
    | TerraformProviderElement
    | TerraformResourceElement 
    | TerraformDataSourceElement
    | TerraformLocalElement

function mapKey(key: string, mappings?: Record<string, any>) {
    if (!mappings) {
        return key
    }

    if (key in mappings) {
        const map = mappings[key]
        const val = typeof map === 'object' ? map[''] : map
        
        return val === '' ? toSnakeCase(key) : val
    }

    return key
}

function createTfExpression() {
    const terraformExpression = function () {}
    ;(terraformExpression as any)[internalState] = true
    ;(terraformExpression as any)[expressionSym] = true
    ;(terraformExpression as any)[mappingsSym] = true

    return terraformExpression
}

// This may hurt perf on containing strings because they can be treated as two-byte strings
const expressionMarker = '\u039BexpMarker\u039B'
const renderedExpressions = new Map<string, Expression>()

export function createProxy<T = unknown>(
    expression: Expression, 
    state: InternalState | undefined, 
    mappings: Record<string, any> = {}, 
    original?: any, 
): any {
    // We cache all created proxies to ensure referential equality
    const proxies = new Map<PropertyKey, any>()
    function createInnerProxy(key: PropertyKey, expression: Expression) {
        if (proxies.has(key)) {
            return proxies.get(key)
        }

        const isPropertyAccess = expression.kind === ExpressionKind.PropertyAccess && typeof key === 'string'
        const childMappings = isPropertyAccess ? mappings[key] : mappings
        const inner = createProxy(expression, state, childMappings)
        proxies.set(key, inner)

        return inner
    }

    const target = original ? original : createTfExpression()

    let renderedIndex: number

    function toString() {
        if (renderedIndex !== undefined) {
            return `\${${expressionMarker}${renderedIndex}}`
        }

        renderedIndex = renderedExpressions.size

        const rendered = `${renderedIndex}`
        renderedExpressions.set(rendered, expression)

        return `\${${expressionMarker}${rendered}}`
    }

    return new Proxy(target, {
        get: (target, prop, receiver) => {
            if (typeof prop === 'symbol') {
                if (prop === internalState) {
                    return state
                }
    
                if (prop === expressionSym) {
                    return expression
                }
    
                if (prop === mappingsSym) {
                    return mappings
                }
    
                if (prop === originalSym) {
                    return original
                }

                if (prop === Symbol.toPrimitive) {
                    return toString
                }

                if (original && Reflect.has(original, prop)) {
                    return Reflect.get(original, prop, receiver)
                }
    
                return target?.[prop] ?? (state as any)?.[prop]
            }

            if (prop === 'toString' || prop === 'toJSON') {
                return toString
            }

            // if (prop === 'slice') {
            // // call `substr`
            //     return () => `\${${render(expression)}}`
            // }

            if (original && Reflect.has(original, prop)) {
                return Reflect.get(original, prop, receiver)
            }

            // Terraform doesn't allow expressions on providers
            // But we support accessing the initial configuration of a provider
            if (state?.kind === 'provider') {
                return undefined
            }

            // `mappings['_']` contains type info
            // `1` means we need to automatically index it
            // Obfuscation isn't the goal here. The values used minimizes generated code size.
            const inner = mappings['_'] === 1
                ? { kind: ExpressionKind.ElementAccess, expression, element: {
                    kind: ExpressionKind.Literal,
                    value: 0,
                } }
                : expression

            const val = Number(prop)
            const exp = !isNaN(val)
                ? {
                    kind: ExpressionKind.ElementAccess,
                    expression: inner,
                    element: {
                        kind: ExpressionKind.Literal,
                        value: val,
                    }
                }
                : {
                    kind: ExpressionKind.PropertyAccess,
                    expression: inner,
                    member: mapKey(prop, mappings),
                }

            return createInnerProxy(prop, exp) 
        },
        apply: (target, thisArg, argArray) => {
            const args = thisArg !== undefined
                ? [thisArg, ...argArray]
                : argArray

            return createCallExpression((expression as PropertyAccessExpression).member, args, state)
        },
        has: (target, prop) => {
            if (prop === internalState || prop === expressionSym || prop === mappingsSym || prop === originalSym) {
                return true
            }

            // if (typeof prop === 'string' && mappings[prop]) {
            //     return true
            // }

            if (!original) {
                return false
            }

            return Reflect.has(original, prop)
        },

        // This would only work with statically known props
        // ownKeys: (target) => {
        //     return Array.from(new Set([
        //         internalState,
        //         expressionSym,
        //         mappingsSym,
        //         originalSym,
        //         ...(Object.keys(mappings)),
        //         ...(original ? Reflect.ownKeys(original) : [])
        //     ]))
        // }
        // getOwnPropertyDescriptor: (target, prop) => {
        //     if (prop === internalState || prop === expressionSym || prop === mappingsSym || prop === originalSym) {
        //         return { value: true, configurable: true, enumerable: true }
        //     }

        //     if (original) {
        //         return Object.getOwnPropertyDescriptor(original, prop)
        //     }
        // },
    })
}

function maybeGetMappings(obj: any) {
    if ((typeof obj !== 'object' && typeof obj !== 'function') || !obj) {
        return
    }

    return obj[mappingsSym]
}

function maybeGetExpression(obj: any): Expression | undefined {
    if ((typeof obj !== 'object' && typeof obj !== 'function') || !obj) {
        return
    }

    return obj[expressionSym]
}

const createCallExpression = (name: string, args: any[], state?: any) => createProxy({
    kind: ExpressionKind.Call,
    target: name,
    arguments: args, // FIXME: don't use jsonencode for this
} as any, state, maybeGetMappings(args[0]))


export interface TfJson {
    readonly provider: Record<string, any[]>
    readonly resource: Record<string, Record<string, any>>
    readonly data:  Record<string, Record<string, any>>
    readonly terraform: { backend?: Record<string, any>, 'required_providers': Record<string, any> }
    readonly moved: { from: string, to: string }[]
    readonly locals: Record<string, any>
    
    '//'?: TemplateMetadata
}

function isDefaultProviderName(name: string, type: string) {
    return name === 'default' || name === type
}

function isDefaultProvider(element: TerraformElement) {
    return isDefaultProviderName(element.name, element.type)
}

export function getResourceId(obj: any) {
    if (!isElement(obj)) {
        return
    }
    
    const state = obj[internalState]
    if (!state?.name || !state.type || state.kind !== 'resource') {
        return
    }

    return `${state.type}.${state.name}`
}

export interface HookContext {
    moveResource(from: string, to: TerraformResourceElement): void
}

export type SynthHook = (element: TerraformElement, context: HookContext) => TerraformElement | void

export interface Symbol {
    name: string
    line: number // 0-indexed
    column: number // 0-indexed
    fileName: string
    specifier?: string // specific to the consumer
    packageRef?: string // normalized ref
}

export interface ExecutionScope {
    callSite?: Symbol
    assignment?: Symbol
    namespace?: Symbol[]
    // This can generally be derived from the symbol location, we add 
    // it here to further decouple from the source
    declaration?: Symbol[]
    isNewExpression?: boolean
}

interface IndexedScope {
    callSite: number
    assignment?: number
    namespace?: number[]
    declaration?: number[]
    isNewExpression?: boolean
}

export interface TerraformSourceMap {
    symbols: Symbol[]
    resources: Record<string, Record<string, { scopes: IndexedScope[] }>>
}

export interface PackageInfo {
    readonly type: 'npm' | 'cspm' | 'synapse-provider' | 'file' | 'jsr' | 'synapse-tool' | 'spr' | 'github'
    readonly name: string
    readonly version: string
    readonly packageHash?: string // Only relevant for `synapse`
    readonly os?: string[]
    readonly cpu?: string[]
    readonly resolved?: {
        readonly url: string
        readonly integrity?: string
    }
}

export interface TerraformPackageManifest {
    roots: Record<string, ResolvedDependency>
    packages: Record<string, PackageInfo>
    dependencies: Record<string, Record<string, ResolvedDependency>>
}

interface ResolvedDependency {
    readonly package: number
    readonly versionConstraint: string
}

// This is added as a separate object beneath the root template
export interface TemplateMetadata {
    deployTarget?: string
    secrets?: Record<string, string> // TODO: make secrets into a proper data source
    sourceMap?: TerraformSourceMap
    synapseVersion?: string

    // `null` is used to represent accesses when the var was undefined
    envVarHashes?: Record<string, string | null>
}

function initTfJson(): TfJson {
    return {
        provider: {},
        resource: {},
        data: {},
        terraform: { required_providers: {} },
        moved: [],
        locals: {},
    }
}

// MUTATES
function deleteEmptyKeys<T extends object>(obj: T): Partial<T> {
    for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && Object.keys(v).length === 0) {
            delete (obj as any)[k]
        }
    }

    return obj
}

function getModuleName(element: InternalState) {
    const moduleId = element.module
    const testSuiteId = element.testContext?.id

    return `${moduleId}${testSuiteId !== undefined ? `#test-suite=${testSuiteId}` : ''}`
}

function strcmp(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0
}

interface SourceMapper {
    addSymbols(resourceType: string, resourceName: string, scopes: ExecutionScope[]): void
    getSourceMap(): TerraformSourceMap
}

export interface EmitResult {
    finalize: (extraMetadata?: Partial<TemplateMetadata>) => {
        json: TfJson & { metadata?: TemplateMetadata }
        binary: Buffer
    }
}

function emitTerraformJson(
    state: State,
    sourceMapper: SourceMapper,
): EmitResult {
    const tfJson: TfJson = {
        ...initTfJson(),
    }

    const sortedResources = Array.from(state.registered.entries()).sort((a, b) => strcmp(a[0], b[0]))
    for (const [k, v] of sortedResources) {
        const element = v[internalState] as TerraformElement
        if (element.kind === 'resource') {
            element.state['module_name'] = getModuleName(element)
        }
        const mappings = v[mappingsSym]
        const synthed = finalize(element.state, mappings, element)
        const name = element.name

        // Only add symbols for resources for now. Providers/data nodes aren't as useful to show
        // without resolving them i.e. calling the provider
        const scopes = (element as InternalState).scopes
        if (scopes && element.kind === 'resource') {
            sourceMapper.addSymbols(element.type, name, scopes)
        }

        if (element.kind === 'provider') {
            if (!isDefaultProvider(element)) {
                synthed['alias'] = name
            }

            tfJson.provider[element.type] ??= []
            tfJson.provider[element.type].push(synthed)

            if (!tfJson.terraform.required_providers[element.type]) {
                tfJson.terraform.required_providers[element.type] = { 
                    source: element.source,
                    // version?
                }
            }
        }
        if (element.kind === 'resource') {
            const resources = tfJson.resource[element.type] ??= {}
            resources[name] = synthed
        }
        if (element.kind === 'data-source') {
            const sources = tfJson.data[element.type] ??= {}
            sources[name] = synthed
        }
    }

    // Prune all refs that were inlined
    const pruned = new Set<string>()
    const sortedSerialized = Array.from(state.serialized.entries()).sort((a, b) => strcmp(a[0] as string, b[0] as string))
    for (const [id, v] of sortedSerialized) {
        if (v.refCount > 1 || (v.data.flags & SerializationFlags.Moveable)) {
            tfJson.locals[id] = finalize(v.element.state)
        } else {
            pruned.add(id as string)
        }
    }

    if (state.tables) {
        // Merge all transitive data segments
        function merge(ctx: Context, seen = new Set<string>()): Record<string, Expression> {
            const m: Record<string, Expression> = {}
            function visit(id: string) {
                if (seen.has(id)) {
                    return
                }
                
                seen.add(id)
                const { data } = state.serialized.get(id)!
                for (const d of data.deps) {
                    visit(d)                    
                }
                if (!pruned.has(id)) {
                    m[data.idOverride ?? id] = createLocalReference(id)
                }
            }

            for (const [k, v] of Object.entries(ctx.dataTable)) {
                visit(k)
            }

            return Object.fromEntries(Object.entries(m).sort((a, b) => strcmp(a[0], b[0])))
        }

        const sortedTable = Array.from(state.tables.entries()).sort((a, b) => strcmp(a[1].name, b[1].name))
        for (const [t, { name }] of sortedTable) {
            tfJson.locals[name] = merge(t)
        }
    }

    for (const [k, v] of state.backends.entries()) {
        const backend = tfJson.terraform.backend ??= {}
        backend[k] = finalize(v, {})
    }

    const metadata: TemplateMetadata = {}

    if (state.secrets.size > 0) {
        metadata.secrets = Object.fromEntries(state.secrets.entries())
    }

    metadata.sourceMap = sourceMapper.getSourceMap()

    deleteEmptyKeys(tfJson)

    function finalizeTemplate(extraMetadata?: Partial<TemplateMetadata>) {
        for (const [k, v] of Object.entries(extraMetadata ?? {})) {
            (metadata as any)[k] = v
        }

        const sorted = Object.fromEntries(Object.entries(metadata).sort((a, b) => strcmp(a[0], b[0])))
        tfJson['//'] = sorted

        const binary = createBinarySerializer().serialize(tfJson)

        return {
            binary,
            json: tfJson,
        }
    }

    return { finalize: finalizeTemplate }
}

const uncapitalize = (s: string) => s ? s.charAt(0).toLowerCase().concat(s.slice(1)) : s
function toSnakeCase(str: string) {
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

export function isElement(o: unknown): o is { [internalState]: TerraformElement } {
    return (
        !!o &&
        (typeof o === 'object' || typeof o === 'function') &&
        internalState in o &&
        typeof o[internalState] === 'object'
    )
}

export function getClassKey(o: unknown): string | undefined {
    if (typeof o !== 'function') {
        return
    }

    const base = (o as any)[terraformClassKey]
    if (base !== 'resource.synapse_resource.Custom') {
        return base
    }

    const usertype = (o as any)[customClassKey]

    return usertype ? `${base}.${usertype}` : base
}

const getElementKey = (element: Entity & { module?: string }) => `${element.module ?? 'global'}_${element.kind}_${element.type}_${element.name}`

// INTERNAL ONLY
export function overrideId(o: any, id: string) {
    if (!isElement(o)) {
        throw new Error(`Object is not a terraform element`)
    }

    const s = o[internalState]
    const key = getElementKey(s)
    const r = getState().registered.get(key)
    if (!r) {
        throw new Error(`Resource not found within current state: ${s.type}.${s.name}`)
    }

    getState().registered.delete(key)
    Object.assign(s, { name: id })
    getState().registered.set(getElementKey(s), r)

    return o
}

function finalize(obj: any, mappings?: Record<string, any>, parent?: TerraformElement): any {
    const exp = maybeGetExpression(obj)
    if (exp) {
        if (exp.kind === ExpressionKind.Serialize) {
            doSerialize(exp as SerializeExpression)
        }

        return obj
    }

    if (typeof obj !== 'object' || !obj) {
        return obj
    }

    if (Array.isArray(obj)) {
        return obj.map(x => finalize(x, mappings))
    }

    if (obj[tableRefSym] || isDataPointer(obj) || obj instanceof RegExp) {
        return obj
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (k === 'module_name') {
            res[k] = v
        } else if (k === 'lifecycle' && Array.isArray(v)) {
            res[k] = v.map(x => finalizeLifecycle(x, mappings))
        } else if (k === 'depends_on' && Array.isArray(v) && parent) {
            res[k] = v.filter(x => expressionSym in x)
        } else if (k === 'provider' && (parent?.kind === 'resource' || parent?.kind === 'data-source')) {
            if (!isElement(v)) {
                throw new Error(`Expected element value for key: ${k}`)
            }

            const element = v[internalState]
            if (!isDefaultProvider(element)) {
                res[k] = createRefExpression({ kind: 'provider', type: element.type, name: element.name })
            }
        } else {
            res[mapKey(k, mappings)] = finalize(v, mappings?.[k])
        }
    }

    return res
}

function finalizeLifecycle(obj: any, mappings?: Record<string, any>) {
    const ignoreChanges = Array.isArray(obj['ignore_changes'])
        ? obj['ignore_changes'].map(k => mapKey(k, mappings))
        : undefined

     const replaceTriggeredBy = Array.isArray(obj['replace_triggered_by'])
        ? obj['replace_triggered_by'].filter(x => expressionSym in x)
        : undefined

    return {
        ...obj,
        ignore_changes: ignoreChanges,
        replace_triggered_by: replaceTriggeredBy,
    }
}

export function updateResourceConfiguration<T extends object>(obj: T, fn: (obj: T) => void): void {
    updateResourceConfigurationWorker(obj, fn)
}

// We recursively search the object, applying the changes to any resource found
// Does not apply to resources within arrays
function updateResourceConfigurationWorker(obj: any, fn: (obj: any) => void, visited = new Set<any>()) {
    if ((typeof obj !== 'function' && typeof obj !== 'object') || !obj || Array.isArray(obj) || visited.has(obj)) {
        return
    }

    visited.add(obj)
    if (internalState in obj && typeof (obj as any)[internalState] === 'object') {
        fn(obj[internalState].state)
    }

    for (const v of Object.values(obj)) {
        updateResourceConfigurationWorker(v, fn, visited)
    }
}

export function getAllResources(obj: any, keepExpressions = false, exclude?: Set<any>, visited = new Set<any>()): any[] {
    if ((typeof obj !== 'function' && typeof obj !== 'object') || !obj || visited.has(obj)) {
        return []
    }

    visited.add(obj)
    if (Array.isArray(obj)) {
        return obj.map(x => getAllResources(x, keepExpressions, exclude, visited)).reduce((a, b) => a.concat(b), [])
    }

    if (internalState in obj && typeof (obj as any)[internalState] === 'object') {
        if ((!keepExpressions && !(obj as any)[originalSym]) || exclude?.has(obj)) {
            return []
        }

        return [obj]
    }

    return getAllResources(Array.from(Object.values(obj)), keepExpressions, exclude, visited)
}

function getExcludeSet(exclude: Iterable<any>) {
    const resources = [...exclude].flatMap(r => getAllResources(r, true))

    return new Set(resources)
}

export function addIndirectRefs<T extends Record<PropertyKey, any> | Function>(dst: T, src: any, exclude?: Iterable<any>) {
    const arr: BareReference[] = (dst as any)[indirectRefs] ??= []

    if (typeof src === 'function' && src[moveable]) {
        arr.push(src)
        return dst
    }

    const excludeSet = exclude ? getExcludeSet(exclude) : undefined
    const resources = getAllResources(src, true, excludeSet)
    for (const r of resources) {
        const exp = r[expressionSym] as Expression
        switch (exp.kind) {
            case ExpressionKind.Reference:
            case ExpressionKind.ElementAccess:
            case ExpressionKind.PropertyAccess:
                if (!arr.find(e => e.target === exp)) {
                    arr.push({
                        kind: ExpressionKind.BareReference,
                        target: exp as any,
                    })
                }
        }
    }

    return dst
}

function getTestContext() {
    const contexts = getProviders()
    const testSuite = contexts['test-suite']?.[0]
    if (testSuite && typeof testSuite.id !== 'string' && typeof testSuite.id !== 'number') {
        throw new Error(`Test context is missing an "id" field`)
    }

    return testSuite as { id: string | number }
}

function getTerraformProviders(): Record<string, { [internalState]: TerraformElement }[]> {
    return Object.fromEntries(
        Object.entries(getProviders()).map(
            ([k, v]) => [k, v.filter(isElement).filter(x => x[internalState].kind === 'provider')]
        )
    )
}

declare var __getDefaultProvider: (type: string) => any | undefined
function getDefaultProvider(type: string) {
    if (typeof __getDefaultProvider === 'undefined') {
        return
    }

    // We need to enter the provider context
    const p = __getDefaultProvider(type)
    if (p !== undefined) {
        getProviders()[type] ??= [p]
    }

    return p
}

declare var __registerProvider: (cls: new () => any) => boolean
function registerProvider(cls: new () => any) {
    if (typeof __registerProvider === 'undefined') {
        return false
    }

    return __registerProvider(cls)
}

function getProviderForElement(element: { name: string, type: string }) {
    const allProviders = getTerraformProviders()
    const elementProviderType = element.type.split('_').shift()!

    const slotted = allProviders[elementProviderType]
    const matched = slotted?.[0] ?? getDefaultProvider(elementProviderType)
    if (!matched) {
        throw new Error(`No provider found for element: ${element.name} (${element.type})`)
    }

    return matched
}

interface InternalState {
    module?: string
    name: string
    type: string
    kind: TerraformElement['kind']
    mappings?: Record<string, any>
    version?: string
    source?: string
    state: any // This is the resource state
    scopes?: { callSite?: Symbol; assignment?: Symbol; namespace?: Symbol[] }[]
    testContext?: any
    __serializer?: Serializer
}

export const peekNameSym = Symbol('peekName')

export function createTerraformClass<T = any>(
    type: string, 
    kind: TerraformElement['kind'], 
    mappings?: Record<string, any>,
    version?: string,
    source?: string,
): new (...args: any[]) => T {
    const isSynapse = type === 'synapse_resource'

    const c = class {
        static [terraformClassKey] = `${kind}.${type}`
        static [peekNameSym] = () => `${type}.${getScopedId(type, kind, undefined, true)}`

        constructor(props: any = {}) {
            const name = getScopedId(type, kind, isSynapse ? props['type'] : undefined)

            if (kind === 'resource' || kind === 'data-source') {
                props['provider'] = getProviderForElement({ name, type })
            } else if (kind === 'provider') {
                Object.assign(this, props)
            }

            const state = {
                name,
                kind,
                type,
                source,
                version,
                mappings,
                state: props,
                module: kind === 'resource' ? (getModuleId() ?? '__global') : undefined,
                testContext: kind === 'resource' ? getTestContext() : undefined,
                scopes: kind === 'resource' ? globalFunctions.getScopes() : undefined,
            }

            const proxy = createEntityProxy(this, state, mappings)
            getState().registered.set(getElementKey(state), proxy)

            return proxy
        }
    } as any

    if (kind === 'provider') {
        Object.defineProperty(c, Symbol.for('synapse.contextType'), { 
            value: type,
            enumerable: true,
        })

        registerProvider(c)
    }

    return c
}

export const classOutputSym = Symbol('classOutput')

export function createSynapseClass<T, U>(
    type: string,
    kind: 'resource' | 'data-source' | 'provider' = 'resource'
): { new (config: T): U } {
    const tfType = kind === 'provider' ? 'synapse' : 'synapse_resource'

    const cls = class extends createTerraformClass(tfType, kind) {
        static [terraformClassKey] = `${kind}.${tfType}.${type}`
        static [peekNameSym] = () => `${kind === 'data-source' ? 'data.' : ''}${tfType}.${getScopedId(tfType, kind, type, true)}`

        public constructor(config: T) {
            if (kind === 'provider') {
                super(config)

                return
            }

            super({ type, input: config })

            const _this = this

            return new Proxy(_this, {
                get: (target, prop, recv) => {
                    if (prop === classOutputSym) {
                        return _this.output
                    }

                    if (Reflect.has(target, prop) || typeof prop === 'symbol') {
                        return Reflect.get(target, prop, recv)
                    }
    
                    return _this.output[prop]
                },
            })
        }
    }

    return Object.defineProperty(cls, 'name', { 
        value: type, 
        writable: false, 
        configurable: true, 
        enumerable: false 
    }) as any
}

const functions = {
    // This is a special function which is not actually rendered as a function
    serialize: (obj: any) => ({}) as any,
    jsonencode: (obj: any) => '' as string,
    jsondecode: (str: string) => ({}) as any,
    dirname: (path: string) => '' as string,
    trimprefix: (target: string, prefix: string) => '' as string,
    replace: (str: string, substring: string | RegExp, replacement: string) => '' as string,
    basename: (str: string) => '' as string,
    abspath: (str: string) => '' as string,
    substr: (str: string, offset: number, length: number) => '' as string,
    element: <T>(arr: T[], index: number) => ({}) as T,
    tolist: <T>(arr: T[]) => ({}) as T[],
    generateidentifier: (targetId: string, attribute: string, maxLength: number, sep?: string) => '' as string,
}

const serializeExps = new Map<SerializeExpression, { result?: { captured: any, table: any, __isDeduped: true } }>()

function doSerialize(exp: SerializeExpression) {
    if (serializeExps.get(exp)?.result) {
        return serializeExps.get(exp)!.result
    }

    const captured = exp.serializer.serialize(exp.arguments[0])
    const table = exp.serializer.getTable()
    const result = { captured, table, __isDeduped: true } as const
    serializeExps.set(exp, { result })

    return result
}

export const Fn = createFunctions(k => {
    if (k !== 'serialize') {
        return (...args: any[]) => createCallExpression(k, args)
    }
    
    return (...args: any[]) => {
        if (args.length !== 1) {
            throw new Error(`Serialize requires 1 argument`)
        }

        const serializer = getSerializer({
            moduleId: getModuleId() ?? '__global',
            testContext: getTestContext(),
            dataTable: {},
        })

        const exp: SerializeExpression = {
            kind: ExpressionKind.Serialize,
            serializer,
            arguments: args as [any],
        }

        serializeExps.set(exp, {})

        return createProxy(exp as Expression, undefined, maybeGetMappings(args[0]))        
    }
})

function createFunctions(factory: <T extends keyof typeof functions>(name: T) => (typeof functions)[T]): typeof functions {
    return Object.fromEntries(
        Object.keys(functions).map(k => [k, factory(k as any)])
    ) as typeof functions
}

export interface State {
    registered: Map<string, any>
    backends: Map<string, any>
    moved: { from: string, to: string }[]
    names: Set<string>
    serialized: Map<number | string, { element: TerraformElement; refCount: number, data: SerializationData }>
    tables: Map<Context, { ref: Expression; name: string }>
    serializers: Map<string, ReturnType<typeof createSerializer>>
    secrets: Map<string, string>
}

// Currently placed in the registry for `permissions.ts`
const terraformClassKey = Symbol.for('synapse.terraformClassKey')
export function isProviderClass(o: any) {
    if (typeof o !== 'function') {
        return false
    }

    return o[terraformClassKey]?.startsWith('provider')
}

export const customClassKey = Symbol('customClassKey')

export function getResourceName(r: any): string {
    if (!isElement(r)) {
        throw new Error('Not a resource')
    }

    return r[internalState].name
}

let globalFunctions: {
    getState: () => State,
    getScopedId: (type: string, kind: TerraformElement['kind'], suffix?: string, peek?: boolean) => string,
    getModuleId: () => string | undefined
    getProviders: () => Record<string, any[]>
    getScopes: () => ExecutionScope[]
    unwrapProxy: (o: any, checkPrototype?: boolean) => any
}

function assertInit() {
    if (typeof globalFunctions === 'undefined') {
        throw new Error(`Cannot be called outside of the compiler`)
    }
}

function getState() {
    assertInit()

    return globalFunctions.getState()
}

function getScopedId(type: string, kind: TerraformElement['kind'], suffix?: string, peek?: boolean) {
    assertInit()

    return globalFunctions.getScopedId(type, kind, suffix, peek)
}

function getProviders() {
    assertInit()

    return globalFunctions.getProviders()
}

function getModuleId() {
    assertInit()

    return globalFunctions.getModuleId()
}

const defaultSerializerName = 'default'
function getSerializer(ctx: Context) {
    const serializers = getState().serializers
    if (serializers.has(defaultSerializerName)) {
        return serializers.get(defaultSerializerName)!.withContext(ctx)
    }

    const serializer = createSerializer(getState().serialized, getState().tables)
    serializers.set(defaultSerializerName, serializer)

    return serializer.withContext(ctx)
}

export function init(
    getState: () => State,
    getScopedId: (type: string, kind: TerraformElement['kind'], suffix?: string, peek?: boolean) => string,
    getModuleId: () => string | undefined,
    getProviders: () => Record<string, any[]>,
    getScopes: () => ExecutionScope[],
    unwrapProxy: (o: any, checkPrototype?: boolean) => any
) {
    globalFunctions = { 
        getState, 
        getScopedId,
        getProviders,
        getModuleId,
        getScopes,
        unwrapProxy,
    }

    function registerBackend(type: string, config: any) {
        getState().backends.set(type, config)
    }
    
    function getResources(moduleName: string, includeTests = false) {
        const r: any[] = []
        for (const [k, v] of getState().registered) {
            const element = v[internalState] as InternalState
            if (element.testContext?.id !== undefined && !includeTests) {
                continue
            }
            if (element.module === moduleName) {
                r.push(v)
            }
        }

        return r
    }

    const beforeSynthHooks: SynthHook[] = []
    function registerBeforeSynthHook(...callbacks: SynthHook[]) {
        beforeSynthHooks.push(...callbacks)
    }

    function registerSecret(envVar: string, type: string) {
        getState().secrets.set(envVar, type)
    }

    const sourceMap: TerraformSourceMap = {
        symbols: [],
        resources: {}
    }

    const symbolIds = new Map<Symbol, number>()
    function getSymbolId(symbol: Symbol) {
        if (!symbolIds.has(symbol)) {
            const id = symbolIds.size
            symbolIds.set(symbol, id)
            sourceMap.symbols.push(symbol)

            return id
        }

        return symbolIds.get(symbol)!
    }

    function addSymbols(resourceType: string, resourceName: string, scopes: ExecutionScope[]) {
        const mapped = scopes.filter(s => !!s.callSite).map(s => ({
            isNewExpression: s.isNewExpression,
            callSite: getSymbolId(s.callSite!),
            assignment: s.assignment ? getSymbolId(s.assignment) : undefined,
            namespace: s.namespace?.map(getSymbolId),
            declaration: s.declaration?.map(getSymbolId),
        }))

        if (mapped.length > 0) {
            const byType = sourceMap.resources[resourceType] ??= {}
            byType[resourceName] = { scopes: mapped }
        }
    }

    const sourceMapper: SourceMapper = {
        addSymbols,
        getSourceMap: () => sourceMap,
    }

    return {
        getResources,
        registerSecret,
        registerBackend,
        registerBeforeSynthHook,
        emitTerraformJson: () => emitTerraformJson(getState(), sourceMapper)
    }
}

function quote(s: string) {
    // TODO: handle already escaped quotes...
    const escaped = s.replaceAll('"', '\\"')

    return `"${escaped}"`
}

function renderResourceIdPart(part: string) {
    if (part.includes('.')) {
        return quote(part)
    }

    return part
}

const enum ValueKind {
    _,
    Boolean,
    Null,
    u32,
    i32,
    u64,
    i64,
    f64,
    String,
    EmptyString,
    RegExp,
    Object,
    Array,
    Identifier,
    CallExpression,
    PropertyAccess,
    ElementAccess,
    AddExpression,
}

function createBinarySerializer() {
    const strings = new Map<string, number>()
    function indexString(s: string) {
        if (strings.has(s)) {
            return strings.get(s)!
        }

        const index = strings.size
        strings.set(s, index)

        return index
    }

    // FIXME: don't use a fixed buffer, either find the size ahead of time or dynamically resize
    let offset = 0
    let buf = Buffer.allocUnsafe(4 * 1024 * 1024)

    function writeSized(writer: () => void) {
        offset += 4
        const start = offset
        writer()
        buf.writeUint32LE(offset - start, start - 4)
    }

    function writeObject(obj: Record<string, any>) {
        writeKind(ValueKind.Object)
        writeSized(() => {
            const entries = Object.entries(obj).filter(([_, v]) => v !== undefined)
            buf.writeUInt32LE(entries.length, offset)
            offset += 4
    
            for (const [k, v] of entries) {
                // FIXME: `k` can be an expression rather than a raw string
                writeIndexedString(k)
                writeValue(v)
            }
        })
    }

    function writeArrayInner(arr: any[]) {
        buf.writeUInt32LE(arr.length, offset)
        offset += 4

        for (const el of arr) {
            writeValue(el)
        }    
    }

    function writeArray(arr: any[]) {
        writeKind(ValueKind.Array)
        writeSized(() => {
            writeArrayInner(arr)
        })
    }

    function maybeWriteExpressions(s: string) {
        const maybeExpressions = s.split(`\${${expressionMarker}`)   
        if (maybeExpressions.length === 1) {
            return false
        }

        const cleaned = [maybeExpressions[0]]
        const expressions: Expression[] = []
        for (let i = 1; i < maybeExpressions.length; i++) {
            const rightBrace = maybeExpressions[i].indexOf('}')
            if (rightBrace === -1) {
                throw new Error(`Missing right brace: ${maybeExpressions[i]} [source: ${s}]`)
            }

            const index = maybeExpressions[i].slice(0, rightBrace)
            expressions.push(renderedExpressions.get(index)!)
            cleaned.push(maybeExpressions[i].slice(rightBrace + 1))
        }

        if (cleaned[0] === '' && cleaned.length === 1 && expressions.length === 1) {
            writeExpression(expressions[0])

            return true
        }


        let lhs: BinaryExpression = {
            kind: ExpressionKind.Add,
            lhs: { kind: ExpressionKind.Literal, value: cleaned[0] } as Literal,
            rhs: expressions[0]
        }

        // TODO: prune empty strings
        for (let i = 1; i < cleaned.length; i++) {
            const n1 = {
                kind: ExpressionKind.Add,
                lhs,
                rhs: { kind: ExpressionKind.Literal, value: cleaned[i] } as Literal,
            }

            lhs = n1

            if (expressions[i]) {
                const n2 = {
                    kind: ExpressionKind.Add,
                    lhs,
                    rhs: expressions[i]
                }

                lhs = n2
            }
        }

        writeExpression(lhs)

        return true
    }

    function writeString(s: string) {
        if (maybeWriteExpressions(s)) {
            return
        }

        if (s === '') {
            return writeKind(ValueKind.EmptyString)
        }

        writeStringChecked(s)
    }

    function writeStringChecked(s: string) {
        writeKind(ValueKind.String)
        writeIndexedString(s)
    }

    const i32Threshold = -(2**31)
    const u32Threshold = 2**32

    function writeNumber(n: number) {
        if (!Number.isInteger(n)) {
            writeKind(ValueKind.f64)
            buf.writeDoubleLE(n, offset)
            offset += 8
            return
        }

        if (n < 0) {
            if (n >= i32Threshold) {
                writeKind(ValueKind.i32)
                buf.writeInt32LE(n, offset)
                offset += 4
                return
            }

            writeKind(ValueKind.i64)

            buf.writeIntLE(n, offset, 6)
            buf.writeUInt16LE(0xFFFF, offset + 6)
            offset += 8
        } else {
            if (n < u32Threshold) {
                writeKind(ValueKind.u32)
                buf.writeUint32LE(n, offset)
                offset += 4
                return
            }

            writeKind(ValueKind.u64)

            buf.writeUIntLE(n, offset, 6)
            buf.writeUInt16LE(0, offset + 6)
            offset += 8
        }
    }

    function writeIndexedString(s: string) {
        buf.writeUInt32LE(indexString(s), offset)
        offset += 4
    }

    function writeKind(kind: ValueKind) {
        buf[offset] = kind
        offset += 1
    }

    function writeCallExpression(name: string, args: any[]) {
        writeKind(ValueKind.CallExpression)
        writeSized(() => {
            writeIndexedString(name)
            writeArrayInner(args)
        })
    }

    function writeReference(exp: ReferenceExpression) {
        writeKind(ValueKind.PropertyAccess)
        writeSized(() => {
            if (exp.target.kind === 'data-source') {
                writePropertyAccess('data', exp.target.type)
            } else {
                writeKind(ValueKind.Identifier)
                writeIndexedString(exp.target.type)
            }
    
            writeIndexedString(exp.target.name)
        })
    }

    function writePropertyAccess(exp: string | Expression, member: string) {
        writeKind(ValueKind.PropertyAccess)
        writeSized(() => {
            if (typeof exp === 'string') {
                writeKind(ValueKind.Identifier)
                writeIndexedString(exp)
            } else {
                writeExpression(exp)
            }
            writeIndexedString(member)
        })
    }

    function writeElementAccess(exp: any, element: any) {
        writeKind(ValueKind.ElementAccess)
        writeSized(() => {
            writeExpression(exp)
            writeExpression(element)
        })
    }

    function writeAddExpression(lhs: Expression, rhs: Expression) {
        writeKind(ValueKind.AddExpression)
        writeSized(() => {
            writeExpression(lhs)
            writeExpression(rhs)
        })
    }

    function writeSerialization(exp: SerializeExpression) {
        writeValue(doSerialize(exp))
    }

    function isBareReferenceTarget(exp: Expression): exp is BareReference['target'] {
        switch (exp.kind) {
            case ExpressionKind.Reference:
            case ExpressionKind.ElementAccess:
            case ExpressionKind.PropertyAccess:
                return true
        }

        return false
    }

    function writeBareReference(exp: BareReference) {
        const parts: string[] = []

        let current: BareReference['target'] = exp.target

        loop: while (true) {
            switch (current.kind) {
                case ExpressionKind.Reference:
                    parts.unshift(current.target.type, current.target.name)
                    break loop

                case ExpressionKind.ElementAccess:
                case ExpressionKind.PropertyAccess:
                    const target = (current as PropertyAccessExpression | ElementAccessExpression).expression
                    if (!isBareReferenceTarget(target)) {
                        return
                    }

                    current = target
                    break
            }
        }

        if (parts.length === 0) {
            return
        }

        writeStringChecked(parts.join('.'))
    }

    function writeExpression(exp: Expression): void {
        switch (exp.kind) {
            case ExpressionKind.Call:
                return writeCallExpression((exp as CallExpression).target, (exp as CallExpression).arguments)
            case ExpressionKind.Reference:
                return writeReference((exp as ReferenceExpression))
            case ExpressionKind.PropertyAccess:
                return writePropertyAccess((exp as PropertyAccessExpression).expression, (exp as PropertyAccessExpression).member)
            case ExpressionKind.ElementAccess:
                return writeElementAccess((exp as ElementAccessExpression).expression, (exp as ElementAccessExpression).element)
            case ExpressionKind.Add:
                return writeAddExpression((exp as BinaryExpression).lhs, (exp as BinaryExpression).rhs)
            case ExpressionKind.Literal:
                return writeValue((exp as Literal).value)
            case ExpressionKind.Serialize:
                return writeSerialization(exp as SerializeExpression)
            case ExpressionKind.BareReference:
                return writeBareReference(exp as BareReference)
        }
    }
    
    function writeObjectLike(v: any): void {
        const exp = maybeGetExpression(v)
        if (exp) {
            return writeExpression(exp)
        }

        if (Array.isArray(v)) {
            return writeArray(v)
        }
    
        if (isRegExp(v)) {
            writeKind(ValueKind.RegExp)
            return writeIndexedString(v.source)
        }

        if (isDataPointer(v)) {
            const { hash, storeHash } = v.resolve()

            return writeCallExpression('markpointer', [hash, storeHash])
        }

        if (v[tableRefSym]) {
            return writeValue(v[tableRefSym]())
        }

        if (typeof v === 'function') {
            throw new Error(`Failed to serialize function: ${v.toString()}`)
        }

        return writeObject(v)
    }

    function writeValue(v: any) {
        if (v === null || v === undefined) {
            return writeKind(ValueKind.Null)
        }

        switch (typeof v) {
            case 'object':
            case 'function':        
                return writeObjectLike(v)
            case 'string':
                return writeString(v)
            case 'number':
                return writeNumber(v)
            case 'boolean':
                writeKind(ValueKind.Boolean)
                buf[offset] = v ? 1 : 0
                offset += 1
                break
            
            case 'bigint': // TODO
            case 'symbol':
                throw new Error(`Not serializeable: ${typeof v}`)
        }
    }
    
    function encodeStringTable() {
        let totalSize = 0
        const encoded: Buffer[] = []
        for (const [k, v] of strings) {
            encoded[v] = Buffer.from(k)
            totalSize += encoded[v].byteLength + 4 // 4 bytes for the length
        }

        return { encoded, totalSize }
    }

    const version = 1

    function serialize(obj: any) {
        writeValue(obj)

        const { encoded, totalSize } = encodeStringTable()

        const numStrings = encoded.length
        const finalBuf = Buffer.allocUnsafe(totalSize + offset + 4 + 4)

        // `version` is the low byte, remaining 3 are reserved
        finalBuf.writeUint32LE(version)
        let offset2 = 4

        finalBuf.writeUint32LE(numStrings, offset2)
        offset2 += 4

        for (const b of encoded) {
            finalBuf.writeUint32LE(b.byteLength, offset2)
            offset2 += 4
            finalBuf.set(b, offset2)
            offset2 += b.byteLength
        }

        finalBuf.set(buf.subarray(0, offset), offset2)

        return finalBuf
    }

    return { serialize }
}

export function serializeAsJson(obj: any) {
    const serialized: State['serialized'] = new Map()
    const serializer = createSerializer(serialized).withContext({
        moduleId: '',
        dataTable: {},
    })

    function unwrap(obj: any): any {
        if ((typeof obj !== 'function' && typeof obj !== 'object') || !obj) {
            return obj
        }

        if (isElement(obj)) {
            return unwrap(obj[internalState].state)
        }

        if (obj[tableRefSym]) {
            return unwrap(obj[tableRefSym]())
        }

        if (isDataPointer(obj)) {
            return obj
        }

        if (Array.isArray(obj)) {
            return obj.map(unwrap)
        }

        const res: Record<string, any> = {}
        for (const k of Object.keys(obj)) {
            res[k] = unwrap(obj[k])
        }

        return res
    }

    const captured = unwrap(serializer.serialize(obj))
    const table: Record<string, any> = {}
    for (const [k, v] of serialized) {
        if (v.refCount > 1 || (v.data.flags & SerializationFlags.Moveable)) {
            table[k] = unwrap(v.element.state)
        }
    }
    
    return { captured, table, __isDeduped: true } as const
}

export function shouldSerializeDirectly(o: any, visited = new Set<any>()): boolean {
    if (typeof o === 'function' || typeof o === 'symbol' || typeof o === 'bigint') { 
        return false
    }

    if (typeof o !== 'object' || o === null) {
        return true
    }

    if (isDataPointer(o)) {
        return true
    }

    if (visited.has(o)) {
        return false
    }
    visited.add(o)

    if (Array.isArray(o)) {
        return o.every(x => shouldSerializeDirectly(x, visited))
    }

    if (!isObjectOrNullPrototype(Object.getPrototypeOf(o))) {
        return false
    }

    // This is somewhat lossy as we should only attempt to serialize 'simple' descriptors (value + writable + enumerable + configurable)
    for (const desc of Object.values(Object.getOwnPropertyDescriptors(o))) {
        if (desc.get || desc.set || !shouldSerializeDirectly(desc.value, visited)) {
            return false
        }
    }

    return true
}
