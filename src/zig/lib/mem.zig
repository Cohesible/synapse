const std = @import("std");
const builtin = @import("builtin");
const isWasm = builtin.target.isWasm();

pub const allocator = if (isWasm) toAllocator(&std.heap.WasmPageAllocator{}) else std.heap.c_allocator;

pub fn strlen(source: [*:0]const u8) usize {
    var i: usize = 0;
    while (source[i] != 0) i += 1;
    return i;
}

export fn memcpy(dest: [*]u8, src: [*]const u8, len: usize) [*]u8 {
    for (0..len) |i| {
        dest[i] = src[i];
    }
    return dest;
}

export fn memset(dest: [*]u8, fill: u8, count: usize) [*]u8 {
    for (0..count) |i| {
        dest[i] = fill;
    }
    return dest;
}

fn toAllocator(a: *const std.heap.WasmPageAllocator) std.mem.Allocator {
    return std.mem.Allocator{
        .ptr = @constCast(a),
        .vtable = &std.heap.WasmPageAllocator.vtable,
    };
}
