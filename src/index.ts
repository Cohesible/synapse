import ts from 'typescript'
import * as path from 'node:path'
import { CompilerOptions, CompilerHost, synth, CompiledSource, readPointersFile, readSources } from './compiler/host'
import { FailedTestEvent, TestEvent, runTask } from './logging'
import { BoundTerraformSession, DeployOptions, SessionContext, SessionError, createStatePersister, createZipFromDir, getChangeType, getDiff, getTerraformPath, isTriggeredReplaced, parsePlan, startStatelessTerraformSession, startTerraformSession } from './deploy/deployment'
import { LocalWorkspace, getV8CacheDirectory, initProject, getLinkedPackagesDirectory, Program, getRootDirectory, getDeploymentBuildDirectory, getTargetDeploymentIdOrThrow, getOrCreateDeployment, getWorkingDir } from './workspaces'
import { createLocalFs } from './system'
import { AmbientDeclarationFileResult, Mutable, acquireFsLock, createHasher, createRwMutex, getCiType, isNonNullable, isWindows, keyedMemoize, makeExecutable, memoize, printNodes, replaceWithTilde, showArtifact, throwIfNotFileNotFoundError, toAmbientDeclarationFile, wrapWithProxy } from './utils'
import { SymbolGraph, SymbolNode, createMergedGraph, createSymbolGraph, createSymbolGraphFromTemplate, detectRefactors, normalizeConfigs, renderSymbol, renderSymbolLocation } from './refactoring'
import { SourceMapHost } from './static-solver/utils'
import { getLogger } from './logging'
import { createContext, createModuleLoader, createSourceMapParser } from './runtime/loader'
import { BuildFsIndex, CompiledChunk, TemplateWithHashes, checkBlock, commitProgram, createArtifactFs, createBuildFsFragment, createMountedFs, getDataRepository, getFsFromHash, getInstallation, getMoved, getPreviousDeploymentProgramHash, getDeploymentFs, getProgramFs, getProgramHash, getResourceProgramHashes, listCommits, maybeRestoreTemplate, printBlockInfo, putState, readResourceState, readState, saveMoved, shutdownRepos, syncRemote, toFs, toFsFromHash, writeTemplate } from './artifacts'
import { PackageService, createPackageService, maybeDownloadPackages, showManifest, downloadAndUpdatePackage, verifyInstall, downloadAndInstall, listInstall, resolveDepsGreedy, printTree } from './pm/packages'
import { createTestRunner, listTestSuites, listTests } from './testing'
import { ReplOptions, enterRepl, createReplServer, prepareReplWithSymbols, getSymbolDataResourceId } from './repl'
import { createTemplateService, getHash, parseModuleName } from './templates'
import { createImportMap, createModuleResolver } from './runtime/resolver'
import { createAuth, getAuth } from './auth'
import { generateOpenApiV3, generateStripeWebhooks } from './codegen/schemas'
import { addImplicitPackages, createMergedView, createNpmLikeCommandRunner, dumpPackage, emitPackageDist, getPkgExecutables, getProjectOverridesMapping, installToUserPath, linkPackage } from './pm/publish'
import { ResolvedProgramConfig, getResolvedTsConfig, resolveProgramConfig } from './compiler/config'
import { createProgramBuilder, getDeployables, getEntrypointsFile, getExecutables } from './compiler/programBuilder'
import { loadCpuProfile } from './perf/profiles'
import { colorize, createTreeView, printJson, printLine, print, getDisplay, bold, RenderableError, dim } from './cli/ui'
import { createDeployView, extractSymbolInfoFromPlan, groupSymbolInfoByFile, printSymbolTable, renderBetterSymbolName, renderSummary, renderSymbolWithState } from './cli/views/deploy'
import { TfJson } from './runtime/modules/terraform'
import { glob } from './utils/glob'
import { createMinimalLoader } from './runtime/rootLoader'
import { getBackendClient } from './backendClient'
import { createCodeCache } from './runtime/utils'
import { getBuildTarget, getBuildTargetOrThrow, getFs, getSelfPathOrThrow, isCancelled, isSelfSea, throwIfCancelled } from './execution'
import * as secrets from './services/secrets'
import * as workspaces from './workspaces'
import { createTestView } from './cli/views/test'
import { clearIncrementalCache, createIncrementalHost, getAllDependencies, getFileHasher } from './compiler/incremental'
import { getMostRecentLogFile, getSortedLogs, listLogFiles } from './cli/logger'
import { ResolvedPackage, getCompiledPkgJson, getCurrentPkg, getPackageJson, getPreviousPkg, parsePackageInstallRequests, resetCompiledPkgJson, setCompiledPkgJson } from './pm/packageJson'
import * as quotes from '@cohesible/quotes'
import * as analytics from './services/analytics'
import { TfState } from './deploy/state'
import { bundleExecutable, bundlePkg } from './closures'
import { cleanArtifacts, maybeCreateGcTrigger } from './build-fs/gc'
import { buildBinaryDeps, copyIntegrations, createArchive, createPackageForRelease, installExternalPackages, signWithDefaultEntitlements } from './cli/buildInternal'
import { runCommand, which } from './utils/process'
import { transformNodePrimordials } from './utils/convertNodePrimordials'
import { createCompileView, getPreviousDeploymentData } from './cli/views/compile'
import { createSessionContext, getModuleLoader, getSession, shutdownSessions } from './deploy/session'
import { findArtifactByPrefix, getMetadata } from './build-fs/utils'
import { diffFileInLatestCommit, diffIndices, diffObjects } from './build-fs/stats'
import { renderCmdSuggestion } from './cli/commands'
import * as ui from './cli/ui'
import * as bfs from './artifacts'
import { findAllBareSpecifiers, findProviderImports } from './compiler/entrypoints'
import { makeSea, resolveAssets } from './build/sea'
import { createGraphCompiler, createSerializer } from './static-solver'
import { createInstallView } from './cli/views/install'
import { resolveBuildTarget } from './build/builder'
import { createIndexBackup } from './build-fs/backup'
import { homedir } from 'node:os'
import { createBlock, openBlock } from './build-fs/block'
import { seaAssetPrefix } from './bundler'
import { buildWindowsShim } from './zig/compile'

export { runTask, getLogger } from './logging'

// TODO: https://github.com/pulumi/pulumi/issues/3388

// Apart of refactoring story:
// https://github.com/pulumi/pulumi/issues/3389

function removeUndefined<T extends Record<string, any>>(obj: T | undefined): { [P in keyof T]: NonNullable<T[P]> } | undefined {
    if (!obj) {
        return obj
    }

    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined)) as any
}

export type CombinedOptions = CompilerOptions & DeployOptions & { 
    forceRefresh?: boolean
    cwd?: string
    project?: string
    program?: string
    process?: string
}

export function shutdown() {
    const promises: Promise<unknown>[] = []

    promises.push(shutdownSessions())
    promises.push(shutdownRepos())
    promises.push(analytics.shutdown().catch(e => {
       getLogger().warn('Failed to flush events', e)
    }))

    return Promise.all(promises)
}


// TODO: add permissions model to all system APIs e.g. `fs`, `https`, etc.
// This would be very similar to Deno, but we can do so much more with it


export async function syncModule(deploymentId: string, bt = getBuildTargetOrThrow()) {
    const projectId = await workspaces.getRemoteProjectId(bt.projectId)
    if (projectId) {
        getLogger().log('Using remote project id', projectId)
        await syncRemote(projectId, bt.programId, deploymentId)
    }
}

export async function publish(target: string, opt?: CompilerOptions & DeployOptions & { newFormat?: boolean; archive?: string; dryRun?: boolean; local?: boolean; globalInstall?: boolean; skipInstall?: boolean }) {
    if (opt?.archive) {
        const packageDir = getWorkingDir()
        const dest = path.resolve(packageDir, opt.archive)
        const tmpDest = dest.replace(path.extname(opt.archive), '-tmp')
        const bt = getBuildTargetOrThrow()

        try {
            await createPackageForRelease(packageDir, tmpDest, { environmentName: bt.environmentName }, true, true)
            await createArchive(tmpDest, dest, false)
        } finally {
            await getFs().deleteFile(tmpDest).catch(throwIfNotFileNotFoundError)
        }

        return
    }

    if (opt?.local) {
        await linkPackage({ dryRun: opt?.dryRun, globalInstall: opt?.globalInstall, skipInstall: opt?.skipInstall, useNewFormat: opt?.newFormat }) 
    } else {
        throw new Error(`Publishing non-local packages is not implemented`)
    }
}

async function findOrphans() {
    const previousTemplate = await maybeRestoreTemplate()
    if (!previousTemplate) {
        throw new Error(`No previous template found`)
    }

    const state = await readState()
    if (!state) {
        throw new Error(`Cannot find orphans with no state`)
    }

    const orphans: string[] = []
    const resources = new Map<string, any>()
    for (const [k, v] of Object.entries(previousTemplate.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            resources.set(`${k}.${k2}`, v2)
        }
    }

    for (const r of state.resources) {
        const k = `${r.type}.${r.name}`
        if (!resources.has(k)) {
            orphans.push(k)
        }
    }

    return {
        previousTemplate,
        orphans,
    }
}

// IMPORTANT: this implementation is incredibly flawed in that it uses the previous template. It can
// potentially change resources if the orphans depend on current resources.
export async function collectGarbageResources(target: string, opt?: CombinedOptions & { dryRun?: boolean }) {
    const { orphans, previousTemplate } = await findOrphans()
    if (opt?.dryRun) {
        printLine(`Destroying (dry-run):`, orphans.join(', '))

        return 
    }

    if (orphans.length === 0) {
        getLogger().log(`Nothing to remove`)

        return
    }

    printLine(`Destroying:`, orphans.join(', '))

    const session = await getSession(getTargetDeploymentIdOrThrow())
    await session.setTemplate(previousTemplate)

    const res = await session.destroy({
        ...opt,
        targetResources: orphans,
    })

    if (res.state) {
        const afs = await bfs.getArtifactFs()
        await afs.commit(res.state)
    }

    if (res.error) {
        throw res.error
    }
}

export async function collectGarbage(target: string, opt?: CombinedOptions & { dryRun?: boolean }) {
    await cleanArtifacts(undefined, opt?.dryRun)
}

async function getMergedGraph(templateFile: TfJson) {
    const oldTemplate = await maybeRestoreTemplate()
    const oldGraph = oldTemplate ? createSymbolGraphFromTemplate(oldTemplate) : undefined

    return createMergedGraph(createSymbolGraphFromTemplate(templateFile), oldGraph)
}

async function getDeployView(templateFile: TfJson, isDestroy?: boolean) {
    return createDeployView(await getMergedGraph(templateFile), isDestroy) 
}


// Deploying to an active deployment with a different cloud target is very likely to be an error
// If detected, we'll immediately abort and suggest that the previous deployment should be destroyed
// before deploying to a new cloud provider
async function assertSameCloudTarget(template: TfJson) {
    // Template was stripped of metadata
    const currentTarget = template['//']?.deployTarget
    if (!currentTarget) {
        return
    }

    const previousTemplate = await maybeRestoreTemplate()
    const previousTarget = previousTemplate?.['//']?.deployTarget
    if (!previousTarget) {
        return
    }

    if (currentTarget !== previousTarget) {
        throw new RenderableError(`Mis-matched deployment targets`, () => {
            printLine(colorize('brightRed', 'Detected mis-matched deployment targets'))
            printLine(`    previous: ${colorize('green', previousTarget)}`)
            printLine(`    current: ${colorize('red', currentTarget)}`)
            printLine()

            const destroyCmd = renderCmdSuggestion('destroy')
            printLine(`If this is intentional, run ${destroyCmd} first and try again.`)
            printLine()
        })
    }
}

// The current stance is that anything that might change the "remote" application _must_ be
// an explicit/distinct step. It's not okay to automatically apply changes unless the user
// has opted-in through a very clear and obvious mechanism.
//
// Much of the motivation for this decision is because we don't want to surprise people.
// In theory, if someone was doing everything in a self-contained developer account then
// automatic deployments might actually be expected. But we don't know that.
//
// There's also plenty of situations where automatic deployments would get in the way because
// it's just too slow. Terraform does a decent job of minimizing the # of updates needed
// but it still triggers needless updates quite frequently.
//
// Over time, as the tooling matures, I expect automatic deploys (for developers) to become
// the norm. Right now that just isn't a common thing.

type DeployOpt2 = CombinedOptions & { 
    tsOptions?: ts.CompilerOptions; 
    autoDeploy?: boolean; 
    sessionCtx?: SessionContext; 
    dryRun?: boolean; 
    symbols?: string[]
    hideNextSteps?: boolean
    rollbackIfFailed?: boolean
    useOptimizer?: boolean
}

async function validateTargets(targets: string[]) {
    await Promise.all(targets.map(async t => {
        const resolved = path.resolve(getWorkingDir(), t)
        if (!(await getFs().fileExists(resolved))) {
            throw new Error(`No such file found: ${t}`)
        }
    }))
}

