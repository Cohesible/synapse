#!/usr/bin/env node

import * as synapse from '..'
import * as path from 'node:path'
import * as inspector from 'node:inspector'
import { getLogger } from '../logging'
import { LogLevel, logToFile, logToStderr, purgeOldLogs, validateLogLevel } from './logger'
import { CancelError, dispose, getCurrentVersion, runWithContext, setContext, setCurrentVersion } from '../execution'
import { RenderableError, colorize, getDisplay, printLine } from './ui'
import { showUsage, executeCommand, runWithAnalytics, removeInternalCommands } from './commands'
import { getCiType } from '../utils'
import { resolveProgramBuildTarget } from '../workspaces'
import { devLoader } from '../runtime/nodeLoader'
import { readFileSync, writeFileSync } from 'node:fs'

async function _main(argv: string[]) {
    if (argv.length === 0) {
        return showUsage()
    }

    const [cmd, ...params] = argv

    await runWithAnalytics(cmd, async () => {
        await executeCommand(cmd, params)
    }).finally(() => synapse.shutdown())
}

function isProbablyRelativePath(arg: string) {
    if (arg[0] !== '.') return false

    if (arg[1] === '/' || (arg[1] === '.' && arg[2] === '/')) {
        return true
    }

    if (process.platform === 'win32') {
        return arg[1] === '\\' || (arg[1] === '.' && arg[2] === '\\')
    }

    return false
}

function isMaybeCodeFile(arg: string) {
    if (path.isAbsolute(arg)) return true
    if (isProbablyRelativePath(arg)) return true
    if (arg.length <= 3) return false

    switch (path.extname(arg)) {
        case '':
            return false

        case '.js':
        case '.cjs':
        case '.mjs':
            return true

        case '.ts':
        case '.cts':
        case '.mts':
            return true                
    }

    return false
}

function getLogLevel(): LogLevel | 'off' | undefined {
    const envVar = process.env['SYNAPSE_LOG']
    if (!envVar) {
        return
    }

    if (envVar === 'off') {
        return envVar
    }

    return validateLogLevel(envVar.toLowerCase())
}

const isSea = !!process.env['BUILDING_SEA']
const isProdBuild = process.env.SYNAPSE_ENV === 'production'

if (isSea) {
    const pkgPath = process.env.CURRENT_PACKAGE_DIR
        ? path.resolve(process.env.CURRENT_PACKAGE_DIR, 'package.json')
        : path.resolve(__dirname, '..', 'package.json')

    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    setCurrentVersion(pkgJson.version, process.env['GITHUB_SHA'])
}

