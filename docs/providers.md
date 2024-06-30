## Providers

[Terraform providers](https://registry.terraform.io/browse/providers) can be used directly with Synapse. **This only works with "Official" providers at the moment.**

### Adding a provider

Providers can be installed by adding the name to the `synapse` section of your `package.json`:

```package.json
{
  "synapse": {
    "providers": {
      "aws": "*"
    }
  }
}
```

Then run `synapse install`. This will generate a module called `synapse-provider:<name>` that you can use like so:

```ts
import { using } from 'synapse:core'
import * as aws from 'synapse-provider:aws'

const provider = new aws.AwsProvider()

using(provider, () => {
    const bucket = new aws.S3Bucket()
})
```

The `using` function establishes a _context_ in which resources are created in. There is no "default" provider context currently so this is required. Note that multiple context "types" may exist simultaneously e.g. AWS + Azure.

Providers simply use the latest version available. Eventually, you will be able to use providers as normal package dependencies.

### Building integrations

Provider packages are a key building block for creating integrations. See the [`aws` integration](../integrations/aws) as an example.