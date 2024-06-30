<h1 align="center">Synapse</h1>
<p align="center">
    <a href="https://github.com/Cohesible/synapse/blob/main/.github/workflows/build-synapse.yml">
        <img alt="Build Status" src="https://img.shields.io/github/actions/workflow/status/Cohesible/synapse/build-synapse.yml" >
    </a>
    <a href="https://discord.gg/QkvgrmkAdE" target="_blank">
        <img height=20 src="https://img.shields.io/discord/1254172766849073202" />
    </a>
</p>

Synapse is a toolchain for building and deploying TypeScript applications, from CLI tools to full-stack apps. Your application's infrastructure is defined within the application itself.

Features:
* Multi-stage programming - run code at build time
* Cloud agnostic libraries - write once, deploy anywhere, including locally
* Automatic permissions solver - least privilege permissions via symbol execution
* Native modules - write modules using Zig with automatic TypeScript bindings (coming soon)
* Everything you need, built-in
    * TypeScript compiler and bundler
    * Incremental builds (distributed caching coming soon)
    * Extremely fast package manager
    * Node.js compatible JavaScript runtime
    * [A testing framework](docs/testing.md)

```main.ts
import { Bucket } from 'synapse:srl/storage'

const bucket = new Bucket()

export async function main() {
    await bucket.put('hello', 'world!')
    console.log(await bucket.get('hello', 'utf-8'))
}
```

## How it works

One way to think about Synapse is to imagine a "metaprogram" that controls _what_ code is executed and _where_ it is executed. Synapse enables you to write code describing this metaprogram within traditional code. 

The basic idea is that your code is executed at build time to generate instructions for your metaprogram. An instruction is best thought of as an individual goal state. For example, writing `new Bucket()` describes an instruction that creates a bucket if it does not already exist. Most instructions exist as configuration for resources. The remaining instructions are purely computational.

A "resource" is essentially anything that can be configured and persisted at build time. The idea of resources is deeply integrated into Synapse, meaning you can find them in many places:
* Classes exported by `synapse:srl/*` modules
* [Generated "provider"](docs/providers.md) classes
* User-defined [custom resources](docs/custom-resources.md)
* Utility functions/classes in `synapse:lib` (most notably, `Bundle`)

`synapse deploy` executes (or applies) your metaprogram, creating or updating a deployment. Deployments are the side-effects of instructions and their resulting state. Note that resources are effectively "frozen" outside of `synapse deploy`. Trying to create/update resources at runtime using Synapse APIs will fail. 

## Installation

These commands download and execute [a script](src/cli/install.sh) that will:
* Download a release compatible with your system
* Extract to `~/.synapse`
* Add `synapse` to your PATH

### macOS/Linux
```shell
curl -fsSL https://synap.sh/install | bash
```

### Windows
```shell
irm https://synap.sh/install.ps1 | iex
```


## Getting Started

See [Quick Start](docs/getting-started.md#quick-start) for basic instructions. 

For help with specific features:
* [Custom Resources](docs/custom-resources.md)
* [Environments](docs/environments.md)
* [Packages](docs/packages.md)
* [Tests](docs/testing.md)
* [Providers](docs/providers.md)

## Attributions

The core functionality of Synapse is built on top of several amazing projects:
* [TypeScript](https://github.com/microsoft/TypeScript)
* [esbuild](https://github.com/evanw/esbuild)
* [Node.js](https://github.com/nodejs/node)
* [Terraform 1.5.5](https://github.com/hashicorp/terraform/tree/v1.5.5)

And it wouldn't have been possible to create Synapse without them and their contributors!

Each cloud target also uses their respective SDK + Terraform provider. The AWS target uses:
* [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3)
* [Terraform AWS Provider](https://github.com/hashicorp/terraform-provider-aws)

A few things were also inspired by [Bun](https://github.com/oven-sh/bun). Most notably is the usage of Zig.
