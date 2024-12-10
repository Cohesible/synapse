const js = @import("js"); 

pub fn add(a: u32, b: u32) js.Promise(u32) {
    return .{ a + b };
}

pub fn throwMe() !js.Promise(void) {
    return error.Failed;
}

pub fn returnVoid() js.Promise(void) {
    return .{};
}

