const std = @import("std");
const builtin = @import("builtin");
const js = @import("./lib/js.zig");
const fs = std.fs;

const FsPromise = js.Promise(void, anyerror);

const NodeErrors = error{EEXIST, ENOENT, EINVAL};

pub fn cloneDir(src: js.UTF8String, srcName: js.UTF8String, dst: js.UTF8String, dstName: js.UTF8String) FsPromise {
    _cloneDir(src.data, srcName.data, dst.data, dstName.data) catch |e| {
        return FsPromise.reject(e);
    };

    return FsPromise.resolve({});
}

pub fn copyDir(src: js.UTF8String, dst: js.UTF8String) FsPromise {
    var srcDir = fs.openDirAbsoluteZ(src.data, .{ .iterate = true }) catch |e| return FsPromise.reject(e);
    defer srcDir.close();

    var dstDir = ensureDirAbs(dst.data) catch |e| return FsPromise.reject(e);
    defer dstDir.close();

    _copyDir(srcDir, dstDir) catch |e| return FsPromise.reject(e);

    return FsPromise.resolve({});
}

pub fn symLinkBin(src: js.UTF8String, dst: js.UTF8String) FsPromise {
    _symLinkBin(src.data, dst.data) catch |e| return FsPromise.reject(e);

    return FsPromise.resolve({});
}

fn _symLinkBin(src: [:0]const u8, dst: [:0]const u8) !void {
    return fs.symLinkAbsoluteZ(src, dst, .{}) catch |e| {
        if (e == std.posix.SymLinkError.FileNotFound) {
            return NodeErrors.ENOENT;
        }
        if (e != std.posix.SymLinkError.PathAlreadyExists) {
            return e;
        }
        
        try fs.deleteFileAbsoluteZ(dst);
        return fs.symLinkAbsoluteZ(src, dst, .{});
    };
}

pub fn removeDir(parent: js.UTF8String, name: js.UTF8String) FsPromise {
    _removeDir(parent.data, name.data) catch |e| return FsPromise.reject(e);

    return FsPromise.resolve({});
}

fn ensureDirAbs(path: [:0]const u8) !fs.Dir {
    return fs.openDirAbsoluteZ(path, .{}) catch |e| {
        if (e != fs.File.OpenError.FileNotFound) {
            return e;
        }

        fs.makeDirAbsoluteZ(path) catch |e2| {
            if (e2 != std.posix.MakeDirError.PathAlreadyExists) {
                return e2;
            }
        };

        return fs.openDirAbsoluteZ(path, .{});
    };
}

fn ensureDirZ(dir: fs.Dir, path: [:0]const u8) !fs.Dir{
    return dir.openDirZ(path, .{}) catch |e| {
        if (e != fs.File.OpenError.FileNotFound) {
            return e;
        }

        dir.makeDirZ(path) catch |e2| {
            if (e2 != std.posix.MakeDirError.PathAlreadyExists) {
                return e2;
            }
        };

        return dir.openDirZ(path, .{});
    };
}

fn ensureDir(dir: fs.Dir, path: []const u8) !fs.Dir {
    return dir.openDir(path, .{}) catch |e| {
        if (e != fs.File.OpenError.FileNotFound) {
            return e;
        }

        dir.makeDir(path) catch |e2| {
            if (e2 != std.posix.MakeDirError.PathAlreadyExists) {
                return e2;
            }
        };

        return dir.openDir(path, .{});
    };
}

const CopyFileRawError = error{SystemResources} || NodeErrors || std.posix.CopyFileRangeError || std.posix.SendFileError;

const native_os = builtin.os.tag;

