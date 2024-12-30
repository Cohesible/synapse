const std = @import("std");

pub const StateEntry = struct {
    kind: std.fs.File.Kind,
    name: []const u8,
    parent: ?u64 = null,
    size: u64,
    mtime: u64,
};

pub const Settings = struct {
    ignore_dot_dirs: bool = true,
    extnames: []const []const u8 = &.{},
    excluded_dirnames: []const []const u8 = &.{},
    included_patterns: []const []const u8 = &.{},
    excluded_patterns: []const []const u8 = &.{},
};

const State = struct {
    const Name = struct { offset: u32, len: u32 };

    pub const Entry = struct {
        kind: std.fs.File.Kind, 
        name: Name, 
        size: u64, 
        mtime: u64,
        parent: ?u64 = null, 
    };

    pub const Map = std.ArrayHashMap(u64, Entry, PassthroughCtx, false);

    map: Map,
    names: std.ArrayList(u8),
};

const ThreadPool = @import("./thread_pool.zig");
const ConcurrentBumpAllocator = @import("./mem.zig").ConcurrentBumpAllocator;

fn Job(comptime T: type) type {
    return struct {
        task: ThreadPool.Task,
        data: T,
        cb: *const fn (data: T) anyerror!void,

        pub fn call(task: *ThreadPool.Task) void {
            const t: *@This() = @fieldParentPtr("task", task);
            defer getAllocator().destroy(t);
            t.cb(t.data) catch |e| {
                if (comptime builtin.mode == .Debug) {
                    std.debug.print("cb failed {any}\n", .{e});
                }
            };
        }

        pub fn schedule(pool: *ThreadPool, data: T, cb: *const fn (data: T) anyerror!void) !void {
            const t = try getAllocator().create(@This());
            t.* = .{
                .cb = cb,
                .data = data,
                .task = .{ .callback = @This().call },
            };
            
            pool.schedule(ThreadPool.Batch.from(&t.task));
        }
    };
}

const RawChangeEvent = struct {
    const Kind = enum(u2) {
        added,
        updated,
        removed,
    };

    kind: Kind,
    subject: u64,
    state: StateEntry,
};

inline fn getPathHash(name: []const u8, parent_hash: ?u64) u64 {
    var hasher = std.hash.Wyhash.init(0);
    if (parent_hash) |h| {
        hasher.update(&@as([8]u8, @bitCast(h)));
        hasher.update(&.{0});
    }
    hasher.update(name);
    return hasher.final();
}

inline fn strEql(name: []const u8, comptime name2: []const u8) bool {
    return std.mem.eql(u8, name, name2);
}

const root_hash = getPathHash(".", null);

fn createSubPath(state: *const StateMap, buf: []u8, name: []const u8, parent_hash: ?u64) anyerror![]const u8 {
    const h = parent_hash orelse return name;
    if (h == root_hash) {
        @memcpy(buf[0..name.len], name);
        return buf[0..name.len];
    }

    const s = state.get(h) orelse return error.MissingEntry;
    if (s.parent == root_hash) {
        const len = s.name.len+1+name.len;
        std.debug.assert(len < buf.len);

        @memcpy(buf[0..s.name.len], s.name);
        buf[s.name.len] = std.fs.path.sep;
        @memcpy(buf[s.name.len+1..len], name);

        return buf[0..len];
    }

    const prefix = try createSubPath(state, buf, s.name, s.parent);

    const len = prefix.len+1+name.len;
    std.debug.assert(len < buf.len);

    buf[prefix.len] = std.fs.path.sep;
    @memcpy(buf[prefix.len+1..len], name);

    return buf[0..len];
}

const PassthroughCtx = struct {
    pub inline fn hash(_: @This(), key: u64) u32 {
        return @truncate(key);
    }

    pub inline fn eql(_: @This(), a: u64, b: u64, _: usize) bool {
        return a == b;
    }
};

const StateMap = std.ArrayHashMap(u64, StateEntry, PassthroughCtx, false);

var global_pool: ThreadPool = undefined;
var has_global_pool = false;
var pool_lock = std.Thread.Mutex{};

fn getThreadPool() *ThreadPool {
    pool_lock.lock();
    defer pool_lock.unlock();

    if (has_global_pool) {
        return &global_pool;
    }

    const max_threads = std.Thread.getCpuCount() catch |e| blk: {
        if (comptime builtin.mode == .Debug) {
            std.debug.print("failed to get cpu count, limiting to 1 thread: {any}\n", .{e});
        }
        break :blk 1;
    };

    global_pool = ThreadPool.init(.{ .max_threads = @intCast(max_threads) });
    has_global_pool = true;

    return &global_pool;
}

