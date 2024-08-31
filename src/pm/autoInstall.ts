import { createSynapseProviderRequirement, PackageJson } from './packageJson'
import { addImplicitPackages } from './publish'
import { SynapseConfiguration } from '../workspaces'
import { getLatestVersion, getSpecifierComponents } from './packages'
import { getLogger } from '../logging'
import { isBuiltin } from 'node:module'

// Determines what's needed in `package.json` based on module specifiers
// TODO: skip adding types entirely when running in "script mode"
export async function getNeededDependencies(deps: Set<string>, pkg: PackageJson, synapseConfig?: SynapseConfiguration) {
    const dependencies: Record<string, string> = {}
    const devDependencies: Record<string, string> = {}

    const installed = new Set([
        ...(pkg.dependencies ? Object.keys(pkg.dependencies) : []),
        ...(pkg.devDependencies ? Object.keys(pkg.devDependencies) : []),
        ...(pkg.peerDependencies ? Object.keys(pkg.peerDependencies) : []),
        ...(pkg.optionalDependencies ? Object.keys(pkg.optionalDependencies) : []),
        ...(pkg.optionalDevDependencies ? Object.keys(pkg.optionalDevDependencies) : []),
    ])

    let shouldAddSynapse = false
    for (const spec of deps) {
        const components = getSpecifierComponents(spec)

        if (components.scheme === 'node' || (!components.scheme && !components.scope && isBuiltin(components.name))) {
            const typesSpec = '@types/node'
            if (!installed.has(typesSpec)) {
                // XXX: hard-coded
                // TODO: use the current built-in version
                installed.add(typesSpec)
                devDependencies[typesSpec] = '^22.5.0'
            }

            continue
        }

        const nameWithScope = components.scheme 
            ? `${components.scheme}:${components.name}` 
            : components.name

        if (installed.has(nameWithScope)) {
            continue
        }

        if (components.scheme === 'synapse' || components.scheme === 'synapse-provider') {
            shouldAddSynapse = true
            installed.add(nameWithScope)

            if (components.scheme === 'synapse-provider') {
                const [_, constraint] = createSynapseProviderRequirement(components.name, '*')
                devDependencies[nameWithScope] = constraint
            }
        } else if (spec.startsWith('@cohesible/synapse-')) {
            shouldAddSynapse = true
            installed.add(nameWithScope)

            const name = spec.split('/')[1]
            devDependencies[`@cohesible/${name}`] = `spr:#${name}`
        } else {
            // TODO: parallelize or defer by writing `latest` to version constraint
            const latest = await getLatestVersion(nameWithScope).catch(err => {
                getLogger().warn(`Failed to resolve specifier "${spec}"`, err)
            })

            if (latest?.source) {
                getLogger().log(`Resolved unbound specifier "${spec}" -> ${latest.source}`)

                installed.add(nameWithScope)
                dependencies[nameWithScope] = `^${latest.source}`

                // TODO: check for `@types` if the package lacks types
            }
        }
    }

    const devDeps = shouldAddSynapse 
        ? await addImplicitPackages({ ...pkg.devDependencies, ...devDependencies }, synapseConfig)
        : devDependencies

    return { dependencies, devDependencies: devDeps }
}
