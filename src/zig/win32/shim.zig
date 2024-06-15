// This is a minimal executable to act as a proxy for executing other 
// executable-like things on Windows. 
//
// The idea was inspired by Bun's "bunx" feature, though this implementation
// doesn't use a second file to store the target information. It's possible
// that Bun's implementation could be faster in practice depending on how
// Windows caches executable images from the filesystem.

const std = @import("std");
const windows = std.os.windows;

const PayloadType = enum(u8) {
    NativeExecutable,
    Interpretted,
};

const Payload = struct {
    payloadType: PayloadType,

    /// Absolute path to the file to be executed, utf-16le encoded
    target: [:0]u16,

    /// [optional]
    /// Absolute path to a runtime executable to start the target file, utf-16le encoded
    runtime: ?[:0]u16,
};

fn parsePayload(buf: []u8) !Payload {
    var payload: Payload = undefined;
    payload.payloadType = switch (buf[0]) {
        0 => PayloadType.NativeExecutable,
        1 => PayloadType.Interpretted,
        else => return error.UnknownPayloadType,
    };

    const rem: [*]u16 = @alignCast(@ptrCast(buf[1..].ptr));
    var end: usize = 0;
    for (0..(buf.len / 2)) |i| {
        if (rem[i] == 0) {
            end = i;
            break;
        }
    }

    if (end == 0) {
        return error.UnterminatedString;
    }

    payload.target = rem[0..end :0];
    payload.runtime = null;

    switch (payload.payloadType) {
        .NativeExecutable => {},
        .Interpretted => {
            payload.runtime = rem[(end+1)..(buf.len / 2) :0];
        },
    }

    return payload;
}


const HANDLE = windows.HANDLE;

pub fn OpenFile(sub_path_w: []const u16) !HANDLE {
    var result: HANDLE = undefined;

    const path_len_bytes: u16 = @truncate(sub_path_w.len * 2);

    var nt_name = windows.UNICODE_STRING{
        .Length = path_len_bytes,
        .MaximumLength = path_len_bytes,
        .Buffer = @constCast(sub_path_w.ptr),
    };
    var attr = windows.OBJECT_ATTRIBUTES{
        .Length = @sizeOf(windows.OBJECT_ATTRIBUTES),
        .RootDirectory = null,
        .Attributes = 0,
        .ObjectName = &nt_name,
        .SecurityDescriptor = null,
        .SecurityQualityOfService = null,
    };
    var io: windows.IO_STATUS_BLOCK = undefined;

    // If we're not following symlinks, we need to ensure we don't pass in any synchronization flags such as FILE_SYNCHRONOUS_IO_NONALERT.
    const flags: windows.ULONG = windows.FILE_SYNCHRONOUS_IO_NONALERT | windows.FILE_NON_DIRECTORY_FILE | windows.FILE_OPEN_REPARSE_POINT;

    const rc = windows.ntdll.NtCreateFile(
        &result,
        windows.GENERIC_READ | windows.SYNCHRONIZE,
        &attr,
        &io,
        null,
        windows.FILE_ATTRIBUTE_NORMAL,
        0,
        windows.FILE_OPEN,
        flags,
        null,
        0,
    );
    switch (rc) {
        .SUCCESS => return result,
        .OBJECT_NAME_INVALID => return error.BadPathName,
        .OBJECT_NAME_NOT_FOUND => return error.FileNotFound,
        .OBJECT_PATH_NOT_FOUND => return error.FileNotFound,
        .BAD_NETWORK_PATH => return error.NetworkNotFound, // \\server was not found
        .BAD_NETWORK_NAME => return error.NetworkNotFound, // \\server was found but \\server\share wasn't
        .NO_MEDIA_IN_DEVICE => return error.NoDevice,
        .INVALID_PARAMETER => unreachable,
        .SHARING_VIOLATION => return error.AccessDenied,
        .ACCESS_DENIED => return error.AccessDenied,
        .PIPE_BUSY => return error.PipeBusy,
        .OBJECT_PATH_SYNTAX_BAD => unreachable,
        .OBJECT_NAME_COLLISION => return error.PathAlreadyExists,
        .FILE_IS_A_DIRECTORY => return error.IsDir,
        .NOT_A_DIRECTORY => return error.NotDir,
        .USER_MAPPED_FILE => return error.AccessDenied,
        .INVALID_HANDLE => unreachable,

        .VIRUS_INFECTED, .VIRUS_DELETED => return error.AntivirusInterference,
        else => unreachable,
    }
}

