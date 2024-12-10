const js = @import("js");
const std = @import("std");

pub fn concat(a: js.UTF8String, b: js.UTF8String) !js.UTF8String {
    if (a.data.len == 1) {
        return error.StringTooSmall;
    }

    var buf = try std.heap.c_allocator.allocSentinel(u8, a.data.len + b.data.len, 0);
    @memcpy(buf[0..a.data.len], a.data);
    @memcpy(buf[a.data.len..], b.data);

    return .{ .data = buf };
}

