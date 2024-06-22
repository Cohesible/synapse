# Synapse

Synapse is a toolchain for building and deploying full-stack TypeScript applications. The infrastructure that your application depends on is defined within your application itself.

Features:
* Built-in TypeScript compiler and bundler
* Incremental builds
* Extremely fast package manager
* Node.js compatible JavaScript runtime
* Cloud agnostic libraries - write once, deploy anywhere
* Deploy locally or to the cloud (only AWS at this time)
* [A testing framework](docs/testing.md)
* Novel programming paradigm - Resource-driven programming
    * Define and manage resources directly in your code
* Fine-grained permission modeling via symbolic execution

## Installation

These commands download and execute a script that will:
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

See [Quick Start](./docs/getting-started.md#quick-start) for basic instructions. 


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
