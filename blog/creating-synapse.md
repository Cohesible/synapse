# Creating Synapse: A Compiler for the Cloud

My name is Jaden. I used to work on developer tools at AWS before leaving to start my own company, Cohesible. For nearly a year I've been tackling the problem of making cloud-based applications easier to create and use. Because let's face it, developing for the cloud is rough.

## The Beginning

Where do you even start with such a complex problem? I had no clue. But I did know what kind of experience I wanted: 

> Let me easily create and use cloud resources!

For me, using the cloud just felt so... tedious. The amount of hoops you need to jump through just to put something into an S3 bucket from a Lambda function is absurd:
* Create the S3 bucket
* Write some code, ignoring portability by hardcoding the bucket name
* Figure out how Lambda expects your code to be packaged
* Package the code
* Create the Lambda function
* Navigate the AWS console (or CLI) trying to figure out how to run the code
* Figure it out, but the code fails??? Oh, it's because you need to configure _permissions_
* Fix permissions, now it works!
* Avoid having to change the code because you don't want to deal with that again

If you're using the AWS console, you get the additional pleasure of waiting on page reloads _constantly_. Everything in AWS is so scattered around that navigation alone is painful. And that's one of the simpler examples of using the cloud! Things get even more fun once you start bringing in networks, observability, and cost into the equation.

Don't get me wrong, cloud services like S3 and Lambda are _amazing_ feats of engineering. In isolation. Trying to use them together? A nightmare.

## What Came Before

I wasn't alone in my frustration. Countless tools have been created to address the problem of creating cloud resources. _Creating cloud resources_. But not so much interacting with them from your app. 

If you're okay with only sparingly using the cloud within your application, then creation is good enough. But that feels so limiting. I want to just _use_ the simplest, easiest, cheapest solution whenever possible. Sometimes that might be something "serverless", other times that might be running a fleet of dedicated hosts. I wanted a solution where making that choice was not a technical limitation.

Creating such a solution is tricky because "using resources" implies a strong coupling with the application itself Traditional infrastructure-as-code (IaC) tools that use JSON or YAML just wouldn't cut it. They're good at creating the resources, not so much using them. 

So what about newer IaC tools like CDK and Pulumi? I mean, they use programming languages right? They do, but mainly to simplify creating more sophisticated infrastructure. Pulumi's "magic functions" is close to what I was imagining. JavaScript or Python functions are serialized during deployment, automatically capturing any deployed resources along the way. I was able to put something in a bucket from a Lambda function fairly easily with this:

```ts
import * as aws from '@pulumi/aws'
import * as S3 from '@aws-sdk/client-s3'

const bucket = new aws.s3.Bucket('my-bucket')

aws.lambda.createFunctionFromEventHandler('my-fn', async ev => {
    const client = new S3.S3()
    await client.putObject({ 
        Bucket: bucket.bucket.get(),
        Key: 'foo',
        Body: 'bar',
    })
})
```

But this solution still had problems:
* Overly broad permissions
* No way to bundle code
* Invoking the function is not obvious
* Putting something into the bucket requires more libraries
* Not obvious how to adapt to other cloud compute e.g. dedicated hosts

Magic functions is a cool feature. And I wanted a fully-realized version of it.

Tools in the IaC space tend to "go broad", offering language-agnostic solutions. This, to me, seems like a safe business strategy. But it's difficult to truly explore the problem space when spread so thin. I think this is why Pulumi's magic functions felt incomplete. For whatever I was going to build, I wanted to specialize. So I opted to go all-in on TypeScript, which is also my favorite language.

## Hacking Away

Initial implementations were rough to say the least. They "worked" in the sense that they let me create and use cloud resources. But only if you wrote the code _just right_. That's not what I wanted.

### Static analysis

My first implementations relied on static analysis. Because it felt "cleaner". Static analysis is _hard_ though. You essentially have to re-implement the language depending on how extensive your analysis is. 

Here's one of my earliest code examples:

```ts
import * as cloud from 'cloud'

const bucket = new cloud.Bucket()

export function read(key: string) {
    return bucket.get(key)
}

const fn = new cloud.Function(read)
```

My implementation would parse this code, looking for `new` calls from the `cloud` module. Identifiers like `bucket` and `fn` are marked as cloud resources which was how I could automatically figure out what needed to be deployed.

This analysis was brittle. What if the bucket was created within a function instead? Broken. What if `read` was created by a factory function? Broken. What if we wanted to _conditionally_ create a resource? Broken.

But here's the thing: I was already executing the user's code in order to "compile" it. This was because I was using the CDK for Terraform which executes JavaScript to produce configuration files. There were other ways to make this work.

### Going dynamic

Focus shifted from doing most of the work statically to doing most of the work dynamically. Static analysis became a mechanism to prepare the code for execution. An intermediate step. The prep work allowed me to do things such as solving permissions and function serialization by executing code.

This was a game changer. My first few implementations felt dead. Rigid. _Static_. Many things just weren't possible. But now, most things simply work. It feels alive. When I wrote some code to instrument serverless functions was when I thought "this is real now":

