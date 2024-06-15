import { BaseOutputMessage, getLogger } from '../../logging'
import { DepsDiff } from '../../pm/packageJson'
import { compareVersions } from '../../pm/versions'
import { memoize } from '../../utils'
import { colorize, dim, getDisplay, printLine, renderDuration } from '../ui'

interface InstallLifecycleEventBase extends BaseOutputMessage {
    readonly type: 'install-lifecycle'
}

interface InstallEventStart extends InstallLifecycleEventBase {
    readonly phase: 'start'
}

interface InstallEventResolve extends InstallLifecycleEventBase {
    readonly phase: 'resolve'
    readonly resolveCount?: number
}

interface InstallEventDownload extends InstallLifecycleEventBase {
    readonly phase: 'download'
    readonly packages: string[]
}

interface InstallEventWrite extends InstallLifecycleEventBase {
    readonly phase: 'write'
    readonly numPackages: number
    // readonly packages: string[]
}

interface InstallEventEnd extends InstallLifecycleEventBase {
    readonly phase: 'end'
    readonly summary: InstallSummary
}

export interface InstallSummary {
    readonly rootDeps: Record<string, {
        name?: string
        installedVersion: string
        latestVersion?: string
    }>

    readonly installed?: string[]
    readonly changed?: string[]
    readonly removed?: string[]
    readonly diff?: DepsDiff
}

export type InstallLifecycleEvent =
    | InstallEventStart
    | InstallEventResolve
    | InstallEventDownload
    | InstallEventWrite
    | InstallEventEnd

export interface PackageProgressEvent extends BaseOutputMessage {
    readonly type: 'install-package'
    readonly phase: 'download' | 'install'
    readonly package: string
    // readonly totalSizeBytes: number
    // readonly bytesDownloaded: number
    readonly done?: boolean
    readonly cached?: boolean
    readonly skipped?: boolean
    readonly error?: Error
}


export function createInstallView() {
    const view = getDisplay().getOverlayedView()
    const getHeader = memoize(() => view.createRow('Installing packages...'))
    const completed = new Set<string>()
    const requested = new Set<string>()
    let skipped = 0
    const startTime = Date.now()

    function updateDownloading() {
        const suffix = colorize('gray', ` (${completed.size} / ${requested.size})`)
        getHeader().update(`Installing...${suffix}`) // Download/install
    }

    let summary: InstallSummary
    const onInstall = getLogger().onInstall(ev => {
        const header = getHeader()
        switch (ev.phase) {
            case 'start':
                header.update('Starting package install...')
                break
            case 'resolve':
                header.update(`Resolving...${ev.resolveCount ? ` ${colorize('gray', `(${ev.resolveCount} packages)`)}` : ''}`)
                break
            case 'download':
                ev.packages.forEach(p => requested.add(p))
                updateDownloading()
                break
            case 'write':
                header.update(`Creating node_modules...`)
                break
            case 'end':
                header.destroy()
                getLogger().log(`Total packages installed: ${completed.size - skipped}`)
                summary = ev.summary

                // need to show errors
                break
        }
    })

    const onProgress = getLogger().onPackageProgress(ev => {
        if (ev.done) {
            completed.add(ev.package)
            updateDownloading()
            
            if (ev.skipped) {
                skipped += 1
            }
        }
    })

    function summarize() {
        if (!summary) {
            if (completed.size === 0) {
                printLine(colorize('green', 'Done!') + ' No changes needed')
            } else {
                printLine(colorize('green', 'Done!') + ` ${completed.size} packages installed`)
            }
            return
        }

        const installCount = summary.installed?.length ?? 0
        const removeCount = summary.removed?.length ?? 0
        const changeCount = summary.changed?.length ?? 0
        const total = installCount + removeCount + changeCount
        const dur = renderDuration(Date.now() - startTime)

        if (total === 0) {
            printLine(colorize('green', 'Done!') + dur + colorize('green', ' No changes needed'))
            return
        }

        const suffix = ` package${(installCount + removeCount + changeCount) > 1 ? 's' : ''}`

        const addedText = ` Added ${colorize('green', String(installCount))}`
        const removedText = ` Removed ${colorize('red', String(removeCount))}`
        const changedText = ` Changed ${colorize('blue', String(changeCount))}`

        const arr: string[] = []
        if (installCount) arr.push(addedText)
        if (removeCount) arr.push(removedText)
        if (changeCount) arr.push(changedText)

        const finalText = arr.map((x, i) => i === 0 ? x : x.toLowerCase()).join(',') + suffix


        printLine(colorize('green', 'Done!') + dur + `${finalText}`)

        for (const [k, v] of Object.entries(summary.rootDeps)) {
            if (v.name?.startsWith('file:/')) continue // XXX: this filters user-installed pkgs, not just internal ones

            const displayName = k === v.name || !v.name
                ? `${k}@${v.installedVersion}`
                : `${k} - ${v.name}@${v.installedVersion}`

            const latestVersion = v.latestVersion && v.latestVersion !== v.installedVersion
                ? dim(` (latest: ${v.latestVersion})`)
                : ''

            if (summary.diff?.added && k in summary.diff.added) {
                printLine(`  ${colorize('green', `+ ${displayName}`)}${latestVersion}`)
            } else if (summary.diff?.changed && k in summary.diff.changed) {
                const from = summary.diff.changed[k].from.pattern
                const to = summary.diff.changed[k].to.pattern
                const order = from && to ? compareVersions(from, to) : undefined
                const directionText = order 
                    ? colorize(order < 0 ? 'green' : 'red', dim(` [${order < 0 ? 'upgraded' : 'downgraded'}]`))
                    : ''
                printLine(`  ${colorize('blue', `~ ${displayName}`)}${directionText}${latestVersion}`)
            } else if (summary.diff?.removed && k in summary.diff.removed) {
                printLine(`  ${colorize('red', `- ${displayName}`)}`)
            } else {
                // idk
            }
        }
    }

    function dispose() {
        //view.dispose()
        onInstall.dispose()
        onProgress.dispose()
    }

    return { summarize, dispose }
}

