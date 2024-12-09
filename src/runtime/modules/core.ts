//# moduleId = synapse:core

import * as terraform from 'synapse:terraform'

// This is duplicated from `synapse:terraform`
/** @internal */
export interface Symbol {
    name: string
    line: number // 0-indexed
    column: number // 0-indexed
    fileName: string
}

/** @internal */
export interface Scope {
    name?: string
    moduleId?: string
    contexts?: any[]
    namespace?: Symbol[] // This is only relevant for property accesses
    isNewExpression?: boolean
    isStandardResource?: boolean

    // Used for mapping resource instantiations to source code 
    symbol?: Symbol

    assignmentSymbol?: Symbol
}

declare function __getCurrentId(): string
declare function __symEval(target: any, args: any[]): any
declare function __getContext(): { run(scope: Scope, fn: (...args: any[]) => any, ...args: any[]): any, get: (type: string) => any }
declare function __getBuildDirectory(): string
declare function __getBackendClient(): BackendClient
declare function __requireSecret(envVar: string, type: string): void 
declare function __getArtifactFs(): ArtifactFs
declare function __cwd(): string
declare function __waitForPromise<T>(promise: Promise<T> | T): T

declare function dynamicImport(specifier: string): Promise<any>

// AUTH
declare function __getCredentials(id?: string): Promise<{ expiresAt: number; access_token: string }>

// UTIL
declare function __runCommand(cmdOrExecutable: string, args?: string[]): Promise<string>
declare function __createAsset(target: string, importer: string): DataPointer

interface Logger {
    log: (...args: any[]) => void
}

declare function __getLogger(): Logger



/** @internal */
export function getCurrentId() {
    if (typeof __getCurrentId === 'undefined') {
        return ''
    }

    return __getCurrentId()
}

export function runCommand(cmd: string): Promise<string>
export function runCommand(executable: string, args: string[]): Promise<string>
export function runCommand(cmdOrExecutable: string, args?: string[]) {
    if (typeof __runCommand === 'undefined') {
        throw new Error(`Not implemented outside of Synapse runtime`)
    }

    return __runCommand(cmdOrExecutable, args)
}

/** @internal */
export function createAsset(target: string, importer: string): DataPointer {
    if (typeof __createAsset === 'undefined') {
        throw new Error(`Not implemented outside of Synapse runtime`)
    }

    return __createAsset(target, importer)
}

//# resource = true
export function asset(path: string): OpaquePointer {
    throw new Error(`Failed to transform "asset" calls`)
}

/** @internal */
export function cwd() {
    if (typeof __cwd === 'undefined') {
        return process.cwd()
    }
    
    return __cwd()
}

const pointerPrefix = 'pointer:'

/** @internal */
export function importArtifact(id: string): Promise<any> {
    // A bare hash is OK, metadata may be applied separately
    if (typeof id !== 'string' || id.startsWith(pointerPrefix)) {
        return dynamicImport(id)
    }

    return dynamicImport(`${pointerPrefix}${id}`)
}

/** @internal */
export function getCredentials(id?: Identity['id']) {
    const envCreds = process.env['COHESIBLE_AUTH']
    if (envCreds) {
        return JSON.parse(envCreds) as ReturnType<typeof __getCredentials>
    }

    if (typeof __getCredentials !== 'undefined') {
        return __getCredentials(id)
    }

    const os = require('node:os') as typeof import('node:os')
    const path = require('node:path') as typeof import('node:path')
    const fs = require('node:fs/promises') as typeof import('node:fs/promises')

    return (async function () {
        const synapseDir = process.env['SYNAPSE_INSTALL'] ?? path.resolve(os.homedir(), '.synapse')
        const credsDir = path.resolve(synapseDir, 'credentials')
        const statePath = path.resolve(credsDir, 'state.json')
        const state = JSON.parse(await fs.readFile(statePath, 'utf-8'))
        const target = id ?? state.currentAccount
        if (!target) {
            throw new Error(`No account selected`)
        }

        const creds = JSON.parse(await fs.readFile(path.resolve(credsDir, `${target}.json`), 'utf-8'))

        return creds as ReturnType<typeof __getCredentials>
    })()
}

function failMissingRuntime(name: string): never {
    throw new Error(`Cannot use "${name}" outside of the Synapse runtime`)
}

