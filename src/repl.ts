import * as repl from 'node:repl'
import * as net from 'node:net'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { CombinedOptions } from '.'
import { getLogger } from './logging'
import { getSocketsDirectory, getTargetDeploymentIdOrThrow, getUserSynapseDirectory } from './workspaces'
import { TfState } from './deploy/state'
import { SessionContext } from './deploy/deployment'
import { pointerPrefix } from './build-fs/pointers'
import { getDisplay } from './cli/ui'
import { getArtifactFs } from './artifacts'

export interface ReplOptions extends CombinedOptions {
    onInit?: (instance: ReplInstance) => void
}

interface ReplInstance {
    context: any
    setValue(name: string, value: any): void
}

export async function createReplServer(
    target: string,
    loader: ReturnType<SessionContext['createModuleLoader']>, 
    options: ReplOptions,
) {
    const socketsDir = getSocketsDirectory()
    const targetName = target.startsWith(pointerPrefix) 
        ? target.slice(pointerPrefix.length) 
        : getTargetDeploymentIdOrThrow()

    const socketAddress = path.resolve(socketsDir, targetName)
    if (socketAddress.length > 103) {
        throw new Error(`Socket address is too long`)
    }

    await fs.mkdir(path.dirname(socketAddress), { recursive: true })

    const server = net.createServer({})
    await new Promise<void>((resolve, reject) => {
        server.listen(socketAddress, () => {
            server.removeListener('error', reject)
            resolve()
        })
        server.once('error', reject)
    })

    getLogger().log('started server at', socketAddress)
    server.on('close', () => {
        getLogger().log('stopped server at', socketAddress)
    })

    let socket: net.Socket
    const dimensions = { columns: 100, rows: 12 }
    function resize(columns: number, rows: number) {
        dimensions.columns = columns
        dimensions.rows = rows
        socket?.emit('resize')
    }

    server.once('connection', async s => {
        getLogger().log('got connection')
        s.once('close', () => {
            server.close()
            instance.close()
        })

        socket = s
        
        Object.defineProperties(s, {
            columns: { get: () => dimensions.columns, enumerable: true, configurable: true },
            rows: { get: () => dimensions.rows, enumerable: true, configurable: true },
        })

        const instance = await createRepl(target, loader, options, s).catch(e => {
            getLogger().error('Failed to start REPL instance', (e as any).message)
            s.end()

            throw e
        })
        instance.on('close', () => s.end())
    })

    return {
        resize,
        address: socketAddress,
    }
}

async function createRepl(
    target: string | undefined,
    loader: ReturnType<SessionContext['createModuleLoader']>, 
    options: ReplOptions,
    socket?: net.Socket
) {
    const [targetModule, loggingModule] = await Promise.all([
        target ? loader.loadModule(target) : undefined,
        undefined
    ])

    const instance = repl.start({ 
        useGlobal: true,
        useColors: true,
        replMode: repl.REPL_MODE_STRICT,
        breakEvalOnSigint: true, // note: does not work w/ custom `eval`,
        input: socket,
        output: socket,
        terminal: socket ? true : undefined,
    })

    // TODO: history should be per-program
    const historyFile = path.resolve(getUserSynapseDirectory(), 'repl-history')
    instance.setupHistory(historyFile, err => {
        if (err) {
            getLogger().error(`Failed to setup REPL history`, err)
        }
    })

    const names: string[] = []

    // TODO: make this do more than clearing the screen
    instance.defineCommand('reset', () => {
        instance.output.write(`\x1b[2J${instance.getPrompt()}`)
    })

    instance.defineCommand('list', () => {
        instance.output.write(names.join('\n') + '\n')
        instance.output.write(instance.getPrompt())
    })

    function setValue(name: string, value: any) {
        names.push(name)
        Object.defineProperty(instance.context, name, {
            value,
            enumerable: true,
            configurable: false,
        })
    }

    function initContext() {
        if (targetModule) {
            for (const [k, v] of Object.entries(targetModule)) {
                if (k === '__esModule') continue
    
                setValue(k, v)
            }    
        }

        options?.onInit?.({ context: instance.context, setValue })
    }

    instance.on('reset', initContext)
    // instance.on('close', async () => (await logSubscription)?.dispose())

    try {
        initContext()
    } catch (e) {
        instance.close()
        throw e
    }

    return instance
}

export async function enterRepl(
    target: string | undefined,
    loader: ReturnType<SessionContext['createModuleLoader']>, 
    options: CombinedOptions
) {
    await getDisplay().releaseTty()
    const instance = await createRepl(target, loader, options)

    return {
        promise: new Promise<void>((resolve, reject) => {
            instance.on('exit', resolve)
        })
    }
}

// Looks like this: `0:foo;4:bar;21:qaz`
function parseSymbolBindings(bindings: string): Record<string, string> {
    const parsed: Record<string, string> = {}
    for (const b of bindings.split(';')) {
        const [id, name] = parseBinding(b)
        parsed[id] = name
    }

    return parsed

    function parseBinding(binding: string): [id: string, name: string]  {
        const [id, name] = binding.split(':', 2)
        if (!name) {
            throw new Error(`Bad symbol binding: ${binding}`)
        }
    
        return [id, name]
    }
}

export async function getSymbolDataResourceId(resources: Record<string, any>, fileName: string, executionScope: string) {
    const synapseResources: Record<string, any> = resources?.synapse_resource ?? {}
    const symbolDataResourceName = Object.entries(synapseResources).find(([k, v]) => {
        return (
            v.type === 'Closure' &&
            v.input.source === fileName && 
            v.input.options?.id === '__exported-symbol-data' && 
            v.input.options?.executionScope === executionScope
        )
    })?.[0]

    if (!symbolDataResourceName) {
        throw new Error(`No exported symbols found for scope: ${executionScope}`)
    }

    return {
        resourceId: `synapse_resource.${symbolDataResourceName}`
    }
}

export async function prepareReplWithSymbols(bindings: string, dataResourceId: string, state: TfState) {
    const parsedBindings = parseSymbolBindings(bindings)
    const [type, ...rest] = dataResourceId.split('.')
    const name = rest.join('.')
    const symbolDataResource = state.resources
        .filter(r => r.type === type && r.name === name)
        .map(r => r.state)
        .map(r => r.attributes.output.value.destination)
        .pop()

    if (!symbolDataResource) {
        throw new Error('No exported symbol resource found!')
    }

    const artifactFs = await getArtifactFs()
    const location = await artifactFs.resolveArtifact(symbolDataResource)
    const artifactName = path.basename(location)

    const onInit: ReplOptions['onInit'] = instance => {
        const symbols = instance.context.symbols
        if (!symbols) {
            throw new Error(`Missing symbols object`)
        }

        for (const [id, name] of Object.entries(parsedBindings)) {
            if (!(id in symbols)) {
                throw new Error(`Symbol value not found in execution scope`)
            }

            instance.setValue(name, symbols[id])
        }
    }

    return {
        location: `${pointerPrefix}${artifactName}`,
        onInit,
    }
}