export async function deploy(targets: string[], opt?: DeployOpt2) {
    await validateTargets(targets)

    const programFsHash = opt?.sessionCtx?.buildTarget.programHash
    if (!programFsHash && !opt?.targetResources) {
        const doCompile = (beforeSynthCommit?: () => Promise<void>) => compile(targets, { incremental: true, skipSummary: true, hideLogs: true, deployTarget: opt?.deployTarget, beforeSynthCommit })

        const programState = await getProgramFs().readJson<{ needsSynth?: boolean }>('__buildState__.json').catch(throwIfNotFileNotFoundError)
        if (programState?.needsSynth) {
            await doCompile(() => getProgramFs().writeJson('[#compile]__buildState__.json', {
                ...programState,
                needsSynth: false,
            }))
        } else {
            // In any kind of machine-to-machine interaction we shouldn't try to be smart like this
            // It's better to fail and say that the program should be compiled explicitly first.
            // Auto-compile/synth is a feature for humans, not machines. 
            //
            // TODO: we should check stale compilation for `syn test` too
            // TODO: also we should limit the staleness check to the subgraph(s) specified by `targets`
            const { stale } = await getStaleDeployableSources(targets.length > 0 ? targets : undefined) ?? {}
            if (!stale || stale.size > 0) {
                await doCompile()
            } else if (opt?.deployTarget) {
                const prev = await getPreviousPkg()
                if (prev?.synapse?.config?.target !== opt.deployTarget) {
                    await doCompile()
                }
            }
        }
    }

    const deploymentId = getTargetDeploymentIdOrThrow()
    const session = await getSession(deploymentId, opt?.sessionCtx, { parallelism: 50 })
    const templateFile = await session.templateService.getTemplate()
    await assertSameCloudTarget(templateFile)

    const artifactFs = await bfs.getArtifactFs()
    getLogger().debug('Starting deploy operation')

    const view = await getDeployView(templateFile)

    if (opt?.symbols) {
        const targets = opt.targetResources ??= []
        const graph = createSymbolGraphFromTemplate(templateFile)
        for (const s of opt.symbols) {
            if (!!graph.getConfig(s)) {
                targets.push(s)
                continue
            }

            const n = getSymbolNodeFromRef(graph, s)
            for (const r of n.resources) {
                const id = `${r.type}.${r.name}`
                if (!targets.includes(id)) {
                    targets.push(id)
                }
            }
        }
    }

    const resolvedOpt: CombinedOptions = {
        parallelism: 50,
        disableRefresh: !opt?.forceRefresh,
        autoApprove: true,
        targetFiles: targets,
        ...opt,
    }

    try {
        const result = await runTask('apply', 'deploy', async () => {
            return session.apply(resolvedOpt)
        }, 1)

        if (result.state) {
            await artifactFs.commit(result.state, programFsHash, opt?.useTests ? true : undefined)
        }

        if (result.error && opt?.rollbackIfFailed) {
            await shutdownSessions()
            await rollback('', opt)
        }

        throwIfFailed(view, result.error)

        if (!opt?.hideNextSteps) {
            await showNextStepsAfterDeploy(templateFile, result.state)
        }

        return result.state
    } finally {
        // TODO: in theory this should happen right after saving the state to disk
        // We just want to make sure that if `syncModule` fails, it doesn't prevent
        // a rollback from happening.
        if (opt?.syncAfter) {
            await syncModule(deploymentId)
        }

        view.dispose()
    }
}

function throwIfFailed(view: { formatError: (err: any) => string }, sessionErr: any) {
    if (!sessionErr) {
        return
    }

    if (!(sessionErr instanceof SessionError)) {
        throw sessionErr
    }

    throw new RenderableError(sessionErr.message, () => {
        printLine()
        printLine(colorize('red', 'Failed to deploy')) // FIXME: use `destroy` when destroying

        for (const err of sessionErr.errors) {
            printLine(view.formatError(err))
        }
    })
}

async function showNextStepsAfterDeploy(template: TfJson, state: TfState) {
    const files = await getEntrypointsFile()
    const executables = files?.executables
    if (!executables) {
        return
    }

    const names = Object.keys(executables)
    if (names.length !== 1) {
        return
    }

    const executable = names[0]
    const deployed = findDeployedFileResources(state)
    if (!deployed[executable]) {
        return
    }

    printLine()
    printLine(`${colorize('brightWhite', executable)} can now be ran with ${renderCmdSuggestion('run')}`)
}

export async function install(targets: string[], opt?: { dev?: boolean; mode?: 'all' | 'types'; remove?: boolean }) {
    const cwd = getBuildTarget()?.workingDirectory ?? process.cwd()
    if (cwd !== process.cwd()) {
        printLine(colorize(`yellow`, `Treating ${getBuildTarget()?.workingDirectory} as the working directory`))
    }

    const view = createInstallView()
    const pkg = await getCurrentPkg() // FIXME: this needs to update the stored package when it changes
    if (!pkg) {
        if (opt?.remove) {
            printLine('Nothing to remove') //FIXME: needs better UX
            return
        }
        if (targets.length === 0) {
            printLine('Nothing to install') //FIXME: needs better UX
            return
        }

        const deps = parsePackageInstallRequests(targets)
        await downloadAndUpdatePackage({ directory: cwd, data: { dependencies: deps } as any }, deps)
        view.summarize()

        return
    }

    if (targets.length === 0) {
        if (opt?.remove) {
            printLine('Nothing to remove') //FIXME: needs better UX
            return
        }

        await maybeDownloadPackages(pkg, false, true)
    } else {
        if (opt?.remove) {
            await downloadAndUpdatePackage(pkg, Object.fromEntries(targets.map(k => [k, k])), opt?.dev, opt?.mode === 'all', true)
        } else {
            const parsed = parsePackageInstallRequests(targets)
            await downloadAndUpdatePackage(pkg, parsed, opt?.dev, opt?.mode === 'all')
        }
    }

    view.summarize()
}

// deploy/destroy should accept symbol names/ids too **but only if they are unambiguous**
// Using a switch/option to specify symbols works too, it's not as smooth though.
//
// In any case, we should never ever EVER destroy something the user did not want to destroy.
// Seriously. While many resources are easily replaced, some are not. And it's practically
// guaranteed that people will be manually destroying resources in production regardless of
// whatever we say.

export async function destroy(targets: string[], opt?: CombinedOptions & { dryRun?: boolean; symbols?: string[]; deploymentId?: string }) {
    // TODO: this should be done prior to running any commands, not within a command
    if (opt?.deploymentId) {
        Object.assign(getBuildTargetOrThrow(), { deploymentId: opt?.deploymentId }) 
    }

    const deploymentId = opt?.deploymentId ?? getTargetDeploymentIdOrThrow()
    const state = await readState()
    if (!state || state.resources.length === 0) {
        getLogger().debug('No resources to destroy, returning early')
        printLine(colorize('green', 'Nothing to destroy!'))
        return
    }

    const template = await maybeRestoreTemplate()
    if (!template) {
        throw new Error(`No previous deployment template found`)
    }

    const programHash = await getPreviousDeploymentProgramHash()
    const sessionCtx = await createSessionContext(programHash)

    const session = await getSession(deploymentId, sessionCtx, { parallelism: 50 })

    const view = await getDeployView(template, true)
    const artifactFs = await bfs.getArtifactFs()

    const resolvedOpt: DeployOptions = {
        parallelism: 50,
        disableRefresh: !opt?.forceRefresh,
        targetFiles: targets,
        ...opt,
    }

    if (opt?.symbols) {
        const graph = createSymbolGraphFromTemplate(template)
        const sym = getSymbolNodeFromRef(graph, opt.symbols[0])
        const arr = resolvedOpt.targetResources ??= []
        for (const r of sym.resources) {
            arr.push(`${r.type}.${r.name}`)
        }
    }

    try {
        const result = await session.destroy(resolvedOpt)

        await artifactFs.commit(result.state, undefined, opt?.useTests ? true : undefined)

        throwIfFailed(view, result.error)

        // Only delete this on a "full" destroy
        if (result.state.resources.length === 0) {
            const templateFilePath = await session.templateService.getTemplateFilePath()
            const stateFile = path.resolve(path.dirname(templateFilePath), '.terraform', 'terraform.tfstate')
            await getFs().deleteFile(stateFile).catch(e => {
                if ((e as any).code !== 'ENOENT') {
                    throw e
                }
            })
        
            const artifactFs = await bfs.getArtifactFs()
            await artifactFs.resetManifest(deploymentId)
        }

        return result.state
    } finally {
        if (opt?.syncAfter) {
            await syncModule(deploymentId)
        }

        view.dispose()
    }
}

async function getLocallyDeployableResources(session: BoundTerraformSession) {
    const templateFile = await session.templateService.getTemplate()
   
    const configs: Record<string, any> = {}
    for (const [k, v] of Object.entries(templateFile.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            configs[`${k}.${k2}`] = v2
        }
    }
    for (const [k, v] of Object.entries(templateFile.data)) {
        for (const [k2, v2] of Object.entries(v)) {
            configs[`data.${k}.${k2}`] = v2
        }
    }
    for (const [k, v] of Object.entries(templateFile.locals)) {
        configs[`local.${k}`] = v
    }

    const synapseResources = Object.keys(configs)
        .filter(x => x.startsWith('synapse_resource.') || x.startsWith('data.synapse_resource.'))
        .filter(k => configs[k].type !== 'Example' && configs[k].type !== 'Custom')

    const state = await session.getState()
    const deployed = new Set<string>()
    if (state) {
        for (const r of state.resources) {
            deployed.add(`${r.type}.${r.name}`)
        }
    }

    const deps: Record<string, Set<string>> = {}
    async function loadDeps(targets: string[]) {
        const needRefs = targets.filter(x => !deps[x])
        if (needRefs.length === 0) {
            return
        }

        const allRefs = await session.getRefs(needRefs)
        for (const [k, v] of Object.entries(allRefs)) {
            deps[k] = new Set(v.map(x => x.subject))
        }    
    }


    const canUse = new Map<string, boolean>()
    const csSet = new Set(synapseResources)
    const requiredDeps = new Map<string, string[]>()

    // `a` depends on `b`
    function addRequiredDep(a: string, b: string) {
        if (!requiredDeps.has(a)) {
            requiredDeps.set(a, [])
        }
        requiredDeps.get(a)!.push(b)
    }

    function explain(r: string): [string, any[]?] {
        return [r, requiredDeps.get(r)?.map(explain)]
    }

    // Assumption: no circular deps
    async function visit(k: string) {
        if (canUse.has(k)) {
            return canUse.get(k)!
        }

        if (!k.startsWith('data.') && !k.startsWith('local.') && !csSet.has(k)) {
            const isDeployed = deployed.has(k)
            canUse.set(k, isDeployed)

            return isDeployed
        }

        await loadDeps([...deps[k]])

        for (const d of deps[k]) {
            if (!(await visit(d))) {
                canUse.set(k, false)
                addRequiredDep(k, d)

                return false
            }
        }

        canUse.set(k, true)

        return true
    }

    await loadDeps([...csSet])
    const result: string[] = []
    for (const k of csSet) {
        if (await visit(k)) {
            result.push(k)
        }
    }

    return {
        result,
        deployed,
        explain,
    }
}

// FIXME: this is broken when nothing has been deployed
export async function deployModules(targetFiles: string[]) {
    const deploymentId = getTargetDeploymentIdOrThrow()
    const session = await getSession(deploymentId)
    const template = await session.templateService.getTemplate()
    const graph = createSymbolGraphFromTemplate(template)

    const set = targetFiles.length > 0 ? new Set(targetFiles) : undefined
    const targets: string[] = []
    const { result } = await getLocallyDeployableResources(session)
    for (const r of result) {
        const type = graph.getResourceType(r)
        if (type.kind === 'synapse' && type.name === 'Closure') {
            const config = graph.getConfig(r) as any
            if (!config?.input?.options?.isModule) continue

            const parsed = parseModuleName(config.module_name)
            if (set && set.has(parsed.fileName)) {
                targets.push(r)
            }
        }
    }

    if (targets.length === 0) {
        throw new Error(`Nothing to deploy`)
    }

    getLogger().log('Deploying', targets)

    await deploy([], {
        targetResources: targets,
    })
}

