import * as path from 'node:path'
import { getFs } from '../../execution'
import { makeRelative } from '../../utils'
import { getLogger } from '../../logging'

// This is a separate TS-only impl.
//
// I'm a tad concerned w/ stability right now with trying to push
// for a native solution. While it's largely functional, I do not
// think it's worth it yet. 
// 
// Regardless, the knowledge gained from writing the native solution
// first has been and will be incredibly useful for future work.

export interface Settings {
    ignore_dot_dirs?: boolean
    extnames?: string[]
    excluded_dirnames?: string[]
    included_patterns?: string[]
    excluded_patterns?: string[]
}

export interface SimpleChangeEvent {
    subpath: string
    is_added: boolean
    is_removed: boolean
}

const enum FileKind {
    File,
    Directory,
}

interface StateEntry {
    readonly kind: FileKind
    readonly size: number
    readonly mtime: number
}

function deserializeState(ab: ArrayBuffer) {
    return JSON.parse(Buffer.from(ab).toString('utf-8'))
}

function serializeState(state: Record<string, StateEntry>) {
    return Buffer.from(JSON.stringify(state), 'utf-8')
}

interface NextStateResult {
    readonly state: Record<string, StateEntry>
    readonly changes: SimpleChangeEvent[]
}

async function nextState(dirname: string, opt: Settings, state?: Record<string, StateEntry>): Promise<NextStateResult> {
    const fs = getFs()
    const changes: (SimpleChangeEvent & { state: StateEntry })[] = []
    const patterns = new Map<string, Patterns>()

    patterns.set('.', {
        included: opt.included_patterns?.map(x => x.split('/')) ?? [],
        excluded: opt.excluded_patterns?.map(x => x.split('/')) ?? [],
    })

    interface Patterns {
        included: string[][]
        excluded: string[][]
    }

    function matchSegment(name: string, pattern: string) {
        const starIndex = pattern.indexOf('*')
        if (starIndex === -1) {
            return name === pattern
        }

        return name.startsWith(pattern.slice(0, starIndex)) && name.endsWith(pattern.slice(starIndex+1))
    }

    function matchFile(name: string, patterns: Patterns) {
        function matchGroup(group: string[][]) {
            for (const p of group) {
                if (p.length === 1) {
                    if (matchSegment(name, p[0])) {
                        return true
                    }
                } else if (p.length === 2) {
                    if (p[0] === '**') {
                        if (matchSegment(name, p[1])) {
                            return true
                        }
                    }
                }
            }

            return false
        }

        if (matchGroup(patterns.excluded)) {
            return false
        }

        return matchGroup(patterns.included) || patterns.included.length === 0
    }

    function getNextPatterns(base: Patterns, name: string) {
        const included: string[][] = []
        const excluded: string[][] = []

        for (const p of base.excluded) {
            if (p.length === 1) {
                if (matchSegment(name, p[0])) {
                    return
                }
            } else {
                if (p[0] === '**') {
                    if (p.length > 1 && matchSegment(name, p[1])) {
                        if (p.length === 2) {
                            return
                        }

                        excluded.push(p.slice(2))
                    }

                    excluded.push(p)
                } else {
                    if (matchSegment(name, p[0])) {
                        excluded.push(p.slice(1))
                    }
                }
            }
        }

        let didMatch = base.included.length === 0
        for (const p of base.included) {
            if (p.length === 1) {
                if (matchSegment(name, p[0])) {
                    didMatch = true
                    included.length = 0
                    break
                }
            } else {
                if (p[0] === '**') {
                    if (p.length > 1 && matchSegment(name, p[1])) {
                        if (p.length === 2) {
                            didMatch = true
                            included.length = 0
                            break
                        }

                        included.push(p.slice(2))
                    }

                    included.push(p)
                } else {
                    if (matchSegment(name, p[0])) {
                        included.push(p.slice(1))
                    }
                }
            }
        }

        didMatch ||= included.length > 0
        if (!didMatch) {
            return
        }

        return { included, excluded }
    }

    const {
        ignore_dot_dirs = true,
    } = opt

    const extnames = opt.extnames && opt.extnames.length > 0
        ? new Set(opt.extnames.map(x => `.${x}`)) 
        : undefined

    const excludedDirs = opt.excluded_dirnames && opt.excluded_dirnames.length > 0 
        ? new Set(opt.excluded_dirnames) 
        : undefined

    function handleError(e: any, subpath: string) {
        if (e?.code !== 'ENOENT') {
            throw e
        }

        if (state?.[subpath]) {
            changes.push({
                subpath,
                is_added: false,
                is_removed: true,
                state: state[subpath],
            })
        }
    }

    async function doVisit(subpath: string, kind: FileKind) {
        const fullpath = path.resolve(dirname, subpath)
        const stat = await fs.stat(fullpath).catch(e => {
            handleError(e, subpath)
        })

        if (!stat) {
            return
        }

        const prior = state?.[subpath]
        if (prior?.mtime === stat.mtimeMs && prior?.size === stat.size) {
            return
        }

        changes.push({
            subpath,
            is_added: prior === undefined,
            is_removed: false,
            state: {
                kind,
                size: stat.size,
                mtime: stat.mtimeMs,
            },
        })

        if (kind !== FileKind.Directory) {
            return
        }

        await visitDir(fullpath)
    }

    async function visitFileFromDir(parent: string, name: string, kind: FileKind) {
        const fullpath = path.resolve(parent, name)
        const subpath = makeRelative(dirname, fullpath)
        if (state?.[subpath] || !shouldVisit(parent, name, kind)) {
            return
        }

        return doVisit(subpath, kind)
    }

    function getPatterns(absPath: string): Patterns {
        const subpath = path.relative(dirname, absPath) || '.'
        if (patterns.has(subpath)) {
            return patterns.get(subpath)!
        }

        if (subpath === '.' || subpath === '/') {
            throw new Error(`Unexpected recursion: ${absPath}`)
        }

        const p = path.dirname(absPath)
        const base = getPatterns(p)
        if (!base) {
            throw new Error(`Failed to get parent patterns: ${absPath}`)
        }
        
        const next = getNextPatterns(base, path.basename(absPath))
        if (!next) {
            throw new Error(`Failed to get patterns: ${absPath}`)
        }

        patterns.set(subpath, next)

        return next
    }

    function shouldVisit(parent: string, name: string, kind: FileKind): boolean {
        const base = getPatterns(parent)

        if (kind === FileKind.Directory) {
            if (ignore_dot_dirs && name[0] === '.') {
                return false
            }
            
            if (excludedDirs && excludedDirs.has(name)) {
                return false
            }

            const next = getNextPatterns(base, name)
            if (!next) {
                return false
            }
    
            const subpath = makeRelative(dirname, path.resolve(parent, name))
            patterns.set(subpath, next)
            
            return true
        }

        if (extnames && !extnames.has(path.extname(name))) {
            return false
        }

        return matchFile(name, base)
    }

    async function visitDir(absPath: string) {
        const files = await fs.readDirectory(absPath)
        const promises: Promise<void>[] = []
        for (const f of files) {
            const p = visitFileFromDir(
                absPath,
                f.name,
                f.type === 'file' ? FileKind.File : FileKind.Directory,
            )

            if (p) {
                promises.push(p)
            }
        }

        await Promise.all(promises)
    }

    if (state) {
        const promises: Promise<void>[] = []
        for (const [k, v] of Object.entries(state)) {
            promises.push(doVisit(k, v.kind))
        }
        await Promise.all(promises)
    } else {
        await doVisit('.', FileKind.Directory)
    }

    const nextState = { ...state }
    for (const c of changes) {
        if (c.is_removed) {
            delete nextState[c.subpath]
        } else {
            nextState[c.subpath] = c.state
        }
    }

    const fileChanges = changes.filter(x => x.state.kind === FileKind.File)

    return {
        state: nextState,
        changes: fileChanges,
    }
}

export async function initState(dirname: string, opt: Settings | null): Promise<ArrayBufferLike> {
    const r = await nextState(dirname, opt ?? {}, undefined)

    return serializeState(r.state)
}

export interface DetectChangesResult {
    state: ArrayBufferLike
    changes: SimpleChangeEvent[]
}

export async function detectChanges(state: ArrayBufferLike | Uint8Array, dirname: string, opt: Settings | null): Promise<DetectChangesResult | null> {
    const r = await nextState(dirname, opt ?? {}, deserializeState(state instanceof Uint8Array ? state.buffer : state))

    return {
        state: serializeState(r.state),
        changes: r.changes,
    }
}
