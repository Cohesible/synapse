import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as DynamoDB from '@aws-sdk/client-dynamodb'
import * as aws from 'synapse-provider:aws'
import { createClient } from './clients'
import { addReplacementHook, generateIdentifier } from 'synapse:lib'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import * as storage from 'synapse:srl/storage'
import { HttpError } from 'synapse:http'
import { addResourceStatement } from '../permissions'

// DBB name: 3-255
// [a-zA-Z0-9_.-]+

export class Table<K, V> {
    private readonly client = createClient(DynamoDB.DynamoDB)
    public readonly resource: aws.DynamodbTable
    private readonly keyPrefix = undefined

    public constructor() {
        // FIXME: use map type
        this.resource = new aws.DynamodbTable({
            name: generateIdentifier(aws.DynamodbTable, 'name'),
            billingMode: 'PAY_PER_REQUEST',
            hashKey: '__key',
            attribute: [{
                name: '__key',
                type: 'S',
            }],
            pointInTimeRecovery: lib.isProd() ? { enabled: true } : undefined,
            // TODO: enable this via a CLI flag too?
            deletionProtectionEnabled: lib.isProd() ? true : undefined,
        })
    }

    public async get(key: K): Promise<V | undefined> {
        const resp = await this.client.getItem({
            TableName: this.resource.name,
            Key: this.makeKey(key),
            ConsistentRead: true, // TODO: make configurable
        })
    
        const data = resp.Item?.['__value']?.['S']
        if (data === undefined) {
            return data as any
        }

        return JSON.parse(data)
    }

    public async set(key: K, val: V): Promise<void> {
        await this.client.putItem({
            TableName: this.resource.name,
            Item: {
                ...this.makeKey(key),
                __value: { S: JSON.stringify(val) } // BUG: this fails for non-serializable shapes
            },
        })
    }

    public async delete(key: K): Promise<void> {
        await this.client.deleteItem({
            TableName: this.resource.name,
            Key: this.makeKey(key),
        })
    }

    public async keys(): Promise<K[]> {
        const resp = await this.client.scan({
            TableName: this.resource.name,
            ProjectionExpression: '#k',
            ExpressionAttributeNames: { '#k': '__key' },
        })

        return resp.Items!.map(i => i['__key']['S']! as K)
    }

    async *values(): AsyncIterable<V[]> {
        let startKey: Record<string, DynamoDB.AttributeValue> | undefined
        while (true) {
            const resp = await this.client.scan({
                TableName: this.resource.name,
                ProjectionExpression: '#v',
                ExpressionAttributeNames: { '#v': '__value' },
                ExclusiveStartKey: startKey,
            })
    
            yield resp.Items!.map(i => JSON.parse(i['__value']!['S']!))
    
            startKey = resp.LastEvaluatedKey
            if (!startKey) {
                break
            }
        }
    }

    public async getBatch(keys: K[]): Promise<{ key: K, value: V }[]> {
        const batches = chunk(keys, 100)
        const items: Record<string, DynamoDB.AttributeValue>[] = []
        for (const batch of batches) {
            const resp = await this.client.batchGetItem({
                RequestItems: {
                    [this.resource.name]: {
                        Keys: batch.map(k => this.makeKey(k)),
                    }
                }
            })
    
            if (resp.UnprocessedKeys && Object.keys(resp.UnprocessedKeys).length > 0) {
                throw new Error('Handling unprocessed keys is not implemented')
            }
        
            items.push(...resp.Responses![this.resource.name])
        }

        const result: { key: K, value: V }[] = []
        for (const item of items) {
            const itemKey = item['__key']['S']
            const key = keys.find(k => this.makeKey(k)['__key']['S'] === itemKey)
            if (!key) continue // Item wasn't in response

            const data = item['__value']['S']!
            result.push({ key, value: JSON.parse(data) })
        }

        return result
    }

