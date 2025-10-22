import * as nodeUtil from 'node:util'
import { getLogger } from '../../logging'
import { FailedTestEvent, TestEvent, TestLogEvent } from '../../logging'
import { colorize, format, printLine } from '../ui'

// We should output the filename for each suite/test
export function createTestView() {
    const startTimes = new Map<string, number>()
    const usePerformance = false

    function getDuration(id: string, endTime: number) {
        const startTime = startTimes.get(id)
        if (!startTime) {
            return
        }

        const dur = endTime - startTime
        if (usePerformance) {
            return dur.toFixed(3)
        }

        return dur < 5 ? 0 : dur
    }

    const cachedTests = new Map<string, string[]>()

    const indentLevel = new Map<string, number>()
    function getIndent(ev: TestEvent) {
        if (ev.parentId === undefined) {
            indentLevel.set(ev.id, 0)

            return ''
        }

        const parentIndent = indentLevel.get(ev.parentId) ?? -1
        const indent = parentIndent + 1
        indentLevel.set(ev.id, indent)

        return '  '.repeat(indent)
    }

    const l = getLogger().onTest(ev => {
        if (ev.status === 'cached') {
            const parentId = ev.parentId ?? 'root'
            const arr = cachedTests.get(parentId) ?? []
            arr.push(ev.id)
            cachedTests.set(parentId, arr)

            return
        }

        // TODO: dynamically show # of tests pending when in tty
        if (ev.status === 'pending') {
            return
        }

        if (ev.status === 'running') {
            if (ev.itemType === 'suite') {
                printLine(`${getIndent(ev)}- ${ev.name}`)
            }

            return startTimes.set(ev.id, usePerformance ? performance.now() : ev.timestamp.getTime())
        }

        if (ev.itemType === 'suite') {
            return
        }

        const duration = ev.status === 'passed' || ev.status === 'failed'
            ? getDuration(ev.id, usePerformance ? performance.now() : Date.now())
            : undefined

        const durationText = duration ? colorize('gray', ` (${duration}ms)`) : ''

        // We assume that test events come in sequentially
        if (ev.status === 'passed') {
            printLine(getIndent(ev) + colorize('green', `${ev.name}${durationText}`))
        } else {
            printLine(getIndent(ev) + colorize('red', `${ev.name}${durationText}`))
        }
    })

    function showFailures(failures: FailedTestEvent[]) {
        for (const ev of failures) {
            // XXX: don't show test suite failures caused by a child test failing
            if (failures.find(x => x.parentId === ev.id)) {
                continue
            }

            printLine('\n')
            printLine(
                colorize('red', `[FAILED] ${ev.name}`), 
                nodeUtil.formatWithOptions({ colors: process.stdout.isTTY }, ev.reason)
            )
        }
    }

    const testLogs: TestLogEvent[] = []
    getLogger().onTestLog(ev => testLogs.push(ev))

    function dispose(failures: FailedTestEvent[], showAllLogs?: boolean) {
        l.dispose()

        if (cachedTests.size > 0) {
            let count = 0
            for (const [k, v] of cachedTests) {
                count += v.length
            }

            printLine()
            printLine(colorize('gray', `Skipped ${count} unchanged tests`))
        }

        const failedTests = new Set(failures.map(ev => ev.id))
        const filtered = showAllLogs ? testLogs : testLogs.filter(ev => failedTests.has(ev.id))
        if (filtered.length > 0) {
            printLine()
            printLine('Test logs:')
            for (const ev of filtered) {
                printLine(`    ${format(...ev.args)}`)
            }
        }
    }

    return {
        showFailures,
        dispose,
    }
}