const builtin = @import("builtin");
const native_os = builtin.target.os.tag;

const disable_thread_pool = builtin.os.tag == .linux;

inline fn toEntries(arr: []const []const u8) []const struct { []const u8, void } {
    const ptr: [*]const struct { []const u8, void } = @ptrCast(arr.ptr);

    return ptr[0..arr.len];
}

const static_string_map = @import("./static_string_map.zig");
const StaticStringSet = static_string_map.StaticStringMap(void);

// `kind_hint` is needed on Windows
fn _statFile(self: std.fs.Dir, sub_path: []const u8, kind_hint: std.fs.File.Kind) !std.fs.File.Stat {
    if (native_os == .windows) {
        if (kind_hint == .directory) {
            var dir = try self.openDir(sub_path, .{});
            defer dir.close();
            return dir.stat();
        }
        var file = try self.openFile(sub_path, .{});
        defer file.close();
        return file.stat();
    }
    if (native_os == .wasi and !builtin.link_libc) {
        const st = try std.os.fstatat_wasi(self.fd, sub_path, .{ .SYMLINK_FOLLOW = true });
        return std.fs.File.Stat.fromWasi(st);
    }
    const st = try std.posix.fstatat(self.fd, sub_path, 0);
    return std.fs.File.Stat.fromSystem(st);
}

