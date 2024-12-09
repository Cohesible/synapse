//# moduleId = synapse:lib
//# transform = persist

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as core from 'synapse:core'
import { Fn, peekNameSym } from 'synapse:terraform'
import { readFileSync } from 'node:fs'

export interface BundleOptions {
    readonly external?: string[]
    readonly destination?: string
    readonly moduleTarget?: 'cjs' | 'esm' | 'iife'
    readonly platform?: 'node' | 'browser'
    readonly minify?: boolean
    readonly immediatelyInvoke?: boolean
    readonly banners?: string[]

    // For artifacts
    /** @internal */
    readonly publishName?: string
    /** @internal */
    readonly includeAssets?: boolean

    /** @internal */
    readonly arch?: 'aarch64' | 'x64'

    /** @internal */
    readonly os?: 'windows' | 'darwin' | 'linux'

    /** @internal */
    readonly libc?: 'gnu' | 'musl'

    /** @internal */
    readonly endianness?: 'LE' | 'BE'

    /** 
     * @internal
     * Generates code to lazily load modules
     */
    // readonly lazyLoad?: string[]
}

export enum AssetType {
    File = 0,
    Directory = 1,
    Archive = 2,
}

// FIXME: don't overload `Bundle` with closures??
// TODO: if `target` is a string then we are just bundling a file vs. a JavaScript object/function (???)
//# resource = true
export class Bundle extends core.Closure {
    public constructor(target: ((...args: any[]) => any) | Record<string, any>, opt?: BundleOptions) {
        const normalizedLocation = opt?.destination 
            ? path.relative(core.cwd(), opt.destination)
            : undefined

        super({
            location: normalizedLocation,
            options: { ...opt, destination: normalizedLocation },
            captured: new core.SerializedObject(target).filePath,
        })

        Object.assign(this, {
            // Terraform doesn't understand that some output fields are optional
            // So we need to give hints to downstream code
            hasAssets: opt?.includeAssets,
            destination: tagPointer(this.destination),
        })
    }
}

//# resource = true
/** @internal */
export class Export extends core.Closure {
    public constructor(target: any, opt?: { id?: string, destination?: string, source?: string, testSuiteId?: number; publishName?: string }) {
        const normalizedLocation = opt?.destination 
            ? path.relative(core.cwd(), opt.destination)
            : undefined

        super({
            source: opt?.source,
            location: normalizedLocation,
            options: {
                 ...opt,
                bundled: false, 
                destination: normalizedLocation,
            },
            captured: new core.SerializedObject(target).filePath,
        })

        Object.assign(this, { destination: tagPointer(this.destination) })
    }
}

interface AssetProps {
    readonly path: string
    readonly type?: AssetType
    readonly extname?: string
    readonly extraFiles?: Record<string, string>
    // readonly destination?: string
}

class AssetConstruct extends core.Asset {
    public constructor(props: AssetProps) {
        super({
            path: props.path,
            extname: props.extname,
            type: props.type ?? AssetType.Archive,
            extraFiles: props.extraFiles,
            // filePath: props.destination,
        })

        // Would be better if this was 'lazy_refresh' or something similar
        core.updateLifecycle(this, { force_refresh: true })
    }
}

function maybeGetAssets(pathOrTarget: string | Bundle) {
    if (!(pathOrTarget instanceof Bundle)) {
        return
    }

    if (!(pathOrTarget as any).hasAssets) {
        return
    }

    return pathOrTarget.assets
}

//# resource = true
export class Archive extends AssetConstruct {
    public constructor(pathOrTarget: string | Bundle) {
        const filePath = pathOrTarget instanceof Bundle ? pathOrTarget.destination : pathOrTarget as string
        const extname = pathOrTarget instanceof Bundle ? pathOrTarget.extname : path.extname(pathOrTarget as string)

        super({
            extname,
            path: filePath,
            type: AssetType.Archive,
            extraFiles: maybeGetAssets(pathOrTarget),
        })
    }
}

export async function readAsset(asset: string) {
    if (asset.startsWith('file:')) {
        // XXX: ideally we'd resolve in the bundle
        const data = await fs.readFile(path.resolve(__dirname, asset.slice('file:'.length)))

        return Buffer.from(data).toString('utf-8')
    }

    const artifactFs = core.getArtifactFs()
    const data = await artifactFs.readArtifact(asset)

    return Buffer.from(data).toString('utf-8')
}

const pointerSymbol = Symbol.for('synapse.pointer')
function tagPointer(ref: string): string {
    return Object.assign(ref as any, { [pointerSymbol]: true })
}

const nodeEnv = process.env['NODE_ENV']
export function isProd() {
    return nodeEnv === 'production' || envName?.includes('production')
}

const envName = process.env['SYNAPSE_ENV']
export function getEnvironmentName() {
    return envName
}

/** @internal */
export interface FileAsset {
    readonly pointer: core.DataPointer
    read(): Promise<string>
    resolve(): Promise<string>
}

