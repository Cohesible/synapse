import { runCommand } from "../utils/process"
import { BuildSourceParams } from "./builder"

interface Overlay {
    Replace: Record<string, string>
}

// -C dir <-- changes to this dir, must be first flag
// -race
// -msan
// -asan
// -installsuffix suffix

// go tool dist list

type Os = 
    | 'linux'
    | 'darwin'
    | 'windows'
    | 'solaris'
    | 'plan9'
    | 'openbsd'
    | 'netbsd'
    | 'freebsd'
    | 'ios' // mobile
    | 'android' // mobile

    | 'aix'
    | 'illumos'
    | 'dragonfly'

    | 'js' // wasm

type Arch = 
    | 'arm'
    | '386'
    | 'arm64'
    | 'amd64'

type BuildMode = 
    | 'archive'
    | 'c-archive'
    | 'c-shared'
    | 'default'
    | 'shared'
    | 'exe'
    | 'pie'
    | 'plugin'

// CGO_ENABLED=0

interface RawBuildParams {
    // -overlay file
    // -pgo file
    // -gccgoflags
    // -gcflags
    // -ldflags

    cwd?: string
    cgo?: boolean
    os?: string
    arch?: string
    output?: string // File or directory
    moduleMode?: 'readonly' | 'vendor' | 'mod'
    ldflags?: string // https://pkg.go.dev/cmd/link
    trimpath?: boolean
    // asmflags?: string
    // compiler?: 'gc' | 'gccgo'
    // packages?: string[]
}

async function runGoBuild(params: RawBuildParams) {
    const env: Record<string, string | undefined> = { ...process.env }
    if (params.cgo === false) {
        env['CGO_ENABLED'] = '0'
    }

    if (params.os) {
        env['GOOS'] = params.os
    }

    if (params.arch) {
        env['GOARCH'] = params.arch
    }

    const args = ['build']
    if (params.trimpath) {
        args.push('-trimpath')
    }

    if (params.moduleMode) {
        args.push(`-mod`, params.moduleMode)
    }

    if (params.ldflags) {
        args.push('-ldflags', `"${params.ldflags}"`)
    }

    if (params.output) {
        args.push('-o', params.output)
    }

    await runCommand('go', args, { env, cwd: params.cwd })
}


function resolveParams(params: BuildSourceParams): RawBuildParams {
    const res: RawBuildParams = { 
        cwd: params.sourceDir,
        moduleMode: 'readonly',
    }

    const ldflags: string[] = []

    if (params.target) {
        if (params.target.mode === 'release') {
            ldflags.push('-s', '-w')
            res.trimpath = true
            res.cgo = false
        }

        res.os = params.target.os
        res.arch = params.target.arch 
        if (res.arch === 'aarch64') {
            res.arch = 'arm64'
        } else if (res.arch === 'x64') {
            res.arch = 'amd64'
        }
    }

    if (params.defines) {
        for (const [k, v] of Object.entries(params.defines)) {
            ldflags.push('-X', `'${k}=${v}'`)
        }
    }

    if (ldflags.length > 0) {
        res.ldflags = ldflags.join(' ')
    }

    if (params.output) {
        res.output = params.output
    }

    return res
}

export async function buildGoProgram(params: BuildSourceParams) {
    const resolved = resolveParams(params)
    await runGoBuild(resolved)
}