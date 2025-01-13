import { Bucket } from 'synapse:srl/storage'

const b = new Bucket()

// !commands
// OUTPUT=$(synapse status)
// @expectMatch "$OUTPUT" "Not compiled"
// 
// synapse compile
// OUTPUT=$(synapse status)
// @expectMatch "$OUTPUT" "target: local"
//
// # Environment name + different target
// export SYNAPSE_ENV=test
// synapse clean
// synapse compile --target aws
// OUTPUT=$(synapse status)
// @expectMatch "$OUTPUT" "target: aws, env: test"
