import * as path from 'node:path'
import { getFs } from '../execution'
import { createNpmLikeCommandRunner } from '../pm/publish'
import { getWorkingDir } from '../workspaces'
import { glob } from '../utils/glob'
import { isNonNullable } from '../utils'

// Logic for an internal test runner

// Commands are treated like scripts in `package.json`
const commandsDirective = '!commands'
const finallyCommand = '@finally'
const expectFailCommand = '@expectFail'
const skipCleanCommand = '@skipClean'

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

    return commands
}

interface RunTestOptions {
    baseline?: boolean
    snapshot?: boolean
    synapseCmd?: string
}

export async function runInternalTestFile(fileName: string, opt?: RunTestOptions) {
    const text = await getFs().readFile(fileName, 'utf-8')
    const commands = parseCommands(text)
    if (!commands || commands.length === 0) {
        throw new Error(`No commands found in test file: ${fileName}`)
    }
    
    return runTest(fileName, commands, opt)
}

function renderCommands(commands: string[], synapseCmd = process.env.SYNAPSE_CMD) {
    if (synapseCmd) {
        commands = commands.map(cmd => cmd.replaceAll('synapse', synapseCmd))
    }

    let shouldClean = true
    const inner: string[] = []
    const statements: string[] = []
    for (let i = 0; i < commands.length; i++) {
        const c = commands[i]
        if (c.startsWith(finallyCommand)) {
            statements.push(c.slice(finallyCommand.length).trim())
            continue
        }

        if (c.startsWith(skipCleanCommand)) {
            shouldClean = false
            continue
        }

        // Skip all `@` commands for forwards compat
        if (c.startsWith('@')) {
            continue
        }

        const index = c.indexOf(expectFailCommand)
        if (index !== -1) {
            const command = `${c.slice(0, index)}; if [[ $? -eq 0 ]]; then echo "Expected command ${i} to fail"; false; fi`
            inner.push(command)
        } else {
            inner.push(c)
        }
    }

    if (statements.length > 0) {
        statements.unshift('export _EXIT_CODE=$?')
        statements.push('exit $_EXIT_CODE')
    }

    const cmd = [
        inner.join(' && '),
        ...statements,
    ].join('; ')

    return { cmd, shouldClean }
}

function getSynapseCmd() {
    if (process.env.SYNAPSE_CMD) {
        return process.env.SYNAPSE_CMD
    }

    const runIndex = process.argv.indexOf('run')
    if (runIndex <= 0) {
        return
    }

    // TODO: we need to get rid of `SYNAPSE_USE_DEV_LOADER` for this to work correctly
    return process.argv[runIndex - 1]
}

async function cleanFixtures(dirs: Iterable<string>, synapseCmd = process.env.SYNAPSE_CMD || 'synapse') {
    const shell = process.platform === 'win32' ? 'bash' : undefined

    for (const dir of dirs) {
        const runner = createNpmLikeCommandRunner(dir, undefined, 'inherit', shell)
        await runner(synapseCmd, ['destroy', '--yes', '--clean-after'])
    }
}

function parseDirectories(fileName: string, commands: string[]) {
    const workingDir = path.dirname(fileName)
    const dirs = new Set<string>([workingDir])
    for (const cmd of commands) {
        // Naive impl. only works for simple cases
        const [_, dir] = cmd.match(/cd ([^\s]+)/) ?? []
        if (dir) {
            dirs.add(path.resolve(workingDir, dir))
        }
    }

    return dirs
}

async function runTest(fileName: string, commands: string[], opt?: RunTestOptions) {
    // Force `bash` on windows
    const shell = process.platform === 'win32' ? 'bash' : undefined
    const { cmd, shouldClean } = renderCommands(commands, opt?.synapseCmd)

    async function runCommands() {
        if (opt?.snapshot) {
            const runner = createNpmLikeCommandRunner(path.dirname(fileName), undefined, ['inherit', 'pipe', 'inherit'], shell)
            const result = await runner(cmd)
            return
        }
    
        const runner = createNpmLikeCommandRunner(path.dirname(fileName), undefined, 'inherit', shell)
        await runner(cmd)
    }

    try {
        await runCommands()
    } finally {
        if (shouldClean) {
            const dirs = parseDirectories(fileName, commands)
            await cleanFixtures(dirs, opt?.synapseCmd)
        }
    }
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

    console.log(`${tests.length - failures.length} tests passed`)

    if (failures.length > 0) {
        for (const [fileName, e] of failures) {
            console.log(`Test "${path.relative(testDir, fileName)}" failed`, e)
        }

        return 1
    }
}
