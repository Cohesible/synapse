import ts from 'typescript'
import * as zig from './ast.zig'
import * as path from 'node:path'
import { isNonNullable, keyedMemoize } from '../utils'
import { emitChunk } from '../static-solver/utils'
import { getFs } from '../execution'

type SyntheticUnion<T extends Record<string, any>> = { [P in keyof T as 'x']: { $type: P } & T[P] }['x']

function createSyntheticUnion<T extends Record<string, any>>(obj: T): SyntheticUnion<T> {
    if ('$type' in obj) {
        return obj as any
    }

    const $type = Object.getOwnPropertyNames(obj)[0]
    const inner = (obj as any)[$type]
    Object.defineProperty(inner, '$type', { writable: false, enumerable: false, configurable: true, value: $type })

    return inner
}

interface PointerType {
    readonly type: 'pointer'
    readonly inner: ZigType
}

interface IntegerType {
    readonly type: 'integer'
    readonly width: number // 'size'
    readonly signed?: boolean
}

interface FloatType {
    readonly type: 'float'
    readonly name: (typeof floatTypes)[number]
}

interface StringType {
    readonly type: 'string'
    readonly length?: number
    readonly mutable?: boolean
    readonly nullTerminated?: boolean
}

interface NullableType {
    readonly type: 'nullable'
    readonly inner: ZigType
}

interface RecordType {
    readonly type: 'record'
    readonly fields: Record<string, ZigType>
}

interface AliasType {
    readonly type: 'alias'
    readonly name: string
}

type ZigType = 
    | StringType
    | FloatType
    | IntegerType
    | PointerType
    | NullableType
    | RecordType
    | AliasType

const floatTypes = ['f16', 'f32', 'f64', 'f80', 'f128', 'c_longdouble']

type StringTypeNode = zig.PtrType & { child_type: { ident: zig.Identifier } }

function isStringTypeNode(node: zig.Node): node is { ptr_type: StringTypeNode } {
    const n = createSyntheticUnion(node)
    if (n.$type !== 'ptr_type' || (n.size !== 'Many' && n.size !== 'Slice')) {
        return false
    }

    const c = createSyntheticUnion(n.child_type)

    return c.$type === 'ident' && c.name === 'u8'
}

function convertType(name: string): ZigType | undefined {
    if (floatTypes.includes(name)) {
        return {
            type: 'float',
            name: name as FloatType['name'],
        }
    }

    // Zig has arbitrary bit-width types (max is 65535)
    const m = name.match(/^([ui])([1-9][0-9]{0,4})$/)
    if (m) {
        return {
            type: 'integer',
            signed: m[1] === 'i',
            width: Number(m[2]),
        }
    }

    if (name === 'usize' || name === 'isize') {
        return {
            type: 'integer',
            signed: name === 'isize',
            width: -1,
        }
    }
}

function createPromiseTypeNode(inner: ts.TypeNode) {
    return ts.factory.createTypeReferenceNode('Promise', [inner])
}

function getJsImportName(node: zig.Node) {
    const n = createSyntheticUnion(node)
    if (n.$type !== 'field_access') {
        return
    }

    const target = createSyntheticUnion(n.exp)
    if (target.$type !== 'ident') {
        return
    }

    // XXX: need symbol resolution
    if (target.name !== 'js') {
        return
    }

    return n.member
}

function isJsPromise(node: zig.Node) {
    return getJsImportName(node) === 'Promise'
}

function isUtf8String(node: zig.Node) {
    return getJsImportName(node) === 'UTF8String'
}

// This type conversion assumes immutability
// Our common use-case with Zig/TypeScript interop
function toTsTypeNode(node: zig.Node): ts.TypeNode {
    const n = createSyntheticUnion(node)
    switch (n.$type) {
        case 'ident':
            if (n.name === 'void') {
                return ts.factory.createTypeReferenceNode('void')
            }

            if (n.name === 'anyopaque') {
                return ts.factory.createTypeReferenceNode('any')
            }

            if (n.name === 'bool') {
                return ts.factory.createTypeReferenceNode('boolean')
            }

            const converted = convertType(n.name)
            if (!converted) {
                return ts.factory.createTypeReferenceNode(n.name)
            }

            if (converted.type === 'integer') {
                const bigintWidth = converted.signed ? 54 : 53

                if (converted.width >= bigintWidth) {
                    return ts.factory.createUnionTypeNode([
                        ts.factory.createTypeReferenceNode('number'),
                        ts.factory.createTypeReferenceNode('bigint'),
                    ])
                }
            }

            return ts.factory.createTypeReferenceNode('number')
        case 'field_access':
            if (isUtf8String(node)) {
                return ts.factory.createTypeReferenceNode('string')
            }
        
            break
        case 'error_union':
            return toTsTypeNode(n.rhs)
        case 'ptr_type':
            if (isStringTypeNode(node)) {
                return ts.factory.createTypeReferenceNode('string')
            }

            const inner = toTsTypeNode(n.child_type)
            if (n.size === 'Many' || n.size === 'Slice') {
                return ts.factory.createArrayTypeNode(inner)
            }

            return inner
        case 'optional_type': {
            const inner = toTsTypeNode(n.child_type)

            return ts.factory.createUnionTypeNode([
                inner,
                ts.factory.createLiteralTypeNode(ts.factory.createNull())
            ])
        }
        case 'call_exp': {
            if (isJsPromise(n.exp) && n.args.length === 1) {
                return createPromiseTypeNode(toTsTypeNode(n.args[0]))
            }

            break
        }
    }

    return ts.factory.createTypeReferenceNode('any')
}

