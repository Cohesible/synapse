import * as path from 'node:path'
import { Fs } from '../system'
import { keyedMemoize, throwIfNotFileNotFoundError } from '../utils'

interface Wildcard {
    readonly type: 'wildcard'
    readonly value: '*' | '?' | '**'
}

interface Literal {
    readonly type: 'literal'
    readonly value: string
}

interface Separator {
    readonly type: 'sep'
}

interface CharacterSet {
    readonly type: 'set'
    readonly values: (string | [string, string])[]
    readonly negate?: boolean
}

type GlobComponent = 
    | Literal
    | Separator
    | Wildcard
    | CharacterSet

const enum ParseState {
    Initial,
    Set,
}

// https://www.man7.org/linux/man-pages/man7/glob.7.html
function parseGlobPattern(pattern: string) {
    let state = ParseState.Initial
    let negate = false
    let charSet: (string | [string, string])[] = []

    const components: GlobComponent[] = []
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i]
        switch (state) {
            case ParseState.Initial:
                switch (c) {
                    case '*':
                        if (pattern[i + 1] === '*') {
                            components.push({ type: 'wildcard', value: '**' })
                            i += 1
                            break
                        }
                        if (pattern[i + 1] === '?') {
                            let j = i + 2
                            while (j < pattern.length) {
                                if (pattern[j] !== '?') {
                                    break
                                }
                                j += 1
                            }
                            components.push({ type: 'wildcard', value: '*' })
                            i += j - i - 1
                            break
                        }
                    case '?':
                        components.push({ type: 'wildcard', value: c })
                        break
                    case '/':
                        components.push({ type: 'sep' })
                        break
                    case '[':
                        state = ParseState.Set
                        if (pattern[i + 1] === '!') {
                            negate = true
                            i += 1
                        }
                        break
                    default:
                        let j = i + 1
                        while (j < pattern.length) {
                            if (pattern[j] === '*' || pattern[j] === '?' || pattern[j] === '/' || pattern[j] === '[') {
                                break
                            }
                            j += 1
                        }
                        components.push({ type: 'literal', value: pattern.slice(i, j) })
                        i += j - i - 1
                        break
                }
                break
            case ParseState.Set:
                switch (c) {
                    case ']':
                        if (charSet.length > 0) {
                            components.push({ type: 'set', values: charSet, negate })
                            charSet = []
                            negate = false
                            state = ParseState.Initial
                        } else {
                            charSet.push(c)
                        }
                        break
                    case '-':
                        if (charSet.length === 0 || pattern[i + 1] === ']') {
                            charSet.push(c)
                        } else {
                            i += 1
                            const previous = charSet.pop()!
                            if (typeof previous !== 'string') {
                                throw new Error(`Invalid character range at position: ${i}`)
                            }
                            charSet.push([previous, pattern[i + 1]])
                        }
                        break
                    default:
                        charSet.push(c)
                        break
                }
        }        
    }

    if (components.length === 0) {
        throw new Error(`Bad parse: empty glob pattern`)
    }

    if (state !== ParseState.Initial) {
        throw new Error(`Bad parse: unfinished character set`)
    }

    return components
}

function splitComponents(components: GlobComponent[]) {
    const groups: Exclude<GlobComponent, Separator>[][] = []
    let cg: Exclude<GlobComponent, Separator>[] = groups[0] = []
    for (const c of components) {
        if (c.type === 'sep') {
            cg = groups[groups.length] = []
        } else {
            cg.push(c)
        }
    }
    return groups
}

const getCharCode = (v: string, caseInsensitive: boolean) => (caseInsensitive ? v.toLowerCase() : v).charCodeAt(0)

function matchCharOrRange(char: string, value: string | string[], caseInsensitive: boolean) {
    if (typeof value === 'string') {
        return caseInsensitive ? char.toLowerCase() === value.toLowerCase() : char === value
    }

    const c = getCharCode(char, caseInsensitive)
    const x = getCharCode(value[0], caseInsensitive)
    const y = getCharCode(value[1], caseInsensitive)

    return c >= x && c <= y
}

function matchSet(char: string, s: CharacterSet, caseInsensitive = false) {
    for (const v of s.values) {
        const matched = matchCharOrRange(char, v, caseInsensitive)
        if ((s.negate && !matched) || (!s.negate && matched)) {
            return true
        }
    }
    return false
}

