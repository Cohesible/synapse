
import * as path from 'node:path'
import { homedir } from 'node:os'
import { getFs } from '../execution'
import { isNonNullable, throwIfNotFileNotFoundError } from '../utils'

// per-project config file (/path/to/my/project/.npmrc)
// per-user config file (~/.npmrc)
// global config file ($PREFIX/etc/npmrc)
// npm builtin config file (/path/to/npm/npmrc)

// Array values are specified by adding "[]" after the key name. For example: foo[] = bar; foo[] = baz

// _auth (base64 authentication string)
// _authToken (authentication token)
// username
// _password
// email
// certfile (path to certificate file)
// keyfile (path to key file)

// ; good config
// @myorg:registry=https://somewhere-else.com/myorg
// @another:registry=https://somewhere-else.com/another
// //registry.npmjs.org/:_authToken=MYTOKEN
// ; would apply to both @myorg and @another
// ; //somewhere-else.com/:_authToken=MYTOKEN
// ; would apply only to @myorg
// //somewhere-else.com/myorg/:_authToken=MYTOKEN1
// ; would apply only to @another
// //somewhere-else.com/another/:_authToken=MYTOKEN2

export interface NpmConfig {
    readonly registries: Record<string, string>
    readonly scopedConfig: Record<string, {
        _authToken?: string
        [key: string]: any
    }>
}

export function parseText(text: string) {
    const lines = text.split('\n').map(x => x.trim()).filter(x => !!x)
    const registries: Record<string, string> = {}
    const scopedConfig: Record<string, Record<string, string>> = {}
    for (const l of lines) {
        if (l.startsWith('#') || l.startsWith(';')) continue

        const m = l.match(/^([^\s=]+)\s*=\s*(.*?)\s*$/)
        if (!m) {
            throw new Error(`Bad parse: ${l}`) // FIXME: may contain sensitive stuff
        }

        const [_, key, value] = m
        
        // Technically environemnt variables can be anything but a few special symbols e.g. "$\=
        const resolvedValue = value.replace(/\$\{([A-Za-z0-9\-_]+)\}/g, (_, name) => {
            const val = process.env[name] ?? process.env[`NPM_CONFIG_${name}`]
            if (val === undefined) {
                throw new Error(`No environment variable found: ${name}`)
            }
            return val
        })

        const scopedMatch = key.match(/^(@[a-z]+):registry$/)
        if (scopedMatch) {
            registries[scopedMatch[1]] = resolvedValue
            continue
        }

        const uriFragmentMatch = key.match(/^\/\/([^:]+):([a-zA-Z_]+)/)
        if (uriFragmentMatch) {
            const [_, scope, key] = uriFragmentMatch
            const config = scopedConfig[scope] ??= {}
            config[key] = resolvedValue
            continue
        }
    }

    return {
        registries,
        scopedConfig,
    }
}

function mergeConfigs(configs: NpmConfig[]): NpmConfig {
    if (configs.length === 1) {
        return configs[0]
    }

    const merged: NpmConfig = { registries: {}, scopedConfig: {} }
    for (const c of configs) {
        for (const [k, v] of Object.entries(c.registries)) {
            if (!merged.registries[k]) {
                merged.registries[k] = v
            }
        }

        for (const [k, v] of Object.entries(c.scopedConfig)) {
            const scoped = merged.scopedConfig[k] ??= {}
            for (const [k2, v2] of Object.entries(v)) {
                if (!scoped[k2]) {
                    scoped[k2] = v2
                }
            } 
        }
    }

    return merged
}

export async function resolveNpmConfigs(pkgDir: string) {
    const sources = [
        path.resolve(homedir(), '.npmrc'),
        path.resolve(pkgDir, '.npmrc'),
    ]

    const texts = await Promise.all(
        sources.map(p => getFs().readFile(p, 'utf-8').catch(throwIfNotFileNotFoundError))
    )

    const configs = texts.map(text => text ? parseText(text) : undefined).filter(isNonNullable)
    if (configs.length === 0) {
        return
    }

    return mergeConfigs(configs)
}
