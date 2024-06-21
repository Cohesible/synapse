import ts from 'typescript'
import * as path from 'node:path'
import { getFs } from '../execution'
import { createObjectLiteral, isNonNullable, printNodes } from '../utils'
import { OpenApiModel, Operation, ParameterLocation, RequestBody, Response } from './openapiv3'

// Rough impl. of JSONSchema7

type PrimitiveType = 'null' | 'boolean' | 'object' | 'array' | 'number' | 'string' | 'integer'
type Literal = null | boolean | string | number

interface SchemaBase {
    readonly type?: PrimitiveType | PrimitiveType[]
    readonly enum?: Literal[]
    readonly const?: Literal
    readonly oneOf?: Schema[]
    readonly title?: string
}

interface ObjectSchema extends SchemaBase {
    readonly type: 'object'
    readonly properties?: Record<string, Schema>
    readonly required?: string[]
    readonly additionalProperties?: Schema
    readonly maxProperties?: number
    readonly minProperties?: number
    readonly dependentRequired?: Record<string, string[]>
    readonly patternProperties?: Record<string, Schema>
}

interface ArraySchema extends SchemaBase {
    readonly type: 'array'
    readonly items?: Schema | false
    readonly prefixItems?: Schema[]
    readonly maxItems?: number
    readonly minItems?: number
    readonly uniqueItems?: boolean
}

interface StringSchema extends SchemaBase {
    readonly type: 'string'
    readonly pattern?: string // RegExp
    readonly maxLength?: number
    readonly minLength?: number
}

interface NumberSchema extends SchemaBase {
    readonly type: 'number' | 'integer'
    readonly multipleOf?: number
    readonly maximum?: number
    readonly minimum?: number
    readonly exclusiveMaximum?: number
    readonly exclusiveMinimum?: number
}

interface BooleanSchema extends SchemaBase {
    readonly type: 'boolean'
}

interface NullSchema extends SchemaBase {
    readonly type: 'null'
}

interface Ref {
    readonly $ref: string
}

interface OneOf extends SchemaBase {
    readonly oneOf: Schema[]
}

interface AllOf extends SchemaBase {
    readonly allOf: Schema[]
}

interface AnyOf extends SchemaBase {
    readonly anyOf: Schema[]
}

export type Schema = ObjectSchema | ArraySchema | StringSchema | NumberSchema | BooleanSchema | NullSchema | OneOf | AllOf | Ref | boolean

function isRef(o: any): o is Ref {
    return typeof o === 'object' && !!o && typeof o.$ref === 'string'
}

function isOneOf(o: any): o is OneOf {
    return typeof o === 'object' && !!o && Array.isArray(o.oneOf)
}

function isAllOf(o: any): o is AllOf {
    return typeof o === 'object' && !!o && Array.isArray(o.allOf)
}

function isAnyOf(o: any): o is AnyOf {
    return typeof o === 'object' && !!o && Array.isArray(o.anyOf)
}

function isObjectSchema(o: any): o is ObjectSchema {
    return typeof o === 'object' && !!o && o.type === 'object'
}

function quote(name: string) {
    if (name.match(/^[\-\+_]/)) {
        return `'${name}'`
    }

    return name
}

function tryConvertRegExpPattern(pattern: string) {
    const strings: string[] = []
    const types: ts.TypeNode[] = []

    let isLiteral = true

    if (!pattern.startsWith('^')) {
        strings.push('')
        types.push(ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword))
        isLiteral = false
    } else {
        pattern = pattern.slice(1)
    }

    pattern = pattern.replace(/\\([\$\/])/g, '$1')

    while (pattern) {
        const g = pattern.indexOf('(')
        const g2 = pattern.indexOf('[')
        if (g2 !== -1) {
            let end = pattern.indexOf(']')
            if (end === -1) {
                throw new Error(`Bad parse: missing end of group token: ${pattern}`)
            }

            if (pattern[end + 1] === '+') {
                end++
            }

            strings.push(pattern.slice(0, g2))
            types.push(ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword))
            isLiteral = false

            pattern = pattern.slice(end + 1)
            continue
        }
        if (g === -1) {
            if (!pattern.endsWith('$')) {
                types.push(ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword))
                isLiteral = false
            } else {
                pattern = pattern.slice(0, -1)
            }
        
            strings.push(pattern)
            pattern = ''
            continue
        }
        const end = pattern.indexOf(')')
        if (end === -1) {
            throw new Error(`Bad parse: missing end of group token: ${pattern}`)
        }
        const vals = pattern.slice(g + 1, end).split('|')
        types.push(ts.factory.createUnionTypeNode(vals.map(v => ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(v)))))

        pattern = pattern.slice(end + 1)
    }

    const head = ts.factory.createTemplateHead(strings.shift() ?? '')
    const tail = ts.factory.createTemplateTail(strings.pop() ?? '')
    if (isLiteral) {
        if (types.length === 0) {
            return ts.factory.createStringLiteral(head.text + tail.text)
        }

        return types[0]
    }

    const spans = types.slice(0, strings.length + 1).map((t, i) => {
        const literal = i === strings.length ? tail : ts.factory.createTemplateMiddle(strings[i])

        return ts.factory.createTemplateLiteralTypeSpan(t, literal)
    })

    return ts.factory.createTemplateLiteralType(head, spans)
}

