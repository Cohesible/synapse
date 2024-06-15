// FIXME: `default` imports don't work correctly for cjs bundles
// import EventEmitter from 'node:events'
import { EventEmitter } from 'node:events'
export { EventEmitter }

export interface Disposable {
    dispose: () => void 
}

export interface Event<T extends any[]> {
    fire(...args: T): void
    on(listener: (...args: T) => void): Disposable
}

export function createEventEmitter() {
    return new EventEmitter()
}

const listenerSymbol = Symbol('listener')

interface ListenerEvent {
    readonly eventName: string | symbol
    readonly mode: 'added' | 'removed'
}

export function addMetaListener(emitter: EventEmitter, listener: (ev: ListenerEvent) => void) {
    emitter.on(listenerSymbol, listener)

    return { dispose: () => emitter.removeListener(listenerSymbol, listener) }
}

export type EventEmitter2<T> = (listener: (ev: T) => void) => Disposable

export function createEvent<T extends any[], U extends string>(emitter: EventEmitter, type: U): Event<T> {
    return {
        fire: (...args) => emitter.emit(type, ...args),
        on: listener => {
            emitter.on(type, listener as any)
            emitter.emit(listenerSymbol, { eventName: type, mode: 'added' })

            function dispose() {
                emitter.removeListener(type, listener as any)
                emitter.emit(listenerSymbol, { eventName: type, mode: 'removed' })
            }

            return { dispose }
        },
    }
}

export function once<T extends any[]>(event: Event<T>, fn: (...args: T) => void): Disposable {
    const d = event.on((...args) => {
        d.dispose()
        fn(...args)
    })

    return d
}
