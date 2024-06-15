//@internal
//# moduleId = synapse:reify

import type { Schema, TypedObjectSchema, TypedArraySchema, TypedStringSchema, TypedNumberSchema } from 'synapse:validation'


export declare function schema(): never
export declare function schema<const T extends any[]>(): TypedArraySchema<T>
export declare function schema<const T extends object>(): TypedObjectSchema<T>
export declare function schema<const T extends string>(): TypedStringSchema<T>
export declare function schema<const T extends number>(): TypedNumberSchema<T>

/** @internal */
export function __schema(obj: any): any {
    return obj
}

// export declare function check<T>(val: unknown): asserts val is T
