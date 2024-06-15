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

const Ref = opaque {
    extern fn napi_create_reference(env: *Env, value: *Value, initial_refcount: u32, result: **Ref) Status;

    pub fn init(env: *Env, value: *Value, count: u32) !*Ref {
        var result: *Ref = undefined;
        const status = napi_create_reference(env, value, count, &result);
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
    extern fn napi_create_uint32(env: *Env, value: u32, result: **Number) Status;

    pub fn createU32(env: *Env, val: u32) !*Number {
        var result: *Number = undefined;
        const status = napi_create_uint32(env, val, &result);
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

    const CTypeDef = extern struct {
        ty: CType,
        sequence_type: c_uint = 0,
        flags: c_uint = 0,
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

    extern fn napi_iterate(env: *Env, object: *ArrayPointer, cb: *const IterateCb, data: *anyopaque) Status;

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
        var buf: []*Value = @ptrCast(data);
        buf[index] = element;
        return ._continue;
    }

    pub fn copy(this: *ArrayPointer, env: *Env, allocator: std.mem.Allocator) ![]*Value {
        const len = try this.length(env);
        if (len == 0) {
            return &[_]*Value{};
        }

        var buf = try allocator.alloc(*Value, len);
        for (0..len) |i| {
            buf[i] = try this.get(env, @intCast(i));
        }
        // const status = napi_iterate(env, this, &ArrayPointer.copyTo, buf);
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

const ArrayBuffer = opaque {};

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

fn toCTypeDef(comptime T: type) ?CFunction.CTypeDef {
    return switch (T) {
        void => CFunction.CTypeDef{ .ty = .void },
        u32 => CFunction.CTypeDef{ .ty = .uint32 },
        *Value => CFunction.CTypeDef{ .ty = .v8_value },
        *Receiver => CFunction.CTypeDef{ .ty = .v8_value },
        else => null,
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
    const FnAsyncTypes = getAsyncTypes(ReturnType);

    if (FnAsyncTypes != null) {
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

            const ret = @call(.always_inline, v, args);

            return switch (t.return_type orelse unreachable) {
                *Value => ret,
                u32 => @ptrCast(Number.createU32(env, ret) catch return null),
                else => null,
            };
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

var _task_name: ?*String = null;
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

    fn get_name(env: *Env) !*String {
        if (_task_name) |n| {
            return n;
        }

        const scope = try EscapableHandleScope.open(env);
        var name = try String.fromLatin1External(env, task_name);
        name = @ptrCast(try scope.escape(env, @ptrCast(name)));
        try scope.close(env);
        const ref = try Ref.init(env, @ptrCast(name), 1);
        _ = ref;
        _task_name = name;
        return name;
    }

    pub fn init(env: *Env, exec: Execute, complete: Complete, data: ?*anyopaque) !*AsyncTask {
        var result: *AsyncTask = undefined;
        const name = try String.fromLatin1External(env, task_name);
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
};

inline fn fatal(src: std.builtin.SourceLocation, msg: [:0]const u8) noreturn {
    var buf: [256]u8 = undefined;
    const location = std.fmt.bufPrintZ(&buf, "{s}:{d}:{d}", .{src.file, src.line, src.column}) catch unreachable;
    napi_fatal_error(location.ptr, location.len, msg.ptr, msg.len);
}

fn toValue(comptime T: type, env: *Env, val: T) ?*Value {
    return switch (T) {
        void => null,
        anyerror => {
            // const n = @intFromError(val);
            // return @ptrCast(Number.createU32(env, n) catch unreachable);
            return @ptrCast(env.createError(val, "Native error") catch fatal(@src(), "Failed to create error"));
        },
        u32 => @ptrCast(Number.createU32(env, val) catch fatal(@src(), "Failed to create number")),
        *PromiseValue => @ptrCast(val),
        *Value => val,
        else => fatal(@src(), "Invalid type"),
    };
}

// const TaskQueue = struct {
//     pending: []*AsyncTask = &[_]*AsyncTask{},
//     pendingCount: u32 = 0,
//     didInit: bool = false,

//     pub fn init() TaskQueue {
//         return TaskQueue{};
//     }

//     fn grow(this: *TaskQueue) !void {
//         if (!this.didInit) {
//             this.didInit = true;
//             const buf = try std.heap.c_allocator.alloc(*AsyncTask, 4);
//             this.pending = buf;
//             return;
//         }

//         const buf = try std.heap.c_allocator.alloc(*AsyncTask, this.pending.len * 2);
//         @memcpy(buf, this.pending[0..this.pendingCount]);
//         std.heap.c_allocator.free(this.pending);
//         this.pending = buf;
//     }

//     pub fn push(this: *TaskQueue, item: *AsyncTask) !void {
//         if (this.pendingCount + 1 >= this.pending.len) {
//             try this.grow();
//         }
//         this.pending[this.pendingCount] = item;
//         this.pendingCount += 1;
//     }

//     pub fn pop(this: *TaskQueue) ?*AsyncTask {
//         if (this.pendingCount == 0) {
//             return null;
//         }

//         const val = this.pending[this.pendingCount - 1];
//         this.pendingCount -= 1;

//         return val;
//     }
// };

// var tasks = TaskQueue.init();
// var runningCount: u32 = 0;

fn runAsyncFn(comptime func: anytype, env: *Env, info: *CallFrame) !*PromiseValue {
    const Func = AsyncFn(func);
    const frame = try Func.init(env, info);
    const task = try AsyncTask.init(env, &Func.run, &Func.complete, frame);
    frame.task = task;
    // if (runningCount >= 8) {
    //     try tasks.push(task);
    //     return frame.wrap.promise;
    // }

    try task.start(env);
    // runningCount += 1;

    return frame.wrap.promise;
}

fn getFnType(comptime val: anytype) Type.Fn {
    return switch (@typeInfo(@TypeOf(val))) {
        .Fn => |f| f,
        else => unreachable,
    };
}

/// Functions that return a Promise will appear asychronous to
/// JavaScript callers by running the function in a separate thread.
pub fn Promise(comptime T: type, comptime E: type) type {
    return union(enum) {
        resolved: T,
        rejected: E,

        pub fn resolve(val: T) @This() {
            return .{ .resolved = val };
        }

        pub fn reject(err: E) @This() {
            return .{ .rejected = err };
        }
    };
}

const AsyncTypes = struct {
    resolved: type,
    rejected: type,
};

fn getAsyncTypes(comptime t: type) ?AsyncTypes {
    const info = @typeInfo(t);
    const u = switch (info) {
        .Union => |s| s,
        else => return null,
    };

    if (!@hasField(t, "resolved") and !@hasField(t, "rejected")) return null;

    return .{
        .resolved = u.fields[0].type,
        .rejected = u.fields[1].type,
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

// Current overhead (on my machine): ~2500ns (possibly ~1900ns)
fn AsyncFn(comptime func: anytype) type {
    const funcType = getFnType(func);
    const Args = MakeTuple(funcType);
    const ReturnType = funcType.return_type orelse unreachable;
    const Frame = struct {
        args: Args,
        ret: ReturnType,
        wrap: PromiseWrap,
        task: *AsyncTask, // Assigned by the caller
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

            return this;
        }

        pub fn run(_: *Env, data: ?*anyopaque) void {
            var this: *@This() = @alignCast(@ptrCast(data orelse unreachable));
            this.ret = @call(.auto, func, this.args);
        }

        pub fn complete(env: *Env, _: Status, data: ?*anyopaque) void {
            const this: *@This() = @alignCast(@ptrCast(data orelse unreachable));
            defer {
                // runningCount -= 1;
                // if (runningCount < 8) {
                //     if (tasks.pop()) |t| {
                //         t.start(env) catch {};
                //         runningCount += 1;
                //     }
                // }

                this.task.deinit(env) catch {};
                var conv = this.converter;
                conv.deinit();
            }

            const promiseTypes = getAsyncTypes(ReturnType);
            if (promiseTypes) |x| {
                switch (this.ret) {
                    .resolved => |r| this.wrap.resolve(toValue(x.resolved, env, r)) catch {},
                    .rejected => |e| this.wrap.reject(toValue(x.rejected, env, e)) catch {},
                }
            } else {
                this.wrap.resolve(toValue(ReturnType, env, this.ret)) catch {};
            }
        }
    };

    return Frame;
}

pub const UTF8String = struct { data: [:0]u8 };

const FunctionWrap = struct {
    env: *Env,
};

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
            for (tmp, 0..tmp.len) |x, i| {
                tmp2[i] = try this.fromJs(U, x);
            }

            return T{ .elements = tmp2 };
        }

        return switch (T) {
            *Value => val,
            *Receiver => @ptrCast(val),
            *String => @ptrCast(val),
            *Number => @ptrCast(val),
            u32 => {
                const n: *Number = @ptrCast(val);
                return try n.toU32(this.env);
            },
            else => unreachable,
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

    _null: ?*Value = null,
    _true: ?*Value = null,
    _false: ?*Value = null,
    _undefined: ?*Value = null,

    pub fn getNull(this: *EnvWrap) !*Value {
        if (this._null) |v| {
            return v;
        }

        const result = try this.env.getNull();
        this._null = result;
        return result;
    }

    pub fn getUndefined(this: *EnvWrap) !*Value {
        if (this._undefined) |v| {
            return v;
        }

        const result = try this.env.getUndefined();
        this._undefined = result;
        return result;
    }

    pub fn getTrue(this: *EnvWrap) !*Value {
        if (this._true) |v| {
            return v;
        }

        const result = try this.env.getBool(true);
        this._true = result;
        return result;
    }

    pub fn getFalse(this: *EnvWrap) !*Value {
        if (this._false) |v| {
            return v;
        }

        const result = try this.env.getBool(false);
        this._false = result;
        return result;
    }

    pub fn initConverter(this: *EnvWrap) ValueConverter {
        return ValueConverter{
            .env = this.env,
            .arena = std.heap.ArenaAllocator.init(this.allocator),
        };
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

const Receiver = opaque {};

const TestModule = struct {
    // pub fn addSync(this: *Receiver, a: u32, b: u32) u32 {
    //     // std.debug.print("{}", .{this});
    //     _ = this;
    //     return a + b;
    // }

    // pub fn add(a: u32, b: u32) Promise(u32, void) {
    //     return Promise(u32, void).resolve(a + b);
    // }

    pub fn add2(a: u32, b: Array(u32)) Promise(void, void) {
        std.debug.print("{}, {}", .{ a, b });
        return Promise(void, void).resolve({});
    }
};

// comptime {
//     registerModule(TestModule);
// }

// --allow-natives-syntax
// %CompileOptimized
// %PrepareFunctionForOptimization
// %OptimizeFunctionOnNextCall
// const status = %GetOptimizationStatus(doAdd)
// console.log('maybe deopt', (status >> 3) & 1)
// console.log('optimized', (status >> 4) & 1)
// console.log('magleved', (status >> 5) & 1)
// console.log('turbofanned', (status >> 6) & 1)