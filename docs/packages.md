## Overview

A "package" is a collection of code that is meant to be shared. Packages allow you to build and/or deploy software without knowing exactly how other packages are implemented.

### `package.json`

Synapse follows in the footsteps of `npm`, and so it uses `package.json` to determine which directories are packages. [The documentation from `npm`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json) also applies to Synapse except for the following fields:
* `files` *
* `directories`
* `man`
* `config`
* `publishConfig`
* `overrides` *
* `scripts` **
* `bundleDependencies`

Legend:
- \* Under consideration
- ** Partial support

Package `scripts` can be executed with `synapse run` but are otherwise ignored. This includes "install" scripts, which means packages that rely on building from source on install do not work yet.

### Publishing

Publishing packages is currently limited to the following destinations:

* A local repository via `synapse publish --local`
* An archive using `synapse publish --archive <name>`

Support for publishing directly to `npm` is planned in addition to a repository specifically for Synapse.

### "Deployed" Packages

Code produced by Synapse can be shared _after_ running `synapse deploy`. The shared code is no longer 1:1 with the source code but rather a reduced form of it.

A good example of this is an SDK for an API. See [this directory](../examples/sdk-and-cli/) for a mini project that creates an SDK + CLI tool.

### Best Practices

It is ***incredibly important*** to understand that "deployed" packages are _not_ always isolated from changes you make to the original package. This is because the package might reference resources that you can change.

***If you were to run `synapse destroy`, all consumers of the package might immediately break if you delete referenced resources!***

Fortunately, Synapse has safeguards to prevent someone from accidentally doing this. But we still need solutions for stopping more subtle problems.

#### Environments

[Environments](./environments.md) are a great way to test changes in isolation. Future improvements will make packages more "environment-aware".

<!-- #### Pipelines (Experimental)

The potentially high-stakes involved with changing deployed packages often warrants more sophisticated automation. 

Pipelines are a form of automation that splits things up into stages connected in sequence. Changes are only moved ("promoted") to the next changes after passing an arbitrary set of checks (tests, manual approval, etc.).

This setup means you can test changes in total isolation before sending them out to the world.  -->

#### Rollbacks (Experimental)

A deployment can be changed back to its previous configuration through several mechanisms:

* Manually with `synapse rollback`
* When tests fails via `synapse test --rollback-if-failed`
* When deploying fails via `synapse deploy --rollback-if-failed`

Rollbacks are best-effort. Their success (or failure) is dependent on which resources were changed. In particular, resources that cause side-effects are less likely to be safely rolled back. 

#### Immutable Deployments (Planned)

Many resources, particularly stateless ones, do not need to be updated in-place. Instead, each deploy operation can create a new resource with the changes and swap out the references. 

This ensures that existing code behaves _exactly_ the same, bugs and all. The downside is that there are, more often than not, practical limitations to constantly creating new resources. But we believe these can be addressed over time.

