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

Note that some functions are aliases and can be used interchangeably:
* `describe` <---> `suite`
* `it` <---> `test`

## Running tests

Use the command `synapse test` to run all tests. You can provide specific filenames to only run tests in those files as well.

Note that tests are considered a "resource" (albeit a local one). That means a "deploy" operation is required to create/update tests. This happens automatically when you run `synapse test`. Any resources that your tests depend on could be updated which might not be wanted. A future release may include ways to control this behavior. 

## Assertion functions

`synapse:test` exports a few basic functions for making comparisons (equivalents are from `node:assert`):
* `expect` - truthy check, equivalent to `ok`
* `expectEqual` - deep comparison, equivalent to `assertDeepStrictEqual`
* `expectReferenceEqual` - shallow comparison, equivalent to `assertStrictEqual`

Something that should stand out is the swapping of deep equal and shallow equal. This was done because structural equality is far more useful and common for distributed systems.

## Hooks

Per-test lifecycle hooks can be registered using `before` and `after` which run before and after each test, respectively. Nested suites inherit the hooks of their parents.

The order of execution for "inherited" hooks is different between `before` and `after`:
`before` - top-down execution, start with the hooks in the top-most suite and work down
`after`- bottom-up execution, start with the hooks in the bottom-most suite and work up


## Test isolation

In contrast to many JS test frameworks, `synapse:test` executes each test in isolation.

For example, these two tests will both pass:
```ts
import { test, expectEqual } from 'synapse:test'

let c = 0

test('one', () => {
    expectEqual(++c, 1)
})

test('two', () => {
    expectEqual(++c, 1)
})
```

Not everything is isolated between tests. The following are still shared for performance reasons:
* Code not compiled with Synapse, such as from `npm` packages
* The global context i.e `globalThis`

This should not cause problems in the vast majority of cases. If you run into any problems, please create an issue and we can figure out a solution.

### Sharing state

Resources, by design, are not isolated across tests nor individual executions. **All tests see the same resource in a given environment.** 

This can result in broken tests if not accounted for:

```ts
import { Bucket } from 'synapse:srl/storage'
import { test, expectEqual } from 'synapse:test'

const b = new Bucket()

test('put into bucket', () => {
    await b.put('a', 'b')
    expectEqual(await b.get('a', 'utf-8'), 'b')
})

// This test is not reliable!
test('has nothing', () => {
    const keys = await b.list()
    expectEqual(keys, [])
})
```

The suggested approach here is to add hooks to clean the resource before and/or after each test. For granular isolation, you can create resources isolated to a suite:

```ts
suite('empty bucket', () => {
    const b = new Bucket()

    test('has nothing', () => {
        const keys = await b.list()
        expectEqual(keys, [])
    }) 
})
```

## Using other testing frameworks

Other frameworks have not been tested, however, it should be possible to use existing frameworks with varying degrees of functionality. 

In general, mocking and assertion utilities should be compatible.
