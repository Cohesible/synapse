const std = @import("std");
const Type = std.builtin.Type;


extern fn napi_fatal_error(location: [*:0]const u8, location_len: usize, message: [*:0]const u8, message_len: usize) noreturn;

pub const Value = opaque {};

const CallFrame = opaque {
    extern fn napi_get_cb_info(env: *Env, frame: *CallFrame, argc: *usize, argv: [*]*Value, this: **Value, data: **anyopaque) Status;

    pub fn get_args(this: *CallFrame, env: *Env, comptime maxArgs: usize) !struct { [maxArgs]*Value, *Value, *anyopaque } {
        var argc = maxArgs;
        var argv: [maxArgs]*Value = undefined;
        var this_arg: *Value = undefined;
        var data: *anyopaque = undefined;
        const status = napi_get_cb_info(env, this, &argc, &argv, &this_arg, &data);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return .{ argv, this_arg, data };
    }
};

const Object = opaque {
    extern fn napi_create_object(env: *Env, result: **Object) Status;
    extern fn napi_set_named_property(env: *Env, object: *Object, name: [*:0]const u8, value: *Value) Status;
    extern fn napi_define_properties(env: *Env, object: *Object, len: usize, descriptors: [*]PropertyDescriptor) Status;

    pub fn init(env: *Env) !*Object {
        var result: *Object = undefined;
        const status = napi_create_object(env, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn setNamedProperty(this: *Object, env: *Env, name: [:0]const u8, value: *Value) !void {
        const status = napi_set_named_property(env, this, name, value);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn defineProperties(this: *Object, env: *Env, descriptors: []PropertyDescriptor) !void {
        const status = napi_define_properties(env, this, descriptors.len, descriptors.ptr);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }
};

const Class = opaque {
    extern fn napi_define_class(
        env: *Env,
        utf8name: [*]const u8,
        name_length: usize,
        constructor: *const NativeFn,
        data: ?*anyopaque,
        property_count: usize,
        descriptors: [*]PropertyDescriptor,
        result: **Value
    ) Status;
};

const Ref = opaque {
    extern fn napi_create_reference(env: *Env, value: *Value, initial_refcount: u32, result: **Ref) Status;

    extern fn napi_add_finalizer(env: *Env, obj: *Object, data: ?*anyopaque, cb: *const FinalizeFn, hint: ?*anyopaque, result: **Ref) Status;

    pub fn init(env: *Env, value: *Value, count: u32) !*Ref {
        var result: *Ref = undefined;
        const status = napi_create_reference(env, value, count, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    fn Finalizer(comptime T: type) FinalizeFn {
        return struct {
            pub fn cb(env: *Env, data: ?*anyopaque, hint: ?*anyopaque) void {
                _ = env;
                _ = hint;
                var this: *T = @alignCast(@ptrCast(data orelse unreachable));
                this.deinit();
            }
        }.cb;
    }

    pub fn addFinalizer(env: *Env, obj: *Object, comptime T: type, instance: *T) !*Ref {
        const finalizer = Finalizer(T);
        var result: *Ref = undefined;
        const status = napi_add_finalizer(env, obj, instance, &finalizer, null, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }
};

const String = opaque {
    extern fn napi_get_value_string_latin1(env: *Env, value: *String, buf: [*]u8, bufsize: usize, result: ?*usize) Status;
    extern fn napi_get_value_string_utf8(env: *Env, value: *String, buf: ?[*]u8, bufsize: usize, result: ?*usize) Status;
    extern fn napi_get_value_string_utf16(env: *Env, value: *String, buf: [*]u16, bufsize: usize, result: ?*usize) Status;

    extern fn napi_create_string_utf8(env: *Env, str: [*]const u8, len: usize, result: **String) Status;

    const FinalizeCb = fn (env: *Env, data: *anyopaque, hint: ?*anyopaque) void;
    // `cb` -> `FinalizeCb`
    extern fn node_api_create_external_string_latin1(env: *Env, str: [*]const u8, len: usize, cb: *const anyopaque, hint: ?*anyopaque, result: **String, copied: *bool) Status;

    pub fn fromUtf8(env: *Env, str: []const u8) !*String {
        var result: *String = undefined;
        const status = napi_create_string_utf8(env, str.ptr, str.len, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    fn deleteExternal(env: *Env, data: *anyopaque, hint: ?*anyopaque) void {
        _ = env;
        _ = data;
        _ = hint;
    }

    pub fn fromLatin1External(env: *Env, str: []const u8) !*String {
        var result: *String = undefined;
        var copied: bool = undefined;
        const status = node_api_create_external_string_latin1(env, str.ptr, str.len, &deleteExternal, null, &result, &copied);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn toUtf8Buf(this: *String, env: *Env, buf: []u8) !usize {
        var size = buf.len;
        const status = napi_get_value_string_utf8(env, this, buf.ptr, size, &size);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return size;
    }

    pub fn toUtf8(this: *String, env: *Env, allocator: std.mem.Allocator) ![:0]u8 {
        // Takes an extra call to get the length...
        var size: usize = 0;
        var status = napi_get_value_string_utf8(env, this, null, size, &size);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        var buf = try allocator.alloc(u8, size + 1);
        status = napi_get_value_string_utf8(env, this, buf.ptr, size+1, null);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        // res[size] = 0;
    
        return buf[0..size :0];
    }
};

const Number = opaque {
    // NAPI_EXTERN napi_status NAPI_CDECL napi_get_value_double(napi_env env,
    //                                                          napi_value value,
    //                                                          double* result);
    // NAPI_EXTERN napi_status NAPI_CDECL napi_get_value_int32(napi_env env,
    //                                                         napi_value value,
    //                                                         int32_t* result);
    // NAPI_EXTERN napi_status NAPI_CDECL napi_get_value_int64(napi_env env,
    //                                                         napi_value value,
    //                                                         int64_t* result);
    // NAPI_EXTERN napi_status NAPI_CDECL napi_create_double(napi_env env,
    //                                                       double value,
    //                                                       napi_value* result);
    // NAPI_EXTERN napi_status NAPI_CDECL napi_create_int32(napi_env env,
    //                                                      int32_t value,
    //                                                      napi_value* result);
    // NAPI_EXTERN napi_status NAPI_CDECL napi_create_uint32(napi_env env,
    //                                                       uint32_t value,
    //                                                       napi_value* result);
    // NAPI_EXTERN napi_status NAPI_CDECL napi_create_int64(napi_env env,
    //                                                      int64_t value,
    //                                                      napi_value* result);

    extern fn napi_get_value_uint32(env: *Env, value: *Number, result: *u32) Status;
    extern fn napi_get_value_int32(env: *Env, value: *Number, result: *i32) Status;

    extern fn napi_create_uint32(env: *Env, value: u32, result: **Number) Status;
    extern fn napi_create_int32(env: *Env, value: i32, result: **Number) Status;

    pub fn createU32(env: *Env, val: u32) !*Number {
        var result: *Number = undefined;
        const status = napi_create_uint32(env, val, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }

    pub fn createI32(env: *Env, val: i32) !*Number {
        var result: *Number = undefined;
        const status = napi_create_int32(env, val, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }

    pub fn toU32(this: *Number, env: *Env) !u32 {
        var val: u32 = undefined;
        const status = napi_get_value_uint32(env, this, &val);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return val;
    }

    pub fn toI32(this: *Number, env: *Env) !i32 {
        var val: i32 = undefined;
        const status = napi_get_value_int32(env, this, &val);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return val;
    }
};

const Boolean = opaque {
    extern fn napi_get_boolean(env: *Env, val: bool, result: **Boolean) Status;

    pub fn getBoolean(env: *Env, val: bool) !*Boolean {
        var result: *Boolean = undefined;
        const status = napi_get_boolean(env, val, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }
};

const PropertyAttributes = enum(u32) {
    napi_default = 0,
    napi_writable = 1 << 0,
    napi_enumerable = 1 << 1,
    napi_configurable = 1 << 2,

    // Used with napi_define_class to distinguish static properties
    // from instance properties. Ignored by napi_define_properties.
    napi_static = 1 << 10,

    // Default for class methods.
    napi_default_method = .napi_writable | .napi_configurable,

    // Default for object properties, like in JS obj[prop].
    napi_default_jsproperty = .napi_writable |
        .napi_enumerable |
        .napi_configurable,
};

const PropertyDescriptor = extern struct {
    // One of utf8name or name should be NULL.
    utf8name: [:0]const u8,
    name: *Value,

    method: *NativeFn,
    getter: *NativeFn,
    setter: *NativeFn,
    value: *Value,

    attributes: PropertyAttributes,
    data: *anyopaque,
};

const Function = opaque {
    extern fn napi_create_function(env: *Env, name: [*]const u8, len: usize, cb: *const anyopaque, data: ?*anyopaque, result: **Function) Status;
    extern fn napi_create_fastcall_function(env: *Env, name: [*]const u8, len: usize, cb: *const anyopaque, fast_cb: *CFunction, data: ?*anyopaque, result: **Function) Status;

    pub fn init(env: *Env, name: []const u8, cb: *const NativeFn) !*Function {
        var result: *Function = undefined;
        const status = napi_create_function(env, name.ptr, name.len, cb, null, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn initFastcall(env: *Env, name: []const u8, cb: *const NativeFn, fast_cb: *CFunction) !*Function {
        var result: *Function = undefined;
        const status = napi_create_fastcall_function(env, name.ptr, name.len, cb, fast_cb, null, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }
};

const CFunction = opaque {
    const CType = enum(u32) {
        void,
        bool,
        uint8,
        int32,
        uint32,
        int64,
        uint64,
        float32,
        float64,
        pointer,
        v8_value,
        seq_one_byte_string,
        api_obj,
        any,
    };

    const CSeqType = enum(u32) {
        scalar,
        seq,
        typed_array,
        array_buffer,
    };

    const TypeFlag = enum(u32) {
        none = 0,
        allow_shared = 1 << 0,      // Must be an ArrayBuffer or TypedArray
        enforce_range = 1 << 1,     // T must be integral
        clamp = 1 << 2,             // T must be integral
        restricted = 1 << 3,        // T must be float or double
    };

    const CTypeDef = extern struct {
        ty: CType,
        sequence_type: CSeqType = .scalar,
        flags: TypeFlag = .none,
    };

    const CFunctionDef = extern struct {
        return_type: CTypeDef,
        args: [*]const CTypeDef,
        arg_count: u32,
        uses_options: bool,
    };

    extern fn napi_create_cfunction(def: *const CFunctionDef, cb: *const anyopaque, result: **CFunction) Status;

    pub fn init(def: *const CFunctionDef, cb: *const anyopaque) !*CFunction {
        var result: *CFunction = undefined;
        const status = napi_create_cfunction(def, cb, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }
};

// NAPI_EXTERN napi_status NAPI_CDECL napi_get_last_error_info(
//     node_api_nogc_env env, const napi_extended_error_info** result);

const ArrayPointer = opaque {
    extern fn napi_set_element(env: *Env, object: *ArrayPointer, index: u32, val: *Value) Status;
    extern fn napi_has_element(env: *Env, object: *ArrayPointer, index: u32, result: *bool) Status;
    extern fn napi_get_element(env: *Env, object: *ArrayPointer, index: u32, result: **Value) Status;
    extern fn napi_delete_element(env: *Env, object: *ArrayPointer, index: u32, result: *bool) Status;
    extern fn napi_get_array_length(env: *Env, object: *ArrayPointer, result: *u32) Status;

    const IterateResult = enum(u8) {
        _exception,
        _break,
        _continue,
    };

    const IterateCb = fn (index: u32, element: *Value, data: *anyopaque) IterateResult;

    // cb -> *const IterateCb
    extern fn napi_iterate(env: *Env, object: *ArrayPointer, cb: *const anyopaque, data: *anyopaque) Status;

    pub fn set(this: *ArrayPointer, env: *Env, index: u32, val: *Value) !void {
        const status = napi_set_element(env, this, index, val);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn get(this: *ArrayPointer, env: *Env, index: u32) !*Value {
        var result: *Value = undefined;
        const status = napi_get_element(env, this, index, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn length(this: *ArrayPointer, env: *Env) !u32 {
        var result: u32 = undefined;
        const status = napi_get_array_length(env, this, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    fn copyTo(index: u32, element: *Value, data: *anyopaque) IterateResult {
        var buf: [*]*Value = @alignCast(@ptrCast(data));
        buf[index] = element;
        return ._continue;
    }

    pub fn copy(this: *ArrayPointer, env: *Env, allocator: std.mem.Allocator) ![]*Value {
        const len = try this.length(env);
        if (len == 0) {
            return &[_]*Value{};
        }

        const buf = try allocator.alloc(*Value, len);
        for (0..len) |i| {
            buf[i] = try this.get(env, @intCast(i));
        }

        // Doesn't work currently
        // const status = napi_iterate(env, this, &ArrayPointer.copyTo, @ptrCast(buf.ptr));
        // if (status != .napi_ok) {
        //     return error.NotOk;
        // }

        return buf;
    }
};

// fn Array(comptime T: type) type {}

const External = opaque {
    const FinalizeCb = fn (env: *Env, data: *anyopaque, hint: ?*anyopaque) void;

    extern fn napi_create_external(env: *Env, data: *anyopaque, finalize_cb: ?*const FinalizeCb, finalize_hint: ?*anyopaque, result: **External) Status;
    extern fn napi_get_value_external(env: *Env, value: *External, result: **anyopaque) Status;
};

pub const ArrayBuffer = struct {
    buf: []u8,
    value: *ArrayBufferRaw = undefined,
    hasValue: bool = false,
    isOwned: bool = false,

    pub fn init(len: usize) !ArrayBuffer {
        const wrap = try EnvWrap.getWrap(currentEnv);
        const buf = try wrap.allocator.alloc(u8, len);

        return .{ .buf = buf, .isOwned = true };
    }

    pub fn initJs(len: usize) !ArrayBuffer {
        return ArrayBufferRaw.initJs(currentEnv, len);
    }

    pub fn from(buf: []u8) !ArrayBuffer {
        return .{ .buf = buf, .isOwned = true };
    }

    pub fn resize(this: *ArrayBuffer, len: usize) !void {
        if (this.buf.len >= len) {
            this.buf.len = len;
        } else {
            // TODO
            unreachable;
        }
    }

    pub fn toValue(this: *ArrayBuffer) !*Value {
        if (!this.hasValue) {
            const val = try ArrayBufferRaw.initExternal(currentEnv, this.buf);
            this.value = val;
            this.hasValue = true;
        }

        return @ptrCast(this.value);
    }
};

pub const ArrayBufferRaw = opaque {
    extern fn napi_is_arraybuffer(env: *Env, value: *Value, result: *bool) Status;

    // `data` is an output
    extern fn napi_create_arraybuffer(env: *Env, len: usize, data: **anyopaque, result: **ArrayBufferRaw) Status;
    extern fn napi_create_external_arraybuffer(env: *Env, data: *anyopaque, len: usize, cb: *const anyopaque, hint: ?*anyopaque, result: **ArrayBufferRaw) Status;
    extern fn napi_create_external_arraybuffer2(env: *Env, data: *anyopaque, len: usize, cb: *const anyopaque, hint: ?*anyopaque, result: **ArrayBufferRaw) Status;


    pub fn initJs(env: *Env, len: usize) !ArrayBuffer {
        var data: *anyopaque = undefined;
        var value: *ArrayBufferRaw = undefined;
        const status = napi_create_arraybuffer(env, len, &data, &value);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        var buf: [*]u8 = @ptrCast(data);

        return .{
            .buf = buf[0..len],
            .value = value,
            .hasValue = true,
        };
    }

    fn finalize(data: ?*anyopaque, len: usize, _: ?*anyopaque) void {
        const wrap = EnvWrap.getWrap(currentEnv) catch return;
        var d: [*]u8 = @ptrCast(data);
        wrap.allocator.free(d[0..len]);
    }


    fn finalize_old(env: *Env, data: *anyopaque, hint: ?*anyopaque) void {
        const wrap = EnvWrap.getWrap(env) catch return;
        var d: [*]u8 = @ptrCast(data);
        wrap.allocator.free(d[0..@intFromPtr(hint)]);
    }

    pub fn initExternal(env: *Env, buf: []u8) !*ArrayBufferRaw {
        var value: *ArrayBufferRaw = undefined;
        // const status = napi_create_external_arraybuffer2(env, buf.ptr, buf.len, finalize, null, &value);
        const status = napi_create_external_arraybuffer(env, buf.ptr, buf.len, finalize_old, @ptrFromInt(buf.len), &value);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return value;
    }

    pub fn initCopy(env: *Env, buf: []u8) !*ArrayBufferRaw {
        var data: *anyopaque = undefined;
        var value: *ArrayBufferRaw = undefined;
        const status = napi_create_arraybuffer(env, buf.len, &data, &value);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        const d: [*]u8 = @ptrCast(data);
        @memcpy(d, buf);

        return value;
    }
};

const TypedArray = opaque {
    const ArrayType = enum(u32) {
        int8,
        uint8,
        uint8_clamped,
        uint16,
        int32,
        uint32,
        float32,
        float64,
        bigint64,
        biguint64,
    };

    extern fn napi_get_typedarray_info(env: *Env, value: *TypedArray, ty: *ArrayType, length: *usize, data: **anyopaque, arraybuffer: **ArrayBufferRaw, byte_offset: *usize) Status;

    const Info = struct {
        ty: ArrayType,
        len: usize,
        data: *anyopaque,
        array_buffer: *ArrayBufferRaw,
        byte_offset: usize,
    };

    pub fn get_info(self: *TypedArray, env: *Env) !Info {
        var info: Info = .{
            .ty = undefined,
            .len = undefined,
            .data = undefined,
            .array_buffer = undefined,
            .byte_offset = undefined,
        };

        const status = napi_get_typedarray_info(env, self, &info.ty, &info.len, &info.data, &info.array_buffer, &info.byte_offset);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return info;
    }
};

const ModuleInit = fn (env: *Env, exports: *Object) void;

const Module = opaque {
    const ModuleDesc = extern struct {
        nm_version: u32,
        nm_flags: u32,
        nm_filename: [:0]const u8,
        nm_register_func: *ModuleInit,
        nm_modname: [:0]const u8,
        nm_priv: *anyopaque,
        reserved: [4]*anyopaque,
    };

    extern fn napi_module_register(mod: *ModuleDesc) void;
};

const FastFunc = struct {
    cb: *const anyopaque,
    def: *const CFunction.CFunctionDef,
};

const FnDecl = struct {
    name: []const u8,
    cb: *const NativeFn,
    fast_call_def: ?FastFunc,
};

fn MakeTuple(comptime t: Type.Fn) type {
    var fields: [t.params.len]Type.StructField = undefined;
    const z = Type{ .Struct = Type.Struct{
        .is_tuple = true,
        .layout = .auto,
        .fields = &fields,
        .decls = &[0]Type.Declaration{},
    } };
    comptime var x = 0;
    for (t.params) |a| {
        var buf: [32]u8 = undefined;
        const zz = std.fmt.formatIntBuf(&buf, x, 10, .lower, .{});
        buf[zz] = 0;
        fields[x] = Type.StructField{
            .name = buf[0..zz :0],
            .type = a.type orelse unreachable,
            .default_value = null,
            .is_comptime = false,
            .alignment = @alignOf(a.type orelse unreachable),
        };
        x += 1;
    }
    return @Type(z);
}

pub const FastOneByteString = extern struct {
    data: [*]const u8,
    length: u32,
};

pub const FastU32Array = extern struct {
    data: [*]u32,
    length: usize,
};

fn toCTypeDef(comptime T: type) ?CFunction.CTypeDef {
    return switch (T) {
        void => CFunction.CTypeDef{ .ty = .void },

        i8 => CFunction.CTypeDef{ .ty = .int32 },
        i16 => CFunction.CTypeDef{ .ty = .int32 },
        i32 => CFunction.CTypeDef{ .ty = .int32 },
        i64 => CFunction.CTypeDef{ .ty = .int64 },

        u8 => CFunction.CTypeDef{ .ty = .uint8 },
        u16 => CFunction.CTypeDef{ .ty = .uint32 }, // There's no uint16
        u32 => CFunction.CTypeDef{ .ty = .uint32 },
        u64 => CFunction.CTypeDef{ .ty = .uint64 },

        f32 => CFunction.CTypeDef{ .ty = .float32 },
        f64 => CFunction.CTypeDef{ .ty = .float64 },

        // []u8 => CFunction.CTypeDef{ .ty = .uint8, .sequence_type = .typed_array },
        FastU32Array => CFunction.CTypeDef{ .ty = .uint32, .sequence_type = .typed_array },
        FastOneByteString => CFunction.CTypeDef{ .ty = .seq_one_byte_string },
        *anyopaque => CFunction.CTypeDef{ .ty = .pointer },

        *Value => CFunction.CTypeDef{ .ty = .v8_value },
        *Receiver => CFunction.CTypeDef{ .ty = .v8_value },
        else => null,
    };
}

const Uint8Array = opaque {

};

const CTypedArrayRaw = extern struct {
    length: usize,
     // only guaranteed to be 4-byte aligned, 8-byte alignment needs to be handled separately
    data: *anyopaque,
};

fn CTypedArray(comptime T: type) type {
    return extern struct {
        length: usize,
        data: [*]T,
    };
}

fn makeFastcallFnDef(comptime t: Type.Fn) ?CFunction.CFunctionDef {
    var args: [t.params.len]CFunction.CTypeDef = undefined;
    inline for (t.params, 0..t.params.len) |p, i| {
        args[i] = toCTypeDef(p.type orelse unreachable) orelse return null;
    }

    const final = args[0..args.len].*;

    return .{
        .return_type = toCTypeDef(t.return_type orelse unreachable) orelse return null,
        .args = &final,
        .arg_count = t.params.len,
        .uses_options = false,
    };
}

fn makeFn(comptime t: Type.Fn, comptime v: anytype) NativeFn {
    const Args = MakeTuple(t);
    const ReturnType = t.return_type orelse unreachable;
    const FnErrorTypes = getErrorTypes(ReturnType);
    const PromiseType = getPromiseType(if (FnErrorTypes) |z| z.payload else ReturnType);

    if (PromiseType != null) {
        return struct {
            fn cb(env: *Env, info: *CallFrame) ?*Value {
                return @ptrCast(runAsyncFn(v, env, info) catch return null);
            }
        }.cb;
    }

    const s = struct {
        fn cb(env: *Env, info: *CallFrame) ?*Value {
            const wrap = EnvWrap.getWrap(env) catch return null;
            var converter = wrap.initConverter();
            defer converter.deinit();

            const z = info.get_args(env, t.params.len) catch return null;
            var args: Args = undefined;
            if (t.params.len > 0 and t.params[0].type == *Receiver) {
                args[0] = converter.fromJs(t.params[0].type orelse unreachable, z[1]) catch return null;
                inline for (z[0][0 .. t.params.len - 1], 1..t.params.len) |x, i| {
                    args[i] = converter.fromJs(t.params[i].type orelse unreachable, x) catch return null;
                }
            } else {
                inline for (z[0], 0..t.params.len) |x, i| {
                    args[i] = converter.fromJs(t.params[i].type orelse unreachable, x) catch return null;
                }
            }

            if (FnErrorTypes) |types| {
                const ret = @call(.always_inline, v, args) catch |e| {
                    const err = toValue(anyerror, wrap, e) orelse return null;
                    wrap.throw(err) catch @panic("Failed to throw error");
                    return null;
                };

                return toValue(types.payload, wrap, ret);
            }

            const ret = @call(.always_inline, v, args);

            return toValue(ReturnType, wrap, ret);
        }
    };

    return s.cb;
}

const HandleScope = opaque { 
    extern fn napi_open_handle_scope(env: *Env, result: **HandleScope) Status;
    extern fn napi_close_handle_scope(env: *Env, scope: *HandleScope) Status;

    pub fn init(env: *Env) !*HandleScope {
        var result: *HandleScope = undefined;
        const status = napi_open_handle_scope(env, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn deinit(this: *HandleScope, env: *Env) !void {
        const status = napi_close_handle_scope(env, this);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }
};

var currentEnv: *Env = undefined;
fn MakeInit(comptime decls: []const FnDecl) type {
    return struct {
        fn init(env: *Env, exports: *Object) callconv(.C) ?*Object {
            currentEnv = env;

            const wrap = EnvWrap.getWrap(env) catch return null;
            //var scope = HandleScope.init(env) catch return null;

            inline for (decls) |d| {
                if (d.fast_call_def) |s| {
                    const fast_cb = CFunction.init(s.def, s.cb) catch return null;
                    const zz = Function.initFastcall(env, d.name, d.cb, fast_cb) catch return null;
                    const n: [:0]u8 = wrap.allocator.allocSentinel(u8, d.name.len, 0) catch return null;
                    @memcpy(n, d.name);
                    exports.setNamedProperty(env, n, @ptrCast(zz)) catch {};
                } else {
                    const zz = Function.init(env, d.name, d.cb) catch return null;
                    const n: [:0]u8 = wrap.allocator.allocSentinel(u8, d.name.len, 0) catch return null;
                    @memcpy(n, d.name);
                    exports.setNamedProperty(env, n, @ptrCast(zz)) catch {};
                }
            }

            //scope.deinit(env) catch {};

            return null;
        }
    };
}

pub fn registerModule(comptime T: type) void {
    comptime var numDecls = 0;
    comptime var decls: [256]FnDecl = undefined;
    const info = @typeInfo(T);

    switch (info) {
        .Struct => |s| {
            inline for (s.decls) |decl| {
                const val = @field(T, decl.name);
                const t = @typeInfo(@TypeOf(val));

                switch (t) {
                    .Fn => |f| {
                        const S = struct {
                            const fn_def = makeFastcallFnDef(f);
                        };
                        const d = FnDecl{
                            .name = decl.name,
                            .cb = &makeFn(f, val),
                            // TODO: the fast call cb needs to use a modified preamble for certain value types
                            // currently typed arrays (e.g. []u8) result in a bus error
                            .fast_call_def = if (S.fn_def) |d| .{ .cb = &val, .def = &d } else null,
                        };
                        decls[numDecls] = d;
                        numDecls += 1;
                    },
                    else => {},
                }
            }
        },
        else => {},
    }

    const final = decls[0..numDecls].*;
    const initStruct = MakeInit(&final);
    @export(initStruct.init, .{ .name = "napi_register_module_v1", .linkage = .strong });
}

const EscapableHandleScope = opaque {
    extern fn napi_open_escapable_handle_scope(env: *Env, result: **EscapableHandleScope) Status;
    extern fn napi_close_escapable_handle_scope(env: *Env, scope: *EscapableHandleScope) Status;
    extern fn napi_escape_handle(env: *Env, scope: *EscapableHandleScope, escapee: *Value, result: **Value) Status;

    pub fn open(env: *Env) !*EscapableHandleScope {
        var result: *EscapableHandleScope = undefined;
        const status = napi_open_escapable_handle_scope(env, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn close(this: *EscapableHandleScope, env: *Env) !void {
        const status = napi_close_escapable_handle_scope(env, this);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn escape(this: *EscapableHandleScope, env: *Env, escapee: *Value) !*Value {
        var result: *Value = undefined;
        const status = napi_escape_handle(env, this, escapee, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }
};

const task_name = "task";

const AsyncTask = opaque {
    const Execute = *const fn (*Env, ?*anyopaque) void;
    const Complete = *const fn (*Env, Status, ?*anyopaque) void;

    extern fn napi_create_async_work(
        env: *Env,
        resource: ?*Value,
        name: ?*Value,
        exec: *const anyopaque, // Execute
        complete: *const anyopaque, // Complete
        data: ?*anyopaque,
        result: **AsyncTask,
    ) Status;

    extern fn napi_queue_async_work(env: *Env, task: *AsyncTask) Status;
    extern fn napi_cancel_async_work(env: *Env, task: *AsyncTask) Status;
    extern fn napi_delete_async_work(env: *Env, task: *AsyncTask) Status;

    extern fn napi_schedule_async_work(env: *Env, exec: *const anyopaque, complete: *const anyopaque, data: ?*anyopaque) Status;

    pub fn init(env: *Env, exec: Execute, complete: Complete, data: ?*anyopaque) !*AsyncTask {
        var result: *AsyncTask = undefined;
        const name = try String.fromUtf8(env, task_name);
        const status = napi_create_async_work(env, null, @ptrCast(name), exec, complete, data, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return result;
    }

    pub fn start(this: *AsyncTask, env: *Env) !void {
        const status = napi_queue_async_work(env, this);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn cancel(this: *AsyncTask, env: *Env) !void {
        const status = napi_cancel_async_work(env, this);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn deinit(this: *AsyncTask, env: *Env) !void {
        const status = napi_delete_async_work(env, this);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn schedule(env: *Env, exec: Execute, complete: Complete, data: ?*anyopaque) !void {
        const status = napi_schedule_async_work(env, exec, complete, data);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }
};

inline fn fatal(src: std.builtin.SourceLocation, msg: [:0]const u8) noreturn {
    var buf: [1024]u8 = undefined;
    const location = std.fmt.bufPrintZ(&buf, "{s}:{d}:{d}", .{src.file, src.line, src.column}) catch unreachable;
    napi_fatal_error(location.ptr, location.len, msg.ptr, msg.len);
}

fn toValue(comptime T: type, envWrap: *EnvWrap, val: T) ?*Value {
    return switch (T) {
        void => null,
        bool => envWrap.getBool(val) catch fatal(@src(), "Failed to create bool"),
        anyerror => {
            const err = envWrap.env.createError(val, "Native error") catch fatal(@src(), "Failed to create error");
            return @ptrCast(err);
        },
        i32 => @ptrCast(Number.createI32(envWrap.env, val) catch fatal(@src(), "Failed to create number")),
        u32 => @ptrCast(Number.createU32(envWrap.env, val) catch fatal(@src(), "Failed to create number")),
        *PromiseValue => @ptrCast(val),
        UTF8String => {
            const v = String.fromUtf8(envWrap.env, val.data) catch fatal(@src(), "Failed to create string");
            return @ptrCast(v);
        },
        ArrayBuffer => {
            var ab = val;
            return ArrayBuffer.toValue(&ab) catch fatal(@src(), "Failed to create buffer");
        },
        *ArrayBuffer => val.toValue() catch fatal(@src(), "Failed to create buffer"),
        *Value => val,
        else => fatal(@src(), "Invalid type"),
    };
}

fn runAsyncFn(comptime func: anytype, env: *Env, info: *CallFrame) !*PromiseValue {
    const Func = AsyncFn(func);
    const frame = try Func.init(env, info);
    const task = try AsyncTask.init(env, &Func.run, &Func.complete, frame);
    frame.task = task;

    try task.start(env);

    // try AsyncTask.schedule(env, &Func.run, &Func.complete, frame);

    return frame.wrap.promise;
}

fn getFnType(comptime val: anytype) Type.Fn {
    return switch (@typeInfo(@TypeOf(val))) {
        .Fn => |f| f,
        else => unreachable,
    };
}

fn getOptionalType(comptime val: anytype) Type.Optional {
    return switch (@typeInfo(@TypeOf(val))) {
        .Optional => |o| o,
        else => unreachable,
    };
}

const PromiseMarker = struct {};

fn getPromiseType(comptime t: type) ?type {
    const info = @typeInfo(t);
    const s = switch (info) {
        .Struct => |s| s,
        else => return null,
    };

    if (!s.is_tuple or s.fields.len > 2) {
        return null;
    }

    if (s.fields[0].type == PromiseMarker) {
        return void;
    }

    if (s.fields.len != 2 or s.fields[1].type != PromiseMarker) {
        return null;
    }

    return s.fields[0].type;
}

/// Functions that return a Promise will appear asynchronous to
/// JavaScript callers by running the function in a separate thread.
pub fn Promise(comptime T: type) type {
    if (T == void) {
        return struct {
            void = undefined,
            PromiseMarker = undefined,
        };
    }

    return struct {
        T,
        PromiseMarker = undefined,
    };
}

comptime {
    if (@sizeOf(Promise(void)) != 0) {
        @compileError("Expected Promise(void) to be 0 bytes");
    }

    if (@sizeOf(Promise(u8)) != 1) {
        @compileError("Expected Promise(u8) to be 1 byte");
    }

    if (getPromiseType(struct{u8, struct{}}) != null) {
        @compileError("Expected `getPromiseType` to only work with PromiseMarker");
    }
}

fn getErrorTypes(comptime t: type) ?Type.ErrorUnion {
    return switch (@typeInfo(t)) {
        .ErrorUnion => |s| s,
        else => return null,
    };
}

fn getArrayElementType(comptime T: type) ?type {
    const info = @typeInfo(T);
    const s = switch (info) {
        .Struct => |s| s,
        else => return null,
    };

    if (!@hasField(T, "elements")) return null;

    return switch (@typeInfo(s.fields[0].type)) {
        .Pointer => |a| a.child,
        else => null,
    };
}

// Current overhead (on my machine): ~2000ns
fn AsyncFn(comptime func: anytype) type {
    const funcType = getFnType(func);
    const Args = MakeTuple(funcType);
    const ReturnType = funcType.return_type orelse unreachable;
    const FnErrorTypes = getErrorTypes(ReturnType);

    const PromiseType = getPromiseType(if (FnErrorTypes) |t| t.payload else ReturnType) orelse unreachable;

    const RetSlot = if (FnErrorTypes) |t| blk: {
        break :blk union(enum) {
            val: PromiseType,
            err: t.error_set,
        };
    } else PromiseType;

    const Frame = struct {
        args: Args,
        ret: RetSlot,
        wrap: PromiseWrap,
        task: ?*AsyncTask, // Assigned by the caller
        converter: ValueConverter,

        pub fn init(env: *Env, info: *CallFrame) !*@This() {
            const wrap = try PromiseWrap.init(env);
            const z = try info.get_args(env, funcType.params.len);
            var args: Args = undefined;
            var converter = wrap.envWrap.initConverter();
            inline for (z[0], 0..funcType.params.len) |x, i| {
                args[i] = try converter.fromJs(funcType.params[i].type orelse unreachable, x);
            }

            var this = try converter.arena.allocator().create(@This());
            this.args = args;
            this.wrap = wrap;
            this.converter = converter;
            this.task = null;

            return this;
        }

        pub fn run(_: *Env, data: ?*anyopaque) void {
            var this: *@This() = @alignCast(@ptrCast(data orelse unreachable));
            if (FnErrorTypes != null) {
                const r = @call(.auto, func, this.args) catch |e| {
                    this.ret = .{ .err = e };
                    return;
                };
                this.ret = .{ .val = r[0] };
            } else {
                this.ret = @call(.auto, func, this.args)[0];
            }
        }

        pub fn complete(env: *Env, _: Status, data: ?*anyopaque) void {
            const this: *@This() = @alignCast(@ptrCast(data orelse unreachable));
            defer {
                if (this.task) |task| {
                    task.deinit(env) catch {};
                }

                var conv = this.converter;
                conv.deinit();
            }

            if (FnErrorTypes != null) {
                switch (this.ret) {
                    .val => |r| this.wrap.resolve(toValue(PromiseType, this.wrap.envWrap, r)) catch {},
                    .err => |e| this.wrap.reject(toValue(anyerror, this.wrap.envWrap, e)) catch {},
                }
            } else {
                this.wrap.resolve(toValue(PromiseType, this.wrap.envWrap, this.ret)) catch {};
            }
        }
    };

    return Frame;
}

pub const UTF8String = struct { data: [:0]u8 };

const Env = opaque {
    extern fn napi_create_error(env: *Env, code: *String, msg: *String, result: **Object) Status;
    extern fn napi_get_undefined(env: *Env, result: **Value) Status;
    extern fn napi_get_null(env: *Env, result: **Value) Status;
    extern fn napi_get_boolean(env: *Env, val: bool, result: **Value) Status;

    pub fn getUndefined(this: *Env) !*Value {
        var result: *Value = undefined;
        const status = napi_get_undefined(this, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }

    pub fn getNull(this: *Env) !*Value {
        var result: *Value = undefined;
        const status = napi_get_null(this, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }

    pub fn getBool(this: *Env, val: bool) !*Value {
        var result: *Value = undefined;
        const status = napi_get_boolean(this, val, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }

    pub fn createError(this: *Env, err: anyerror, msg: [:0]const u8) !*Object {
        const errName = @errorName(err);
        const msgString = try String.fromUtf8(this, msg);
        const nameString = try String.fromUtf8(this, errName);

        var result: *Object = undefined;
        const status = napi_create_error(this, nameString, msgString, &result);
        if (status != .napi_ok) {
            return error.NotOk;
        }
        return result;
    }
};

const Status = enum(u16) {
    napi_ok,
    napi_invalid_arg,
    napi_object_expected,
    napi_string_expected,
    napi_name_expected,
    napi_function_expected,
    napi_number_expected,
    napi_boolean_expected,
    napi_array_expected,
    napi_generic_failure,
    napi_pending_exception,
    napi_cancelled,
    napi_escape_called_twice,
    napi_handle_scope_mismatch,
    napi_callback_scope_mismatch,
    napi_queue_full,
    napi_closing,
    napi_bigint_expected,
    napi_date_expected,
    napi_arraybuffer_expected,
    napi_detachable_arraybuffer_expected,
    napi_would_deadlock,
    napi_no_external_buffers_allowed,
    napi_cannot_run_js,
};

const NativeFn = fn (env: *Env, info: *CallFrame) ?*Value;
const FinalizeFn = fn (env: *Env, data: ?*anyopaque, hint: ?*anyopaque) void;
const FinalizeFn2 = fn (data: ?*anyopaque, len: usize, hint: ?*anyopaque) void;

const PromiseValue = opaque {};
const Deferred = opaque {
    extern fn napi_resolve_deferred(env: *Env, deferred: *Deferred, value: *Value) Status;
    extern fn napi_reject_deferred(env: *Env, deferred: *Deferred, value: *Value) Status;

    pub fn resolve(this: *Deferred, env: *Env, value: *Value) !void {
        const status = napi_resolve_deferred(env, this, value);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }

    pub fn reject(this: *Deferred, env: *Env, value: *Value) !void {
        const status = napi_reject_deferred(env, this, value);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }
};

const ValueConverter = struct {
    env: *Env,
    arena: std.heap.ArenaAllocator,

    pub fn deinit(this: *ValueConverter) void {
        this.arena.deinit();
    }

    pub fn fromJs(this: *ValueConverter, comptime T: type, val: *Value) !T {
        if (T == UTF8String) {
            const s: *String = @ptrCast(val);
            const data: [:0]u8 = try s.toUtf8(this.env, this.arena.allocator());

            return UTF8String{ .data = data };
        }

        if (getArrayElementType(T)) |U| {
            const arr: *ArrayPointer = @ptrCast(val);
            const tmp = try arr.copy(this.env, this.arena.allocator());
            var tmp2: []U = try this.arena.allocator().alloc(U, tmp.len);
            for (0..tmp.len) |i| {
                tmp2[i] = try this.fromJs(U, tmp[i]);
            }

            return T{ .elements = tmp2 };
        }

        if (T == []u8) {
            const arr: *TypedArray = @ptrCast(val);
            const info = try arr.get_info(this.env);
            // TODO: validate type
            const d: [*]u8 = @ptrCast(info.data);

            return d[0..info.len];
        }

        if (T == FastOneByteString) {
            const s: *String = @ptrCast(val);
            const data: [:0]u8 = try s.toUtf8(this.env, this.arena.allocator());

            return FastOneByteString{
                .data = data.ptr,
                .length = @intCast(data.len),
            };
        }

        if (T == FastU32Array) {
            const arr: *TypedArray = @ptrCast(val);
            const info = try arr.get_info(this.env);
            const d: [*]u32 = @alignCast(@ptrCast(info.data));

            return .{
                .data = d,
                .length = info.len,
            };
        }

        return switch (T) {
            *anyopaque => val,
            *Value => val,
            *Receiver => @ptrCast(val),
            *String => @ptrCast(val),
            *Number => @ptrCast(val),
            u32 => {
                const n: *Number = @ptrCast(val);
                return try n.toU32(this.env);
            },
            i32 => {
                const n: *Number = @ptrCast(val);
                return try n.toI32(this.env);
            },
            else => fatal(@src(), "Failed to convert to JS value"),
        };
    }
};

// I should probably expose this apart of the node binary rather than the addon api
extern fn napi_wait_for_promise(env: *Env, value: *Value, result: **Value) Status;

pub fn waitForPromise(value: *Value) !*Value {
    var result: *Value = undefined;
    const status = napi_wait_for_promise(currentEnv, value, &result);
    if (status != .napi_ok) {
        return error.NotOk;
    }
    return result;
}

const Allocator = std.heap.GeneralPurposeAllocator(.{});
var gpa = Allocator{};

const EnvWrap = struct {
    const Envs = std.AutoHashMap(*Env, EnvWrap);
    var envs: ?Envs = null;

    fn initEnvs() !Envs {
        if (envs) |o| {
            return o;
        }

        const m = Envs.init(gpa.allocator());
        envs = m;
        return m;
    }

    pub fn getWrap(env: *Env) !*EnvWrap {
        var _envs = try initEnvs();
        var entry = try _envs.getOrPut(env);
        if (!entry.found_existing) {
            entry.value_ptr.env = env;
            entry.value_ptr.allocator = gpa.allocator();
        }

        return entry.value_ptr;
    }

    env: *Env,
    allocator: std.mem.Allocator,

    pub fn getNull(this: *EnvWrap) !*Value {
        return try this.env.getNull();
    }

    pub fn getUndefined(this: *EnvWrap) !*Value {
        return try this.env.getUndefined();
    }

    pub fn getBool(this: *EnvWrap, val: bool) !*Value {
        return try this.env.getBool(val);
    }

    pub fn initConverter(this: *EnvWrap) ValueConverter {
        return ValueConverter{
            .env = this.env,
            .arena = std.heap.ArenaAllocator.init(this.allocator),
        };
    }

    extern fn napi_throw(env: *Env, err: *Value) Status;

    pub fn throw(this: *EnvWrap, err: *Value) !void {
        const status = napi_throw(this.env, err);
        if (status != .napi_ok) {
            return error.NotOk;
        }
    }
};

const PromiseWrap = struct {
    extern fn napi_create_promise(env: *Env, deferred: **Deferred, promise: **PromiseValue) Status;

    envWrap: *EnvWrap,
    deferred: *Deferred,
    promise: *PromiseValue,

    pub fn init(env: *Env) !PromiseWrap {
        var deferred: *Deferred = undefined;
        var promise: *PromiseValue = undefined;
        const envWrap = try EnvWrap.getWrap(env);
        const status = napi_create_promise(env, &deferred, &promise);
        if (status != .napi_ok) {
            return error.NotOk;
        }

        return .{
            .envWrap = envWrap,
            .deferred = deferred,
            .promise = promise,
        };
    }

    pub fn resolve(this: PromiseWrap, value: ?*Value) !void {
        try this.deferred.resolve(this.envWrap.env, value orelse try this.envWrap.env.getUndefined());
    }

    pub fn reject(this: PromiseWrap, value: ?*Value) !void {
        try this.deferred.reject(this.envWrap.env, value orelse try this.envWrap.env.getUndefined());
    }
};

pub fn Array(comptime T: type) type {
    return struct {
        elements: []T,
    };
}

pub const Receiver = opaque {};

