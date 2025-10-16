import * as aws from 'terraform-provider:aws'

const bucket = new aws.S3Bucket()

// !commands
// synapse compile --target local
