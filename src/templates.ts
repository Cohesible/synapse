import * as path from 'node:path'
import { TemplateMetadata, TfJson } from './runtime/modules/terraform'
import * as utils from './utils'
import { getDeploymentBuildDirectory, getRootDir } from './workspaces'
import { getFsFromHash, getDeploymentFs, getProgramFs, getTemplate, readState, getBinaryTemplate, getMoved } from './artifacts'
import { getBuildTargetOrThrow, getFs } from './execution'
import { getSecret } from './services/secrets'
import { deserializeBinaryTemplate } from './deserializer'
import { getLogger } from './logging'

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
    const testSuiteId = Number(params.get('test-suite') ?? undefined)

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
    const copy = Object.create(null, Object.getOwnPropertyDescriptors(template))
    delete copy['//']

    return utils.getHash(JSON.stringify(copy), 'base64url')
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
    let _rawTemplate: Buffer | undefined
    let _template: TfJson | undefined
    let _previousTemplate: TfJson | undefined
    let templateHash: string | undefined

    async function getMovedIfRollback() {
        if (!programFsHash) {
            return
        }

        // TODO: this should _technically_ use all templates between the rollback commit and the current commit
        const [state, moved] = await Promise.all([
            readState(),
            getMoved()
        ])
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

    async function writeMoved(dir: string, moved: { from: string; to: string }[]) {
        await getFs().writeFile(path.resolve(dir, 'moved.tf.json'), JSON.stringify({ moved }))
    }

    async function tryDeleteFiles(paths: string[]) {
        const bt = getBuildTargetOrThrow()
        const dir = path.resolve(getDeploymentBuildDirectory(bt))

        async function tryDelete(f: string) {
            await getFs().deleteFile(path.resolve(dir, f)).catch(utils.throwIfNotFileNotFoundError)
        }

        await Promise.all(paths.map(tryDelete))
    }

    async function cleanTemplates() {
        return tryDeleteFiles(['moved.tf.json', 'stack.tf.bin'])
    }

    async function cleanState() {
        return tryDeleteFiles(['.terraform/terraform.tfstate'])
    }

    async function _getTemplateFilePath() {
        const bt = getBuildTargetOrThrow()
        const dir = getDeploymentBuildDirectory(bt)
        const oldPath = path.resolve(dir, 'stack.tf.json')
        await getFs().deleteFile(oldPath).catch(utils.throwIfNotFileNotFoundError)

        const dest = path.resolve(dir, 'stack.tf.bin')
        const programFs = programFsHash ? await getFsFromHash(programFsHash) : getProgramFs()
        const template = await getBinaryTemplate(programFs)
        if (!template) {
            throw new Error(`No template found`)
        }

        _rawTemplate = template as Buffer
        _template = deserializeBinaryTemplate(_rawTemplate)

        const moved = await getMovedIfRollback()
        if (moved) {
            getLogger().debug('Using reversed moved for rollback')
            await writeMoved(dir, moved)   
        } else {
            const moved2 = await getMoved(programFsHash)
            await writeMoved(dir, moved2 ?? [])
        }

        await fs.writeFile(dest, template)

        return dest
    }

    const getTemplateFilePath = utils.memoize(_getTemplateFilePath)

    async function getTemplate2(): Promise<TfJson> {
        const templateFilePath = await getTemplateFilePath()
        if (_template) {
            return _template
        }

        if (_rawTemplate) {
            return _template = deserializeBinaryTemplate(_rawTemplate)
        }

        const data = await fs.readFile(templateFilePath)
        _rawTemplate = data as any
        return _template = deserializeBinaryTemplate(data as any)
    }

    async function setTemplate(template: TfJson | Buffer): Promise<void> {
        _previousTemplate = _template

        if (template instanceof Buffer) {
            _template = deserializeBinaryTemplate(template)
            _rawTemplate = template
        } else {
            _rawTemplate = undefined
            _template = template
        }

        templateHash = getHash(_template)

        const bt = getBuildTargetOrThrow()
        const dir = getDeploymentBuildDirectory(bt)

        if (_rawTemplate) {    
            await fs.writeFile(path.resolve(dir, 'stack.tf.bin'), _rawTemplate)
        } else if (_template) {
            await tryDeleteFiles(['stack.tf.bin'])
            await fs.writeFile(path.resolve(dir, 'stack.tf.json'), JSON.stringify(_template))
        }
    }

    async function getTemplateHash() {
        if (templateHash) {
            return templateHash
        }

        if (_template) {
            return templateHash = getHash(_template)
        }

        await _getTemplateFilePath()

        return templateHash = getHash(await getTemplate2())
    }

    async function getPreviousTemplateHash() {
        if (_previousTemplate) {
            return getHash(_previousTemplate)
        }

        throw new Error('Missing previous template')
    }

    async function tryGetTemplate(): Promise<TfJson | undefined> {    
        try {
            return await getTemplate2()
        } catch (e) {
            utils.throwIfNotFileNotFoundError(e)
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
        cleanState,
        cleanTemplates,
        getTemplate: getTemplate2,
        setTemplate,
        tryGetTemplate,
        getTemplateFilePath,
        getSecretBindings,
        getTemplateHash,
        getPreviousTemplateHash,
    }
}