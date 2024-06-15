import { getFs } from '../execution'
import { tryReadJson, tryReadJsonSync } from '../utils'
import { getUserConfigFilePath } from '../workspaces'

let config: Record<string, any>
let pendingConfig: Promise<Record<string, any>>
function _readConfig(): Promise<Record<string, any>> | Record<string, any> {
    if (config) {
        return config
    }

    if (pendingConfig) {
        return pendingConfig
    }

    return pendingConfig = tryReadJson(getFs(), getUserConfigFilePath()).then(val => {
        val ??= {}
        return config = val as any
    })
}

let pendingWrite: Promise<void> | undefined
function _writeConfig(conf: Record<string, any>) {
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

async function readConfig(): Promise<Record<string, any>> {
    return (await tryReadJson(getFs(), getUserConfigFilePath())) ?? {}
}

async function writeConfig(conf: Record<string, any>): Promise<void> {
    await getFs().writeFile(getUserConfigFilePath(), JSON.stringify(conf, undefined, 4))
}

function readConfigSync(): Record<string, any> {
    return tryReadJsonSync(getFs(), getUserConfigFilePath()) ?? {}
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

// synapse.cli.suggestions -> false
// Need settings to change where test/deploy/synth logs go
