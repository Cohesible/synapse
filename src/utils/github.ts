import * as http from './http'

export function parseDependencyRef(ref: string) {
    function parsePathComponent(pathname: string) {
        const [p, commitish] = pathname.split('#')
        const [owner, repo] = p.replace(/\.git$/, '').split('/')
        if (!repo) {
            throw new Error(`Failed to parse repository from github ref: ${p}`)
        }

        return {
            owner,
            repository: repo,
            commitish: commitish as string | undefined,
        }
    }

    if (ref.startsWith('https://github.com')) {
        return {
            type: 'github',
            ...parsePathComponent(ref.slice('https://github.com/'.length))
        } as const
    }

    if (!ref.match(/^[a-z]+:/)) {
        return {
            type: 'github',
            ...parsePathComponent(ref),
        } as const
    }

    throw new Error(`Not implemented: ${ref}`)
}

function getToken() {
    return process.env['CROSSREPO_GITHUB_TOKEN'] || process.env['GITHUB_TOKEN']
}

export async function fetchJson<T>(url: string): Promise<T> {
    const token = getToken()
    const authHeaders = token ? { authorization: `token ${token}` } : undefined

    return http.fetchJson(url, {
        ...authHeaders,
        'user-agent': 'synapse',
        accept: 'application/vnd.github+json',
    })
}

export async function fetchData(url: string, accept?: string, bearer?: boolean) {
    const token = getToken()
    const authHeaders = token ? { authorization: `${bearer ? 'Bearer' : 'token'} ${token}` } : undefined
    const base = {
        ...authHeaders,
        'user-agent': 'synapse',
    }

    return http.fetchData(url, accept ? { ...base, accept } : base)
}

export async function listArtifacts(owner: string, repo: string, name?: string) {
    const query = name ? new URLSearchParams({ name }) : undefined
    const url = `https://api.github.com/repos/${owner}/${repo}/actions/artifacts${query ? `?${query.toString()}` : ''}`
    const data = await fetchJson<any>(url)

    return data.artifacts as { id: number; name: string; created_at: string; archive_download_url: string }[]
}

export async function downloadRepoFile(owner: string, repo: string, filePath: string, branch = 'main') {
    const pathSegment = `/${owner}/${repo}/${branch}/${filePath}`
    const url = `https://raw.githubusercontent.com${pathSegment}`

    return fetchData(url, 'application/vnd.github.v3.raw').catch(e => {
        throw new Error(`Download failed: ${pathSegment}`, { cause: e })
    })
}

export interface Release {
    name: string
    tag_name: string
    published_at: string
    assets: {
        name: string
        content_type: string
        browser_download_url: string
    }[]
}

export async function listReleases(owner: string, repo: string): Promise<Release[]> {
    return fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases`)
}

async function getLatestRelease(owner: string, repo: string): Promise<Release> {
    return fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
}

export async function getRelease(owner: string, repo: string, tagName?: string): Promise<Release> {
    if (!tagName) {
        return getLatestRelease(owner, repo)
    }

    return fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tagName}`)
}

export async function downloadAssetFromRelease(owner: string, repo: string, name: string, tagName?: string): Promise<Buffer> {
    const release = await getRelease(owner, repo, tagName)
    const asset = release.assets.find(a => a.name === name)
    if (!asset) {
        throw new Error(`Asset not found: ${name} [release: ${release.tag_name}]`)
    }

    return fetchData(asset.browser_download_url)
}
