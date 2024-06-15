import ts from 'typescript'
import type { Schema } from '../runtime/modules/validation'
import { createObjectLiteral, createVariableStatement, failOnNode, printNodes } from '../utils'

function getOriginalNode<T extends ts.Node>(node: T): T {
    node = ts.getOriginalNode(node) as T
    const sf = node.getSourceFile()
    const resolved = (sf as any).getOriginalSourceFile?.() ?? sf
    if (resolved === sf) {
        return node
    }

    function findNodeByPos(target: ts.Node, pos: number) {
        function visit(node: ts.Node): ts.Node | undefined {
            if (node.pos === pos) {
                return node
            }

            return node.forEachChild(visit)
        }

        const found = visit(target)
        if (!found) {
            failOnNode('Unable to find original node', node)
        } else if (found.kind !== node.kind) {
            failOnNode('Found node is not the same kind as the target', found)
        }

        return found
    }

    return findNodeByPos(resolved, node.pos) as T
}

export type SchemaFactory = ReturnType<typeof createSchemaFactory>
export function createSchemaFactory(program: ts.Program) {
    const validateIdent = ts.factory.createIdentifier('validate')

    function createValidateDeclaration() {
        const runtime = ts.factory.createCallExpression(
            ts.factory.createIdentifier('require'),
            undefined,
            [ts.factory.createStringLiteral('synapse:validation')]
        )

        const validateFn = ts.factory.createPropertyAccessExpression(runtime, validateIdent)
        const validateDecl = createVariableStatement(validateIdent, validateFn)

        return validateDecl
    }

    function createSchema(typeNode: ts.TypeNode): Schema {
        return typeToSchema(program.getTypeChecker(), typeNode) 
    }

    function addValidationSchema(node: ts.CallExpression, factory = ts.factory) {
        node = getOriginalNode(node)

        const type = node.typeArguments?.[0]
        if (!type) {
            failOnNode('No type annotation exists', node)
        }

        const schema = createSchema(type)

        return factory.updateCallExpression(
            node,
            validateIdent,
            undefined,
            [node.arguments[0], createObjectLiteral(schema as any, factory)]
        )
    }

    function replaceWithSchema(node: ts.CallExpression, factory = ts.factory) {
        node = getOriginalNode(node)

        const type = node.typeArguments?.[0]
        if (!type) {
            failOnNode('No type annotation exists', node)
        }

        const schema = createSchema(type)

        return createObjectLiteral(schema as any, factory)
    }
    
    return { 
        createValidateDeclaration, 
        createSchema, 
        addValidationSchema,
        replaceWithSchema,
    }
}

