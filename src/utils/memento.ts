import * as path from 'node:path'
import { Fs } from '../system'
import { throwIfNotFileNotFoundError } from '../utils'

// Roughly inspired by VS Code's "Memento" API

export interface Memento {
    get<T>(key: string): Promise<T | undefined>
    get<T>(key: string, defaultValue: T): Promise<T>
    set<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<void>
}

export function createMemento(fs: Pick<Fs, 'readFile' | 'writeFile' | 'deleteFile'>, dir: string): Memento {
    const getLocation = (key: string) => path.resolve(dir, key)

    async function get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
        try {
            return JSON.parse(await fs.readFile(getLocation(key), 'utf-8'))
        } catch (e) {
            throwIfNotFileNotFoundError(e)
            
            // Delete data when JSON is malformed?
            return defaultValue
        }
    }

    async function set<T>(key: string, value: T) {
        await fs.writeFile(getLocation(key), JSON.stringify(value))
    }

    async function _delete(key: string) {
        await fs.deleteFile(getLocation(key)).catch(throwIfNotFileNotFoundError)
    }

    return { get, set, delete: _delete }
}

export interface TypedMemento<T> {
    get(): Promise<T | undefined>
    set(value: T): Promise<void>
}

export function createTypedMemento<T>(memento: Memento, key: string): TypedMemento<T> {
    return {
        get: () => memento.get(key),
        set: value => memento.set(key, value),
    }
}