/** @internal */
export function waitForPromise<T>(promise: Promise<T> | T): T {
    if (typeof __waitForPromise === 'undefined') {
        failMissingRuntime('waitForPromise')
    }
    return __waitForPromise(promise)
}

/** @internal */
export function getLogger(): Logger {
    if (typeof __getLogger === 'undefined') {
        return console
    }

    return __getLogger()
}

export const context = Symbol.for('synapse.context')
export const contextType = Symbol.for('synapse.contextType')
const permissions = Symbol.for('synapse.permissions')
const moveable2 = Symbol.for('__moveable__2')

type Binding<T extends any[], R, U = void> = ((this: U, ...args: T) => R)

type ExtractSignature<T> = T extends {
    (...args: infer P): Promise<infer R>
    (...args: infer P2): infer R2
    (...args: infer P3): infer R3
} ? [P, Partial<R>] : T extends (...args: infer P) => infer R ? [P, Partial<R>] : never

type Methods<T> = { [P in keyof T]: T[P] extends (...args: any[]) => any ? P : never }[keyof T]
export type PermissionsModel<T> = { [P in Methods<T>]+?: Binding<ExtractSignature<T[P]>[0], ExtractSignature<T[P]>[1], T> }
type ConstructorPermissionsModel<T extends abstract new (...args: any[]) => any> = (this: InstanceType<T>, ...args: ConstructorParameters<T>) => InstanceType<T> | void 

/** @internal */
export function bindModel<T>(ctor: new () => T, model: PermissionsModel<T>): void
export function bindModel<T>(ctor: new (...args: any[]) => T, model: PermissionsModel<T>): void
export function bindModel<T>(ctor: new (...args: any[]) => T, model: PermissionsModel<T>): void {
    _bindModel(ctor, model, 'class')
}

/** @internal */
export function bindConstructorModel<T extends abstract new (...args: any[]) => any>(ctor: T, model: ConstructorPermissionsModel<T>): void {
    _bindModel(ctor, model, 'constructor')
}

/** @internal */
export function bindFunctionModel<T extends (this: U, ...args: any[]) => any, U = void>(
    fn: T, 
    model: Binding<Parameters<T>, Awaited<ReturnType<T>>, U>
): void {
    _bindModel(fn, model, 'function')
}

/** @internal */
export function bindObjectModel<T extends Record<string, any>>(obj: T, model: PermissionsModel<T>): void {
    _bindModel(obj, model, 'object')
}

// `Model` is dependent on the target
type Model = any | any[]

interface ObjectPermissionsBinding {
    type: 'object'
    methods: Record<string, Model>
}

interface ClassPermissionsBinding {
    type: 'class'
    methods: Record<string, Model>
    $constructor?: Model
}

interface FunctionPermissionsBinding {
    type: 'function'
    call: Model
}

// Legacy
interface ContainerPermissionsBinding {
    type: 'container'
    properties: Record<string, Model>
}

type PermissionsBinding = 
    | ObjectPermissionsBinding 
    | ClassPermissionsBinding 
    | FunctionPermissionsBinding 
    | ContainerPermissionsBinding

function mergeBindings(left: PermissionsBinding, right: PermissionsBinding | undefined) {
    if (!right) {
        return left
    }

    if (left.type !== right.type) {
        throw new Error(`Cannot merge bindings of different types: ${left.type} !== ${right.type}`)
    }

    function mergeObject(a: Record<string, Model>, b: Record<string, Model>) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)])
        const result: Record<string, Model> = {}

        for (const k of keys) {
            const l = a[k]
            const r = b[k]

            if (!r) {
                result[k] = l
            } else if (!l) {
                result[k] = r
            } else if (Array.isArray(l)) {
                result[k] = [...l, ...(Array.isArray(r) ? r : [r])]
            } else if (Array.isArray(r)) {
                result[k] = [...r, ...(Array.isArray(l) ? l : [l])]
            } else {
                result[k] = [l, r]
            }
        }

        return result
    }

    switch (left.type) {
        case 'class':
        case 'object':
            return {
                type: left.type,
                methods: mergeObject(left.methods, (right as any).methods),
                $constructor: mergeObject(
                    { $constructor: (left as any).$constructor }, 
                    { $constructor: (right as any).$constructor },
                ).$constructor
            }
    }
    
    throw new Error(`Merging not implemented for type: ${left.type}`)
}