function normalizeName(name: string) {
    return name.split(/[_\-\$.]/).map(s => s.charAt(0).toUpperCase().concat(s.slice(1))).join('')
}

function resolveRef(root: any, p: string) {
    // ~0 for ~
    // ~1 for /

    const parts = p.split('/').map(s => s.replace(/~0/g, '~').replace(/~1/g, '/'))
    const first = parts.shift()
    if (first !== '#') {
        throw new Error('Only document-relative pointers are supported')
    }
    
    let c: any = root
    while (parts.length > 0) {
        const s = parts.shift()!
        if (!c) {
            throw new Error(`Attempted to index a falsy value at segment "${s}" in pointer "${p}"`)
        }
        c = c[s]
    }

    return c
}

export function createSchemaGenerator(root: SchemaBase) {

    function literal(val: Literal) {
        if (val === null) {
            return ts.factory.createLiteralTypeNode(ts.factory.createNull())
        }

        switch (typeof val) {
            case 'number':
                return ts.factory.createLiteralTypeNode(ts.factory.createNumericLiteral(val))
            case 'string':
                return ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(val))
            case 'boolean':
                return ts.factory.createLiteralTypeNode(val ? ts.factory.createTrue() : ts.factory.createFalse())
        }
    }

    function renderString(schema: StringSchema) {
        if (schema.enum) {
            return ts.factory.createUnionTypeNode(schema.enum.filter(x => typeof x === 'string').map(literal))
        }

        return ts.factory.createTypeReferenceNode('string')
    }

    function renderNumber(schema: NumberSchema) {
        if (schema.enum) {
            return ts.factory.createUnionTypeNode(schema.enum.filter(x => typeof x === 'number').map(literal))
        }

        return ts.factory.createTypeReferenceNode('number')
    }

    function renderArray(schema: ArraySchema) {
        // TODO: use `prefixItems` to create a tuple type
        if (schema.prefixItems) {
            console.log(schema)
        }

        const items = schema.items !== undefined ? render(schema.items) : undefined
        if (!items) {
            throw new Error(`Not implemented`)
        }

        return ts.factory.createArrayTypeNode(items)
    }

    function renderObject(schema: ObjectSchema) {
        const required = new Set(schema.required)
        const members: ts.TypeElement[] = []

        function isRequired(name: string, value: Schema) {
            if (required.has(name)) {
                return true
            }

            // if (typeof value === 'object' && (value as any).default !== undefined) {
            //     return true
            // }

            return false
        }

        if (schema.properties) {
            for (const [k, v] of Object.entries(schema.properties)) {
                members.push(ts.factory.createPropertySignature(
                    [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                    quote(k),
                    !isRequired(k, v) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
                    render(v),
                ))
            }
        }

        if (schema.additionalProperties && !schema.properties) {
            return ts.factory.createTypeReferenceNode('Record', [
                ts.factory.createTypeReferenceNode('string'),
                render(schema.additionalProperties)
            ])
        }

        if (schema.patternProperties) {
            for (const [k, v] of Object.entries(schema.patternProperties)) {
                const name = tryConvertRegExpPattern(k)
                if (ts.isTemplateLiteralTypeNode(name)) {
                    members.push(ts.factory.createIndexSignature(
                        [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                        [ts.factory.createParameterDeclaration(undefined, undefined, 'name', undefined, name)],
                        ts.factory.createUnionTypeNode([
                            render(v),
                            ts.factory.createTypeReferenceNode('undefined')
                        ]),
                    ))
                } else if (ts.isStringLiteral(name)) {
                    members.push(ts.factory.createPropertySignature(
                        [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                        name,
                        !isRequired(k, v) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
                        render(v),
                    ))
                } else {
                    if (!ts.isUnionTypeNode(name)) {
                        throw new Error(`Unexpected type: ${name}`)
                    }

                    for (const m of name.types) {
                        if (!ts.isLiteralTypeNode(m) || !ts.isStringLiteral(m.literal)) {
                            continue
                        }
                        members.push(ts.factory.createPropertySignature(
                            [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                            m.literal,
                            !isRequired(k, v) ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
                            render(v),
                        )) 
                    }
                }
            }
        }

        if (members.length === 0) {
            return ts.factory.createTypeReferenceNode('any')
        }

        return ts.factory.createTypeLiteralNode(members)
    }

    const declarations = new Map<string, ts.Declaration>()

    function render(schema: Schema): ts.TypeNode {
        if (isRef(schema)) {
            const name = normalizeName(schema.$ref.split('/').pop()!)
            if (!declarations.has(name)) {
                declarations.set(name, true as any)

                const v = render(resolveRef(root, schema.$ref))
                if (ts.isTypeLiteralNode(v)) {
                    const decl = ts.factory.createInterfaceDeclaration(undefined, name, undefined, undefined, v.members)
                    declarations.set(name, decl)
                } else if (ts.isUnionTypeNode(v)) {
                    const decl = ts.factory.createTypeAliasDeclaration(undefined, name, undefined, v)
                    declarations.set(name, decl)
                } else {
                    declarations.delete(name)
                    return v
                }
            }

            return ts.factory.createTypeReferenceNode(name)
        }

        if (typeof schema === 'boolean') {
            return ts.factory.createTypeReferenceNode(schema ? 'any' : 'never')
        }

        if (isOneOf(schema)) {
            return ts.factory.createUnionTypeNode(schema.oneOf.map(render).filter(isNonNullable))
        }

        // `anyOf` is treated the same as `oneOf`
        if (isAnyOf(schema)) {
            const merged = schema.anyOf.map(s => typeof s === 'object' ? { ...schema, ...s, anyOf: undefined } : s)
            return ts.factory.createUnionTypeNode(merged.map(render).filter(isNonNullable))
        }

        if (isAllOf(schema)) {
            return ts.factory.createIntersectionTypeNode(schema.allOf.map(render).filter(isNonNullable))
        }

        if (Object.keys(schema).length === 0) {
            return ts.factory.createTypeReferenceNode('any')
        }

        if (Array.isArray(schema.type)) {
            return ts.factory.createUnionTypeNode(schema.type.map(t => {
                const s = { ...schema, type: t }

                return render(s)
            }))
        }

        if ((schema as any).not) {
            return ts.factory.createTypeReferenceNode('any')
        }

        if ((schema as any).properties && !schema.type) {
            return render({ ...(schema as any), type: 'object' })
        }

        if ((schema as any).enum && !schema.type) {
            return ts.factory.createUnionTypeNode((schema as any).enum.map(literal))
        }

        switch (schema.type) {
            case 'null':
                return literal(null)
            case 'boolean':
                return ts.factory.createTypeReferenceNode('boolean') // not entirely correct
            case 'string':
                return renderString(schema)
            case 'number':
            case 'integer':
                return renderNumber(schema)
            case 'array':
                return renderArray(schema)
            case 'object':
                return renderObject(schema)
        }

        throw new Error(`Unknown schema: ${JSON.stringify(schema)}`)
    }

    function getDeclarations() {
        return Array.from(declarations.values())
    }

    return {
        render,
        getDeclarations,
    }
}

async function fetchJson<T = any>(url: string): Promise<T> {
    return fetch(url).then(r => r.json())
}


export async function generateOpenApiV3() {
    const doc = await fetchJson<Schema>('https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/schemas/v3.0/schema.json')
    if (!isObjectSchema(doc)) {
        throw new Error('Expected an object schema')
    }

    const generator = createSchemaGenerator(doc) 
    const type = generator.render(doc)
    if (!ts.isTypeLiteralNode(type)) {
        throw new Error(`Unexpected return type node`)
    }

    const decl = ts.factory.createInterfaceDeclaration(
        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)], 
        'OpenApiModel', 
        undefined, 
        undefined, 
        type.members
    )

    const sf = ts.factory.createSourceFile(
        [...generator.getDeclarations() as any, decl], 
        ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), 
        ts.NodeFlags.None
    )

    return printNodes(sf.statements, sf)
}

