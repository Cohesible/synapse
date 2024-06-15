import { memoize } from '../utils'
import { Memento } from './memento'

export interface TtlCache extends Omit<Memento, 'set'> {
    /** `ttl` is in seconds */
    set<T>(key: string, value: T, ttl: number): Promise<void>
}

export function createTtlCache(memento: Memento): TtlCache {
    const manifestKey = '__ttl-manifest__'

    function _getManifest() {
        return memento.get<Record<string, number>>(manifestKey, {})
    }

    // We're assuming there is only 1 writer per-memento
    const getManifest = memoize(_getManifest)

    async function updateManifest(entries: Record<string, number | undefined>) {
        const m = await getManifest()
        await memento.set(manifestKey, { ...m, ...entries })
    }

    async function putEntry(key: string, ttl: number) {
        await updateManifest({ [key]: Date.now() + (ttl * 1000) })
    }

    async function deleteEntry(key: string) {
        await updateManifest({ [key]: undefined })
    }

    async function isInvalid(key: string) {
        const m = await getManifest()
        if (!m[key]) {
            return // Maybe always return true here?
        }

        return Date.now() >= m[key]
    }

    async function get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
        if (await isInvalid(key) === true) {
            await deleteEntry(key)
            await memento.delete(key)

            return defaultValue
        }

        return memento.get(key, defaultValue)
    }

    async function set<T>(key: string, value: T, ttl: number) {
        await putEntry(key, ttl)
        await memento.set(key, value)
    }

    async function _delete(key: string) {
        await deleteEntry(key)
        await memento.delete(key)
    }

    return { get, set, delete: _delete }
}