function fieldDeclToProperty(node: zig.FieldDecl) {
    const ty = node.type_expr
    if (!ty) {
        return ts.factory.createPropertySignature(
            undefined,
            node.name,
            undefined,
            ts.factory.createTypeReferenceNode('any')
        )
    }

    let isOptional = false
    let ty2 = createSyntheticUnion(ty)
    if (ty2.$type === 'optional_type') {
        isOptional = true
        ty2 = createSyntheticUnion(ty2.child_type)
    }

    return ts.factory.createPropertySignature(
        undefined,
        node.name,
        isOptional ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
        toTsTypeNode(ty2 as any),
    )
}

function toTsNode(node: zig.Node, treatPubAsExport?: boolean): ts.Node | undefined {
    const n = createSyntheticUnion(node)
    switch (n.$type) {
        case 'ident':
            return ts.factory.createIdentifier(n.name)
        case 'fndecl': {
            const isExported = n.qualifier === 'export' || n.name === 'main' || (treatPubAsExport && n.visibility === 'pub')
            if (!isExported || !n.name) {
                return
            }

            const mod = [
                ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
                ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)
            ]

            const params = n.params.map(p => {
                if (!p.name) {
                    throw new Error(`Missing parameter name`)
                }

                return ts.factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    p.name,
                    undefined,
                    p.type_expr ? toTsTypeNode(p.type_expr) : undefined,
                    undefined,
                )
            })

            return ts.factory.createFunctionDeclaration(
                mod,
                undefined,
                n.name,
                undefined,
                params,
                n.return_type ? toTsTypeNode(n.return_type) : undefined,
                undefined,
            )
        }
        case 'vardecl':
            if (!n.initializer) {
                return
            }
            
            const c = createSyntheticUnion(n.initializer)
            if (c.$type !== 'container') {
                return
            }

            // TODO
            if (c.subtype === 'root') {
                return
            }


            // TODO: we should only do this for root declarations
            const mod = n.visibility === 'pub' ? [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)] : undefined

            if (c.subtype === 'enum') {
                const members = c.members.map(m => {
                    const mm = createSyntheticUnion(m)
                    if (mm.$type !== 'field_decl') {
                        return
                    }

                    const name = mm.name.startsWith('@"') ? mm.name.slice(2, -1) : mm.name

                    return ts.factory.createEnumMember(name, ts.factory.createStringLiteral(name))
                }).filter(isNonNullable)

                return ts.factory.createEnumDeclaration(mod, n.name, members)
            }

            if (c.subtype === 'struct') {
                const members = c.members.map(m => {
                    const mm = createSyntheticUnion(m)
                    if (mm.$type !== 'field_decl') {
                        return
                    }

                    return fieldDeclToProperty(mm)
                }).filter(isNonNullable)

                return ts.factory.createInterfaceDeclaration(mod, n.name, undefined, undefined, members)
            }

            if (c.subtype === 'union') {
                if (!c.arg) {
                    throw new Error(`Missing enum tag`)
                }

                const members = c.members.map(m => {
                    const mm = createSyntheticUnion(m)
                    if (mm.$type !== 'field_decl') {
                        return
                    }

                    const f = fieldDeclToProperty(mm)
                    if (!f) {
                        return
                    }

                    return ts.factory.createTypeLiteralNode([f])
                }).filter(isNonNullable)

                return ts.factory.createTypeAliasDeclaration(
                    mod,
                    n.name,
                    undefined,
                    ts.factory.createUnionTypeNode(members)
                )
            }

            break


    }
}

type AstRoot = zig.ContainerDecl & { subtype: 'root' }

async function _getAst(sourceFile: string): Promise<AstRoot> {
    if ('parse' in (zig as any)) {
        const data = await getFs().readFile(sourceFile, 'utf-8')
        const rawAst = zig.parse(data)

        return JSON.parse(rawAst).container
    }

    if (!('main' in (zig as any))) {
        throw new Error(`Missing bindings for Zig parser`)
    }

    const ast = await (zig as any).main(sourceFile)

    return ast.container
}

const getAst = keyedMemoize(_getAst)

function generateSourceFile(root: AstRoot, treatPubAsExport?: boolean) {
    const statements = root.members.map(m => {
        const n = toTsNode(m, treatPubAsExport)
        if (!n || (!ts.isStatement(n) && !ts.isFunctionDeclaration(n))) {
            return
        }

        return n
    }).filter(isNonNullable)

    const sf = ts.factory.createSourceFile(statements, ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None)

    return sf
}

