//@internal
//# moduleId = synapse:validation
// TODO: turn this into a 'reify' lib

type PrimitiveType = 'null' | 'boolean' | 'object' | 'array' | 'number' | 'string' // | 'integer'
type InstanceType = PrimitiveType | 'integer' | (PrimitiveType | 'integer' )[]

interface NumberSchema {
    readonly multipleOf?: number
    readonly maximum?: number
    readonly minimum?: number
    readonly exclusiveMaximum?: number
    readonly exclusiveMinimum?: number
}

interface StringSchema {
    readonly pattern?: string // RegExp
    readonly maxLength?: number
    readonly minLength?: number
}

interface ArraySchema {
    // readonly type?: InstanceType
    readonly maxItems?: number
    readonly minItems?: number
    readonly uniqueItems?: boolean

    // readonly maxContains?: number
    // readonly minContains?: number
}

interface ObjectSchema {
    readonly maxProperties?: number
    readonly minProperties?: number
    readonly required?: string[]
    readonly dependentRequired?: Record<string, string[]>

    // readonly maxContains?: number
    // readonly minContains?: number
}

// Basic impl. of JSON schema

interface SchemaBase {
    readonly type?: PrimitiveType | PrimitiveType[]
    readonly enum?: (null | boolean | string | number)[]
    readonly const?: null | boolean | string | number
    readonly anyOf?: Schema[]
}

interface ObjectSchema extends SchemaBase {
    readonly type: 'object'
    readonly properties?: Record<string, Schema>
    readonly additionalProperties?: Schema
    readonly required?: string[]
}

interface ArraySchema extends SchemaBase {
    readonly type: 'array'
    readonly items?: Schema | false
    readonly prefixItems?: Schema[]
}

interface StringSchema extends SchemaBase {
    readonly type: 'string'
}

interface NumberSchema extends SchemaBase {
    readonly type: 'number'
}

interface BooleanSchema extends SchemaBase {
    readonly type: 'boolean'
}

interface NullSchema extends SchemaBase {
    readonly type: 'null'
}

export interface TypedObjectSchema<T extends object> extends ObjectSchema {
    readonly __type: T
}

export interface TypedArraySchema<T extends any[]> extends ArraySchema {
    readonly __type: T
}

export interface TypedStringSchema<T extends string> extends StringSchema {
    readonly __type: T
}

export interface TypedNumberSchema<T extends number> extends NumberSchema {
    readonly __type: T
}

export type Schema = ObjectSchema | ArraySchema | StringSchema | NumberSchema | BooleanSchema | NullSchema

export type FromSchema<T> = T extends TypedArraySchema<infer U> ? U 
    : T extends TypedObjectSchema<infer U> ? U 
    : T extends TypedStringSchema<infer U> ? U 
    : T extends TypedNumberSchema<infer U> ? U : never

export function validate<const T extends any[]>(val: unknown, schema: TypedArraySchema<T>): asserts val is T
export function validate<const T extends object>(val: unknown, schema: TypedObjectSchema<T>): asserts val is T
export function validate<const T extends string>(val: unknown, schema: TypedStringSchema<T>): asserts val is T
export function validate<const T extends number>(val: unknown, schema: TypedNumberSchema<T>): asserts val is T

export function validate(val: unknown, schema: Schema) {
    checkSchema(val, schema)?.throw()
}

