const add = @import("./shared.zig").add;

pub fn addOne(a: u32) u32 {
    return add(a, 1);
}
