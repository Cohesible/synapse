import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FsEntity {
    readonly type: 'file' | 'directory' | 'unknown'
    readonly name: string
}

export interface FsEntityStats {
    readonly type: 'file' | 'directory' | 'unknown'
    readonly size: number
    readonly mtimeMs: number
    readonly ctimeMs: number

    readonly hash?: string
}

export type WriteFileOptions = BufferEncoding | {
    readonly mode?: fs.Mode
    readonly encoding?: BufferEncoding
    readonly flag?: 'w' | 'wx' // | 'w+' | 'wx+'

    /** Using `#mem` writes a temporary in-memory file */
    readonly fsKey?: '#mem' | string
    readonly checkChanged?: boolean
}

interface LinkOptions {
    readonly overwrite?: boolean
    readonly symbolic?: boolean
    readonly typeHint?: 'dir' | 'file' | 'junction'
    readonly mode?: fs.Mode 
}

export interface Fs {
    readDirectory(fileName: string): Promise<FsEntity[]>
    writeFile(fileName: string, data: Uint8Array): Promise<void>
    writeFile(fileName: string, data: string, encoding?: BufferEncoding): Promise<void>
    writeFile(fileName: string, data: Uint8Array | string, encoding?: BufferEncoding): Promise<void>
    writeFile(fileName: string, data: Uint8Array | string, options?: WriteFileOptions): Promise<void>
    readFile(fileName: string): Promise<Uint8Array>
    readFile(fileName: string, encoding: BufferEncoding): Promise<string>
    deleteFile(fileName: string, opt?: { recursive?: boolean; force?: boolean; fsKey?: '#mem' }): Promise<void>
    fileExists(fileName: string): Promise<boolean>
    // open(fileName: string): Promise<FileHandle>
    link(existingPath: string, newPath: string, opt?: LinkOptions): Promise<void>
    stat(fileName: string): Promise<FsEntityStats>
}

export interface JsonFs {
    writeJson(fileName: string, data: any): Promise<void>
    readJson<T = any>(fileName: string): Promise<T>
}

export interface SyncFs {
    writeFileSync(fileName: string, data: Uint8Array): void
    writeFileSync(fileName: string, data: string, encoding?: BufferEncoding): void
    writeFileSync(fileName: string, data: Uint8Array | string, encoding?: BufferEncoding): void
    writeFileSync(fileName: string, data: Uint8Array | string, options?: WriteFileOptions): void
    readFileSync(fileName: string): Uint8Array
    readFileSync(fileName: string, encoding: BufferEncoding): string
    // readFileSync(fileName: string, encoding?: BufferEncoding): string | Buffer
    deleteFileSync(fileName: string): void
    fileExistsSync(fileName: string): boolean
    // linkSync(existingPath: string, newPath: string): void
}

export interface FileHandle {
    // readonly position: number
    write(data: Uint8Array): Promise<void>
    write(data: string, encoding?: BufferEncoding): Promise<void>
    write(data: Uint8Array | string, encoding?: BufferEncoding): Promise<void>
    // read(length: number): Promise<Uint8Array>
    // read(length: number, encoding: BufferEncoding): Promise<string>
    dispose(): Promise<void>
}

// Note:
// On Linux, positional writes don't work when the file is opened in append mode. The kernel ignores 
// the position argument and always appends the data to the end of the file.

// readFile: (position: number, buffer: Uint8Array, length: string, offset?: number) => Promise<void>

type WriteFileFn = (position: number, buffer: Uint8Array, length: number, offset?: number) => Promise<void>