fn dprint(v: [:0]const u16) void {
    var buf: [512]u8 = undefined;
    const size = std.unicode.utf16LeToUtf8(&buf, v) catch return;
    std.debug.print("{s}\n", .{buf[0..size]});
}

fn toExitCode(err: anyerror) u32 {
    const n: u32 = @intFromError(err);

    return n | 0x20000000; // bit 29 is reserved for application error codes
}

fn dumpErrorCodes() void {
    const ty = @typeInfo(@typeInfo(@TypeOf(exec)).Fn.return_type.?);
    const u = switch (ty) {
        .ErrorUnion => |u| u,
        else => return,
    };

    const ty2 = @typeInfo(u.error_set);

    const set = switch (ty2) {
        .ErrorSet => |s| s orelse return,
        else => return,
    };

    for (set, 0..set.len) |e, i| {
        @compileLog(0x20000000 + i + 1, e);
    }
}

// comptime {
//     dumpErrorCodes();
// }

const magic: u32 = 0x74617261;

fn readSelf(buf: []u8) !u32 {
    const teb: *std.os.windows.TEB = @call(.always_inline, std.os.windows.teb, .{});
    const peb = teb.ProcessEnvironmentBlock;
    const image_path_unicode_string = &peb.ProcessParameters.ImagePathName;
    const image_path_name = image_path_unicode_string.Buffer.?[0 .. image_path_unicode_string.Length / 2 :0];
    var prefixed: [2048]u16 = undefined;
    prefixed[0] = '\\';
    prefixed[1] = '?';
    prefixed[2] = '?';
    prefixed[3] = '\\';
    @memcpy(prefixed[4..], image_path_name);
    prefixed[image_path_name.len+4] = 0;
    const prefixed_path_w = prefixed[0..image_path_name.len+4 :0];

    const handle = try OpenFile(prefixed_path_w);
    defer windows.CloseHandle(handle);

    var bytesRead: windows.DWORD = undefined;
    const r = windows.kernel32.ReadFile(handle, buf.ptr, @truncate(buf.len), &bytesRead, null);
    if (r == 0) {
        const err = windows.kernel32.GetLastError();
        switch (err) {
            .SUCCESS => {},
            else => {
                return error.FailedRead;
            }
        }
    }

    return bytesRead;
}

fn exec() !u32 {
    var buf2: [20000]u8 = undefined;
    const bytesRead = try readSelf(&buf2);
    const footer: u32 = @bitCast((buf2[(bytesRead-4)..bytesRead][0..@sizeOf(u32)].*));
    if (footer != magic) {
        return error.InvalidFooter;
    }

    const size: u32 = @bitCast((buf2[(bytesRead-8)..bytesRead-4][0..@sizeOf(u32)].*));
    const payload = buf2[(bytesRead-(size+8))..(bytesRead-8)];
    const parsed = try parsePayload(payload);

    const cmd_line_w = windows.kernel32.GetCommandLineW();
    var proc = ChildProcess { 
        .id = undefined, 
        .thread_handle = undefined,
        .term = undefined,
    };
    if (parsed.payloadType == .NativeExecutable) {
        try spawnWindows(&proc, parsed.target, cmd_line_w, null);
        try waitUnwrappedWindows(&proc);
    } else {
        if (parsed.runtime) |rt| {
            var c: usize = 0;
            var j: usize = 0;
            var start: usize = 0;
            while (cmd_line_w[j] != 0) {
                if (cmd_line_w[j] == '"') {
                    if (c == 1) {
                        start = j + 1;
                        break;
                    } else {
                        c += 1;
                    }
                }
                j += 1;
            }

            if (start == 0) {
                return error.BadParse;
            }

            const target = parsed.target;
            var cmd_buf: [25000]u16 = undefined;
            cmd_buf[0] = '"';
            @memcpy(cmd_buf[1..], rt);
            cmd_buf[rt.len] = '"';
            const start2 = rt.len+2;
            cmd_buf[start2-1] = ' ';

            cmd_buf[start2] = '"';
            @memcpy(cmd_buf[(start2+1)..], target);
            cmd_buf[target.len+start2+1] = '"';
            
            const start3 = target.len+start2+2;

            var i: usize = 0;
            while (cmd_line_w[start+i] != 0) {
                cmd_buf[start3+i] = cmd_line_w[start+i];
                i += 1;
            }

            cmd_buf[start3+i] = 0;

            const cmd_line_w2 = cmd_buf[0..(start3+i) :0];

            try spawnWindows(&proc, rt, cmd_line_w2, null);
            try waitUnwrappedWindows(&proc);
        }
    }

    return proc.term;
}