const Visitor = struct {
    const PatternsMap = std.ArrayHashMap(u64, Patterns, PassthroughCtx, false);

    allocator: std.mem.Allocator,
    root_dir: std.fs.Dir,
    settings: Settings,
    state: StateMap,
    changes: ConcurrentBumpAllocator(RawChangeEvent),
    pool: *ThreadPool,
    wg: ThreadPool.WaitGroup,
    is_fresh: bool,
    size_delta: std.atomic.Value(i32),

    excluded_dirnames: StaticStringSet = undefined,
    included_extnames: StaticStringSet = undefined,

    patterns: PatternsMap,
    patterns_mutex: std.Thread.Mutex,

    pub fn init(_allocator: std.mem.Allocator, settings: Settings, state: ?StateMap) @This() {
        return .{
            .allocator = _allocator,
            .root_dir = std.fs.cwd(),
            .settings = settings,
            .changes = ConcurrentBumpAllocator(RawChangeEvent).init(_allocator, std.heap.page_allocator),
            .state = state orelse StateMap.init(_allocator),
            .pool = getThreadPool(),
            .wg = ThreadPool.WaitGroup{},
            .is_fresh = state == null,
            .size_delta = std.atomic.Value(i32).init(0),
            .patterns = PatternsMap.init(_allocator),
            .patterns_mutex = std.Thread.Mutex{},
         };
    }

    threadlocal var path_buf: [4096]u8 = undefined;

    inline fn statFile(this: *@This(), data: PerDirTaskData, parent_dir: ?std.fs.Dir, parent_hash: ?u64) !std.fs.File.Stat {
        if (parent_dir) |d| {
            return try _statFile(d, data.name, data.kind);
        }

        const sub_path = try createSubPath(&this.state, &path_buf, data.name, parent_hash);

        return try _statFile(this.root_dir, sub_path, data.kind);
    }

    inline fn openDir(this: *@This(), data: PerDirTaskData, parent_dir: ?std.fs.Dir, parent_hash: ?u64) !std.fs.Dir {
        if (parent_dir) |d| {
            return d.openDir(data.name, .{ .iterate = true });
        } 

        const sub_path = try createSubPath(&this.state, &path_buf, data.name, parent_hash);

        return this.root_dir.openDir(sub_path, .{ .iterate = true });
    }

    const CopyMode = enum {
        needs_copy,
        always_copy,
        pre_allocated,
    };

    inline fn prepareTaskData(this: *@This(), hash: u64, _name: []const u8, kind: std.fs.File.Kind, prior: ?*StateEntry, comptime copy_mode: CopyMode) !PerDirTaskData {
        var name = _name;
        if (comptime copy_mode == .always_copy) {
            const n = try this.allocator.alloc(u8, _name.len);
            @memcpy(n, _name);
            name = n;
        }

        return .{
            .hash = hash,
            .name = name,
            .kind = kind,
            .prior = prior,
            .needs_copy = comptime copy_mode == .needs_copy,
        };
    }

    // Avoids multiple calls to `Wyhash.init` for the same dir
    const Hasher = struct {
        parent_hash: u64,
        state: std.hash.Wyhash,

        pub inline fn init(parent_hash: u64) @This() {
            var state = std.hash.Wyhash.init(0);
            state.update((@as([8]u8, @bitCast(parent_hash)) ++ "/"));

            return .{
                .parent_hash = parent_hash,
                .state = state,
            };
        }

        pub inline fn hash(this: *@This(), name: []const u8) u64 {
            const copy = this.state;
            defer this.state = copy;

            this.state.update(name);
            return this.state.final();
        }
    };

    fn tryEnqueueTaskFromDir(this: *@This(), entry: std.fs.Dir.Entry, dir: std.fs.Dir, hasher: ?*Hasher, patterns: ?*Patterns) anyerror!bool {
        const apparent_kind = blk: {
            if (entry.kind != .sym_link) break :blk entry.kind;

            // Check this early to avoid pointless calls
            const hash = if (hasher) |h| h.hash(entry.name) else root_hash;
            if (!this.is_fresh and this.state.contains(hash)) {
                return false;
            }

            // new symlinks use 2 `stat` calls, but the optimal is 1
            const s = try dir.statFile(entry.name);

            // TODO: detect recursive symlinks
            if (s.kind != .file) {
                return error.TODO_non_file_symlinks;
            }

            break :blk s.kind;
        };

        var next_patterns: ?*Patterns = null;
        if (hasher != null) {
            if (!this.shouldVisit(entry.name, apparent_kind)) {
                return false;
            }
        }

        const hash = if (hasher) |h| h.hash(entry.name) else root_hash;
        if (!this.is_fresh and this.state.contains(hash)) {
            return false;
        }

        const parent_hash = if (hasher) |h| h.parent_hash else null;
        
        if (patterns) |p| {
            if (hasher == null) {
                next_patterns = p;
            } else {
                if (apparent_kind == .directory) {
                    const new_patterns = try p.getNextPatterns(entry.name, this.allocator) orelse return false;
                    const np = try this.allocator.create(Patterns);
                    np.* = new_patterns;
                    next_patterns = np;
                } else if (!p.matchFile(entry.name)) {
                    return false;
                }
            }
        }

        var inner = try this.prepareTaskData(
            hash, 
            entry.name,
            apparent_kind,
            null,
            .always_copy,
        );

        if (apparent_kind != .directory) {
            // We stat files in the same task instead of spawning a new one
            try this.doVisit(dir, parent_hash, inner);
            return true;
        }

        inner.patterns = next_patterns;

        const data = TaskData{
            .visitor = this,
            .inner = inner,
            .parent_dir = dir,
            .parent_hash = parent_hash,
        };

        this.wg.start();

        if (comptime disable_thread_pool) {
            try data.run();
        } else {
            try Job(TaskData).schedule(this.pool, data, &TaskData.run);
        }

        return true;
    }

    fn doVisit(this: *@This(), parent_dir: ?std.fs.Dir, parent_hash: ?u64, task: PerDirTaskData) !void {
        const stats = this.statFile(task, parent_dir, parent_hash) catch |e| {
            return this.handleError(task.hash, e, task.prior);
        };

        const prior_mtime = if (task.prior) |p| p.mtime else 0;
        const prior_size = if (task.prior) |p| p.size else 0;

        // microsecond resolution
        const mtime: u64 = if (stats.mtime < 0) 0 else @truncate(@as(u128, @intCast(stats.mtime)) / 1000);

        if (mtime == prior_mtime and stats.size == prior_size) {
            return;
        }

        var name = task.name;
        if (task.needs_copy) {
            const n = try this.allocator.alloc(u8, task.name.len);
            @memcpy(n, task.name);
            name = n;
        }

        if (!this.is_fresh and task.prior == null) {
            _ = this.size_delta.fetchAdd(1, .monotonic);
        }

        _ = try this.changes.push(.{
            .kind = if (task.prior == null) .added else .updated,
            .subject = task.hash,
            .state = .{
                .name = name,
                .kind = task.kind,
                .parent = parent_hash,
                .size = stats.size,
                .mtime = mtime,
            },
        });

        if (task.kind != .directory) {
            return;
        }

        var hasher = Hasher.init(task.hash);

        const patterns = task.patterns orelse try this.getPatterns(task.hash);

        const dir = try this.openDir(task, parent_dir, parent_hash);
        var iter = dir.iterateAssumeFirstIteration();
        while (try iter.next()) |entry| {
            _ = try this.tryEnqueueTaskFromDir(entry, dir, &hasher, patterns);
        }
    } 

    fn getPatterns(this: *@This(), hash: u64) anyerror!*Patterns {
        this.patterns_mutex.lock();
        defer this.patterns_mutex.unlock();

        if (this.patterns.getEntry(hash)) |x| {
            return x.value_ptr;
        }

        const state = this.state.get(hash) orelse return error.MissingEntry;
        if (state.parent) |h| {
            this.patterns_mutex.unlock();   
            const parent_patterns = try this.getPatterns(h); 
            const next = try parent_patterns.getNextPatterns(state.name, this.allocator) orelse return error.TODO;

            this.patterns_mutex.lock();
            this.patterns.putAssumeCapacity(hash, next);
        } else {
            this.patterns.putAssumeCapacity(hash, .{
                .included = this.settings.included_patterns,
                .excluded = this.settings.excluded_patterns,
                .owns_included = false,
                .owns_excluded = false,
            });
        }

        return (this.patterns.getEntry(hash) orelse unreachable).value_ptr;
    }

    const Patterns = struct {
        included: []const []const u8,
        excluded: []const []const u8,
        owns_included: bool = true,
        owns_excluded: bool = true,

        pub fn deinit(this: @This(), allocator: std.mem.Allocator) void {
            if (this.owns_included) {
                allocator.destroy(this.included);
            }
            if (this.owns_excluded) {
                allocator.destroy(this.excluded);
            }
        }

        inline fn matchSegment(subject: []const u8, pattern: []const u8) bool {
            // We only match 1 wildcard
            const star_index = std.mem.indexOfScalar(u8, pattern, '*');
            if (star_index) |i| { 
                return (
                    std.mem.startsWith(u8, subject, pattern[0..i]) and 
                    std.mem.endsWith(u8, subject, pattern[i+1..])
                );
            }

            return std.mem.eql(u8, subject, pattern);
        }

        pub fn matchFile(this: *@This(), name: []const u8) bool {
            for (this.excluded) |p| {
                if (matchSegment(name, std.fs.path.basename(p))) {
                    return false;
                }
            }
  
            for (this.included) |p| {
                if (matchSegment(name, std.fs.path.basename(p))) {
                    return true;
                }
            }

            return this.included.len == 0;
        }

        inline fn rootDirname(path: []const u8) ?[]const u8 {
            const sep_index = std.mem.indexOfScalar(u8, path, std.fs.path.sep) orelse return null;
            if (sep_index == 0) {
                return path[0..1];
            }

            return path[0..sep_index];
        }

        pub fn getNextPatterns(this: *@This(), dirname: []const u8, allocator: std.mem.Allocator) !?@This() {
            var included = std.ArrayList([]const u8).init(allocator);
            var excluded = std.ArrayList([]const u8).init(allocator);

            var did_match = this.included.len == 0;
            var can_reuse_included = true;
            var can_reuse_excluded = true;

            for (this.excluded) |p| {      
                if (rootDirname(p)) |n| {
                    if (!strEql(n, "**")) {
                        if (matchSegment(dirname, n)) {
                            can_reuse_excluded = false;
                            try excluded.append(p[n.len+1..]);
                        }

                        continue;
                    }

                    const next_dir = rootDirname(p[n.len+1..]);
                    if (next_dir) |nd| {
                        if (matchSegment(dirname, nd)) {
                            can_reuse_excluded = false;
                            try excluded.append(p[n.len+nd.len+2..]);
                        }
                    } else {
                        if (matchSegment(dirname, p[n.len+1..])) {
                            excluded.deinit();
                            return null;
                        }
                    }

                    try excluded.append(p);
                } else {
                    if (matchSegment(dirname, p)) {
                        excluded.deinit();
                        return null;
                    }

                    // For excluded, we implicitly globstar things that might be directories
                    const is_implicit_glob = (
                        std.mem.indexOfScalar(u8, p, '*') == null and 
                        std.mem.indexOfScalar(u8, p, '.') == null
                    );

                    if (is_implicit_glob) {
                        try excluded.append(p);
                    }
                }
            }

            for (this.included) |p| {
                if (rootDirname(p)) |n| {
                    if (!strEql(n, "**")) {
                        if (matchSegment(dirname, n)) {
                            can_reuse_included = false;
                            try included.append(p[n.len+1..]);
                        }

                        continue;
                    }

                    // globstar represents 0 or more directories
                    // So we need to lookahead and see if the _next_ segment matches
                    const next_dir = rootDirname(p[n.len+1..]);
                    if (next_dir) |nd| {
                        if (matchSegment(dirname, nd)) {
                            can_reuse_included = false;
                            try included.append(p[n.len+nd.len+2..]);
                        }
                    } else {
                        // Fully matched dir, reset included to include all
                        if (matchSegment(dirname, p[n.len+1..])) {
                            did_match = true;
                            included.deinit();
                            included = std.ArrayList([]const u8).init(allocator);
                            break;
                        }
                    }

                    try included.append(p);
                } else {
                    // Fully matched dir, reset included to include all
                    if (matchSegment(dirname, p)) {
                        did_match = true;
                        included.deinit();
                        included = std.ArrayList([]const u8).init(allocator);
                        break;
                    }
                }
            }

            if (included.items.len > 0) {
                did_match = true;
            }

            if (!did_match) {
                included.deinit();
                excluded.deinit();
                return null;
            }
            
            var result = @This(){
                .included = included.items,
                .excluded = excluded.items,
            };

            if (included.items.len == this.included.len and can_reuse_included) {
                included.deinit();
                result.included = this.included;
                result.owns_included = false;
            }

            if (excluded.items.len == this.excluded.len and can_reuse_excluded) {
                excluded.deinit();
                result.excluded = this.excluded;
                result.owns_excluded = false;
            }

            return result; 
        }
    };

    const PerDirTaskData = struct {
        kind: std.fs.File.Kind,
        name: []const u8,
        hash: u64,
        prior: ?*StateEntry = null,
        needs_copy: bool = false,

        patterns: ?*Patterns = null,
    };

    const TaskData = struct {
        visitor: *Visitor,
        inner: PerDirTaskData,
        parent_dir: ?std.fs.Dir,
        parent_hash: ?u64,

        pub fn run(this: @This()) !void {
            defer this.visitor.wg.finish();
            // TODO: a newly added dir can open the fd directly (maybe better perf?)
            
            try this.visitor.doVisit(this.parent_dir, this.parent_hash, this.inner);
        }
    };

    const BatchedTasks = struct {
        const max_amount = 8;
        tasks: [max_amount]PerDirTaskData = undefined,
        count: u8 = 0,
        visitor: *Visitor,
        parent_dir: ?std.fs.Dir,
        parent_hash: ?u64,

        pub fn init(visitor: *Visitor, parent_hash: ?u64) @This() {
            return .{
                .visitor = visitor,
                .parent_dir = null,
                .parent_hash = parent_hash,
            };
        }

        pub fn append(this: *@This(), task: PerDirTaskData) bool {
            std.debug.assert(this.count < max_amount);

            this.tasks[this.count] = task;
            this.count += 1;

            return this.count < max_amount;
        }

        pub fn run(this: @This()) !void {
            defer this.visitor.wg.finish();

            for (this.tasks[0..this.count]) |t| {
                try this.visitor.doVisit(this.parent_dir, this.parent_hash, t);
            }
        }
    };

    fn shouldVisit(this: *const @This(), name: []const u8, kind: std.fs.File.Kind) bool {
        if (kind == .directory) {
            if (this.settings.ignore_dot_dirs) {
                std.debug.assert(name.len > 0);

                if (name[0] == '.') {
                    return false;
                }
            }

            if (this.excluded_dirnames.has(name)) {
                return false;
            }

            return true;
        }

        if (this.included_extnames.kvs.len == 0) {
            return true;
        }

        // TODO: might be faster to use direct checks against `extnames`
        const extname = std.fs.path.extension(name);
        if (extname.len == 0) {
            return false;
        }

        return this.included_extnames.has(extname[1..]);
    }

    fn handleError(this: *@This(), hash: u64, e: anyerror, prior: ?*StateEntry) !void {
        if (e != std.fs.File.OpenError.FileNotFound and e != std.fs.Dir.OpenError.FileNotFound) {
            return e;
        }

        // File was likely deleted while visiting if it's not in the state prior to this
        if (prior) |s| {
            if (!this.is_fresh) {
                _ = this.size_delta.fetchSub(1, .monotonic);
            }

            _ = try this.changes.push(.{
                .kind = .removed,
                .subject = hash,
                .state = s.*,
            });
        }

        return;
    }

    pub fn nextState(this: *@This(), apply_changes: bool) !struct { StateMap, ConcurrentBumpAllocator(RawChangeEvent) } {
        this.excluded_dirnames = try StaticStringSet.init(toEntries(this.settings.excluded_dirnames), this.allocator);
        this.included_extnames = try StaticStringSet.init(toEntries(this.settings.extnames), this.allocator);

        if (this.is_fresh) {
            const patterns = try this.allocator.create(Patterns);
            patterns.* = .{
                .included = this.settings.included_patterns,
                .excluded = this.settings.excluded_patterns,
                .owns_included = false,
                .owns_excluded = false,
            };

            try this.doVisit(this.root_dir, null, .{
                .hash = root_hash,
                .name = ".",
                .kind = .directory,
                .patterns = patterns,
            });
        } else {
            var iter = this.state.iterator();
            var batches = std.ArrayHashMap(u64, BatchedTasks, PassthroughCtx, false).init(this.allocator);

            // The max # of space we need is the # of dir hashes

            var dirs: u32 = 0;
            while (iter.next()) |entry| {
                if (entry.value_ptr.kind == .directory) {
                    dirs += 1;
                }
            }

            try this.patterns.ensureTotalCapacity(dirs);

            iter.reset();
            try batches.ensureUnusedCapacity(dirs + 1);
 
            while (iter.next()) |entry| {
                const hash = entry.value_ptr.parent orelse 0;
                const batch_entry = batches.getOrPutAssumeCapacity(hash);
                if (!batch_entry.found_existing) {
                    batch_entry.value_ptr.* = BatchedTasks.init(this, entry.value_ptr.parent);
                }

                const task = try this.prepareTaskData(
                    entry.key_ptr.*, 
                    entry.value_ptr.name,
                    entry.value_ptr.kind,
                    entry.value_ptr, 
                    .pre_allocated
                );

                if (!batch_entry.value_ptr.append(task)) {
                    this.wg.start();
                    if (comptime disable_thread_pool) {
                        try batch_entry.value_ptr.*.run();
                        _ = batches.swapRemove(hash);
                        continue;
                    }
                    try Job(BatchedTasks).schedule(this.pool, batch_entry.value_ptr.*, &BatchedTasks.run);
                    _ = batches.swapRemove(hash);
                }
            }

            var batches_iter = batches.iterator();
            while (batches_iter.next()) |b| {
                this.wg.start();
                if (comptime disable_thread_pool) {
                    try b.value_ptr.*.run();
                    continue;
                }
                try Job(BatchedTasks).schedule(this.pool, b.value_ptr.*, &BatchedTasks.run);
            }
        }

        this.wg.wait();

        if (apply_changes) {
            try this.maybeExpandState();
            try applyChanges(&this.state, &this.changes);
        }

        return .{ this.state, this.changes };
    }

    pub fn maybeExpandState(this: *@This()) !void {
        if (this.is_fresh) {
            try this.state.ensureUnusedCapacity(this.changes.count.load(.acquire));
        } else {
            const delta = this.size_delta.load(.acquire);
            if (delta > 0) {
                try this.state.ensureUnusedCapacity(@intCast(delta));
            }
        }
    }
};

