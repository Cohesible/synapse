const std = @import("std");
const zig = std.zig;
const mem = @import("./lib/mem.zig");

pub const Tag = enum {
    ident,
    block,
    container,
    fndecl,
    vardecl,
    field_decl,
    ptr_type,
    optional_type,
    literal,
    field_access,
    error_union,
    call_exp,
    comptime_block,
    test_decl,
    parse_error_node,
};

pub const Node = union(Tag) {
    ident: Identifier,
    block: BlockNode,
    container: ContainerDecl,
    fndecl: FnDecl,
    vardecl: VarDecl,
    field_decl: FieldDecl,
    ptr_type: PtrType,
    optional_type: OptionalType,
    literal: Literal,
    field_access: FieldAccess,
    error_union: ErrorUnion,
    call_exp: CallExp,
    comptime_block: ComptimeBlock,
    test_decl: TestDeclNode,
    parse_error_node: ParseErrorNode,
};

pub const LiteralSubtype = enum {
    number,
    string,
};

pub const Literal = struct { subtype: LiteralSubtype, value: []const u8 };

pub const Identifier = struct {
    name: []const u8,
};

pub const FieldAccess = struct { exp: *Node, member: []const u8 };
pub const ErrorUnion = struct {
    lhs: ?*Node,
    rhs: *Node,
};

pub const CallExp = struct {
    exp: *Node,
    args: []*Node,
};

pub const OptionalType = struct {
    child_type: *Node,
};

pub const PtrType = struct {
    size: std.builtin.Type.Pointer.Size,
    sentinel: ?*Node,
    is_const: bool,
    //     allowzero_token: ?TokenIndex,
    //     const_token: ?TokenIndex,
    //     volatile_token: ?TokenIndex,
    //         main_token: TokenIndex, `*` or `**` or `[`
    //         align_node: Node.Index,
    //         addrspace_node: Node.Index,
    // TODO bit_range
    child_type: *Node,
};

pub const ContainerDecl = struct {
    docs: ?[]const u8,
    subtype: []const u8,
    layout_token: ?[]const u8,
    enum_token: ?[]const u8,
    members: []*Node,
    arg: ?*Node,
};

pub const ParamDecl = struct {
    name: ?[]const u8,
    is_comptime: bool,
    is_variadic: bool,
    is_noalias: bool,
    type_expr: ?*Node,
};

pub const FnDecl = struct {
    name: ?[]const u8,
    visibility: ?[]const u8,
    qualifier: ?[]const u8, // inline, export, extern
    lib_name: ?[]const u8,
    return_type: ?*Node,
    params: []ParamDecl,
    body: ?*Node,
};

pub const VarDecl = struct {
    name: []const u8,
    mutability: []const u8,
    visibility: ?[]const u8,
    qualifier: ?[]const u8, // inline, export, extern
    lib_name: ?[]const u8,
    thread_local: bool,
    is_comptime: bool,
    initializer: ?*Node,
    //     align_node: Node.Index,
    //     addrspace_node: Node.Index,
    //     section_node: Node.Index,
    type_expr: ?*Node,
};

pub const FieldDecl = struct {
    name: []const u8,
    is_comptime: bool,
    tuple_like: bool,
    initializer: ?*Node,
    align_expr: ?*Node,
    type_expr: ?*Node, // Always needs to exist??
};

pub const BlockNode = struct {
    lhs: ?*Node,
    rhs: ?*Node,
};

pub const ComptimeBlock = struct {
    block: ?*Node,
};

pub const ParseErrorNode = struct {
    tag: zig.Ast.Node.Tag,
};

pub const TestDeclNode = struct {
    name: ?*Node, // string literal or identifier
    body: *Node, // block
};

