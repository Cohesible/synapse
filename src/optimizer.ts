import ts from 'typescript'
import { type Symbol, createGraph, getContainingScope, liftScope } from './static-solver/scopes'
import { getNullTransformationContext, printNodes, toSnakeCase } from './utils'
import type { ExternalValue, ResourceValue, SerializedObject } from './runtime/modules/serdes'
import { isDataPointer } from './build-fs/pointers'
import { isModuleExport } from './permissions'

function getCapturedNodes(sf: ts.SourceFile) {
    const exportStatement = sf.statements.find(isModuleExport)
    if (!exportStatement) {
        return
    }

    const closure = exportStatement.expression.right
    if (!ts.isFunctionExpression(closure) || !ts.isBlock(closure.body)) {
        return
    }

    return closure.parameters
}

function getClassDecl(sf: ts.SourceFile) {
    const decl = sf.statements.find(ts.isFunctionDeclaration) ?? sf.statements.find(isModuleExport)?.expression.right
    const body = (decl as any)?.body
    if (!decl || !body || !ts.isBlock(body)) {
        return
    }

    return body.statements.find(ts.isClassDeclaration)
}

// It's safe to do this when a complete closure graph contains class prototypes 
// that are strictly referenced in terms of instances _and_ nothing attempts to
// call the class constructor indirectly via `<instance>.constructor` (very unlikely)
//
function pruneClassInitializers(sf: ts.SourceFile) {
    // TODO: support ESM export declarations
    const decl = sf.statements.find(ts.isFunctionDeclaration) ?? sf.statements.find(isModuleExport)?.expression.right
    const body = (decl as any)?.body
    if (!decl || !body || !ts.isBlock(body)) {
        return
    }


    const closure = body.parent as ts.FunctionExpression

    // TODO: find class expression
    const classDecl = body.statements.find(ts.isClassDeclaration)
    if (!classDecl || !classDecl.name) {
        return
    }

    function visit(node: ts.Node): ts.Node {
        if (ts.isClassDeclaration(node) && node.name && node.parent === body) {
            const pruned = node.members.filter(x => {
                if (ts.isConstructorDeclaration(x) || ts.isPropertyDeclaration(x)) {
                    return false
                }
                return true
            })

            return ts.factory.updateClassDeclaration(
                node,
                node.modifiers,
                node.name,
                node.typeParameters,
                node.heritageClauses,
                pruned
            )        
        }

        return ts.visitEachChild(node, visit, getNullTransformationContext())
    }

    const optimized = visit(sf)

    const graph = createGraph(optimized)
    const sym = graph.symbols.get(classDecl.name) ?? graph.symbols.get(classDecl)
    if (!sym || !sym.declaration) {
        throw new Error(`Missing symbol for node: ${classDecl.name?.getText()}`)
    }
    const scope = getContainingScope(sym)
    const res = liftScope(scope)

    const newCaptured = res.captured
    const captured = closure.parameters

    function visit2(node: ts.Node): ts.Node {
        if (ts.isFunctionExpression(node)) {
            return ts.factory.updateFunctionExpression(
                node,
                node.modifiers,
                node.asteriskToken,
                node.name,
                node.typeParameters,
                newCaptured.map(sym => ts.factory.createParameterDeclaration(undefined, undefined, sym.name, undefined, undefined, undefined)),
                node.type,
                node.body,
            )
        }
        return ts.visitEachChild(node, visit2, getNullTransformationContext())
    }

    const updatedCaptured = captured.map(x => !!newCaptured.find(sym => sym.name === x.getText()))

    return {
        pruned: visit2(optimized) as ts.SourceFile,
        captured: updatedCaptured,
    }
}

function resolveNewExpressions(sf: ts.SourceFile) {
    const resolved: ts.Node[] = []

    function visit(node: ts.Node): void {
        if (!ts.isNewExpression(node)) {
            return ts.forEachChild(node, visit)
        }

        resolved.push(node.expression)

        if (node.arguments) {
            for (const arg of node.arguments) {
                ts.forEachChild(arg, visit)
            }
        }
    }

    visit(sf)

    return resolved
}