export async function findLocalResources(targets: string[], opt?: CombinedOptions) {
    const deploymentId = getTargetDeploymentIdOrThrow()
    const session = await getSession(deploymentId)
    const template = await session.templateService.getTemplate()
    const graph = createSymbolGraphFromTemplate(template)

    const { result, deployed, explain } = await getLocallyDeployableResources(session)
    for (const r of result) {
        const type = graph.getResourceType(r)
        if (type.kind === 'synapse' && type.name === 'Closure') {
            const config = graph.getConfig(r) as any
            if (!config?.input?.options?.isModule) continue

            printLine('<module>', config.module_name)
        }
    }

    const canDeployLocally = new Set(result)
    for (const x of graph.getSymbols()) {
        let isSelfDeployableLocally = true
        const n = new Set<SymbolNode>()
        const q = new Set<string>()
        for (const r of x.value.resources) {
            if (deployed.has(`${r.type}.${r.name}`)) continue
            if (canDeployLocally.has(`${r.type}.${r.name}`)) continue

            const z = explain(`${r.type}.${r.name}`)
            v(z)

            function v(z: any) {
                if (z[1] !== undefined) { // Means the resource depends on a not deployed resource
                    for (const t of z[1]) {
                        v(t)
                    }
                } else {
                    const sym = graph.findSymbolFromResourceKey(z[0])
                    if (sym === x){
                        isSelfDeployableLocally = false
                    } else if (sym) {
                        n.add(sym)
                    }
                    q.add(z[0])
                }
            }
        }

        if (n.size > 0) {
            printLine(x.value.name, 'depends on', [...n].map(x => x.value.name).join(', '))
            printLine(`    ${[...q].map(x => x.split('--').slice(0, -1).join('--')).map(x => x.slice(x.length - 20)).join(', ')}`)
        } else if (!isSelfDeployableLocally) {
            printLine(x.value.name)
            printLine(`    ${[...q].map(x => x.split('--').slice(0, -1).join('--')).map(x => x.slice(x.length - 20)).join(', ')}`)
        }
    }
}

// This assumes that the "primary" deployment is already active
export async function runTests(targets: string[], opt?: DeployOptions & { destroyAfter?: boolean; targetIds?: number[]; rollbackIfFailed?: boolean }) {
    // TODO: handle the other cases
    // await validateTargetsForExecution(targets[0], (await getEntrypointsFile())?.deployables ?? {})
    await compileIfNeeded(targets[0], false)

    const deploymentId = getTargetDeploymentIdOrThrow()

    const filter = {
        targetIds: opt?.targetIds,
        fileNames: targets.length > 0 ? targets : undefined,
    }

    const session = await getSession(deploymentId)

    const suites = await listTestSuites(session.templateService, filter)
    const tests = await listTests(session.templateService, filter)

    const targetResources = [
        ...Object.keys(suites),
        ...Object.keys(tests),
    ]

    const targetModules = new Set<string>()

    // FIXME: figure out a way to avoid doing this. Right now this is done to ensure 
    // that any resources that cause "side-effects" are also deployed
    const suiteIds = [
        ...Object.values(suites).map(x => x.id),
        ...Object.values(tests).map(x => x.parentId),
    ].filter(isNonNullable)
    const resources = (await session.templateService.getTemplate()).resource
    for (const [k, v] of Object.entries(resources)) {
        for (const [k2, v2] of Object.entries(v as any)) {
            const parsed = parseModuleName((v2 as any).module_name)
            const key = `${k}.${k2}`
            if (parsed.testSuiteId && suiteIds.includes(parsed.testSuiteId) && !targetResources.includes(key)) {
                targetResources.push(key)
                targetModules.add(parsed.fileName)
            }
        }
    }

    const [currentHash, hashes] = await Promise.all([
        getProgramHash(),
        getResourceProgramHashes(getDeploymentFs())
    ])

    const staleResources = new Set<string>()
    for (const r of targetResources) {
        if (hashes?.[r] !== currentHash) {
            staleResources.add(r)
        }
    }

    if (targetModules.size === 0) {
        // nothing to run??
        throw new RenderableError('Nothing to run', () => {
            printLine(colorize('brightRed', 'No test files found'))
        })
    }

    // const status = await getDeploymentStatus2([...targetModules], (await getEntrypointsFile())?.deployables ?? {})
    if (staleResources.size === 0) {
        getLogger().log('No changes detected, skipping deploy for test resources')
    } else {
        await deploy([], { 
            ...opt, 
            autoApprove: true, 
            useTests: true, 
            targetResources: [...staleResources], 
            hideNextSteps: true,
        })
        printLine() // Empty line to separate the deployment info from tests
    }

    const testRunner = createTestRunner(session.moduleLoader)
    const resolvedSuites = await testRunner.loadTestSuites(suites, tests)

    const failures: FailedTestEvent[] = []
    getLogger().onTest(ev => {
        if (ev.status === 'failed') {
            failures.push(ev)
        }
    })

    const view = createTestView()

    try {
        return await testRunner.runTestItems(Object.values(resolvedSuites).filter(x => !x.parentId))
    } finally {
        const shouldRollback = opt?.rollbackIfFailed && failures.length > 0
        if (opt?.destroyAfter) {
            await destroy([], { 
                ...opt, 
                autoApprove: true, 
                useTests: true,
                targetResources: targetResources,
            }).catch(err => {
                // Rolling back is much more important than a clean destruction of test resources
                if (!shouldRollback) {
                    throw err
                }

                getLogger().error(`Failed to destroy test resources`, err)
            })
        }

        if (shouldRollback) {
            await shutdownSessions() // TODO: can be removed if test resources use a separate process ID
            await rollback('', opt)
        }

        process.exitCode = failures.length > 0 ? 1 : 0

        view.showFailures(failures)
        view.dispose()
    }
}

export async function testGlob(patterns: string[], opt?: DeployOptions) {
    const excluded = undefined

    await runTask('glob', 'glob', async () => {
        const res = await glob(getFs(), getWorkingDir(), patterns, excluded ? [excluded] : undefined)
        printJson(res)
    }, 25)
}

async function openInEditor(filePath: string) {
    const termProgram = process.env['TERM_PROGRAM'] // or $VISUAL or $EDITOR

    switch (termProgram) {
        case 'vscode':
            return runCommand('code', [filePath])

        default:
            throw new Error(`Not supported: ${termProgram}`)
    }
}

export async function showLogs(patterns: string, opt?: DeployOptions) {
    if (patterns === 'list') {
        const logs = await getSortedLogs()
        for (const l of logs.reverse()) {
            printLine(replaceWithTilde(l.filePath))
        }

        return
    }

    const latest = await getMostRecentLogFile()
    if (!latest) {
        return printLine('No log file found')
    }

    process.stdout.write(await getFs().readFile(latest))
}

export async function plan(targets: string[], opt?: DeployOptions & { symbols?: string[]; forceRefresh?: boolean; planDepth?: number }) {
    const session = await getSession(getTargetDeploymentIdOrThrow(), undefined, { ...opt, noSave: true })
    const template = await session.templateService.getTemplate()

    if (opt?.symbols) {
        const targets = opt.targetResources ??= []
        const graph = createSymbolGraphFromTemplate(template)
        for (const s of opt.symbols) {
            if (!!graph.getConfig(s)) {
                targets.push(s)
                continue
            }

            const n = getSymbolNodeFromRef(graph, s)
            for (const r of n.resources) {
                const id = `${r.type}.${r.name}`
                if (!targets.includes(id)) {
                    targets.push(id)
                }
            }
        }
    }

    const res = await session.plan(
        {
            targetFiles: targets,
            consoleLogger: true, 
            disableRefresh: !opt?.forceRefresh,
            ...opt,
            // useCachedPlan: true,
        }
    )

    const g = await getMergedGraph(template)
    const info = extractSymbolInfoFromPlan(g, res)
    if (info.size === 0){
        printLine('No changes planned')
        return
    }

    const groups = groupSymbolInfoByFile(info)
    for (const [fileName, group] of Object.entries(groups)) {
        // const relPath = path.relative(getWorkingDir(), fileName)
        // const headerSize = Math.min(process.stdout.columns, 80)
        // const padding = Math.floor((headerSize - (relPath.length + 2)) / 2)
        // printLine(colorize('gray', `${'-'.repeat(padding)} ${relPath} ${'-'.repeat(padding)}`))
        // for (const [k, v] of group) {
        //     printLine(renderSymbolWithState(k.value, v, undefined, ui.spinners.empty))
        // }
        printSymbolTable(group)
    }
}

export async function backup(dest: string) {
    await createIndexBackup(path.resolve(dest))
}

export async function explain(target: string, opt?: DeployOptions & { forceRefresh?: boolean }) {
    const session = await getSession(getTargetDeploymentIdOrThrow(), undefined, { ...opt, noSave: true })
    const template = await session.templateService.getTemplate()
    const newSourceMap = template['//']?.sourceMap
    if (!newSourceMap) {
        throw new Error(`No new source map found`)
    }

    const newResources: Record<string, any> = {}
    for (const [k, v] of Object.entries(template.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            const id = `${k}.${k2}`
            newResources[id] = v2
        }
    }

    const symbolGraph = createSymbolGraphFromTemplate(template)
    const s = getSymbolNodeFromRef(symbolGraph, target)

    const res = await session.plan(
        { 
            consoleLogger: true, 
            disableRefresh: !opt?.forceRefresh,
            ...opt,
            targetResources: s.resources.map(x => `${x.type}.${x.name}`),
        }
    )

    const edges: [string, string][] = []
    for (const [k, v] of Object.entries(res)) {
        if (!v.state?.dependencies) {
            continue
        }

        for (const d of v.state.dependencies) {
            if (d in res) {
                edges.push([d, k])
            }
        }
    }

    const notRoots = new Set(edges.map(e => e[1]))
    const roots = new Set(edges.filter(x => !notRoots.has(x[0])).map(x => x[0]))

    for (const r of roots) {
        printLine(r, JSON.stringify(getDiff(res[r].change), undefined, 4))
    }
}

export async function show(targets: string[], opt?: DeployOptions & { 'names-only'?: boolean }) {
    const state = await readState()
    if (!state) {
        throw new Error('No state to show')
    }

    if (opt?.['names-only']) {
        for (const k of state.resources.map(r => `${r.type}.${r.name}`)) {
            printLine(k)
        }
        return
    }

    if (targets.length === 0) {
        printJson(state)
        return
    }

    const template = await maybeRestoreTemplate()
    if (!template) {
        throw new Error(`No deployment template found`)
    }

    const graph = createSymbolGraphFromTemplate(template)
    const sym = getSymbolNodeFromRef(graph, targets[0])
    const isDebug = (opt as any)?.debug

    for (const r of sym.resources) {
        if (r.name.endsWith('--definition') && r.subtype && !isDebug) {
            continue
        }

        const inst = state.resources.find(r2 => r2.name === r.name && r2.type === r.type)
        if (!inst) {
            printLine(`${r.name} [missing]`)
            continue
        }

        const instState = inst.state ?? ((inst as any).instances[0] as typeof inst.state)
        const attr = r.subtype ? instState.attributes.output.value : instState.attributes

        const displayName = isDebug ? r.name : (r.subtype ?? r.type)
        printLine(displayName)
        printJson(attr)
        printLine()
    }
}

export async function quote() {
    const data = await quotes.getRandomQuote()

    printLine()
    printLine(data.text)
    printLine()
    printLine(colorize('gray', `    —— ${data.author}`)) // 2 em dashes —
    printLine()
}

export async function putSecret(secretType: string, value: string, expiresIn?: number, opt?: CombinedOptions) {
    await secrets.putSecret(secretType, value)
}

export async function getSecret(secretType: string, opt?: CombinedOptions) {
    const resp = await secrets.getSecret(secretType)
    getLogger().log(resp)
}

export async function replaceResource(targetModule: string, resourceId: string, opt?: CombinedOptions) {
    const session = await getSession(getTargetDeploymentIdOrThrow())

    const artifactFs = await bfs.getArtifactFs()

    // try {
    //     const result = await session.apply({ ...options, replaceResource: resourceId, targetResource: resourceId })

    //     await artifactFs.commit(result.state)

    //     if (result.error) {
    //         throw result.error
    //     }

    //     return result.state
    // } finally {    
    // }
}

function findDeployedFileResources(state: TfState) {
    const resources: Record<string, TfState['resources'][number]> = {}
    for (const r of state.resources) {
        if (r.type !== 'synapse_resource') continue

        const attr = ('instances' in r) ? (r as any).instances[0].attributes : r.state.attributes
        if (attr.type !== 'Closure') continue

        const input = attr.input.value
        if (input.options?.isModule) {
            resources[input.source] = r
        }
    }

    return resources
}

function findDeployedFile(sourcefile: string, state: TfState) {
    const resources = findDeployedFileResources(state)

    return resources[sourcefile]?.name
}

async function resolveReplTarget(target?: string) {
    if (!target) {
        return
    }

    const x = path.relative(getWorkingDir(), target)
    const state = await readState()
    const rt = state ? findDeployedFile(x, state) : undefined
    if (!rt) {
        // TODO: it should be possible to use a file that wasn't "deployed"
        // We need to check if the target file was a deployable or not
        throw new Error(`No file found: ${x}`)
    }

    const r = await readResourceState(rt)

    return r.destination
}


// TODO: split build artifact template from deployment artifacts. This is mostly to make development faster.
// TODO: detect when mutable references that aren't cloud constructs get split across multiple files