const NodeConverter = struct {
    gpa: std.mem.Allocator,
    tree: zig.Ast,

    pub fn convert(gpa: std.mem.Allocator, tree: zig.Ast) !?*Node {
        const converter = @This(){
            .gpa = gpa,
            .tree = tree,
        };

        const x = tree.containerDeclRoot();
        const p = try gpa.create(Node);

        p.* = Node{ .container = ContainerDecl{
            .subtype = "root",
            .layout_token = null,
            .enum_token = null,
            .arg = null,
            .members = try converter.convert_array(x.ast.members),
            .docs = try converter.maybe_get_docs(0, true),
        } };

        return p;
    }

    const ConversionError = error{
        NullMember,
    };

    const Error = ConversionError || std.mem.Allocator.Error || error{NoSpaceLeft};

    fn convert_array(self: @This(), arr: []const u32) Error![]*Node {
        const new_arr = try self.gpa.alloc(*Node, arr.len);
        for (0..new_arr.len) |i| {
            const el = try self.convert_node(arr[i]) orelse return Error.NullMember;
            new_arr[i] = el;
        }
        return new_arr;
    }

    fn convert_node_strict(self: @This(), index: u32) Error!*Node {
        return try self.convert_node(index) orelse {
            if (index == 0) return Error.NullMember;

            var buf: [256]u8 = undefined;
            const n: zig.Ast.Node = self.tree.nodes.get(index);
            const msg = try std.fmt.bufPrint(&buf, "Failed to parse node with tag: {s}", .{@tagName(n.tag)});
            @panic(msg);
        };
    }

    fn maybe_get_docs(self: @This(), token_index: u32, is_root: bool) !?[]const u8 {
        const tags = self.tree.tokens.items(.tag);
        var j: u32 = token_index;
        if (is_root) j += 1 else j -= 1;
        while (j > 0 and j < self.tree.tokens.len) {
            switch (tags[j]) {
                .doc_comment, .container_doc_comment => {
                    if (is_root) j += 1 else j -= 1;
                },
                else => break,
            }
        }

        if (j == token_index) return null;

        const range: [2]u32 = if (is_root) .{ token_index, j } else .{ j, token_index };
        const lineCount = range[1] - range[0];

        const lines = try self.gpa.alloc([]const u8, lineCount);
        var size: usize = 0;
        for (0..lineCount) |i| {
            const l = self.tree.tokenSlice(@intCast(i + range[0]));
            // lines[i] = l[3..];
            lines[i] = l;
            size += lines[i].len + 1;
        }

        var buf = try self.gpa.alloc(u8, size);
        var pos: usize = 0;

        for (0..lineCount) |i| {
            @memcpy(buf.ptr + pos, lines[i]);
            pos += lines[i].len;
            buf[pos] = '\n';
            pos += 1;
        }

        return buf;
    }

    fn create_parse_error(self: @This(), tag: zig.Ast.Node.Tag) !*Node {
        const p = try self.gpa.create(Node);
        p.* = Node{ .parse_error_node = ParseErrorNode{
            .tag = tag,
        } };
        return p;
    }

    fn convert_node(self: @This(), index: u32) !?*Node {
        if (index == 0) {
            return null;
        }

        const n: zig.Ast.Node = self.tree.nodes.get(index);
        switch (n.tag) {
            .identifier => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .ident = Identifier{
                    .name = self.tree.tokenSlice(n.main_token),
                } };

                return p;
            },
            .root, .container_decl_trailing, .container_decl_arg, .container_decl_arg_trailing, .container_decl_two, .container_decl_two_trailing, .tagged_union, .tagged_union_trailing, .tagged_union_enum_tag, .tagged_union_enum_tag_trailing, .tagged_union_two, .tagged_union_two_trailing, .container_decl => {
                var b: [2]zig.Ast.Node.Index = undefined;
                const x = self.tree.fullContainerDecl(&b, index) orelse return null;

                const members = try self.convert_array(x.ast.members);

                const p = try self.gpa.create(Node);
                p.* = Node{ .container = ContainerDecl{
                    .subtype = self.tree.tokenSlice(x.ast.main_token),
                    .layout_token = if (x.layout_token) |t| self.tree.tokenSlice(t) else null,
                    .enum_token = if (x.ast.enum_token) |t| self.tree.tokenSlice(t) else null,
                    .arg = try self.convert_node(x.ast.arg),
                    .members = members,
                    .docs = null,
                } };

                return p;
            },
            .global_var_decl, .local_var_decl, .aligned_var_decl, .simple_var_decl => {
                const varDecl = self.tree.fullVarDecl(index) orelse return null;
                const p = try self.gpa.create(Node);
                p.* = Node{ .vardecl = VarDecl{
                    .name = self.tree.tokenSlice(varDecl.ast.mut_token + 1),
                    .mutability = self.tree.tokenSlice(varDecl.ast.mut_token),
                    .visibility = if (varDecl.visib_token) |t| self.tree.tokenSlice(t) else null,
                    .initializer = try self.convert_node(varDecl.ast.init_node),
                    .qualifier = null,
                    .thread_local = false,
                    .type_expr = null,
                    .is_comptime = false,
                    .lib_name = null,
                } };

                return p;
            },
            .container_field_init, .container_field_align, .container_field => {
                const x = self.tree.fullContainerField(index) orelse return null;
                const p = try self.gpa.create(Node);
                p.* = Node{
                    .field_decl = FieldDecl{
                        .name = self.tree.tokenSlice(x.ast.main_token),
                        .initializer = try self.convert_node(x.ast.value_expr),
                        .type_expr = try self.convert_node(x.ast.type_expr),
                        .is_comptime = x.comptime_token != null,
                        .align_expr = null, // TODO
                        .tuple_like = x.ast.tuple_like,
                    },
                };

                return p;
            },
            .fn_proto, .fn_proto_multi, .fn_proto_one, .fn_proto_simple, .fn_decl => {
                var b: [1]zig.Ast.Node.Index = undefined;
                const x = self.tree.fullFnProto(&b, index) orelse return null;
                const p = try self.gpa.create(Node);

                // `anytype` params aren't included in `ast.params.len`
                var params = try std.ArrayList(ParamDecl).initCapacity(self.gpa, x.ast.params.len);
                var iter = x.iterate(&self.tree);
                while (iter.next()) |param| {
                    try params.append(.{
                        .name = if (param.name_token) |t| self.tree.tokenSlice(t) else null,
                        .type_expr = try self.convert_node(param.type_expr),
                        .is_comptime = false, // TODO
                        .is_noalias = false, // TODO
                        .is_variadic = param.anytype_ellipsis3 != null,
                    });
                }

                p.* = Node{
                    .fndecl = FnDecl{
                        .name = if (x.name_token) |t| self.tree.tokenSlice(t) else null,
                        .lib_name = null,
                        .body = if (n.tag == .fn_decl and n.data.rhs != 0) try self.convert_node(n.data.rhs) else null,
                        .visibility = if (x.visib_token) |t| self.tree.tokenSlice(t) else null,
                        .qualifier = if (x.extern_export_inline_token) |t| self.tree.tokenSlice(t) else null,
                        .return_type = try self.convert_node(x.ast.return_type),
                        .params = params.items,
                    },
                };

                return p;
            },
            .ptr_type_aligned, .ptr_type_sentinel, .ptr_type, .ptr_type_bit_range => {
                const x = self.tree.fullPtrType(index) orelse return null;
                const p = try self.gpa.create(Node);
                p.* = Node{ .ptr_type = PtrType{
                    .size = x.size,
                    .sentinel = try self.convert_node(x.ast.sentinel),
                    .is_const = x.const_token != null,
                    .child_type = try self.convert_node_strict(x.ast.child_type),
                } };
                return p;
            },
            .optional_type => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .optional_type = OptionalType{
                    .child_type = try self.convert_node_strict(n.data.lhs),
                } };
                return p;
            },
            .number_literal => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .literal = Literal{
                    .subtype = .number,
                    .value = self.tree.tokenSlice(n.main_token),
                } };
                return p;
            },
            .string_literal => {
                const p = try self.gpa.create(Node);
                const token = self.tree.tokenSlice(n.main_token);
                p.* = Node{ .literal = Literal{
                    .subtype = .string,
                    .value = token[1..token.len-1], // assumes single/double quotes
                } };
                return p;
            },
            .field_access => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .field_access = FieldAccess{
                    .exp = try self.convert_node_strict(n.data.lhs),
                    .member = self.tree.tokenSlice(n.data.rhs),
                } };
                return p;
            },
            .error_union => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .error_union = ErrorUnion{
                    .lhs = try self.convert_node(n.data.lhs),
                    .rhs = try self.convert_node_strict(n.data.rhs),
                } };
                return p;
            },
            .builtin_call_two, .builtin_call_two_comma => {
                const ident = try self.gpa.create(Node);
                ident.* = Node{ .ident = Identifier{
                    .name = self.tree.tokenSlice(n.main_token),
                } };

                const args = if (n.data.lhs != 0) try self.convert_array(&[_]u32{ n.data.lhs }) else try self.convert_array(&[_]u32{});
                const p = try self.gpa.create(Node);
                p.* = Node{
                    .call_exp = CallExp{
                        .exp = ident,
                        .args = args,
                    },
                };
                return p;
            },
            .call, .call_one, .call_comma, .call_one_comma => {
                var buf: [1]zig.Ast.Node.Index = undefined;
                const fullCall = self.tree.fullCall(&buf, index) orelse return null;
                const args = try self.convert_array(fullCall.ast.params);

                const p = try self.gpa.create(Node);
                p.* = Node{
                    .call_exp = CallExp{
                        .exp = try self.convert_node_strict(fullCall.ast.fn_expr),
                        .args = args,
                    },
                };
                return p;
            },
            .block, .block_semicolon => {
                // Statements are in tree.extra_data
                return null;
             },
            .block_two, .block_two_semicolon => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .block = BlockNode{
                    .lhs = try self.convert_node(n.data.lhs),
                    .rhs = try self.convert_node(n.data.rhs),
                } };
                return p;
            },
            .test_decl => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .test_decl = TestDeclNode{
                    .name = try self.convert_node(n.data.lhs),
                    .body = try self.convert_node_strict(n.data.rhs),
                } };
                return p;
            },
            .@"comptime" => {
                const p = try self.gpa.create(Node);
                p.* = Node{ .comptime_block = ComptimeBlock{
                    .block = try self.convert_node(n.data.lhs),
                } };
                return p;
            },
            else => {
                return try self.create_parse_error(n.tag);
            },
        }

        return null;
    }
};