function _bindModel(target: any, model: any, type: 'class' | 'object' | 'function' | 'container' | 'constructor') {
    // FIXME: not robust at all
    const m = type === 'function' 
        ? { type, call: model } 
        : type === 'container' 
            ? { type, properties: model }
            : type === 'constructor'
                ? { type: 'class' as const, $constructor: model, methods: {} }
                : { type, methods: model }

    target[permissions] = type !== 'container' ? 
        type !== 'function' 
            ? mergeBindings(m, target[permissions])
            : m
    : {
        type: 'container',
        properties: {
            ...target[permissions]?.properties,
            ...model
        }
    }

    // Bubble up permission models to any parent objects
    if (moveable2 in target) {
        const operations = target[moveable2]().operations
        if (operations.length === 2 && operations[1].type === 'get') {
            _bindModel(
                target[Symbol.for('unproxyParent')], 
                { [operations[1].property]: type !== 'function' ? { type, methods: model } : { type, call: model } },
                'container'
            )
        }
    }
}

// Notes:
// * Permissions/network solutions can be asymmetric; the changes needed on the subject may not be the
//   same as the changes needed on the actor
// * The above means that we may need to know both the subject and the actor in order to provide a solution
// * Connectivity may not necessarily need to be solved in both directions i.e. it can be one way
// * Rendering models with unknown inputs results in a more permissive solution. The least permissive
//   solution can only be found by deferring until final synthesis.


export function symEval<T, U extends any[]>(target: (...args: U) => Promise<T> | T, ...args: U): T | unknown {
    if (typeof __symEval === 'undefined') {
        failMissingRuntime('symEval')
    }

    return __symEval(target, args)
}

declare function __defer(fn: () => void): void

export function defer(fn: () => void) {
    __defer(() => void fn())
}

declare function __createUnknown(): any

export function createUnknown() {
    if (typeof __createUnknown === 'undefined') {
        failMissingRuntime('createUnknown')
    }
    
    return __createUnknown()
}

interface LocalMetadata {
    readonly name?: string
    readonly source?: string
    readonly publishName?: string
    readonly dependencies?: string[]
}

/** @internal must live in 'core' to be accurate */
export function peekResourceId<T extends Record<string, any>>(
    target: new (...args: any[]) => T,
): string {
    if (!(terraform.peekNameSym in target)) {
        throw new Error(`Unable to get resource id from target`)
    }

    return (target[terraform.peekNameSym] as any)()    
}

/** @internal */
export interface ArtifactFs {
    writeFile(fileName: string, data: Uint8Array, metadata?: LocalMetadata): Promise<DataPointer>
    writeFileSync(fileName: string, data: Uint8Array, metadata?: LocalMetadata): DataPointer
    writeArtifact(data: Uint8Array, metadata?: LocalMetadata): Promise<DataPointer>
    writeArtifactSync(data: Uint8Array, metadata?: LocalMetadata): DataPointer
    readArtifact(pointer: string): Promise<Uint8Array>
    readArtifactSync(pointer: string): Uint8Array
    resolveArtifact(pointer: string, opt?: { name?: string, extname?: string }): Promise<string>
}

/** @internal */
export function getArtifactFs(): ArtifactFs {
    if (typeof __getArtifactFs === 'undefined') {
        throw new Error(`Cannot use artifact fs outside of runtime`)
    }

    return __getArtifactFs()
}

const browserImplSym = Symbol.for('synapse.browserImpl')
export function addBrowserImplementation<T extends object | Function, U extends T>(target: T, alt: U): void {
    if (browserImplSym in target) {
        throw new Error(`Target function already has a registered browser implementation: ${(target[browserImplSym] as any).name}`)
    }

    Object.assign(target, { [browserImplSym]: alt })
}

/** @internal */
export function getBackendClient(): BackendClient {
    if (typeof __getBackendClient === 'undefined') {
        throw new Error(`Cannot call "getBackendClient" outside of the compiler runtime`)
    }
    
    return __getBackendClient()
}

interface ContextConstructor<T> {
    readonly [contextType]: string
    new (...args: any[]): T
}

