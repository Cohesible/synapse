import * as path from 'node:path'
import { getFs } from '../../execution'
import { getHash } from '../../utils'
import { createMemento } from '../../utils/memento'
import { runCommand } from '../../utils/process'
import { randomUUID } from 'node:crypto'
import { getUserSynapseDirectory } from '../../workspaces'

 // https://github.com/denisbrodbeck/machineid

async function getDarwinId() {
    const res = await runCommand('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const m = res.match(/"IOPlatformUUID" = "([0-9-]+)"/)
    if (!m) {
        return
    }

    return getHash(m[1])
}

async function getLinuxId() {
    const d = await getFs().readFile('/var/lib/dbus/machine-id', 'utf-8').catch(e => {
        return getFs().readFile('/etc/machine-id', 'utf-8').catch(e => {})
    })

    if (!d) {
        return
    }

    return getHash(d.trim())
}

async function getMachineId() {
    switch (process.platform) {
        case 'darwin':
            return getDarwinId()
        case 'linux':
            return getLinuxId()
    }
}

let deviceId: string 
async function _getDeviceId() {
    const memento = createMemento(getFs(), path.resolve(getUserSynapseDirectory(), 'memento'))
    const deviceId = await memento.get<string>('deviceId')
    if (deviceId) {
        return deviceId
    }

    const machineId = await getMachineId()
    if (machineId) {
        await memento.set('deviceId', machineId)

        return machineId
    }

    const newDeviceId = getHash(randomUUID())
    await memento.set('deviceId', newDeviceId)

    return newDeviceId
}

export async function getDeviceId() {
    return deviceId ??= await _getDeviceId()
}

async function approximateProjectId() {
    // 1. Get the current root dir
    // 2. Remove prefixes e.g. home dir
    // 3. Hash it
}