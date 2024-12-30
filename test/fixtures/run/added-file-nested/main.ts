export function main() {}

// !commands
// # It's important that the `nested` dir exists before we run the test
// 
// synapse run main.ts
// 
// cp main.ts nested/dir/main2.ts
// synapse run nested/dir/main2.ts
//
// @finally rm nested/dir/main2.ts