export function maybeGetContext<T = unknown>(ctor: ContextConstructor<T>): T | undefined {
    if (typeof __getContext === 'undefined') {
        return
    }

    const type = ctor[contextType]
    
    return __getContext().get(type)?.[0]
}

export function getContext<T = unknown>(ctor: ContextConstructor<T>): T {
    if (typeof __getContext === 'undefined') {
        return {} as any
    }

    // TODO: change how contexts are added and use `at(-1)` instead
    const type = ctor[contextType]
    const ctx = __getContext().get(type)?.[0]
    if (ctx === undefined) {
        throw new Error(`Not within context of type "${type}"`)
    }
    
    return ctx
}

const boundContext = Symbol.for('synapse.boundContext')
export function getBoundContext<T = unknown>(target: any, ctor: ContextConstructor<T>): T | undefined {
    const contexts = target?.[boundContext]
    if (!contexts) {
        return
    }

    const type = ctor[contextType]
    
    return contexts?.[type]?.[0]
}

/** @internal */
export function scope(scope: Scope, fn: (...args: any[]) => any, ...args: any[]): any {
    if (typeof __getContext === 'undefined') {
        return fn(...args)
    }

    return __getContext().run(scope, fn, args)
}

/** @internal */
export function getOutputDirectory() {
    if (typeof __getBuildDirectory === 'undefined') {
        return ''
    }

    return __getBuildDirectory()
}

export declare function addTarget<
    T extends abstract new (...args: any[]) => any, 
    U extends T
>(
    base: T,
    replacement: U,
    targets: 'aws' | 'azure' | 'gcp' | 'local'
): void


// TODO: should `update` be given the old args in addition to the new args?
// Maybe add it to `this`

interface ResourceDefinition<
    T extends object = object, 
    U extends any[] = []
> {
    read?(state: T): T | Promise<T>
    create(...args: U): T | Promise<T>
    update?(state: T, ...args: U): T | Promise<T>
    delete?(state: T, ...args: U): void | Promise<void>
    import?(id: string): T | Promise<T>
}

type ResourceConstructor<
    T extends object = object, 
    U extends any[] = [],
> = {
    new (...args: U): Readonly<T>
}

export function defineResource<
    T extends object = object,
    U extends any[] = []
>(
    definition: ResourceDefinition<T, U>
): ResourceConstructor<T, U>

export function defineResource(
    definition: ResourceDefinition
): ResourceConstructor {
    if (typeof __getCurrentId === 'undefined' || typeof arguments[1] !== 'string') {
        return (class {}) as any
    }

    return createCustomResourceClass(arguments[1], definition)
}

type SerializeableKeys<T> = { [P in keyof T]: T[P] extends (...args: any[]) => any ? never : P }[keyof T]
type Serializeable<T extends object> = Pick<T, SerializeableKeys<T>>
type Serialized<T> = Readonly<Pick<T, SerializeableKeys<T>>>

export function using<T extends any[], U>(ctx: T, fn: () => U): U
export function using<T, U>(ctx: T, fn: (ctx: T) => U): U
export function using<T, U>(ctx: T, fn: (ctx: T) => U): U {
    if (typeof __getContext === 'undefined') {
        return fn(ctx)
    }

    return __getContext().run({ contexts: Array.isArray(ctx) ? ctx : [ctx] }, fn)
}

export function move(from: string, to?: string) {
    return terraform.move(from, to)
}

export function fixupScope(name: string) {
    return terraform.fixupScope(name)
}

/**
 * @internal
 * 
 * Binds a secret to a deploy-time environment variable
 * 
 * Currently has no effect at runtime
 */
export function requireSecret(envVar: string, type: string) {
    __requireSecret(envVar, type)
}

/** @internal */
export interface Secret {
    value: string
    expiration?: string
}

/** @internal */
export interface SecretProvider {
    getSecret(): Promise<Secret>
}

interface Identity {
    readonly id: string
    readonly attributes: Record<string, any>
}

