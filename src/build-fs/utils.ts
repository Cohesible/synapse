import * as path from 'node:path'
import { getFs } from '../execution'
import { DataRepository, getDataRepository, getPrefixedPath } from '../artifacts'

export async function findArtifactByPrefix(repo: DataRepository, prefix: string) {
    if (prefix.length === 64) {
        return prefix
    }

    const prefixedPath = getPrefixedPath(prefix)
    const dataDir = repo.getDataDir()
    const dirPath = path.resolve(dataDir, path.dirname(prefixedPath))
    const basename = path.basename(prefixedPath)
    const matches: string[] = []
    for (const f of await getFs().readDirectory(dirPath)) {
        if (f.type === 'file' && f.name.startsWith(basename)) {
            matches.push(f.name)
        }
    }

    if (matches.length > 1) {
        throw new Error(`Ambiguous match: ${matches.join('\n')}`)
    }

    if (!matches[0]) {
        return
    }

    const rem = path.relative(dataDir, dirPath).split('/').join('')

    return rem + matches[0]
}

export async function getArtifactByPrefix(repo: DataRepository, prefix: string) {
    const r = await findArtifactByPrefix(repo, prefix)
    if (!r) {
        throw new Error(`Object not found: ${prefix}`)
    }

    return r
}


export function getObjectByPrefix(prefix: string, repo = getDataRepository()) {
    return getArtifactByPrefix(repo, prefix.replace(/\//g, ''))
}


export async function getMetadata(repo: DataRepository, target: string) {
    const [source, hash] = target.split(':')

    const resolvedSource = await findArtifactByPrefix(repo, source)
    const resolvedHash = await findArtifactByPrefix(repo, hash)

    if (!resolvedSource) {
        throw new Error(`Did not find source matching hash: ${source}`)
    }

    if (!resolvedHash) {
        throw new Error(`Did not find object matching hash: ${hash}`)
    }

    return repo.getMetadata(resolvedHash, resolvedSource)
}

