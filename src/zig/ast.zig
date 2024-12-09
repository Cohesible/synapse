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
    comptime_node,
    test_decl,
    catch_node,
    unary_node,
    return_node,
    switch_case,
    unparsed_node,
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
    comptime_node: ComptimeNode,
    test_decl: TestDeclNode,
    catch_node: CatchNode,
    unary_node: UnaryNode,
    return_node: ReturnNode,
    switch_case: SwitchCase,
    unparsed_node: UnparsedNode,
};

pub const LiteralSubtype = enum {
    number,
    string,
    // @"enum",
    // @"error",
    // @"unreachable",
};

pub const Literal = struct {
    subtype: LiteralSubtype, 
    value: []const u8,
};

pub const Identifier = struct {
    name: []const u8,
};

pub const FieldAccess = struct { 
    exp: *Node, 
    member: []const u8 
};

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
    statements: []*Node,
};

pub const ComptimeNode = struct {
    node: ?*Node,
};

pub const UnparsedNode = struct {
    index: u32,
    tag: zig.Ast.Node.Tag,
};

pub const TestDeclNode = struct {
    name: ?*Node, // string literal or identifier
    body: *Node, // block
};

pub const CatchNode = struct {
    lhs: *Node,
    rhs: *Node,
    payload: ?*Node, // payload is next token after main_token if not rhs
};

pub const UnaryNode = struct {
    op: []const u8,
    exp: *Node,
    payload: ?*Node,
};

pub const ReturnNode = struct {
    expression: ?*Node,
};

