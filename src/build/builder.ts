
import * as os from 'node:os'

// Terminology:
// * Project - source code location
// * Package - bundled distributable artifacts
// * Build - a graph node that consumes inputs to produce artifacts
// * Defines - build-time variables

// Dependencies are always represented as artifacts rather than the producer of said artifacts
//      * In some cases, the package is the artifact (e.g. `npm` packages)

export interface BuildTarget {
    mode?: 'debug' | 'release'
    os?: string
    arch?: string
    runtime?: string // Qualifies shared libs e.g. `glibc`, `node`, `browser` are all runtimes
}


export type Os = 'linux' | 'darwin' | 'windows' | 'freebsd'
export type Arch = 'aarch64' | 'x64'

export interface QualifiedBuildTarget {
    readonly os: Os
    readonly arch: Arch
    readonly endianness: 'LE' | 'BE'
    readonly libc?: 'musl' | 'gnu'
}

function parseOs(osType: string): Os {
    switch (osType) {
        case 'Darwin':
            return 'darwin'
        case 'Linux':
            return 'linux'
        case 'Windows_NT':
            return 'windows'

        default:
            throw new Error(`OS not supported: ${osType}`)
    }
}

function parseArch(arch: string): Arch {
    switch (arch) {
        case 'arm64':
            return 'aarch64'
        case 'x64':
            return arch

        default:
            throw new Error(`Architecture not supported: ${arch}`)
    }
}

export function resolveBuildTarget(target?: Partial<QualifiedBuildTarget>): QualifiedBuildTarget {
    const _os = target?.os ?? parseOs(os.type())
    const arch = target?.arch ?? parseArch(os.arch())
    const endianness = target?.endianness ?? os.endianness()

    return {
        ...target,
        os: _os,
        arch,
        endianness,
    }
}

export function toNodeArch(arch: Arch): NodeJS.Architecture {
    switch (arch) {
        case 'aarch64':
            return 'arm64'
        
        default:
            return arch
    }
}

export function toNodePlatform(os: Os): NodeJS.Platform {
    switch (os) {
        case 'windows':
            return 'win32'

        default:
            return os
    }
}

export interface CommonParams {
    readonly defines?: Record<string, string>
    readonly target?: BuildTarget
}

export interface BuildSourceParams extends CommonParams {
    readonly sourceDir: string
    readonly output?: string
}

