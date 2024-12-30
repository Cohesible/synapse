const std = @import("std");

pub fn ConcurrentBumpAllocator(comptime T: type) type {
    return struct {
        pub const items_per_page = @divFloor(std.mem.page_size, @sizeOf(T));
        const required_bits: u64 = @intFromFloat(@log2(@as(f64, items_per_page)));
        const mask = std.math.pow(u64, 2, required_bits) - 1;

        count: std.atomic.Value(u64) = std.atomic.Value(u64).init(0),
        pages: std.ArrayList([]T),
        page_allocator: std.mem.Allocator,
        mutex: std.Thread.Mutex,

        pub fn init(allocator: std.mem.Allocator, page_allocator: std.mem.Allocator) @This() {
            return .{
                .pages = std.ArrayList([]T).init(allocator),
                .page_allocator = page_allocator,
                .mutex = std.Thread.Mutex{},
            };
        }

        pub fn deinit(this: *@This()) void {
            for (this.pages.items) |p| {
                this.page_allocator.free(p);
            }
            this.pages.deinit();
        }

        inline fn addPage(this: *@This()) !void {
            const page = try this.page_allocator.alloc(T, items_per_page);

            this.mutex.lock();
            defer this.mutex.unlock();

            try this.pages.append(page);
        }

        pub fn push(this: *@This(), value: T) !u64 {
            const ret = this.count.fetchAdd(1, .monotonic);

            const local_count = ret % items_per_page;
            const page = ret / items_per_page;
            if (page == this.pages.items.len) {
                try this.addPage();
            }

            this.mutex.lock();
            var p = this.pages.items[page];
            p[local_count] = value;
            this.mutex.unlock();

            return ret;
        }

        // Not concurrent safe
        pub fn at(this: *const @This(), index: usize) *T {
            std.debug.assert(index < this.count.load(.monotonic));

            const page = index / items_per_page;
            const offset = @rem(index, items_per_page);

            return &this.pages.items[page][offset];
        }
    };
}

