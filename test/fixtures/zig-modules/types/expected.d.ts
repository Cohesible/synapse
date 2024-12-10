export interface MyStruct {
    foo: number;
}
export declare function getStruct(foo: number): MyStruct;
export interface MyNestedStruct {
    foo: number;
    nested: MyStruct;
}
export declare function getNestedStruct(foo: number): MyNestedStruct;
export declare function getFoo(s: MyStruct): number;
export declare function addU64(a: number | bigint, b: number | bigint): number | bigint;