    // This can't be used to update items but that's fine here
    public async setBatch(items: { key: K, value: V }[]): Promise<void> {
        const batches = chunk(items, 25)
        for (const batch of batches) {
            const resp = await this.client.batchWriteItem({
                RequestItems: {
                    [this.resource.name]: batch.map(i => {
                        return {
                            PutRequest: {
                                Item: {
                                    ...this.makeKey(i.key),
                                    __value: { S: JSON.stringify(i.value) } // BUG: this fails for non-serializable shapes
                                }
                            }
                        }
                    })
                }
            })

            if (resp.UnprocessedItems && Object.keys(resp.UnprocessedItems).length > 0) {
                throw new Error('Handling unprocessed keys is not implemented')
            }
        }
    }

    // TODO
    // public async query(expression: any): Promise<T[]> {
    // }

    private makeKey(key: K) {
        return {
            __key: {
                S: this.keyPrefix !== undefined ? `${this.keyPrefix}#${String(key)}` : String(key)
            }
        }
    }
}

async function poll<T>(fn: () => Promise<T | undefined>, interval = 500, timeout = 60_000): Promise<T> {
    const start = Date.now()
    while ((Date.now() - start) < timeout) {
        const val = await fn()
        if (val !== undefined) {
            return val
        }

        await new Promise<void>(r => setTimeout(r, interval))
    }
    
    throw new Error(`Timed out waiting for state transition`)
}

async function* scanTable(tableName: string, client = createClient(DynamoDB.DynamoDB)) {
    let startKey: Record<string, DynamoDB.AttributeValue> | undefined
    while (true) {
        const resp = await client.scan({
            TableName: tableName,
            ProjectionExpression: '#k',
            ExpressionAttributeNames: { '#k': '__key' },
            ExclusiveStartKey: startKey,
        })

        yield resp.Items!

        startKey = resp.LastEvaluatedKey
        if (!startKey) {
            break
        }
    }
}

async function putItems(tableName: string, items: Record<string, DynamoDB.AttributeValue>[], client = createClient(DynamoDB.DynamoDB)) {
    const batches = chunk(items, 25)
    for (const batch of batches) {
        const resp = await client.batchWriteItem({
            RequestItems: {
                [tableName]: batch.map(i => {
                    return {
                        PutRequest: {
                            Item: i
                        }
                    }
                })
            }
        })

        if (resp.UnprocessedItems && Object.keys(resp.UnprocessedItems).length > 0) {
            throw new Error('Handling unprocessed keys is not implemented')
        }
    }
}


function addDbbBackupHook(table: aws.DynamodbTable, client = createClient(DynamoDB.DynamoDB)) {
    addReplacementHook(table, {
        beforeDestroy: async inst => {
            const backupName = `${inst.name}-bk`.slice(Math.min(0, 97 - inst.name.length))
            const resp = await client.createTable({
                TableName: backupName,
                BillingMode: 'PAY_PER_REQUEST',
                AttributeDefinitions: [
                    {
                        AttributeName: '__key',
                        AttributeType: 'S',
                    }
                ],
                KeySchema: [
                    {
                        AttributeName: '__key',
                        KeyType: 'HASH',
                    }
                ]
            })

            const pollFn = async () => {
                const resp = await client.describeTable({ TableName: backupName })
                const status = resp.Table!.TableStatus
                if (status === 'ACTIVE') {
                    return resp
                }
            }

            await poll(pollFn)

            for await (const items of scanTable(inst.name, client)) {
                await putItems(backupName, items, client)
            }

            return { backupName }
        },
        afterCreate: async (inst, state) => {
            for await (const items of scanTable(state.backupName, client)) {
                await putItems(inst.name, items, client)
            }

            await client.deleteTable({
                TableName: state.backupName,
            })
        },
    })
}