const WasmStreamWriter = struct {
    gpa: std.mem.Allocator,
    buf: []u8,
    pos: usize,

    pub const Error = std.mem.Allocator.Error;

    pub fn init(gpa: std.mem.Allocator, size: usize) !@This() {
        const buf = try gpa.alloc(u8, size);

        return @This(){
            .gpa = gpa,
            .buf = buf,
            .pos = 0,
        };
    }

    fn resize(this: *@This(), new_size: usize) ![]u8 {
        const new_buf = try this.gpa.realloc(this.buf, new_size);
        this.buf = new_buf;
        return new_buf;
    }

    fn writeFn(this: *@This(), bytes: []const u8) !usize {
        var buf = this.buf;
        const rem = buf.len - this.pos;
        if (bytes.len > rem) {
            const new_size = buf.len + bytes.len;
            buf = try this.resize(new_size);
        }

        @memcpy(this.buf[this.pos .. this.pos + bytes.len], bytes);
        this.pos += bytes.len;

        return bytes.len;
    }

    pub const Writer = std.io.Writer(*@This(), Error, writeFn);

    pub fn toWriter(this: *@This()) Writer {
        return Writer{ .context = this };
    }

    pub fn toString(this: *@This()) ![:0]const u8 {
        const size: usize = this.pos;
        var buf = if (this.pos == this.buf.len) try this.resize(size + 1) else this.buf;
        buf[size] = 0;

        return buf[0..size :0];
    }
};

fn parse_ast(source: [:0]const u8) ![:0]const u8 {
    const gpa = mem.allocator;
    const tree = try zig.Ast.parse(gpa, source, .zig);
    const root = try NodeConverter.convert(gpa, tree);

    var writer = try WasmStreamWriter.init(gpa, 1024);

    try std.json.stringify(root, .{ .emit_null_optional_fields = false }, writer.toWriter());

    return try writer.toString();
}

export fn parse(source: [*:0]const u8) [*:0]const u8 {
    const len = mem.strlen(source);
    return parse_ast(source[0..len :0]) catch @panic("Failed to parse");
}

export fn alloc(size: usize) [*]u8 {
    const b = mem.allocator.alloc(u8, size) catch @panic("Failed to allocate");

    return b.ptr;
}

// const js = @import("js");

// pub fn parse(source: js.UTF8String) js.UTF8String {
//     const data = parse_ast(source.data) catch |e| {
//         std.debug.print("parse error {?}\n", .{e});

//         return .{ .data = @constCast("{}") };
//     };
//     return .{ .data = @constCast(data) };
// }

// comptime {
//     js.registerModule(@This());
// }
