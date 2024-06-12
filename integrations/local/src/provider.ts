import * as core from 'synapse:core'
import * as srl from 'synapse:srl'
import * as path from 'node:path'
import { homedir } from 'node:os'

// TODO: add a process manager

export class Provider implements srl.Provider {
    static readonly [core.contextType] = 'local'
}

export const getLocalPath = core.defineDataSource((suffix: string) => {
    const synapseDir = process.env['SYNAPSE_INSTALL'] || path.resolve(homedir(), '.synapse')

    return path.resolve(synapseDir, 'local', suffix)
})

core.addTarget(srl.Provider, Provider, 'local')
