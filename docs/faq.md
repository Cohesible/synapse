## I don't need to deploy to the cloud, can Synapse still help me?
Yes! The technology behind Synapse can be used for far more than just cloud infrastructure. 

You can think of Synapse as a build system that is also apart of your application (but only at build time!). This allows for all sorts of things:
* Bundling closures
* Automatically downloading/building/generating dependencies
* Dead-code elimination (more than ES module tree-shaking)
* Customizeable builds similar to C's `#if` directive

And many more things that haven't been released yet!

## Where's the code?
Currently in a private repository. Synapse is built with Synapse, meaning there's _a lot_ of code that uses experimental/unpolished/undocumented features.

We want a relatively smooth contributor experience, not a free-for-all. So open sourcing will happen gradually, starting with the "cloud integration" packages. This will allow people to contribute implementations for different cloud providers.