/** @internal */
export type AuthenticateFn<T extends Identity = Identity> = (pollToken: string) => Promise<T | undefined>
/** @internal */
export type StartAuthenticationFn = () => Promise<{ pollToken: string, redirectUrl: string }> 
/** @internal */
export interface Provider {
    readonly name?: string
    readonly type: string
    readonly authenticate: AuthenticateFn | { invoke: AuthenticateFn }
    readonly startAuthentication: StartAuthenticationFn | { invoke: StartAuthenticationFn }
}
/** @internal */
export interface Project {
    readonly id: string
    readonly name?: string
    readonly gitRepository?: { readonly url: string }
}
/** @internal */
export interface SecretsClient {
    getSecret(secretType: string): Promise<Secret>
    putSecret(secretType: string, secret: Secret): Promise<void>
    deleteSecret(secretType: string): Promise<void>
    createSecretProvider(secretType: string, handler: (() => Promise<Secret>) | { invoke: () => Promise<Secret> }): Promise<any>
    deleteSecretProvider(secretType: string): Promise<void>
}

/** @internal */
export interface AuthClient {
    createIdentityProvider(idp: Provider): Promise<{ id: string }>
    deleteIdentityProvider(id: string): Promise<void>
    createMachineIdentity(attributes?: Record<string, any>): Promise<{ id: string; privateKey: string }>
    deleteMachineIdentity(id: string): Promise<void>
    getMachineCredentials(id: string, privateKey: string): ReturnType<typeof __getCredentials>
}

/** @internal */
export interface ProjectsClient {
    createProject(repo: { name: string; url: string }): Promise<Project>
    deleteProject(id: Project['id']): Promise<void>
}
/** @internal */
export interface BackendClient extends SecretsClient, AuthClient, ProjectsClient {
    getState(resourceId: string): Promise<any> 
    getToolDownloadUrl(type: string, opt?: { os?: string; arch?: string; version?: string }): Promise<{ url: string; version: string }> 
}
/** @internal */
export interface ReplacementHook<T, U> {
    beforeDestroy(oldInstance: T): Promise<U>
    afterCreate(newInstance: T, state: U): Promise<void>
}

const pointerSymbol = Symbol.for('synapse.pointer')

/** @internal */
export type DataPointer = string & {
    readonly ref: string
    readonly hash: string;
    resolve(): { hash: string; storeHash: string }
    isResolved(): boolean
    isContainedBy(storeId: string): boolean
}

/** @internal */
export function isDataPointer(ref: unknown): ref is DataPointer {
    return (typeof ref === 'object' || typeof ref === 'function') && !!ref && (ref as any)[pointerSymbol]
}

export type OpaquePointer = string & { [pointerSymbol]: unknown }


export function defineDataSource<T, U extends any[]>(
    handler: (...args: U) => Promise<T> | T,
    opt?: { forceRefresh?: boolean }
): (...args: U) => T {
    if (typeof __getCurrentId === 'undefined' || typeof arguments[arguments.length - 1] !== 'string') {
        return (() => {}) as any
    }
    
    const ds = createCustomResourceClass(arguments[arguments.length - 1], { data: handler })

    return (...args) => {
        const v = ds.import(...args)
        if (typeof opt === 'object' && opt?.forceRefresh) {
            updateLifecycle(v, { force_refresh: true })
        }

        return (v as any)[terraform.classOutputSym]
    }
}

export function stubWhenBundled(target: any) {
    Object.assign(target, { [terraform.stubWhenBundled]: true })
}

// Common node symbols that are useful in general
// declare global {
//     var __filename: string
//     var __dirname: string
// }

interface SynapseProviderProps {
    readonly endpoint: string
    readonly buildDirectory: string
    readonly workingDirectory: string
    readonly outputDirectory: string
}

/** @internal */
export const Provider = terraform.createSynapseClass<SynapseProviderProps, unknown>('Provider', 'provider')

interface ObjectDataOutput {
    readonly filePath: string
}

interface ObjectDataInput {
    readonly value: any
}

const ObjectData = terraform.createSynapseClass<ObjectDataInput, ObjectDataOutput>('ObjectData', 'data-source')

/** @internal */
export class SerializedObject extends ObjectData {
    constructor(target: any, id?: string) {
        // TODO: add a flag/field so we can hide these resources in UI
        super({ value: terraform.Fn.serialize(target) })

        if (id) {
            terraform.overrideId(this, id)
        }
    }
}

interface ClosureProps {
    readonly captured: any
    readonly globals?: any
    readonly location?: string
    readonly options?: any
    readonly source?: string
}

interface ClosureOutput {
    readonly destination: string
    readonly extname?: string
    readonly assets?: Record<string, string>
}

