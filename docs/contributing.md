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

