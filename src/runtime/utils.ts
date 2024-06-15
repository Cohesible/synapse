import * as vm from 'node:vm'
import * as path from 'node:path'
import { SyncFs } from '../system'
import { throwIfNotFileNotFoundError } from '../utils'

export interface Context {
    readonly vm: vm.Context
    readonly globals: typeof globalThis
}

export function copyGlobalThis(): Context {
    const ctx = vm.createContext()
    const globals = vm.runInContext('this', ctx)
    const keys = new Set(Object.getOwnPropertyNames(globals))

    const propDenyList = new Set([
        'crypto', // Node adds a prop that throws if in a different context
        'console', // We want to add our own
    ])

    const descriptors = Object.entries(Object.getOwnPropertyDescriptors(globalThis)).filter(([k]) => !keys.has(k) && !propDenyList.has(k))

    for (const [k, v] of descriptors) {
        Object.defineProperty(globals, k, v)
    }

    globals.ArrayBuffer = ArrayBuffer
    // Needed for `esbuild`
    globals.Uint8Array = Uint8Array

    globals.console = globalThis.console

    Object.defineProperty(globals, 'crypto', {
        value: globalThis.crypto,
        writable: false,
        configurable: false,
    })

    return { vm: ctx, globals }
}

export type CodeCache = ReturnType<typeof createCodeCache>
export function createCodeCache(fs: Pick<SyncFs, 'readFileSync' | 'writeFileSync' | 'deleteFileSync'>, cacheDir: string) {
    function getCachedData(key: string): Buffer | undefined {
        const filePath = path.resolve(cacheDir, key)

        try {
            const d = fs.readFileSync(filePath)

            return Buffer.isBuffer(d) ? d : Buffer.from(d)
        } catch (e) {
            throwIfNotFileNotFoundError(e)
        }
    }

    function setCachedData(key: string, data: Uint8Array) {
        const filePath = path.resolve(cacheDir, key)
        fs.writeFileSync(filePath, data)
    }

    function evictCachedData(key: string) {
        const filePath = path.resolve(cacheDir, key)
        fs.deleteFileSync(filePath)
    }

    return { getCachedData, setCachedData, evictCachedData }
}

