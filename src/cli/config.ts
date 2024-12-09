import * as path from 'node:path'
import { getFs } from '../execution'
import { memoize, tryReadJson, tryReadJsonSync, makeRelative } from '../utils'
import { getUserConfigFilePath } from '../workspaces'

let config: Record<string, any>
let pendingConfig: Promise<Record<string, any>> | undefined
function readConfig(): Promise<Record<string, any>> | Record<string, any> {
    if (config) {
        return config
    }

    if (pendingConfig) {
        return pendingConfig
    }

    return pendingConfig = tryReadJson(getFs(), getUserConfigFilePath()).then(val => {
        return config = (val ?? {}) as any
    }).finally(() => {
        pendingConfig = undefined
    })
}

function readConfigSync(): Record<string, any> {
    if (config) {
        return config
    }

    return config = (tryReadJsonSync(getFs(), getUserConfigFilePath()) ?? {})
}

let pendingWrite: Promise<void> | undefined
function writeConfig(conf: Record<string, any>) {
    config = conf

    const write = () => getFs().writeFile(getUserConfigFilePath(), JSON.stringify(conf, undefined, 4))

    if (pendingWrite) {
        const tmp = pendingWrite
            .finally(write)
            .finally(() => {
                if (pendingWrite !== tmp) {
                    return
                }
                pendingWrite = undefined
            })
        return pendingWrite = tmp
    }

    const tmp = write().finally(() => {
        if (pendingWrite !== tmp) {
            return
        }
        pendingWrite = undefined
    })

    return pendingWrite = tmp
}

function getValue(val: any, key: string) {
    const parts = key.split('.')
    while (parts.length > 0) {
        const k = parts.shift()!
        val = val?.[k]
    }

    return val
}

export function readKeySync<T = unknown>(key: string): T | undefined {
    return getValue(readConfigSync(), key)
}

export async function readKey<T = unknown>(key: string): Promise<T | undefined> {
    return getValue(await readConfig(), key)
}

export async function setKey(key: string, value: any) {
    const parts = key.split('.')
    const config = await readConfig()
    let val: any = config
    while (parts.length > 1) {
        const k = parts.shift()!
        if (val[k] === undefined) {
            val[k] = {}
        } else if (typeof val[k] !== 'object') {
            throw new Error(`Found non-object type while setting key "${key}" at access "${k}": ${typeof val[k]}`)
        }

        val = val[k]
    }

    const oldValue = val[parts[0]]
    val[parts[0]] = value
    await writeConfig(config)

    return oldValue
}

const getUserConfigDir = memoize(() => path.dirname(getUserConfigFilePath()))

export function readPathKeySync(key: string): string | undefined {
    const val = readKeySync<string>(key)

    return val !== undefined ? path.resolve(getUserConfigDir(), val) : val
}

export async function readPathKey(key: string): Promise<string | undefined> {
    const val = await readKey<string>(key)

    return val !== undefined ? path.resolve(getUserConfigDir(), val) : val
}

export async function readPathMapKey(key: string): Promise<Record<string, string> | undefined> {
    const val = await readKey<Record<string, string>>(key)
    if (!val) {
        return
    }

    const resolved: Record<string, string> = {}
    for (const k of Object.keys(val)) {
        resolved[k] = path.resolve(getUserConfigDir(), val[k])
    }

    return resolved
}

export async function setPathKey(key: string, value: string) {
    const abs = path.resolve(getUserConfigDir(), value)
    const rel = makeRelative(getUserConfigDir(), abs)

    return setKey(key, rel)
}

// synapse.cli.suggestions -> false
// Need settings to change where test/deploy/synth logs go
