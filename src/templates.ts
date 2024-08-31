import * as path from 'node:path'
import { TfJson } from './runtime/modules/terraform'
import * as utils from './utils'
import { getLogger } from './logging'
import { getDeploymentBuildDirectory, getRootDir } from './workspaces'
import { getFsFromHash, getDeploymentFs, getProgramFs, getTemplate, readState } from './artifacts'
import { getBuildTargetOrThrow, getFs } from './execution'
import { getSecret } from './services/secrets'

// Structures for modeling interations between our "local"
// template (the goal state) and the "remote" state (the current state)

const builtinResourceType = 'synapse_resource'

interface BaseConfig {
    readonly module_name: string
}

interface ResourceIdentifier {
    readonly type: string
    readonly name: string
}

export interface ConfigResource<T extends BaseConfig = BaseConfig> extends ResourceIdentifier {
    readonly mode: 'managed' | 'data'
    readonly fileName: string
    readonly testSuiteId?: number
    readonly config: T
}

export interface BuiltinResource<T extends object = object> extends ConfigResource<BuiltinResourceConfig<T>> {
    readonly type: typeof builtinResourceType
}

export interface BuiltinResourceConfig<T extends object = object> extends BaseConfig {
    readonly type: string
    readonly input: T
}

export interface Resource<T extends BaseConfig = BaseConfig, U extends object = object> extends ConfigResource<T> {
    readonly state: U
}

export interface OrphanResource<U extends object = object> extends ResourceIdentifier {
    readonly state: U
}

export function parseModuleName(moduleName: string) {
    const [fileName, rem] = moduleName.split('#')
    const params = new URLSearchParams(rem)
    const testSuiteId = Number(params.get('test-suite') ?? undefined) // Ensure `null` is treated as `NaN`

    return {
        fileName,
        testSuiteId: isNaN(testSuiteId) ? undefined : testSuiteId,
    }
}

export function listConfigResources(template: TfJson) {
    const resources: ConfigResource[] = []

    function gather(segment: Record<string, Record<string, BaseConfig>>, mode: ConfigResource['mode']) {
        for (const [type, group] of Object.entries(segment)) {
            for (const [name, config] of Object.entries(group)) {
                resources.push({
                    mode,
                    name,
                    type,
                    config,
                    ...parseModuleName(config.module_name),
                })
            }
        }
    }

    gather(template.data, 'data')
    gather(template.resource, 'managed')

    return resources
}

export function getHash(template: TfJson) {
    return utils.getHash(JSON.stringify({ ...template, '//': undefined }), 'base64url')
}

export type QualifiedId = `${string}.${string}`
export function getId(resource: ResourceIdentifier): QualifiedId {
    return `${resource.type}.${resource.name}`
}

export type TemplateService = ReturnType<typeof createTemplateService>
export function createTemplateService(
    fs = getFs(),
    programFsHash?: string,
) {
    let templateHash: string | undefined

    async function getMovedIfRollback() {
        if (!programFsHash) {
            return
        }

        const state = await readState()
        // TODO: this should _technically_ use all templates between the rollback commit and the current commit
        const template = await getTemplate(getProgramFs())
        const moved = template?.moved
        if (!moved || !state) {
            return
        }

        const resources = new Set(state.resources.map(r => `${r.type}.${r.name}`))
        const reversed: { from: string; to: string }[] = []
        for (const m of moved) {
            if (resources.has(m.to) && !resources.has(m.from)) {
                reversed.push({ from: m.to, to: m.from })
            }
        }

        return reversed.length > 0 ? reversed : undefined
    }

    async function _getTemplateFilePath() {
        const bt = getBuildTargetOrThrow()
        const dest = path.resolve(getDeploymentBuildDirectory(bt), 'stack.tf.json')
        const programFs = programFsHash ? await getFsFromHash(programFsHash) : getProgramFs()
        const template = await getTemplate(programFs)
        if (!template) {
            throw new Error(`No template found`)
        }

        const moved = await getMovedIfRollback()
        if (moved) {
            getLogger().debug('Using reversed moved for rollback')
            Object.assign(template, { moved })
        }

        templateHash = getHash(template)
        await fs.writeFile(dest, JSON.stringify(template)) 

        return dest
    }

    const getTemplateFilePath = utils.memoize(_getTemplateFilePath)

    async function getTemplate2(): Promise<TfJson> {
        const templateFilePath = await getTemplateFilePath()
    
        return JSON.parse(await fs.readFile(templateFilePath, 'utf-8'))
    }

    async function setTemplate(template: TfJson): Promise<void> {
        templateHash = getHash(template)

        // await writeTemplate(getProgramFs(), template)

        const bt = getBuildTargetOrThrow()
        const dest = path.resolve(getDeploymentBuildDirectory(bt), 'stack.tf.json')

        await fs.writeFile(dest, JSON.stringify(template))
    }

    async function getTemplateHash() {
        return templateHash ??= getHash(await getTemplate2())
    }

    async function tryGetTemplate(): Promise<TfJson | undefined> {    
        try {
            return await getTemplate2()
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
        }
    }

    async function getSecretsMap() {
        const template = await getTemplate2()
        const secrets = template['//']?.secrets

        return secrets
    }

    async function getSecretBindings() {
        const secrets = await getSecretsMap()
        if (!secrets) {
            return
        }
    
        const bindings: Record<string, string> = Object.fromEntries(
            await Promise.all(Object.entries(secrets).map(async ([k, v]) => [k, await getSecret(v)]))
        )
    
        return bindings
    }

    return {
        getTemplate: getTemplate2,
        setTemplate,
        tryGetTemplate,
        getTemplateFilePath,
        getSecretBindings,
        getTemplateHash,
    }
}