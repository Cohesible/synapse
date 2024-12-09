import { getLogger } from '../logging'
import { createEventEmitter } from '../events'
import { memoize } from '../utils'
import * as nodeUtil from 'node:util'
import { pushDisposable } from '../execution'

const esc = '\x1b'

const foregroundColors = {
    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    purple: 35,
    cyan: 36,
    white: 37,
    gray: 90,
    brightRed: 91,
    brightGreen: 92,
    brightYellow: 93,
    brightBlue: 94,
    brightPurple: 95,
    brightCyan: 96,
    brightWhite: 97,
}

const backgroundColors = {
    black: 40,
    red: 41,
    green: 42,
    yellow: 43,
    blue: 44,
    purple: 45,
    cyan: 46,
    white: 47,
}

const modifiers = {
    none: 0,
    bold: 1,
    underline: 4,
}

const eightBitColors = {
    commentGreen: 65,
    orange: 214,
    orange2: 215,
    paleYellow: 229,
    paleCyan: 159,
    paleGreen: 194,
}

export type EightBitColor = keyof typeof eightBitColors
export type AnsiColor = keyof typeof foregroundColors
export type Color = AnsiColor | EightBitColor | 'none'

export function dim(text: string) {
    return `${esc}[2m${text}${esc}[0m`
}

export function bold(text: string) {
    return `${esc}[1m${text}${esc}[0m`
}

// 8-bit
// ESC[38;5;⟨n⟩m Select foreground color      where n is a number from the table below
// ESC[48;5;⟨n⟩m Select background color
//     0-  7:  standard colors (as in ESC [ 30–37 m)
//     8- 15:  high intensity colors (as in ESC [ 90–97 m)
//    16-231:  6 × 6 × 6 cube (216 colors): 16 + 36 × r + 6 × g + b (0 ≤ r, g, b ≤ 5)
//   232-255:  grayscale from dark to light in 24 steps

// 24-bit
// ESC[38;2;⟨r⟩;⟨g⟩;⟨b⟩ m Select RGB foreground color
// ESC[48;2;⟨r⟩;⟨g⟩;⟨b⟩ m Select RGB background color    

// COLORTERM=truecolor

export function colorize(color: Color, text: string) {
    if (color === 'none') {
        return text
    }

    if (color in eightBitColors) {
        const code = eightBitColors[color as EightBitColor]

        return `${esc}[38;5;${code}m${text}${esc}[0m`
    }

    const code = foregroundColors[color as AnsiColor]

    return `${esc}[${code}m${text}${esc}[0m`
}

function colorizeTemplate(
    color: Exclude<Color, 'none'>,
    strings: TemplateStringsArray, 
    values: string[]
) {
    const result = [strings[0]]
    values.forEach((value, i) => {
        result.push(value, strings[i + 1])
    })

    return colorize(color, result.join(''))
}

