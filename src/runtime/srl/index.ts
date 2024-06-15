//# moduleId = synapse:srl

export * as net from './net'
export * as compute from './compute'
export * as storage from './storage'

//# resource = true
export declare class Provider {
    constructor(props?: any)
}

// Re-exporting common resources so they're easier to find
// export { Function, HttpService } from './compute'
// export { Bucket, Queue, Table, Counter } from './storage'