function toUpperCase(s: string) {
    return s[0].toUpperCase().concat(s.slice(1))
}

interface XGitHub {
    githubCloudOnly: boolean
    enabledForGitHubApps: boolean
    category: string
    subcategory: string
}

export async function generateGitHubApi() {
    const doc = await fetchJson<OpenApiModel>('https://unpkg.com/@octokit/openapi@16.6.0/generated/api.github.com.json')

    type Param = ParameterLocation & {
        name: string
        schema: any
    }

    const generator = createSchemaGenerator(doc as any) 

    function getOpName(opId: string) {
        const parts = opId.split('/')
        const segments = parts.at(-1)!.split('-')
        if (parts.length > 1) {
            const subject = parts.at(-2)!
            if (!parts.at(-1)!.includes(subject)) {
                segments.splice(1, 0, ...subject.split('-'))
            }
        }

        return segments.map((s, i) => i === 0 ? s : toUpperCase(s)).join('')
    }

    function renderOpResponse(name: string, op: Operation) {
        if (op.responses['204']) {
            return ts.factory.createTypeReferenceNode('void')
        }

        // We're just assuming the schemas are the same for all 3 statuses
        const resp = op.responses['200'] ?? op.responses['201'] ?? op.responses['202']
        if (!resp) {
            return ts.factory.createTypeReferenceNode('void')
        }

        const r: Response = isRef(resp) ? resolveRef(doc, resp.$ref) : resp
        const c = r.content?.['application/json']
        if (!c) {
            if (r.content?.['text/html']) {
                return ts.factory.createTypeReferenceNode('string')
            }

            // `application/octocat-stream` lol

            return ts.factory.createTypeReferenceNode('unknown')
        }

        const respName = `${toUpperCase(name)}Response`
        const type = generator.render(c.schema)
        if (ts.isTypeLiteralNode(type)) {
            decls.push(ts.factory.createInterfaceDeclaration(
                [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)], 
                respName,
                undefined, 
                undefined, 
                type.members
            ))
            return ts.factory.createTypeReferenceNode(respName)
        }

        return type
    }

    function renderOp(method: string, path: string, name: string, op: Operation) {
        const requestMembers: Record<string, any> = {}
        const required = new Set<string>()
        const resolvedParams = (op.parameters ?? []).map(p => {
            return (isRef(p) ? resolveRef(doc, p.$ref) : p) as Param
        })
        for (const r of resolvedParams) {
            requestMembers[r.name] = generator.render(r.schema)
            if ((r as any).required) {
                required.add(r.name)
            }
        }

        if (op.requestBody) {
            const r = (isRef(op.requestBody) ? resolveRef(doc, op.requestBody.$ref) : op.requestBody) as RequestBody
            const jsonBody = r.content['application/json']
            if (jsonBody) {
                requestMembers['body'] = generator.render(jsonBody.schema)
            } else {
                requestMembers['body'] = ts.factory.createTypeReferenceNode('ArrayBuffer') // TODO: need `BinaryLike` type
            }

            if (r.required) {
                required.add('body')
            }
        }

        const decls: any[] = []
        decls.push(ts.factory.createInterfaceDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)], 
            `${toUpperCase(name)}Request`, 
            undefined, 
            undefined, 
            Object.entries(requestMembers).map(
                ([k, v]) => ts.factory.createPropertySignature(undefined, k, required.has(k) ? undefined : ts.factory.createToken(ts.SyntaxKind.QuestionToken), v)
            )
        ))

        const resp = renderOpResponse(name, op)
        const prunedParams = resolvedParams.map(r => ({...r, description: undefined, schema: undefined, examples: undefined, example: undefined, required: (r as any).required ? true : undefined }))
        const fn = ts.factory.createFunctionDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)], 
            undefined,
            name,
            undefined,
            [ts.factory.createParameterDeclaration(undefined, undefined, 'request', undefined, ts.factory.createTypeReferenceNode(`${toUpperCase(name)}Request`))],
            ts.factory.createTypeReferenceNode('Promise', [resp]),
            ts.factory.createBlock([
                ts.factory.createReturnStatement(
                    ts.factory.createCallExpression(
                        ts.factory.createIdentifier('sendRequest'),
                        undefined,
                        [
                            ts.factory.createStringLiteral(`https://api.github.com`),
                            ts.factory.createStringLiteral(method),
                            ts.factory.createStringLiteral(path),
                            ts.factory.createArrayLiteralExpression(prunedParams.map(r => createObjectLiteral(r))),
                            ts.factory.createIdentifier('request'),
                        ]
                    )
                )
            ], true)
        )

        decls.push(fn)

        return decls
    }

    const decls: any[] = []
    for (const [k, v] of Object.entries(doc.paths)) {
        for (const [k2, v2] of Object.entries(v)) {
            if (k2 === 'get' || k2 === 'post') {
                const op = v2 as Operation
                if (!op.operationId) continue

                const name = getOpName(op.operationId)
                decls.push(...renderOp(k2.toUpperCase(), k, name, v2 as any))
            }
        }
    }

    const sf = ts.factory.createSourceFile(
        [...generator.getDeclarations() as any, ...decls], 
        ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), 
        ts.NodeFlags.None
    )

    return printNodes(sf.statements, sf)
}

