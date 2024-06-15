// ref: https://github.com/nodejs/node-gyp/blob/af876e10f01ea8e3fdfeee20dbee3f7138ccffd5/src/win_delay_load_hook.cc
// This file won't be useful until Zig has an equivalent to the MSVC `/delayload` switch

const std = @import("std");
const DWORD = std.os.windows.DWORD;
const FARPROC = std.os.windows.FARPROC;
const HMODULE = std.os.windows.HMODULE;
const LPCSTR = std.os.windows.LPCSTR;
const WINAPI = std.os.windows.WINAPI;
const eql = std.mem.eql;


const Event = enum(c_uint) {
    dliStartProcessing,             // used to bypass or note helper only
    dliNotePreLoadLibrary,          // called just before LoadLibrary, can
                                    //  override w/ new HMODULE return val
    dliNotePreGetProcAddress,       // called just before GetProcAddress, can
                                    //  override w/ new FARPROC return value
    dliFailLoadLib,                 // failed to load library, fix it by
                                    //  returning a valid HMODULE
    dliFailGetProc,                 // failed to get proc address, fix it by
                                    //  returning a valid FARPROC
    dliNoteEndProcessing,           // called after all processing is done, no
                                    //  bypass possible at this point except
                                    //  by longjmp()/throw()/RaiseException.
};



const ImgDelayDescr = opaque {};
const DelayLoadProc = struct {
    fImportByName: bool,
    data: union {
        szProcName: LPCSTR,
        dwOrdinal: DWORD,
    },
};

const DelayLoadInfo = struct {
    cb: DWORD,                  // size of structure
    pidd: *ImgDelayDescr,       // raw form of data (everything is there)
    ppfn: *FARPROC,             // points to address of function to load
    szDll: LPCSTR,              // name of dll
    dlp: DelayLoadProc,         // name or ordinal of procedure
    hmodCur: HMODULE,           // the hInstance of the library we have loaded
    pfnCur: FARPROC,            // the actual function that will be called
    dwLastError: DWORD,         // error received (if an error notification)
};


extern "kernel32" fn GetModuleHandleA(lpModuleName: ?LPCSTR) callconv(WINAPI) ?HMODULE;

export fn __pfnDliNotifyHook2(dliNotify: Event, pdli: *DelayLoadInfo) callconv(WINAPI) ?FARPROC {
    if (dliNotify != .dliNotePreLoadLibrary) {
        return null;
    }

    std.debug.print("{s}\n", .{pdli.szDll});

    if (!eql(u8, std.mem.sliceTo(pdli.szDll, 0), "node.exe")) {
        return null;
    }

    const h = GetModuleHandleA(null);

    return @ptrCast(h);
}
