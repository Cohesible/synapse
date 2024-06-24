## Overview

In Synapse, a "resource" is anything with a lifecycle that is _outside_ runtime execution. Resources are created/updated/deleted apart of the deploy operation. The _state_ of the resource is what becomes visible to your program at runtime.

### Defining Resources

The `defineResource` function from `synapse:core` creates a new resource class using a set of lifecycle functions.

* `create` (required)
    - Called whenever a new resource is created. The arguments are whatever was passed to the class constructor. The returned value becomes the resource state.

* `update` (optional)
    - Called when the resource parameters change. The first argument is the _current_ resource state. The remaining args are the new parameters. Returns the updated resource state.
    - If not provided, the resource is deleted and re-created instead.

* `delete` (optional)
    - Called when the resource is being deleted. The first argument is the _current_ resource state. Returns nothing.

* `read` (optional)
    - Called when the resource needs to be "refreshed". This is only necessary when the resource state could be changed somewhere else. That is, the current state becomes out-of-sync. The first argument is the current state. Returns the updated state.

Here's a contrived example that puts things in a specific bucket:

```ts
import { defineResource } from 'synapse:core'
import { Bucket } from 'synapse:srl/storage'

const bucket = new Bucket()

class BucketObject extends defineResource({
    create: async (key: string, value: any) => {
        await bucket.put(key, value)

        return { key }
    },
    delete: async (state) => {
        await bucket.delete(state.key)
    },
}) {}

const obj = new BucketObject('foo', 'bar')

export async function main() {
    console.log(await bucket.get(obj.key, 'utf-8'))
}
```

```shell
synapse deploy
synapse run
# bar
```

### Data Sources

There are times where you might want to have something similar to a resource but without all of the statefulness. This is where "data sources" are useful. They are nothing more than functions that become apart of the deploy-time evaluation graph. We can use `defineDataSource` to create such functions.

Following the previous example:

```ts
import { defineResource, defineDataSource } from 'synapse:core'
import { Bucket } from 'synapse:srl/storage'

const bucket = new Bucket()

class BucketObject extends defineResource({
    create: async (key: string, value: any) => {
        await bucket.put(key, value)

        return { key }
    },
    delete: async (state) => {
        await bucket.delete(state.key)
    },
}) {}

const obj = new BucketObject('foo', 'bar')

const bucketData = defineDataSource(async (key: string) => {
    return bucket.get(key, 'utf-8')
})

const data = bucketData(obj.key)

export async function main() {
    console.log(data)
}
```

```shell
synapse deploy
synapse run
# bar
```

The output didn't change! So what exactly happened? 

Notice how `main` no longer depends on `bucket` at all. What we just did was move computation _outside_ of runtime, preserving only the output in the program entrypoint. If we created a bundle, there would be ***no references*** to `bucket` or `obj.key` whatsoever. 

You might be able to imagine plenty of scenarios where you want to include the result of something in the final build but not necessarily how you got that result.

### Limitations

Custom resources are still fairly limited. The goal is to remove many of these limitations over time:

* There is no mechanism to re-use other resource definitions in the lifecycle functions
    * For example, `const bucket = new Bucket()` does not work
* The returned state must be JSON serializeable. So no classes, closures, symbols, etc.
    * Fixing this is a high-priority
* When planning changes, resource state is always treated as a single unknown. This can make `synapse deploy --dry-run` report many changes that won't actually happen.

