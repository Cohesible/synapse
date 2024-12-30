import { Bucket } from 'synapse:srl/storage'

// const b = new Bucket()

// !commands
// synapse compile
// synapse deploy @expectFail
//
// mkdir -p foo
// cp main.ts foo/bar.ts
// @toggleComment foo/bar.ts 3
// synapse deploy @expectFail
//
// cp foo/bar.ts foo/bbar.ts        # Wildcard matching
// synapse deploy @expectFail
//
// mkdir -p foo/foo                 # Nested matching
// cp foo/bar.ts foo/foo/bar.ts     
// synapse deploy @expectFail
//
// mkdir -p foo/bar/foo             # Nested globstar matching
// cp foo/bar.ts foo/bar/foo/bar.ts
// synapse deploy @expectFail
//
// cp foo/bar.ts foo/r.ts           # Doesn't match exclude pattern
// synapse deploy
// synapse show foo/r.ts#b
//
//
// @finally rm -rf foo