// Assumes `state` has enough space
fn applyChanges(state: *StateMap, changes: *ConcurrentBumpAllocator(RawChangeEvent)) !void {
    const count = changes.count.load(.acquire);
    var i: u64 = 0;
    while (i < count) : (i += 1) {
        const ev = changes.at(i);
        if (ev.kind == .removed) {
            std.debug.assert(state.swapRemove(ev.subject));
        } else {
            state.putAssumeCapacity(ev.subject, ev.state);
        }
    }
}

const js = @import("js");

const StateHeader = struct {
    count: u32,
    _pad: [@sizeOf(StateEntryPair) - @sizeOf(u32)]u8 = undefined,
};

const StateEntryPair = struct {
    key: u64,
    value: State.Entry,
};

const ChangesIterator = struct {
    index: u32 = 0,
    count: u32,
    changes: *const ConcurrentBumpAllocator(RawChangeEvent),

    pub fn init(changes: *const ConcurrentBumpAllocator(RawChangeEvent)) @This() {
        return .{
            .count = @intCast(changes.count.load(.acquire)),
            .changes = changes,
        };
    }

    pub fn reset(this: *@This()) void {
        this.index = 0;
    }

    pub fn next(this: *@This()) ?*RawChangeEvent {
        if (this.index == this.count) {
            return null;
        }

        const p = this.changes.at(this.index);
        this.index += 1;

        return p;
    }
};

