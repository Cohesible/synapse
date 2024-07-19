import { Client } from 'pkg-b'

export async function main() {
    const c = new Client({ authorization: () => 'authz' })
    console.log(await c.bar())
}

// !commands
// (cd pkg-b && synapse deploy && synapse publish --archive out/pkg.tgz)
// synapse add pkg-b/out/pkg.tgz
// synapse run
