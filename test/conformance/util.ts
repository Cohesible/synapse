// AWS Lambda will report "done" if the event loop is empty and the microtask queue isn't being emptied
const shouldUnref = process.env.SYNAPSE_TARGET === 'local'
export function sleep(ms: number, unref = shouldUnref) {
    return new Promise<void>(r => {
        const timer = setTimeout(r, ms)
        unref && timer.unref()
    })
}

export async function waitUntil<T>(delay: number, timeout: number, cb: () => Promise<T | undefined> | T | undefined): Promise<T | undefined> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        const actual = await cb()
        if (actual !== undefined) {
            return actual
        }

        await sleep(delay)
    }
}