export function checkSchema(val: unknown, schema: Schema): ValidationError | void {
    if (schema.anyOf) {
        const errors: ValidationError[] = []
        for (const subschema of schema.anyOf) {
            const expanded = { ...schema, anyOf: undefined, ...subschema }
            const error = checkSchema(val, expanded)
            if (!error) {
                return
            }

            errors.push(error)
        }

        return new ValidationError('Failed to match any subschemas', val, schema, errors)
    }

    if (Array.isArray(schema.type)) {
        const errors: ValidationError[] = []
        for (const type of schema.type) {
            const error = checkSchema(val, { ...schema, type })
            if (!error) {
                return
            }

            errors.push(error)
        }

        return new ValidationError(`Failed to match any types: ${schema.type}`, val, schema, errors)
    }

    if (schema.enum) {
        const match = schema.enum.indexOf(val as any)
        if (!match) {
            return new ValidationError(`Value must be on of: ${schema.enum}`, val, schema)
        }

        return
    } else if (schema.const && schema.const !== val) {
        return new ValidationError(`Value must be equal to ${schema.const}`, val, schema)
    }

    switch (schema.type) {
        case 'number':
        case 'string':
        case 'boolean':
            if (typeof val !== schema.type) {
                return new ValidationError(`Expected value with type: ${schema.type}, got ${typeof val}`, val, schema)
            }

            break
        case 'null':
            if (val !== null) {
                return new ValidationError(`Expected null`, val, schema)
            }

            break        
        case 'array': {
            if (!Array.isArray(val)) {
                return new ValidationError(`Expected an array, got ${typeof val}`, val, schema)
            }

            let i = 0
            const errors: ValidationError[] = []
            const prefixItems = schema.prefixItems
            if (prefixItems) {
                for (; i < prefixItems.length; i++) {
                    const error = checkSchema(val[i], prefixItems[i])
                    if (error) {
                        errors.push(error)
                    }
                }

                if ((!schema.items && prefixItems.length > val.length) || val.length < prefixItems.length) {                    
                    return new ValidationError(
                        `Incorrect number of items in array: got ${val.length}, expected ${prefixItems.length}`, 
                        val, 
                        schema, 
                        errors
                    )
                }
            }

            if (schema.items) {
                for (; i < val.length; i++) {
                    const error = checkSchema(val[i], schema.items)
                    if (error) {
                        errors.push(error)
                    }
                }
            }

            if (errors.length > 0) {
                return new ValidationError(
                    `Failed to validate array`, 
                    val, 
                    schema, 
                    errors
                )
            }

            break
        }
        case 'object': {
            if (typeof val !== 'object' || val === null) {
                return new ValidationError(
                    `Expected an object, got ${val === null ? 'null' : typeof val}`, 
                    val, 
                    schema, 
                )
            }

            const errors: ValidationError[] = []
            const matched = new Set<string>()
            if (schema.properties) {
                for (const [k, v] of Object.entries(schema.properties)) {
                    matched.add(k)

                    const isRequired = !!schema.required?.includes(k)
                    const subval = (val as any)[k]
                    if (subval === undefined) {
                        if (isRequired) {
                            errors.push(new ValidationError(`${k}: missing value`, val, v))
                        }

                        continue
                    }

                    const error = checkSchema(subval, v)
                    if (error) {
                        errors.push(new ValidationError(`${k}: ${error.message}`, subval, v, Array.from(error)))
                    }
                }  
            }

            if (schema.additionalProperties) {
                for (const [k, v] of Object.entries(val)) {
                    if (matched.has(k)) {
                        continue
                    }

                    const error = checkSchema(v, schema.additionalProperties)
                    if (error) {
                        errors.push(new ValidationError(`${k}: ${error.message}`, v, schema.additionalProperties, Array.from(error)))
                    }
                }
            }

            if (errors.length > 0) {
                return new ValidationError('Failed to validate object', val, schema, errors)
            }

            break
        }
    }
}

class AggregateError<T extends Error> extends Error implements Iterable<T> {
    constructor(message: string, private readonly errors: T[]) {
        super(message)
    }

    public [Symbol.iterator]() {
        return this.errors[Symbol.iterator]()
    }
}

class ValidationError extends AggregateError<ValidationError> {
    public readonly name = 'ValidationError'

    constructor(message: string, value: unknown, schema: Schema, reasons: ValidationError[] = []) {
        super(message, reasons)
    }

    // Only used to format the error message
    public throw(): never {
        const message = format(this)
        const error = new Error(message)
        error.name = this.name

        throw error
    }
}

function format(error: ValidationError, depth = 0): string {
    const message = [
        error.message, 
        ...Array.from(error).map(e => format(e, depth + 1))
    ]

    return message.map(s => `${'  '.repeat(depth)}${s}`).join('\n')
}