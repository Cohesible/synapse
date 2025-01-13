## Workflows

A "workflow" is a kind of durable code execution. You can imagine it as a series of "checkpoints" that you only want to successfully execute once for a given job, regardless of any subsequent failures.

Synapse has an **experimental** workflows API that is not vended apart of the main CLI.

The API takes inspiration from [Temporal](https://temporal.io/) but compatibility is a non-goal.

The biggest difference between Temporal and this API is that the Synapse-based API relies entirely on your infrastructure. There is no hosted service. 

### Usage

The API package needs to be built and published on your machine:

```shell
(cd sdk && synapse compile && synapse publish --local)
```

See [this simple example](./simple/main.ts) to try it out.