interface Param {
    readonly name: string
    readonly type: string
}

export interface ExportedFn {
    readonly name: string
    readonly params: Param[]
    readonly returnType: string
}

export interface ImportedModule {
    readonly name?: string
    readonly specifier: string
}

function toSimpleType(node: zig.Node): string {
    const n = createSyntheticUnion(node)
    switch (n.$type) {
        case 'ident':
            if (n.name === 'bool') {
                return 'boolean'
            }

            const converted = convertType(n.name)
            if (!converted) {
                throw new Error(`Unknown type: ${n.name}`)
            }

            return 'number'
        case 'field_access':
            if (n.member === 'UTF8String') {
                return 'string'
            }

            break
        case 'ptr_type':
            if (isStringTypeNode(node)) {
                return 'string'
            }

            const inner = toSimpleType(n.child_type)
            if (n.size === 'Many' || n.size === 'Slice') {
                return 'array' // TODO
            }

            return inner
        case 'optional_type': {
            const inner = toSimpleType(n.child_type)

            return inner
        }
    }

    throw new Error(`Not implemented: ${JSON.stringify(n)}`)
}

// FIXME: this check is too simplistic
function isNativeModule(ast: AstRoot) {
    return !!ast.members.map(createSyntheticUnion)
        .find(m => {
            if (m.$type !== 'comptime_node' || !m.node) {
                return
            }

            const b = createSyntheticUnion(m.node)
            if (b.$type !== 'block') {
                return
            }

            for (const s of b.statements.map(createSyntheticUnion)) {
                if (s.$type !== 'call_exp') continue

                const exp = createSyntheticUnion(s.exp)

                if (exp.$type === 'ident') {
                    return exp.name === 'registerModule'
                } else if (exp.$type === 'field_access') {
                    // TODO: check that target is `js` module
                    return exp.member === 'registerModule'
                }
            }
        })
}

function getVarDecls(nodes: zig.Node[]): zig.VarDecl[] {
    return nodes.map(createSyntheticUnion)
        .filter(n => n.$type === 'vardecl')
        .map(n => n as any as zig.VarDecl)
}

function getBuiltinCalls(nodes: zig.Node[]): { expression: zig.CallExp, name: string }[] {
    const decls = getVarDecls(nodes)
    const initializers = decls.map(d => d.initializer).filter(isNonNullable)

    return initializers.map(createSyntheticUnion).filter(n => n.$type === 'call_exp')
        .map(n => n as any as zig.CallExp)
        .map(n => {
            const exp = createSyntheticUnion(n.exp)
            if (exp.$type !== 'ident' || !exp.name.startsWith('@')) {
                return
            }

            return {
                expression: n,
                name: exp.name.slice(1),
            }
        })
        .filter(isNonNullable)
}


function getImportedModules(nodes: zig.Node[]) {
    return getBuiltinCalls(nodes)
        .filter(n => n.name === 'import')
        .map(n => {
            const arg0 = n.expression.args[0] ? createSyntheticUnion(n.expression.args[0]) : undefined
            if (!arg0 || arg0.$type !== 'literal' || arg0.subtype !== 'string') {
                return
            }

            return {
                specifier: arg0.value,
            }
        })
        .filter(isNonNullable) as ImportedModule[]
}

export async function getImportedModulesFromFile(target: string) {
    const ast = await getAst(target)
    const dir = path.dirname(target)

    const result = new Set<string>()
    for (const n of getImportedModules(ast.members)) {
        if (n.specifier.endsWith('.zig')) {
            result.add(path.resolve(dir, n.specifier))
        }
    }

    return result
}

export async function generateTsZigBindings(target: string) {
    const ast = await getAst(target)
    const isModule = isNativeModule(ast)
    const sf = generateSourceFile(ast, isModule)
    const sourcemapHost = {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: (fileName: string) => fileName,
    }

    const { text } = emitChunk(sourcemapHost, sf, undefined, { emitSourceMap: false, removeComments: true })
    const exportedFunctions = ast.members.map(createSyntheticUnion).filter(n => {
        return n.$type === 'fndecl'
    })
        .map(n => n as any as zig.FnDecl)
        .filter(n => (n.qualifier === 'export' || (isModule || n.visibility === 'pub')) && n.name && n.return_type)
        .map(n => ({
            name: n.name!,
            params: n.params.map(p => ({
                name: p.name!,
                type: isModule ? 'any' : toSimpleType(p.type_expr!),
            })),
            returnType: isModule ? 'any' : toSimpleType(n.return_type!),
        } satisfies ExportedFn))

    // Requires `--allowArbitraryExtensions` for tsc
    const outfile = target.replace(/\.zig$/, '.d.zig.ts')
    const importedModules = getImportedModules(ast.members)

    return {
        isModule,
        importedModules,
        exportedFunctions,
        typeDefinition: { name: outfile, text: text },
    }
}
