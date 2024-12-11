import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { runCommand } from './utils/process'
import { getFs } from './execution'
import { getGitDirectory } from './workspaces'
import { ensureDir } from './utils'

async function runGit(cwd: string, args: string[]) {
    return await runCommand('git', args, { cwd })
}

export interface Remote {
    readonly name: string
    readonly fetchUrl: string
    readonly pushUrl: string
    readonly headBranch: string
}

// We simply check for a `.git` directory
export async function findRepositoryDir(dir: string): Promise<string | undefined> {
    const gitDir = path.resolve(dir, '.git')
    if (await getFs().fileExists(gitDir)) {
        return dir
    }

    const parentDir = path.dirname(dir)
    if (parentDir !== dir) {
        return findRepositoryDir(parentDir)
    }
}

// Sync lookup is a bit faster (ideal for serial startup logic)
export function findRepositoryDirSync(dir: string): string | undefined {
    const gitDir = path.resolve(dir, '.git')
    if (getFs().fileExistsSync(gitDir)) {
        return dir
    }

    const parentDir = path.dirname(dir)
    if (parentDir !== dir) {
        return findRepositoryDirSync(parentDir)
    }
}

async function getUrls(dir: string, remote: string) {
    // TODO: use `git ls-remote --get-url ${remote}` too
    const fetchPromise = runGit(dir, ['config', '--get', `remote.${remote}.url`])
    const pushPromise = runGit(dir, ['config', '--get', `remote.${remote}.pushurl`]).catch(e => {
        if (e.code === 1) {
            return fetchPromise
        }

        throw e
    })

    const [fetch, push] = await Promise.all([fetchPromise, pushPromise])

    return { 
        fetchUrl: fetch.trim(),
        pushUrl: push.trim(),
    }
}

async function listBranches(dir: string, url: string) {
    function parseBranch(line: string) {
        const match = line.match(/([^\s])+\s+refs\/heads\/([^\s]+)/)
        if (!match) {
            throw new Error(`Unable to parse branch from line: ${line}`)
        }

        return { name: match[2], commit: match[1] }
    }

    const lsRemote = await runGit(dir, ['ls-remote', '--heads', url])

    return lsRemote.trim().split('\n').map(parseBranch)
}

async function parseRemoteSlow(dir: string, remote: string): Promise<Remote> {
    const { fetchUrl, pushUrl } = await getUrls(dir, remote)
    const lsRemote = await runGit(dir, ['ls-remote', '--symref', fetchUrl])
    const match = lsRemote.match(/ref: refs\/heads\/([^\s]+)\s+HEAD/)
    if (!match) {
        throw new Error(`No HEAD ref found: ${lsRemote}`)
    }

    return {
        pushUrl,
        fetchUrl,
        name: remote,
        headBranch: match[1],
    }
}

async function parseRemoteNoBranch(dir: string, remote: string): Promise<Omit<Remote, 'headBranch'>> {
    const { fetchUrl, pushUrl } = await getUrls(dir, remote)

    return {
        name: remote,
        pushUrl,
        fetchUrl,
    }
}

export async function listRemotes(dir = process.cwd()) {
    try {
        const result = await runGit(dir, ['remote', 'show'])
        const remoteNames = result.trim().split('\n').filter(x => !!x)
        const remotes = remoteNames.map(n => parseRemoteNoBranch(dir, n))
    
        return await Promise.all(remotes)
    } catch (e) {
        // TODO: seems to be an issue with running `git` inside containers:
        // * detected dubious ownership in repository (linux)
        // * fatal: could not read Username for 'https://github.com': Device not configured (macos)
        if ((e as any).code !== 128) {
            throw e
        }

        return []
    }
}

export async function getCurrentBranch(dir = process.cwd()) {
    // fatal: not a git repository (or any of the parent directories): .git
    const branch = await runGit(dir, ['branch', '--show-current']).catch(e => {
        if (e.code !== 128) {
            throw e
        }
    })

    return branch ? branch.trim() : undefined
}

export async function getDefaultBranch(remote: string, dir = process.cwd()) {
    const info = await runGit(dir, ['remote', 'show', remote])
    const branch = info.match(/HEAD branch: ([^\s]+)/)?.[1]
    if (!branch) {
        throw new Error('Failed to parse default branch')
    }

    return branch.trim()
}

export async function getLatestCommit(remote: string, branch = 'main', dir = process.cwd()) {
    await runGit(dir, ['fetch', remote, branch])
    const hash = await runGit(dir, ['rev-parse', 'FETCH_HEAD'])

    return hash.trim()
}

export function getCurrentBranchSync(dir = process.cwd()) {
    const res = child_process.execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf-8' })
    
    return res.trim()
}

export async function openRemote(remote: string) {
    const url = new URL(remote)
    const dest = path.resolve(getGitDirectory(), 'remotes', url.hostname + url.pathname)

    if (!(await getFs().fileExists(dest))) {
        await mkdir(dest, { recursive: true })

        const cloneResult = await runCommand(
            'git',
            ['clone', '--depth', '1', '--no-checkout', '--no-tags',  '--filter=blob:none', remote, dest],
        ).catch(async e => {
            await getFs().deleteFile(dest)
            throw e
        })
    } else {
        await runCommand(
            'git',
            ['fetch', '--depth', '1', '--no-tags',  '--filter=blob:none', remote],
            { cwd: dest }
        )
    }

    const treeResult = await runCommand(
        'git',
        ['ls-tree', '-r', '-z', 'HEAD'],
        { cwd: dest }
    )

    let isDisposed = false

    async function readFile(type: string, hash: string, encoding?: BufferEncoding): Promise<Buffer>
    async function readFile(type: string, hash: string, encoding: BufferEncoding): Promise<string>
    async function readFile(type: string, hash: string, encoding?: BufferEncoding) {
        return runCommand('git', ['cat-file', type, hash], {
            cwd: dest,
            encoding: encoding ?? 'none',
        }) as Promise<string | Buffer>
    }

    const files = treeResult
        .toString()
        .slice(0, -1)
        .split(/\0/)
        .map(s => s.split(/\s/))
        .map(([mode, type, hash, name]) => ({
            name: name!,
            read: async () => {
                if (isDisposed) {
                    throw new Error(`Cannot read file "${name}" after the remote has been disposed`)
                }
        
                return readFile(type!, hash!)
            }
        }))

    async function dispose() {
        isDisposed = true
        await getFs().deleteFile(dest)
    }

    return {
        files,
        dispose,
    }
}

export async function fetchOriginHead(dir: string, commitish: string) {
    await runGit(dir, ['fetch', 'origin', commitish])
    await runGit(dir, ['reset', '--hard', 'FETCH_HEAD'])
}

export async function fetchRepo(dir: string, source: string, commitish: string) {
    await ensureDir(dir)
    await runGit(dir, ['init']),
    await runGit(dir, ['remote', 'add', 'origin', source])
    await fetchOriginHead(dir, commitish)
}

// async function cloneRepo(procId: string, request: CreateProcessRequest, cwd?: string) {
//     const dest = cwd ? path.resolve(cwd, procId) : procId
//     const cloneArgs = [
//         'clone', 
//         '--depth', 
//         '1', 
//         '--single-branch', 
//         '--branch', 
//         request.branch, 
//         getCloneUrl(request.owner, request.repo, request.accessToken),
//         dest
//     ]

//     await runCommand('git', cloneArgs, { stdio: 'inherit' }).promise

//     return dest
// }

// const getCloneUrl = (owner: string, repo: string, token: string) => 
//     `https://x-access-token:${token}@github.com/${owner}/${repo}.git`