pub fn initState(dirname: js.UTF8String, opt: ?Settings) !js.Promise(js.ArrayBuffer) {
    var dir = try std.fs.cwd().openDir(dirname.data, .{});
    defer dir.close();
 
    var v = Visitor.init(getAllocator(), opt orelse .{}, null);
    v.root_dir = dir;
    const result = try v.nextState(false);
    var changes_iter = ChangesIterator.init(&result[1]);

    var names = std.ArrayHashMap(u64, []const u8, PassthroughCtx, false).init(getAllocator());
    defer names.deinit();

    try names.ensureTotalCapacity(changes_iter.count);

    var names_size: u32 = 0;
    while (changes_iter.next()) |ev| {
        const h = std.hash.Wyhash.hash(0, ev.state.name);
        const entry = names.getOrPutAssumeCapacity(h);
        if (!entry.found_existing) {
            entry.value_ptr.* = ev.state.name;
            names_size += @intCast(ev.state.name.len);
        }
    }

    changes_iter.reset();

    const changes = result[1]; // TODO: deinit this
    const count: u32 = @intCast(changes.count.load(.seq_cst));

    const names_start = @sizeOf(StateHeader) + (count * @sizeOf(StateEntryPair));
    const size = names_start + names_size;
    const b = try js.ArrayBuffer.init(size);
    
    const header: *StateHeader = @alignCast(@ptrCast(b.buf[0..@sizeOf(StateHeader)]));
    header.* = .{ .count = count };
    
    var entries: [*]StateEntryPair = @alignCast(@ptrCast(b.buf[@sizeOf(StateHeader)..]));
    const names_buf: [*]u8 = @alignCast(@ptrCast(b.buf[names_start..]));

    var i: u64 = 0;
    var names_cursor: u32 = 0;
    while (changes_iter.next()) |ev| {
        const n = ev.state.name;
        std.debug.assert(ev.kind == .added);

        entries[i] = .{
            .key = ev.subject,
            .value = .{
                .name = .{ .offset = names_cursor, .len = @intCast(n.len) },
                .kind = ev.state.kind,
                .mtime = ev.state.mtime,
                .size = ev.state.size,
                .parent = ev.state.parent,
            },
        };

        @memcpy(names_buf[names_cursor..names_cursor+n.len], n);
        names_cursor += @intCast(n.len);
        i += 1;
    }

    return .{b};
}

