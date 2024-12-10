const js = @import("js");

pub fn waitForPromise(p: *js.Value) *js.Value {
    return js.waitForPromise(p) catch unreachable;
}

comptime {
    js.registerModule(@This());
}

