import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

export function* listFiles(directory: string): Generator<string> {
    const files = fs.readdirSync(directory, { withFileTypes: true })
    for (const f of files) {
        const p = path.join(directory, f.name)
        if (f.isFile()) {
            yield p
        } else if (f.isDirectory()) {
            yield* listFiles(p)
        }
    }
}

export function getFileHash(p: string) {
    const data = fs.readFileSync(p, 'utf-8')

    return crypto.createHash('sha512').update(data).digest('hex')
}

export function getDataHash(data: string | Buffer) {
    return crypto.createHash('sha512').update(data).digest('hex')
}