fn serializeState(state: *StateMap) !js.ArrayBuffer {
    var iter = state.iterator();

    var names = std.ArrayHashMap(u64, struct { []const u8, u32 }, PassthroughCtx, false).init(getAllocator());
    defer names.deinit();

    try names.ensureTotalCapacity(iter.len);

    const count = iter.len;
    const names_start = @sizeOf(StateHeader) + (count * @sizeOf(StateEntryPair));

    var names_size: u32 = 0;
    while (iter.next()) |state_entry| {
        const name = state_entry.value_ptr.name;
        const h = std.hash.Wyhash.hash(0, name);
        const entry = names.getOrPutAssumeCapacity(h);
        if (!entry.found_existing) {
            entry.value_ptr.* = .{name, names_size};
            names_size += @intCast(name.len);
        }
    }

    iter.reset(); 

    const size = names_start + names_size;
    const b = try js.ArrayBuffer.init(size);
    
    const header: *StateHeader = @alignCast(@ptrCast(b.buf[0..@sizeOf(StateHeader)]));
    header.* = .{ .count = count };
    
    var entries: [*]StateEntryPair = @alignCast(@ptrCast(b.buf[@sizeOf(StateHeader)..]));
    var names_buf: [*]u8 = @alignCast(@ptrCast(b.buf[names_start..]));

    var names_iter = names.iterator();
    while (names_iter.next()) |entry| {
        const n = entry.value_ptr[0];
        const names_cursor = entry.value_ptr[1];
        @memcpy(names_buf[names_cursor..names_cursor+n.len], n);
    }

    var i: u64 = 0;
    while (iter.next()) |state_entry| {
        const n = state_entry.value_ptr.name;

        const deduped_name = names.get(std.hash.Wyhash.hash(0, n)) orelse unreachable;

        entries[i] = .{
            .key = state_entry.key_ptr.*,
            .value = .{
                .name = .{ .offset = deduped_name[1], .len = @intCast(n.len) },
                .kind = state_entry.value_ptr.kind,
                .mtime = state_entry.value_ptr.mtime,
                .size = state_entry.value_ptr.size,
                .parent = state_entry.value_ptr.parent,
            },
        };

        i += 1;
    }

    return b;
}