```ts
export class LambdaFunction<T extends any[] = any[], U = unknown> {
    public constructor(target: (...args: T) => Promise<U> | U) {
        const entrypoint = new Bundle(instrument(target))

        // ... creating IAM roles, uploading to S3, creating the Lambda function, etc.
    }
}

const logger = getCustomLogger()

function instrument<T, U extends any[]>(fn: (...args: U) => T): (...args: U) => Promise<T> {
    return async (...args) => {
        try {
            return await fn(...args)
        } catch (err) {
            logger.error(err)

            throw err
        }
    }
}
```

Imagine for a moment that `logger` was some sort of logging service created using Synapse. That's what I had done. I was able to create my own service and feed it back into the code. Of course, I didn't want to automatically instrument everyone's code by default, and so the logger no longer exists. But it _could_ exist, and I think that's amazing.

## Building a Foundation

Abstraction is a tricky topic. Too much and you severely limit possible use-cases. Too little and you're basically doing nothing at all. In either case, you're probably getting in people's way. 

So how do you go about trying to abstract something as complex as cloud computing? In layers, of course! There is no single abstraction that is "just right" for the cloud. But what you can do is create many "just right" abstractions that build off each other. 

### Layer 0 - Defining Resources (CRUD)

Before doing _anything_ with a resource, we need to know how to create, read, update, and delete them. The Terraform ecosystem has already done much of the work for us here. No need to re-invent the wheel. Of course, Synapse does allow hooking into this layer in a convenient way. There isn't always a Terraform provider for every possible use-case.

### Layer 1 - Configuration

Now we get to create/configure resources. This is where most IaC tools live today. Synapse uses a lightweight mechanism to generate bindings directly from Terraform providers.

```ts
import * as aws from 'terraform-provider:aws'

const bucket = new aws.S3Bucket({ forceDestroy: false })
```

### Layer 2 - Interaction Models

Here's where it gets interesting: we get to _use_ what we create! We don't necessarily abstract away cloud provider specific peculiarities here. The goal is to plumb through API calls as well as model permissions/networking. This layer is still very unpolished and often hides too much for the sake of simplicity:

```ts
import * as aws from 'terraform-provider:aws'
import * as S3 from '@aws-sdk/client-s3'

type Encoding = 'utf-8' | 'base64' | 'base64url' | 'hex'

export class Bucket {
    private readonly client = new S3.S3({})
    public readonly resource: aws.S3Bucket
    public readonly name: string
    public readonly id: string

    public constructor() {
        this.resource = new aws.S3Bucket({ forceDestroy: false })
        this.id = this.resource.arn
        this.name = this.resource.bucket
    }

    public async get(key: string): Promise<Uint8Array>
    public async get(key: string, encoding: Encoding): Promise<string>
    public async get(key: string, encoding?: Encoding): Promise<Uint8Array | string> {
        const resp = await this.client.getObject({ Bucket: this.name, Key: key })
        const bytes = await resp.Body!.transformToByteArray()

        return !encoding ? bytes : Buffer.from(bytes).toString(encoding)
    }

    public async put(key: string, blob: string | Uint8Array): Promise<void> {
        await this.client.putObject({ Bucket: this.name, Key: key, Body: blob })
    }
}
```

### Layer 3 - Standard Resources

Now we distill the core functionality offered by cloud providers into a standard set of interfaces. An implementation in layer 2 is used for a given interface based on whatever cloud target is needed.

```ts
// Simplified class from `synapse:srl/storage`

export declare class Bucket {
    get(key: string): Promise<Uint8Array>
    get(key: string, encoding: Encoding): Promise<string>
    put(key: string, blob: string | Uint8Array): Promise<void>
}
```


### Extensible Layers

A major goal with Synapse is to allow for rich customization without sacrificing the power that abstractions offer. The layers are designed in such a way that they all effectively exist as user code. In other words, they are _not_ baked into the compiler. Even the very first layer can be extended directly:

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

One thing to point out here is how _fluid_ the layers are. We're able to take an abstract `Bucket` and define an entirely new resource using it. `BucketObject` works the same whether `bucket` uses AWS or Azure!

## Hello, world!

Finally, we get to the culmination of all my work: a "Hello, world!" program. I like using this example because it does what I originally set out to achieve so succinctly:
* Creates cloud resources
* Allows you to quickly use what you just created
* Automatically sets the minimum required permissions

```ts
import { Bucket } from 'synapse:srl/storage'
import { Function } from 'synapse:srl/compute'

const bucket = new Bucket()

const fn = new Function(async () => {
    await bucket.put('hello.txt', 'hello, world!')
})

export async function main() {
    await fn()
    const data = await bucket.get('hello.txt', 'utf-8')
    console.log(data)
}
```

In just two commands, you've deployed to AWS, invoked the function, and grabbed data from the bucket:
```shell
synapse deploy --target aws
synapse run
# hello, world! 
```

## The Future

Synapse is still woefully incomplete. It can only deploy to AWS. Some code still fails to compile. But that's okay. Because it will improve. Because, unlike a year ago, I now have a much clearer idea for what needs to be done. 

Thank you for taking the time to read this! If anyone has questions or would like more detailed technical explanations, I'd be happy to share! I tried to keep things somewhat digestible by not covering all the challenges and capabilities of Synapse.