function typeToSchema(typeChecker: ts.TypeChecker, typeOrNode: ts.Type | ts.TypeNode): Schema {
    const node = (typeOrNode as any).kind ? typeOrNode as ts.TypeNode : undefined
    const type = node ? typeChecker.getTypeFromTypeNode(node) : typeOrNode as ts.Type

    // Special case: `boolean` is evaluated as `true | false` but we want just `boolean`
    if (type.flags & ts.TypeFlags.Boolean) {
        return { type: 'boolean' }
    }

    if (type.isUnion()) {
        const types = type.types
        const enums: any[] = []
        const schemas: Schema[] = []
        for (const t of types) {
            const subschema = typeToSchema(typeChecker, t)
            if (subschema.const) {
                enums.push(subschema.const)
            } else if (subschema.enum) {
                enums.push(...subschema.enum)
            } else {
                schemas.push(subschema)
            }
        }

        // Collapse it down to a boolean
        if (enums.includes(true) && enums.includes(false)) {
            schemas.push({ type: 'boolean' })

            const filtered = enums.filter(x => typeof x !== 'boolean')
            const enumSchemas = filtered.length > 0 ? [{ enum: Array.from(new Set(filtered)) }] : []

            return { anyOf: [...enumSchemas, ...schemas] } as Schema
        }

        const enumSchemas = enums.length > 0 ? [{ enum: Array.from(new Set(enums)) }] : []

        return { anyOf: [...enumSchemas, ...schemas] } as Schema
    }

    if (type.isIntersection()) {
        function intersect(a: Schema, b: Schema): Schema | false {
            if (b.anyOf) {
                const schemas = b.anyOf.map(s => intersect(a, { ...b, anyOf: undefined, ...s })).filter((s): s is Schema => !!s)
                if (schemas.length === 0) {
                    return false
                }

                return { anyOf: schemas } as any
            }

            if (a.anyOf) {
                return intersect(b, a)
            }

            if (a.enum && b.enum) {
                const union = new Set([...a.enum, ...b.enum])
                const intersection = Array.from(union).filter(x => a.enum!.includes(x) && b.enum!.includes(x))
                if (intersection.length === 0) {
                    return false
                }

                return { enum: intersection } as Schema
            }

            if (a.enum && b.type) {
                const enums: any[] = []
                if (Array.isArray(b.type)) {
                    const schemas = b.type.map(s => intersect(a, { ...b, type: s })).filter((s): s is Schema => !!s)
                    for (const s of schemas) {
                        if (s.enum) {
                            enums.push(...s.enum)
                        }
                    }
                } else {
                    for (const x of a.enum) {
                        switch (b.type) {
                            case 'boolean':
                            case 'string':
                            case 'number':
                                if (typeof x === b.type) {
                                    enums.push(x)
                                }

                                break
                            case 'null':
                                if (x === null) {
                                    enums.push(x)
                                }

                                break
                        }
                    }
                }

                if (enums.length === 0) {
                    return false
                }

                return { enum: Array.from(new Set(enums)) } as Schema
            }

            if (a.type && b.enum) {
                return intersect(b, a)
            }

            if (a.type && b.type) {
                if (Array.isArray(b.type)) {
                    const schemas = b.type.map(s => intersect(a, { ...b, type: s })).filter((s): s is Schema => !!s)

                    return { type: schemas.map(s => s.type) } as any
                }
                if (Array.isArray(a.type)) {
                    return intersect(b, a)
                }

                if (a.type !== b.type) {
                    return false
                }

                if (a.type === 'object' && b.type === 'object') {
                    const keysA = Object.keys(a.properties ?? {})
                    const keysB = Object.keys(b.properties ?? {})
                    const keys = Array.from(new Set([...keysA, ...keysB]))
                    const props: Record<string, Schema> = {}

                    for (const key of keys) {
                        const schemaA = a.properties?.[key]
                        const schemaB = b.properties?.[key]
                        if (schemaA && schemaB) {
                            const s = intersect(schemaA, schemaB)
                            if (s) {
                                props[key] = s
                            }
                        } else if (schemaA) {
                            props[key] = schemaA
                        } else if (schemaB) {
                            props[key] = schemaB
                        }
                    }

                    const requiredA = a.required ?? []
                    const requiredB = b.required ?? []
                    const required = Array.from(new Set([...requiredA, ...requiredB]))

                    // `never` is effectively coerced to `any` here
                    return { type: 'object', properties: props, required }
                }

                if (a.type === 'array' && b.type === 'array') {
                    const items = a.items && b.items ? intersect(a.items, b.items) : a.items ?? b.items
    
                    if (a.prefixItems && b.prefixItems) {
                        if (a.prefixItems.length !== b.prefixItems.length) {
                            return false
                        }

                        const prefixItems: Schema[] = []
                        for (let i = 0; i < a.prefixItems.length; i++) {
                            const s = intersect(a.prefixItems[i], b.prefixItems[i])
                            if (!s) {
                                return false
                            }
                            prefixItems.push(s)
                        }

                        if (items) {
                            return { type: 'array', items, prefixItems }
                        }

                        return { type: 'array', prefixItems }
                    }

                    if (!items) {
                        return false
                    }

                    return { type: 'array', items }
                }

                return { type: a.type }
            }

            return false
        }

        const res = type.types.map<Schema | false>(t => typeToSchema(typeChecker, t)).reduce((a, b) => a && b ? intersect(a, b) : false)
        if (!res) {
            throw new Error('Failed to create intersection schema')
        }

        return res
    }

    const typeAsString = typeChecker.typeToString(type)
    if (typeAsString === 'any') {
        return { type: 'object' } // FIXME: not correct
    } else if (typeAsString === 'string') {
        return { type: 'string' }
    } else if (typeAsString === 'number') {
        return { type: 'number' }
    } else if (typeAsString === 'true' || typeAsString === 'false') {
        return { type: 'boolean', enum: [typeAsString === 'true' ? true : false] }
    } else if (type.isNumberLiteral() || type.isStringLiteral()) {
        return {
            type: type.isNumberLiteral() ? 'number' : 'string',
            enum: [type.value] 
        }
    }
    
    const symbol = type.symbol ?? (node ? typeChecker.getSymbolAtLocation(node) : undefined)
    const typeNode = node ?? typeChecker.typeToTypeNode(type, symbol?.valueDeclaration, undefined)
    if (typeNode === undefined) {
        throw new Error(`Type "${typeAsString}" has no type node`)
    }
    
    function convertSymbols(symbols: ts.Symbol[]) {
        const properties: Record<string, Schema> = {}
        const required: string[] = []
    
        for (const prop of symbols) {
            if (!prop.valueDeclaration) {
                throw new Error(`Symbol "${prop.name}" does not have a value declaration`)
            }
            const propType = typeChecker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration)
            const nonNullableType = propType.getNonNullableType()
            properties[prop.name] = typeToSchema(typeChecker, nonNullableType)
    
            if (nonNullableType === propType) {
                required.push(prop.name)
            }
        }
    
        if (required.length === 0) {
            return {
                type: 'object' as const,
                properties,
            }
        }

        return {
            type: 'object' as const,
            properties,
            required,
        }
    }

    if (type.isClassOrInterface() || ts.isTypeLiteralNode(typeNode)) {
        return convertSymbols(typeChecker.getPropertiesOfType(type))
    } else if (ts.isTypeReferenceNode(typeNode)) {
        const args = typeChecker.getTypeArguments(type as ts.TypeReference)

        if (ts.isIdentifier(typeNode.typeName) && args) {
            if (typeNode.typeName.text === 'Record') {
                return {
                    type: 'object',
                    additionalProperties: typeToSchema(typeChecker, args[1]),
                    // key: typeToSchema(typeChecker, args[0]),
                    // value: typeToSchema(typeChecker, args[1]),
                }
            } else if (typeNode.typeName.text === 'Array') {
                return {
                    type: 'array',
                    items: typeToSchema(typeChecker, args[0])
                }
            } else if (typeNode.typeName.text === 'Promise') {
                // Assume return type position
                return typeToSchema(typeChecker, args[0])
            }
        }
    } else if (ts.isArrayTypeNode(typeNode)) {
        const args = typeChecker.getTypeArguments(type as ts.TypeReference)

        return {
            type: 'array',
            items: typeToSchema(typeChecker, args[0]),
        }
    } else if (ts.isTupleTypeNode(typeNode)) {
        return {
            type: 'array',
            prefixItems: typeNode.elements.map(item => typeToSchema(typeChecker, item)),
        }
    } else if (symbol.members) {
        return convertSymbols([...symbol.members.values()])
    }

    throw new Error(`Unable to convert type "${typeAsString}" to JSON schema`)
}