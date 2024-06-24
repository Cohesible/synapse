// This file will called by `install.sh` to finish setting things up

import * as os from 'node:os'
import * as path from 'node:path'
import * as child_process from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { createLocalFs, ensureDir } from '../system'
import { readKey, setKey } from './config'
import { createInstallCommands, installToUserPath, isSupportedShell } from '../pm/publish'
import { Export } from 'synapse:lib'
import { makeExecutable } from '../utils'

new Export({}) // XXX: adding this so the bundle gets optimized

export async function main(installDir: string, pkgDir: string, shell?: string) {
    const resolvedInstallDir = path.resolve(installDir)
    const resolvedPkgDir = path.resolve(pkgDir)
    process.env['SYNAPSE_INSTALL'] ||= resolvedInstallDir

    if (resolvedPkgDir.startsWith(resolvedInstallDir)) {
        console.log(`Installing to "${resolvedInstallDir}"`)
    } else {
        console.log(`Installing "${resolvedPkgDir}" to "${resolvedInstallDir}"`)
    }

    try {
        await finishInstall(resolvedInstallDir, resolvedPkgDir, shell)
    } catch (e) {
        console.log('Install failed!', e)
        process.exitCode = 1

        if ((e as any).code === 'EPERM' && process.platform === 'win32') {
            process.exitCode = 2
        }
    }
}

function getExec(name: string) {
    return process.platform === 'win32' ? `${name}.exe` : name
}

function getExecutablePath(pkgDir: string, name: string) {
    return path.resolve(pkgDir, 'bin', getExec(name))
}

function getToolPath(pkgDir: string, name: string) {
    return path.resolve(pkgDir, 'tools', getExec(name))
}

function getCwdVar() {
    return process.platform === 'win32' ? '%~dp0' : '$SCRIPT_DIR'
}

function getVarArgs() {
    return process.platform === 'win32' ? '%*' : '"$@"'
}

async function createWindowsExecutableScript(cliRelPath: string, nodeRelPath: string, binDir: string) {
    const nodeArgs = ['"%CLI_PATH%"', '%*']

    const cwd = '%~dp0'
    const contents = `
@ECHO OFF

SET "SYNAPSE_PATH=%0"
SET "NODE_PATH=${cwd}/${nodeRelPath}"
SET "CLI_PATH=${cwd}/${cliRelPath}"

"%NODE_PATH%" ${nodeArgs.join(' ')}
`.trim()

    const dest = path.resolve(binDir, 'synapse.cmd')
    const fs = createLocalFs()
    await fs.writeFile(dest, contents, { mode: 0o755 })

    return dest
}

type PackageType = 'sea' | 'script'

async function createExecutableScript(pkgDir: string, installDir: string, pkgType: PackageType = 'script') {
    const fs = createLocalFs()
    const binDir = path.resolve(installDir, 'bin')
    const seaPath = getExecutablePath(pkgDir, 'synapse')
    const nodeRelPath = path.relative(binDir, getExecutablePath(pkgDir, 'node'))
    const cliRelPath = path.relative(binDir, path.resolve(pkgDir, 'dist', 'cli.js'))
    if (await fs.fileExists(seaPath)) {
        pkgType = 'sea'
    }
    
    const nodeArgs: string[] = []

    if (process.platform === 'win32') {
        if (pkgType !== 'sea') {
            return createWindowsExecutableScript(cliRelPath, nodeRelPath, binDir)
        }

        const dest = path.resolve(binDir, 'synapse.exe')

        try {
            await fs.link(seaPath, dest, { symbolic: true, typeHint: 'file' })
        } catch (e) {
            if ((e as any).code !== 'EPERM') {
                throw e
            }

            // Windows "junctions" don't require admin
            // XXX: need to rename `terraform.exe` so we don't shadow existing installs
            await fs.link(path.dirname(seaPath), path.dirname(dest), { symbolic: true, typeHint: 'junction' })
        }

        return dest
    }

    const dest = path.resolve(binDir, 'synapse')

    if (pkgType !== 'sea') {
        nodeArgs.push(`"$SCRIPT_DIR/${cliRelPath}"`, '"$@"')

        const executable = `
#!/bin/sh

export SYNAPSE_PATH="$0"
SCRIPT_DIR=$(dirname -- "$( readlink -f -- "$0"; )");

exec "$SCRIPT_DIR/${nodeRelPath}" ${nodeArgs.join(' ')}
        `.trim()
            
        await fs.writeFile(dest, executable, { mode: 0o755 })
    } else {
        await makeExecutable(seaPath)
        await fs.link(seaPath, dest, { symbolic: true })
    }

    return dest
}

async function maybeInstallToGitHubRunner(installDir: string) {
    if (process.env.GITHUB_ENV) {
        console.log("Probably in a GitHub runner, installing to workflow paths")
        await appendFile(process.env.GITHUB_ENV, `SYNAPSE_INSTALL=${installDir}\n`)

        if (process.env.GITHUB_PATH) {
            await appendFile(process.env.GITHUB_PATH, `${path.resolve(installDir, 'bin')}\n`)
        }    
    }
}

async function finishInstall(installDir: string, pkgDir: string, shell?: string) {
    const fs = createLocalFs()
    const newTfPath = getToolPath(pkgDir, 'terraform')
    const newEsbuildPath = getToolPath(pkgDir, 'esbuild')

    const synapse = await createExecutableScript(pkgDir, installDir)


    // XXX: needed until the packages are hosted somewhere
    // Ideally this should be a fallback for hosted versions rather than an override
    const overrides: Record<string, string> = { synapse: pkgDir }
    const builtinPackagesDir = path.resolve(pkgDir, 'packages')
    for (const f of await fs.readDirectory(builtinPackagesDir)) {
        overrides[f.name] = path.resolve(builtinPackagesDir, f.name)
    }

    const oldOverrides = await readKey<any>('projectOverrides')
    await setKey('projectOverrides', { ...overrides, ...oldOverrides })

    await Promise.all([
        setKey('terraform.path', newTfPath),
        makeExecutable(newTfPath),
    ])

    await Promise.all([
        setKey('esbuild.path', newEsbuildPath),
        makeExecutable(newEsbuildPath),    
    ])

    await setKey('typescript.libDir', path.resolve(pkgDir, 'dist'))

    // Make sure things work
    // `shell: true` is required to spawn `.cmd` files
    const out = child_process.spawnSync(synapse, ['--version'], { encoding: 'utf-8', shell: synapse.endsWith('.cmd') })
    if (out.status !== 0) {
        if (out.status === null && out.error) {
            throw new Error(`Failed to run Synapse`, { cause: out.error })
        }
        throw new Error(`Failed to run Synapse: ${out.stdout + '\n' + out.stderr}`)
    }

    await maybeInstallToGitHubRunner(installDir)

    if (process.platform === 'win32') {
        return
    }

    const completionsScriptPath = path.resolve(installDir, 'completions', 'synapse.sh')

    await fs.writeFile(
        completionsScriptPath,
        await fs.readFile(path.resolve(pkgDir, 'dist', 'completions.sh'))
    )

    if (!shell || !isSupportedShell(shell)) {
        console.log('Synapse was not added to your PATH.')
        console.log('You will have to manually update relevant config files with the following:')
        const commands = createInstallCommands(installDir, false, completionsScriptPath)
        for (const c of commands) {
            console.log(`    ${c}`)
        }
        return
    }

    await installToUserPath(shell, installDir)
}