export async function generateGitHubWebhooks() {
    const doc = await fetchJson<SchemaBase>('https://unpkg.com/@octokit/webhooks-schemas@7.3.1/schema.json')
    if (!doc.oneOf) {
        throw new Error('Expected a `oneOf` field')
    }

    const generator = createSchemaGenerator(doc) 

    const members: ts.TypeElement[] = []
    for (const schema of doc.oneOf) {
        if (!isRef(schema)) {
            throw new Error(`Expected a reference`)
        }

        const name = schema.$ref.split('/').pop()!.replace(/[_\$]event$/, '')
        members.push(ts.factory.createPropertySignature(
            undefined,
            quote(name),
            undefined,
            generator.render(schema),
        ))
    }

    const finalDecl = ts.factory.createInterfaceDeclaration(
        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        'WebhookEvent',
        undefined,
        undefined,
        members
    )

    const sf = ts.factory.createSourceFile(
        [...generator.getDeclarations() as any, finalDecl], 
        ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), 
        ts.NodeFlags.None
    )

    return printNodes(sf.statements, sf)
}

interface EventObject {
    readonly id: string
    readonly object: 'event'
    readonly api_version: string
    readonly created: number
    readonly type: string
    // Info about the triggering request
    readonly request?: any
    readonly livemode: boolean
    readonly data: {
        readonly object: any
        readonly previous_attributes?: any // Only included for events with type `*.updated`
    }
}

