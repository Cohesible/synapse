## Quick Start

### Hello, world!
Let's create a "hello, world!" program with a twist: the message might come from a _different_ process (like inside an AWS Lambda function) than the one printing it out.

You can run `synapse init` in an empty directory to start or just copy-paste the below code into a `.ts` file:

```ts
import { Function } from 'synapse:srl/compute'

const hello = new Function(() => {
    return { message: 'hello, world!' }
})

export async function main(...args: string[]) {
    console.log(await hello())
}
```

For quick testing, this can be deployed to the "local" target (no cloud required):
```shell
synapse deploy --target local
```

And now we can execute our program:
```shell
synapse run
# { message: 'hello, world!' }
```

### Cleanup
Synapse applications continue to exist until we explicitly delete them. This can be done with the `destroy` command:

```shell
synapse destroy
```

### Getting real

Local deployments are nice and all, but what if you want something a little more scalable? Assuming you have valid credentials (this is dependent on your cloud provider), then moving to the cloud is as simple as changing the target: 

```shell
synapse deploy --target aws
```

Everything else still works the same. We can run our program just like before:

```shell
synapse run
```

## Important Commands

### `deploy`
Applies your code to the current target, creating or updating a deployment as-needed.

#### Targets
The default target is your current machine i.e. the "local" target. You can change the destination using the `--target` option like so:

```shell
synapse deploy --target aws
```

Currently, this always uses the default credentials configured for a given cloud target. 

Subsequent deployments for the same program use the currently deployed target. You must teardown the existing deployment before you can change the target.

#### Dry-runs
You can view the changes Synapse will make without applying them by providing the `--dry-run` flag:

```shell
synapse deploy --dry-run
```

These changes always represnt the "worst-case" scenario. Some changes may not be required, however, it's not always possible to know that ahead of time.

#### Deploy UI
The deploy view uses the following colors/characters to represent different actions:
* `+` (green) - create
* `-` (red) - delete
* `~` (blue) - update
* `±` (yellow) - replace

Only "top-level" names are displayed in this view. For example:

```ts
function createBucketClosure() {
    const bucket = new Bucket()

    return new Function(async (key: string) => bucket.get(key))
}

const myFn = createBucketClosure()
```

Will only show `myFn` and not `bucket`.

### `destroy`
Deletes all resources in the current deployment, if any. 

This command does not complete until all resources in a deployment are either deleted or were attempted to delete.

Any failures are reported on completion, which may require manual intervention to fix. `destroy` can be ran again after fixing any issues.

### `run`
Runs an "executable" in the current application.

Executables are any TypeScript file that exports a "main" function:

```main.ts
export function main() {
    console.log('hello, world!')
}
```

```shell
synapse run main.ts
# hello, world!
```

You can omit the file if it's unambiguous e.g. there's only 1 executable file:

```shell
synapse run
# hello, world!
```

Arguments can be passed using the `--` switch:
```main.ts
export function main(name: string) {
    console.log('hello, ${name}!')
}
```

```shell
synapse run -- alice
# hello, alice!
```

### `quote`

Prints a motivational quote fetched from a public Synapse application.

## Other Commands
These commands expose lower-level functionality that you might find useful.

### `clean`

Deletes all cached data for the current application.

The best cache is one you don't know about, but sometimes things break! If you're running into obscure errors and nothing seems to be working, run `synapse clean` before trying again.

If that fixes your problem, it would be **incredibly helpful** to open an issue with the following information:
* The error/problem you were seeing
* Any details/specifics about the code you're working on that you're comfortable with sharing (exact source code is best)
* Commands you ran before seeing the issue (it's ok if you don't know exactly)


Caching bugs are frustrating to experience, so these issues are given a high priority.

Note that the package cache is _not_ cleaned by default. Use the following to clear the package cache as well:
```shell
synapse clean --packages
```

### `emit`

Writes out the current build artifacts to disk. 

By default, this will write to `outDir` from `tsconfig.json` if found, otherwise `./out`. You can change the destination using the `--outDir` option:

```shell
synapse emit --outDir dist
```

