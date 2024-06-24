## Overview

Environments allow you create multiple deployments from the same code. These deployments are _isolated_ from one another, meaning you can test your changes in a safe way before shipping them out. 

### Switching Environments

The environment variable `SYNAPSE_ENV` is used to switch environments. For example, I might enter the `beta` environment like so:

```shell
export SYNAPSE_ENV=beta
synapse status
# env: beta
```

Environment names are not special with two exceptions:
* `local` is the default environment. Deployments created in this environment are assumed to be isolated to a single user/machine. 
* Names that contain the word `production` are automatically considered a production enviroment. Production environments have additional safeguards in place:
    * Prevents replacement of stateful resources whenever possible
    * `synapse destroy` requires a confirmation

### Configuration

In theory, environments should be _exact_ copies of one another. In practice, this often isn't the case. 

The current support for per-environment configuration is limited to `.env` files. Synapse automatically reads environment variables from a `.env.${envName}` file in the working directory. For example, `.env.beta` would be used when `SYNAPSE_ENV` is set to `beta`. You can then write code that uses `process.env` to change configuration.

Here are some common scenarios where you might want to tweak things slightly per-environment:
* Cost optimization e.g. smaller host machines in developer/test environments, less frequent backups, etc.
* Enabling debug options/tools in non-prod, disabling them in prod
* External dependencies like API keys or DB urls
  * These _should_ be converted to [resources](./custom-resources.md) whenever possible

In general, the differences between non-prod and prod should be _subtractive_. That is, prod potentially executes _less_ code than non-prod, never more. The code would never be tested otherwise!