export async function generateStripeWebhooks() {
    const doc = await fetchJson<{ components: { schemas: Record<string, Schema> } }>('https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.sdk.json')
    const events = Object.entries(doc.components.schemas).filter(([k, v]) => typeof v === 'object' && 'x-stripeEvent' in v)    

    function createMember(name: string, type: ts.TypeNode, optional = false) {
        return ts.factory.createPropertySignature(
            undefined, 
            name, 
            optional ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
            type,
        )
    }

    const literalType = (literal: string | number) => {
        const exp = typeof literal === 'string' 
            ? ts.factory.createStringLiteral(literal) 
            : ts.factory.createNumericLiteral(literal)

        return ts.factory.createLiteralTypeNode(exp)
    }

    const anyType = ts.factory.createTypeReferenceNode('any')
    const stringType = ts.factory.createTypeReferenceNode('string')
    const numberType = ts.factory.createTypeReferenceNode('number')
    const booleanType = ts.factory.createTypeReferenceNode('boolean')

    const eventObjBase = ts.factory.createInterfaceDeclaration(
        undefined,
        'EventObjectBase',
        undefined,
        undefined,
        [
            createMember('id', stringType),
            createMember('created', numberType),
            createMember('livemode', booleanType),
            createMember('api_version', stringType),
            createMember('request', anyType, true),
            createMember('object', literalType('event')),
        ]
    )

    const generator = createSchemaGenerator(doc as any) 

    function generateEvent(type: string) {
        const ref = generator.render({ $ref: `#/components/schemas/${type}` })
        const declName = `${normalizeName(type)}Event`

        return ts.factory.createInterfaceDeclaration(
            undefined,
            declName,
            undefined,
            [ts.factory.createHeritageClause(
                ts.SyntaxKind.ExtendsKeyword,
                [ts.factory.createExpressionWithTypeArguments(eventObjBase.name, undefined)]
            )],
            [
                createMember('type', literalType(type)),
                // TODO: include `previous_attributes` for updated events
                // TODO: create an object literal instead of a reference
                createMember('data', ref)
            ]
        )
    }

    const eventDecls = events.map(([k]) => generateEvent(k))

    const finalDecl = ts.factory.createTypeAliasDeclaration(
        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        'EventObject',
        undefined,
        ts.factory.createUnionTypeNode(eventDecls.map(d => ts.factory.createTypeReferenceNode(d.name)))
    )

    const sf = ts.factory.createSourceFile(
        [eventObjBase, ...generator.getDeclarations() as any, ...eventDecls, finalDecl], 
        ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), 
        ts.NodeFlags.None
    )

    return printNodes(sf.statements, sf)
}

export async function main() {
    const res = await generateGitHubApi()
    await getFs().writeFile(path.resolve('dist', 'github.ts'), res)
}