function matchComponent(segment: string, pattern: Exclude<GlobComponent, Separator>[], matchHidden = false, caseInsensitive = false): boolean {
    if (segment[0] === '.' && !matchHidden && pattern[0].type === 'wildcard') {
        return false
    }

    let i = 0
    let j = 0
    for (j = 0; j < pattern.length; j++) {
        const current = pattern[j]
        switch (current.type) {
            case 'set':
                if (!matchSet(segment[i], current)) {
                    return false
                }
                i += 1
                break
            case 'literal':
                if (current.value !== segment.slice(i, i + current.value.length)) {
                    return false
                }
                i += current.value.length
                break
            case 'wildcard':
                switch (current.value) {
                    case '?':
                        i += 1
                        break
                    case '*':
                        while (j < pattern.length && pattern[j].type === 'wildcard') j++
                        if (j === pattern.length) {
                            return true
                        }

                        const n = pattern[j]
                        switch (n.type) {
                            case 'wildcard':
                                throw new Error('Bad state')
                            case 'literal':
                                const ni = segment.indexOf(n.value, i)
                                if (ni === -1) {
                                    return false
                                }
                                i = ni + n.value.length
                                break
                            case 'set':
                                let matched = false
                                while (i < segment.length) {
                                    if (matchSet(segment[i], n)) {
                                        matched = true
                                        i += 1
                                        break
                                    }
                                    i += 1
                                }
                                if (!matched) {
                                    return false
                                }
                                break
                        }
                        break
                    case '**':
                        return true
                }
                break
        }
    }

    return segment.length === i && pattern.length === j
}

export type GlobHost = Pick<Fs, 'stat' | 'readDirectory'>

interface PatternOptions {
    readonly exclude?: boolean
    readonly matchHidden?: boolean // Defaults to `true` when using an exclude pattern
    readonly caseInsensitive?: boolean
}

