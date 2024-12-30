// Taken from the standard library to fix a bug
const std = @import("std");
const mem = std.mem;

/// Static string map optimized for small sets of disparate string keys.
/// Works by separating the keys by length at initialization and only checking
/// strings of equal length at runtime.
pub fn StaticStringMap(comptime V: type) type {
    return StaticStringMapWithEql(V, defaultEql);
}

/// Like `std.mem.eql`, but takes advantage of the fact that the lengths
/// of `a` and `b` are known to be equal.
pub fn defaultEql(a: []const u8, b: []const u8) bool {
    if (a.ptr == b.ptr) return true;
    for (a, b) |a_elem, b_elem| {
        if (a_elem != b_elem) return false;
    }
    return true;
}


/// StaticStringMap, but accepts an equality function (`eql`).
/// The `eql` function is only called to determine the equality
/// of equal length strings. Any strings that are not equal length
/// are never compared using the `eql` function.
pub fn StaticStringMapWithEql(
    comptime V: type,
    comptime eql: fn (a: []const u8, b: []const u8) bool,
) type {
    return struct {
        kvs: *const KVs = &empty_kvs,
        len_indexes: [*]const u32 = &empty_len_indexes,
        len_indexes_len: u32 = 0,
        min_len: u32 = std.math.maxInt(u32),
        max_len: u32 = 0,

        pub const KV = struct {
            key: []const u8,
            value: V,
        };

        const Self = @This();
        const KVs = struct {
            keys: [*]const []const u8,
            values: [*]const V,
            len: u32,
        };
        const empty_kvs = KVs{
            .keys = &empty_keys,
            .values = &empty_vals,
            .len = 0,
        };
        const empty_len_indexes = [0]u32{};
        const empty_keys = [0][]const u8{};
        const empty_vals = [0]V{};

        /// Returns a map backed by static, comptime allocated memory.
        ///
        /// `kvs_list` must be either a list of `struct { []const u8, V }`
        /// (key-value pair) tuples, or a list of `struct { []const u8 }`
        /// (only keys) tuples if `V` is `void`.
        pub inline fn initComptime(comptime kvs_list: anytype) Self {
            comptime {
                var self = Self{};
                if (kvs_list.len == 0)
                    return self;

                // Since the KVs are sorted, a linearly-growing bound will never
                // be sufficient for extreme cases. So we grow proportional to
                // N*log2(N).
                @setEvalBranchQuota(10 * kvs_list.len * std.math.log2_int_ceil(usize, kvs_list.len));

                var sorted_keys: [kvs_list.len][]const u8 = undefined;
                var sorted_vals: [kvs_list.len]V = undefined;

                self.initSortedKVs(kvs_list, &sorted_keys, &sorted_vals);
                const final_keys = sorted_keys;
                const final_vals = sorted_vals;
                self.kvs = &.{
                    .keys = &final_keys,
                    .values = &final_vals,
                    .len = @intCast(kvs_list.len),
                };

                var len_indexes: [self.max_len + 1]u32 = undefined;
                self.initLenIndexes(&len_indexes);
                const final_len_indexes = len_indexes;
                self.len_indexes = &final_len_indexes;
                self.len_indexes_len = @intCast(len_indexes.len);
                return self;
            }
        }

        /// Returns a map backed by memory allocated with `allocator`.
        ///
        /// Handles `kvs_list` the same way as `initComptime()`.
        pub fn init(kvs_list: anytype, allocator: mem.Allocator) !Self {
            var self = Self{};
            if (kvs_list.len == 0)
                return self;

            const sorted_keys = try allocator.alloc([]const u8, kvs_list.len);
            errdefer allocator.free(sorted_keys);
            const sorted_vals = try allocator.alloc(V, kvs_list.len);
            errdefer allocator.free(sorted_vals);
            const kvs = try allocator.create(KVs);
            errdefer allocator.destroy(kvs);

            self.initSortedKVs(kvs_list, sorted_keys, sorted_vals);
            kvs.* = .{
                .keys = sorted_keys.ptr,
                .values = sorted_vals.ptr,
                .len = @intCast(kvs_list.len),
            };
            self.kvs = kvs;

            const len_indexes = try allocator.alloc(u32, self.max_len + 1);
            self.initLenIndexes(len_indexes);
            self.len_indexes = len_indexes.ptr;
            self.len_indexes_len = @intCast(len_indexes.len);
            return self;
        }

        /// this method should only be used with init() and not with initComptime().
        pub fn deinit(self: Self, allocator: mem.Allocator) void {
            allocator.free(self.len_indexes[0..self.len_indexes_len]);
            allocator.free(self.kvs.keys[0..self.kvs.len]);
            allocator.free(self.kvs.values[0..self.kvs.len]);
            allocator.destroy(self.kvs);
        }

        const SortContext = struct {
            keys: [][]const u8,
            vals: []V,

            pub fn lessThan(ctx: @This(), a: usize, b: usize) bool {
                return ctx.keys[a].len < ctx.keys[b].len;
            }

            pub fn swap(ctx: @This(), a: usize, b: usize) void {
                std.mem.swap([]const u8, &ctx.keys[a], &ctx.keys[b]);
                std.mem.swap(V, &ctx.vals[a], &ctx.vals[b]);
            }
        };

        fn initSortedKVs(
            self: *Self,
            kvs_list: anytype,
            sorted_keys: [][]const u8,
            sorted_vals: []V,
        ) void {
            for (kvs_list, 0..) |kv, i| {
                sorted_keys[i] = kv.@"0";
                sorted_vals[i] = if (V == void) {} else kv.@"1";
                self.min_len = @intCast(@min(self.min_len, kv.@"0".len));
                self.max_len = @intCast(@max(self.max_len, kv.@"0".len));
            }
            mem.sortUnstableContext(0, sorted_keys.len, SortContext{
                .keys = sorted_keys,
                .vals = sorted_vals,
            });
        }

        fn initLenIndexes(self: Self, len_indexes: []u32) void {
            var len: usize = 0;
            var i: u32 = 0;
            while (len <= self.max_len) : (len += 1) {
                // find the first keyword len == len
                while (len > self.kvs.keys[i].len) {
                    i += 1;
                }
                len_indexes[len] = i;
            }
        }

        /// Checks if the map has a value for the key.
        pub fn has(self: Self, str: []const u8) bool {
            return self.get(str) != null;
        }

        /// Returns the value for the key if any, else null.
        pub fn get(self: Self, str: []const u8) ?V {
            if (self.kvs.len == 0)
                return null;

            return self.kvs.values[self.getIndex(str) orelse return null];
        }

        pub fn getIndex(self: Self, str: []const u8) ?usize {
            const kvs = self.kvs.*;
            if (kvs.len == 0)
                return null;

            if (str.len < self.min_len or str.len > self.max_len)
                return null;

            var i = self.len_indexes[str.len];
            while (true) {
                const key = kvs.keys[i];
                if (key.len != str.len)
                    return null;
                if (eql(key, str))
                    return i;
                i += 1;
                if (i >= kvs.len)
                    return null;
            }
        }

        /// Returns the key-value pair where key is the longest prefix of `str`
        /// else null.
        ///
        /// This is effectively an O(N) algorithm which loops from `max_len` to
        /// `min_len` and calls `getIndex()` to check all keys with the given
        /// len.
        pub fn getLongestPrefix(self: Self, str: []const u8) ?KV {
            if (self.kvs.len == 0)
                return null;
            const i = self.getLongestPrefixIndex(str) orelse return null;
            const kvs = self.kvs.*;
            return .{
                .key = kvs.keys[i],
                .value = kvs.values[i],
            };
        }

        pub fn getLongestPrefixIndex(self: Self, str: []const u8) ?usize {
            if (self.kvs.len == 0)
                return null;

            if (str.len < self.min_len)
                return null;

            var len = @min(self.max_len, str.len);
            while (len >= self.min_len) : (len -= 1) {
                if (self.getIndex(str[0..len])) |i|
                    return i;
            }
            return null;
        }

        pub fn keys(self: Self) []const []const u8 {
            const kvs = self.kvs.*;
            return kvs.keys[0..kvs.len];
        }

        pub fn values(self: Self) []const V {
            const kvs = self.kvs.*;
            return kvs.values[0..kvs.len];
        }
    };
}