function createFileHandle(writeFile: WriteFileFn, close: () => Promise<void>): FileHandle {
    let writePosition = 0
    let isWorking = false
    let closingCallback: (err?: any) => void | undefined
    const queuedWrites: { buffer: Uint8Array, callback: (err?: any) => void }[] = []

    async function doWork() {
        while (queuedWrites.length > 0) {
            const task = queuedWrites.shift()!
            try {
                await writeFile(writePosition, task.buffer, task.buffer.length)
                writePosition += task.buffer.length
                task.callback()
            } catch (e) {
                task.callback(e)

                // All remaining tasks must be evicted
                const tasks = [...queuedWrites]
                queuedWrites.length = 0
                tasks.forEach(t => t.callback(e))
                closingCallback?.(e)
            }
        }

        isWorking = false
        closingCallback?.()
    }

    function write(data: Uint8Array | string, encoding?: BufferEncoding) {
        if (closingCallback !== undefined) {
            throw new Error(`Cannot write to a disposed file handle`)
        }

        const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data

        return new Promise<void>((resolve, reject) => {
            const callback = (err?: any) => err ? reject(err) : resolve()
            queuedWrites.push({ buffer, callback })
            if (!isWorking) {
                isWorking = true
                doWork()
            }
        })   
    }

    function dispose() {
        const flushed = new Promise<void>((resolve, reject) => {
            closingCallback = err => err ? reject(err) : resolve()
        })

        const lastTask = queuedWrites[queuedWrites.length - 1]
        if (!lastTask) {
            return close()
        }

        return flushed.finally(close)
    }

    return { write, dispose }
}

export function watchForFile(fileName: string) {
    const watcher = fs.watch(path.dirname(fileName))

    function dispose() {
        watcher.close()
    }

    function onFile(listener: () => void) {
        watcher.on('change', ev => {
            if (ev === path.basename(fileName)) {
                listener()
            }
        })
    }

    return { onFile, dispose }
}

export async function openHandle(fileName: string): Promise<FileHandle> {
    await fs.promises.mkdir(path.dirname(fileName), { recursive: true })

    const fd = await new Promise<number>((resolve, reject) => {
        fs.open(fileName, 'w', (err, fd) => err ? reject(err) : resolve(fd))
    })

    const writeFile: WriteFileFn = (position, buffer, length, offset) => {
        return new Promise<void>((resolve, reject) => {
            fs.write(fd, buffer, offset, length, position, err => err ? reject(err) : resolve())
        })
    }

    const closeFile = () => {
        return new Promise<void>((resolve, reject) => {
            fs.close(fd, err => err ? reject(err) : resolve())
        })
    }

    return createFileHandle(writeFile, closeFile)
}

function toEntityStats(stats: fs.Stats): FsEntityStats {
    return { 
        type: mapType(stats),
        size: stats.size, 
        mtimeMs: stats.mtimeMs, 
        ctimeMs: stats.ctimeMs,
    }
}

export async function readFileWithStats(fileName: string): Promise<{ data: Uint8Array, stats: FsEntityStats }>
export async function readFileWithStats(fileName: string, encoding: BufferEncoding): Promise<{ data: string, stats: FsEntityStats }>
export async function readFileWithStats(fileName: string, encoding?: BufferEncoding): Promise<{ data: string | Uint8Array, stats: FsEntityStats }>
export async function readFileWithStats(fileName: string, encoding?: BufferEncoding): Promise<{ data: string | Uint8Array, stats: FsEntityStats }> {
    const fd = await new Promise<number>((resolve, reject) => {
        fs.open(fileName, 'r', (err, fd) => err ? reject(err) : resolve(fd))
    })

    const stats = fs.fstatSync(fd)
    let buf = Buffer.allocUnsafe(stats.size)
    let total = 0

    while (total < buf.byteLength) {
        const amountRead = await new Promise<number>((resolve, reject) => {
            fs.read(fd, buf, total, buf.byteLength, -1, (err, read) => err ? reject(err) : resolve(read))
        })

        if (amountRead === 0) break
        total += amountRead
    }

    if (total < buf.byteLength) {
        buf = buf.subarray(0, total)
    }

    await new Promise<void>((resolve, reject) => {
        fs.close(fd, err => err ? reject(err) : resolve())
    })

    return {
        stats: toEntityStats(stats),
        data: encoding ? buf.toString(encoding) : buf,
    }
}