function serialize(obj: any): DynamoDB.AttributeValue {
    switch (typeof obj) {
        case 'string':
            return { S: obj }
        case 'number':
            return { N: String(obj) }
        case 'boolean':
            return { BOOL: obj }
        case 'object':
            return serializeObject(obj)
        default:
            throw new Error(`Unable to serialize object: ${obj}`)
    }

    function serializeObject(o: any): DynamoDB.AttributeValue {
        if (o === null) {
            return { NULL: true }
        }
    
        if (Array.isArray(o)) {
            return { L: o.map(serialize) }
        }
        
        const proto = Object.getPrototypeOf(o)
        if (proto !== Object.prototype && proto !== null) {
            throw new Error(`Unable to serialize object: ${o}`)
        }

        const res: Record<string, DynamoDB.AttributeValue> = {}
        for (const [k, v] of Object.entries(o)) {
            if (v !== undefined) {
                res[k] = serialize(v)
            }
        }

        return { M: res }
    }
}

function deserialize(item: Record<string, DynamoDB.AttributeValue>): any {
    const res: Record<string, any> = {}
    for (const [k, v] of Object.entries(item)) {
        res[k] = deserializeValue(v)
    }

    return res

    function deserializeValue(value: DynamoDB.AttributeValue): any {
        if ('S' in value) {
            return value['S']
        } else if ('N' in value) {
            return Number(value['N'])
        } else if ('BOOL' in value) {
            return value['BOOL']
        } else if ('L' in value) {
            return value['L']!.map(deserializeValue)
        } else if ('M' in value) {
            return deserialize(value['M']!)
        } else if (value['NULL']) {
            return null
        }

        // BUG: throw here?
    }
}

function* chunk<T>(arr: T[], amount: number) {
    while (arr.length > 0) {
        yield arr.splice(0, Math.min(arr.length, amount))
    }
}

export class Cache<K extends string = string, V = any> {
    private readonly client = new DynamoDB.DynamoDB()
    public readonly resource: aws.DynamodbTable

    // TTL is in seconds
    public constructor(private readonly ttl = 3600) {
        this.resource = new aws.DynamodbTable({
            name: generateIdentifier(aws.DynamodbTable, 'name'),
            billingMode: 'PAY_PER_REQUEST',
            hashKey: 'hashKey',
            attribute: [
                {
                    name: 'hashKey',
                    type: 'S',
                }
            ],
            ttl: {
                enabled: true,
                attributeName: 'expirationTime',
            }
        })
    }

    public async put(key: K, value: V) {
        await this.client.putItem({
            TableName: this.resource.name,
            Item: serialize({
                hashKey: key,
                value,
                expirationTime: Math.floor(Date.now() / 1000) + this.ttl,
            })['M'],
        })
    }

    public async get(key: K): Promise<V | undefined> {
        const resp = await this.client.getItem({
            TableName: this.resource.name,
            Key: serialize({ hashKey: key })['M'],
            ConsistentRead: true, // TODO: make configurable
        })

        if (!resp.Item) {
            return
        }

        return deserialize(resp.Item)['value']
    }

    public async delete(key: K) {
        await this.client.deleteItem({
            TableName: this.resource.name,
            Key: serialize({ hashKey: key })['M'],
        })
    }

    public async keys(): Promise<K[]> {
        const resp = await this.client.scan({
            TableName: this.resource.name,
            ProjectionExpression: 'hashKey',
        })

        return resp.Items!.map(i => i['hashKey']['S']! as K)
    }
}

core.addTarget(storage.TTLCache, Cache, 'aws')

// XXX: must be a function, otherwise `Symbol.asyncDispose` won't be initialized
function getAsyncDispose(): typeof Symbol.asyncDispose {
    if (!Symbol.asyncDispose) {
        const asyncDispose = Symbol.for('Symbol.asyncDispose')
        Object.defineProperty(Symbol, 'asyncDispose', { value: asyncDispose, enumerable: true })
    }

    return Symbol.asyncDispose
}

export class SimpleLock {
    private readonly table = new Table<string, number>()
    async lock(id: string) {
        // Error: Not a function: ${table--Table.get} [kind: 212] (/Users/jadensimon/Projects/cloud-compiler/cloudscript-resources/src/services/aws/dynamodb.ts:92:32)
        // const isLocked = (await this.table.get(id)) === 1
        const currentState = await this.table.get(id)
        if (currentState === 1) {
            throw new HttpError(`Key is already locked: ${id}`, { statusCode: 423 })
        }

        await this.table.set(id, 1)

        return {
            id,
            [getAsyncDispose()]: () => this.unlock(id),
        }
    }

