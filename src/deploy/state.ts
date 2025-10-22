// TODO: move relevant util functions to this file

export interface TfResourceInstance {
    status?: 'tainted'
    schema_version: number
    attributes: Record<string, any>
    private?: string
    create_before_destroy?: boolean
    dependencies?: string[]
    sensitive_attributes?: {
        type: 'get_attr'
        value: string
    }[]
}

export interface TfResourceOld {
    type: string
    name: string
    provider: string
    instances: TfResourceInstance[]
}

export interface TfResource {
    type: string
    name: string
    provider: string
    state: TfResourceInstance
}

export interface TfStateOld {
    version: number
    serial: number
    lineage: string
    resources: TfResourceOld[]
}

export interface TfState {
    version: number
    serial: number
    lineage: string
    resources: TfResource[]
}