class FsError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message)
    }
}

export async function ensureDir(fileName: string) {
    // TODO: delete file if it's a sym link ?
    await fs.promises.mkdir(path.dirname(fileName), { recursive: true })
}

export function ensureDirSync(fileName: string) {
    fs.mkdirSync(path.dirname(fileName), { recursive: true })
}

function mapType(f: fs.Dirent | fs.Stats): FsEntityStats['type'] {
    return f.isDirectory() ? 'directory' : f.isFile() ? 'file' : 'unknown'   
}

export function readDirectorySync(dir: string) {
    const res: FsEntity[] = []
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        res.push({ type: mapType(f), name: f.name })
    }

    return res
}

export async function readDirRecursive(fs: Fs, dir: string) {
    const files: Record<string, string> = {}
    async function readDir(filePath: string) {
        for (const f of await fs.readDirectory(filePath)) {
            const absPath = path.resolve(filePath, f.name)
            if (f.type === 'directory') {
                await readDir(absPath)
            } else if (f.type === 'file') {
                files[path.relative(dir, absPath)] = absPath 
            }
        }
    }

    await readDir(dir)

    return files
}

export async function rename(from: string, to: string) {
    await fs.promises.rename(from, to)
}

function isTooManyFilesError(err: unknown): err is Error & { code: 'EMFILE' } {
    return (err as any).code === 'EMFILE'
}

