import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as fsExt from './fs-ext.zig'

function canUseFsExt() {
    return process.release.name === 'node-synapse'
}

export function fastCopyDir(src: string, dst: string) {
    if (!canUseFsExt()) {
        throw new Error(`"fastCopyDir" is not available in the current runtime`)
    }

    src = path.resolve(src)
    dst = path.resolve(dst)

    const srcDir = path.dirname(src)
    const dstDir = path.dirname(dst)
    const srcBase = path.basename(src)
    const dstBase = path.basename(dst)

    return fsExt.cloneDir(srcDir, srcBase, dstDir, dstBase)
}

// Faster than `fs.rm(b, { force: true, recursive: true })` by ~50% on darwin (untested elsewhere)
export async function removeDir(dir: string) {
    const files = await fs.readdir(dir, { withFileTypes: true })
    const p: Promise<void>[] = []
    for (const f of files) {
        if (!f.isDirectory()) {
            p.push(fs.rm(path.resolve(dir, f.name)))
        } else {
            if (!canUseFsExt()) {
                p.push(fs.rm(path.resolve(dir, f.name), { recursive: true, force: true }))
            } else {
                p.push(fsExt.removeDir(dir, f.name)) 
            }        
        }
    }
 
    await Promise.all(p)
    await fs.rmdir(dir)
}

export async function cleanDir(dir: string, toKeep: string[]) {
    const s = new Set(toKeep)
    const files = await fs.readdir(dir, { withFileTypes: true })
    const p: Promise<void>[] = []
    for (const f of files) {
        if (s.has(f.name)) continue

        if (!f.isDirectory()) {
            p.push(fs.rm(path.resolve(dir, f.name)))
        } else {
            if (!canUseFsExt()) {
                p.push(fs.rm(path.resolve(dir, f.name), { recursive: true, force: true }))
            } else {
                p.push(fsExt.removeDir(dir, f.name)) 
            }
        }
    }
 
    await Promise.all(p)
}

export async function linkBin(src: string, dst: string) {
    await fsExt.symLinkBin(path.resolve(src), path.resolve(dst))
}