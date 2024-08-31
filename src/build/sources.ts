import * as git from '../git'
import * as path from 'node:path'
import { getUserSynapseDirectory } from '../workspaces'
import { getFs } from '../execution'
import { ensureDir, getHash } from '../utils'
import { runCommand } from '../utils/process'
import { getLogger } from '../logging'

const getSourcesDirs = () => path.resolve(getUserSynapseDirectory(), 'build', 'sources')
const getPkgName = (url: string) => url.replace(/^https?:\/\//, '').replace(/\.git$/, '')

interface GitSource {
    readonly type: 'git'
    readonly url: string
    readonly commitish: string
}

export async function downloadSource(source: GitSource) {
    const dest = path.resolve(getSourcesDirs(), getPkgName(source.url), source.commitish)
    const fs = getFs()
    if (await fs.fileExists(dest)) {
        await git.fetchOriginHead(dest, source.commitish)

        return dest
    }

    await git.fetchRepo(dest, source.url, source.commitish)

    return dest
}

