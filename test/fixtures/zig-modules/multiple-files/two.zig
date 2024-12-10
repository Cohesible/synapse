const add = @import("./shared.zig").add;

pub fn addTwo(a: u32) u32 {
    return add(a, 2);
}
