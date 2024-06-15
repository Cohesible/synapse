import { getLogger } from '../..'
import * as path from 'node:path'
import { getFs } from '../../execution'
import { glob } from '../../utils/glob'
import { CommandDescriptor, enumTypeSym, fileTypeSym, isEnumType, isFileType } from '../commands'
// import { createFileAsset } from 'synapse:lib'

// const completionsScript = createFileAsset(path.resolve(__dirname, 'completion.sh'))
// completionsScript.

function parseArgsForCompletion(args: string[], desc: CommandDescriptor) {
    let argPosition = 0

    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '--' && i < args.length - 1) {
            return false
        }

        const isLongSwitch = a.startsWith('--')
        const isShortSwitch = !isLongSwitch && a.startsWith('-')
        if (isShortSwitch || isLongSwitch) {
            const n = a.slice(isShortSwitch ? 1 : 2)
            const opt = isLongSwitch 
                ? desc.options?.find(x => x.name === n || x.aliases?.includes(n))
                : desc.options?.find(x => x.shortName === n)

            if (!opt || opt.type === 'boolean') {
                continue
            }

            if (i === args.length - 1 || i === args.length - 2) {
                return { ...opt, kind: 'option' } as const
            }
        } else {
            const currentArg = desc.args?.[argPosition]
            if (!currentArg) {
                return
            }

            if (!currentArg.allowMultiple) {
                if (i === args.length - 1) {
                    break
                }
                argPosition += 1
            }
        }
    }

    const arg = desc.args?.[argPosition]

    return arg ? { ...arg, kind: 'arg' } as const : undefined
}

const env = process.env.SYNAPSE_ENV
const showInternal = env !== 'production'

export async function handleCompletion(args: string[], commands: Record<string, CommandDescriptor>) {
    const { COMP_CWORD, COMP_LINE, COMP_POINT, COMP_FISH } = process.env

    if (COMP_CWORD === undefined || COMP_LINE === undefined || COMP_POINT === undefined) {
        return
    }

    const w = +COMP_CWORD
    const words = args.map(unescape)
    const word = words[w] ?? ''

    // Find a command
    if (w === 1) {
        const matches = Object.keys(commands)
            .filter(x => !commands[x].hidden && (showInternal || !commands[x].internal))
            .filter(x => x.startsWith(word))

        // Try looking for a file to execute
        // This is 100% not the correct/best way to do completions for files
        if (matches.length === 0) {
            const cwd = process.cwd()
            const r = path.resolve(cwd, word)
            const dir = r !== cwd ? word.endsWith('/') ? word : path.dirname(r) : cwd
            const base = r !== cwd && !word.endsWith('/') ? path.basename(r) : ''
            const files = await getFs().readDirectory(dir)

            const lastSep = word.lastIndexOf('/')
            const prefix = lastSep !== -1 ? word.slice(0, lastSep + 1) : ''

            const prefixMatched = files
                .filter(x => x.name.startsWith(base))
                .filter(x => x.type === 'directory' || ((x.name.endsWith('.ts') && !x.name.endsWith('.d.ts'))|| x.name.endsWith('.js')))
                .map(x => `${prefix}${x.name}`)

            return emitCompletions(prefixMatched)
        }

        return emitCompletions(matches)
    }

    const cmd = commands[words[1]]
    if (!cmd) {
        return
    }

    function filterOpts(opt: NonNullable<CommandDescriptor['options']>) {
        return opt.filter(o => showInternal || !o.hidden)
    }

    function emitOptions(opt: NonNullable<CommandDescriptor['options']>) {
        const trimmedWord = word.startsWith('--') ? word.slice(2) : word.startsWith('-') ? word.slice(1) : word
        const names = filterOpts(opt).map(x => x.name).filter(x => x.startsWith(trimmedWord))
        const alreadyAddedOpts = new Set(
            words.slice(0, -1)
                .filter(x => x.startsWith('--'))
                .map(x => x.slice(2))
                .filter(x => !opt.find(o => o.name === x)?.allowMultiple)
        )

        return emitCompletions(names.filter(x => !alreadyAddedOpts.has(x)).map(x => `--${x}`))
    }

    const p = parseArgsForCompletion(args.slice(2), cmd)
    if (p === false) {
        return
    }
    
    if (p === undefined) {
        // we can only complete options now
        const opts = cmd.options
        if (!opts) {
            return
        }

        return emitOptions(opts)
    } else {
        if (p.kind !== 'option' && cmd.options && word.startsWith('-')) { 
            return emitOptions(cmd.options)
        }

        // complete input to arg/opt
        if (isFileType(p.type)) {
            const cwd = process.cwd()
            const files = await glob(getFs(), cwd, [...p.type[fileTypeSym]].map(x => `**/*${x}`), ['node_modules'])
            const previous = new Set(words)

             // TODO: these need to be filtered to a single level
            const prefixMatched = files.map(x => path.relative(cwd, x))
                .filter(x => !previous.has(x))
                .filter(f => f.startsWith(word))

            if (prefixMatched.length === 0 && !word && cmd.options && p.kind !== 'option' && (p.allowMultiple || p.optional)) {
                return emitOptions(cmd.options)
            }

            return emitCompletions(prefixMatched)
        } else if (isEnumType(p.type)) {
            const values = [...p.type[enumTypeSym]].filter(x => typeof x === 'string') as string[]
            return emitCompletions(values.filter(x => x.startsWith(word)))
        }

        // TODO: auto-complete symbols

        if (p.kind !== 'option' && (p.allowMultiple || p.optional) && !word && cmd.options) {
            return emitOptions(cmd.options)
        }
    }
}

function emitCompletions(comps: string[]) {
    if (comps.length === 0) {
        return
    }

    return new Promise<void>(r => process.stdout.write(comps.join('\n'), () => r()))
}

const unescape = (w: string) => w.charAt(0) === '\'' 
    ? w.replace(/^'|'$/g, '') 
    : w.replace(/\\ /g, ' ')