const moveableStr = '@@__moveable__'

// TODO: strip out logic added to classes to make them serializable if it's not needed

// Must do two passes for removing class initializers:
// 1. Determine what things are being used as constructors (if any) + which things are classes
// 2. Prune all classes that are not used as constructors

// This optimization looks everywhere an object might appear and sees which 
// properties or methods are accessed. From there, we can build up a list of
// properties that are never used.
//
// We try to be conservative for computed element accesses. If we find such
// an expression and we cannot figure out all possible values then we assume
// any property could be accessed. 
function pruneUnusedProperties(
    table: Record<string | number, ExternalValue | any[]>, 
    captured: any,
    getSourceFile: (pointer: string) => ts.SourceFile,
) {
    function resolve(val: any) {
        if (val && typeof val === 'object') {
            if (moveableStr in val) {
                const id = val[moveableStr].id
                if (id !== undefined) {
                    return table[id]
                }
            }
        }
        return val
    }

    const skipOptimize = new Set<SerializedObject | ResourceValue>()
    const usedProps = new Map<SerializedObject | ResourceValue, Set<string>>()
    const methodCalls = new Map<SerializedObject, Set<ts.MemberName>>() // FIXME: doesn't handle symbols
    const symbols = new Map<SerializedObject, Symbol>()

    for (const [k, val] of Object.entries(table)) {
        if (Array.isArray(val) || !val.captured) continue

        const sf = getSourceFile(val.module)
        const params = getCapturedNodes(sf)
        if (!params) {
            continue
        }

        const graph = createGraph(sf)
        const symbolMap = new Map<Symbol, ExternalValue>()
        for (let i = 0; i < params.length; i++) {
            const sym = graph.symbols.get(params[i])
            if (!sym) continue

            symbolMap.set(sym, resolve(val.captured[i]))
        }

        for (const [sym, v] of symbolMap) {
            if (!v || (v.valueType !== 'object' && v.valueType !== 'resource')) continue

            const obj = v as SerializedObject | ResourceValue
            const props = usedProps.get(obj) ?? new Set()
            for (const r of sym.references) {
                const exp = r.parent
                if (ts.isPropertyAccessExpression(exp)) {
                    if (ts.isCallExpression(exp.parent)) {
                        if (exp.parent.expression === exp) {
                            if (obj.valueType === 'object' && obj.constructor) {
                                const calls = methodCalls.get(obj) ?? new Set()
                                calls.add(exp.name)
                                methodCalls.set(obj, calls)
                            } else {
                                // TODO
                            }
                        }
                        // TODO: maybe skip optimize here
    
                        continue
                    }

                    props.add(exp.name.text)
                    continue
                } else if (ts.isElementAccessExpression(exp)) {
                    if (ts.isStringLiteral(exp.argumentExpression)) {
                        props.add(exp.argumentExpression.text)
                    } else {
                        skipOptimize.add(obj)
                        break
                    }
                } else {
                    skipOptimize.add(obj)
                    break
                }
            }

            usedProps.set(obj, props)
        }
    }

    for (const [k, v] of methodCalls) {
        const ctor = resolve(k.constructor!)
        if (!ctor.module) {
            skipOptimize.add(k)
            continue
        }

        const sf = getSourceFile(ctor.module)
        // TODO: use the called method instead of looking at the whole class
        const decl = getClassDecl(sf)
        if (!decl) {
            skipOptimize.add(k)
            continue
        }

        // TODO: deal with super classes
        if (decl.heritageClauses) {
            skipOptimize.add(k)
            continue
        }

        const graph = createGraph(sf)
        const symbol = graph.symbols.get(decl)
        const thisSymbol = symbol?.parentScope?.thisSymbol
        if (!thisSymbol) {
            skipOptimize.add(k)
            continue
        }

        symbols.set(k, thisSymbol)

        const props = usedProps.get(k) ?? new Set()
        for (const ref of thisSymbol.references) {
            const exp = ref.parent
            if (ts.isPropertyAccessExpression(exp)) {
                props.add(exp.name.getText())
            } else if (ts.isElementAccessExpression(exp)) {
                if (ts.isStringLiteral(exp.argumentExpression)) {
                    props.add(exp.argumentExpression.text)
                } else {
                    skipOptimize.add(k)
                    break
                }
            } else if (ts.isCallExpression(exp)) {
                continue
            } else {
                skipOptimize.add(k)
                break
            }
        }

        usedProps.set(k, props)
    }

    function pruneResource(r: ResourceValue, props: Set<string>): ExternalValue {
        const capitalize = (s: string) => s ? s.charAt(0).toUpperCase().concat(s.slice(1)) : s
        function normalize(str: string) {
            const [first, ...rest] = str.split('_')

            return [first, ...rest.map(capitalize)].join('')
        }

        const value = { ...r.value }
        for (const k of Object.keys(value)) {
            // Terraform uses snake_case for property names
            if (!props.has(normalize(k))) {
                delete value[k]
            }
        }

        return { ...r, value } as ExternalValue
    }

    function pruneObject(obj: SerializedObject, props: Set<string>): ExternalValue {
        const properties = { ...obj.properties }
        for (const k of Object.keys(properties)) {
            if (!props.has(k)) {
                delete properties[k]
            }
        }

        return { ...obj, properties } as any as ExternalValue
    }

    const pruneableResources = new Map<SerializedObject, [key: string, value: ResourceValue]>()
    const newTable: Record<string | number, ExternalValue | any[]> = { ...table }

    function prune() {
        for (const [k, v] of usedProps) {
            if (skipOptimize.has(k)) continue
    
            if (k.valueType === 'object') {
                const pruned = pruneObject(k, v)
                for (const [k2, v2] of Object.entries((pruned as SerializedObject).properties ?? {})) {
                    if (typeof v2 === 'object' && moveableStr in v2) {
                        const id = v2[moveableStr].id
                        if (id !== undefined) {
                            const resolved = table[id]
                            if (!Array.isArray(resolved) && resolved.valueType === 'resource') {
                                pruneableResources.set(k, [k2, resolved as ResourceValue])
                            }
                        }
                    }
                }
    
                newTable[k.id] = pruned
            } else if (k.valueType === 'resource') {
                newTable[k.id] = pruneResource(k, v)
            }
        }
    }

    prune()
    usedProps.clear()

    if (pruneableResources.size > 0) {
        for (const [prop, [key, value]] of pruneableResources) {
            const sym = symbols.get(prop)?.members.get(key)
            if (!sym) continue

            // TODO: this is copy-pasted from above
            const props = usedProps.get(value) ?? new Set()
            for (const ref of sym.references) {
                const exp = ref.parent
                if (ts.isPropertyAccessExpression(exp)) {
                    props.add(exp.name.getText())
                } else if (ts.isElementAccessExpression(exp)) {
                    if (ts.isStringLiteral(exp.argumentExpression)) {
                        props.add(exp.argumentExpression.text)
                    } else {
                        skipOptimize.add(value)
                        break
                    }
                } else if (ts.isCallExpression(exp)) {
                    continue
                } else {
                    skipOptimize.add(value)
                    break
                }
            }
    
            if (props.size > 0) {
                usedProps.set(value, props)
            }
        }

        prune()
    }

    return {
        table: newTable,
        captured,
    }
}

