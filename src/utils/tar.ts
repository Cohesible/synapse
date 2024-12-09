import * as path from 'node:path'
import { runCommand } from './process'
import { ensureDir, memoize } from '../utils'
import { getFs } from '../execution'
import { randomUUID } from 'node:crypto'

// Pre-posix.1-1988 tarball header format (field size in bytes):
// File name - 100
// File mode - 8 (octal)
// Owner id - 8 (octal)
// Group id - 8 (octal)
// File size - 12 (octal)
//   * Highest order bit set to 1 means it's encoded as base-256 instead of octal
// Last modified in Unix time - 12 (octal)
// Checksum for header - 8
// Link indicator - 1
//   * 0 - normal file
//   * 1 - hard link
//   * 2 - symbolic link
//   * 3 - character special (UStar)
//   * 4 - block special (UStar)
//   * 5 - directory (UStar)
//   * 6 - FIFO (UStar)
//   * 7 - contiguous file (UStar)

// Name of linked file - 100

// Anything marked "octal" means it's stored as ASCII text
// Headers are padded to 512 bytes

// UStar header format is an extended form
// Check for "ustar" at offset 257
// If present, there may be a filename prefix at offset 345 (155 bytes)

export interface TarballFile {
    path: string
    mode: number
    contents: Buffer
    mtime: number
    // uid: number
    // gid: number
}

const toString = (buf: Buffer, start: number, length: number) => 
    String.fromCharCode(...buf.subarray(start, start + length)).split('\0', 2)[0]

export function extractTarball(buf: Buffer): TarballFile[] {
    let i = 0
    const files: TarballFile[] = []
    while (i < buf.length) {
        const isUstar = toString(buf, i + 257, 6) === 'ustar'
        const prefix = isUstar ? toString(buf, i + 345, 155) : undefined

        const name = toString(buf, i, 100)
        const mode = parseInt(toString(buf, i + 100, 8), 8)
        const size = parseInt(toString(buf, i + 124, 12), 8)
        const mtime = parseInt(toString(buf, i + 136, 12), 8)
        i += 512

        if (!isNaN(size)) {
            const contents = buf.subarray(i, i + size)
            const p = prefix ? path.join(prefix, name) : name

            files.push({ 
                path: p, 
                mode, 
                contents,
                mtime,
            })

            // File data section is always padded to the nearest 512 byte increment
            i += (size + 511) & ~511 
        }
    }

    return validateTarball(files)
}

function validateTarball(files: TarballFile[]) {
    for (const f of files) {
        if (path.isAbsolute(f.path)) {
            throw new Error(`Found absolute file paths: ${f.path}`)
        }
        if (f.path.split('/').some(s => s === '..')) {
            throw new Error(`Found relative file path: ${f.path}`) 
        }
    }
    return files
}

const toOctal = (n: number, size: number) => n.toString(8).padStart(size - 1, '0') + '\0'

export function createTarball(files: TarballFile[]): Buffer {
    validateTarball(files)

    const totalSize = files.map(f => ((f.contents.length + 511) & ~511) + 512).reduce((a, b) => a + b, 0)
    const buf = Buffer.alloc(totalSize)

    let i = 0
    for (const f of files) {
        const uid = 0
        const gid = 0
        const size = f.contents.length

        let relPath
        if (f.path.length >= 100) {
            buf.write('ustar', i + 257, 6, 'ascii')

            const sepIndex = f.path.indexOf(path.sep, f.path.length - 100)
            if (sepIndex === -1) {
                throw new Error(`Failed to find path separator: ${f.path}`)
            }

            relPath = f.path.slice(sepIndex+1)
            buf.write(f.path.slice(0, sepIndex), i + 345, 155, 'ascii')
        }

        buf.write(relPath ?? f.path, i, 100, 'ascii')
        buf.write(toOctal(f.mode, 8), i + 100, 8, 'ascii')
        buf.write(toOctal(uid, 8), i + 108, 8, 'ascii')
        buf.write(toOctal(gid, 8), i + 116, 8, 'ascii')
        buf.write(toOctal(size, 12), i + 124, 12, 'ascii')
        buf.write(toOctal(f.mtime, 12), i + 136, 12, 'ascii')

        buf.write(' '.repeat(8), i + 148, 8, 'ascii')
        let checksum = 0
        for (let j = 0; j < 512; j++) {
            checksum += buf[i + j]
        }

        buf.write((checksum & 0o777777).toString(8).padStart(6, '0') + '\0 ', i + 148, 8, 'ascii')
        i += 512
        buf.set(f.contents, i)
        i += (size + 511) & ~511
    }

    return buf
}