//# resource = true
/** @internal */
export function createFileAsset(filePath: string, opt?: { publishName?: string }): FileAsset {
    const data = readFileSync(filePath)
    const artifactFs = core.getArtifactFs()
    const pointer = opt?.publishName 
        ? artifactFs.writeFileSync(opt.publishName, data)
        : artifactFs.writeArtifactSync(data, opt)

    async function read() {
        const artifactFs = core.getArtifactFs()
        const data = await artifactFs.readArtifact(pointer)

        return Buffer.from(data).toString('utf-8')
    }

    async function resolve() {
        const artifactFs = core.getArtifactFs()

        return artifactFs.resolveArtifact(pointer) //, { extname })
    }

    return {
        pointer,
        read,
        resolve,
    }
}

class DataAsset extends core.defineResource({
    create: async (data: string, extname?: string) => {
        const artifactFs = core.getArtifactFs()
        const pointer = await artifactFs.writeArtifact(Buffer.from(data, 'utf-8'))

        return { pointer, extname }
    },
}) {
    async read() {
        const artifactFs = core.getArtifactFs()
        const data = await artifactFs.readArtifact(this.pointer)

        return Buffer.from(data).toString('utf-8')
    }
}

/** @internal */
export function createDataAsset(data: string, extname?: string) {
    const asset = new DataAsset(data, extname)

    return {
        pointer: tagPointer(asset.pointer),
        extname: asset.extname,
    }
}

/** @internal */
export const resolveArtifact = core.defineDataSource(async (pointer: core.DataPointer, extname?: string) => {
    const { hash } = pointer.resolve()
    const resolved = await core.getArtifactFs().resolveArtifact(pointer, { extname })

    return { hash, filePath: resolved }
}) 

// Target _must_ be a resource
/** @internal */
export function addReplacementHook<T extends object, U>(target: T, hook: core.ReplacementHook<T, U>) {
    const handler = new Export(hook)

    core.updateLifecycle(target, {
        hook: [{
            kind: 'replace',
            input: target,
            handler: handler.destination,
        }]
    })
}

const _calculateFromState = core.defineDataSource(async (resourceId: string, fn: (state: any) => any) => {
    const client = core.getBackendClient()
    const state = await client.getState(resourceId)

    return fn(state)
})

//# resource = true
/** @internal */
export function calculateFromState<T extends Record<string, any>, U>(
    target: new (...args: any[]) => T,
    fn: (state: T) => Promise<U> | U
): any {
    return _calculateFromState(core.peekResourceId(target), fn)
}

function toSnakeCase(str: string) {
    return str.replace(/[A-Z]/g, s => `_${s.toLowerCase()}`)
}

interface GeneratedIdentifierProps {
    readonly sep?: string
    readonly prefix?: string
    readonly maxLength?: number
}

/** @internal */
export class GeneratedIdentifier extends core.defineResource({
    create: async (props: GeneratedIdentifierProps) => {
        return {
            props,
            value: generateName(props.maxLength, props.sep, props.prefix),
        }
    },
    update: async (state, props) => {
        if (
            state.props.sep === props.sep &&
            state.props.prefix === props.prefix && 
            state.props.maxLength === props.maxLength
        ) {
            return state
        }

        return {
            props,
            value: generateName(props.maxLength, props.sep, props.prefix),
        }
    },
}) {}

/** @internal */
export function createGeneratedIdentifier(props: GeneratedIdentifierProps = {}) {
    const ident = new GeneratedIdentifier(props)

    return ident.value
}

let nameCounter = 0
let previousTime: number
function generateName(maxLength?: number, sep = '-', namePrefix = 'synapse') {
    const currentTime = Date.now()
    if (currentTime !== previousTime) {
        nameCounter = 0
        previousTime = currentTime
    }

    const id = `${currentTime}${sep}${++nameCounter}`
    const offset = namePrefix ? namePrefix.length + sep.length : 0
    const trimmed = maxLength ? id.slice(Math.max(0, id.length - (maxLength - offset))) : id

    return namePrefix ? `${namePrefix}${sep}${trimmed}` : trimmed
}

//# resource = true
/** @internal */
export function generateIdentifier<T extends Record<string, any>, K extends keyof T>(
    target: new (...args: any[]) => T, 
    attribute: K & string,
    maxLength = 100,
    sep?: string
): string {
    if (!(peekNameSym in target)) {
        throw new Error(`Unable to get resource id from target`)
    }

    const resourceId = (target[peekNameSym] as any)()
    
    return Fn.generateidentifier(resourceId, toSnakeCase(attribute), maxLength, sep)
}

interface BuildTarget {
    readonly programId: string
    readonly deploymentId: string
}

declare var __buildTarget: BuildTarget

/** @internal */
export const getBuildTarget = core.defineDataSource(() => {
    if (typeof __buildTarget === 'undefined') {
        throw new Error(`Not within a build context`)
    }

    return __buildTarget
})