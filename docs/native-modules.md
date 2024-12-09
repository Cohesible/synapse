## Overview

Native modules are any non-JavaScript code that is callable from within JavaScript. This is sometimes done because:
* Direct access to syscalls is needed
* Code re-use (many libraries are written in C/C++)
* Well-crafted code in a systems language will generally be more performant than JavaScript

Synapse has first-class support for native modules using the [Zig](https://ziglang.org/) programming language. The integration currently requires pinning to a specific Zig version (0.13.0), which is automatically downloaded as-needed.

**`allowArbitraryExtensions` must be enabled in `tsconfig.json` to use native modules.** This requirement may be removed in a future release. Here's a minimal `tsconfig.json` file for reference:
```json
{
    "compilerOptions": {
        "allowArbitraryExtensions": true
    }
}
```

`*.d.zig.ts` files are automatically generated for imported Zig modules. Adding this pattern to `.gitignore` is recommended.

## Basic usage

When working with many primitive types, things "just work". Simply treat Zig files as-if they were any other module, making sure to import them with the `.zig` suffix:

```main.ts
import { add } from './add.zig'

export function main() {
    console.log(add(2, 2))
}
```

```add.zig
pub fn add(a: u32, b: u32) u32 {
    return a + b;
}
```

## The `js` module

Many things we take for granted in JavaScript (Promises, strings, arrays) do not translate so easily to Zig. The `js` module is shipped with Synapse and provides APIs for working with the JavaScript runtime.


### Strings

Modern JavaScript engines (V8, JSC, etc.) have various optimizations for strings that make it difficult to use them directly from native code. We can simplify things by copying the string into an owned-buffer with `js.UTF8String`:

```fs.zig
const js = @import("js");
const std = @import("std");

pub fn openSync(src: js.UTF8String) !i32 {
    const file = try std.fs.openFileAbsolute(src.data, .{});

    return .{ file.fd };
}
```

```main.ts
import { openSync } from './fs.zig'

export function main() {
    console.log(openSync('fs.zig'))
}
```

Parameters typed as `[:0]u8` are also treated as strings.

### Promises

We can declare an exported function as "async" by returning a `js.Promise`:

```add.zig
const js = @import("js");

pub fn addAsync(a: u32, b: u32) js.Promise(u32) {
    return .{ a + b };
}
```

```main.ts
import { addAsync } from './add.zig'

export function main() {
    console.log(await add(2, 2))
}
```

Note that `js.Promise` changes how the Zig function is called from JavaScript by running the function in a thread pool. Zig functions calling Zig functions that return `js.Promise` will appear synchronous.

### Errors

Errors returned by a Zig function are bubbled up to the JS side largely as-is:

```error.zig
pub fn fail() !void {
    return error.Failed;
}
```

```main.ts
import { fail } from './error.zig'

export function main() {
    try {
        fail()
    } catch (e) {
        console.log(e)
    }
}
```

This will show `[Error: Native error] { code: 'Failed' }`. Stack traces will be added soon.


### Structs

Structs passed to or returned from native modules are automatically converted to/from JS objects for convenience. This can be opted-out of by using `*js.Object` instead of the struct type.

