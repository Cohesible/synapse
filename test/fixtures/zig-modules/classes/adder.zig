const js = @import("js");

pub const Adder = struct {
    a: u32,

    pub fn init(a: u32) @This() {
        return .{ .a = a };
    }

    pub fn add(this: *@This(), b: u32) u32 {
        return this.a + b;
    }
};

comptime {
    js.registerModule(@This());
}