function parseSymbolRef(ref: string) {
    const parsed = ref.match(/^(?:(?<fileName>[^#]+)#)?(?<name>[^\.\[\]]+)(?:\.(?<attribute>[^\.\[\]]+))?(?:\[(?<index>[0-9]+)\])?$/)
    if (!parsed || !parsed.groups) {
        throw new Error(`Failed to parse resource ref: ${ref}`)
    }

    const name = parsed.groups['name']!
    const fileName = parsed.groups['fileName']
    const attribute =  parsed.groups['attribute']
    const index = parsed.groups['index'] ? Number(parsed.groups['index']) : undefined 

    return { name, fileName, attribute, index }
}

function getSymbolNodeFromRef(graph: SymbolGraph, ref: string) {
    const { name, fileName, index } = parseSymbolRef(ref)
    const matched = graph.matchSymbolNodes(name, fileName)
    if (matched.length === 0) {
        throw new Error(`No resources found matching name "${name}"${fileName ? ` in file "${fileName}"` : ''}`)
    }

    if (matched.length > 1 && index === undefined) {
        throw new Error(`Ambiguous match:\n${matched.map(n => '  ' + renderSymbol(n.value, true, true)).join('\n')}`)
    }

    return matched[index ?? 0].value
}

export async function deleteResource(id: string, opt?: CombinedOptions & { dryRun?: boolean; force?: boolean }) {
    async function _deleteResource(id: string) {
        const state = await readState()
        if (!state) {
            return
        }

        const r = state.resources.findIndex(r => `${r.type}.${r.name}` === id)
        if (r === -1) {
            getLogger().log(`No resource found`)
            return
        }

        state.resources.splice(r, 1)
        await putState(state)
    }

    if (id === 'ALL_CUSTOM') {
        const state = await readState()
        if (!state) {
            return
        }

        for (const r of state.resources) {
            if (r.type === 'synapse_resource' && (r.name.endsWith('--Example')) || r.name.endsWith('--Custom')) {
                await _deleteResource(`${r.type}.${r.name}`)
            }
        }

        return 
    }

    if (opt?.force) {
        getLogger().log(`Treating target as an absolute reference`)
        await _deleteResource(id)

        return
    }

    const template = await maybeRestoreTemplate()
    if (!template) {
        getLogger().warn(`No template found. Treating target as an absolute reference.`)
        await _deleteResource(id)

        return
    }

    const graph = createSymbolGraphFromTemplate(template)
    if (graph.hasResource(id)) {
        getLogger().log(`Treating target as an absolute reference`)
        await _deleteResource(id)

        return
    }

    const s = getSymbolNodeFromRef(graph, id)

    getLogger().log(`Found symbol${opt?.dryRun ? [' [DRY RUN]:'] : ':'}`)
    getLogger().log(renderSymbol(s, true, true))
    for (const r of s.resources) {
        getLogger().log('  ' + `${r.type}.${r.name}`)
    }

    if (!opt?.dryRun) {
        getLogger().log('Deleting resource states...')
        for (const r of s.resources) {
            await _deleteResource(`${r.type}.${r.name}`)
        }    
    }
}


export async function taint(id: string, opt?: CombinedOptions & { dryRun?: boolean }) {
    async function markTainted(ids: string[]) {
        const state = await readState()
        if (!state) {
            return
        }

        for (const id of ids) {
            const r = state.resources.find(r => `${r.type}.${r.name}` === id)
            if (!r) {
                continue
            }

            if (r.state) {
                r.state.status = 'tainted'
            } else {
                (r as any).instances[0].status = 'tainted'
            }
        }

       await putState(state)
    }

    const template = await maybeRestoreTemplate()
    if (!template) {
        getLogger().warn(`No template found.`)

        return
    }

    const graph = createSymbolGraphFromTemplate(template)
    if (graph.hasResource(id)) {
        getLogger().log(`Treating target as an absolute reference`)
        await markTainted([id])

        return
    }

    const s = getSymbolNodeFromRef(graph, id)

    getLogger().log(`Found symbol${opt?.dryRun ? [' [DRY RUN]:'] : ':'}`)
    getLogger().log(renderSymbol(s, true, true))
    for (const r of s.resources) {
        getLogger().log('  ' + `${r.type}.${r.name}`)
    }

    if (!opt?.dryRun) {
        getLogger().log('Tainting...')
        await markTainted(s.resources.map(r => `${r.type}.${r.name}`))
    }
}


export async function watch(targets?: string[], opt?: CompilerOptions & { autoDeploy?: boolean }) {
    const session = await startWatch(targets, opt)

    await new Promise<void>((resolve, reject) => {
        process.on('SIGINT', async () => {
            await session.dispose()
            resolve()
        })
    })
}

export async function startWatch(targets?: string[], opt?: CompilerOptions & { autoDeploy?: boolean }) {
    const options = {
        ...opt,
        incremental: true,
    }

    const workingDirectory = getWorkingDir()
    const resolver = createModuleResolver(getFs(), workingDirectory)

    const sys: ts.System = Object.create(null, Object.getOwnPropertyDescriptors(ts.sys))
    sys.write = s => getLogger().log('[TypeScript]', s.trim())
    sys.writeOutputIsTTY = () => false
    sys.clearScreen = () => {}
    sys.getCurrentDirectory = () => workingDirectory

    // Needed to find 'lib' files
    const isSea = isSelfSea()
    const selfPath = getSelfPathOrThrow()
    sys.getExecutingFilePath = () => isSea ? selfPath : resolver.resolve('typescript', path.resolve(workingDirectory, 'fake-script.ts'))

    const config = await resolveProgramConfig(options)
    config.tsc.cmd.options.noLib = false // Forcibly set this otherwise `watch` can break if `lib` is set

    const watchHost = ts.createWatchCompilerHost(
        config.tsc.cmd.fileNames, 
        config.tsc.cmd.options,
        sys,
        ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    )

    const sourceMapHost: SourceMapHost & ts.FormatDiagnosticsHost = {
        getNewLine: () => sys.newLine,
        getCurrentDirectory: watchHost.getCurrentDirectory,
        getCanonicalFileName: (ts as any).createGetCanonicalFileName(ts.sys.useCaseSensitiveFileNames)
    }

    const tfSession = opt?.autoDeploy 
        ? await getSession(getTargetDeploymentIdOrThrow())
        : undefined

    const afs = await bfs.getArtifactFs()
    async function apply(files?: string[]) {
        if (!tfSession) {
            return
        }

        const result = await tfSession.apply({
            ...options,
            parallelism: 50,
            autoApprove: true,
            targetFiles: files,
            disableRefresh: true,
        })

        await afs.commit(result.state)

        if (result.error) {
            throw result.error
        }

        // XXX
        await afs.clearCurrentProgramStore()
    }

    let task: Promise<unknown> | undefined
    async function doTask(program: ts.EmitAndSemanticDiagnosticsBuilderProgram, affected: ts.SourceFile[]) {
        const builder = createProgramBuilder(config)
        const { infraFiles, compiledFiles, compilation } = await builder.emit(program.getProgram(), watchHost, true)
        const changedDeployables = new Set<string>()
        for (const f of infraFiles) {
            const { deps } = getAllDependencies(compilation.graph, [f])
            for (const d of deps) {
                if (compiledFiles.has(d)) {
                    changedDeployables.add(f)
                    break
                }
            }
        }
        getLogger().debug(`Changed infra files:`, [...changedDeployables])

        if (changedDeployables.size > 0 && config.csc.deployTarget) {
            const template = await builder.synth(config.csc.deployTarget)

            await writeTemplate(template)
            await commitProgram()

            await tfSession?.setTemplate(template)

            const view = tfSession ? await getDeployView(template) : undefined

            await apply([...changedDeployables].map(f => path.relative(workingDirectory, f))).finally(() => {
                view?.dispose()
            })
        } else {
            await commitProgram()

            // XXX
            await afs.clearCurrentProgramStore()
        }
    }

    const afterProgramCreate = watchHost.afterProgramCreate

    watchHost.afterProgramCreate = program => {
        if (task) {
            return
        }

        const diags = program.getSyntacticDiagnostics()
        if (diags.length > 0) {
            for (const d of diags) {
                const formatted = ts.formatDiagnostic(d, sourceMapHost)
                getLogger().error('[TypeScript]', formatted)
            }

            return
        }

        function collectAffectedFiles() {
            const files: ts.SourceFile[] = []
            const diagnostics: ts.Diagnostic[] = []

            while (true) {
                const { affected, result } = program.getSemanticDiagnosticsOfNextAffectedFile() ?? {}
                if (!affected) {
                    break
                }

                diagnostics.push(...result!)

                if ((affected as any).kind === ts.SyntaxKind.SourceFile) {
                    files.push(affected as ts.SourceFile)
                }
            }

            return { files, diagnostics }
        }
        
        // `affected` will be a superset of all changed files
        const affected = collectAffectedFiles()
        if (affected.diagnostics.length > 0) {
            for (const d of affected.diagnostics) {
                const formatted = ts.formatDiagnostic(d, sourceMapHost)
                getLogger().error('[TypeScript]', formatted)
            }

            return
        }

        task = runTask('watch', 'compile', () => doTask(program, affected.files), 100).finally(() => task = undefined)

        return afterProgramCreate?.(program)
    }

    const w = ts.createWatchProgram(watchHost)

    return {
        dispose: async () => {
            await tfSession?.dispose()
            w.close()
        }
    }
}

async function resolveConfigAndDeps(targets: string[], opt?: CombinedOptions & { skipInstall?: boolean }) {
    const config = await resolveProgramConfig(opt, targets.length > 0 ? targets : undefined)
    const incrementalHost = createIncrementalHost(config.tsc.cmd.options)

    const deps = await runTask('parse', 'deps', async () => {
        return findAllBareSpecifiers(config, await incrementalHost.getTsCompilerHost())
    }, 1)

    await runTask('', 'add implicit deps', async () => {
        if (config.pkg) {
            const hasSynapseSpecifier = !![...deps].find(spec => spec.startsWith('synapse:'))
            if (hasSynapseSpecifier) {
                const pkgDeps = (config.pkg as Mutable<typeof config.pkg>).devDependencies ??= {}
                Object.assign(pkgDeps, await addImplicitPackages(pkgDeps, config.csc as any))
            }

            const hasNodeSpecifier = !![...deps].find(spec => spec.startsWith('node:'))
            if (hasNodeSpecifier) {
                const pkgDeps = (config.pkg as Mutable<typeof config.pkg>).devDependencies ??= {}
                if (!pkgDeps['@types/node']) {
                    // XXX: hard-coded
                    Object.assign(pkgDeps, { '@types/node': '^20.14.2' })
                }
            }
    
            // We persist the target if there are no other sources
            // This is mainly a convenience feature
            if (opt?.deployTarget && !config.pkg.synapse?.config?.target) {
                const mutable = config.pkg as Mutable<typeof config.pkg>
                const synapse: Mutable<NonNullable<typeof mutable.synapse>> = mutable.synapse ??= {}
                const synapseConfig = synapse.config ??= {}
                synapseConfig.target = opt.deployTarget
            }

            await setCompiledPkgJson(config.pkg)
        }
    }, 1)

    if (!opt?.skipInstall && config.pkg) {
        const view = createInstallView()
        const pkg: ResolvedPackage = { data: config.pkg, directory: getWorkingDir() }
        await runTask('package', 'init', () => maybeDownloadPackages(pkg, !!config.csc.noInfra), 1).catch(async e => {
            await resetCompiledPkgJson()
            throw e
        }).finally(() => {
            view.dispose()
        })
    } else {
        getLogger().log('Skipping auto-install')
    }

    return { config, deps, incrementalHost }
}

type CompileOptions = CombinedOptions & {
    skipSynth?: boolean
    skipInstall?: boolean
    skipSummary?: boolean
    hideLogs?: boolean
    forcedInfra?: string[]
    beforeSynthCommit?: () => Promise<void> | void
}

export async function compile(targets: string[], opt?: CompileOptions) {
    const view = createCompileView(opt)

    const { config, incrementalHost } = await resolveConfigAndDeps(targets, opt)
    const builder = createProgramBuilder(config, incrementalHost)
    const { entrypointsFile } = await runTask('compile', 'all', () => builder.emit(), 100)

    const deployTarget = config.csc.deployTarget
    const needsSynth = deployTarget && entrypointsFile.entrypoints.length > 0
    const shouldSkipSynth = config.csc.sharedLib || opt?.skipSynth || config.csc.noSynth || config.csc.noInfra
    if (needsSynth && !shouldSkipSynth) {
        // Fetch any existing state in the background so we can enhance the output messages
        const previousData = !opt?.skipSummary ? getPreviousDeploymentData() : undefined

        const template = await runTask('infra', 'synth', () => builder.synth(deployTarget, entrypointsFile), 10)
        const ext = (template as Mutable<TfJson>)['//'] ??= {}
        ext.deployTarget = deployTarget // Used to track what target was used in the last deployment

        await writeTemplate(template)
        await opt?.beforeSynthCommit?.()
        await commitProgram()

        if (!opt?.skipSummary) {
            view.showSimplePlanSummary(template, deployTarget, targets, await previousData)
        } else {
            view.done()
        }
    } else {
        if (needsSynth && opt?.skipSynth) {
            await getProgramFs().writeJson('[#compile]__buildState__.json', {
                needsSynth: true,
            })
        }
        await commitProgram()
        view.done()
    }
}


export async function emitBfs(target?: string, opt?: CombinedOptions & { isEmit?: boolean; block?: boolean; outDir?: string; debug?: boolean }) {
    if (opt?.isEmit) {
        const bt = getBuildTargetOrThrow()
        const config = (await getResolvedTsConfig())?.options
        const outDir = path.resolve(bt.workingDirectory, opt.outDir ?? config?.outDir ?? 'out')
        const normalizedTsOutDir = config?.outDir 
            ? path.posix.relative(bt.workingDirectory, path.posix.resolve(bt.workingDirectory, config.outDir)) 
            : undefined

        const dest = await emitPackageDist(outDir, bt, normalizedTsOutDir, config?.declaration)

        const executables = await getExecutables()
        if (executables) {
            for (const [k, v] of Object.entries(executables)) {
                const rel = path.relative(bt.workingDirectory, v)
                const outfile = normalizedTsOutDir 
                    ? path.resolve(outDir, path.posix.relative(normalizedTsOutDir, rel))
                    : path.resolve(outDir, rel)

                // TODO: this can leave inaccurate source maps if we don't generate source maps here

                await bundleExecutable(bt, v, outfile, bt.workingDirectory, { useOptimizer: (opt as any)?.['no-optimize'] ? false : true })
            }
        }

        printLine(colorize('green', `Wrote to ${dest}`))

        return
    }

    if (opt?.block) {
        const repo = getDataRepository()
        const head = await repo.getHead(getTargetDeploymentIdOrThrow())
        const hash = head?.storeHash
        if (!hash) {
            throw new Error(`No process found`)
        }

        const bfs = await repo.getBuildFs(hash)
        const objects = await repo.serializeBuildFs(bfs)
        await getFs().writeFile(path.resolve('dist', hash), createBlock(Object.entries(objects)))

        const pHash = await getPreviousDeploymentProgramHash()
        if (pHash) {
            const bfs = await repo.getBuildFs(pHash)
            const objects = await repo.serializeBuildFs(bfs)
            await getFs().writeFile(path.resolve('dist', pHash), createBlock(Object.entries(objects)))
        }

        return
    }

    // XXX: assumes it's a hash
    if (target && path.basename(target).length === 64) {
        const data = await getFs().readFile(target)
        const block = openBlock(Buffer.from(data))
        const index = JSON.parse(block.readObject(path.basename(target)).toString('utf-8'))

        const dest = path.resolve('.vfs-dump')
        for (const [k, v] of Object.entries(index.files)) {
            await getFs().writeFile(path.resolve(dest, k), block.readObject((v as any).hash))
        }

        return
    }

    if (target === 'package') {
        await dumpPackage(path.resolve('.vfs-dump'))
    } else {
        await bfs.dumpFs(target || undefined)
    }
}

export async function inspectBuildTarget(target?: string, opt?: CombinedOptions) {
    printJson(getBuildTargetOrThrow())
}

export async function dumpArtifacts(target: string, opt?: CombinedOptions) {
    const programFs = getProgramFs()
    const manifest = await readPointersFile(programFs)
    if (!manifest) {
        return
    }


    const artifacts = await Promise.all(Object.values(manifest).map(v => Object.values(v)).flat().map(async a => {
        const data = Buffer.from(await programFs.readFile(a)).toString('utf-8')

        return {
            name: a,
            data: JSON.parse(data) as CompiledChunk
        }
    }))
    
    const result = artifacts.map(showArtifact).join('\n')
    await getFs().writeFile(target, result)
}

async function emitBlock(id: string, dest: string) {
    const repo = getDataRepository()
    const head = await repo.getHead(id)
    if (!head) {
        throw new Error(`No build fs found: ${id}`)
    }

    const index = await repo.getBuildFs(head.storeHash)
    const data = await repo.serializeBuildFs(index)
    const block = createBlock(Object.entries(data))
    await getFs().writeFile(path.resolve(dest, head.storeHash), block)

    return head.storeHash
}

export async function emitBlocks(dest: string) {
    const bt = getBuildTargetOrThrow()
    const destDir = path.resolve(getWorkingDir(), dest)
    const deploymentId = bt.deploymentId
    const ids = {
        program: await emitBlock(bt.programId, destDir),
        process: deploymentId ? await emitBlock(deploymentId, destDir) : undefined,
    }

    await getFs().writeFile(
        path.resolve(destDir, 'ids.json'), 
        JSON.stringify(ids, undefined, 4)
    )
}

export async function showRemoteArtifact(target: string, opt?: { captured?: boolean; deployed?: boolean; infra?: boolean }) {
    const repo = getDataRepository()

    if (target.includes(':')) {
        const m = await getMetadata(repo, target)
        printJson(m)

        return
    }

    const hash = await findArtifactByPrefix(repo, target)
    if (!hash) {
        //const p = await findParents(target)
        //getLogger().log(p)
        throw new Error(`No artifact found: ${target}`)
    }

    if (!(await repo.hasData(hash))) {
        printLine(`Missing data ${hash}`)

        //const p = await findParents(hash)
        //getLogger().log(p)
        return
    }

    const contents = await repo.readData(hash)
    const text = Buffer.from(contents).toString('utf-8')
    try {
        const parsed = JSON.parse(text)
        if (opt?.captured) {
            const capturedArray = parsed['@@__moveable__']['captured']
            printJson(capturedArray)

            // const t = params.match(/captured:(.*)/)?.[1]
            // if (t) {
            //     printJson(capturedArray[Number(t)]['@@__moveable__'])
            // } else {
            //     printJson(capturedArray)
            // }
        } else if (opt?.deployed || parsed.kind === 'deployed') {
            printLine(Buffer.from(parsed.rendered, 'base64').toString('utf-8'))

            // if (params.includes('imports')) {
            //     showManifest(parsed.packageDependencies)
            // } else {
            //     printLine(Buffer.from(parsed.rendered, 'base64').toString('utf-8'))
            // }
        } else if (opt?.infra) {
            printLine(Buffer.from(parsed.infra, 'base64').toString('utf-8'))
        } else if (parsed.kind === 'compiled-chunk') {
            printLine(Buffer.from(parsed.runtime, 'base64').toString('utf-8'))
        } else {
            printLine(JSON.stringify(parsed, undefined, 4))
        }
    } catch {
        printLine(text)
    }
}

export async function loadState(target: string, opt?: CombinedOptions) {
    const state = JSON.parse(await getFs().readFile(path.resolve(getWorkingDir(), target), 'utf-8'))
    await putState(state)
}

export async function dumpState(target?: string, opt?: CombinedOptions) {
    const deploymentId = target ?? getTargetDeploymentIdOrThrow()
    const state = await readState(getDeploymentFs(deploymentId))
    await getFs().writeFile(
        path.resolve(getWorkingDir(), 'dist', 'states', `${deploymentId}.json`), 
        JSON.stringify(state, undefined, 4)
    )
}

// FIXME: exclude invalid move sets (e.g. cycles)
// TODO: add way to add overrides (this command is unlikely to cover every scenario)
// TODO: selectively include files
export async function migrateIdentifiers(targets: string[], opt?: CombinedOptions & { dryRun?: boolean; reset?: boolean }) {
    const deploymentId = getBuildTargetOrThrow().deploymentId
    const state = deploymentId ? await readState() : undefined
    if (!deploymentId || !state || state.resources.length === 0) {
        printLine(colorize('brightRed', 'No deployment to migrate'))
        return
    }

    const targetFiles = targets.length > 0 ? new Set(targets) : undefined

    // TODO: automatically compile if stale

    const session = await getSession(deploymentId)

    const afs = await bfs.getArtifactFs()
    const oldTemplate = await afs.maybeRestoreTemplate()

    const oldSourceMap = oldTemplate?.['//']?.sourceMap // FIXME: make this a required field
    if (!oldSourceMap) {
        throw new Error(`No existing source map found`)
    }

    const templateService = session.templateService
    const template = await templateService.getTemplate()
    const newSourceMap = template['//']?.sourceMap
    if (!newSourceMap) {
        throw new Error(`No new source map found`)
    }

    const newResources: Record<string, any> = {}
    for (const [k, v] of Object.entries(template.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            if (targetFiles) {
                const parsed = parseModuleName((v2 as any).module_name)
                if (!targetFiles.has(parsed.fileName)) continue
            }
            const id = `${k}.${k2}`
            newResources[id] = v2
        }
    }

    normalizeConfigs(template)

    // XXX: need to load the state manually
    await session.getState()

    const newDeps: Record<string, Set<string>> = {}
    const newRefs = await session.getRefs(Object.keys(newResources))
    for (const [k, v] of Object.entries(newRefs)) {
        newDeps[k] = new Set(v.filter(x => !x.subject.startsWith('local.') && !x.subject.startsWith('data.')).map(x => x.subject))
    } 

    await session.setTemplate(oldTemplate)

    const oldResources: Record<string, any> = {}
    for (const [k, v] of Object.entries(oldTemplate.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            if (targetFiles) {
                const parsed = parseModuleName((v2 as any).module_name)
                if (!targetFiles.has(parsed.fileName)) continue
            }
            oldResources[`${k}.${k2}`] = v2
        }
    }

    normalizeConfigs(oldTemplate)

    const oldDeps: Record<string, Set<string>> = {}
    const oldRefs = await session.getRefs(Object.keys(oldResources))
    for (const [k, v] of Object.entries(oldRefs)) {
        oldDeps[k] = new Set(v.filter(x => !x.subject.startsWith('local.') && !x.subject.startsWith('data.')).map(x => x.subject))
    }


    if (targetFiles) {
        const newKeys = Object.keys(newResources)
        const oldKeys = Object.keys(oldResources)
        for (const k of Object.keys(newSourceMap.resources)) {
            if (!newKeys.includes(k)) {
                delete newSourceMap.resources[k]
            }
        }
        for (const k of Object.keys(oldSourceMap.resources)) {
            if (!oldKeys.includes(k)) {
                delete oldSourceMap.resources[k]
            }
        }
    }


    // TODO: we _need_ to cross-reference the template with the actual state before proceeding
    // TODO: check existing moves

    const moves = runTask('', 'Tree Edits', () => detectRefactors(newResources, newSourceMap, oldResources, oldSourceMap, newDeps, oldDeps), 100)
    if (moves.length === 0) {
        printLine(colorize('green', 'No resources need to be moved'))

        return
    }

    function printMove(move: (typeof moves)[number]) {
        const { fromSymbol, toSymbol } = move
        const sameFile = fromSymbol.fileName === toSymbol.fileName

        return `${renderSymbol(fromSymbol, !sameFile)} --> ${renderSymbol(toSymbol)}`
    }

    function printDedupedMoves(arr: typeof moves) {
        const s = new Set<string>()
        for (const m of arr) {
            s.add(printMove(m))
        }

        return [...s]
    }

    if (opt?.dryRun) {
        for (const m of printDedupedMoves(moves)) {
            printLine(`Will move (dry-run): ${m}`)
        }

        return
    }

    // XXX: remove the symbol info
    const prunedMoves = moves.map(m => ({ from: m.from, to: m.to }))
    await saveMoved(prunedMoves)

    for (const m of printDedupedMoves(moves)) {
        printLine(`Will move: ${m}`)
    }
}

async function loadMovedIntoTemplate(fileName: string, template?: TfJson) {
    const moved = await getFs().readFile(fileName, 'utf-8').then(JSON.parse)
    if (typeof moved !== 'object' || !moved) {
        throw new Error(`Moved file must contain an object`)
    }

    const checked: { from: string; to: string }[] = []
    for (const [k, v] of Object.entries(moved)) {
        if (typeof v !== 'string') {
            throw new Error(`"from" is not a string: ${JSON.stringify(v)} [key: ${k}]`)
        }

        // TODO: validate that `k` is in the current state and `v` is in the current template

        checked.push({
            from: k,
            to: v,
        })
    }

    await saveMoved(checked, template)

    for (const m of checked) {
        printLine(`Will move: ${m.from} -> ${m.to}`)
    }
}

export async function loadMoved(fileName: string) {
    await loadMovedIntoTemplate(fileName)
}

export async function machineLogin(type?: string, opt?: CombinedOptions) {
    const auth = getAuth()
    await auth.machineLogin()
}

export async function getIdentity(type?: string, opt?: CombinedOptions) {
    const auth = getAuth()
    const acc = await auth.getActiveAccount()
    if (!acc) {
        throw new Error(`Not logged in`)
    }
}

export async function login(target?: string, opt?: CombinedOptions) {
    const auth = getAuth()
    const acc = await auth.login(target)
}

export async function setSessionDuration(target: string, opt?: CombinedOptions) {
    const auth = getAuth()
    const acc = await auth.getActiveAccount()
    if (!acc) {
        throw new Error(`Not logged in`)
    }

    const sessionDuration = Number(target)
    if (isNaN(sessionDuration) || sessionDuration <= 0 || (Math.floor(sessionDuration) !== sessionDuration) || sessionDuration > 7200) {
        throw new Error(`Invalid session duration. Must be a non-zero integer between 0 and 7200.`)
    }

    await auth.updateAccountConfig(acc, { sessionDuration })
}

export async function listDeployments(type?: string, opt?: CombinedOptions) {
    const rootDir = workspaces.getRootDir()
    const deployments = await workspaces.listAllDeployments()
    for (const [k, v] of Object.entries(deployments)) {
        const s = await readState(getDeploymentFs(k, v.programId, v.projectId))

        const isRunning = s && s.resources.length > 0
        const rel = path.relative(rootDir, v.workingDirectory)
        const info = `(${rel || '.'}) [${isRunning ? 'RUNNING' : 'STOPPED'}]`
        printLine(`${k} ${info}`)
    }
}

export async function testGcDaemon(type?: string, opt?: CombinedOptions) {
    await using trigger = maybeCreateGcTrigger(true)
}

export async function schemas(type?: string, opt?: CombinedOptions) {
    if (type === 'stripe') {
        const text = await generateStripeWebhooks()
        await getFs().writeFile('webhooks.ts', text)
    } else {
        const text = await generateOpenApiV3()
        await getFs().writeFile('openapiv3.ts', text)
    }
}


// This inits a new package w/ scaffolding
// `initWorkspace` initializes a non-empty directory
// TODO: we should clone from GitHub
export async function init(opt?: { template?: 'hello-world' | 'react' }) {
    const fs = getFs()
    const dir = process.cwd()
    const dirFiles = (await fs.readDirectory(dir)).filter(f => f.name !== '.git')
    if (dirFiles.length !== 0) {
        throw new Error(`${dir} is not empty! Move to an empty directory and try again.`)
    }

    async function showInstructions(filesCreated: string[]) {
        async function detectAwsCredentials() {
            if (await getFs().fileExists(path.resolve(homedir(), '.aws'))) {
                return true
            }
    
            return (
                process.env['AWS_CONFIG_FILE'] ||
                process.env['AWS_PROFILE'] || 
                process.env['AWS_ACCESS_KEY_ID'] ||
                process.env['AWS_ROLE_ARN']
            )
        }
    
        const probablyHasAwsCredentials = await detectAwsCredentials()
    
        printLine(colorize('green', `Created files:`))
        for (const f of filesCreated) {
            printLine(colorize('green', `  ${f}`))
        }
        if (await getFs().fileExists(path.resolve(dir, 'node_modules'))) {
            printLine(colorize('gray', '"node_modules" was created for better editor support'))
        }
        printLine()
    
        const deployCmd = renderCmdSuggestion('deploy')
        const targetOption = colorize('gray', '--target aws')
    
        printLine(`You can now use ${deployCmd} to compile & deploy your code!`)
        printLine()
        printLine(`By default, your code is built for and deployed to a "local" target.`)
    
        if (probablyHasAwsCredentials) {
            printLine(`You can target AWS by adding ${targetOption} to a compile or deploy command.`)
            printLine(`The target is remembered for subsequent commands.`)
        } else {
            const docsLink = colorize('gray', '<placeholder>')
            printLine(`Deploying to other targets requires credentials specific to the target.`)
            printLine(`For more information, see: ${docsLink}`)
        }
    }

    if (opt?.template === 'react') {
        const tsconfig = {
            "include": ["app.tsx"],
            "compilerOptions": {
                "target": "ES2022",
                "jsx": "react-jsx",
                "module": "NodeNext",
                "moduleResolution": "NodeNext"
            },
        }

        await getFs().writeFile(path.resolve(dir, 'tsconfig.json'), JSON.stringify(tsconfig, undefined, 4))
        const pkg = { "synapse": { "dependencies": { "@cohesible/synapse-react": "#synapse-react" } } }
        await getFs().writeFile(path.resolve(dir, 'package.json'), JSON.stringify(pkg, undefined, 4))
        const text = 'aW1wb3J0IHsgU3VzcGVuc2UsIHVzZVJlZiB9IGZyb20gJ3JlYWN0JwppbXBvcnQgeyBCdWNrZXQgfSBmcm9tICdzeW5hcHNlOnNybC9zdG9yYWdlJwppbXBvcnQgeyBjcmVhdGVXZWJzaXRlIH0gZnJvbSAnQGNvaGVzaWJsZS9zeW5hcHNlLXJlYWN0JwppbXBvcnQgeyB1c2VTZXJ2ZXIsIG9wZW5Ccm93c2VyIH0gZnJvbSAnQGNvaGVzaWJsZS9zeW5hcHNlLXdlYnNpdGVzJwoKY29uc3Qgd2Vic2l0ZSA9IGNyZWF0ZVdlYnNpdGUoKQpjb25zdCBidWNrZXQgPSBuZXcgQnVja2V0KCkKCmNvbnN0IGdldERhdGEgPSAoa2V5OiBzdHJpbmcpID0+IHsKICAgIHJldHVybiBidWNrZXQuZ2V0KGtleSwgJ3V0Zi04JykuY2F0Y2goZSA9PiB7CiAgICAgICAgcmV0dXJuIChlIGFzIGFueSkubWVzc2FnZQogICAgfSkKfQoKZnVuY3Rpb24gQnVja2V0Q29udGVudHMocHJvcHM6IHsgYnVja2V0S2V5OiBzdHJpbmcgfSkgewogICAgY29uc3QgZGF0YSA9IHVzZVNlcnZlcihnZXREYXRhLCBwcm9wcy5idWNrZXRLZXkpCgogICAgcmV0dXJuIDxwcmU+e2RhdGF9PC9wcmU+Cn0KCmZ1bmN0aW9uIEJ1Y2tldFBhZ2UocHJvcHM6IHsgYnVja2V0S2V5OiBzdHJpbmcgfSkgewogICAgcmV0dXJuICgKICAgICAgICA8ZGl2PgogICAgICAgICAgICA8U3VzcGVuc2UgZmFsbGJhY2s9ezxkaXY+bG9hZGluZzwvZGl2Pn0+CiAgICAgICAgICAgICAgICA8QnVja2V0Q29udGVudHMgYnVja2V0S2V5PXtwcm9wcy5idWNrZXRLZXl9Lz4KICAgICAgICAgICAgPC9TdXNwZW5zZT4KICAgICAgICA8L2Rpdj4KICAgICkKfQoKZnVuY3Rpb24gUm9vdExheW91dCh7IGNoaWxkcmVuIH06IHsgY2hpbGRyZW46IEpTWC5FbGVtZW50IHwgSlNYLkVsZW1lbnRbXSB9KSB7CiAgICByZXR1cm4gKAogICAgICAgIDxodG1sIGxhbmc9ImVuIj4KICAgICAgICAgICAgPGhlYWQ+PC9oZWFkPgogICAgICAgICAgICA8Ym9keT57Y2hpbGRyZW59PC9ib2R5PgogICAgICAgIDwvaHRtbD4KICAgICkKfQoKY29uc3QgYWRkRGF0YSA9IHdlYnNpdGUuYmluZChhc3luYyAoa2V5OiBzdHJpbmcsIGRhdGE6IHN0cmluZykgPT4gewogICAgYXdhaXQgYnVja2V0LnB1dChrZXksIGRhdGEpCn0pCgpmdW5jdGlvbiBCdWNrZXRGb3JtVGhpbmcoKSB7CiAgICBjb25zdCBrZXlSZWYgPSB1c2VSZWY8SFRNTElucHV0RWxlbWVudD4oKQogICAgY29uc3QgdmFsdWVSZWYgPSB1c2VSZWY8SFRNTElucHV0RWxlbWVudD4oKQoKICAgIGZ1bmN0aW9uIHN1Ym1pdCgpIHsKICAgICAgICBjb25zdCBrZXkgPSBrZXlSZWYuY3VycmVudC52YWx1ZQogICAgICAgIGNvbnN0IHZhbHVlID0gdmFsdWVSZWYuY3VycmVudC52YWx1ZQoKICAgICAgICBhZGREYXRhKGtleSwgdmFsdWUpLnRoZW4oKCkgPT4gewogICAgICAgICAgICB3aW5kb3cubG9jYXRpb24gPSB3aW5kb3cubG9jYXRpb24KICAgICAgICB9KQogICAgfQoKICAgIHJldHVybiAoCiAgICAgICAgPGRpdj4KICAgICAgICAgICAgPGxhYmVsPgogICAgICAgICAgICAgICAgS2V5CiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0ndGV4dCcgcmVmPXtrZXlSZWZ9PjwvaW5wdXQ+CiAgICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICAgIDxsYWJlbD4KICAgICAgICAgICAgICAgIFZhbHVlCiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT0ndGV4dCcgcmVmPXt2YWx1ZVJlZn0+PC9pbnB1dD4KICAgICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXtzdWJtaXR9IHN0eWxlPXt7IG1hcmdpbkxlZnQ6ICcxMHB4JyB9fT5BZGQgSXRlbTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgKQp9Cgphc3luYyBmdW5jdGlvbiBnZXRJdGVtcygpIHsKICAgIHJldHVybiBhd2FpdCBidWNrZXQubGlzdCgpCn0KCmNvbnN0IGRvRGVsZXRlID0gd2Vic2l0ZS5iaW5kKChrZXk6IHN0cmluZykgPT4gYnVja2V0LmRlbGV0ZShrZXkpKQoKZnVuY3Rpb24gQnVja2V0SXRlbShwcm9wczogeyBidWNrZXRLZXk6IHN0cmluZyB9KSB7CiAgICBjb25zdCBrID0gcHJvcHMuYnVja2V0S2V5CgogICAgZnVuY3Rpb24gZGVsZXRlSXRlbSgpIHsKICAgICAgICBkb0RlbGV0ZShrKS50aGVuKCgpID0+IHsKICAgICAgICAgICAgd2luZG93LmxvY2F0aW9uID0gd2luZG93LmxvY2F0aW9uCiAgICAgICAgfSkKICAgIH0KCiAgICByZXR1cm4gKAogICAgICAgIDxsaT4KICAgICAgICAgICAgPGRpdiBzdHlsZT17eyBkaXNwbGF5OiAnZmxleCcsIG1heFdpZHRoOiAnMjUwcHgnLCBtYXJnaW5Cb3R0b206ICcxMHB4JyB9fT4KICAgICAgICAgICAgICAgIDxhIGhyZWY9e2AvYnVja2V0LyR7a31gfSBzdHlsZT17eyBmbGV4OiAnZml0LWNvbnRlbnQnLCBhbGlnblNlbGY6ICdmbGV4LXN0YXJ0JyB9fT57a308L2E+CiAgICAgICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9e2RlbGV0ZUl0ZW19IHN0eWxlPXt7IGFsaWduU2VsZjogJ2ZsZXgtZW5kJyB9fT5EZWxldGU8L2J1dHRvbj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9saT4KICAgICkKfQoKZnVuY3Rpb24gSXRlbUxpc3QoKSB7CiAgICBjb25zdCBpdGVtcyA9IHVzZVNlcnZlcihnZXRJdGVtcykKCiAgICBpZiAoaXRlbXMubGVuZ3RoID09PSAwKSB7CiAgICAgICAgcmV0dXJuIDxkaXY+PGI+VGhlcmUncyBub3RoaW5nIGluIHRoZSBidWNrZXQhPC9iPjwvZGl2PgogICAgfQoKICAgIHJldHVybiAoCiAgICAgICAgPHVsPgogICAgICAgICAgICB7aXRlbXMubWFwKGsgPT4gPEJ1Y2tldEl0ZW0ga2V5PXtrfSBidWNrZXRLZXk9e2t9Lz4pfQogICAgICAgIDwvdWw+CiAgICApCn0KCmZ1bmN0aW9uIEhvbWVQYWdlKCkgewogICAgcmV0dXJuICgKICAgICAgICA8ZGl2PgogICAgICAgICAgICA8QnVja2V0Rm9ybVRoaW5nPjwvQnVja2V0Rm9ybVRoaW5nPgogICAgICAgICAgICA8YnI+PC9icj4KICAgICAgICAgICAgPFN1c3BlbnNlIGZhbGxiYWNrPSdsb2FkaW5nJz4KICAgICAgICAgICAgICAgIDxJdGVtTGlzdC8+CiAgICAgICAgICAgIDwvU3VzcGVuc2U+CiAgICAgICAgPC9kaXY+CiAgICApCn0KCndlYnNpdGUuYWRkUGFnZSgnLycsIHsKICAgIGNvbXBvbmVudDogSG9tZVBhZ2UsCiAgICBsYXlvdXQ6IHsgY29tcG9uZW50OiBSb290TGF5b3V0IH0sCn0pCiAgICAKCndlYnNpdGUuYWRkUGFnZSgnL2J1Y2tldC97YnVja2V0S2V5fScsIHsKICAgIGNvbXBvbmVudDogQnVja2V0UGFnZSwKICAgIGxheW91dDogeyBjb21wb25lbnQ6IFJvb3RMYXlvdXQgfSwKfSkKCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKCkgewogICAgb3BlbkJyb3dzZXIod2Vic2l0ZS51cmwpCn0KCg=='
        await getFs().writeFile(path.resolve(dir, 'app.tsx'), Buffer.from(text, 'base64'))
        await showInstructions(['app.tsx', 'package.json', 'tsconfig.json'])
    
        return
    }

    const text = `
import { Function } from 'synapse:srl/compute'

const hello = new Function(() => {
    return { message: 'hello, world!' }
})

export async function main(...args: string[]) {
    console.log(await hello())
}
`.trimStart()

    await fs.writeFile(path.resolve(dir, 'hello.ts'), text, { flag: 'wx' })

    await showInstructions(['hello.ts'])
}

export async function clearCache(targetKey?: string, opt?: CombinedOptions) {
    if (!targetKey) {
        return clearIncrementalCache()
    }

    const programFs = getProgramFs()
    await programFs.clear(targetKey)
}

export async function listCommitsCmd(mod: string, opt?: CombinedOptions & { useProgram?: boolean }) {
    const timestampWidth = new Date().toISOString().length
    const hashWidth = 12
    const commits = await listCommits(opt?.useProgram ? getBuildTargetOrThrow().programId : undefined)
    if (commits.length === 0) {
        printLine(colorize('brightRed', 'No commits found'))
        return
    }

    if (!opt?.useProgram) {
        printLine(`${'Timestamp'.padEnd(timestampWidth, ' ')} ${'Process'.padEnd(hashWidth, ' ')} ${'Program'.padEnd(hashWidth, ' ')} ${'IsTest?'}`)
        for (const c of commits) {
            printLine(c.timestamp, c.storeHash.slice(0, hashWidth), c.programHash?.slice(0, hashWidth), !!c.isTest)
        }
    } else {
        printLine(`${'Timestamp'.padEnd(timestampWidth, ' ')} ${'Program'.padEnd(hashWidth, ' ')}`)
        for (const c of commits) {
            printLine(c.timestamp, c.storeHash.slice(0, hashWidth))
        } 
    }
}

export async function rollback(mod: string, opt?: CombinedOptions) {
    printLine(colorize('yellow', 'Rolling back...'))

    const syncAfter = opt?.syncAfter ?? !!getCiType() // XXX: for internal use only 

    const commits = await listCommits()
    const targetCommit = commits.filter(x => !x.isTest)[1]
    if (!targetCommit) {
        throw new Error('Nothing to rollback to')
    }

    if (!targetCommit.programHash) {
        throw new Error(`No program to restore from`)
    }

    printLine(`Using previous program hash: ${targetCommit.programHash}`)
    const sessionCtx = await createSessionContext(targetCommit.programHash)

    await deploy([], { ...opt, syncAfter, sessionCtx, hideNextSteps: true, rollbackIfFailed: false })
}

export async function printTypes(target?: string, opt?: CombinedOptions) {
    const config = await resolveProgramConfig(opt)
    const builder = createProgramBuilder(config)
    await builder.printTypes(target)
}

export async function processProf(t?: string, opt?: CombinedOptions) {
    const buildTarget = getBuildTargetOrThrow()
    const afs = await bfs.getArtifactFs()
    const programStore = await afs.getCurrentProgramStore().getRoot()
    const fs = toFs(buildTarget.workingDirectory, programStore.root, getFs())

    const target = t ?? await (async function () {
        const files = await glob(getFs(), getWorkingDir(), ['*.cpuprofile'])
        if (files.length === 0) {
            throw new Error(`No ".cpuprofile" files found in current directory`)
        }
        if (files.length > 1) {
            throw new Error(`Ambiguous match: ${files.join(', ')}`)
        }
        return files[0]
    })()

    const r = await loadCpuProfile(fs, target, buildTarget.workingDirectory, await getProjectOverridesMapping(getFs()))
    getLogger().log(r)
}

async function runProgramExecutable(fileName: string, args: string[]) {
    const moduleLoader = await runTask('init', 'loader', () => getModuleLoader(), 1) // 8ms on simple hello world no infra
    const m = await moduleLoader.loadModule(fileName)    
    if (typeof m.main !== 'function') {
        throw new Error(`Missing main function in file "${fileName}", found exports: ${Object.keys(m)}`)
    }
   
    try {
        const exitCode = await m.main(...args)
        if (typeof exitCode === 'number') {
            process.exitCode = exitCode
        }
    } catch (e) {
        process.exitCode = 1
        printLine(ui.format(e))
    }
}

async function compileIfNeeded(target?: string, skipSynth = true) {
    // XXX: we should normalize everything at program entrypoints
    if (isWindows() && target) {
        target = target.replaceAll('/', '\\')
    }

    // TODO: we can skip synth if the stale files aren't apart of the synthesis dependency graph
    // TODO: if `run` automatically compiles anything, it should _always_ use the last-used settings
    const { stale, sources } = await getStaleSources() ?? {}
    if (!sources || (stale && stale.size > 0) || (target && !sources[target])) {
        // We don't need to generate a template, we just want updated program analyses
        // TODO: mark the current compilation as "needs synth"
        await compile(
            target ? [target] : [],
            { incremental: true, skipSummary: true, skipSynth: !!stale && skipSynth },
        )
    }
}

async function getDeploymentStatus(target: string, deployables: Record<string, string>) {
    const incr = createIncrementalHost({})

    const [deps, info, sources] = await Promise.all([
        incr.getCachedDependencies(path.resolve(getWorkingDir(), target)),
        getPreviousDeployInfo(),
        readSources(),
    ])

    const allDeps = getAllDependencies(deps, [path.resolve(getWorkingDir(), target)])
    const resolvedSource = path.resolve(getWorkingDir(), target)
    const deployableSet = new Set(Object.keys(deployables).map(k => path.resolve(getWorkingDir(), k)))

    // BUG: synthesis removes unused imports, but we don't check that here
    const isTargetDeployable = deployableSet.has(resolvedSource)
    const toCheck = isTargetDeployable ? [resolvedSource] : allDeps.deps
    const needsDeploy: string[] = []
    const staleDeploys: string[] = []
    for (const d of toCheck) {
        if (!deployableSet.has(d)) continue

        const relPath = path.relative(getWorkingDir(), d)
        const resourceName = info?.state ? findDeployedFile(relPath, info.state) : undefined

        if (!resourceName) {
            needsDeploy.push(relPath)
            continue
        } 

        // TODO: improve staleness check by only looking at captured symbols
        const currentHash = sources?.[relPath].hash
        if (currentHash && currentHash !== info?.deploySources?.[relPath].hash) {
            staleDeploys.push(relPath)
        }
    }

    return {
        isTargetDeployable,
        needsDeploy,
        staleDeploys,
        sources,
    }
}

async function validateTargetsForExecution(targets: string, deployables: Record<string, string>) {
    const status = await getDeploymentStatus(targets, deployables)

    if (status.needsDeploy.length > 0) {
        // TODO: automatically deploy for "local" (or if the user opts-in for other targets)
        throw new RenderableError(`Program not deployed`, () => {
            function printSuggestion() {
                printLine()

                const deployCmd = renderCmdSuggestion('deploy', status.needsDeploy)
                printLine(`Run ${deployCmd} first and try again.`)
                printLine()
            }

            if (status.needsDeploy.length === 1 && status.needsDeploy[0] === targets) {
                printLine(colorize('brightRed', 'Resources in the target file need to be deployed'))
                printSuggestion()
                return
            }

            // Implies length >= 2
            if (status.needsDeploy.includes(targets)) {
                printLine(colorize('brightRed', 'The target file and its dependencies have not been deployed'))
            } else {
                if (status.needsDeploy.length === 1) {
                    printLine(colorize('brightRed', 'Dependency has not been deployed'))
                    printSuggestion()
                    return
                }

                printLine(colorize('brightRed', 'Dependencies have not been deployed'))
            }

            printLine('Needs deployment:')
            for (const f of status.needsDeploy) {
                printLine(`    ${f}`)
            }

            printSuggestion()
        })
    }

    // If the target file isn't a deployable AND its deps are stale, we will fail
    if (status.staleDeploys.length > 0) {
        // This is too strict and somewhat incorrect. 
        // We should fail when a non-deployable file depends on a stale deployable in general.
        if (!status.isTargetDeployable) {
            throw new RenderableError(`Program not deployed`, () => {
                printLine(colorize('brightRed', 'The target\'s dependencies have not been deployed'))
            })
        }
        printLine(colorize('brightYellow', 'Deployment has not been updated with the latest changes'))
    }

    return status
}

export async function run(name: string | undefined, args: string[], opt?: CombinedOptions & { skipValidation?: boolean; skipCompile?: boolean }) {
    const maybeCmd = name ? await maybeGetPkgScript(name) : undefined
    if (maybeCmd) {
        getLogger().log(`Running package script: ${name}`)

        const runCommand = createNpmLikeCommandRunner(maybeCmd.pkg.directory, undefined, 'inherit')
        await runCommand(maybeCmd.cmd, args)

        return
    }

    if (!opt?.skipCompile) {
        await compileIfNeeded()
    }

    const programFs = opt?.skipCompile 
        ? await getPreviousDeploymentProgramFs() 
        : undefined

    // Must be loaded after compilation
    const files = await getEntrypointsFile(programFs)

    const executables = files?.executables
    if (!executables || Object.keys(executables).length === 0) {
        throw new Error(`No executables found`)
    }

    const deployables = files.deployables ?? {}

    const [source, output] = !name ? Object.entries(executables)[0] : Object.entries(executables).find(([k, v]) => k === name)!

    if (!opt?.skipValidation) {
        const status = await validateTargetsForExecution(source, deployables)

        const resolved = status.isTargetDeployable
            ? await resolveReplTarget(source)
            : path.resolve(getWorkingDir(), output)
    
        return runProgramExecutable(resolved, args)
    }

    return runProgramExecutable(path.resolve(getWorkingDir(), output), args)
}

// need to add this to a few places to make sure we handle abs paths
function normalizeToRelative(fileName: string, workingDir = getWorkingDir()) {
    return path.relative(workingDir, path.resolve(workingDir, fileName))
}

export async function replCommand(target: string, opt?: { entrypoint?: string; cwd?: string }) {
    await compileIfNeeded(target)

    const repl = await runTask('', 'repl', async () => {
        const files = await getEntrypointsFile()
        const deployables = files?.deployables ?? {}
        const status = await validateTargetsForExecution(target, deployables)
        const outfile = status.sources?.[target]?.outfile 
        if (!status.isTargetDeployable && !outfile) {
            throw new RenderableError('No such file', () => {
                printLine(colorize('brightRed', 'No such file exists'))
            })
        }

        const resolved = status.isTargetDeployable
            ? await resolveReplTarget(target)
            : path.resolve(getWorkingDir(), outfile!)
    
        const moduleLoader = await runTask('init', 'loader', () => getModuleLoader(false), 1) // 8ms on simple hello world no infra
    
        return enterRepl(resolved, moduleLoader, {})
    }, 1)

    return repl.promise
}

async function getPreviousDeploymentProgramFs() {
    const hash = await getPreviousDeploymentProgramHash()
    if (!hash) {
        return
    }

    return toFsFromHash(hash)
}

async function getPreviousDeployInfo() {
    if (!getBuildTargetOrThrow().deploymentId) {
        return
    }

    const hash = await getPreviousDeploymentProgramHash()
    if (!hash) {
        return
    }

    const state = await readState()
    const oldProgramFs = await getFsFromHash(hash)
    const deploySources = await readSources(oldProgramFs)

    return { state, hash, deploySources }
}

async function getStaleSources(include?: Set<string>) {
    const sources = await readSources()
    const hasher = getFileHasher()
    if (!sources) {
        return
    }

    // Check hashes
    const stale = new Set<string>()
    const workingDir = getWorkingDir()

    async function checkSource(k: string, v: { hash: string }) {
        const source = path.resolve(workingDir, k)
        if (include && !include.has(source)) return

        const hash = await hasher.getHash(source).catch(e => {
            throwIfNotFileNotFoundError(e)
        })

        if (!hash) {
            delete sources![source]
            return
        }

        if (v.hash !== await hasher.getHash(source)) {
            stale.add(source)
        }
    }

    await Promise.all(Object.entries(sources).map(([k, v]) => checkSource(k, v)))

    return { stale, sources }
}

// This is used to see if we need to re-synth
async function getStaleDeployableSources(targets?: string[]) {
    const deployables = await getDeployables()
    if (!deployables) {
        return
    }

    const deployableSet = new Set(Object.keys(deployables).map(k => path.resolve(getWorkingDir(), k)))
    const incr = createIncrementalHost({})
    const deps = await incr.getCachedDependencies(...(deployableSet))
    const allDeps = getAllDependencies(deps, targets?.map(x => path.resolve(getWorkingDir(), x)) ?? [...deployableSet])
    
    return getStaleSources(allDeps.deps)
}

export async function showStatus(opt?: { verbose?: boolean }) {
    // Packages (installation)
    // Compile (pending moves)
    // Deploy 
    // Projects?
    // 

    const programFs = getProgramFs()
    const installation = await getInstallation(programFs)
    if (installation?.packages) {
        printLine(colorize('green', 'Installed packages'))
        if (opt?.verbose) {
            for (const [k, v] of Object.entries(installation.packages)) {
                printLine(`  ${k} -> ${v.name}${v.version ? `@${v.version}` : ''}`)
            }
        }
    } else {
        printLine(colorize('red', 'No packages installed'))
    }

    const { stale: staleSources, sources } = await getStaleSources() ?? {}

    if (!staleSources) {
        printLine(colorize('red', 'Not compiled'))
    } else {
        if (staleSources.size > 0) {
            printLine(colorize('yellow', 'Stale compilation'))
            for (const f of staleSources) {
                printLine(colorize('yellow', `  ${path.relative(getWorkingDir(), f)}`))
            }
        } else {
            printLine(colorize('green', 'Compiled'))
        }
    }

    const info = await getPreviousDeployInfo()
    if (!info?.deploySources || !info.state || info.state.resources.length === 0) {
        printLine(colorize('red', 'Not deployed'))
        return
    }

    const deployables = await getDeployables() ?? {}
    const deployableSet = new Set(Object.keys(deployables).map(k => path.resolve(getWorkingDir(), k)))
    const incr = createIncrementalHost({})
    const deps = await incr.getCachedDependencies(...deployableSet)
    const allDeps = getAllDependencies(deps, [...deployableSet])

    // This staleness check is probably too simplistic
    const stale = new Set<string>()
    for (const d of allDeps.deps) {
        const source = path.relative(getWorkingDir(), d)
        const h = info.deploySources[source]?.hash
        if (h && h !== sources![source]?.hash) {
            stale.add(source)
        }
    }

    if (stale.size > 0) {
        printLine(colorize('yellow', 'Stale deployment'))
        for (const f of stale) {
            printLine(colorize('yellow', `  ${path.relative(getWorkingDir(), f)}`))
        }
    } else {
        printLine(colorize('green', 'Deployed'))
    }

    const currentHash = await getProgramHash()
    if (currentHash !== info.hash) {
        const moved = await getMoved()
        if (moved) {
            // TODO: show the moves...
            printLine(colorize('blue', 'Pending moves'))
        }
    }
}

async function maybeGetPkgScript(name: string) {
    const pkg = await getCurrentPkg()
    if (!pkg) {
        return
    }

    const cmd = pkg.data.scripts?.[name]

    return cmd ? { pkg, cmd } : undefined
}

export async function convertPrimordials(targets: string[]) {
    await transformNodePrimordials(targets)
}

export async function testZip(dir: string, dest?: string) {
    dest ??= path.resolve(path.dirname(dir), `${path.basename(dir)}.zip`)
    await createZipFromDir(dir, dest, true)
}

export async function printBlock(hash: string, opt?: any) {
    await printBlockInfo(hash)
}

export async function diffIndicesCmd(a: string, b: string, opt?: any) {
    await diffIndices(getDataRepository(), a, b)
}

export async function diffObjectsCmd(a: string, b: string, opt?: any) {
    await diffObjects(getDataRepository(), a, b)
}

export async function diffFileCmd(fileName: string, opt?: { commitsBack?: number }) {
    await diffFileInLatestCommit(fileName, opt)
}

// This is safe because deployments always reference fs hashes not head IDs
export async function clean(opt?: any) {
    await getDataRepository().deleteHead(getBuildTargetOrThrow().programId)
}

export async function lockedInstall() {
    await verifyInstall()
}

export async function listInstallTree() {
    await listInstall()
}

export async function loadBlock(target: string, dest?: string, opt?: any) {
    const data = await getFs().readFile(target)
    const block = openBlock(Buffer.from(data))
    const index = JSON.parse(block.readObject(path.basename(target)).toString('utf-8'))
    checkBlock(Buffer.from(data), index)

    if (dest) {
        printLine(`Loading block to ${dest}`)
    }

    const repo = getDataRepository(undefined, dest)
    await Promise.all(block.listObjects().map(h => repo.writeData(h, block.readObject(h))))
}

export async function inspectBlock(target: string, opt?: any) {
    const data = await getFs().readFile(target)
    const block = openBlock(Buffer.from(data))
    const objects = block.listObjects().map(h => [h, block.readObject(h).byteLength] as const)
        .sort((a, b) => b[1] - a[1])

    for (const [h, size] of objects) {
        printLine(`${h} ${size}`)
    }

    const index = JSON.parse(block.readObject(path.basename(target)).toString('utf-8'))
    checkBlock(Buffer.from(data), index)
    printLine(colorize('green', 'No issues found'))
}

export function runUserScript(target: string) {
    const loader = createMinimalLoader(target.endsWith('.ts'))

    return loader.loadModule(target)
}

interface BuildExecutableOpt {
    readonly sea?: boolean
    readonly lazyLoad?: string[]
}

export async function buildExecutables(opt: BuildExecutableOpt) {
    const bt = getBuildTargetOrThrow()
    const pkg = await getCurrentPkg()
    if (!pkg) {
        throw new Error(`No package.json found`)
    }

    const bin = getPkgExecutables(pkg.data)
    const executables = await getExecutables()
    if (!bin || !executables) {
        throw new Error(`No executables to build`)
    }

    async function _getNodePath() {
        if (isSelfSea()) {
            return process.execPath
        }

        try {
            return await which('synapse')
        } catch (e) {
            getLogger().log('Failed to find "synapse", falling back to node', e)

            return which('node')
        }
    }

    const getNodePath = memoize(_getNodePath)

    const set = new Set(Object.values(executables).map(k => path.resolve(bt.workingDirectory, k)))

    const external = ['esbuild', 'typescript', 'postject']
    // XXX: this is hard-coded to `synapse`
    const bundleOpt = pkg.data.name === 'synapse' ? {
        external, 
        lazyLoad: ['@cohesible/*', 'typescript', 'esbuild', ...lazyNodeModules],
        extraBuiltins: ['typescript', 'esbuild'],
    } : opt

    if (pkg.data.name === 'synapse') {
        process.env.SKIP_SEA_MAIN = '1'
        process.env.CURRENT_PACKAGE_DIR = pkg.directory
    }

    for (const [k, v] of Object.entries(bin)) {
        const resolved = path.resolve(bt.workingDirectory, v)
        if (!set.has(resolved)) continue

        const res = await bundleExecutable(bt, resolved, undefined, undefined, { sea: opt.sea, ...bundleOpt })
        const dest = path.resolve(bt.workingDirectory, 'dist', 'bin', k)
        if (opt.sea) {
            await makeSea(res.outfile, await getNodePath(), dest, res.assets)
        } else {
            // TODO: write out assets
        }
    }
}

export async function convertBundleToSea(dir: string) {
    const nodePath = path.resolve(dir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    await makeExecutable(nodePath)

    const bundledCliPath = path.resolve(dir, 'dist', 'cli.js')
    const assets: Record<string, string> = {}
    const assetsDir = path.resolve(dir, 'assets')
    const hasAssets = await getFs().fileExists(assetsDir)
    if (hasAssets) {
        for (const f of await getFs().readDirectory(assetsDir)) {
            if (f.type === 'file') {
                assets[`${seaAssetPrefix}${f.name}`] = path.resolve(assetsDir, f.name)
            }
        }
    }

    const seaDest = path.resolve(dir, 'bin', process.platform === 'win32' ? 'synapse.exe' : 'synapse')
    await makeSea(bundledCliPath, nodePath, seaDest, assets, true)

    await getFs().deleteFile(nodePath)
    await getFs().deleteFile(path.resolve(dir, 'dist', 'cli.js'))
    await getFs().deleteFile(path.resolve(dir, 'node_modules')).catch(throwIfNotFileNotFoundError)
    if (hasAssets) {
        await getFs().deleteFile(path.resolve(dir, 'assets'))
    }

    await createArchive(dir, `${dir}${process.platform === 'linux' ? `.tgz` : '.zip'}`, false)
}

const lazyNodeModules = [
    'node:vm',
    'node:http',
    'node:https',
    'node:repl',
    'node:assert',
    'node:stream',
    'node:zlib',
    'node:module',
    'node:net',
    'node:url',
]

export async function internalBundle(target?: string, opt: any = {}) {
    const targetDouble = target?.split('-')
    const resolved = resolveBuildTarget({ os: targetDouble?.[0] as any, arch: targetDouble?.[1] as any })
    const os = resolved.os
    const arch = resolved.arch

    const libc = opt.libc
    const external = ['esbuild', 'typescript', 'postject']
    const isProdBuild = opt.production
    const dirName = opt.stagingDir ?? `synapse-${os}-${arch}`
    const outdir = path.resolve(getWorkingDir(), 'dist', dirName)

    const isSea = opt.sea || opt.seaOnly
    const hostTarget = resolveBuildTarget()
    if (isSea && (hostTarget.os !== os || hostTarget.arch !== arch)) {
        throw new Error(`Cross-platform builds are not supported for snapshots/SEAs`)
    }

    const shouldSign = false // opt.sign || isProdBuild
    const bundledCliPath = path.resolve(outdir, 'dist/cli.js')

    opt.lto ??= isProdBuild

    const execPath = (name: string) => path.resolve(outdir, 'bin', `${name}${os === 'windows' ? '.exe' : ''}`)
    const toolPath = (name: string) => path.resolve(outdir, 'tools', `${name}${os === 'windows' ? '.exe' : ''}`)

    if (opt.integrationsOnly) {
        return copyIntegrations(getRootDirectory(), outdir, opt.integration)
    }

    const nodePath = execPath('node')
    const seaDest = execPath('synapse')

    if (opt.seaOnly) {
        const bundle = await createBundle()

        return await makeSea(bundledCliPath, nodePath, seaDest, bundle.assets) 
    }

    async function bundleMain() {
        const bundleOpt = {
            external, 
            minifyKeepWhitespace: isProdBuild, 
            lazyLoad: (isSea || opt.seaPrep) ? ['@cohesible/*', 'typescript', 'esbuild', ...lazyNodeModules] : [],
            extraBuiltins: ['typescript', 'esbuild'],
        }

        if (isProdBuild && process.env.SKIP_SEA_MAIN) {
            const bt = getBuildTargetOrThrow()
            return bundleExecutable(
                bt,
                'dist/src/cli/index.js',
                bundledCliPath,
                bt.workingDirectory,
                { sea: true, ...bundleOpt }
            )
        }

        return bundlePkg(
            'dist/src/cli/index.js',
            getWorkingDir(), // TODO: we should bundle in an empty directory to prevent extraneous files from being used
            bundledCliPath,
            bundleOpt,
        )
    }

    // TODO: external sourcemaps for the bundle/binary
    async function createBundle() {
        const res = await bundleMain()

        // XXX: Patch the bundle
        await getFs().writeFile(
            bundledCliPath,
            (await getFs().readFile(bundledCliPath, 'utf-8'))
                .replace('#!/usr/bin/env node', 'var exports = {};')
        )

        const procFs = getDeploymentFs()

        await getFs().writeFile(
            path.resolve(outdir, 'dist', 'completions.sh'),
            await procFs.readFile(path.resolve(getWorkingDir(), 'src', 'cli', 'completions', 'completion.sh'))
        )

        return res
    }

    async function bundleInstallScript() {
        await bundleExecutable(
            getBuildTargetOrThrow(),
            'dist/src/cli/install.js',
            path.resolve(outdir, 'dist', 'install.js')
        )
    }

    await bundleInstallScript()

    await createPackageForRelease(getWorkingDir(), outdir, { 
        external, 
        os, 
        arch,
        libc,
        lto: opt.lto,
        sign: shouldSign, 
        snapshot: isSea || opt.seaPrep,
        stripInternal: isProdBuild,
        buildLicense: isProdBuild,
        downloadOnly: opt.downloadOnly,
    })

    const bundle = await createBundle()
    await copyIntegrations(getRootDirectory(), outdir, opt.integration)

    if (resolved.os === 'windows') {
        const shimPath = await buildWindowsShim()
        await getFs().writeFile(
            path.resolve(outdir, 'dist', 'shim.exe'),
            await getFs().readFile(shimPath)
        )
    }

    await makeExecutable(nodePath)
    await makeExecutable(toolPath('terraform'))
    if (isSea) {
        await makeExecutable(toolPath('esbuild'))
    }

    if (isSea) {
        await makeSea(bundledCliPath, nodePath, seaDest, bundle.assets, !shouldSign)
        if (isProdBuild || opt.stagingDir || !!getCiType()) {
            if (!opt.preserveSource) {
                await getFs().deleteFile(bundledCliPath)
            }
            await getFs().deleteFile(nodePath)
            await getFs().deleteFile(path.resolve(outdir, 'node_modules'))
        }

        if (shouldSign) {
            await signWithDefaultEntitlements(seaDest)
        }
    } else {
        await getFs().deleteFile(path.resolve(outdir, 'node_modules', '.bin')).catch(throwIfNotFileNotFoundError)
    }

    if (opt.seaPrep) {
        const resolved = await resolveAssets(bundle.assets)
        if (resolved) {
            const assetsDest = path.resolve(outdir, 'assets')
            for (const [k, v] of Object.entries(resolved)) {
                await getFs().writeFile(
                    path.resolve(assetsDest, k), 
                    await getFs().readFile(v)
                )
            }
        }
    }

    // darwin we use `.zip` for signing
    const extname = opt.seaPrep || os === 'linux' ? '.tgz' : '.zip'
    await createArchive(outdir, `${outdir}${extname}`, shouldSign && !opt.seaPrep)
}


// This is to get the WS URL for Inspector
// http://host:port/json/list


