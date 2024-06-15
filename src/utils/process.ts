import * as child_process from 'node:child_process'

interface RunCommandOptions extends child_process.SpawnOptions {
    readonly input?: string | Uint8Array // Passed directly to stdin
    /** Defaults to `utf-8` */
    readonly encoding?: BufferEncoding | 'none'
}

export function runCommand(executable: string, args: string[], opts?: RunCommandOptions): Promise<string>
export function runCommand(executable: string, args: string[], opts: RunCommandOptions & { encoding: 'none' }): Promise<Buffer>
export function runCommand(executable: string, args: string[], opts: RunCommandOptions = {}) {
    const runner = createCommandRunner(opts)

    return runner(executable, args) as Promise<string | Buffer>
}

export function runCommandStdErr(executable: string, args: string[], opts?: RunCommandOptions): Promise<string>
export function runCommandStdErr(executable: string, args: string[], opts: RunCommandOptions & { encoding: 'none' }): Promise<Buffer>
export async function runCommandStdErr(executable: string, args: string[], opts: RunCommandOptions = {}) {
    const proc = child_process.spawn(executable, args, { ...opts })
    const result = await toPromise(proc)

    return result.stderr
}

export function execCommand(cmd: string, opts: child_process.ExecOptions = {}) {
    const runner = createCommandRunner(opts)

    return runner(cmd)
}

export function createCommandRunner(opts?: RunCommandOptions): (cmd: string, args?: string[]) => Promise<string>
export function createCommandRunner(opts: RunCommandOptions & { encoding: 'none' }): (cmd: string, args?: string[]) => Promise<Buffer>
export function createCommandRunner(opts: RunCommandOptions = {}) {
    async function runCommand(executableOrCommand: string, args?: string[]): Promise<string | Buffer> {
        const proc = !args
            ? child_process.spawn(executableOrCommand, { shell: true, ...opts })
            : child_process.spawn(executableOrCommand, args, { shell: true, ...opts })

        // Likely not needed
        if (proc.exitCode || proc.signalCode) {
            throw new Error(`Non-zero exit code: ${proc.exitCode} [signal ${proc.signalCode}]`)
        }

        if (opts.input) {
            proc.stdin?.end(opts.input)
        }

        const result = await toPromise(proc, opts?.encoding === 'none' ? undefined : (opts.encoding ?? 'utf-8'))

        return result.stdout
    }

    return runCommand
}

function toPromise(proc: child_process.ChildProcess, encoding?: BufferEncoding) {
    const stdout: any[] = []
    const stderr: any[] = []
    proc.stdout?.on('data', chunk => stdout.push(chunk))
    proc.stderr?.on('data', chunk => stderr.push(chunk))

    // XXX: needed to capture original trace
    const _err = new Error()

    function getResult(chunks: any[], enc = encoding) {
        const buf = Buffer.concat(chunks)

        return enc ? buf.toString(enc) : buf
    }

    const p = new Promise<{ stdout: string | Buffer; stderr: string | Buffer}>((resolve, reject) => {
        function onError(e: unknown) {
            reject(e)
            proc.kill()
        }

        proc.on('error', onError)
        proc.on('close', (code, signal) => {
            if (code !== 0) {
                const message = `Non-zero exit code: ${code} [signal ${signal}]`
                const err = Object.assign(
                    new Error(message), 
                    { code, stdout: getResult(stdout), stderr: getResult(stderr, 'utf-8') },
                    { stack: message + '\n' + _err.stack?.split('\n').slice(1).join('\n') }
                )

                reject(err)
            } else {
                resolve({ stdout: getResult(stdout), stderr: getResult(stderr) })
            }
        })

        // Likely not needed
        if (!proc.stdout && !proc.stderr) {
            proc.on('exit', (code, signal) => {
                if (code !== 0) {
                    const err = Object.assign(
                        new Error(`Non-zero exit code: ${code} [signal ${signal}]`), 
                        { code, stdout: '', stderr: '' }
                    )
    
                    reject(err)
                } else {
                    resolve({ stdout: '', stderr: '' })
                }
            })
        }
    })

    return p
}

export function patchPath(dir: string, env = process.env) {
    return {
        ...env,
        PATH: `${dir}${env.PATH ? `:${env.PATH}` : ''}`,
    }
}

export async function which(executable: string) {
    if (process.platform === 'win32') {
        return runCommand('where', [executable])
    }

    return runCommand('which', [executable])
}
