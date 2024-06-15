import path from 'node:path'
import * as fs from 'node:fs/promises'
import * as nodeStream from 'node:stream'
import { createHash, timingSafeEqual } from 'node:crypto'

type HashSums = [string, Buffer][]

function parseHashSums(text: string, hashEncoding: BufferEncoding = 'hex'): [string, Buffer][] {
    const result: [string, Buffer][] = []
    for (const line of text.split('\n')) {
        const match = line.match(/^([^\s]+) (.+)$/)
        if (!match) {
            throw new Error(`Failed to parse hash entry: ${line}`)
        }

        const [_, hash, fileName] = match
        const buf = Buffer.from(hash, hashEncoding)
        result.push([fileName, buf])
    }

    return result
}

function resolveHashSums(sums: HashSums, dir: string): HashSums {
    return sums.map(([f, h]) => [path.relative(dir, f), h])
}

class IntegrityException extends Error {
    public constructor(
        public readonly filePath: string,
        public readonly actual: Buffer, 
        public readonly expected: Buffer
    ) {
        super(`File ${filePath} failed integrity check`)
    }
}

async function checksum(filePath: string, expected: Buffer) {
    const actual = await hashFile(filePath)
    if (actual.byteLength !== expected.byteLength) {
        return new IntegrityException(filePath, actual, expected)
    }

    if (!timingSafeEqual(actual, expected)) {
        return new IntegrityException(filePath, actual, expected)
    }
}

async function validateHashSums(sums: HashSums): Promise<IntegrityException[]> {
    const result: IntegrityException[] = []
    for (const [f, h] of sums) {
        const err = await checksum(f, h)
        if (err) {
            result.push(err)
        }
    }
    return result
}

async function hashStream(stream: ReadableStream, alg: 'sha256' = 'sha256') {
    const h = createHash(alg)
    const d = nodeStream.Transform.toWeb(h)
    await stream.pipeTo(d.writable)

    return h.digest()
}

async function hashFile(filePath: string, alg: 'sha256' = 'sha256') {
    const r = await fs.open(filePath, 'r').then(handle => handle.createReadStream())
    const h = await hashStream(nodeStream.Readable.toWeb(r) as any, alg)

    return h
}

export async function hashFiles(files: string[], workingDir: string, alg: 'sha256' = 'sha256') {
    const result: [string, Buffer][] = []
    for (const f of files) {
        const absPath = path.resolve(workingDir, f)
        result.push([absPath, await hashFile(absPath, alg)])
    }

    return result
}

export async function createShaSumsFileText(files: string[], workingDir: string) {
    const sums = await hashFiles(files, workingDir)
    const result: string[] = []
    for (const [f, h] of sums) {
        const relPath = path.resolve(workingDir, f)
        const encoded = h.toString('hex')
        result.push(`${encoded} ${relPath}`)
    }

    result.push('')

    return result.join('\n')
}

export async function checkShaSumsFile(filePath: string, workingDir = path.dirname(filePath), include?: string[]) {
    const text = await fs.readFile(filePath, 'utf-8')
    const res = parseHashSums(text)

    const includeSet = include ? new Set(include.map(f => path.relative(workingDir, f))) : undefined
    const filtered = includeSet ? res.filter(([f]) => includeSet.has(f)) : res
    const resolved = resolveHashSums(filtered, workingDir)

    const errors = await validateHashSums(resolved)
    if (errors.length > 0) {
        throw new AggregateError(errors)
    }
}