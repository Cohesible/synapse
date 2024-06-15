import * as path from 'node:path'
import { getFs, isSelfSea } from '../execution'
import { createNpmLikeCommandRunner } from '../pm/publish'

// Logic for an internal test runner

// Commands are treated like scripts in `package.json`
const commandsDirective = '!commands'

function parseCommands(text: string, synapseCmd = isSelfSea() ? undefined : 'syn') {
    const lines = text.split('\n')
    const directive = lines.findIndex(l => l.startsWith(`// ${commandsDirective}`))
    if (directive === -1) {
        return
    }

    const commands: string[] = []
    for (let i = directive + 1; i < lines.length; i++) {
        const line = lines[i]
        if (!line.startsWith('//')) break
        
        const [command, ...rest] = line.slice(2).split('#')
        const comment = rest.join('#')

        const trimmed = command.trim()
        if (trimmed) {
            commands.push(trimmed)
        }
    }

    // Used to support partial dev builds
    if (synapseCmd) {
        return commands.map(cmd => cmd.replaceAll('synapse', synapseCmd))
    }

    return commands
}

interface RunTestOptions {
    baseline?: boolean
    snapshot?: boolean
}

export async function runInternalTestFile(fileName: string, opt?: RunTestOptions) {
    const text = await getFs().readFile(fileName, 'utf-8')
    const commands = parseCommands(text)
    if (!commands || commands.length === 0) {
        throw new Error(`No commands found in test file: ${fileName}`)
    }
    
    if (opt?.snapshot) {
        const runner = createNpmLikeCommandRunner(path.dirname(fileName), undefined, ['inherit', 'pipe', 'inherit'])
        const cmd = commands.join(' && ')
        const result = await runner(cmd)
        return
    }

    const runner = createNpmLikeCommandRunner(path.dirname(fileName), undefined, 'inherit')
    const cmd = commands.join(' && ')

    await runner(cmd)
}