async function multiGlob(fs: GlobHost, dir: string, patterns: Exclude<GlobComponent, Separator>[][][], options = new Map<number, PatternOptions>()): Promise<string[]> {
    const res: string[] = []
    if (patterns.length === 0) {
        return res
    }

    if ([...options.values()].every(x => x.exclude) && options.size === patterns.length) {
        return res
    }

    function match(index: number, name: string, pattern: Exclude<GlobComponent, Separator>[]) {
        const opt = options.get(index)
        const matchHidden = opt?.matchHidden ?? !!opt?.exclude

        return matchComponent(name, pattern, matchHidden, opt?.caseInsensitive)
    }

    const literalSegments: [index: number, group: Literal[]][] = []
    const wildcardSegments: [index: number, group: Exclude<GlobComponent, Separator>[]][] = []
    const globstars = new Set<number>()

    for (let i = 0; i < patterns.length; i++) {
        const groups = patterns[i]
        const g = groups.shift()
        if (!g || g.length === 0) {
            continue
        }
    
        const isGlobstar = g[0].type === 'wildcard' && g[0].value === '**'
        const isWildcard = isGlobstar || g.some(x => x.type !== 'literal') // Case insensitive -> wildcard?
        if (isWildcard) {
            if (isGlobstar) {
                globstars.add(i)
            }
            wildcardSegments.push([i, g])
        } else {
            literalSegments.push([i, g as Literal[]])
        }
    }

    // Sorting
    const isExcluded = (index: number) => !!options.get(index)?.exclude
    const sortExcludedFirst = (a: number, b: number) => {
        const c = isExcluded(a)
        const d = isExcluded(b)

        return c === d ? 0 : c ? -1 : 1
    }

    wildcardSegments.sort((a, b) => sortExcludedFirst(a[0], b[0]))
    literalSegments.sort((a, b) => sortExcludedFirst(a[0], b[0]))
    //

    const matchedFiles = new Set<string>()
    const matchedDirectoriesAll = new Map<string, boolean>()
    const matchedDirectories = new Map<string, number[]>()

    const getStats = keyedMemoize((fileName: string) => fs.stat(fileName).catch(throwIfNotFileNotFoundError))

    function matchFile(index: number, name: string, filePath: string) {
        const included = !options.get(index)?.exclude
        if (included) {
            res.push(filePath)
        }
        matchedFiles.add(name)
    }

    for (let i = 0; i < literalSegments.length; i++) {
        const [j, g] = literalSegments[i]
        const literal = g.map(c => c.value).join('')
        if (matchedFiles.has(literal) || matchedDirectoriesAll.get(literal) === false) {
            continue
        }

        const p = path.join(dir, literal)
        const stats = await getStats(p) // could call this in parallel
        if (!stats) {
            continue
        }

        if (stats.type === 'directory') {
            if (patterns[j].length > 0) {
                matchedDirectories.set(literal, [j, ...(matchedDirectories.get(literal) ?? [])])
            } else {
                matchedDirectoriesAll.set(literal, !options.get(j)?.exclude)
            }
        } else if (stats.type === 'file') {
            matchFile(j, literal, p)
        }
    }

    function searchDir(name: string) {
        if (matchedDirectoriesAll.get(name) === false) {
            return
        }

        const nextPatterns: number[] = []
        for (let i = 0; i < wildcardSegments.length; i++) {
            const [j, g] = wildcardSegments[i]

            // '*' by itself does not match directories
            if (g.length === 1 && g[0].type === 'wildcard' && g[0].value === '*') {
                continue
            }

            if (globstars.has(j)) {
                if (match(j, name, g)) {
                    nextPatterns.push(j)
                }

                if (patterns[j].length === 1 && match(j, name, patterns[j][0])) {
                    const included = !options.get(j)?.exclude
                    matchedDirectoriesAll.set(name, included)
                    if (!included) {
                        return
                    }
                }
            } else if (match(j, name, g)) {
                if (patterns[j].length > 0) {
                    nextPatterns.push(j)
                } else {
                    const included = !options.get(j)?.exclude
                    matchedDirectoriesAll.set(name, included)
                    if (!included) {
                        return
                    }
                }
            }
        }

        if (matchedDirectories.has(name)) {
            nextPatterns.push(...matchedDirectories.get(name)!)
        }

        if (nextPatterns.length > 0) {        
            matchedDirectories.set(name, nextPatterns)
        }
    }

    if (wildcardSegments.length > 0) {
        const files = await fs.readDirectory(dir)
        for (const f of files) {
            if (f.type === 'directory') {
                searchDir(f.name)
            } else if (f.type === 'file' && !matchedFiles.has(f.name)) {
                for (let i = 0; i < wildcardSegments.length; i++) {
                    const [j, g] = wildcardSegments[i]

                    if (globstars.has(j)) {
                        if (patterns[j].length === 1 && match(j, f.name, patterns[j][0])) {
                            matchFile(j, f.name, path.join(dir, f.name))
                            break
                        }
                    } else if (patterns[j].length === 0) {
                        if (match(j, f.name, g)) {
                            matchFile(j, f.name, path.join(dir, f.name))
                            break
                        }
                    }
                }
            }
        }
    }    

    async function readAll(name: string) {
        // TODO: if `matchHidden` then use `*`
        const nextPatterns: typeof patterns = [splitComponents(parseGlobPattern('**/[!.]*'))]
        const nextOptions: typeof options = new Map()

        for (const i of matchedDirectories.get(name) ?? []) {
            const opt = options.get(i)
            if (!opt?.exclude && !(patterns[i][0][0].type === 'literal' && (patterns[i][0][0]as any).value.startsWith('.'))) { // FIXME: is this right?
                continue
            }

            // TODO: dedupe code w/ the `matchedDirectories` loop
            nextOptions.set(nextPatterns.length, opt ?? {})
            if (globstars.has(i)) {
                nextPatterns.push([[{ type: 'wildcard', value: '**' }], ...patterns[i]])
                nextOptions.set(nextPatterns.length, opt ?? {})
                nextPatterns.push([...patterns[i]])
            } else {
                nextPatterns.push([...patterns[i]])
            }
        }

        return multiGlob(fs, path.join(dir, name), nextPatterns, nextOptions)
    }

    const promises: Promise<string[]>[] = []

    for (const [name, included] of matchedDirectoriesAll.entries()) {
        if (included) {
            promises.push(readAll(name))
        }
    }

    for (const [name, indices] of matchedDirectories.entries()) {
        if (matchedDirectoriesAll.has(name)) {
            continue
        }

        const nextPatterns: typeof patterns = []
        const nextOptions: typeof options = new Map()
        for (const i of indices) {
            const opt = options.get(i) ?? {}
            nextOptions.set(nextPatterns.length, opt)

            if (globstars.has(i)) {
                nextPatterns.push([[{ type: 'wildcard', value: '**' }], ...patterns[i]])
                nextOptions.set(nextPatterns.length, opt)
                nextPatterns.push([...patterns[i]])
            } else {
                nextPatterns.push([...patterns[i]])
            }
        }

        promises.push(multiGlob(fs, path.join(dir, name), nextPatterns, nextOptions))
    }

    for (const arr of await Promise.all(promises)) {
        res.push(...arr)
    }

    return res
}

export function glob(fs: GlobHost, dir: string, include: string[], exclude: string[] = []) {
    const patterns = include.map(parseGlobPattern).map(splitComponents)
    const options = new Map<number, PatternOptions>()
    for (const p of exclude) {
        options.set(patterns.length, { exclude: true })

        // We implicitly globstar things that might be directories
        if (!p.startsWith('**/') && !p.includes('/') && !p.includes('*') && (!p.includes('.') || p.startsWith('.'))) {
            patterns.push(splitComponents(parseGlobPattern(`**/${p}`)))
        } else {
            patterns.push(splitComponents(parseGlobPattern(p)))
        }
    }

    return multiGlob(fs, dir, patterns, options)
}

// TODO: tests
// describe('...')
//