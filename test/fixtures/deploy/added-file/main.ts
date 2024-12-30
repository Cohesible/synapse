import { Bucket } from 'synapse:srl/storage'

const b = new Bucket()

// !commands
// synapse deploy main.ts
// cp main.ts main2.ts
// synapse deploy main2.ts
// synapse show main.ts#b
// synapse show main2.ts#b
//
// @finally rm main2.ts