pub fn main() noreturn {
    const code = exec() catch |e| toExitCode(e);
    windows.kernel32.ExitProcess(code);
}


fn windowsCreateProcess(app_name: [*:0]u16, cmd_line: [*:0]u16, envp_ptr: ?[*]u16, cwd_ptr: ?[*:0]u16, lpStartupInfo: *windows.STARTUPINFOW, lpProcessInformation: *windows.PROCESS_INFORMATION) !void {
    return windows.CreateProcessW(
        app_name,
        cmd_line,
        null,
        null,
        windows.TRUE,
        windows.CREATE_UNICODE_ENVIRONMENT,
        @as(?*anyopaque, @ptrCast(envp_ptr)),
        cwd_ptr,
        lpStartupInfo,
        lpProcessInformation,
    );
}

fn spawnWindows(self: *ChildProcess, app_name_w: [*:0]u16, cmd_line_w: [*:0]u16, cwd_w: ?[*:0]u16) !void {
    const g_hChildStd_IN_Rd = windows.GetStdHandle(windows.STD_INPUT_HANDLE) catch null;
    const g_hChildStd_OUT_Wr = windows.GetStdHandle(windows.STD_OUTPUT_HANDLE) catch null;
    const g_hChildStd_ERR_Wr = windows.GetStdHandle(windows.STD_ERROR_HANDLE) catch null;

    var siStartInfo = windows.STARTUPINFOW{
        .cb = @sizeOf(windows.STARTUPINFOW),
        .hStdError = g_hChildStd_ERR_Wr,
        .hStdOutput = g_hChildStd_OUT_Wr,
        .hStdInput = g_hChildStd_IN_Rd,
        .dwFlags = windows.STARTF_USESTDHANDLES,

        .lpReserved = null,
        .lpDesktop = null,
        .lpTitle = null,
        .dwX = 0,
        .dwY = 0,
        .dwXSize = 0,
        .dwYSize = 0,
        .dwXCountChars = 0,
        .dwYCountChars = 0,
        .dwFillAttribute = 0,
        .wShowWindow = 0,
        .cbReserved2 = 0,
        .lpReserved2 = null,
    };

    var piProcInfo: windows.PROCESS_INFORMATION = undefined;

    try windowsCreateProcess(app_name_w, cmd_line_w, null, cwd_w, &siStartInfo, &piProcInfo);

    self.id = piProcInfo.hProcess;
    self.thread_handle = piProcInfo.hThread;
}

const ChildProcess = struct {
    id: HANDLE,
    thread_handle: HANDLE,
    term: u32,
};

fn waitUnwrappedWindows(self: *ChildProcess) !void {
    const result = windows.WaitForSingleObjectEx(self.id, windows.INFINITE, false);

    var exit_code: windows.DWORD = undefined;
    if (windows.kernel32.GetExitCodeProcess(self.id, &exit_code) == 0) {
        return error.UnknownExit;
    } else {
        self.term = exit_code;
    }

    windows.CloseHandle(self.id);
    windows.CloseHandle(self.thread_handle);
    return result;
}