export function optimizeSerializedData(
    table: Record<string | number, ExternalValue | any[]>, 
    captured: any,
    getSourceFile: (pointer: string) => ts.SourceFile,
    writeDataSync: (buf: Uint8Array) => string
) {
    const files = new Map<string, ts.SourceFile>()
    const _getSourceFile = (pointer: string) => {
        if (files.has(pointer)) {
            return files.get(pointer)!
        }

        const sf = getSourceFile(pointer)
        files.set(pointer, sf)

        return sf
    }

    const newExpressions = new Map<string | number, ts.Node[]>()
    const constructors = new Map<string | number, any>()
    function visitValue(id: string | number) {
        const val = table[id]
        if (Array.isArray(val)) {
            return
        }

        if (val.valueType === 'object') {
            const o = val as SerializedObject
            if (o.constructor) {
                const resolved = resolve(o.constructor)
                if (typeof resolved !== 'function') {
                    constructors.set(id, resolved)
                }
            } else if (o.prototype) {
                constructors.set(id, resolve(o.prototype))
            }
        }

        if (val.valueType !== 'function') {
            return
        }

        const module = val.module
        const sf = _getSourceFile(module)
        const exps = resolveNewExpressions(sf)
        if (exps.length > 0) {
            newExpressions.set(id, exps)
        }
    }

    for (const id of Object.keys(table)) {
        visitValue(id)
    }

    function resolve(val: any) {
        if (val && typeof val === 'object') {
            if (moveableStr in val) {
                const id = val[moveableStr].id
                if (id !== undefined) {
                    return table[id]
                }
            }
        }
        return val
    }
    
    // Now we need to evaluate the expressions to see if they match with any serialized values
    const constructed = new Map<ExternalValue, Set<ExternalValue>>()
    for (const [k, v] of newExpressions) {
        const val = table[k]
        if (Array.isArray(val) || !val.captured) continue

        const sf = v[0].getSourceFile()
        const params = getCapturedNodes(sf)
        if (!params) {
            continue
        }

        const graph = createGraph(sf)
        const symbolMap = new Map<Symbol, any>()
        for (let i = 0; i < params.length; i++) {
            const sym = graph.symbols.get(params[i])
            if (!sym) continue

            symbolMap.set(sym, val.captured[i])
        }

        for (const n of v) {
            // FIXME: we need to symbolically evaluate each expression
            // This impl. does not handle dynamic construction
            const sym = graph.symbols.get(n)
            if (!sym) {
                continue
            }

            const val = symbolMap.get(sym)
            const resolved = resolve(val)
            if (resolved) {
                const set = constructed.get(resolved) ?? new Set()
                set.add(val)
                constructed.set(resolved, set)
            }
        }
    }

    const pruned = new Map<ExternalValue, ExternalValue>()
    function canPrune(val: ExternalValue) {
        if (!maybeClasses.has(val)) {
            return false
        }

        const instantiators = constructed.get(val)
        if (instantiators && [...instantiators].filter(x => !pruned.has(x)).length > 0) {
            return false
        }

        return true
    }

    const maybeClasses = new Set(constructors.values())
    function maybePruneValue(id: string | number): ExternalValue | any[] {
        const val = table[id]
        if (Array.isArray(val) || !canPrune(val)) {
            return visit(val)
        }

        const sf = _getSourceFile(val.module)
        const optimized = pruneClassInitializers(sf)
        if (!optimized) {
            return visit(val)
        }

        const printed = printNodes(optimized.pruned.statements)
        const newData = {
            kind: 'compiled-chunk',
            runtime: Buffer.from(printed).toString('base64'),
        }

        const pointer = writeDataSync(Buffer.from(JSON.stringify(newData)))
        const res: ExternalValue = {
            ...val,
            module: pointer,
            captured: val.captured?.filter((_, i) => optimized.captured[i]),
        }
    
        pruned.set(val, res)

        return visit(res)
    }

    const newTable: Record<string | number, ExternalValue | any[]> = { ...table }
    function visit(obj: any): any {
        if (Array.isArray(obj)) {
            return obj.map(visit)
        }

        if (typeof obj !== 'object' || !obj) {
            return obj
        }

        // We won't touch these even though they might technically be a dynamically imported module
        if (isDataPointer(obj)) {
            return obj
        }

        if (moveableStr in obj) {
            const id = obj[moveableStr].id
            if (id !== undefined) {
                newTable[id] = maybePruneValue(id)
            }

            return obj
        }

        const r: Record<string, any> = {}
        for (const [k, v] of Object.entries(obj)) {
            r[k] = visit(v)
        }
        return r
    }

    const optimized = {
        table: newTable,
        captured: visit(captured),
    }

    return pruneUnusedProperties(optimized.table, optimized.captured, _getSourceFile)
}