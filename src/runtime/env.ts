import * as path from 'node:path'
import { getWorkingDir } from '../workspaces'
import { getBuildTarget } from '../execution'
import { getLogger } from '../logging'
import { Fs } from '../system'
import { throwIfNotFileNotFoundError } from '../utils'

// Maybe do backticks too
function unquote(str: string) {
    const isSingleQuoted = str[0] === "'" && str.at(-1) === "'"
    const isDoubleQuoted = !isSingleQuoted && str[0] === '"' && str.at(-1) === '"'
    if (isSingleQuoted || isDoubleQuoted) {
        return str.slice(1, -1)
    }

    return str
}

export function parseEnvFile(text: string) {
    const result: Record<string, string> = {}

    const lines = text.split(/\r?\n/)
    for (const l of lines) {
        const sep = l.indexOf('=')
        if (sep === -1) {
            // bad parse
            continue
        }

        const key = l.slice(0, sep).trimEnd()
        const value = l.slice(sep + 1).trimStart()
        result[key] = unquote(value)
    }

    return result
}

export function getCurrentEnvFilePath() {
    const environment = getBuildTarget()?.environmentName
    const suffix = environment ? `.${environment}` : ''

    return path.resolve(getWorkingDir(), `.env${suffix}`)
}

// TODO: this isn't clean
const cachedEnvVars = new Map<string, Record<string, string>>()
export async function maybeLoadEnvironmentVariables(fs: Pick<Fs, 'readFile'>) {
    const filePath = getCurrentEnvFilePath()
    if (cachedEnvVars.has(filePath)) {
        return cachedEnvVars.get(filePath)!
    }

    getLogger().debug(`Trying to load environment variables from "${filePath}"`)

    const text = await fs.readFile(filePath, 'utf-8').catch(throwIfNotFileNotFoundError)
    if (!text) {
        return
    }

    const vars = parseEnvFile(text)
    cachedEnvVars.set(filePath, vars)
    for (const k of Object.keys(vars)) {
        process.env[k] = vars[k]
    }

    getLogger().debug(`Loaded environment variables: ${Object.keys(vars)}`)

    return vars
}