    async unlock(id: string) {
        await this.table.set(id, 0)
        // TODO: make perms work with this by fixing `await using` somehow
        // await this.table.delete(id)
    }
}

core.addTarget(compute.SimpleLock, SimpleLock, 'aws')

// https://docs.aws.html
// dynamodb:LeadingKeys – This condition key allows users to access only the items where the partition key value matches their user ID. This ID, ${www.amazon.com:user_id}, is a substitution variable. For more information about substitution variables, see Using web identity federation.
// dynamodb:Attributes – This condition key limits access to the specified attributes so that only the actions listed in the permissions policy can return values for these attributes. In addition, the StringEqualsIfExists clause ensures that the app must always provide a list of specific attributes to act upon and that the app can't request all attributes.
// "Condition": {
//     "ForAllValues:StringEquals": {
//     "dynamodb:LeadingKeys": [
//         "${www.amazon.com:user_id}"
//     ],
//     "dynamodb:Attributes": [
//         "UserId",
//         "GameTitle",
//         "Wins",
//         "Losses",
//         "TopScore",
//         "TopScoreDateTime"
//     ]
//     },
//     "StringEqualsIfExists": {
//     "dynamodb:Select": "SPECIFIC_ATTRIBUTES"
//     }

core.addTarget(storage.Table, Table, 'aws')
core.bindModel(DynamoDB.DynamoDB, {
    'putItem': function (req) {
        addResourceStatement({
            service: 'dynamodb',
            action: 'PutItem',
            resource: `table/${req.TableName}`
        }, this)

        return core.createUnknown()
    },
    'getItem': function (req) {
        addResourceStatement({
            service: 'dynamodb',
            action: 'GetItem',
            resource: `table/${req.TableName}`
        }, this)

        return core.createUnknown()
    },
    'batchGetItem': function (req) {
        const items = req.RequestItems!
        const tables = new Set(Object.keys(items))
        for (const t of tables) {
            addResourceStatement({
                service: 'dynamodb',
                action: 'BatchGetItem',
                resource: `table/${t}`
            }, this)
        }

        return { Responses: Object.fromEntries(Array.from(tables).map(t => [t, core.createUnknown()])) }
    },
    'batchWriteItem': function (req) {
        const items = req.RequestItems!
        const tables = new Set(Object.keys(items))
        for (const t of tables) {
            addResourceStatement({
                service: 'dynamodb',
                action: 'BatchWriteItem',
                resource: `table/${t}`
            }, this)
        }

        return {}
    },
    'deleteItem': function (req) {
        addResourceStatement({
            service: 'dynamodb',
            action: 'DeleteItem',
            resource: `table/${req.TableName}`
        }, this)

        return core.createUnknown()
    },
    'updateItem': function (req) {
        addResourceStatement({
            service: 'dynamodb',
            action: 'UpdateItem',
            resource: `table/${req.TableName}`
        }, this)

        return core.createUnknown()
    },
    'scan': function (req) {
        addResourceStatement({
            service: 'dynamodb',
            action: 'Scan',
            resource: `table/${req.TableName}`
        }, this)

        return core.createUnknown()
    },
    'listTables': function (req) {
        addResourceStatement({
            service: 'dynamodb',
            action: 'ListTables',
        }, this)

        return core.createUnknown()
    },
})

export class Counter {
    private static _table?: aws.DynamodbTable
    private static get table() {
        return this._table ??= new aws.DynamodbTable({
            name: generateIdentifier(aws.DynamodbTable, 'name'),
            billingMode: 'PAY_PER_REQUEST',
            hashKey: 'key',
            attribute: [
                {
                    name: 'key',
                    type: 'S',
                }
            ],
        })
    }

    private readonly item: CounterTableItem
    private readonly client = new DynamoDB.DynamoDB({})
    private readonly key = core.getCurrentId().split('--').join('-')

