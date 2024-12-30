import { Bucket } from 'synapse:srl/storage'

const b = new Bucket()

// !commands
// cp main.ts main2.ts
// synapse deploy --symbol main2.ts#b --dry-run
// 
// rm main2.ts
// export OUTPUT=$(synapse deploy --dry-run | grep -i '^ ')
// @expectEqual "$OUTPUT" " + b <Bucket>  main.ts:3:15"
//
//
// @finally rm -f main2.ts