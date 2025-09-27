import type { TfJson } from './runtime/modules/terraform'

const enum ValueKind {
    _,
    Boolean,
    Null,
    u32,
    i32,
    u64,
    i64,
    f64,
    String,
    EmptyString,
    RegExp,
    Object,
    Array,
    Identifier,
    CallExpression,
    PropertyAccess,
    ElementAccess,
    AddExpression,
}

function createBinaryDeserializer(buf: Buffer) {
    let offset = 0
    let strings: string[]

    function readKind() {
        const kind = buf.readUint8(offset) as ValueKind
        offset += 1

        return kind
    }

    function readSize() {
        const size = buf.readUInt32LE(offset)
        offset += 4

        return size
    }

    function readValue(): any {
        const kind = readKind()

        switch (kind) {
            // Fixed-sized values
            case ValueKind.Null:
                return null
            case ValueKind.EmptyString:
                return ""
            case ValueKind.Boolean:
                return readBoolean()
            case ValueKind.String:
            case ValueKind.Identifier:
                return readStringLike()
            case ValueKind.RegExp:
                return new RegExp(readStringLike())

            case ValueKind.i32: {
                const val = buf.readInt32LE(offset)
                offset += 4

                return val
            }

            case ValueKind.u32: {
                const val = buf.readUint32LE(offset)
                offset += 4

                return val
            }

            case ValueKind.i64: {
                const val = buf.readBigInt64LE(offset)
                offset += 8

                return Number(val) // FIXME
            }

            case ValueKind.u64: {
                const val = buf.readBigUint64LE(offset)
                offset += 8

                return Number(val) // FIXME
            }

            case ValueKind.f64: {
                const val = buf.readDoubleLE(offset)
                offset += 8

                return val
            }

            case ValueKind.CallExpression:
                return readCallExpression()

            case ValueKind.PropertyAccess:
                return readPropertyAccess()

            case ValueKind.AddExpression: 
                // readSize()
                // console.log(readValue(), readValue())
                // return '<add>'
            
            case ValueKind.ElementAccess:
                const s = readSize()
                // console.log(readValue(),readValue())  
                offset += s
                return {} // TODO

            case ValueKind.Object:
                readSize()
                return readLazyObject()

            case ValueKind.Array:
                readSize()
                return readArray()

            default:
                throw new Error(`TODO: ${kind}`)

        }
    }

    function readBoolean() {
        const v = buf.readUint8(offset)
        offset += 1

        return v > 0
    }

    function readStringLike() {
        const index = buf.readUint32LE(offset)
        offset += 4

        return strings[index]
    }

    function readArray() {
        const length = buf.readUint32LE(offset)
        offset += 4

        const arr: any[] = new Array(length)
        for (let i = 0; i < length; i++) {
            arr[i] = readValue()
        }
        return arr
    }

    // XXX: we're just materializing it as a string for now
    function readPropertyAccess() {
        readSize()
        const target = readValue()
        const member = readStringLike()

        return `${target}.${member}`
    }

    function readCallExpression() {
        const s = readSize()
        const ident = readStringLike()
        // if (ident === 'jsonencode') {
        //     const args = readArray()
        //     return args[0]
        // }

        if (ident !== 'markpointer') {
            // TODO
            offset += s - 4
            return {}
        }

        const args = readArray()
        return `pointer:${args[1]}:${args[0]}`
    }

    // TODO: we shouldn't skip fixed-sized values
    function skip() {
        const kind = readKind()

        switch (kind) {
            case ValueKind.Null:
            case ValueKind.EmptyString:
                break

            case ValueKind.Boolean:
                offset += 1
                break

            case ValueKind.String:
            case ValueKind.Identifier:
            case ValueKind.RegExp:
            case ValueKind.i32:
            case ValueKind.u32:
                offset += 4
                break

            case ValueKind.i64:
            case ValueKind.u64:
            case ValueKind.f64:
                offset += 8
                break

            case ValueKind.Array:
            case ValueKind.Object:
            case ValueKind.AddExpression:
            case ValueKind.CallExpression:
            case ValueKind.ElementAccess:
            case ValueKind.PropertyAccess:
                const s = readSize()
                offset += s
                break

            default:
                throw new Error(`TODO: ${kind}`)

        }
    }

    function lazyDescriptor(key: PropertyKey, from: number): PropertyDescriptor {
        return {
            enumerable: true,
            configurable: true,
            get: function (this: any) {
                const originalOffset = offset
                offset = from
                const value = readValue()
                Object.defineProperty(this, key, { value, enumerable: true, writable: true, configurable: true })
                offset = originalOffset

                return value
            },
            set: function (this: any, value: any) {
                Object.defineProperty(this, key, { value, enumerable: true, writable: true, configurable: true })
            },
        }
    }

    function readLazyObject() {
        const numFields = buf.readUint32LE(offset)
        offset += 4

        const res: Record< string, any> = {}
        for (let i = 0; i < numFields; i++) {
            const index = buf.readUint32LE(offset)
            offset += 4
            Object.defineProperty(res, strings[index], lazyDescriptor(strings[index], offset))
            skip()
        }

        return res
    }

    function readObject() {
        const numFields = buf.readUint32LE(offset)
        offset += 4

        const res: Record<string, any> = {}
        for (let i = 0; i < numFields; i++) {
            const index = buf.readUint32LE(offset)
            offset += 4
            res[strings[index]] = readValue()
        }

        return res
    }

    function readStringTable() {
        if (strings) {
            return
        }

        if (offset !== 0) {
            throw new Error(`Can only read string table at the start of deserialization`)
        }

        const version = buf.readUint32LE()
        offset += 4

        if (version !== 1) {
            throw new Error(`Unsupported version: ${version}`)
        }

        const numStrings = buf.readUint32LE(offset)
        offset += 4

        strings = new Array(numStrings)
        for (let i = 0; i < numStrings; i++) {
            const length = buf.readUInt32LE(offset)
            offset += 4
            strings[i] = buf.subarray(offset, offset + length).toString('utf-8')
            offset += length
        }
    }

    function deserialize() {
        readStringTable()

        return readValue()
    }

    return { deserialize }
}

export function deserializeBinaryTemplate(buf: Buffer): TfJson {
    return createBinaryDeserializer(buf).deserialize()
}
