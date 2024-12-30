import { Bucket } from 'synapse:srl/storage'

// const b = new Bucket()

// !commands
// synapse compile
// synapse deploy @expectFail
//
// cp main.ts main2.ts
// @toggleComment main2.ts 3
// synapse deploy @expectFail
//
// @toggleComment 3
// synapse deploy
//
// mkdir -p foo
// cp main.ts foo/main3.ts
// synapse deploy
// synapse show foo/main3.ts#b
//
//
// @finally rm main2.ts
// @finally rm -rf foo