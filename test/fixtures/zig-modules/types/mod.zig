pub const MyStruct = struct {
    foo: u32,
};

pub fn getStruct(foo: u32) MyStruct {
    return .{ .foo = foo };
}

pub const MyNestedStruct = struct {
    foo: u32,
    nested: MyStruct,
};

pub fn getNestedStruct(foo: u32) MyNestedStruct {
    return .{ 
        .foo = foo,
        .nested = .{ .foo = foo },
    };
}

pub fn getFoo(s: MyStruct) u32 {
    return s.foo;
}

pub fn addU64(a: u64, b: u64) u64 {
    return a + b;
}
