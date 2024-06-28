import * as path from 'node:path'
import { getFs, isSelfSea } from '../execution'
import { createNpmLikeCommandRunner } from '../pm/publish'
import { getWorkingDir } from '../workspaces'
import { glob } from '../utils/glob'
import { isNonNullable } from '../utils'

// Logic for an internal test runner

// Commands are treated like scripts in `package.json`
const commandsDirective = '!commands'

function parseCommands(text: string) {
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
    // if (synapseCmd) {
    //     return commands.map(cmd => cmd.replaceAll('synapse', synapseCmd))
    // }

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
    
    return runTest(fileName, commands, opt)
}

async function runTest(fileName: string, commands: string[], opt?: RunTestOptions) {
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

async function findTests(testDir: string, patterns = ['**/*.ts']) {
    const tsFiles = await glob(getFs(), testDir, patterns, ['node_modules', 'out', 'dist'])

    const maybeTests = await Promise.all(tsFiles.map(async f => {
        const text = await getFs().readFile(f, 'utf-8')
        const commands = parseCommands(text)
        if (!commands || commands.length === 0) {
            return
        }

        return {
            fileName: f,
            commands,
        }
    }))

    return maybeTests.filter(isNonNullable)
}

export async function main(...patterns: string[]) {
    const testDir = path.resolve(getWorkingDir(), 'test', 'fixtures')
    const tests = await findTests(testDir, patterns.length === 0 ? undefined : patterns)

    const failures: [string, unknown][] = []
    for (const test of tests) {
        try {
            await runTest(test.fileName, test.commands)
        } catch (e) {
            failures.push([test.fileName, e])
        }
    }

    if (failures.length > 0) {
        for (const [fileName, e] of failures) {
            console.log(`Test "${path.relative(testDir, fileName)}" failed`, e)
        }

        return 1
    }
}