export async function extractToDir(data: Buffer, dir: string, ext: '.xz' | '.zip', stripComponents = 1) {
    await ensureDir(dir)

    // Okay so apparently passing through stdin on windows doesn't write out top-level files ??
    const useStdin = process.platform !== 'win32'
    const args: string[] = []

    switch (ext) {
        case '.xz':
            args.push(useStdin ? '-xJf-' : '-xJf')
            break
        case '.zip':
            args.push(useStdin ? '-xzf-' : '-xzf')
            break
        default:
            throw new Error(`Unknown extname: ${ext}`)
    }


    if (useStdin) {
        if (stripComponents !== 0) {
            args.push(`--strip-components=${stripComponents}`)
        }
    
        return runCommand('tar', args, { cwd: dir, input: data })
    }

    const tmpPath = path.resolve(dir, `archive${ext}`)
    args.push(tmpPath)
    if (stripComponents !== 0) {
        args.push(`--strip-components=${stripComponents}`)
    }

    await getFs().writeFile(tmpPath, data)

    try {
        await runCommand('tar', args, { cwd: dir })
    } finally {
        await getFs().deleteFile(tmpPath)
    }
}

export const hasBsdTar = memoize(async () => {
    const res = await runCommand('tar', ['--version'])

    return res.includes('bsdtar')
})

export async function extractFileFromZip(zip: Buffer, fileName: string) {
    if (!(await hasBsdTar())) {
        const tmp = path.resolve(process.cwd(), 'dist', `tmp-${randomUUID()}.zip`)
        await getFs().writeFile(tmp, zip)
        const res = await runCommand('unzip', ['-p', tmp, fileName], {
            encoding: 'none',
        }).finally(async () => {
            await getFs().deleteFile(tmp)
        })

        return res as any as Buffer
    }

    if (process.platform === 'win32') {
        const tmp = path.resolve(process.cwd(), 'dist', `tmp-${randomUUID()}.zip`)
        await getFs().writeFile(tmp, zip)
        await runCommand('tar', ['-zxf', tmp, fileName], {
            encoding: 'none',
        }).finally(async () => {
            await getFs().deleteFile(tmp)
        })
    
        return getFs().readFile(fileName)
    }

    // Only works with `bsdtar`
    const res = await runCommand('tar', ['-zxf-', '-O', fileName], {
        input: zip,
        encoding: 'none',
    })

    return res as any as Buffer
}

export async function listFilesInZip(zip: Buffer) {
    if (!(await hasBsdTar())) {
        const tmp = path.resolve(process.cwd(), 'dist', `tmp-${randomUUID()}.zip`)
        await getFs().writeFile(tmp, zip)
        const res = await runCommand('unzip', ['-l', tmp]).finally(async () => {
            await getFs().deleteFile(tmp)
        })

        // first three lines and last two lines we don't care
        const lines = res.trim().split('\n').slice(3, -2)
        return lines.map(l => {
            const [length, date, time, name] = l.trim().split(/\s+/)

            return name
        })
    }

    if (process.platform === 'win32') {
        const tmp = path.resolve(process.cwd(), 'dist', `tmp-${randomUUID()}.zip`)
        await getFs().writeFile(tmp, zip)
        const res = await runCommand('tar', ['-tzf', tmp]).finally(async () => {
            await getFs().deleteFile(tmp)
        })
    
        return res.split(/\r?\n/).map(x => x.trim()).filter(x => !!x)
    }

    // Only works with `bsdtar`
    const res = await runCommand('tar', ['-tzf-'], {
        input: zip,
    })

    return res.split(/\r?\n/).map(x => x.trim()).filter(x => !!x)
}
