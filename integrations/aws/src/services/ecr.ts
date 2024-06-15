import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as aws from 'synapse-provider:aws'
import * as fs from 'fs/promises'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import * as ECR from '@aws-sdk/client-ecr'
import * as ECRPublic from '@aws-sdk/client-ecr-public'
import { getFileHash } from '../utils'

interface DockerfileProps {
    baseImage?: string
    workingDirectory?: string
    entrypoint?: string
    preCopyCommands?: string[]
    postCopyCommands?: string[]
    extraFiles?: [core.DataPointer, string][]
    jsCommand?: string
}

// TODO: we should _not_ resolve pointers here. They should
// be resolved "just-in-time" i.e. right before we run docker
//
// Plus it'd be more user-friendly if you could write out the 
// dockerfile directly rather than having to go through an abstraction
export class GeneratedDockerfile extends core.defineResource({
    create: async (bundle: lib.Bundle, props?: DockerfileProps) => {
        const artifactFs = core.getArtifactFs()
        const resolvedDest = bundle.destination.startsWith('pointer:')
            ? await artifactFs.resolveArtifact(bundle.destination)
            : bundle.destination

        const extraFileCommands: string[] = []
        for (const [k, v] of (props?.extraFiles ?? [])) {
            const resolved = await artifactFs.resolveArtifact(k)
            extraFileCommands.push(`COPY ${path.basename(resolved)} ${v}`)
        }

        const jsCommand = props?.jsCommand ?? 'node'
        const localPath = path.basename(resolvedDest)
        const baseImage = props?.baseImage ?? '--platform=linux/amd64 node:18-alpine'
        const workdir = props?.workingDirectory ?? '/app'
        const entrypoint = props?.entrypoint 
            ? `"${props.entrypoint}"` 
            : (props?.baseImage ? `"${jsCommand}", "./${localPath}"` : `"node", "-e", "require('./${localPath}').default()"`)

        const preCopyCommands = props?.preCopyCommands?.join('\n') ?? ''
        const postCopyCommands = props?.postCopyCommands?.join('\n') ?? ''
        const inlinedDockerfile = `
FROM ${baseImage}
WORKDIR ${workdir}
${preCopyCommands}
COPY [ "${localPath}", "./" ]
${extraFileCommands.join('\n')}
${postCopyCommands}
CMD [ ${entrypoint} ]
`.trim()
    
        const pointer = await artifactFs.writeArtifact(Buffer.from(inlinedDockerfile), {
            dependencies: [bundle.destination]
        })
    
        return { location: pointer }
    },
}) {}


async function runDocker(args: string[], stdin?: string, cwd?: string): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        try {
            console.log(`Running docker with args (cwd: ${cwd ?? process.cwd()})`, args)
            const proc = child_process.execFile('docker', args, { cwd }, (err, stdout, stderr) => {
                if (err) return reject(err)
                resolve({ stdout, stderr })
            })

            proc.on('spawn', () => {
                if (stdin) {
                    proc.stdin?.end(stdin)
                }
            })

            proc.on('error', reject)
        } catch (e) {
            reject(e)
        }
    })
}

interface DockerfileDeploymentBase {
    readonly dockerfilePath: string
    readonly repoName: string
    readonly workingDirectory?: string
}

interface EcrDockerfileDeployment extends DockerfileDeploymentBase {
    readonly type: 'ecr'
    readonly repositoryUrl: string

    // AWS specific
    readonly region: string // NOT NEEDED FOR PUBLIC ECR
}

interface DockerhubDockerfileDeployment extends DockerfileDeploymentBase {
    readonly type: 'dockerhub'
    readonly credentials: { username: string; password: string }
}


type DockerfileDeploymentProps = EcrDockerfileDeployment | DockerhubDockerfileDeployment

async function getPrivateEcrCredentials(region: string) {
    const client = new ECR.ECR({ region })
    const creds = await client.getAuthorizationToken({})
    const token = creds.authorizationData![0].authorizationToken!
    
    return {
        username: 'AWS',
        password: Buffer.from(token, 'base64').toString('utf-8').split(':').pop()!,
    }
}

async function getPublicEcrCredentials() {
    const client = new ECRPublic.ECRPUBLIC({ region: 'us-east-1' })
    const creds = await client.getAuthorizationToken({})
    const token = creds.authorizationData!.authorizationToken!
    
    return {
        username: 'AWS',
        password: Buffer.from(token, 'base64').toString('utf-8').split(':').pop()!,
    }
}

