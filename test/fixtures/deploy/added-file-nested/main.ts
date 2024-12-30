import { Bucket } from 'synapse:srl/storage'

const b = new Bucket()

// !commands
// # It's important that the `nested` dir exists before we run the test
// 
// synapse deploy main.ts
// 
// cp main.ts nested/dir/main2.ts
//
// synapse deploy nested/dir/main2.ts
// synapse show main.ts#b
// synapse show nested/dir/main2.ts#b
//
// @finally rm nested/dir/main2.ts