/** @internal */
export const Closure = terraform.createSynapseClass<ClosureProps, ClosureOutput>('Closure')
/** @internal */
export const Artifact = terraform.createSynapseClass<{ url: string }, { filePath: string }>('Artifact', 'data-source')

interface ModuleExportsProps {
    readonly source: string
    readonly exports: any
}

const Exported = terraform.createSynapseClass<ModuleExportsProps, { pointer: string }>('ModuleExports')

/** @internal */
export class ModuleExports extends Exported {
    constructor(source: string, exports: any) {
        const id = source.replace(/\.(.*)$/, '').replace(/\//g, '--')

        super({
            source,
            exports: new SerializedObject(exports, id + '-exports').filePath,
        })

        terraform.overrideId(this, id)
    }
}

interface CustomResourceProps {
    readonly type: string
    readonly handler: string
    readonly plan: any
    readonly context?: any
}

/** @internal */
export const Custom = terraform.createSynapseClass<CustomResourceProps, any>('Custom')
/** @internal */
export const CustomData = terraform.createSynapseClass<CustomResourceProps, any>('CustomData', 'data-source')

class Export extends Closure {
    public constructor(id: string, target: any) {
        super({
            source: `${id.replace(/--/g, '-')}.ts`,
            options: { bundled: false },
            captured: new SerializedObject(target, id + '-captured').filePath,
        })

        terraform.overrideId(this, id)
    }
}

interface AssetProps {
    readonly path: string
    readonly type?: number
    readonly filePath?: string
    readonly extname?: string
    readonly extraFiles?: Record<string, string> // dest (relative path/url) -> source
}

interface AssetOutput {
    readonly filePath: string
    readonly sourceHash?: string
}

/** @deprecated @internal */
export const Asset = terraform.createSynapseClass<AssetProps, AssetOutput>('Asset')

/** @internal */
export class CustomResource extends Custom {
    public constructor(type: string, handler: string, ...args: any[]) {
        const context = {
            'aws': __getContext().get('aws'),
            'fly-app': __getContext().get('fly-app') // XXX: make this generic
        }

        super({
            type,
            handler,
            plan: new SerializedObject(args).filePath,
            context: new SerializedObject(context).filePath,
        })
    }
}

class CustomDataClass extends CustomData {
    public constructor(type: string, handler: string, ...args: any[]) {
        super({
            type,
            handler,
            plan: new SerializedObject(args).filePath,
        })
    }
}

const resourceDefinitionIds = new Map<string, number>()
function createCustomResourceClass(id: string, definition: any): any {
    let def: Export

    // XXX: definitions should use `getCurrentId`, `id` is too static
    // TODO: we need to make sure that scopes aren't being captured from 
    // lazy eval during target binding, right now `getCurrentId` itself is
    // too unstable for class ctor instantiation
    if (resourceDefinitionIds.has(id)) {
        const base = id
        const count = resourceDefinitionIds.get(base)!
        id = `${base}-${count}`

        resourceDefinitionIds.set(base, count + 1)
    } else {
        resourceDefinitionIds.set(id, 1)
    }

    // Lazy init
    const getDef = () => {
        if (def === undefined) {
            return def = new Export(id, definition)
        }

        // TODO: this probably isn't needed despite being "technically correct"
        // We want to strip `testContext` if the shared def is referenced outside of a test
        const state = (def as any)[terraform.internalState]
        if (state?.testContext) {
            const current = __getContext().get('test-suite')?.[0]
            if (!current) {
                delete state['testContext']
            }
        }

        return def
    }

    return class extends CustomResource {
        static [terraform.customClassKey] = id

        constructor(...args: any[]) {
            super(id, getDef().destination, ...args)
        }

        static import(...args: any[]) {
            return new CustomDataClass(id, getDef().destination, ...args)
        }
    }
}

interface ResourceLifecycle<T> {
    create_before_destroy?: boolean
    prevent_destroy?: boolean
    /** @internal */
    force_refresh?: boolean
    ignore_changes?: 'all' | (keyof T)[]
    replace_triggered_by?: any[]
    /** @internal */
    hook?: {
        kind: 'replace'
        input: any
        handler: string
    }[]
}

// `exclude` is a hack because `getAllResources` is too aggressive
export function updateLifecycle<T extends object>(obj: T, lifecycle: ResourceLifecycle<T>, exclude?: any[]) {
    const resolvedLifecycle = { ...lifecycle }
    if (lifecycle.replace_triggered_by) {
        resolvedLifecycle.replace_triggered_by = terraform.getAllResources(lifecycle.replace_triggered_by, true)
    }

    const excluded = exclude?.flatMap(o => terraform.getAllResources(o)) // XXX: this is a big hack
    const expandedTarget = terraform.getAllResources(obj).filter(x => !excluded?.includes(x))
    expandedTarget.forEach(t => {
        terraform.updateResourceConfiguration(t, o => {
            if (!('lifecycle' in o)) {
                (o as any).lifecycle = [resolvedLifecycle]
            } else {
                // TODO: add merge logic
                (o as any).lifecycle[0] = {
                    ...(o as any).lifecycle[0],
                    ...resolvedLifecycle,
                }
            }
        })
    })
}

export function addDependencies<T extends object>(obj: T, ...deps: any[]) {
    const expandedTarget = terraform.getAllResources(obj)
    const expandedDeps = deps.flatMap(d => terraform.getAllResources(d))
    expandedTarget.forEach(t => {
        terraform.updateResourceConfiguration(t, o => {
            if (!('depends_on' in o)) {
                (o as any).depends_on = []
            }
            expandedDeps.forEach(d => {
                if (!(o as any).depends_on.includes(d)) {
                    (o as any).depends_on.push(d)
                }
            })
        })
    })
}

interface ApiRegistrationProps {
    readonly kind: string
    readonly config: string // pointer
}

const ApiRegistration = terraform.createSynapseClass<ApiRegistrationProps, any>('ApiRegistration', 'resource')

/** @internal */
export interface SecretProviderProps {
    readonly secretType: string
    readonly getSecret: () => Promise<Secret> | Secret
}

//# resource = true
/** @internal */
export class SecretProvider2 extends ApiRegistration {
    public constructor(props: SecretProviderProps) {
        super({
            kind: 'secret-provider',
            config: new SerializedObject(props).filePath,
        })
    }
}
 
interface IdentityProviderProps {
    readonly name?: string
    readonly type: string
    readonly authenticate: AuthenticateFn | { invoke: AuthenticateFn }
    readonly startAuthentication: StartAuthenticationFn | { invoke: StartAuthenticationFn }
}

//# resource = true
/** @internal */
export class IdentityProvider extends ApiRegistration {
    public constructor(props: IdentityProviderProps) {
        super({
            kind: 'identity-provider',
            config: new SerializedObject(props).filePath,
        })
    }
}


export interface LogEvent {
    readonly timestamp: string | number // ISO8601 or Unix epoch
    readonly data: string | { message: string } | any
    readonly sourceType?: 'user' | 'system'
}

export interface LogQuery {
    readonly startTime?: number // unix epoch
    readonly endTime?: number // unix epoch
    readonly limit?: number
}

type LogQueryResponse = LogEvent[] | Promise<LogEvent[]> | AsyncIterable<LogEvent[]>

export interface LogProviderProps {
    readonly resourceType: string
    readonly queryLogs: (resource: any, query: LogQuery) => LogQueryResponse
}

//# resource = true
export class LogProvider extends ApiRegistration {
    public constructor(props: LogProviderProps) {
        super({
            kind: 'log-provider',
            config: new SerializedObject(props).filePath,
        })

        // TODO: modules should be bound with the context they're referenced in
        // rather than the context they're loaded in. 
        //
        // Overriding ensures a stable resource key when the resource is created on
        // module load. But it means only one resource can exist.
        terraform.overrideId(this, `LogProvider-${props.resourceType.replaceAll('.', '-')}`)
    }
}

export function registerLogProvider<T extends object>(
    ctor: new (...args: any[]) => T, 
    queryLogs: (resource: T, query: LogQuery) => LogQueryResponse
) {
    const key = terraform.getClassKey(ctor)
    if (!key || !key.startsWith('resource')) {
        throw new Error(`Not a valid resource class: ${ctor.name} [key: ${key}]`)
    }

    const resourceType = key.split('.').slice(1).join('.')

    return new LogProvider({ resourceType, queryLogs })
}