export async function deployToEcr(props: EcrDockerfileDeployment) {
    const creds = props.repositoryUrl.includes('public.ecr.aws')
        ? await getPublicEcrCredentials()
        : await getPrivateEcrCredentials(props.region)

    const workingDir = props.workingDirectory ?? path.dirname(props.dockerfilePath)
    // TODO: run `logout` to clear credentials?
    await runDocker(['login', '--username', creds.username, '--password-stdin', props.repositoryUrl], creds.password, workingDir)
    await runDocker(['build', '-t', props.repoName, '-f', props.dockerfilePath, '.'], undefined, workingDir)
    const buildId = await getLatestBuildId(props.repoName)
    const destination = `${props.repositoryUrl}:${buildId}`

    await runDocker(['tag', props.repoName, destination], undefined, workingDir)
    await runDocker(['push', destination], undefined, workingDir)
    // const imageDigest = stdout.match(/latest: digest: ([^\s]+)/)?.[1]
    // if (!imageDigest) {
    //     throw new Error(`Failed to parse out digest: ${stdout}`)
    // }
    const dockerfileHash = getFileHash(props.dockerfilePath)

    return { ...props, dockerfileHash, tagName: buildId, imageName: destination }
}

// ONLY RELEVANT FOR PRIVATE ECR
core.bindFunctionModel(deployToEcr, [
    {
        "Action": [
            "ecr:BatchCheckLayerAvailability",
            "ecr:BatchGetImage",
            "ecr:CompleteLayerUpload",
            "ecr:GetDownloadUrlForLayer",
            "ecr:InitiateLayerUpload",
            "ecr:PutImage",
            "ecr:UploadLayerPart"
        ],
        "Effect": "Allow",
        "Resource":"arn:{context.Partition}:ecr:{0.region}:{context.Account}:repository/{0.tagName}" // <-- THIS IS BASED OFF THE REPO NAME
    },
    {
        "Action": [
            "ecr:GetAuthorizationToken"
        ],
        "Effect": "Allow",
        "Resource": "arn:{context.Partition}:ecr:{0.region}:{context.Account}:*"
    }
])

interface DockerImageSummary {
    ID: string // Build ID
    Tag: string
    Repository: string
    Digest: string
    Containers: string
    CreatedAt: string
    CreatedSince: string
    SharedSize: string
    UniqueSize: string
    VirtualSize: string // 'N/A' is basically `undefined`
}

async function listImages(): Promise<DockerImageSummary[]>
async function listImages(repoName: string): Promise<DockerImageSummary[]>
async function listImages(repoName: string, tag: string): Promise<DockerImageSummary[]>
async function listImages(repoName?: string, tag?: string) {
    // const baseArgs = ['--no-trunc', '--format', 'json']
    const baseArgs = ['--format', 'json']
    const target = repoName ? `${repoName}${tag ? `:${tag}` : ''}` : undefined
    const args = target ? [target, ...baseArgs] : baseArgs
    const { stdout } = await runDocker(['images', ...args])

    const images: DockerImageSummary[] = []
    for (const line of stdout.split('\n').map(x => x.trim())) {
        if (line) {
            images.push(JSON.parse(line))
        }
    }

    return images
}

async function getLatestBuildId(repoName: string) {
    const images = await listImages(repoName, 'latest')
    if (images.length === 0) {
        throw new Error(`No image found: ${repoName}`)
    }

    return images[0].ID
}

async function deployToDockerhub(props: DockerhubDockerfileDeployment) {
    const creds = props.credentials
    const workingDir = props.workingDirectory ?? path.dirname(props.dockerfilePath)
    await runDocker(['login', '--username', creds.username, '--password-stdin'], creds.password, workingDir)
    await runDocker(['build', '-t', props.repoName, '-f', props.dockerfilePath, '.'], undefined, workingDir)
    const buildId = await getLatestBuildId(props.repoName)
    const destination = `${props.repoName}:${buildId}`

    await runDocker(['tag', props.repoName, destination], undefined, workingDir)
    await runDocker(['push', destination], undefined, workingDir)

    return { ...props, tagName: buildId, imageName: destination } as DockerfileDeploymentBase & { imageName: string; tagName: string }
}

// We use a fixed name so Docker can cache things
export class DockerfileDeployment extends core.defineResource({
    create: async (props: DockerfileDeploymentProps & { _name?: string }) => {
        const resolved = await core.getArtifactFs().resolveArtifact(props.dockerfilePath, { name: props._name } as any)

        if (props.type === 'ecr') {
            return deployToEcr({ ...props, dockerfilePath: resolved })
        }

        return deployToDockerhub({ ...props, dockerfilePath: resolved })
    },
    delete: async state => {
        try {
            const result = await runDocker(['image', 'rm', `${state.imageName}`])
            console.log(result.stdout)
            console.log(result.stderr)
        } catch (e) {
            if (!(e instanceof Error) || !e.message.includes('No such image')) {
                throw e
            }
        }
    }
}) {}

export function createDockerfileDeployment(props: DockerfileDeploymentProps) {
    const _name = core.getCurrentId()

    return new DockerfileDeployment({ ...props, _name })
}