// Binary block format for build artifacts
// 4-bytes - # of hash LUT entries
// <hashes>
// <objects>
// Data segment

// # of hashes will always be equal to the # of obj
// Hashes are always sorted, allowing for binary search

function cmpBuffer(a: Buffer, b: Buffer) {
    if (a.byteLength !== b.byteLength) {
        return a.byteLength - b.byteLength
    }

    if (a.byteLength % 4 !== 0) {
        throw new Error(`Not implemented`)
    }

    for (let i = 0; i < a.byteLength; i += 4) {
        const c = a.readUInt32LE(i) - b.readUInt32LE(i)
        if (c !== 0) {
            return c
        }
    }

    return 0
}

function cmpTypedArray(a: Uint32Array, b: Uint32Array) {
    if (a.length !== b.length) {
        return a.length - b.length
    }

    for (let i = 0; i < a.length; i += 4) {
        const c = a[i] - b[i]
        if (c !== 0) {
            return c
        }
    }

    return 0
}

const objRecordSize = (32 + 4)

export function createBlock(objects: [string, Uint8Array][]) {
    const bytes = objects.map(o => [Buffer.from(o[0], 'hex'), o[1]] as const)
    bytes.sort((a, b) => cmpBuffer(a[0], b[0]))

    const headerSize = 4 + (bytes.length * objRecordSize)
    let totalSize = headerSize
    for (let i = 0; i < bytes.length; i++) {
        totalSize += bytes[i][1].byteLength
    }

    const block = Buffer.allocUnsafe(totalSize)

    let cursor = 0
    let dataOffset = 0
    cursor = block.writeUint32LE(bytes.length, cursor)

    for (let i = 0; i < bytes.length; i++) {
        const [h, d] = bytes[i]
        block.set(h, cursor)
        cursor += h.byteLength
        cursor = block.writeUint32LE(dataOffset, cursor)
        
        block.set(d, headerSize + dataOffset)
        dataOffset += d.byteLength
    }

    return block
}

export type DataBlock = ReturnType<typeof openBlock>

export function openBlock(block: Buffer) {
    const offsets: Record<string, number> = {}
    const numObjects = block.readUint32LE()
    const dataStart = 4 + (numObjects * objRecordSize)
    if (block.byteLength <= dataStart) {
        throw new Error(`Corrupted block: ${block.byteLength} <= ${dataStart}`)
    }

    function cmpBufferWithOffsets(b: Buffer, c: number) {
        for (let i = 0; i < 32; i += 4) {
            const z = block.readUInt32LE(i + c) - b.readUInt32LE(i)
            if (z !== 0) {
                return z
            }
        }

        return 0
    }

    function binarySearch(b: Buffer) {
        let lo = 0
        let hi = numObjects - 1
        while (lo <= hi) {
            const m = Math.floor((lo + hi) / 2)
            const z = cmpBufferWithOffsets(b, 4 + (m * objRecordSize))
            if (z < 0) {
                lo = m + 1
            } else if (z > 0) {
                hi = m - 1
            } else {
                return m
            }
        }

        return -1
    }

    function indexOf(hash: string) {
        const o = offsets[hash]
        if (o !== undefined) {
            return o
        }

        const b = Buffer.from(hash, 'hex')
 
        return offsets[hash] = binarySearch(b)
    }

    function hasObject(hash: string) {
        return indexOf(hash) !== -1
    }

    function getDataOffset(index: number) {
        return block.readUint32LE(4 + (index * objRecordSize) + 32) + dataStart
    }

    function readObject(hash: string) {
        const index = indexOf(hash)
        if (index === -1) {
            throw new Error(`Object not found: ${hash}`)
        }

        const start = getDataOffset(index)
        const end = index === numObjects - 1 ? block.byteLength : getDataOffset(index + 1)

        return block.subarray(start, end)
    }

    function listObjects() {
        const hashes: string[] = []
        for (let i = 0; i < numObjects; i++) {
            const offset = 4 + (i * objRecordSize)
            const hash = block.subarray(offset, offset + 32).toString('hex')
            offsets[hash] = i
            hashes.push(hash)
        }

        return hashes
    }

    return { 
        readObject, 
        hasObject, 
        listObjects,
    }
}

export function getBlockInfo(block: Buffer) {
    const b = openBlock(block)
    const hashes = b.listObjects()
    const objects = Object.fromEntries(hashes.map(h => [h, b.readObject(h)]))
    const headerSize = 4 + (hashes.length * objRecordSize)

    return {
        objects,
        headerSize,
        dataSize: block.byteLength - headerSize,
    }
}

function isInBloomFilter(key: Buffer, filter: Buffer) {
    const size = filter.byteLength
    const v = new Uint32Array(key.buffer)
    const l = v.length
    for (let i = 0; i < l; i += 1) {
        const p = v[i]
        const index = (p >>> 3) % size
        if (!(filter[index] & (1 << (p & 0x7)))) {
            return false
        }
    }

    return true
}

// The "block" data structure works exceptionally well with bloom
// filters because the object key is a hash of the object
//
// Using 10 bits per-element results in a false-positive rate of ~1%
//
// TODO: 11 bits per-element is theoretically better for 32-byte keys, but is it really?
function createBloomFilterData(keys: Buffer[], bitsPerElement = 10) {
    if (keys.length === 0) {
        throw new Error(`No keys provided`)
    }

    const buf = Buffer.alloc(keys.length * bitsPerElement)
    const size = buf.byteLength
    for (const k of keys) {
        // Assumption: `k` is an array of 4-byte integers
        const v = new Uint32Array(k.buffer)
        const l = v.length
        for (let i = 0; i < l; i += 1) {
            const p = v[i]
            const index = (p >>> 3) % size
            buf[index] |= 1 << (p & 0x7)
        }
    }

    return buf
}


// TODO: add `key` to object metadata and use that (plus `source`?) to delta compress commits
// Named objects can use their names as the key