import { expectEqual } from 'synapse:test'

export function main(status: string) {
    const lines = status.split('\n')
    expectEqual(lines[0], 'No packages installed')
}

// !commands
// synapse clean
// export CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
// synapse compile
// git checkout -b test-branch-isolation
// # TODO: this test will eventually fail once smarter caching is enabled
// export STATUS=$(synapse status)
// synapse compile
// synapse run -- "$STATUS"
//
// @finally synapse clean
// @finally if [ -n "$CURRENT_BRANCH" ]; then git checkout "$CURRENT_BRANCH"; fi
// @finally git branch -d test-branch-isolation || true