inline fn checkName(name: []const u8) !void {
    if (comptime builtin.mode == .Debug) {
        if (std.mem.indexOfScalar(u8, name, 0) != null) {
            return error.CorruptedState;
        }
    }
}

fn deserializeState(buf: []const u8) !StateMap {
    const header: *const StateHeader = @alignCast(@ptrCast(buf[0..@sizeOf(StateHeader)]));
    var state = StateMap.init(getAllocator());
    try state.ensureTotalCapacity(header.count);

    const names_start = @sizeOf(StateHeader) + (header.count * @sizeOf(StateEntryPair));
    const names_buf: [*]const u8 = @alignCast(@ptrCast(buf[names_start..]));

    const entries: [*]const StateEntryPair = @alignCast(@ptrCast(buf[@sizeOf(StateHeader)..]));
    for (entries[0..header.count]) |entry| {
        const name = names_buf[entry.value.name.offset..entry.value.name.offset+entry.value.name.len];
        try checkName(name);

        state.putAssumeCapacity(entry.key, .{
            .name = names_buf[entry.value.name.offset..entry.value.name.offset+entry.value.name.len],
            .kind = entry.value.kind,
            .mtime = entry.value.mtime,
            .size = entry.value.size,
            .parent = entry.value.parent,
        });
    }

    return state; 
} 

