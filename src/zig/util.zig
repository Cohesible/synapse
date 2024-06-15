const js = @import("./lib/js.zig");

pub fn waitForPromise(p: *js.Value) *js.Value {
    return js.waitForPromise(p) catch unreachable;
}

comptime {
    js.registerModule(@This());
}