    public constructor(init = 0) {
        this.item = new CounterTableItem(Counter.table, this.key, init)
    }

    public get() {
        return this.item.get()
    }

    public async set(value: number) {
        const oldValue = await this.item.set(value)

        return Number(oldValue?.['value']?.['N'])
    }

    public async inc(amount = 1) {
        const resp = await this.client.updateItem({
            TableName: this.item.table.name,
            Key: { key: { S: this.key } },
            ExpressionAttributeNames: { '#v': 'value' },
            ExpressionAttributeValues: { ":inc": { N: `${amount}` } },
            UpdateExpression: "ADD #v :inc",
            ReturnValues: 'ALL_NEW',
        })
        
        const val = resp.Attributes?.['value']?.['N']
        
        return Number(val!)
    }
}

core.addTarget(storage.Counter, Counter, 'aws')

export class KeyedCounter {
    private static _table?: aws.DynamodbTable
    private static get table() {
        return this._table ??= new aws.DynamodbTable({
            name: generateIdentifier(aws.DynamodbTable, 'name'),
            billingMode: 'PAY_PER_REQUEST',
            hashKey: 'key',
            attribute: [
                {
                    name: 'key',
                    type: 'S',
                }
            ],
        })
    }

    private readonly client = new DynamoDB.DynamoDB({})
    private readonly table = KeyedCounter.table
    public constructor(private readonly init = 0) {}

    public async get(key: string): Promise<number> {
        const item = await getItem(this.table.name, key)

        return Number(item?.['value']?.['N'] ?? this.init)
    }

    public async set(key: string, value: number) {
        const oldValue = await putItem(this.table.name, key, value)

        return Number(oldValue?.['value']?.['N'])
    }

    public async inc(key: string, amount = 1) {
        const resp = await this.client.updateItem({
            TableName: this.table.name,
            Key: { key: { S: key } },
            ExpressionAttributeNames: { '#v': 'value' },
            ExpressionAttributeValues: { ":inc": { N: `${amount}` } },
            UpdateExpression: "ADD #v :inc",
            ReturnValues: 'ALL_NEW',
        })
        
        const val = resp.Attributes?.['value']?.['N']
        
        return Number(val!)
    }

    public async dec(key: string, amount = -1) {
        return this.inc(key, amount)
    }
}

core.addTarget(storage.KeyedCounter, KeyedCounter, 'aws')


class CounterTableItem extends core.defineResource({
    create: async (table: aws.DynamodbTable, key: string, value: number) => {
        await putItem(table.name, key, value)

        return { table, key }
    },
    update: state => state,
    // read: async (state) => {
    //     const item = await getItem(state.table.name, state.key)
    //     const data = item?.['value']?.['N']
    //     if (!data) {
    //         return { ...state, value: 0 }
    //     }

    //     return { ...state, value: Number(data) }
    // },
    delete: async (state) => {
        const client = createClient(DynamoDB.DynamoDB)
        try {
            await client.deleteItem({
                TableName: state.table.name,
                Key: { key: { S: state.key } },
            })
        } catch (e) {
            if ((e as any).name !== 'ResourceNotFoundException') {
                throw e
            }
        }
    }
}) {
    async get() {
        const { table, key } = this
        const item = (await getItem(table.name, key))?.['value']?.['N']
        if (!item) {
            throw new Error('Counter has no value set!')
        }

        return Number(item)
    }

    async set(value: number) {
        const { table, key } = this
        
        return await putItem(table.name, key, value)
    }
}

async function getItem(tableName: string, key: string, client = createClient(DynamoDB.DynamoDB)) {
    const resp = await client.getItem({
        TableName: tableName,
        Key: { key: { S: key } },
        ConsistentRead: true, 
    })

    return resp.Item
}

async function putItem(tableName: string, key: string, value: number, client = createClient(DynamoDB.DynamoDB)) {
    const resp = await client.putItem({
        TableName: tableName,
        Item: {
            key: { S: key },
            value: { N: String(value) }, 
        },
        ReturnValues: 'ALL_OLD',
    })

    return resp.Attributes
}