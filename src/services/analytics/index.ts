import { getLogger } from '../../logging'
import { readKey } from '../../cli/config'
import { memoize } from '../../utils'
import { AnalyticsEvent } from './backend'
import { connect } from './daemon'

const pendingEvents = new Set<Promise<unknown>>()

export function emitEvent(ev: AnalyticsEvent) {
    if (isAnalyticsDisabledByEnv()) {
        return
    }

    const p = _emit(ev).finally(() => pendingEvents.delete(p))
    pendingEvents.add(p)
}

export function eagerlyStartDaemon() {
    getDaemon()
}

async function _emit(ev: AnalyticsEvent) {
    const daemon = await getDaemon()

    return daemon?.sendAnalytics([ev])
}

// Sync check is kept separate so we can skip creating promises
const isAnalyticsDisabledByEnv = memoize(() => {
    if (process.env['DO_NOT_TRACK'] && process.env['DO_NOT_TRACK'] !== '0') {
        return true
    }

    if (process.env['SYNAPSE_NO_ANALYTICS'] && process.env['SYNAPSE_NO_ANALYTICS'] !== '0') {
        return true
    }
})

const isAnalyticsDisabled = memoize(async () => {
    return isAnalyticsDisabledByEnv() || (await readKey('cli.analytics')) === false
})

const getDaemon = memoize(async () => {
    if (await isAnalyticsDisabled()) {
        return
    }

    try {
        return await connect()
    } catch (e) {
        if (!(e as any).message.includes('has not been deployed')) {
            getLogger().error(e)
        }
    }
})

export async function shutdown() {
    const start = performance.now()

    if (pendingEvents.size === 0) {
        if (getDaemon.cached) {
            (await getDaemon())?.dispose()
        }
        return
    }

    const timer = setTimeout(async () => {
        if (getDaemon.cached) {
            getLogger().warn(`Forcibly destroying analytics socket`)
            ;(await getDaemon())?.destroySocket()
        }
    }, 100).unref()

    await Promise.all(pendingEvents)
    ;(await getDaemon())?.dispose()
    clearTimeout(timer)
    getLogger().debug(`analytics shut down time: ${Math.floor((performance.now() - start) * 100) / 100}ms`)
}

interface CommandEventAttributes {
    readonly name: string
    readonly duration: number
    readonly errorCode?: string
    // cliVersion
    // OS
    // arch
    // maybe shell
}

interface CommandEvent extends AnalyticsEvent {
    readonly type: 'command'
    readonly attributes: CommandEventAttributes
}

export function emitCommandEvent(attributes: CommandEventAttributes) {
    emitEvent({
        type: 'command',
        timestamp: new Date().toISOString(),
        attributes,
    } satisfies CommandEvent)
}

const legalNotice = `
The Synapse CLI collects anonymous usage data. You can opt-out by running the command \`syn config synapse.cli.analytics false\`. 

For more information on what is collected, see the following documentation: <URL HERE>
`