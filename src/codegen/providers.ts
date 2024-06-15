import ts from 'typescript'
import * as path from 'node:path'
import { getProviderCacheDir, getProviderTypesDirectory, getWorkingDirectory, getGlobalCacheDirectory } from '../workspaces'
import { capitalize, memoize, toAmbientDeclarationFile, toSnakeCase } from '../utils'
import { providerPrefix } from '../runtime/loader'
import { Fs, SyncFs } from '../system'
import { runCommand } from '../utils/process'

// --------------------------------------------------------------- //
// --------------------- SCHEMA RENDERING ------------------------ //
// --------------------------------------------------------------- //

interface TerraformSchema {
    readonly format_version: '1.0' | string
    readonly provider_schemas: Record<string, ProviderSchema>
}

interface ProviderSchema {
    readonly provider: Schema
    readonly resource_schemas: Record<string, Schema>
    readonly data_source_schemas: Record<string, Schema>
}

interface Schema {
    readonly version: 0 | number // schema version, not provider
    readonly block: Block
}

type DescriptionKind = 'plain' | 'markdown' | string

interface Block {
    readonly attributes?: Record<string, Attribute>
    readonly block_types?: Record<string, BlockType>
    readonly description?: string
    readonly description_kind?: DescriptionKind
}

type AttributeType = PrimitiveType | ObjectType | ContainerType
type PrimitiveType = 'string' | 'bool' | 'number' | 'dynamic'
type ObjectType = ['object', Record<string, AttributeType>]
type ContainerType = ['set' | 'map' | 'list', AttributeType]

// It appears that if the type is a `list` then the the next element in the array is the element type
// Same thing applies to `map` and `set` and `object` ?

interface Attribute {
    readonly type: AttributeType
    readonly description?: string
    readonly description_kind?: DescriptionKind
    readonly required?: boolean
    readonly computed?: boolean
    readonly optional?: boolean
    readonly deprecated?: boolean
    readonly sensitive?: boolean
}

interface BlockType {
    readonly nesting_mode: 'single' | 'set' | 'list' | 'map'
    readonly block: Block
    readonly min_items?: number
    readonly max_items?: number // only in `list` ?
}

function getImmediateObjectType(v: AttributeType): ObjectType[1] | undefined {
    if (!Array.isArray(v)) {
        return
    }

    if (v[0] === 'object') {
        return v[1]
    }

    // if (Array.isArray(v[1]) && v[1][0] === 'object') {
    //     return v[1][1]
    // }

    return
}

function hasRequiredField(block: Block) {
    if (!block.attributes) return false

    return !!Object.values(block.attributes).find(a => a.required || !a.optional)
}

function createNameMapper(mappings = Object.create(null) as Record<string, any>) {
    function normalize(str: string) {
        const [first, ...rest] = str.split('_')
        const mapped = [first, ...rest.map(capitalize)].join('')
        if (typeof mappings[mapped] === 'object') {
            mappings[mapped][''] = toSnakeCase(mapped) !== str ? str : ''
        } else {
            mappings[mapped] = toSnakeCase(mapped) !== str ? str : ''
        }

        return [first, ...rest.map(capitalize)].join('')
    }

    function addType(str: string, type: string | number) {
        const [first, ...rest] = str.split('_')
        const mapped = [first, ...rest.map(capitalize)].join('')
        if (typeof mappings[mapped] === 'string') {
            mappings[mapped] = { '': mappings[mapped] }
        } else if (!mappings[mapped]) {
            mappings[mapped] = { '': '' }
        }

        mappings[mapped]['_'] = type
    }

    function createSubmapper(suffix: string) {
        const submappings = mappings[suffix] = typeof mappings[suffix] === 'string'
            ? { '': mappings[suffix] } 
            : (typeof mappings[suffix] === 'undefined' ? {} : mappings[suffix])

        return createNameMapper(submappings)
    }

    return { mappings, normalize, createSubmapper, addType }
}

function inheritDocs<T extends ts.Node>(to: T, from: ts.Node) {
    const comments = ts.getSyntheticLeadingComments(from)
    ts.setSyntheticLeadingComments(to, comments)

    return to
}