pub fn dumpState(state: js.ArrayBuffer) !void {
    var state_map = try deserializeState(state.buf);
    defer state_map.deinit();

    var iter = state_map.iterator();
    while (iter.next()) |entry| {
        std.debug.print("{s} {any}\n", .{ entry.value_ptr.name, entry.value_ptr.kind });
    }
} 

pub const SimpleChangeEvent = struct {
    subpath: []const u8,
    is_added: bool,
    is_removed: bool,
};

pub const DetectChangesResult = struct {
    state: js.ArrayBuffer,
    changes: []const SimpleChangeEvent,
};

const use_js_allocator = true;
inline fn getAllocator() std.mem.Allocator {
    if (comptime use_js_allocator) {
        return js.getAllocator();
    }
    return std.heap.c_allocator;
}

pub fn detectChanges(state: js.ReferencedBuffer, dirname: js.UTF8String, opt: ?Settings) !js.Promise(?DetectChangesResult) {
    var dir = try std.fs.cwd().openDir(dirname.data, .{});
    defer dir.close();

    const state_map = try deserializeState(state.data);

    var arena = std.heap.ArenaAllocator.init(getAllocator());
    defer arena.deinit();

    var v = Visitor.init(arena.allocator(), opt orelse .{}, state_map);
    v.root_dir = dir;

    var result = try v.nextState(false);
    defer {
        result[0].deinit();
        result[1].deinit();
    }

    var file_change_count: u32 = 0;
    var changes_iter = ChangesIterator.init(&result[1]);
    while (changes_iter.next()) |ev| {
        if (ev.state.kind == .file) {
            file_change_count += 1;
        } 
    } 

    if (changes_iter.count == 0) {
        return .{null};
    }

    changes_iter.reset();

    // LEAKS
    // The current design of the `js` module automatically creates an array and copies elements when returning a slice
    // Which is fine for slices managed on the JS side, but we lack control on this side. A generic type to indicate
    // "take ownership of this"
    const elements = try getAllocator().alloc(SimpleChangeEvent, file_change_count);

    var i: u32 = 0;
    var path_buf: [4096]u8 = undefined;

    while (changes_iter.next()) |ev| {
        if (ev.kind != .removed) continue;
        if (ev.state.kind != .file) continue;

        const p = try createSubPath(&v.state, &path_buf, ev.state.name, ev.state.parent);
        const n = try getAllocator().alloc(u8, p.len);
        @memcpy(n, p);

        try checkName(n);
         
        elements[i] = .{
            .subpath = n,
            .is_added = false,
            .is_removed = true,
        };
        i += 1;
    }

    try v.maybeExpandState();
    try applyChanges(&v.state, &v.changes);

    const new_state = try serializeState(&v.state);

    changes_iter.reset();
    while (changes_iter.next()) |ev| {
        if (ev.kind == .removed) continue;
        if (ev.state.kind != .file) continue;

        const p = try createSubPath(&v.state, &path_buf, ev.state.name, ev.state.parent);
        const n = try getAllocator().alloc(u8, p.len);
        @memcpy(n, p);

        try checkName(n);
         
        elements[i] = .{
            .subpath = n,
            .is_added = ev.kind == .added,
            .is_removed = false,
        };
        i += 1;
    }
    
    return .{
        .{
            .state = new_state,
            .changes = elements,
        },
    };
}