// Transfer all the data between two file descriptors in the most efficient way.
// The copy starts at offset 0, the initial offsets are preserved.
// No metadata is transferred over.
fn copy_file(fd_in: std.posix.fd_t, fd_out: std.posix.fd_t, size: u64) CopyFileRawError!void {
    if (comptime builtin.target.isDarwin()) {
        const rc = std.posix.system.fcopyfile(fd_in, fd_out, null, std.posix.system.COPYFILE_DATA);
        switch (std.posix.errno(rc)) {
            .SUCCESS => return,
            .INVAL => return NodeErrors.EINVAL,
            .NOMEM => return error.SystemResources,
            // The source file is not a directory, symbolic link, or regular file.
            // Try with the fallback path before giving up.
            .OPNOTSUPP => {},
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }

    if (native_os == .linux) {
        // Try copy_file_range first as that works at the FS level and is the
        // most efficient method (if available).
        var offset: u64 = 0;
        cfr_loop: while (true) {
            // The kernel checks the u64 value `offset+count` for overflow, use
            // a 32 bit value so that the syscall won't return EINVAL except for
            // impossibly large files (> 2^64-1 - 2^32-1).
            const amt = try std.posix.copy_file_range(fd_in, offset, fd_out, offset, std.math.maxInt(u32), 0);
            // Terminate as soon as we have copied size bytes or no bytes
            if (amt == 0 or size == amt) break :cfr_loop;
            offset += amt;
        }
        return;
    }

    // Sendfile is a zero-copy mechanism iff the OS supports it, otherwise the
    // fallback code will copy the contents chunk by chunk.
    const empty_iovec = [0]std.posix.iovec_const{};
    var offset: u64 = 0;
    sendfile_loop: while (true) {
        const amt = try std.posix.sendfile(fd_out, fd_in, offset, 0, &empty_iovec, &empty_iovec, 0);
        // Terminate as soon as we have copied size bytes or no bytes
        if (amt == 0 or size == amt) break :sendfile_loop;
        offset += amt;
    }
}

// https://keith.github.io/xcode-man-pages/copyfile.3.html
// https://keith.github.io/xcode-man-pages/clonefile.2.html

const COPYFILE_RECURSIVE = 1 << 15;
const COPYFILE_CLONE = 1 << 24;
const COPYFILE_CLONE_FORCE = 1 << 25;

extern fn copyfile(src: [*]const u8, dst: [*]const u8, state: ?*anyopaque, flags: u32) c_int;
extern fn clonefileat(src_dirfd: c_int, src: [*:0]const u8, dst_dirfd: c_int, dst: [*:0]const u8, flags: c_int) c_int;
extern fn fclonefileat(srcfd: c_int, dst_dirfd: c_int, dst: [*:0]const u8, flags: c_int) c_int;

fn _cloneDir(src: [:0]const u8, srcName: [:0]const u8, dst: [:0]const u8, dstName: [:0]const u8) !void {
    var srcDir = try fs.openDirAbsoluteZ(src.ptr, .{});
    defer srcDir.close();

    var dstDir = try ensureDirAbs(dst);
    defer dstDir.close();

    if (!comptime builtin.target.isDarwin()) {
        var nextSrc = try srcDir.openDirZ(srcName.ptr, .{ .iterate = true });
        defer nextSrc.close();

        var nextDst = try ensureDirZ(dstDir, dstName);
        defer nextDst.close();

        return _copyDir(nextSrc, nextDst);
    }

    const res = clonefileat(srcDir.fd, srcName, dstDir.fd, dstName, 0);
    switch (std.posix.errno(res)) {
        .SUCCESS => return,
        .INVAL => return NodeErrors.EINVAL,
        .NOMEM => return error.SystemResources,
        .OPNOTSUPP => {
            var nextSrc = try srcDir.openDirZ(srcName, .{ .iterate = true });
            defer nextSrc.close();

            var nextDst = try ensureDirZ(dstDir, dstName);
            defer nextDst.close();

            return _copyDir(nextSrc, nextDst);
        },
        .NOENT => return NodeErrors.ENOENT,
        .EXIST => return NodeErrors.EEXIST,
        else => |err| {
            // std.debug.print("unexpected errno: {s} {d}\n", .{ @tagName(err), @intFromEnum(err) });

            return std.posix.unexpectedErrno(err);
        },
    }
}

// std.debug.print("enoent: {s} {d} {s} {d}\n", .{ srcName, srcName.len, srcName, srcName[srcName.len] })
fn _copyDir(srcDir: fs.Dir, dstDir: fs.Dir) !void {
    var it = srcDir.iterate();
    while (try it.next()) |entry| {
        switch (entry.kind) {
            .directory => {
                var nextSrc = try srcDir.openDir(entry.name, .{ .iterate = true });
                defer nextSrc.close();

                var nextDst = try ensureDir(dstDir, entry.name);
                defer nextDst.close();

                try _copyDir(nextSrc, nextDst);
            },
            .file => {
                    var in_file = try srcDir.openFile(entry.name, .{});
                    defer in_file.close();

                    const st = try in_file.stat();
                    const size = st.size;
                    const mode = st.mode;

                    var out_file = try dstDir.createFile(entry.name, .{ .mode = mode });
                    defer out_file.close();

                    // var atomic_file = try dstDir.atomicFile(entry.name, .{ .mode = mode });
                    // defer atomic_file.deinit();

                    // try copy_file(in_file.handle, atomic_file.file.handle, size);
                    // try atomic_file.finish();

                    try copy_file(in_file.handle, out_file.handle, size);
            },
            else => {},
        }
    }
}

// const w = std.os.windows;
// const LPCSTR = w.LPCSTR;
// const LPSECURITY_ATTRIBUTES = opaque {};

// // The maximum number of hard links that can be created with this function is 1023 per file. If more than 1023 links are created for a file, an error results.
// // If you pass a name longer than MAX_PATH characters to the lpFileName or lpExistingFileName parameter of the ANSI version of this function or to the Unicode version of this function without prepending "\\?\" to the path, the function returns ERROR_PATH_NOT_FOUND.

// extern "kernel32" fn CreateHardLinkA(lpFileName: LPCSTR, lpExistingFileName: LPCSTR, lpSecurityAttributes: ?*LPSECURITY_ATTRIBUTES) callconv(w.WINAPI) bool;

// fn _copyDirHardLink(srcDir: fs.Dir, dstDir: fs.Dir, srcDirName: [:0]const u8, dstDirName: [:0]const u8) !void {
//     var it = srcDir.iterate();

//     // This isn't correct. We're using UTF-8 encoded strings
//     var buf1: [w.PATH_MAX_WIDE]u8 = undefined;
//     var buf2: [w.PATH_MAX_WIDE]u8 = undefined;

//     while (try it.next()) |entry| {
//         switch (entry.kind) {
//             .directory => {
//                 var nextSrc = try srcDir.openDir(entry.name, .{ .iterate = true });
//                 defer nextSrc.close();

//                 var nextDst = try ensureDir(dstDir, entry.name);
//                 defer nextDst.close();

//                 const nextSrcName = try std.fmt.bufPrintZ(&buf1, "{s}\\{s}", .{ srcDirName, entry.name });
//                 const nextDstName = try std.fmt.bufPrintZ(&buf2, "{s}\\{s}", .{ dstDirName, entry.name });

//                 try _copyDirHardLink(nextSrc, nextDst, nextSrcName, nextDstName);
//             },
//             .file => {
//                     const srcFile = try std.fmt.bufPrintZ(&buf1, "\\\\?\\{s}\\{s}", .{ srcDirName, entry.name });
//                     const dstFile = try std.fmt.bufPrintZ(&buf2, "\\\\?\\{s}\\{s}", .{ dstDirName, entry.name });

//                     const success = CreateHardLinkA(dstFile, srcFile, null);
//                     if (!success) {
//                         const err = w.kernel32.GetLastError();
//                         switch (err) {
//                             .SUCCESS => {},
//                             else => return error.Unsupported,
//                         }
//                     }
//             },
//             else => {},
//         }
//     }
// }

// $(xcrun --show-sdk-path)/usr/include/removefile.h
//
// https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/removefile.3.html
// https://keith.github.io/xcode-man-pages/removefile.3.html

extern fn removefileat(dirfd: c_int, path: [*:0]const u8, state: ?*anyopaque, flags: c_int) c_int;

const REMOVEFILE_RECURSIVE = 1 << 0;

fn _removeDir(parent: [:0]const u8, path: [:0]const u8) !void {
    var parentDir = try fs.openDirAbsoluteZ(parent.ptr, .{});
    defer parentDir.close();

    if (!comptime builtin.target.isDarwin()) {
        return parentDir.deleteDirZ(path.ptr);
    }

    const res = removefileat(parentDir.fd, path, null, REMOVEFILE_RECURSIVE);
    return switch (std.posix.errno(res)) {
        .SUCCESS => {},
        .INVAL => NodeErrors.EINVAL,
        .NOMEM => error.SystemResources,
        .OPNOTSUPP => parentDir.deleteDirZ(path),
        .NOENT => NodeErrors.ENOENT,
        else => |err| std.posix.unexpectedErrno(err),
    };
}
 
comptime {
    js.registerModule(@This());
}