// FIXME: doesn't handle colon-separated commands
const ansiPattern = /\u001b\[[0-9]+m/g

export function stripAnsi(s: string) {
    return s.replace(ansiPattern, '')
}


let display: ReturnType<typeof createDisplay>
export function getDisplay() {
    if (display) {
        return display
    }

    display = createDisplay()

    return pushDisposable(display)
}

function swap(arr: any[], i: number, j: number) {
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
}


const getSegmenter = memoize(() => new Intl.Segmenter(undefined, { granularity: 'grapheme' }))
const emojiPattern = /\p{Emoji_Presentation}/u
function getGraphemeWidth(str: string) {
    if (emojiPattern.test(str)) {
        return 2
    }

    // TODO: East Asian width (maybe just use a library)

    return 1
}

function getDisplayWidth(str: string) {
    let w = 0
    let j = 0
    let isEscaped = false

    // const segmenter = getSegmenter()
    function getSliceWidth(s: string) {
        return [...s].map(getGraphemeWidth).reduce((a, b) => a + b, 0)
        //return [...segmenter.segment(s)].map(x => getGraphemeWidth(x.segment)).reduce((a, b) => a + b, 0)
    }

    for (let i = 0; i < str.length; i++) {
        if (str[i] === esc && str[i+1] === '[') {
            if (i > j) {
                w += getSliceWidth(str.slice(j, i))
            }
            isEscaped = true
            i += 1
        } else if (isEscaped) {
            if (str[i] === 'm') {
                isEscaped = false
                j = i+1
            }
        }
    }

    if (j < str.length) {
        w += getSliceWidth(j === 0 ? str : str.slice(j))
    }

    return w
}

function createSyncWrapper<T extends Record<string, (...args: any[]) => any>>(obj: T) {
    interface Operation<K extends keyof T = keyof T> {
        readonly id: number
        readonly type: K
        readonly args: Parameters<T[K]>
    }

    let idCounter = 0
    const queue: Operation[] = []
    const pending = new Set<number>()

    async function processOps() {
        while (queue.length > 0) {
            const op = queue.shift()!
            if (pending.has(op.id)) {
                pending.delete(op.id)
                await (obj[op.type] as any)(...op.args)
            }
        }
    }

    let processing: Promise<void> | undefined
    function startProcessing() {
        if (processing) {
            return processing
        }

        processing = processOps().finally(() => (processing = undefined))
    }

    function cancel(id: number) {
        pending.delete(id)
    }

    function cancelAll() {
        pending.clear()
    }

    async function flush() {
        await startProcessing()
    }

    const wrapped: { [P in keyof T]: (...args: Parameters<T[P]>) => number } = {} as any
    for (const [k, v] of Object.entries(obj)) {
        const type = k as keyof T
        wrapped[type] = (...args: any) => {
            const id = idCounter++
            pending.add(id)
            queue.push({ id, type, args })
            if (queue.length === 1) {
                startProcessing()
            }

            return id
        }
    }

    function createCompositeOp(fn: (writer: typeof wrapped) => void): { cancel: () => void } {
        const start = idCounter
        fn(wrapped)
        const end = idCounter

        function cancel() {
            for (let i = start; i < end; i++) {
                pending.delete(i)
            }
        }

        return { cancel }
    }

    return {
        wrapped,
        flush,
        cancel,
        cancelAll,
        createCompositeOp,
    }
}

function createScreenWriter(stream = process.stdout) {
    async function waitForDrain() {
        await new Promise<void>((r) => stream.once('drain', r))
    }

    async function runAndDrain<T = void>(fn: (cb: (val: T) => void) => boolean) {
        let didDrain = false
        const val = await new Promise<T>(resolve => {
            didDrain = fn(resolve)
        })

        if (!didDrain) {
            await waitForDrain()
        }

        return val
    }

    async function write(data: string | Buffer) {
        const err = await runAndDrain<Error | undefined>(resolve => stream.write(data, resolve))
        if (err) {
            throw err
        }
    }

    async function cursorTo(x: number, y?: number) {
        await runAndDrain((resolve) => stream.cursorTo(x, y, resolve))
    }

    async function moveCursor(dx: number, dy: number) {
        await runAndDrain((resolve) => stream.moveCursor(dx, dy, resolve))
    }

    async function clearScreenDown() {
        await runAndDrain((resolve) => stream.clearScreenDown(resolve))
    }

    /**
     * -1 - to the left from cursor
     *  0 - the entire line
     *  1 - to the right from cursor
     */
    async function clearLine(dir: -1 | 0 | 1 = 0) {
        await runAndDrain((resolve) => stream.clearLine(dir, resolve))
    }

    async function clearScreen(fullScreen = false) {
        await cursorTo(0, fullScreen ? 0 : 1)
        await clearScreenDown()
    }

    async function scrollUp(lines = 1) {
        await write(`${esc}[${lines}S`)
    }

    async function scrollDown(lines = 1) {
        await write(`${esc}[${lines}T`)
    }

    let cursorVisible = true
    function showCursor() {
        if (cursorVisible) {
            return
        }

        cursorVisible = true
        return write(`${esc}[?25h`)
    }

    function hideCursor() {
        if (!cursorVisible) {
            return
        }

        cursorVisible = false
        return write(`${esc}[?25l`)
    }

    async function writeRows(rows: string[], fullScreen = false) {
        await clearScreen(fullScreen)
        await write(rows.join('\n'))
    }

    async function setupScreen(fullScreen = false) {
        const pos = await getCursorPosition()
        if (pos && pos.row > 1) {
            const offset = stream.rows - 1
            await write('\n'.repeat(offset - (fullScreen ? 0 : 1)))
        }
    }

    const operations = { write, scrollUp, cursorTo, clearScreenDown, clearLine, clearScreen, writeRows, moveCursor, setupScreen, showCursor, hideCursor }

    const { wrapped, flush, cancel, cancelAll, createCompositeOp } = createSyncWrapper(operations)

    const tty = registerTty()

    async function getCursorPosition() {
        if (!tty) {
            return
        }

        const p = new Promise<DeviceStatusEvent>((resolve, reject) => {
            function end(ev?: DeviceStatusEvent) {
                l.dispose()
                l2.dispose()
                ev ? resolve(ev) : resolve({ row: 0, column: 0 })
            }

            const l = tty!.onDeviceStatus(end)
            const l2 = tty!.onClose(end)
        })

        await write(`${esc}[6n`)

        return p
    }

    async function end(data?: string | Uint8Array) {
        await flush()

        return new Promise<void>((resolve, reject) => {
            data !== undefined ? stream.end(data, resolve) : stream.end(resolve)
        })
    }
    
    return { 
        ...wrapped,
        cancel,
        cancelAll,
        flush,
        end,
        createCompositeOp,
        getCursorPosition,
        tty,
    }
}

interface ViewData {
    readonly fullScreen?: boolean
    readonly rows: string[]
    readonly currentRow: number
    readonly pendingWrites: number[]
    readonly cursorPosition: {
        readonly row: number
        readonly column: number
    }
}

export enum ControlKey {
    Backspace = 8,
    Enter = 13,
    UpArrow,
    DownArrow,
    RightArrow,
    LeftArrow,
    ESC = 27,
    DEL = 127,
}

interface SignalEvent {
    readonly signal: NodeJS.Signals
}

// Emits ASCII characters only
interface KeyPressEvent {
    readonly key: string | ControlKey
}

interface DeviceStatusEvent {
    readonly row: number
    readonly column: number
}

function registerTty() {
    const isStdinTTY = process.stdin.isTTY
    if (!isStdinTTY) {
        return
    }

    const emitter = createEventEmitter()

    const controlKeys = {
        ['A'.charCodeAt(0)]: ControlKey.UpArrow,
        ['B'.charCodeAt(0)]: ControlKey.DownArrow,
        ['C'.charCodeAt(0)]: ControlKey.RightArrow,
        ['D'.charCodeAt(0)]: ControlKey.LeftArrow,
    }

    controlKeys[ControlKey.Backspace] = ControlKey.Backspace
    controlKeys[ControlKey.ESC] = ControlKey.ESC
    controlKeys[ControlKey.DEL] = ControlKey.DEL
    controlKeys[ControlKey.Enter] = ControlKey.Enter

    function handleInput(d: Buffer) {
        let isEscapeCode = false

        for (let i = 0; i < d.length; i++) {
            if (d[i] === 0x03) {
                emitter.emit('signal', { signal: 'SIGINT' } satisfies SignalEvent)
            } else if (d[i] === 0x1b && d[i+1] === 0x5b) {
                i += 1
                isEscapeCode = true
            } else if (isEscapeCode) {
                isEscapeCode = false

                // Try to parse out the cursor position
                if (d[d.length - 1] === 0x52) { // 'R'
                    const sub = d.subarray(i, d.length - 1)
                    const sepIndex = sub.indexOf(0x3b)
                    if (sepIndex === -1) {
                        break
                    }

                    const row = parseInt(String.fromCharCode(...sub.subarray(0, sepIndex))) - 1
                    const column = parseInt(String.fromCharCode(...sub.subarray(sepIndex + 1))) - 1
                    if (!isNaN(row) && !isNaN(column)) {
                        emitter.emit('device-status', { row, column } satisfies DeviceStatusEvent)
                    }

                    break
                }

                const key = controlKeys[d[i]]
                if (key !== undefined) {
                    emitter.emit('keypress', { key } satisfies KeyPressEvent)
                }
            } else if (d[i] > 0x1f && d[i] < 0x7f) {
                emitter.emit('keypress', { key: String.fromCharCode(d[i]) } satisfies KeyPressEvent)
            } else {
                const key = controlKeys[d[i]]
                if (key !== undefined) {
                    emitter.emit('keypress', { key } satisfies KeyPressEvent)
                }
            }
        }
    }

    function onClose(listener: () => void) {
        emitter.addListener('close', listener)

        return { dispose: () => emitter.removeListener('close', listener) }
    }

    function onDeviceStatus(listener: (ev: DeviceStatusEvent) => void) {
        setup()
        emitter.addListener('device-status', listener)

        return { dispose: () => emitter.removeListener('device-status', listener) }
    }

    function onKeyPress(listener: (ev: KeyPressEvent) => void) {
        setup()
        emitter.addListener('keypress', listener)

        return { dispose: () => emitter.removeListener('keypress', listener) }
    }

    function onSignal(listener: (ev: SignalEvent) => void) {
        emitter.addListener('signal', listener)

        return { dispose: () => emitter.removeListener('signal', listener) }
    }

    const previousRawMode = process.stdin.isRaw

    function dispose() {
        emitter.emit('close')
        emitter.removeAllListeners()
        process.stdin.removeListener('data', handleInput)
        process.stdin.setRawMode(previousRawMode)
    }

    let didSetup = false
    function setup() {
        if (didSetup) {
            return
        }

        didSetup = true
        process.stdin.setRawMode(true)
        process.stdin.on('end', dispose)
        process.stdin.on('data', handleInput)

        onSignal(ev => {
            if (ev.signal === 'SIGINT') {
                process.emit('SIGINT')
            }
        })
    }

    return { onClose, onKeyPress, onDeviceStatus, dispose }
}

interface DisplayRow {
    update: (text: string) => void
    // "Releases" the row, allowing it to be pushed off the screen
    release: (text?: string, emptyDelay?: number) => void
    // Removes the row entirely and leaves an empty space
    destroy: () => void
}

export function createDisplay() {
    const viewStack: string[] = []
    const views = new Map<string, ViewData>()
    const writer = createScreenWriter()

    function renderView(data: ViewData) {
        const start = data.currentRow 
        const end = start + Math.min(process.stdout.rows - (data.fullScreen ? 0 : 1), data.rows.length)
        const rows = data.rows.slice(start, end).map(r => r.slice(0, process.stdout.columns))
        data.pendingWrites.push(writer.writeRows(rows))
        data.pendingWrites.push(writer.cursorTo(data.cursorPosition.column, data.cursorPosition.row))
    }

    // For non-tty displays we only show text from `writeLine` or the final text of a row after `release`
    function createOverlayableView() {
        let idCounter = 0
        let screenTop: number
        let height = process.stdout.rows
        let needsSort = false
        let perfTime = 0
        let frames = 0
        let drawStart: number 

        const getCursorPosition = memoize(() => writer.getCursorPosition())

        async function _getScreenTop() {
            if (screenTop !== undefined) {
                return screenTop
            }

            if (!writer.tty) {
                return screenTop = 0
            }

            // XXX: hardcoded delay to make shutdowns faster
            // We only need to know the cursor position when we want
            // to keep track of the text we've drawn. But that doesn't
            // matter if we've finished execution.
            await new Promise<void>(r => setTimeout(r, 25).unref())

            if (disposed) {
                return 0
            }

            const cursor = await getCursorPosition()
            if (!cursor) {
                throw new Error(`No cursor position found`)
            }

            if (disposed) {
                return 0
            }
    
            writer.hideCursor()

            return screenTop = cursor.row
        }

        const getScreenTop = memoize(_getScreenTop)

        interface Span {
            id: number
            row?: number
            empty?: boolean
            open?: boolean
            released?: boolean
            // drawnPos?: number
            text: string
            spinner?: Spinner
            startTime?: number
            forceRemove?: boolean
        }

        function getSpanText(span: Span) {
            if (!span.spinner) {
                return span.text
            }

            const delta = span.startTime !== undefined 
                ? drawStart - span.startTime
                : 0

            const spinnerFrame = getSpinnerFrame(span.spinner, delta)
            span.startTime ??= drawStart

            return `${spinnerFrame} ${span.text}`
        }

        const spans: Span[] = []

        process.stdout.on('resize', async () => {
            const delta = process.stdout.rows - height
            height = process.stdout.rows
            if (delta < 0) {
                screenTop = Math.max(await getScreenTop() + delta, 0)
                redraw()
            }
        })

        const widthCache = new Map<Span, number>()
        function getWidth(span: Span) {
            if (widthCache.has(span)) {
                return widthCache.get(span)!
            }

            const width = getDisplayWidth(getSpanText(span))
            widthCache.set(span, width)

            return width
        }

        function padDisplayWidth(span: Span, width: number, padding = ' ') {
            const str = getSpanText(span)
            const paddingNeeded = width - getWidth(span)
            if (paddingNeeded <= 0) {
                return str
            }

            return str.padEnd(str.length + paddingNeeded, padding)
        }

        function shiftUp() {
            const idx = spans.findIndex(s => s.row === undefined || s.released)
            if (idx === -1) {
                return false
            }

            // TODO: we can skip writing and sorting when `idx` is 0 and the span 
            // was in the same row + text on the last draw

            writer.cursorTo(0, 0)

            const shiftAmount = getLinesNeeded(spans[idx])
            writer.write(padDisplayWidth(spans[idx], shiftAmount * process.stdout.columns))
            writer.cursorTo(process.stdout.columns - 1, process.stdout.rows - 1)

            swap(spans, idx, spans.length - 1)
            const removed = spans.pop()!
            widthCache.delete(removed)

            return shiftAmount
        }

        function getLinesNeeded(span: Span) {
            // This is generally a reasonable approximation except for some east asian characters
            // See https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt for a list of
            // code points that are "wide" or ambiguous 
            //
            // In this case we're only checking the # of code units, some of which could be displayed
            // as wide characters. So we use half of the actual width available.
            if (span.text.length < (process.stdout.columns / 2)) {
                return 1
            }

            const width = getWidth(span)
            if (width < process.stdout.columns) {
                return 1
            }

            return Math.ceil(width / process.stdout.columns)
        }

        function index(row: number) {
            return row < 0 ? spans.length + row : row
        }

        function sortSpans() {
            // const indices = new Map(spans.map((s, i) => [s, i]))
            spans.sort((a, b) => {
                if (a.row !== undefined && b.row !== undefined) {
                    return (index(a.row) - index(b.row)) || (a.id - b.id)
                }

                if (a.row !== undefined && b.row === undefined) {
                    return index(a.row) - spans.indexOf(a)
                }

                if (a.row === undefined && b.row !== undefined) {
                    return spans.indexOf(b) - index(b.row)
                }

                return a.id - b.id
            })
        }

        function addSpan(s: Span) {
            if (disposed) {
                return
            }

            const p = performance.now()
            spans.push(s)
            needsSort = true
            redraw()
            perfTime += performance.now() - p
        }

        // TODO: track the last 20 or so rows that were pushed off the screen
        // This would allows us to redraw the screen correctly on resize
        function _redraw() {
            if (disposed) {
                return
            }

            const p = performance.now()
            drawStart = p
            t = undefined
            frames += 1

            if (needsSort) {
                sortSpans()
                needsSort = false
            }

            let forceRemoveIndex = -1
            while ((forceRemoveIndex = spans.findIndex(x => x.forceRemove)) !== -1) {
                spans.splice(forceRemoveIndex, 1)
            }

            let isCursorAtBottom = false
            function scroll(amount = 1) {
                if (!isCursorAtBottom) {
                    writer.cursorTo(process.stdout.columns - 1, process.stdout.rows - 1)
                    isCursorAtBottom = true
                }

                writer.write('\n'.repeat(amount))
            }

            let lineCount = spans.map(getLinesNeeded).reduce((a, b) => a + b, 0)
            while (lineCount > (process.stdout.rows - screenTop)) {
                if (screenTop === 0) {
                    const shiftAmount = shiftUp()
                    if (!shiftAmount) break

                    sortSpans()
                    scroll(shiftAmount)
                    lineCount -= shiftAmount
                } else {
                    screenTop -= 1
                    scroll()
                }
            }

            writer.cursorTo(0, screenTop)
            writer.clearScreenDown()

            lineCount = 0
            const rows: Span[] = []
            for (const s of spans) {
                const l = getLinesNeeded(s)
                if (lineCount + l > process.stdout.rows - screenTop) break

                rows.push(s)
                lineCount += l
            }

            writer.write(rows.map(getSpanText).join('\n'))

            if (rows.some(s => s.spinner)) {
                t = +setTimeout(_redraw, 25).unref()
            }

            perfTime += performance.now() - p
        }

        let t: number | undefined
        function redraw() {
            if (t !== undefined) {
                return
            }

            if (screenTop !== undefined) {
                t = +setTimeout(_redraw).unref()
            } else {
                t = +setTimeout(() => getScreenTop().then(_redraw)).unref()
            }
        }

        function rowFromSpan(s: Span): DisplayRow {
            const existing = rows.get(s)
            if (existing) {
                return existing
            }

            function update(text: string) {
                if (s.released) {
                    return
                }

                if (s.text !== text) {
                    widthCache.delete(s)
                    s.text = text
                    redraw()
                }
            }

            function release(text?: string, emptyDelay?: number) {
                if (s.released) {
                    return
                }

                if (text !== undefined) {
                    widthCache.delete(s)
                    s.text = text
                }

                s.released = true
                redraw()

                if (emptyDelay !== undefined) {
                    setTimeout(() => {
                        s.forceRemove = true
                        redraw()
                    }, emptyDelay).unref()
                }
            }

            function destroy() {
                if (s.released) {
                    return
                }

                s.released = true
                const idx = spans.indexOf(s)
                if (idx === -1) {
                    return
                }

                const needsSwap = idx !== spans.length - 1
                if (needsSwap) {
                    swap(spans, idx, spans.length - 1)
                }

                spans[spans.length - 1] = {
                    id: idCounter++,
                    empty: true,
                    text: '',
                }

                if (needsSwap) {
                    needsSort = true
                }

                redraw()
            }

            const row: DisplayRow = { update, release, destroy }
            rows.set(s, row)

            return row
        }

        function createSpan(attr: Omit<Span, 'id'>): Span {
            return {
                id: idCounter++,
                ...attr,
            }
        }

        function findAvailableIndex(allowOpen = false) {
            for (let i = spans.length - 1; i >= 0; i--) {
                const s = spans[i]
                if (s.row !== undefined) {
                    continue
                } else if (s.empty || (allowOpen && s.open)) {
                    return i
                } else {
                    break
                }
            }

            return -1
        }

        function findOrCreateSpan(attr: Omit<Span, 'id' | 'empty'>) {
            const p = performance.now()
            const idx = findAvailableIndex()
            if (idx === -1) {
                const s: Span = createSpan(attr)
                perfTime += performance.now() - p
                addSpan(s)

                return s
            }

            const s = spans[idx] = createSpan(attr)

            redraw()
            perfTime += performance.now() - p

            return s
        }

        const rows = new WeakMap<Span, DisplayRow>()
        function createRow(text = '', row = 0, spinner?: Spinner): DisplayRow {
            const s = findOrCreateSpan({ text, released: false, row, spinner })

            return rowFromSpan(s)
        }

        function createFooter(text = '') {
            return createRow(text, -1)
        }

        function write(text: string = '', leaveOpen = true) {
            const p = performance.now()
            const idx = findAvailableIndex(true)
            if (idx === -1) {
                perfTime += performance.now() - p

                return addSpan(createSpan({ text, open: leaveOpen }))
            }

            if (spans[idx].empty) {
                spans[idx] = createSpan({ text, open: leaveOpen })
            } else {
                spans[idx].text += text
                spans[idx].open = leaveOpen
            }

            redraw()
            perfTime += performance.now() - p
        }

        // Writes text in the non-overlayed screen, potentially scrolling the screen down
        function writeLine(text: string = '') {
            write(text, false)
        }

        async function _dispose() {
            if (getCursorPosition.cached) {
                await getCursorPosition()
            }

            const p = performance.now()

            // Erase anything we've already drawn
            if (screenTop !== undefined) {
                writer.cursorTo(0, screenTop)
                writer.clearScreenDown()
            }

            if (needsSort) {
                sortSpans()
            }

            const nonEmpty = spans.filter(x => !x.empty)
            if (spans.length > 0) {
                writer.write(nonEmpty.map(getSpanText).join('\n') + '\n')
                spans.length = 0
            }

            perfTime += performance.now() - p

            getLogger().debug(`Time spent on UI: ${Math.floor(perfTime * 100) / 100}ms (${frames} frames)`)
        }

        let disposed = false
        function dispose() {
            if (disposed) {
                return
            }

            clearTimeout(t)
            disposed = true

            return _dispose()
        }

        async function clearScreen() {
            if (disposed) {
                return
            }

            clearTimeout(t)
            spans.length = 0
            if (screenTop !== undefined) {
                writer.cursorTo(0, screenTop)
                writer.clearScreenDown()
            }
            await writer.flush()
        }

        return { 
            write: (text: string) => write(text, true), 
            writeLine, 
            createRow, 
            createFooter, 
            dispose, 
            clearScreen,
            get disposed() {
                return disposed
            }
        }
    }

    function cancelPending(data: ViewData) {
        while (data.pendingWrites.length > 0) {
            writer.cancel(data.pendingWrites.shift()!)
        }
    }

    function renderCurrentView() {
        const name = getCurrentView()
        if (!name) {
            writer.clearScreen()
            return
        }

        const data = views.get(name)!
        cancelPending(data)
        renderView(data)
    }

    function hideView(name: string) {
        const index = viewStack.indexOf(name)
        if (index === -1) {
            return
        }

        swap(viewStack, index, viewStack.length - 1)
        viewStack.pop()

        if (index === viewStack.length) {
            cancelPending(views.get(name)!)
            renderCurrentView()
        }
    }

    let didSetup = false
    function swapView(name: string) {
        const index = viewStack.indexOf(name)
        if (index === -1) {
            if (viewStack.length === 0 && !didSetup) {
                writer.setupScreen()
                didSetup = true
            }
            viewStack.push(name)
        } else {
            swap(viewStack, index, viewStack.length - 1)
            if (index !== viewStack.length - 1) {
                cancelPending(views.get(viewStack[index])!)
            }
        }
    }

    function getCurrentView(): string | undefined {
        return viewStack[viewStack.length - 1]
    }

    function bound(val: number, max: number, min = 0) {
        return Math.max(min, Math.min(val, max))
    }

    function moveCursor(name: string, dx: number, dy: number) {
        const data = views.get(name)
        if (!data) {
            return
        }

        const maxRows = (process.stdout.rows - (data.fullScreen ? 0 : 1))
        const column = bound(data.cursorPosition.column + dx, process.stdout.columns - 1)

        const row = bound(data.cursorPosition.row + dy, Math.min(
            data.rows.length - 1,
            maxRows - 1,
        ))
        
        const scroll = dy < 0 
            ? Math.min(0, data.cursorPosition.row + dy)
            : Math.max(0, (data.cursorPosition.row + dy) - (maxRows - 1))

        const currentRow = bound(data.currentRow + scroll, data.rows.length - maxRows)

        const updated = {
            ...data,
            currentRow,
            cursorPosition: { column, row }
        }

        views.set(name, updated)
        if (getCurrentView() === name) {
            cancelPending(data)
            renderView(updated)
        }
    }

    function createView(name: string, opt?: { hideCursor?: boolean }) {
        views.set(name, {
            rows: [],
            currentRow: 0, 
            pendingWrites: [],
            cursorPosition: { row: 0, column: 0 },
        })

        function show() {
            if (getCurrentView() === name) {
                return
            }

            if (opt?.hideCursor) {
                writer.hideCursor()
            }

            swapView(name)
            renderCurrentView()
        }

        function hide() {
            hideView(name)

            if (opt?.hideCursor) {
                writer.showCursor()
            }
        }

        function writeLine(line: string) {
            const data = views.get(name)!
            const currentRow = data.currentRow + 1
            data.rows.push(line)
            const updated = {
                ...data,
                currentRow,
                cursorPosition: {
                    column: 0,
                    row: Math.min(currentRow, process.stdout.rows)
                }
            }

            views.set(name, updated)

            if (getCurrentView() === name) {
                if (updated.cursorPosition.row === process.stderr.rows) {
                    cancelPending(updated)
                    data.pendingWrites.push(writer.writeRows(updated.rows))
                } else {
                    data.pendingWrites.push(writer.write(line + '\n'))
                }
            }
        }

        function setRows(rows: string[]) {
            const data = views.get(name)!
            const updated = {
                ...data,
                rows,
            }
            views.set(name, updated)

            if (getCurrentView() === name) {
                cancelPending(data)
                renderView(updated)
            }
        }

        function dispose() {
            hide()
            views.delete(name)

            return writer.flush()
        }

        return { show, hide, writeLine, setRows, dispose, moveCursor: (dx: number, dy: number) => moveCursor(name, dx, dy) }
    }

    function _createOverlayableView(): ReturnType<typeof createOverlayableView> {
        if (process.stdout.isTTY) {
            return createOverlayableView()
        }

        const write = (msg: string) => process.stdout.write(stripAnsi(msg))

        function createDisplayRow(text?: string): DisplayRow {
            let currentText = text

            return {
                update: text => { currentText = text },
                release: text => { 
                    currentText = text ?? currentText
                    write(`${currentText}\n`)
                },
                destroy: () => {},
            }
        }

        return {
            write,
            writeLine: msg => msg ? write(`${msg}\n`) : write('\n'),
            createFooter: text => createDisplayRow(text),
            createRow: (text) => createDisplayRow(text),
            dispose: async () => {},
            clearScreen: async () => {},
            get disposed() {
                return false
            },
        }
    }

    const getOverlayedView = memoize(_createOverlayableView)

    async function releaseTty(closeStdout = false) {
        if (getOverlayedView.cached) {
            const v = getOverlayedView()
            await v.dispose()
        }

        if (process.stdout.isTTY) {
            writer.showCursor()
        }

        if (closeStdout) {
            await writer.end()
        } else {
            await writer.flush()
        }

        writer.tty?.dispose()
    }

    let disposed = false
    async function dispose() {
        if (disposed) {
            return
        }

        disposed = true
        if (!process.stdout.isTTY) {
            return
        }

        await releaseTty(true)
    }

    return { 
        createView, 
        getOverlayedView, 
        dispose, 
        releaseTty, 
        writer,
        [Symbol.asyncDispose]: dispose,
    }
}

export interface TreeItem {
    readonly id: string
    readonly children: TreeItem[]
    label: string
    visible: boolean
    sortOrder: number
}

export function createTreeView(name: string, display = getDisplay()) {
    const view = display.createView(name, { hideCursor: true })
    const items = new Map<string, TreeItem>()
    const roots: TreeItem[] = []

    function renderItem(item: TreeItem, depth = 0): string[] {
        const rows: string[] = []
        if (!item.visible) {
            return rows
        }

        rows.push(`${'    '.repeat(depth)}${item.label}`)

        for (const child of item.children.sort((a, b) => a && b ? a.sortOrder - b.sortOrder : 0)) {
            // Child could have been deleted
            if (child) {
                rows.push(...renderItem(child, depth + 1))
            }
        }

        return rows
    }

    function getRows() {
        const rows: string[] = []
        for (const item of roots.sort((a, b) => a.sortOrder - b.sortOrder)) {
            rows.push(...renderItem(item))
        }

        return rows
    }

    function render() {
        view.setRows(getRows())
    }

    function createItem(id: string, label = ''): TreeItem {
        if (items.has(id)) {
            throw new Error(`Item with id already exists: ${id}`)
        }

        const children = new Proxy([] as TreeItem['children'], {
            set: (arr, p, val, recv) => {
                if (p === 'length' && arr.length !== val) {
                    render()

                    return Reflect.set(arr, p, val, recv)
                }

                const index = Number(p)
                if (!isNaN(index) && arr[index] !== val) {
                    render()
                }

                return Reflect.set(arr, p, val, recv)
            },
            deleteProperty: (arr, p) => {
                const index = Number(p)
                if (!isNaN(index) && arr[index]) {
                    render()
                }

                return Reflect.deleteProperty(arr, p)
            },
        })

        let visible = true
        let sortOrder = 0

        const item: TreeItem = {
            id,
            children,

            get label() {
                return label
            },

            set label(val: string) {
                if (val !== label) {
                    label = val
                    render()
                }
            },

            get visible() {
                return visible
            },

            set visible(val: boolean) {
                if (val !== visible) {
                    visible = val
                    render()
                }
            },

            get sortOrder() {
                return sortOrder
            },

            set sortOrder(val: number) {
                if (val !== sortOrder) {
                    sortOrder = val
                    render()
                }
            },
        }

        items.set(id, item)

        return item
    }

    function addItem(item: TreeItem): void {
        roots.push(item)
        render()
    }

    function _removeItem(arr: TreeItem[], item: TreeItem): boolean {
        let didRemove = false
        const index = arr.indexOf(item)
        if (index !== -1) {
            arr.splice(index, 1)
            didRemove = true
        }

        for (const c of arr) {
            if (c.children.length > 0) {
                didRemove ||= _removeItem(c.children, item)
            }
        }

        return didRemove
    }

    function removeItem(item: TreeItem): void {
        const didRemove = _removeItem(roots, item)
        if (didRemove) {
            items.delete(item.id)
            render()
        }
    }

    function clearItems() {
        items.clear()
        roots.length = 0
        render()
    }

    return { 
        addItem,
        removeItem,
        createItem, 
        clearItems,
        getRows, // Kind of a leaky abstraction but eh
        show: () => view.show(),
        hide: () => view.hide(),
        dispose: () => view.dispose(),
    }
}

// This is preferred over `console.log` because we want to change the output depending on where the tool is ran
export function print(msg: string) {
    if (!process.stdout.isTTY || getDisplay().getOverlayedView().disposed) {
        return process.stdout.write(stripAnsi(msg))
    }

    // XXX: not a good impl.
    const view = getDisplay().getOverlayedView()
    if (msg.endsWith('\n')) {
        const lines = msg.slice(0, -1).split('\n')
        for (const l of lines) {
            view.writeLine(l)
        }
    } else {
        view.write(msg)
    }
}

// Why not call this `println`? Because not everyone knows `ln` === `line`
export function printLine(msg: string = '', ...args: any[]) {
    return print([msg, ...args].map(String).join(' ') + '\n')
}

export function printJson(data: any) {
    return print(JSON.stringify(data, undefined, 4) + '\n')
}

export class RenderableError extends Error {
    public constructor(message: string, private readonly renderFn: () => Promise<void> | void) {
        super(message)
    }

    public render() {
        return this.renderFn()
    }
}

export interface Spinner {
    readonly frames: string[]
    readonly rotationsPerSecond: number
}

const brailleSpinner: Spinner = {
    rotationsPerSecond: 1/2,

    // Braille grid
    // 1 4
    // 2 5
    // 3 6
    // 7 8

    frames: [
        '\u2806', // 23
        '\u2807', // 123
        '\u2803', // 12
        '\u280b', // 124
        '\u2809', // 14
        '\u2819', // 145
        '\u2818', // 45
        '\u2838', // 456
        '\u2830', // 56
        '\u2834', // 356
        '\u2824', // 36
        '\u2826', // 236
    
        // MacOS system font doesn't show the bottom 2 dots if they're empty
    
        // '\u28b0', // 568
        // '\u28a0', // 68
        // '\u28e0', // 678
        // '\u28c0', // 78
        // '\u28c4', // 378
        // '\u2844', // 37
        // '\u2846', // 237
    ]    
}

const ellipsisSpinner: Spinner = {
    frames: ['', '.', '..', '...'],
    rotationsPerSecond: 1/4,
}

export function getSpinnerFrame(spinner: Spinner, duration: number) {
    const framesPerSecond = spinner.frames.length * spinner.rotationsPerSecond
    const frame = Math.floor((duration / 1000) * framesPerSecond)

    return spinner.frames[frame % spinner.frames.length]
}

// circle spinner ['◴', '◷', '◶', '◵']
// bar spinner 
// [
//     '—',       // 1 em dash (U+2014)
//     '\u27cb',   // ⟋
//     '|',
//     '\u27cb'    // ⟍
// ]

const emtpySpinner: Spinner = {
    frames: [''],
    rotationsPerSecond: 0,
}

export const spinners = {
    empty: emtpySpinner,
    braille: brailleSpinner,
    ellipsis: ellipsisSpinner,
} satisfies Record<string, Spinner>

export function formatDuration(ms: number) {
    if (ms >= 100000) {
        // Show no decimal places
        // 521852 -> 522s
        return `${Math.round(ms / 1000)}s`
    }

    if (ms >= 10000) {
        // Show 1 decimal place
        // 18472 -> 18.5s
        return `${Math.round(ms / 100) / 10}s`
    }

    if (ms >= 1000) {
        // Show 2 decimal places
        // 1374 -> 1.37s
        return `${Math.round(ms / 10) / 100}s`
    }

    return `${ms}ms`
}

export function renderDuration(duration?: number) {
    return duration ? dim(` [${formatDuration(duration)}]`) : ''
}

export function format(...args: any[]) {
    return nodeUtil.formatWithOptions({ colors: process.stdout.isTTY }, ...args)
}