export function main(...args: string[]) {
    const arg0 = args[0]
    if (arg0 === '--version') {
        const version = getCurrentVersion()
        if (args[1] === '--json') {
            process.stdout.write(JSON.stringify(version, undefined, 4) + '\n')
        } else {
            const includeRevision = !isProdBuild || args[1] === '--revision'
            const versionStr = `synapse ${version.semver}${(version.revision && includeRevision) ? `-${version.revision}` : ''}`
            process.stdout.write(versionStr + '\n')
        }
        return
    }

    if (process.env['SYNAPSE_USE_DEV_LOADER'] && isSea) {
        process.argv.splice(1, 1)
        delete process.env['SYNAPSE_USE_DEV_LOADER']

        return devLoader(arg0)
    }

    // TODO: if we didn't get a command _and_ `stdin` is piped, parse it as a `.ts` file


    if (isSea) {
        // XXX: this is done for typescript/esbuild
        // It seems like `process.argv[0]` isn't resolved?
        const execPath = process.platform !== 'darwin'
            ? require('node:fs').realpathSync(process.argv[0]) 
            : process.argv[0]

        globalThis.__filename = path.resolve(path.dirname(path.dirname(execPath)), 'dist', 'cli.js')
        globalThis.__dirname = path.dirname(globalThis.__filename)

        // XXX: mostly used as a fallback for "standalone" installs
        if (!process.env['SYNAPSE_INSTALL']) {
            let currentDir = globalThis.__dirname
            const fs = require('node:fs') as typeof import('node:fs')
            while (true) {
                if (fs.existsSync(path.resolve(currentDir, 'config.json'))) {
                    process.env['SYNAPSE_INSTALL'] = currentDir
                    break
                }

                const next = path.dirname(currentDir)
                if (next === currentDir || next === '.') {
                    break
                }
                currentDir = next
            }
        }
    }

    const selfPath = globalThis.__filename ?? __filename
    const selfBuildType = isSea ? 'sea' as const : undefined

    if (isSea && arg0 && arg0.startsWith('sea-asset:')) {
        process.argv.splice(isSea ? 1 : 2, 1)

        return runWithContext(
            { selfPath, selfBuildType }, 
            () => synapse.runUserScript(arg0, process.argv.slice(2))
        )
    }

    // `pointer:<sha256 hash hex>` has a length of 72
    // `pointer:<hash>:<hash>` has a length of 137
    if (arg0 && (arg0.length === 72 || arg0.length === 137) && arg0.startsWith('pointer:')) {
        process.argv.splice(isSea ? 1 : 2, 1)

        return resolveProgramBuildTarget(process.cwd()).then(buildTarget => {
            return runWithContext(
                { selfPath, selfBuildType, buildTarget }, 
                () => synapse.runUserScript(arg0, process.argv.slice(2))
            )
        })
    }

    // TODO: -p (print) and -e (eval)
    if (arg0 && isMaybeCodeFile(arg0)) {
        process.argv.splice(isSea ? 1 : 2, 1)

        const fs = require('node:fs') as typeof import('node:fs')
        const resolved = fs.realpathSync(path.resolve(arg0))
        setContext({ selfPath, selfBuildType })

        return synapse.runUserScript(resolved, process.argv.slice(2))
    }

    Error.stackTraceLimit = 100
    process.on('uncaughtException', e => getLogger().error('Uncaught exception', e))
    process.on('unhandledRejection', e => getLogger().error('Unhandled rejection', e))

    // if (args.includes('--inspect')) {
    //     const inspector = require('node:inspector') as typeof import('node:inspector')
    //     inspector.open()
    //     inspector.waitForDebugger()
    // }

    function tryGracefulExit(exitCode = process.exitCode) {
        let loops = 0

        function loop() {
            const activeResources = process.getActiveResourcesInfo().filter(x => x !== 'TTYWrap' && x !== 'Timeout')
            if (activeResources.length === 0) {
                process.exit(exitCode)
            } else {
                setTimeout(loop, Math.min(loops++, 10)).unref()
            }
        }

        loop()
    }

    async function createProfiler(): Promise<AsyncDisposable> {
        const session = new inspector.Session()
        session.connect()

        await new Promise<void>((resolve, reject) => {
            session.post('Profiler.enable', err => err ? reject(err) : resolve())
        })

        await new Promise<void>((resolve, reject) => {
            session.post('Profiler.setSamplingInterval', { interval: 100 }, err => err ? reject(err) : resolve())
        })

        await new Promise<void>((resolve, reject) => {
            session.post('Profiler.start', err => err ? reject(err) : resolve())
        })

        function dispose() {
            return new Promise<void>((resolve, reject) => {
                session.post('Profiler.stop', (err, res) => {
                    if (!err) {
                        writeFileSync('./profile.cpuprofile', JSON.stringify(res.profile))
                        resolve()
                    } else {
                        reject(err)
                    }
                })
            })
        }

        return { [Symbol.asyncDispose]: dispose }
    }

    function getProfiler() {
        if (!process.env['CPU_PROF']) {
            return
        }

        return createProfiler()
    }

    async function runWithLogger() {
        purgeOldLogs().catch(e => console.error('Failed to purge logs', e))

        const isCi = !!getCiType()
        const logLevel = getLogLevel()
        const disposable = logLevel !== 'off' 
            ? isCi ? logToStderr(getLogger(), logLevel) : logToFile(getLogger(), logLevel) 
            : undefined

        let didThrow = false

        function handleUnknownError(e: unknown) {
            try {
                if (process.stdout.isTTY) {
                    printLine(colorize('red', (e as any).message))
                } else {
                    process.stderr.write((e as any).message + '\n')
                }

                getLogger().error(e)
            } catch {
                console.error(e)
            }
        }

        try {
            await using profiler = await getProfiler()
            await _main(args)
        } catch (e) {
            if (e instanceof CancelError) {
                didThrow = true
                return
            }

            if (e instanceof RenderableError) { 
                try {
                    await e.render()
                } catch (e2) {
                    getLogger().log('Failed to render', e2)
                    handleUnknownError(e)
                }
            } else {
                handleUnknownError(e)
            }

            didThrow = true
        } finally {
            await dispose()
            await disposable?.dispose() // No more log events will be emitted

            setTimeout(() => {
                process.stderr.write(`Forcibly shutting down\n`)
                if (process.env['SYNAPSE_DEBUG'] || process.env['CI']) {
                    process.stderr.write(`Active resources: ${(process as any).getActiveResourcesInfo()}\n`, () => {
                        process.exit(didThrow ? 1 : undefined)
                    })
                } else {
                    process.exit(didThrow ? 1 : undefined)
                }
            }, 5000).unref()

            if (process.stdout.isTTY) {
                tryGracefulExit(didThrow ? 1 : undefined)
            } else {
                process.stdin.unref?.()
                process.stdout.unref?.()
                process.stderr.unref?.()    
                process.exitCode = process.exitCode || (didThrow ? 1 : 0)
            }
        }
    }

    const ac = new AbortController()
    if (process.stdout.isTTY) {
        let sigintCount = 0
        process.on('SIGINT', () => {
            sigintCount += 1
            if (sigintCount === 1) {
                getLogger().debug(`Received SIGINT`)
                ac.abort(new CancelError('Received SIGINT'))
            } else if (sigintCount === 2) {
                getDisplay().dispose().then(() => {
                    process.exit(1)
                })
            } else if (sigintCount === 3) {
                process.exit(2)
            }
        })
    } else {
        process.on('SIGINT', () => {
            getLogger().debug(`Received SIGINT`)
            ac.abort(new CancelError('Received SIGINT'))
        })
    }

    return runWithContext({ abortSignal: ac.signal, selfPath, selfBuildType }, runWithLogger).catch(e => {
        process.stderr.write((e as any).message + '\n')
        process.exit(100)
    })
}

function seaMain() {
    const v8 = require('node:v8') as typeof import('node:v8')
    if (!v8.startupSnapshot.isBuildingSnapshot()) {
        throw new Error(`BUILDING_SEA was set but we're not building a snapshot`)
    }

    v8.startupSnapshot.setDeserializeMainFunction(() => {
        const args = process.argv.slice(2)

        return main(...args)
    })
}

if (isSea) {
    if (isProdBuild) {
        removeInternalCommands()
    }
    if (!process.env.SKIP_SEA_MAIN) {
        seaMain()
    }
} else {
    main(...process.argv.slice(2))
}

// Note: currently unable to bundle the serialized form of this file due to a cycle somewhere