export function createLocalFs(): Fs & SyncFs {
    const memory = new Map<string, { data: string | Uint8Array; encoding?: BufferEncoding }>()

    // const queue: [resolve: () => void, reject: (err: any) => void, fileName: string, data: string | Uint8Array, opt?: WriteFileOptions][] = []

    async function writeFile(fileName: string, data: string | Uint8Array, opt?: WriteFileOptions) {
        if (typeof opt !== 'string' && opt?.fsKey === '#mem') {
            if (opt.flag === 'wx' && memory.has(fileName)) {
                throw new FsError(`File "${fileName}" already exists in memory`, 'EEXIST')
            }

            memory.set(fileName, { data, encoding: opt.encoding ?? (typeof data === 'string' ? 'utf-8' : undefined) })

            return
        }

        try {
            await fs.promises.writeFile(fileName, data, opt)
        } catch (e) {
            if (isTooManyFilesError(e)) {
                // XXX: not the best impl.
                return new Promise<void>((resolve, reject) => {
                    setTimeout(
                        () => writeFile(fileName, data, opt).then(resolve, reject), 
                        100 + (250 * Math.random())
                    )
                })
            }

            if ((e as any).code !== 'ENOENT') { // TODO: throw when using 'append' (or equivalent) flags
                throw e
            }

            await ensureDir(fileName)
            try {
                await fs.promises.writeFile(fileName, data, opt)
            } catch (e) {
                if (isTooManyFilesError(e)) {
                    // XXX: not the best impl.
                    return new Promise<void>((resolve, reject) => {
                        setTimeout(
                            () => writeFile(fileName, data, opt).then(resolve, reject), 
                            100 + (250 * Math.random())
                        )
                    })
                }
                throw e
            }
        }
    }

    function writeFileSync(fileName: string, data: string | Uint8Array, opt?: WriteFileOptions) {
        ensureDirSync(fileName)
        fs.writeFileSync(fileName, data, opt)
    }

    async function deleteFile(fileName: string, opt?: { recursive?: boolean; force?: boolean; fsKey?: '#mem' }) {
        if (memory.has(fileName)) {
            memory.delete(fileName)
            return
        } else if (opt?.fsKey === '#mem') {
            return
        }

        const stat = await fs.promises.lstat(fileName)
        if (stat.isDirectory()) {
            if (opt && !opt.force) {
                await fs.promises.rmdir(fileName, opt)
            } else {
                await fs.promises.rm(fileName, opt ?? { recursive: true, force: true })
            }
        } else if (stat.isSymbolicLink()) {
            await fs.promises.unlink(fileName)
        } else {
            await fs.promises.rm(fileName) // TODO: use flag for `force` ?
        }
    }

    function decode(data: Uint8Array, encoding: BufferEncoding) {
        if (Buffer.isBuffer(data)) {
            return data.toString(encoding)
        }

        return Buffer.from(data).toString(encoding)
    }

    async function readFile(fileName: string, encoding?: BufferEncoding) {
        if (memory.has(fileName)) {
            const r = memory.get(fileName)!
            if (r.encoding === encoding) {
                return r.data
            }

            const encoded = typeof r.data === 'string' ? Buffer.from(r.data, r.encoding) : r.data
            memory.set(fileName, { data: encoded })

            return encoding ? decode(encoded, encoding) : encoded
        }

        try {
            return fs.promises.readFile(fileName, encoding).catch(e => {
                const err = new Error((e as any).message)
                Object.defineProperty(e, 'stack', {
                    get: () => err.stack,
                })
                throw e
            }) as any
        } catch (e) {
            if (isTooManyFilesError(e)) {
                // XXX: not the best impl.
                return new Promise<void>((resolve, reject) => {
                    setTimeout(
                        () => readFile(fileName, encoding).then(resolve, reject), 
                        100 + (250 * Math.random())
                    )
                })
            }
            throw e
        }
    }

    async function fileExists(fileName: string) {
        return fs.promises.access(fileName, fs.constants.F_OK).then(() => true, () => false)
    }

    async function stat(fileName: string) {
        const stats = await fs.promises.stat(fileName).catch(e => {
            const err = new Error((e as any).message)
            Object.defineProperty(e, 'stack', {
                get: () => err.stack,
            })
            throw e
        })

        return toEntityStats(stats)
    }

    async function readDirectory(fileName: string) {
        const res: FsEntity[] = []
        for (const f of await fs.promises.readdir(fileName, { withFileTypes: true })) {
            res.push({ type: mapType(f), name: f.name })
        }

        return res
    }

    return {
        stat,
        // open,
        writeFile,
        writeFileSync,
        link: async (existingPath, newPath, opt) => {
            async function _link() {
                if (opt?.symbolic) {
                    await fs.promises.symlink(existingPath, newPath, opt.typeHint)
                } else { 
                    await fs.promises.link(existingPath, newPath)
                }

                if (opt?.mode) {
                    await fs.promises.chmod(newPath, opt.mode)
                }
            }

            try {
                await _link()
            } catch (e) {
                if ((e as any).code === 'EEXIST') {
                    if (opt?.overwrite === false) {
                        return
                    }

                    await fs.promises.unlink(newPath).catch(async e => {
                        if ((e as any).code === 'EPERM' && process.platform === 'win32') {
                            // This isn't a symlink
                            const realpath = await fs.promises.realpath(newPath)
                            if (realpath === newPath) {
                                try {
                                    return await fs.promises.rm(newPath)
                                } catch (e) {
                                    // ok, I guess `rm` doesn't behave the same on Windows
                                    if ((e as any).code === 'ERR_FS_EISDIR' || (e as any).code === 'EISDIR') {
                                        return fs.promises.rmdir(newPath)
                                    }
                                }
                            }
                        }

                        throw e
                    })
                    return _link()
                }

                if ((e as any).code !== 'ENOENT') {
                    throw e
                }

                await ensureDir(newPath)

                return _link()
            }
        },
        deleteFile,
        deleteFileSync: (fileName) => fs.rmSync(fileName),
        readFile,
        readFileSync: (fileName, encoding?: BufferEncoding) => fs.readFileSync(fileName, encoding) as any,
        fileExists,
        fileExistsSync: fs.existsSync,
        readDirectory,
    }
}
