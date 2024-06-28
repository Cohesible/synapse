import * as fs from 'node:fs'
import * as path from 'node:path'
import * as lib from 'synapse:lib'
import { defineResource, asset, runCommand } from 'synapse:core'
import { describe, it, expectEqual } from 'synapse:test'
import { Function } from 'synapse:srl/compute'


class MyData extends defineResource({
    create: async (asset: string) => {
        const data = await lib.readAsset(asset)

        return { data }
    },
}) {}

const myAsset = asset('./my-data.json')
const myData = new MyData(myAsset)

async function hello() {
    return JSON.parse(myData.data)
}

const fn = new Function(hello)

describe('image function', () => {
    it('returns the asset data', async () => {
        const resp = await fn()
        expectEqual(resp.hello, 'world')
    })
})


async function readMyAsset() {
    const data = await lib.readAsset(myAsset)

    return JSON.parse(data)
}

const b = new lib.Bundle({ readMyAsset, __esModule: true }, { includeAssets: true })

const a = new lib.Archive(b)

declare var __buildTarget: { deploymentId: string; buildDir: string }
function getDeployBuildDir() {
    return path.resolve(__buildTarget.buildDir, 'deployments', __buildTarget.deploymentId)
}

const deployBuildDir = getDeployBuildDir()

// TODO: the logic to support this is commented out in `synapse:lib`
// `extraFiles` needs to be passed to the backend. We don't because
// terraform complains about things being missing in the state

// it('zips assets', async () => {
//     const tmpDir = path.resolve('dist', 'tmp')
//     await fs.promises.mkdir(tmpDir, { recursive: true })

//     const archivePath = path.resolve(deployBuildDir, a.filePath)

//     // Doesn't work with gnu tar
//      await runCommand('tar', ['-xzf', archivePath, '-C', tmpDir])
//     //await runCommand('unzip', ['-o', archivePath, '-d', tmpDir])

//     const h = await import(path.resolve(tmpDir, 'handler.cjs'))
//     const resp = await h.readMyAsset()
//     expectEqual(resp.hello, 'world')
// })

// !commands
// synapse deploy
// synapse test