pub const SwitchCase = struct {
    is_inline: bool,
    payload: ?*Node,
    values: []*Node,
    exp: *Node,
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

        p.* = .{ .container = .{
            .subtype = "root",
            .layout_token = null,
            .enum_token = null,
            .arg = null,
            .members = try converter.convertArray(x.ast.members),
            .docs = try converter.maybeGetDocs(0, true),
        } };

        return p;
    }

    fn convertArray(self: @This(), arr: []const u32) anyerror![]*Node {
        const new_arr = try self.gpa.alloc(*Node, arr.len);
        for (0..new_arr.len) |i| {
            const el = try self.convertNode(arr[i]) orelse return error.NullMember;
            new_arr[i] = el;
        }
        return new_arr;
    }

    fn convertNodeStrict(self: @This(), index: u32) anyerror!*Node {
        return try self.convertNode(index) orelse {
            if (index == 0) return error.NullMember;

            var buf: [256]u8 = undefined;
            const n: zig.Ast.Node = self.tree.nodes.get(index);
            const msg = try std.fmt.bufPrint(&buf, "Failed to parse node with tag: {s}", .{@tagName(n.tag)});
            @panic(msg);
        };
    }

    fn maybeGetDocs(self: @This(), token_index: u32, is_root: bool) !?[]const u8 {
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

    fn convertContainer(self: @This(), index: u32) !ContainerDecl {
        var b: [2]zig.Ast.Node.Index = undefined;
        const decl = self.tree.fullContainerDecl(&b, index) orelse return error.NotAContainer;

        const members = try self.convertArray(decl.ast.members);

        return .{
            .subtype = self.tree.tokenSlice(decl.ast.main_token),
            .layout_token = if (decl.layout_token) |t| self.tree.tokenSlice(t) else null,
            .enum_token = if (decl.ast.enum_token) |t| self.tree.tokenSlice(t) else null,
            .arg = try self.convertNode(decl.ast.arg),
            .members = members,
            .docs = null,
        };
    }

    fn convertVarDecl(self: @This(), index: u32) !VarDecl {
        const varDecl = self.tree.fullVarDecl(index) orelse return error.NotAVarDecl;

        return .{
            .name = self.tree.tokenSlice(varDecl.ast.mut_token + 1),
            .mutability = self.tree.tokenSlice(varDecl.ast.mut_token),
            .visibility = if (varDecl.visib_token) |t| self.tree.tokenSlice(t) else null,
            .initializer = try self.convertNode(varDecl.ast.init_node),
            .qualifier = null,
            .thread_local = false,
            .type_expr = null,
            .is_comptime = false,
            .lib_name = null,
        };
    }

    fn convertFieldDecl(self: @This(), index: u32) !FieldDecl {
        const field = self.tree.fullContainerField(index) orelse return error.NotAFieldDecl;

        return .{
            .name = self.tree.tokenSlice(field.ast.main_token),
            .initializer = try self.convertNode(field.ast.value_expr),
            .type_expr = try self.convertNode(field.ast.type_expr),
            .is_comptime = field.comptime_token != null,
            .align_expr = null, // TODO
            .tuple_like = field.ast.tuple_like,
        };
    }

    fn convertFnDecl(self: @This(), index: u32) !FnDecl {
        var b: [1]zig.Ast.Node.Index = undefined;
        const proto = self.tree.fullFnProto(&b, index) orelse return error.NotAFnDecl;

        // `anytype` params aren't included in `ast.params.len`
        var params = try std.ArrayList(ParamDecl).initCapacity(self.gpa, proto.ast.params.len);
        var iter = proto.iterate(&self.tree);
        while (iter.next()) |param| {
            try params.append(.{
                .name = if (param.name_token) |t| self.tree.tokenSlice(t) else null,
                .type_expr = try self.convertNode(param.type_expr),
                .is_comptime = false, // TODO
                .is_noalias = false, // TODO
                .is_variadic = param.anytype_ellipsis3 != null,
            });
        }

        const n: zig.Ast.Node = self.tree.nodes.get(index);

        return .{
            .name = if (proto.name_token) |t| self.tree.tokenSlice(t) else null,
            .lib_name = null,
            .body = if (n.tag == .fn_decl and n.data.rhs != 0) try self.convertNode(n.data.rhs) else null,
            .visibility = if (proto.visib_token) |t| self.tree.tokenSlice(t) else null,
            .qualifier = if (proto.extern_export_inline_token) |t| self.tree.tokenSlice(t) else null,
            .return_type = try self.convertNode(proto.ast.return_type),
            .params = params.items,
        };
    }

    fn convertPtrType(self: @This(), index: u32) !PtrType {
        const x = self.tree.fullPtrType(index) orelse return error.NotAPtrType;

        return .{
            .size = x.size,
            .sentinel = try self.convertNode(x.ast.sentinel),
            .is_const = x.const_token != null,
            .child_type = try self.convertNodeStrict(x.ast.child_type),
        };
    }

    fn convertBlock(self: @This(), index: u32) !BlockNode {
        const n: zig.Ast.Node = self.tree.nodes.get(index);

        switch (n.tag) {
            .block, .block_semicolon => {
                const statements = self.tree.extra_data[n.data.lhs..n.data.rhs];

                return .{
                    .statements = try self.convertArray(statements),
                };
             },
            .block_two, .block_two_semicolon => {
                var statements_buf: [2]zig.Ast.Node.Index = undefined;
                const statements = b: {
                    statements_buf = .{ n.data.lhs, n.data.rhs };
                    if (statements_buf[0] == 0) {
                        break :b statements_buf[0..0];
                    } else if (statements_buf[1] == 0) {
                        break :b statements_buf[0..1];
                    } else {
                        break :b statements_buf[0..2];
                    }
                };
                
                return .{
                    .statements = try self.convertArray(statements),
                };
            },
            else => return error.NotABlock,
        }
    }

    fn convertCallExp(self: @This(), index: u32) !CallExp {
        const n: zig.Ast.Node = self.tree.nodes.get(index);

        switch (n.tag) {
            .builtin_call_two, .builtin_call_two_comma => {
                const ident = try self.gpa.create(Node);
                ident.* = Node{ .ident = Identifier{
                    .name = self.tree.tokenSlice(n.main_token),
                } };

                const args = if (n.data.lhs != 0) 
                    try self.convertArray(&[_]u32{ n.data.lhs }) 
                else 
                    try self.convertArray(&[_]u32{});

                return .{
                    .exp = ident,
                    .args = args,
                };
            },
            .call, .call_one, .call_comma, .call_one_comma => {
                var buf: [1]zig.Ast.Node.Index = undefined;
                const fullCall = self.tree.fullCall(&buf, index) orelse return error.NotACallExp;
                const args = try self.convertArray(fullCall.ast.params);

                return .{
                    .exp = try self.convertNodeStrict(fullCall.ast.fn_expr),
                    .args = args,
                };
            },
            else => return error.NotACallExp,
        }
    }

    fn convertLiteral(self: @This(), index: u32) !Literal {
        const n: zig.Ast.Node = self.tree.nodes.get(index);

        switch (n.tag) {
            .number_literal => {
                return .{
                    .subtype = .number,
                    .value = self.tree.tokenSlice(n.main_token),
                };
            },
            .string_literal => {
                const token = self.tree.tokenSlice(n.main_token);

                return .{
                    .subtype = .string,
                    .value = token[1..token.len-1], // assumes single/double quotes
                };
            },
        //    .enum_literal => {
        //         return .{
        //             .subtype = .@"enum",
        //             .value = self.tree.tokenSlice(n.main_token),
        //         };
        //     },
        //     .error_value => {
        //         return .{
        //             .subtype = .@"error",
        //             .value = self.tree.tokenSlice(n.main_token),
        //         };
        //     },
        //     .unreachable_literal => {
        //         return .{
        //             .subtype = .@"unreachable",
        //             .value = self.tree.tokenSlice(n.main_token),
        //         };
        //     },
            else => return error.NotALiteral,
        }
    }

    fn convertSwitchCase(self: @This(), index: u32) !SwitchCase {
        const switchCase = self.tree.fullSwitchCase(index) orelse return error.NotASwitchCase;

        return .{
            .values = try self.convertArray(switchCase.ast.values),
            .exp = try self.convertNodeStrict(switchCase.ast.target_expr),
            .is_inline = switchCase.inline_token != null,
            .payload = if (switchCase.payload_token) |t| try self.convertNode(t) else null,
        };
    }

    fn convertNode(self: @This(), index: u32) anyerror!?*Node {
        if (index == 0) {
            return null;
        }

        const n: zig.Ast.Node = self.tree.nodes.get(index);
        const p = try self.gpa.create(Node);
        p.* = switch (n.tag) {
            .identifier => .{ .ident = .{
                .name = self.tree.tokenSlice(n.main_token),
            } },
            .root, .container_decl_trailing, .container_decl_arg, 
            .container_decl_arg_trailing, .container_decl_two, .container_decl_two_trailing,
            .tagged_union, .tagged_union_trailing, .tagged_union_enum_tag, 
            .tagged_union_enum_tag_trailing, .tagged_union_two, .tagged_union_two_trailing, 
            .container_decl => .{ 
                .container = try self.convertContainer(index) 
            },
            .global_var_decl, .local_var_decl, .aligned_var_decl, .simple_var_decl => .{ 
                .vardecl = try self.convertVarDecl(index) 
            },
            .container_field_init, .container_field_align, .container_field => .{
                .field_decl = try self.convertFieldDecl(index),
            },
            .fn_proto, .fn_proto_multi, .fn_proto_one, .fn_proto_simple, .fn_decl => .{ 
                .fndecl = try self.convertFnDecl(index) 
            },
            .ptr_type_aligned, .ptr_type_sentinel, .ptr_type, .ptr_type_bit_range => .{ 
                .ptr_type = try self.convertPtrType(index) 
            },
            .optional_type => .{ .optional_type = .{
                .child_type = try self.convertNodeStrict(n.data.lhs),
            } },
            // .number_literal, .string_literal, .enum_literal, .error_value, .unreachable_literal => .{ 
            .number_literal, .string_literal => .{ 
                .literal = try self.convertLiteral(index) 
            },
            .field_access => .{ .field_access = .{
                .exp = try self.convertNodeStrict(n.data.lhs),
                .member = self.tree.tokenSlice(n.data.rhs),
            } },
            .error_union => .{ .error_union = .{
                .lhs = try self.convertNode(n.data.lhs),
                .rhs = try self.convertNodeStrict(n.data.rhs),
            } },
            .builtin_call_two, .builtin_call_two_comma, .call, .call_one, .call_comma, .call_one_comma => .{
                .call_exp = try self.convertCallExp(index),
            },
            .block, .block_semicolon, .block_two, .block_two_semicolon => .{ 
                .block = try self.convertBlock(index) 
            },
            .test_decl => .{ .test_decl = .{
                .name = try self.convertNode(n.data.lhs),
                .body = try self.convertNodeStrict(n.data.rhs),
            } },
            .@"comptime" => .{ .comptime_node = .{
                .node = try self.convertNode(n.data.lhs),
            } },
            // .switch_case_one, .switch_case_inline_one,
            // .switch_case, .switch_case_inline => .{
            //     .switch_case = try self.convertSwitchCase(index),
            // },

            // .negation_wrap, .bit_not, .negation, 
            // .bool_not, .address_of, .@"try" => .{ .unary_node = .{
            //     .op = self.tree.tokenSlice(n.main_token),
            //     .exp = try self.convertNode(n.data.lhs),
            // } },

            // .@"defer", .@"errdefer" => .{ .unary_node = .{
            //     .op = self.tree.tokenSlice(n.main_token),
            //     .exp = try self.convertNode(n.data.rhs),
            //     .payload = try self.convertNode(n.data.lhs),
            // } },

            // .error_set_decl => {

            // },
            // .merge_error_sets => {

            // },
            // .@"catch" => {

            // },
            // .@"return" => {

            // },
            else => .{ 
                .unparsed_node = .{ 
                    .index = index, 
                    .tag = n.tag,
                } 
            },
        };

        return p;
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

pub const Ast = struct {
    tokens: []RawToken,
    nodes: []RawNode,
    extra_data: []u32,
};

pub const RawToken = struct {
    tag: zig.Token.Tag,
    text: []const u8,
};

pub const NodeData = struct {
    lhs: u32,
    rhs: u32,
};

pub const RawNode = struct {
    tag: zig.Ast.Node.Tag,
    main_token: u32,
    data: NodeData,
};

fn parse_ast_raw(source: [:0]const u8) ![:0]const u8 {
    const gpa = mem.allocator;
    const tree = try zig.Ast.parse(gpa, source, .zig);

    var tokens = try gpa.alloc(RawToken, tree.tokens.len);

    for (0..tokens.len) |i| {
        const text = tree.tokenSlice(i);
        tokens[i] = .{
            .tag = tree.tokens.get(i).tag,
            .text = text,
        };
    }

    var nodes = try gpa.alloc(RawNode, tree.nodes.len);

    for (0..nodes.len) |i| {
        const n = tree.nodes.get(i);
        // These are copied to make type generation easier
        nodes[i] = .{
            .tag = n.tag,
            .main_token = n.main_token,
            .data = .{
                .lhs = n.data.lhs,
                .rhs = n.data.rhs,
            },
        };
    }

    var writer = try WasmStreamWriter.init(gpa, 1024);

    const ast: Ast = .{
        .tokens = tokens,
        .nodes = nodes,
        .extra_data = tree.extra_data,
    };
    try std.json.stringify(ast, .{ .emit_null_optional_fields = false }, writer.toWriter());

    return try writer.toString();
}

export fn parse(source: [*:0]const u8) [*:0]const u8 {
    const len = mem.strlen(source);
    return parse_ast(source[0..len :0]) catch @panic("Failed to parse");
}

export fn parse_raw(source: [*:0]const u8) [*:0]const u8 {
    const len = mem.strlen(source);
    return parse_ast_raw(source[0..len :0]) catch @panic("Failed to parse");
}

export fn render_ast(astStr: [*:0]const u8) [*:0]const u8 {
    const len = mem.strlen(astStr);
    const parsed = std.json.parseFromSlice(Ast, mem.allocator, astStr[0..len], .{}) catch @panic("Failed to parse");

    var tokens = zig.Ast.TokenList{};
    var nodes = zig.Ast.NodeList{};

    var source = std.ArrayList(u8).init(mem.allocator);

    for (0..parsed.value.tokens.len) |i| {
        const start = source.items.len;
        const token = parsed.value.tokens[i];
        source.appendSlice(token.text) catch @panic("");
        source.append(" "[0]) catch @panic("");

        tokens.append(mem.allocator, .{
            .start = start,
            .tag = token.tag,
        }) catch @panic("");
    }

    source.append(0) catch @panic("");

    for (0..parsed.value.nodes.len) |i| {
        const node = parsed.value.nodes[i];

        nodes.append(mem.allocator, .{
            .data = .{
                .lhs = node.data.lhs,
                .rhs = node.data.rhs,
            },
            .main_token = node.main_token,
            .tag = node.tag,
        }) catch @panic("");
    }


    const ast: zig.Ast = .{
        .source = source.items[0..source.items.len :0],
        .nodes = nodes.slice(),
        .tokens = tokens.slice(),
        .errors = &.{},
        .extra_data = parsed.value.extra_data,
    };

    const res = zig.Ast.render(ast, mem.allocator) catch @panic("");
    var buf = mem.allocator.alloc(u8, res.len+1) catch @panic("");
    @memcpy(buf, res);
    buf[res.len] = 0;

    return buf[0..res.len :0];
}

export fn alloc(size: usize) [*]u8 {
    const b = mem.allocator.alloc(u8, size) catch @panic("Failed to allocate");

    return b.ptr;
}

