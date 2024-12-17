## Prerequisites
You'll need the latest version of Synapse installed

## Synapse CLI
The bulk of Synapse lives in `src`. Use `synapse compile` in the root of the repository to build. There is a fast and slow way to test your changes. The fast way requires a little bit of setup but results in quicker iterations. The slow way creates an executable which is most similar to the release build of Synapse.

### Slow Way

Run `synapse compile` + `synapse build`. The executable will be placed in `dist/bin` e.g. `dist/bin/synapse` for Linux/macOS and `dist/bin/synapse.exe` for Windows.

### Fast Way

This is currently unreliable. Use the slow way for now.

<!-- 

TODO: the dev loader needs to setup the VFS from the import map

First setup this bash script:

```bash
#/usr/bin/env bash
set -e
export SYNAPSE_USE_DEV_LOADER="1"
PACKAGE_NAME=$(ls -t $SYNAPSE_INSTALL/cache/packages/linked | grep 'synapse-.*-.*-' | head -n 1)
exec synapse "$SYNAPSE_INSTALL/cache/packages/linked/$PACKAGE_NAME/dist/src/cli/index.js" "$@"
```

I like to place it in `$SYNAPSE_INSTALL/app/bin/syn`. Make sure to `chmod +x <script>`!

Now instead of `synapse compile`, run `synapse compile && synapse publish --local` after every change. Use the script instead of `synapse` to test your changes.

Note that you _should_ be able to build Synapse with the script, however, if you run into issues you might have to build without comptime evaluation first:

```bash
<dev-cmd> compile --no-synth && <dev-cmd> publish --local
```

-->

## Integrations (aka compiler backends)

Synapse uses a plugin-like architecture for loading deployment target implementations. Packages can contribute implementations by using the `addTarget` function from `synapse:core`. See [this file](../integrations/local/src/function.ts) for a reasonably simple example.

Integrations are packages within this repository found under the `integrations` directory. The directory name matches the target e.g. `integrations/local` for `synapse compile --target local`. Future improvments may allow for substituting these built-in references.

### Building and Testing

Each integration is built with `synapse compile`. Use `synapse publish --local` to use the locally built package for future compilations.

Currently there are no integration-specific tests. Integrations are validated against `synapse:srl/*` by running the [conformance suite](../test/conformance). You can build and run this suite by running the following from the repository root:

```shell
cd test/conformance && synapse compile && synapse test
```

This will use the `local` target by default. You can change the target by adding it to `synapse compile`:

```shell
cd test/conformance && synapse compile --target aws && synapse test
```

## Documentation

### Commands

Output from `synapse help` is generated from command declarations [here](../src/cli/commands.ts).

The easiest way to find the command you want to edit is to search for the command name in single quotes e.g. `'compile'`.

### Everything else

All other documentation is hand-written and lives in the [docs](../docs) directory. These files will eventually be used as content for a documentation site.

## The `packages` directory

The tarballs in this directory contain services (or rather, service stubs) that may eventually be used in either Synapse directly, or possibly a separate CLI entirely. These are currently closed-source for two main reasons:

1. It's difficult to open-source _live_ services (but Synapse _will_ make it easier!)
2. They may become apart of a strategy to help fund the development of Synapse

Right now only "quotes" does anything. The rest are stubs and will fail if used. 