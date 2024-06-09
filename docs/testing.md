## Creating Tests

Tests can be created using functions from the `synapse:test` module; Synapse _does not_ require you to create a separate file for tests (but you can if you wish). The interfaces are similar to existing test frameworks e.g. Mocha, Jest, etc. in that you can create individual tests as well as suites of tests.

For example:
```ts
import { describe, it } from 'synapse:test'

describe('a test suite', () => {
    it('runs a test', () => {
        console.log('hi')
    })
})
```
Creates a test suite named "a test suite" and a test within that suite called "runs a test", following the BDD-style of naming.

You can also create tests outside of a suite:
```ts
import { test, it } from 'synapse:test'

test('console.log("hi")', () => {
    console.log("hi")
})
```

Note that `it` is an alias for `test`. Both can be used interchangeably.

## Running tests

Use the command `synapse test` to run all tests. You can provide specific filenames to only run tests in those files as well.

Note that tests are considered a "resource" (albeit a local one). That means a "deploy" operation is required to create/update tests. This happens automatically when you run `synapse test`. Any resources that your tests depend on could be updated which might not be wanted. A future release may include ways to control this behavior. 

## Assertion functions

`synapse:test` exports a few basic functions for making comparisons (equivalents are from `node:assert`):
* `expect` - truthy check, equivalent to `ok`
* `expectEqual` - deep comparison, equivalent to `assertDeepStrictEqual`
* `expectReferenceEqual` - shallow comparison, equivalent to `assertStrictEqual`

One thing that should stand out is the swapping of deep equal and shallow equal. This was done because structural equality is far more useful and common for distributed systems.

## Using other testing frameworks

Other frameworks have not been tested, however, it might be possible to use existing frameworks with varying degrees of functionality. 

In general, mocking and assertion utilities should be compatible.
