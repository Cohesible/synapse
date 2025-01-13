import { defineResource } from 'synapse:core'
import { Bucket } from 'synapse:srl/storage'

export const b = new Bucket()

class Obj extends defineResource({
    create: async () => {
        await b.put('foo', 'bar')
    },
}) {}

new Obj()
