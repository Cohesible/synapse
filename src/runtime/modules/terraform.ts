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

enum ExpressionKind {
    NumberLiteral,
    Reference,
    PropertyAccess,
    ElementAccess,
    Call
}

interface Expression {
    readonly kind: ExpressionKind
}

interface NumberLiteral extends Expression {
    readonly kind: ExpressionKind.NumberLiteral
    readonly value: number
}

interface ReferenceExpression extends Expression {
    readonly kind: ExpressionKind.Reference
    readonly target: Entity
}

interface CallExpression extends Expression {
    readonly kind: ExpressionKind.Call
    readonly target: string
    //readonly arguments: Expression[]
    readonly arguments: any[]
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

function isProxy(o: any) {
    return !!o && (typeof o === 'object' || typeof o === 'function') && !!Reflect.getOwnPropertyDescriptor(o, moveable2)
}

function unwrapProxy(o: any): any {
    if (isProxy(o)) {
        return unwrapProxy(o[unproxy])
    }

    return o
}

function isJsonSerializeable(o: any, visited = new Set<any>()): boolean {
    if (visited.has(o)) {
        return false
    }
    visited.add(o)

    if (typeof o === 'symbol' || typeof o === 'bigint') {
        return false
    }
    if (typeof o === 'function') { 
        return isCustomSerializeable(o)
    }
    if (typeof o !== 'object' || o === null || isCustomSerializeable(o)) {  // `undefined` is only implicitly serializeable
        return true
    }
    if (Array.isArray(o)) {
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

const TypedArray = Object.getPrototypeOf(Uint8Array)

function isObjectOrNullPrototype(proto: any) {
    return proto === Object.prototype || proto === null || proto.constructor?.name === 'Object'
}

export function isGeneratedClassConstructor(o: any) {
    if (Object.prototype.hasOwnProperty.call(o, terraformClassKey)) {
        return true
    }

    const proto = Object.getPrototypeOf(o)
    if (proto && Object.prototype.hasOwnProperty.call(proto, terraformClassKey)) {
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

const unproxy = Symbol.for('unproxy')
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

function renderDataPointer(pointer: DataPointer) {
    const { hash, storeHash } = pointer.resolve()
            
    return renderCallExpression({
        kind: ExpressionKind.Call,
        target: 'markpointer',
        arguments: [hash, storeHash],
    })
}

function renderEntity(entity: Entity) {
    return `${entity.kind === 'data-source' ? 'data.' : ''}${entity.type}.${entity.name}`
}

export function isRegExp(o: any): o is RegExp {
    return o instanceof RegExp || (typeof o === 'object' && !!o && 'source' in o && Symbol.match in o)
}

function renderObjectLiteral(obj: any, raw = false): string {
    const entries = Object.entries(obj).filter(([_, v]) => v !== undefined)

    return `{${entries.map(([k, v]) => `${renderLiteral(k)} = ${raw ? v : renderLiteral(v)}`).join(', ')}}`
}

type Ref = { [Symbol.toPrimitive]: () => string }

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

    // Legacy
    'Example',
    'ExampleData',
])

export function createSerializer(
    serialized: State['serialized'] = new Map(), 
    tables: State['tables'] = new Map()
) {
    const moduleIds = new Map<string, number>() // Used to track reference bindings per-module

    const objectTable = new Map<any, { id: string; name: string, ref: Ref, ctx: Context }>()
    const refCounter = new Map<string, number>()

    const hashes = new Map<string, string>()
    function getHash(ctx: Context) {
        const prefix = `${ctx.moduleId}:${ctx.testContext?.id ?? ''}`
        if (hashes.has(prefix)) {
            return hashes.get(prefix)!
        }

        const hash = require('node:crypto')
            .createHash('sha1')
            .update(prefix)
            .digest('hex')
            .slice(0, 16)
        
        hashes.set(prefix, hash)

        return hash
    }

    const idTable = new Map<string, number>()
    function generateId(ctx: Context) {
        const prefix = getHash(ctx)
        const count = (idTable.get(prefix) ?? 0) + 1
        idTable.set(prefix, count)

        return `${prefix}_${count}`                
    }

    const depsStack: Set<string>[] = []
    function addDep(id: string, name: string, ctx: Context) {
        if (depsStack.length > 0) {
            depsStack[depsStack.length - 1].add(id)
        } else {
            ctx.dataTable[id] = `\${local.${name}}`
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

        const id = generateId(ctx)
        const name = `d_${id}`
        const ref = renderEntity({ type: 'local', kind: 'resource', name })
        tables.set(ctx, { name, ref })

        return ref
    }

    function incRefCount(o: any, ctx: Context) {
        if (!objectTable.has(o)) {
            throw new Error(`Object was never registered: ${o}`)
        }

        const { id, name, ref } = objectTable.get(o)!
        addDep(id, name, ctx)

        // Self-reference, we have to inline a reference here instead of using the ref counter
        // 
        // This means the current object is no longer directly serializeable without the
        // object being self-referenced included in its serialization
        // if (scopes.includes(id)) {
        //     return { [`@@${moveable.description!}`]: { id, valueType: 'reference' } }
        // }

        const refCount = refCounter.get(name)!
        refCounter.set(name, refCount + 1)

        return ref
    }

    function getId(obj: any, ctx: Context) {
        if (objectTable.has(obj)) {
            throw new Error(`Unexpected duplicate "getId" call`)
        }

        // IMPORTANT: the `id` is determined when the object is first serialized
        // as opposed to when the object is created (the ideal). In most situations
        // this works fine, though it's still possible to see unexpected changes.

        // const id = objectTable.size
        const id = generateId(ctx)
        const name = `o_${id}`
        const ref = getReference(id, ctx)
        objectTable.set(obj, { id, name, ref, ctx })
        refCounter.set(name, 1)
        addDep(id, name, ctx)

        return { id, ref }
    }

    function getReference(id: number | string, ctx: Context, lateBound = false) {
        function resolve(type?: string) {
            const { obj, name, refCount, isMoveable, idOverride } = serialized.get(id)!
            // TODO: just never inline? this is buggy
            // or we can resolve all call expressions before synth
            if (refCount <= 1 && !isMoveable) {
                return obj[Symbol.toPrimitive](type)
            }

            // The latebound ref is a bare id and should not be treated as a config object
            if (lateBound && type === 'object') {
                return undefined
            }

            if (lateBound) {
                return idOverride ?? id
            }

            if (!isMoveable) {
                // This is an itsy bitsy hack to force multiple references to an array to be shared
                if (Array.isArray(obj.val)) {
                    return renderLiteral({ [`@@${moveable.description!}`]: { id: idOverride ?? id } })
                }
                return `local.${name}`
            }

            return renderLiteral({ [`@@${moveable.description!}`]: { id: idOverride ?? id } })
        }

        return { [Symbol.toPrimitive]: resolve }
    }

    function getLateBoundRef(o: any, ctx: Context) {
        if (!objectTable.has(o)) {
            throw new Error(`Object was never registered: ${o}`)
        }

        const { id } = objectTable.get(o)!

        return getReference(id, ctx, true)
    }

    class DataClass {
        static [terraformClassKey] = 'local'
        constructor(public readonly val: any, data: { encoded: any, isMoveable: boolean, deps: string[], idOverride?: string }) {
            if (!objectTable.get(val)) {
                throw new Error(`Object was never registered: ${data}`)
            }

            const { id, name, ctx } = objectTable.get(val)!

            if (serialized.has(id)) {
                throw new Error(`Object was created more than once`)
            }

            const inlineVal = data.isMoveable
                ? { [`@@${moveable.description!}`]: data.encoded }
                : data.encoded

            const state = {
                name, 
                type: 'local',
                state: data.encoded,  
                kind: 'resource' as const,
                ...ctx,
            }

            const entity = createEntityProxy(this, state, {})
            const proxy = new Proxy(entity, {
                get: (_, prop) => {
                    if (prop === Symbol.toPrimitive) {
                        return (type?: string) => type === 'object' ? inlineVal : renderLiteral(inlineVal)
                    }

                    return entity[prop]
                }
            })

            serialized.set(id, {
                ctx,
                name,
                obj: proxy,
                deps: data.deps,
                isMoveable: data.isMoveable,
                idOverride: data.idOverride,
                get refCount() {
                    return refCounter.get(name) ?? 1
                }
            })    

            return proxy
        }
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

            let isMoveable = true
            let idOverride: string | undefined
            new DataClass(unproxied, {
                encoded: serializeData(),
                isMoveable,
                idOverride,
                deps: Array.from(depsStack.pop()!),
            })
    
            serializeStack.pop()

            return ref
    
            function serializeData(): any {
                if (Array.isArray(obj)) {
                    isMoveable = false
    
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
                                return {
                                    id,
                                    valueType: 'object',
                                    properties: val, // FIXME: doesn't handle extra props
                                    constructor: serialize(obj.constructor),
                                }
                            }
        
                            isMoveable = false
        
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
                        isMoveable = false
    
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
                            isMoveable = false
                            
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
                            const ref = getLateBoundRef(unproxied, ctx)
    
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

                    // isMoveable = false
    
                    // return serializeObjectLiteral(obj)
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
    
                if (typeof obj === 'function') {
                    if (obj.name === 'Object' && Object.keys(Object).every(k => Object.prototype.hasOwnProperty.call(obj, k))) {
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
    
            const finalDesc = (serializeSym in obj && typeof obj[serializeSym] === 'function') 
                ? obj[serializeSym](decomposed) 
                : decomposed

            return {
                id,
                valueType: 'object',
                properties: serializeObjectLiteral(finalDesc.properties),
                constructor: serialize(finalDesc.__constructor),
                prototype: serialize(finalDesc.__prototype),
                descriptors: serializeObjectLiteral(finalDesc.descriptors),
                __privateFields: serializeObjectLiteral(finalDesc.__privateFields),
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
    
            new DataClass(obj, {
                encoded: {
                    id,
                    valueType: 'reflection',
                    operations: [
                        ...thisArg.operations,
                        { type: 'get', property: 'for' },
                        { type: 'apply', args: [desc], thisArg }
                    ]
                },
                isMoveable: true,
                deps: Array.from(depsStack.pop()!),
            })
    
            return ref
        }
    
        function serialize(obj: any): any {
            if (obj === null) {
                return obj
            }

            if (isDataPointer(obj)) {
                return `\${${renderDataPointer(obj)}}`
            }
    
            switch (typeof obj) {
                case 'object':
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
    serialize: (obj: any) => string
    getTable: () => string
}

function renderLiteral(obj: any, isEncoding = false, serializer?: Serializer): string {
    if (Array.isArray(obj)) {
        return `[${obj.map(x => renderLiteral(x, isEncoding, serializer)).join(', ')}]`
    }

    if (typeof obj === 'string') {
        // This is awful...
        const pattern = /([^]*[^$]?)\$\{(.*)\}([^]*)/g
        let res: string = ''
        let match: RegExpExecArray | null
        while (match = pattern.exec(obj)) {
            res += JSON.stringify(match[1]).slice(1, -1) + `\${${match[2]}}` + JSON.stringify(match[3]).slice(1, -1)
        }
        if (res) return '"' + res + '"'

        return JSON.stringify(obj)
    }

    if (typeof obj === 'number') {
        return String(obj)
    }

    if (typeof obj === 'boolean') {
        return obj ? 'true' : 'false'
    }

    if (obj === null) {
        return 'null'
    }

    // Not correct
    if (obj === undefined) {
        return 'null'
    }

    if (isRegExp(obj)) {
        return JSON.stringify(`/${obj.source}/`)
    }

    if (isDataPointer(obj)) {
        return renderDataPointer(obj)
    }

    if (serializer && isEncoding) {
        return serializer.serialize(obj)
    }

    if (expressionSym in obj) {
        return render((obj as any)[expressionSym])
    }

    if (Object.prototype.hasOwnProperty.call(obj, Symbol.toPrimitive)) {
        return obj[Symbol.toPrimitive]('string')
    }

    if (typeof obj === 'function') {
        throw new Error(`Unable to render function: ${obj.toString()}`)
    }

    if (typeof obj === 'symbol') {
        throw new Error(`Unable to render symbol: ${obj.toString()}`)
    }

    return renderObjectLiteral(obj)
}

function renderCallExpression(expression: CallExpression, serializer?: Serializer) {
    if (expression.target === 'serialize') {
        const captured = renderLiteral(expression.arguments[0], true, serializer)

        return renderObjectLiteral({
            captured,
            table: serializer?.getTable(),
            __isDeduped: true,
        }, true)
    }

    const target = expression.target === 'encoderesource' ? 'jsonencode' : expression.target
    const isEncoding = expression.target === 'encoderesource'
    const args = expression.arguments.map(x => renderLiteral(x, isEncoding, serializer))

    return `${target}(${args.join(', ')})` 
}

function render(expression: Expression, serializer?: Serializer): string {
    switch (expression.kind) {
        case ExpressionKind.Reference:
            return renderEntity((expression as ReferenceExpression).target)
        case ExpressionKind.PropertyAccess:
            return `${render((expression as PropertyAccessExpression).expression)}.${(expression as PropertyAccessExpression).member}`
        case ExpressionKind.ElementAccess:
            return `${render((expression as ElementAccessExpression).expression)}[${render((expression as ElementAccessExpression).element)}]`
        case ExpressionKind.NumberLiteral:
            return renderLiteral((expression as NumberLiteral).value)
        case ExpressionKind.Call:
            return renderCallExpression(expression as CallExpression, serializer)    
    }
}

function createEntityProxy(original: any, state: InternalState, mappings?: Record<string, string>) {
    return createProxy({
        kind: ExpressionKind.Reference,
        target: state,
    } as any, state, mappings, original,)
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

function mapKey(key: string, mappings: Record<string, any>) {
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

export function createProxy<T = unknown>(
    expression: Expression, 
    state: InternalState | undefined, 
    mappings: Record<string, any> = {}, 
    original?: any, 
): any {
    const serializer = state?.['__serializer']

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

    return new Proxy(target, {
        get: (target, prop, receiver) => {
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

            if (prop === 'toString') {
                return () => `\${${render(expression, serializer)}}`
            }

            if (prop === 'toJSON') {
                return () => `\${${render(expression, serializer)}}`
            }

            // if (prop === 'slice') {
            // // call `substr`
            //     return () => `\${${render(expression)}}`
            // }

            if (prop === Symbol.toPrimitive) {
                return () => `\${${render(expression, serializer)}}`
            }

            if (original && Reflect.has(original, prop)) {
                return Reflect.get(original, prop, receiver)
            }

            if (typeof prop === 'symbol') {
                return target?.[prop] ?? (state as any)?.[prop]
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
                    kind: ExpressionKind.NumberLiteral,
                    value: 0,
                } }
                : expression

            const val = Number(prop)
            const exp = !isNaN(val)
                ? {
                    kind: ExpressionKind.ElementAccess,
                    expression: inner,
                    element: {
                        kind: ExpressionKind.NumberLiteral,
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

const createCallExpression = (name: string, args: any[], state?: any) => createProxy({
    kind: ExpressionKind.Call,
    target: name,
    arguments: args, // FIXME: don't use jsonencode for this
} as any, state, ((typeof args[0] === 'object' || typeof args[0] === 'function') && !!args[0] && mappingsSym in args[0]) ? (args[0] as any)[mappingsSym] : undefined)


export interface TfJson {
    readonly '//'?: Extensions
    readonly provider: Record<string, any[]>
    readonly resource: Record<string, Record<string, any>>
    readonly data:  Record<string, Record<string, any>>
    readonly terraform: { backend?: Record<string, any>, 'required_providers': Record<string, any> }
    readonly moved: { from: string, to: string }[]
    readonly locals: Record<string, any>
}

function isDefaultProviderName(name: string, type: string) {
    return name === '#default' || name === 'default' || name === type
}

function isDefaultProvider(element: TerraformElement) {
    return isDefaultProviderName(element.name, element.type)
}

// terraform: 'terraform.io/builtin/terraform',

function computeSizeTree(o: any): any {
    if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean' || o === null) {
        return String(o).length
    }

    if (typeof o !== 'object' && typeof o !== 'function') {
        return 0
    }

    if (Array.isArray(o)) {
        return o.map(computeSizeTree)
    }

    if (expressionSym in o) {
        return computeSizeTree(JSON.parse(`"${String(o)}"`))
    }

    function getSize(o: any): number {
        if (typeof o === 'number') {
            return o
        }

        if (Array.isArray(o)) {
            return o.reduce((a, b) => a + getSize(b), 0)
        }

        return o['__size']
    }

    if (typeof o === 'object') {
        let totalSize = 0
        const res: Record<string, any> = {}
        for (const [k, v] of Object.entries(o)) {
            const size = computeSizeTree(v)
            totalSize += getSize(size)
            res[k] = size
        }

        res['__size'] = totalSize

        return res
    }

    throw new Error(`Bad type: ${JSON.stringify(o)}`)
}


function escapeRegExp(pattern: string) {
    return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
}

export interface ExecutionScope {
    isNewExpression?: boolean
    callSite?: Symbol
    assignment?: Symbol
    namespace?: Symbol[]
}

export interface TerraformSourceMap {
    symbols: Symbol[]
    resources: Record<string, { scopes: { isNewExpression?: boolean; callSite: number; assignment?: number; namespace?: number[] }[] }>
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

interface MoveCommand {
    scope: string
    name: string
    type?: 'fixup'
}

// These are embedded as comments into the Terraform format
interface Extensions {
    deployTarget?: string
    secrets?: Record<string, string> // TODO: make secrets into a proper data source
    sourceMap?: TerraformSourceMap
    moveCommands?: MoveCommand[]
    synapseVersion?: string
}

function initTfJson(): TfJson {
    return {
        '//': {},
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
    addSymbols(resourceName: string, scopes: ExecutionScope[]): void
    getSourceMap(): TerraformSourceMap
}

function emitTerraformJson(
    state: State,
    sourceMapper: SourceMapper,
    hooks: { before?: SynthHook[] } = {},
): { main: TfJson } {
    const tfJson: TfJson = {
        ...initTfJson(),
    }

    const synthedSizes: Record<string, number> = {}

    const hookContext: HookContext = {
        moveResource(from, to) {
            const type = to.type
            tfJson.moved.push({
                from: type + '.' + from,
                to: type + '.' + to.name,
            })
        },
    }

    function before(element: TerraformElement) {
        if (!hooks.before) {
            return element
        }

        return hooks.before.reduce((a, b) => b(a, hookContext) ?? a, element)
    }

    const sortedResources = Array.from(state.registered.entries()).sort((a, b) => strcmp(a[0], b[0]))
    for (const [k, v] of sortedResources) {
        const element = before(v[internalState] as TerraformElement)
        element.state['module_name'] = getModuleName(element)

        const mappings = v[mappingsSym]
        const synthed = synth(element.state, mappings, element)
        const name = element.name

        // Only add symbols for resources for now. Providers/data nodes aren't as useful to show
        // without resolving them i.e. calling the provider
        const scopes = (element as InternalState).scopes
        if (scopes && element.kind === 'resource') {
            sourceMapper.addSymbols(`${element.type}.${element.name}`, scopes)
        }

        if (element.kind === 'provider') {
            if (!isDefaultProvider(element)) {
                synthed['alias'] = element.name
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

    const pruned = new Set<string>()
    const sortedSerialized = Array.from(state.serialized.entries()).sort((a, b) => strcmp(a[0] as string, b[0] as string))
    for (const [id, v] of sortedSerialized) {
        if (v.refCount > 1 || v.isMoveable) {
            const element = v.obj[internalState] as TerraformElement
            tfJson.locals[v.name] = synth(element.state, undefined, element)
        } else {
            pruned.add(id as string)
        }
    }

    if (state.tables) {
        // Merge all transitive data segments
        function merge(ctx: Context, seen = new Set<string>()): Record<string, string> {
            const m: Record<string, string> = {}
            function visit(id: string) {
                if (seen.has(id)) {
                    return
                }
                
                seen.add(id)
                const o = state.serialized.get(id)!
                for (const d of o.deps) {
                    visit(d)                    
                }
                if (!pruned.has(id)) {
                    m[o.idOverride ?? id] = `\${local.${o.name}}`
                }
            }

            for (const [k, v] of Object.entries(ctx.dataTable)) {
                visit(k)
            }

            return Object.fromEntries(Object.entries(m).sort(([a, b]) => strcmp(a[0], b[0])))
        }
        const sortedTable = Array.from(state.tables.entries()).sort((a, b) => strcmp(a[1].name, b[1].name))
        for (const [t, { name }] of sortedTable) {
            tfJson.locals[name] = merge(t)
        }
    }

    for (const [k, v] of state.backends.entries()) {
        const backend = tfJson.terraform.backend ??= {}
        backend[k] = synth(v, {})
    }

    if (state.secrets.size > 0) {
        tfJson['//']!.secrets = Object.fromEntries(state.secrets.entries())
    }

    tfJson['//']!.sourceMap = sourceMapper.getSourceMap()
    tfJson['//']!.moveCommands = moveCommands

    deleteEmptyKeys(tfJson)

    return { main: tfJson }
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

function synth(obj: any, mappings?: Record<string, any>, parent?: TerraformElement): any {
    if (isElement(obj)) {
        return obj.toString()
    }

    if (Array.isArray(obj)) {
        return obj.map(x => synth(x, mappings))
    }

    if (obj instanceof RegExp) {
        return `/${obj.source}/`
    }

    if (typeof obj !== 'object' || !obj) {
        return obj
    }

    if (isDataPointer(obj)) {
        return `\${${renderDataPointer(obj)}}`
    }

    if (Object.prototype.hasOwnProperty.call(obj, Symbol.toPrimitive)) {
        // Try serializing the target as a ref first before falling back to a literal
        const res = obj[Symbol.toPrimitive]('object')
        if (res === undefined) {
            return obj[Symbol.toPrimitive]('string')
        }

        if (typeof res === 'string') {
            return `\${${res}}`
        }

        return synth(res)
    }

    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (k === 'module_name') {
            res[k] = v
        } else if (k === 'lifecycle' && Array.isArray(v)) {
            res[k] = v.map(x => synthLifecycle(x, mappings ?? {}))
        } else if (k === 'depends_on' && Array.isArray(v) && parent) {
            res[k] = v.filter(x => expressionSym in x).map(x => render(x[expressionSym]))
        } else if (k === 'provider' && (parent?.kind === 'resource' || parent?.kind === 'data-source')) {
            if (!isElement(v)) {
                throw new Error(`Expected element value for key: ${k}`)
            }

            const element = v[internalState]
            if (!isDefaultProvider(element)) {
                res[k] = `${element.type}.${element.name}`
            }
        } else {
            res[mappings ? mapKey(k, mappings) : k] = synth(v, mappings?.[k])
        }
    }

    return res
}

function synthLifecycle(obj: any, mappings: Record<string, any>) {
    const ignoreChanges = Array.isArray(obj['ignore_changes'])
        ? obj['ignore_changes'].map(k => mapKey(k, mappings))
        : undefined

     const replaceTriggeredBy = Array.isArray(obj['replace_triggered_by'])
        ? obj['replace_triggered_by'].filter(x => expressionSym in x).map(x => render(x[expressionSym]))
        : undefined

    const hook = Array.isArray(obj['hook'])
        ? obj['hook'].map(x => {
            return {
                kind: x.kind,
                input: x.input.toString(),
                handler: x.handler.toString(),
            }
        })
        : undefined

    return {
        ...obj,
        hook,
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
    const arr = (dst as any)[indirectRefs] ??= []

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
                const ref = render(exp)
                if (!arr.includes(ref)) {
                    arr.push(ref)
                }
        }
    }

    return dst
}

const moveCommands: MoveCommand[] = []
export function move(from: string, to?: string): void {
    const scope = getScopedId()
    if (!scope) {
        throw new Error(`Failed to move "${from}": not within a scope`)
    }

    if (to) {
        moveCommands.push({
            name: from,
            scope: `${scope}--${to}`,
        })

        return
    }

    moveCommands.push({
        name: from,
        scope,
    })
}

export function fixupScope(name: string): void {
    const scope = getScopedId()
    if (!scope) {
        throw new Error(`Failed to fixup with name "${name}": not within a scope`)
    }

    moveCommands.push({
        name,
        scope,
        type: 'fixup',
    })
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

    return __getDefaultProvider(type)
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
        static [peekNameSym] = () => `${type}.${peekName(type, kind, getScopedId(true))}`

        constructor(...args: any[]) {
            const props = (typeof args[args.length - 1] !== 'string' ? args[args.length - 1] : args[args.length - 2]) ?? {}
            const csType = isSynapse ? props['type'] : undefined
            const name = typeof args[args.length - 1] === 'string' 
                ? args[args.length - 1] 
                : generateName(type, kind, getScopedId(), csType)

            if (kind === 'resource' || kind === 'data-source') {
                props['provider'] = getProviderForElement({ name, type })
            } else if (kind === 'provider') {
                Object.assign(this, props)
                // Object.defineProperty(this, Symbol.for('synapse.context'), {
                //     get: () => ({ [type]: proxy })
                // })
            }

            const state = {
                name,
                kind,
                type,
                source,
                version,
                mappings,
                state: props,
                module: getModuleId() ?? '__global',
                testContext: getTestContext(),
                scopes: globalFunctions.getScopes(),
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
    jsonencode: (obj: any) => '' as string,
    encoderesource: (obj: any) => '' as string,
    serialize: (obj: any) => ({}) as any,
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

export const Fn = createFunctions(k => (...args: any[]) => createCallExpression(k, args, { 
    ['__serializer']: getSerializer({
        moduleId: getModuleId() ?? '__global',
        testContext: getTestContext(),
        dataTable: {},
    }),
}))

// export declare function registerBeforeSynthHook(callback: SynthHook): void

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
    serialized: Map<number | string, { obj: any; name: string; refCount: number, isMoveable: boolean, ctx: Context, deps: string[]; idOverride?: string }>
    tables: Map<Context, { ref: string; name: string }>
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

let globalFunctions: {
    getState: () => State,
    getScopedId: (peek?: boolean) => string | undefined,
    getModuleId: () => string | undefined
    getProviders: () => Record<string, any[]>
    exportSymbols?: (getSymbolId: (sym: Symbol) => number) => void
    getScopes: () => ExecutionScope[]
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

function getScopedId(peek?: boolean) {
    assertInit()

    return globalFunctions.getScopedId(peek)
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

function peekName(type: string, kind: TerraformElement['kind'] | 'local', prefix?: string, suffix?: string) {
    let count = 0
    const resolvedPrefix = prefix ?? `${kind === 'provider' ? '' : `${kind}-`}${type}`
    const cleanedPrefix = resolvedPrefix.replace(/\$/g, 'S-') // XXX
    const getName = () => `${cleanedPrefix || 'default'}${suffix ? `--${suffix}` : ''}${count === 0 ? '' : `-${count}`}`
    while (getState().names.has(`${type}.${getName()}`)) count++

    return getName()

    // if (kind === 'provider' && isDefaultProviderName(finalName, type)) {
    //     return finalName
    // }

    // return 'r-' + require('crypto').createHash('sha256').update(finalName).digest('hex')
}

function generateName(type: string, kind: TerraformElement['kind'] | 'local', prefix?: string, suffix?: string) {
    const finalName = peekName(type, kind, prefix, suffix)
    getState().names.add(`${type}.${finalName}`)

    return finalName
}

export function init(
    getState: () => State,
    getScopedId: (peek?: boolean) => string | undefined,
    getModuleId: () => string | undefined,
    getProviders: () => Record<string, any[]>,
    getScopes: () => ExecutionScope[],
    exportSymbols?: (getSymbolId: (sym: Symbol) => number) => void,
) {
    globalFunctions = { 
        getState, 
        getScopedId,
        getProviders,
        getModuleId,
        getScopes,
        exportSymbols,
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

    const symbolIds = new Map<string, number>()
    function getSymbolId(symbol: Symbol) {
        const key = `${symbol.fileName}:${symbol.line}:${symbol.column}`
        if (!symbolIds.has(key)) {
            symbolIds.set(key, symbolIds.size)
            sourceMap.symbols.push(symbol)
        }

        return symbolIds.get(key)!
    }

    function addSymbols(resourceName: string, scopes: ExecutionScope[]) {
        const relevantScopes = scopes.filter(s => !!s.callSite)
        const mapped = relevantScopes.map(s => ({
            isNewExpression: s.isNewExpression,
            callSite: getSymbolId(s.callSite!),
            assignment: s.assignment ? getSymbolId(s.assignment) : undefined,
            namespace: s.namespace?.map(getSymbolId),
        }))

        if (mapped.length > 0) {
            sourceMap.resources[resourceName] = { scopes: mapped }
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
        emitTerraformJson: () => {
            if (globalFunctions.exportSymbols) {
                globalFunctions.exportSymbols(getSymbolId)
            }

            return emitTerraformJson(getState(), sourceMapper, { before: beforeSynthHooks })
        }
    }
}
