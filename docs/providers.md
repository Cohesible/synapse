## Providers

[Terraform providers](https://registry.terraform.io/browse/providers) can be used directly with Synapse. "Official" providers can be referenced directly using their name. "Unofficial" providers must be referenced using their namespace e.g. `aliyun/alicloud`. See [this package](../test/fixtures/pm/unofficial-provider/package.json) for an example.

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
import * as aws from 'synapse-provider:aws'

const bucket = new aws.S3Bucket()
```

This will use the default provider configuration. You can manually specify provider configurations by creating a provider instance:

```ts
import { using } from 'synapse:core'
import * as aws from 'synapse-provider:aws'

const provider = new aws.AwsProvider({ region: 'us-west-2' })

const bucket = using(provider, () => {
    return new aws.S3Bucket()
})
```

The `using` function establishes a _context_ in which resources are created in. Note that multiple context "types" may exist simultaneously e.g. AWS + Azure. Synapse's `--target` option works exactly the same as the above code, the provider is just created before execution instead of during.

### Building integrations

Provider packages are a key building block for creating integrations. See the [`aws` integration](../integrations/aws) as an example.