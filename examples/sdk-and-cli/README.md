## SDK + CLI

This example shows how you can use Synapse to:
* Configure and deploy backend infrastructure
* Create an "SDK" for that infrastructure
* Build a CLI tool that uses the SDK

Because our client-side code doesn't use anything specific to `node`, the SDK would work in a browser too!

### Project Structure

We've split up the code into two packages:
* `cli` - Feeds input from the command line into the client from `sdk`
* `sdk` - Creates a bucket + public service to use the bucket. We export a function to create our client.

Note that all of this code can be placed into a single package instead. This may be preferred for small projects.

### Building

First navigate to `sdk` and run the following:

```shell
synapse deploy
synapse publish --local
```

This will deploy the necessary infrastructure + expose our `createClient` function.

Now navigate to `cli`. Because `main.ts` doesn't specify any infrastructure, we can immediately try things out:

```shell
synapse run -- put foo bar
# Put object foo
synapse run -- get foo
# bar
```

We can also use `synapse build` to create a standalone executable:

```shell
synapse build
./out/bin/cli get foo # or cli.exe on Windows
```

Or if we just want an executable JavaScript bundle:

```shell
synapse build --no-sea
./out/main.js get foo # or `[synapse|node|bun|deno] ./out/main.js get foo` on Windows
```