const savedDocs = new Map<string, string>()
function addDocs<T extends ts.Node>(node: T, docs?: string, key?: string) {
    // Some data sources are directly related with a resource but do not include docs in their schema
    if (key) {
        if (docs) {
            savedDocs.set(key, docs)
        } else {
            docs = inferDocs(key)
        }
    }

    if (!docs) return node

    const lines = docs.split('\n')
    const text = `*\n${lines.map(l => ` * ${l.trim()}`).join('\n')}\n `

    return ts.setSyntheticLeadingComments(node, [{
        text,
        pos: -1,
        end: -1,
        hasLeadingNewline: true,
        hasTrailingNewLine: true,
        kind: ts.SyntaxKind.MultiLineCommentTrivia,
    }])
}

function inferDocs(key: string) {
    const [name, prop] = key.split('.')

    if (name.endsWith('Data')) {
        return savedDocs.get(`${name.slice(0, -4)}.${prop}`)
    }
}

function createGenerator(
    prefix = '', 
    mapper = createNameMapper(),
    interfaces = new Map<any, ts.InterfaceDeclaration>()
) {
    function createBlockType(name: string, data: BlockType, variance: 'in' | 'out' = 'in'): ts.PropertySignature {
        const key = `${prefix}.${name}-${variance}`
        if (!interfaces.has(key)) {
            const declName = `${prefix}${capitalize(name)}`
            const generator = createGenerator(declName, mapper.createSubmapper(name), interfaces)
            const elements = generator.getBlockElements(data.block, variance === 'in' ? { excludeComputed: true } : undefined)
            const decl = ts.factory.createInterfaceDeclaration(
                [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
                variance === 'out' ? `${declName}OutProps` : `${declName}Props`,
                undefined,
                undefined,
                elements
            )

            interfaces.set(key, decl)
        }

        const ref = ts.factory.createTypeReferenceNode(interfaces.get(key)!.name)

        function getType() {
            switch (data.nesting_mode) {
                case 'set':
                case 'list':
                    // Apparently older versions of the Terraform provider schema only supported nested
                    // lists/sets of objects instead of single objects. This lack of expressiveness meant
                    // implementations resorted to using lists/sets limited to 1 item instead.
                    if (data.max_items === 1) {
                        // TODO: replace the TF JSON format with something custom that avoids all of these issues
                        if (variance === 'out') {
                            // This alone appears to add ~300kB (or around 10%) to the AWS provider output
                            mapper.addType(name, 1) // `set`/`list` are effectively treated the same
                        }
                        return ref
                    }
                    return ts.factory.createArrayTypeNode(ref)

                case 'map':
                    return ts.factory.createTypeReferenceNode('Record', [ts.factory.createTypeReferenceNode('string'), ref])

                default:
                    return ref
            }
        }

        return ts.factory.createPropertySignature(
            [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
            name,
            // I guess it's always optional?
            !data.min_items ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
            // hasRequiredField(data.block) ? undefined : ts.factory.createToken(ts.SyntaxKind.QuestionToken),
            getType()
        )
    }
    
    function createAttribute(name: string, data: Attribute, variance: 'in' | 'out' = 'in') {
        const isOptional = variance === 'in'
            ? !(data.required || (!data.optional && !data.computed))
            : (!data.required && !data.computed)
    
        const prop = ts.factory.createPropertySignature(
            [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
            name,
            isOptional ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
            createAttributeShape(data.type, name)
        )

        return addDocs(prop, data.description, `${prefix}.${name}`)
    }

    function getObjectMembers(o: any) {
        const members: ts.TypeElement[] = []
        for (const [k, v] of Object.entries(o)) {
            members.push(ts.factory.createPropertySignature(
                [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                mapper.normalize(k),
                undefined,
                createAttributeShape(v as any, k)
            ))
        }
    
        return members
    }

    // Name is the name of the associated member
    function createAttributeShape(type: AttributeType, name: string): ts.TypeNode {
        const objectType = getImmediateObjectType(type)
        if (objectType) {
            const key = `${prefix}.${name}`
            if (!interfaces.has(key)) {
                const declName = `${prefix}${capitalize(name)}`
                const generator = createGenerator(declName, mapper.createSubmapper(name), interfaces)
                const elements = generator.getObjectMembers(objectType)
                const decl = ts.factory.createInterfaceDeclaration(
                    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
                    `${declName}Props`,
                    undefined,
                    undefined,
                    elements
                )

                interfaces.set(key, decl)
            }

            return ts.factory.createTypeReferenceNode(interfaces.get(key)!.name)
        }

        if (typeof type === 'string') {
            switch (type) {
                case 'string':
                case 'number':
                    return ts.factory.createTypeReferenceNode(type)
                case 'bool':
                    return ts.factory.createTypeReferenceNode('boolean')
                case 'dynamic':
                    return ts.factory.createTypeReferenceNode('any')
                default:
                    throw new Error(`Unknown type: ${type}`)
            }
        }

        switch (type[0]) {
            case 'object':
                return ts.factory.createTypeLiteralNode(getObjectMembers(type[1]))
            case 'set':
            case 'list':
                return ts.factory.createArrayTypeNode(createAttributeShape(type[1], name))
            case 'map':
                return ts.factory.createTypeReferenceNode('Record', [
                    ts.factory.createTypeReferenceNode('string'),
                    createAttributeShape(type[1], name)
                ])
        }
    }

    function getBlockElements(data: Block, opt?: { excludeComputed?: boolean }): ts.PropertySignature[] {
        const members: ts.PropertySignature[] = []
        const variance = opt?.excludeComputed ? 'in' : 'out'
        if (data.attributes) {
            for (const [k, v] of Object.entries(data.attributes)) {
                if (v.computed && !v.required && !v.optional && opt?.excludeComputed) continue

                const name = mapper.normalize(k)
                members.push(createAttribute(name, v, variance))
            }
        }
    
        if (data.block_types) {
            for (const [k, v] of Object.entries(data.block_types)) {
                const name = mapper.normalize(k)
                members.push(
                    addDocs(
                        createBlockType(name, v, variance),
                        v.block.description,
                        `${prefix}.${name}`
                    )
                )
            }    
        }
    
        return members
    }

    return { mapper, interfaces, getBlockElements, getObjectMembers }
}

function generateConstruct(name: string, schema: Schema, mapper = createNameMapper(), kind?: 'provider' | 'resource' | 'data-source') {
    const propsName = `${name}Props`
    const generator = createGenerator(name, mapper)
    // Must be called first
    removeNestedTypes(schema.block)

    const stateElements = generator.getBlockElements(schema.block)
    const propsDeclElements = generator.getBlockElements(schema.block, { excludeComputed: true })
    const result: (ts.InterfaceDeclaration | ts.ClassDeclaration)[] = [...generator.interfaces.values()]

    function createConstructorParameters() {
        if (propsDeclElements.length === 0) {
            return []
        }

        const propsDecl = ts.factory.createInterfaceDeclaration(
            [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
            propsName,
            undefined,
            undefined,
            propsDeclElements
        )
        result.push(propsDecl)

        const props = ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            'props',
            propsDeclElements.filter(x => !x.questionToken).length === 0
                ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
                : undefined,
            ts.factory.createTypeReferenceNode(propsName)
        )

        return [props]
    }

    const ctor = ts.factory.createConstructorDeclaration(
        undefined,
        createConstructorParameters(),
        undefined
    )

    function createPropertyDecl(sig: ts.PropertySignature) {
        const decl = ts.factory.createPropertyDeclaration(
            (sig as any).modifiers,
            (sig.name as ts.Identifier),
            sig.questionToken,
            sig.type,
            undefined
        )

        return inheritDocs(decl, sig)
    }

    // Only static provider attributes can be referenced
    const props = (kind === 'provider' ? propsDeclElements : stateElements).map(createPropertyDecl)

    const decl = ts.factory.createClassDeclaration(
        [
            ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
            ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)
        ],
        name,
        undefined,
        undefined,
        [...props, ctor]
    )

    result.push(addDocs(decl, schema.block.description))

    return result
}

// Exclude `Wafv2` ???
// It's massive...

async function installTypes(fs: Fs, workingDirectory: string, packages: Record<string, string>) {
    const indexFileName = 'index.d.ts'
    const typesPackage = getProviderTypesDirectory(workingDirectory)
    const packageJsonPath = path.resolve(typesPackage, 'package.json')

    async function getPackageJson(): Promise<{ name: string; types: string; installed: Record<string, boolean> }> {
        try {
            return JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
            
            return {
                name: '@types/synapse-providers',
                types: indexFileName,
                installed: {},
            }
        }
    }

    const getDeclFileName = (providerName: string) => `${providerName}.d.ts`

    const packageJson = await getPackageJson()
    packageJson.installed ??= {}

    await Promise.all(Object.entries(packages).map(async ([k, v]) => {    
        const typesFile = await fs.readFile(path.resolve(v, indexFileName))
        await fs.writeFile(path.resolve(typesPackage, `${k}.d.ts`), typesFile)
        packageJson.installed[k] = true
    }))

    packageJson.installed = Object.fromEntries(
        Object.entries(packageJson.installed).sort((a, b) => a[0].localeCompare(b[0]))
    )

    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, undefined, 4))

    const indexFile = Object.entries(packageJson.installed)
        .filter(([_, v]) => v)
        .map(([k]) => getDeclFileName(k))
        .map(n => `/// <reference path="${n}" />`).join('\n')

    await fs.writeFile(
        path.resolve(typesPackage, indexFileName), 
        indexFile,
    )
}

async function generateProvider(fs: Fs, provider: ProviderInfo, outdir: string, generateLazyBindings = true) {
    interface Provider {
        readonly kind: 'provider'
        readonly id: string
        readonly source: string
        readonly version: string
    }

    interface Resource {
        readonly kind: 'resource'
        readonly id: string
    }

    interface DataSource {
        readonly kind: 'data-source'
        readonly id: string
    }

    type Element = Provider | Resource | DataSource

    const mapper = createNameMapper()
    const map = new Map<string, Element>()
    const outfile: ts.Statement[] = []


    const providerName = `${capitalize(provider.name)}Provider`
    outfile.push(...generateConstruct(providerName, provider.schema.provider, mapper.createSubmapper(providerName), 'provider'))
    map.set(providerName, { 
        kind: 'provider',
        id: provider.name, 
        source: provider.source,
        version: provider.version,
    })


    for (const [k, v] of Object.entries(provider.schema.resource_schemas)) {
        // we'll remove the provider name
        const name = capitalize(mapper.normalize(k.split('_').slice(1).join('_')))
        outfile.push(...generateConstruct(name, v, mapper.createSubmapper(name)))
        map.set(name, { id: k, kind: 'resource' })
    }

    for (const [k, v] of Object.entries(provider.schema.data_source_schemas)) {
        const name = capitalize(mapper.normalize(k.split('_').slice(1).join('_'))) + 'Data'
        outfile.push(...generateConstruct(name, v, mapper.createSubmapper(name)))
        map.set(name, { id: k, kind: 'data-source' })
    }

    const declSf = ts.factory.createSourceFile(outfile, ts.factory.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None)
    const sf = toAmbientDeclarationFile(`${providerPrefix}${provider.name}`, declSf)

    // Actual logic
    const indexfile: string[] = []
    indexfile.push('"use strict";')
    indexfile.push('const terraform = require("synapse:terraform");')

    if (generateLazyBindings) {
        indexfile.push('function bindClass(name, fn) {')
        indexfile.push('    let v;')
        indexfile.push('    const get = () => v ??= terraform.createTerraformClass(...fn());')
        indexfile.push('    Object.defineProperty(exports, name, { get });')
        indexfile.push('}')
    } else {
        indexfile.push('function bindClass(name, type, kind, mappings, version, source) {')
        indexfile.push('    exports[name] = terraform.createTerraformClass(type, kind, mappings, version, source);')
        indexfile.push('}')
    }

    for (const [k, v] of map.entries()) {
        const mappings = mapper.mappings[k]
        const args: any[] = [k, v.id, v.kind]
        if (typeof mappings !== 'object' || Object.keys(mappings).length === 0) {
            args.push(undefined);
        } else {
            args.push(mappings)
        }

        if (v.kind === 'provider') {
            args.push(v.version, v.source)
        }

        if (generateLazyBindings) {
            indexfile.push(`bindClass('${args[0]}', () => JSON.parse('${JSON.stringify(args.slice(1))}'));`)
        } else {
            indexfile.push(`bindClass(...JSON.parse('${JSON.stringify(args)}'));`)
        }
    }

    await fs.writeFile(
        path.resolve(outdir, 'index.js'),
        indexfile.join('\n')
    )
    
    await fs.writeFile(path.resolve(outdir, 'index.d.ts'), sf.text)

    await createResolvedFile()

    const packageJson = {
        name: provider.name,
        source: provider.source,
        version: provider.version, 
        exports: { '.': './index.js' },
    }

    await fs.writeFile(
        path.resolve(outdir, 'package.json'),
        JSON.stringify(packageJson, undefined, 4)
    )

    return outdir

    // Used for bundling
    // Can be removed once these classes are stripped out from the serialization data on deployment
    async function createResolvedFile() {
        const resolvedFile: string[] = []
        resolvedFile.push('"use strict";')
        resolvedFile.push(`const names = JSON.parse('${JSON.stringify(Array.from(map.keys()))}');`)
        resolvedFile.push(`names.forEach(name => exports[name] = class {});`)
    
        await fs.writeFile(
            path.resolve(outdir, 'index.resolved.js'),
            resolvedFile.join('\n')
        )
    }
}

function render(o: any): string {
    if (typeof o === 'string') {
        return `'${o}'`
    }
    if (typeof o === 'undefined') {
        return 'undefined'
    }
    if (typeof o !== 'object' || !o) {
        return o
    }
    
    return `{ ${Object.entries(o).map(([k, v]) => `'${k}': ${render(v)}`).join(', ')} }`
}

async function getProviderVersions(terraformPath: string, cwd: string) {
    const result: Record<string, string> = {}
    const stdout = await runCommand(terraformPath, ['version'], { cwd })

    for (const line of stdout.split('\n')) {
        const [_, source, version] = line.match(/provider (.*) v([0-9]+\.[0-9]+\.[0-9]+.*)/) ?? []
        if (source && version) {
            result[source] = version
        }
    }

    return result
}

function removeNestedTypes(block: Block) {
    if (!block.attributes) {
        return block
    }

    const block_types = (block as { -readonly [P in keyof Block]: Block[P] }).block_types ??= {}
    for (const [k, v] of Object.entries(block.attributes)) {
        if ('nested_type' in v) {
            delete block.attributes[k]
            block_types[k] = {
                block: {
                    ...removeNestedTypes((v as any).nested_type),
                    description: v.description,
                    description_kind: v.description_kind,
                    optional: v.optional,
                } as any,
                nesting_mode: (v as any).nested_type.nesting_mode,
            }
        }
    }

    return block
}

async function listVersions(
    terraformPath: string,
    source: string,
): Promise<string[]> {
    const result = await runCommand(terraformPath, ['providers', 'list', source])
    const data = JSON.parse(result.trim().split('\n').pop()!).data
    if (!Array.isArray(data)) {
        throw new Error(`Expected an array of versions, got: ${typeof data}`)
    }

    // Latest version first
    return data.reverse()
}

async function getProviderSchema(
    fs: Fs & SyncFs, 
    terraformPath: string,
    info: Omit<ProviderInfo, 'schema'>,
    cwd = process.cwd(),
): Promise<ProviderInfo> {
    const { name, source, version } = info
    const tfJson = JSON.stringify({
        terraform: {
            'required_providers': {
                [name]: { version, source }
            }
        }
    })

    const tfJsonPath = path.resolve(cwd, 'tmp.tf.json')
    await fs.writeFile(tfJsonPath, tfJson)
    const env = { TF_PLUGIN_CACHE_DIR: getProviderCacheDir() }

    try {
        await runCommand(terraformPath, ['init'], { cwd, env })
        const stdout = await runCommand(terraformPath, ['providers', 'schema', '-json'], { cwd, env })

        const parsed = JSON.parse(stdout) as TerraformSchema
        const schema = parsed['provider_schemas'][source]
        if (!schema) {
            throw new Error(`Failed to get provider schema for "${name}" from Terraform output`)
        }

        return {
            name,
            source,
            schema,
            version,
        }
    } finally {
        try {
            await fs.deleteFile(tfJsonPath)
            await fs.deleteFile(path.resolve(cwd, '.terraform.lock.hcl'))
        } catch {}
    }
}

export interface ProviderConfig {
    readonly name: string
    readonly source?: string
    readonly version?: string
}

interface ResolvedProviderConfig extends ProviderConfig {
    readonly source: string
    readonly version: string
}

interface ProviderInfo extends ResolvedProviderConfig {
    readonly schema: ProviderSchema
}

export function getProviderSource(name: string, providerRegistryHostname?: string) {
    switch (name) {
        // case 'aws':
        //     return `${providerRegistryHostname}/cohesible/aws`
        case 'github':
            return 'registry.terraform.io/integrations/github'
        case 'fly':
            return 'registry.terraform.io/fly-apps/fly'
        case 'kubernetes':
            return 'registry.terraform.io/hashicorp/kubernetes'

        // Built-ins
        case 'synapse':
        case 'terraform':
            return `terraform.io/builtin/${name}`

        default:
            return `registry.terraform.io/hashicorp/${name}`
    }
}

export async function listProviderVersions(name: string, providerRegistryHostname?: string, terraformPath = 'terraform') {
    const source = name.includes('/') ? name : getProviderSource(name, providerRegistryHostname)

    return listVersions(terraformPath, source)
}

export function createProviderGenerator(fs: Fs & SyncFs, providerRegistryHostname: string, terraformPath = 'terraform') {
    const providersDir = path.resolve(getGlobalCacheDirectory(), 'providers-codegen')
    const schemasDir = path.resolve(providersDir, 'schemas')
    const packagesDir = path.resolve(providersDir, 'packages')

    async function resolveProvider(provider: ProviderConfig): Promise<ResolvedProviderConfig> {
        const source = provider.source ?? getProviderSource(provider.name, providerRegistryHostname)
        const version = provider.version ?? (await listVersions(terraformPath, source))[0]
        
        return {
            source,
            version,
            name: provider.name,
        }
    }

    async function getSchema(resolved: ResolvedProviderConfig): Promise<ProviderSchema> {
        const key = `${resolved.source}/${resolved.version}`
        const cacheDir = path.resolve(schemasDir, '.cache')
        const schemaPath = path.resolve(cacheDir, key, 'schema.json')

        try {
            return JSON.parse(await fs.readFile(schemaPath, 'utf-8'))
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }

            const schemasWorkingDir = path.resolve(schemasDir, `${resolved.name}-${resolved.version}`)
            const info = await getProviderSchema(fs, terraformPath, resolved, schemasWorkingDir)
            await fs.writeFile(schemaPath, JSON.stringify(info.schema))

            return info.schema
        }
    }

    const getInstalledProviders = memoize(async function (): Promise<Record<string, string>> {
        const pkgManifest = path.resolve(providersDir, 'manifest.json')

        try {
            return JSON.parse(await fs.readFile(pkgManifest, 'utf-8'))
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
            return {}
        }
    })

    async function generate(provider: ProviderConfig, dest?: string) {
        const resolved = await resolveProvider(provider)
        const info = { ...resolved, schema: await getSchema(resolved) }
        const outdir = dest ?? path.resolve(packagesDir, resolved.source, resolved.version)

        const pkgManifest = path.resolve(providersDir, 'manifest.json')
        const manifest = await getInstalledProviders()

        const pkgDest = await generateProvider(fs, info, outdir)
        manifest[provider.name] = path.relative(providersDir, pkgDest)
        await fs.writeFile(pkgManifest, JSON.stringify(manifest, undefined, 4))

        return {
            ...resolved,
            dest: pkgDest,
        }
    }

    return { 
        generate,
        resolveProvider,
        installTypes: (packages: Record<string, string>, workingDirectory = getWorkingDirectory()) => installTypes(fs, workingDirectory, packages),
    }
}
