import ts from 'typescript'
import * as path from 'node:path'
import { CompilerOptions, getEnvVarHash, readPointersFile } from './compiler/host'
import { FailedTestEvent, TestEvent, runTask } from './logging'
import { BoundTerraformSession, DeployOptions, SessionContext, SessionError, createStatePersister, createZipFromDir, getChangeType, getDiff, getTerraformPath, isTriggeredReplaced, parsePlan, startTerraformSession } from './deploy/deployment'
import { LocalWorkspace, getV8CacheDirectory, initProject, getLinkedPackagesDirectory, Program, getRootDirectory, getDeploymentBuildDirectory, getTargetDeploymentIdOrThrow, getOrCreateDeployment, getWorkingDir } from './workspaces'
import { createLocalFs } from './system'
import { AmbientDeclarationFileResult, Mutable, acquireFsLock, createHasher, createRwMutex, getCiType, gunzip, isNonNullable, isWindows, keyedMemoize, makeExecutable, makeRelative, memoize, printNodes, replaceWithTilde, resolveRelative, showArtifact, throwIfNotFileNotFoundError, toAmbientDeclarationFile, wrapWithProxy } from './utils'
import { MoveWithSymbols, SymbolGraph, SymbolNode, createMergedGraph, createSymbolGraph, createSymbolGraphFromTemplate, deleteSourceMapResource, detectRefactors, findAutomaticMoves, getKeyFromScopes, getMovesWithSymbols, getRenderedStatementFromScope, isOldSourceMapFormat, normalizeConfigs, renderSymbol, renderSymbolLocation } from './refactoring'
import { SourceMapHost } from './static-solver/utils'
import { getLogger } from './logging'
import { BuildFsIndex, CompiledChunk, checkBlock, commitProgram, createArtifactFs, createBuildFsFragment, createMountedFs, getDataRepository, getFsFromHash, getInstallation, getMoved, getPreviousDeploymentProgramHash, getDeploymentFs, getProgramFs, getProgramHash, getResourceProgramHashes, listCommits, maybeRestoreTemplate, printBlockInfo, putState, readResourceState, readState, saveMoved, shutdownRepos, syncRemote, toFs, toFsFromHash, writeTemplate } from './artifacts'
import { PackageService, createPackageService, maybeDownloadPackages, showManifest, downloadAndUpdatePackage, verifyInstall, downloadAndInstall, listInstall, resolveDepsGreedy, printTree } from './pm/packages'
import { clearCachedTestResults, createTestRunner, listTestSuites, listTests } from './testing'
import { enterRepl } from './repl'
import { createTemplateService, getHash, parseModuleName } from './templates'
import { createImportMap, createModuleResolver } from './runtime/resolver'
import { createAuth, getAuth } from './auth'
import { generateOpenApiV3, generateStripeWebhooks } from './codegen/schemas'
import { createNpmLikeCommandRunner, dumpPackage, emitPackageDist, getPkgExecutables, getProjectOverridesMapping, linkPackage, publishToRemote } from './pm/publish'
import { ResolvedProgramConfig, getResolvedTsConfig, resolveProgramConfig } from './compiler/config'
import { createProgramBuilder, getDeployables, getEntrypointsFile, getExecutables } from './compiler/programBuilder'
import { loadCpuProfile } from './perf/profiles'
import { colorize, createTreeView, printJson, printLine, print, getDisplay, bold, RenderableError, dim } from './cli/ui'
import { createDeployView, extractSymbolInfoFromPlan, getPlannedChanges, groupSymbolInfoByPkg, printSymbolTable, promptDestroyConfirmation, promptForInput, renderMove, renderSummary, renderSym } from './cli/views/deploy'
import { TerraformSourceMap, TfJson } from './runtime/modules/terraform'
import { glob } from './utils/glob'
import { createMinimalLoader } from './runtime/rootLoader'
import { CancelError, getBuildTarget, getBuildTargetOrThrow, getFs, getSelfPathOrThrow, isCancelled, isSelfSea, pushDisposable, throwIfCancelled } from './execution'
import * as secrets from './services/secrets'
import * as workspaces from './workspaces'
import { createTestView } from './cli/views/test'
import { clearIncrementalCache, createIncrementalHost, getAllDependencies, getFileHasher } from './compiler/incremental'
import { getMostRecentLogFile, getSortedLogs, listLogFiles } from './cli/logger'
import { PackageJson, ResolvedPackage, getCompiledPkgJson, getCurrentPkg, getPackageJson, getPreviousPkg, parsePackageInstallRequests, resetCompiledPkgJson, setCompiledPkgJson } from './pm/packageJson'
import * as quotes from '@cohesible/quotes'
import * as analytics from './services/analytics'
import { TfState } from './deploy/state'
import { bundleExecutable, bundlePkg, InternalBundleOptions } from './closures'
import { cleanDataRepo, maybeCreateGcTrigger } from './build-fs/gc'
import { createArchive, createPackageForRelease, lazyNodeModules } from './cli/buildInternal'
import { runCommand, which } from './utils/process'
import { transformNodePrimordials } from './utils/convertNodePrimordials'
import { createCompileView, getPreviousDeploymentData } from './cli/views/compile'
import { createSessionContext, getModuleLoader, getSession, shutdownSessions } from './deploy/session'
import { findArtifactByPrefix, getMetadata } from './build-fs/utils'
import { collectAllStats, collectStats, diffFileInLatestCommit, diffIndices, diffObjects, mergeRepoStats, printStats, printTopNLargestObjects } from './build-fs/stats'
import { renderCmdSuggestion } from './cli/commands'
import * as ui from './cli/ui'
import * as bfs from './artifacts'
import { findAllBareSpecifiers } from './compiler/entrypoints'
import { makeSea, resolveAssets } from './build/sea'
import { createInstallView } from './cli/views/install'
import { resolveBuildTarget } from './build/builder'
import { createIndexBackup } from './build-fs/backup'
import { homedir } from 'node:os'
import { createBlock, openBlock } from './build-fs/block'
import { seaAssetPrefix } from './bundler'
import { buildWindowsShim, getZigCompilationGraph } from './zig/compile'
import { openRemote } from './git'
import { getTypesFile } from './compiler/resourceGraph'
import { formatEvents, getLogService } from './services/logs'
import { getNeededDependencies } from './pm/autoInstall'
import { maybeLoadEnvironmentVariables } from './runtime/env'
import { pointerPrefix } from './build-fs/pointers'
import { initOrUpdateWatcherState, maybeDetectChanges } from './utils/stateless-watcher/binding'

// TODO: https://github.com/pulumi/pulumi/issues/3388

// Apart of refactoring story:
// https://github.com/pulumi/pulumi/issues/3389


export type CombinedOptions = CompilerOptions & DeployOptions & { 
    forceRefresh?: boolean
    cwd?: string
    project?: string
    program?: string
    process?: string
}

export function pushPlatformDisposables() {
    pushDisposable(shutdownSessions)
    pushDisposable(shutdownRepos)
    pushDisposable(() => analytics.shutdown().catch(e => {
        getLogger().warn('Failed to flush events', e)
    }))
}

// TODO: add permissions model to all system APIs e.g. `fs`, `https`, etc.
// This would be very similar to Deno, but we can do so much more with it


export async function syncModule(deploymentId: string, bt = getBuildTargetOrThrow()) {
    const projectId = await workspaces.getRemoteProjectId(bt.projectId)
    if (projectId) {
        getLogger().log('Using remote project id', projectId)
        await syncRemote(projectId, deploymentId)
    }
}

type PublishOptions = CompilerOptions & DeployOptions & { 
    remote?: boolean
    newFormat?: boolean
    archive?: string
    dryRun?: boolean
    local?: boolean
    skipInstall?: boolean 
    overwrite?: boolean
    visibility?: 'public' | 'private'
    ref?: string
}

export async function publish(target: string, opt?: PublishOptions) {
    if (opt?.remote) {
        return publishToRemote({
            ref: opt['ref'],
            tarballPath: opt['archive'],
            allowOverwrite: opt['overwrite'],
            visibility: opt['visibility'],
        })
    }

    if (opt?.archive) {
        const packageDir = getWorkingDir()
        const dest = path.resolve(packageDir, opt.archive)
        const tmpDest = dest.replace(path.extname(opt.archive), '-tmp')
        const bt = getBuildTargetOrThrow()

        try {
            await createPackageForRelease(packageDir, tmpDest, { environmentName: bt.environmentName }, true, true, true)
            await createArchive(tmpDest, dest, false)
        } finally {
            await getFs().deleteFile(tmpDest).catch(throwIfNotFileNotFoundError)
        }

        return
    }

    if (opt?.local) {
        await linkPackage({ dryRun: opt?.dryRun, skipInstall: opt?.skipInstall })
        return
    }

    throw new Error(`Publishing non-local packages is not implemented`)
}

async function findOrphans(opt?: { synapseOnly?: boolean }) {
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
        if (!resources.has(k) && (!opt?.synapseOnly || r.type === 'synapse_resource')) {
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
export async function collectGarbageResources(target: string, opt?: CombinedOptions & { dryRun?: boolean; synapseOnly?: boolean }) {
    const { orphans, previousTemplate } = await findOrphans(opt)
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
    await cleanDataRepo(undefined, opt?.dryRun)
}

async function getMergedGraph(templateFile: TfJson) {
    const oldTemplate = await maybeRestoreTemplate()
    const oldGraph = oldTemplate ? createSymbolGraphFromTemplate(oldTemplate) : undefined

    return createMergedGraph(createSymbolGraphFromTemplate(templateFile), oldGraph)
}

async function getDeployView(templateFile: TfJson, isDestroy?: boolean) {
    return createDeployView(await getMergedGraph(templateFile), isDestroy ? 'destroy' : 'deploy') 
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

function gatherTargets(template: TfJson, symbols: string[]) {
    const targets = new Set<string>()
    const graph = createSymbolGraphFromTemplate(template)

    const allResources = new Set<string>(Object.keys(gatherResources(template)))

    for (const s of symbols) {
        if (allResources.has(s)) {
            targets.add(s)
            continue
        }

        const n = getSymbolNodeFromRef(graph, s)
        for (const r of n.resources) {
            targets.add(`${r.type}.${r.name}`)
        }
    }

    if (targets.size === 0) {
        throw new Error('No targets found')
    }

    return Array.from(targets)
}

async function checkCompileForDeploy(targets: string[], opt?: DeployOpt2) {
    const programFsHash = opt?.sessionCtx?.buildTarget.programHash
    if (programFsHash || opt?.targetResources) {
        return
    }

    const doCompile = (forcedSynth?: boolean, targetFiles = targets, skipWatcher = true) => compile(targetFiles, { 
        forcedSynth, 
        incremental: true, 
        skipSummary: true,
        skipWatcher,
        hideLogs: true, 
        deployTarget: opt?.deployTarget,
    })

    const needsSynth = await getNeedsSynth()
    if (needsSynth) {
        await doCompile(true)
    } else {
        // In any kind of machine-to-machine interaction we shouldn't try to be smart like this
        // It's better to fail and say that the program should be compiled explicitly first.
        // Auto-compile/synth is a feature for humans, not machines. 
        //
        // TODO: we should check stale compilation for `syn test` too
        // TODO: also we should limit the staleness check to the subgraph(s) specified by `targets`
        const sources = await getStaleDeployableSources(targets.length > 0 ? targets : undefined)

        // We never synthed, need a full compile
        if (!sources) {
            getLogger().log('No sources found, compiling all')
            await doCompile(undefined, [], false)
        } else if (sources.stale.size > 0) {
            getLogger().log('Found stale sources, recompiling')
            await doCompile()
        } else if (sources.removed.size > 0) {
            getLogger().log('Found removed sources, recompiling', [...sources.removed])
            await doCompile()
        } else if (opt?.deployTarget) {
            const prev = await getPreviousPkg()
            if (prev?.synapse?.config?.target !== opt.deployTarget) {
                getLogger().log(`Target has changed, recompiling: ${prev?.synapse?.config?.target} [previous] !== ${opt.deployTarget} [current]`)
                await doCompile()
            } else {
                await checkEnvVars()
            }
        } else {
            await checkEnvVars()
        }

        async function checkEnvVars() {
            const diff = await getChangedEnvVarsForSynth()
            if (diff) {
                getLogger().log(`Synthesis environment variables changed: ${diff}`)

                return doCompile()
            }
        }
    }

    return await loadMoved(path.resolve(getWorkingDir(), 'moved.json'))
}

export async function deploy(targets: string[], opt: DeployOpt2 = {}) {
    const workingDir = getBuildTargetOrThrow().workingDirectory
    targets = targets.map(x => makeRelative(workingDir, resolveRelative(workingDir, x)))

    await validateTargets(targets)

    const programFsHash = opt?.sessionCtx?.buildTarget.programHash
    const maybeMoved = await checkCompileForDeploy(targets, opt)
    // TODO: return early if there is nothing to deploy
    // Currently users see "No deployment associated with build target" if they
    // try to deploy a file that does not instantiate any resources

    const deploymentId = getTargetDeploymentIdOrThrow()
    const session = await getSession(deploymentId, opt?.sessionCtx, { parallelism: 50 })
    const template = await session.templateService.getTemplate()
    await assertSameCloudTarget(template)

    const artifactFs = await bfs.getArtifactFs()
    getLogger().debug('Starting deploy operation')

    const view = await getDeployView(template)

    const targetResources = opt.targetResources ??= []
    if (opt?.symbols) {
        targetResources.push(...gatherTargets(template, opt.symbols))
    }

    if (maybeMoved && targetResources.length > 0) {
        for (const m of maybeMoved) {
            targetResources.push(m.from)
            targetResources.push(m.to)
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
            await showNextStepsAfterDeploy(template, result.state)
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

export async function destroy(targets: string[], opt?: CombinedOptions & { dryRun?: boolean; symbols?: string[]; deploymentId?: string; yes?: boolean; cleanAfter?: boolean }) {
    // TODO: this should be done prior to running any commands, not within a command
    if (opt?.deploymentId) {
        Object.assign(getBuildTargetOrThrow(), { deploymentId: opt?.deploymentId }) 
    }

    if (opt?.cleanAfter && !getBuildTargetOrThrow().deploymentId) {
        return clean()
    }

    const deploymentId = opt?.deploymentId ?? getTargetDeploymentIdOrThrow()
    const state = await readState()
    if (!state || state.resources.length === 0) {
        getLogger().debug('No resources to destroy, returning early')
        printLine(colorize('green', 'Nothing to destroy!'))
        return opt?.cleanAfter ? clean() : undefined
    }

    const template = await maybeRestoreTemplate()
    if (!template) {
        throw new Error(`No previous deployment template found`)
    }

    if (getCiType() !== 'github' && !opt?.yes) {
        const envName = getBuildTargetOrThrow().environmentName
        if (envName?.includes('production')) {
            await promptDestroyConfirmation(`The current environment "${envName}" is marked as production.`, state)
        } else if (await workspaces.isPublished(getBuildTargetOrThrow().programId)) {
            await promptDestroyConfirmation(`The current package has been published.`, state)
        }
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
            await session.templateService.cleanState()
        
            const artifactFs = await bfs.getArtifactFs()
            await artifactFs.resetManifest(deploymentId)
            await cleanTests(deploymentId)
        }

        return result.state
    } finally {
        if (opt?.syncAfter) {
            await syncModule(deploymentId)
        }

        if (opt?.cleanAfter) {
            await clean()
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
    const synapseSet = new Set(synapseResources)
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

    async function getAllDeps(r: string) {
        const visited = new Set<string>()

        async function visit(addr: string) {
            if (visited.has(addr)) {
                return
            }

            visited.add(addr)
            if (!deps[addr]) {
                await loadDeps([addr])
            }

            if (deps[addr]) {
                for (const d of deps[addr]) {
                    visit(d)
                }
            }
        }

        await visit(r)

        return visited
    }

    // Assumption: no circular deps
    async function visit(k: string) {
        if (canUse.has(k)) {
            return canUse.get(k)!
        }

        if (!k.startsWith('data.') && !k.startsWith('local.') && !synapseSet.has(k)) {
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

    await loadDeps([...synapseSet])
    const result: string[] = []
    for (const k of synapseSet) {
        if (await visit(k)) {
            result.push(k)
        }
    }

    return {
        result,
        deployed,
        explain,
        getAllDeps,
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

type TestOptions = DeployOptions & { 
    destroyAfter?: boolean
    //targetIds?: string[]
    rollbackIfFailed?: boolean
    filter?: string,
    noCache?: boolean
    showLogs?: boolean
}

// This assumes that the "primary" deployment is already active
export async function runTests(targets: string[], opt?: TestOptions) {
    // TODO: handle the other cases
    // await validateTargetsForExecution(targets[0], (await getEntrypointsFile())?.deployables ?? {})
    await compileIfNeeded(targets[0], false)

    const deploymentId = getTargetDeploymentIdOrThrow()

    const filter = {
        // targetIds: opt?.targetIds,
        fileNames: targets.length > 0 ? targets : undefined,
        names: opt?.filter,
    }

    const session = await getSession(deploymentId)

    const suites = await listTestSuites(session.templateService, filter)
    const tests = await listTests(session.templateService, filter)

    const targetResources = new Set([
        ...Object.keys(suites),
        ...Object.keys(tests),
    ])

    const targetModules = new Set<string>()

    // FIXME: figure out a way to avoid doing this. Right now this is done to ensure 
    // that any resources that cause "side-effects" are also deployed
    const suiteKeys = new Set([
        ...Object.values(suites).map(x => `${x.fileName}:${x.id}`),
        ...Object.values(tests).map(x => `${x.fileName}:${x.parentId}`),
    ].filter(isNonNullable))

    const resources = (await session.templateService.getTemplate()).resource
    for (const [k, v] of Object.entries(resources)) {
        for (const [k2, v2] of Object.entries(v as any)) {
            const parsed = parseModuleName((v2 as any).module_name)
            const key = `${k}.${k2}`
            const testKey = parsed.testSuiteId !== undefined ? `${parsed.fileName}:${parsed.testSuiteId}` : undefined
            if (testKey!== undefined && suiteKeys.has(testKey) && !targetResources.has(key)) {
                targetResources.add(key)
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

    const testRunner = createTestRunner(session.moduleLoader, session.ctx.packageService, opt)
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
                targetResources: [...targetResources],
            }).catch(err => {
                // Rolling back is much more important than a clean destruction of test resources
                if (!shouldRollback) {
                    throw err
                }

                getLogger().error(`Failed to destroy test resources`, err)
            })
        }

        if (shouldRollback) {
            await shutdownSessions() // TODO: can be removed if test resources use a separate deployment ID
            await rollback('', opt)
        }

        process.exitCode = failures.length > 0 ? 1 : 0

        view.showFailures(failures)
        view.dispose(failures, opt?.showLogs)
    }
}

export async function testGlob(patterns: string[], opt?: DeployOptions) {
    const excluded = undefined

    await runTask('glob', 'glob', async () => {
        const res = await glob(getFs(), getWorkingDir(), patterns, excluded ? [excluded] : undefined)
        printJson(res.map(x => path.relative(getWorkingDir(), x)))
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

type PlanOptions = DeployOptions & { symbols?: string[]; forceRefresh?: boolean; planDepth?: number; debug?: boolean; expectNoChanges?: boolean }

export async function plan(targets: string[], opt: PlanOptions = {}) {
    const workingDir = getBuildTargetOrThrow().workingDirectory
    targets = targets.map(x => makeRelative(workingDir, resolveRelative(workingDir, x)))

    const maybeMoved = await checkCompileForDeploy(targets, opt)

    const session = await getSession(getTargetDeploymentIdOrThrow(), undefined, { ...opt, noSave: true })
    const template = await session.templateService.getTemplate()

    const targetResources = opt.targetResources ??= []
    if (opt?.symbols) {
        targetResources.push(...gatherTargets(template, opt.symbols))
    }

    if (maybeMoved && targetResources.length > 0) {
        for (const m of maybeMoved) {
            targetResources.push(m.from)
            targetResources.push(m.to)
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

    if (opt?.debug) {
        const graph = createSymbolGraphFromTemplate(template)

        const changes = getPlannedChanges(res)

        function order(a: string) {
            switch (a) {
                case 'replace': return 0
                case 'create': return 1
                case 'delete': return 2
                default: return 3
            }
        }

        const moved = await getMoved()
        const state = await readState()
        const remaining = new Set<string>(state?.resources.map(r => `${r.type}.${r.name}`) ?? [])
        for (const m of moved ?? []) {
            remaining.delete(m.from)
        }

        const potentialMatches = new Map<string, string[]>()
        const friendlyNames = new Map<string, string>()

        const sorted = Object.entries(changes).sort((a, b) => order(a[1].change) - order(b[1].change))
        for (const [k, v] of sorted) {
            // Data source
            if (v.change === 'read') continue

            const s = graph.findSymbolFromResourceKey(k)
            const ty = graph.getResourceType(k)
            const name = s?.value.name

            const wasMoved = moved?.find(x => x.to === k)

            const text = `${v.change} - ${name ? `${name} [${k}]` : k}${wasMoved ? `[moved]` : ''}`
            if (v.change === 'replace') {
                // XXXX: generally noisy
                if (k.startsWith('aws_s3_object.')) {
                    continue
                }
                printLine(colorize('yellow', text))

                printLine(`    reason: ${v.plan.reason}`)
                printLine(`    diff: ${JSON.stringify(getDiff(v.plan.change), undefined, 4)}`)
                printLine(`    attributes: ${JSON.stringify(v.plan.attributes, undefined, 4)}`)

            } else if (v.change === 'create') {
                if (ty.closureKindHint === 'definition') continue
                printLine(colorize('green', text))
                const z = k.split('.')[0]
                const rem = [...remaining].filter(x => x.split('.')[0] === z && (ty.kind !== 'custom' || x.endsWith('--Custom')))
                potentialMatches.set(k, rem)
                friendlyNames.set(k, name ? `${name} [${k}]` : k)
            } else if (v.change === 'delete') {
                printLine(colorize('red', text))
            } else {
                printLine(colorize('gray', text))
            }
        }
        
        for (const [k, v] of potentialMatches) {
            printLine(`maybe match ${friendlyNames.get(k)!}`)
            for (const d of v) {
                printLine(`    ${d.split('.')[1]}`)
            }
        }

        return
    }

    const g = await getMergedGraph(template)
    const info = extractSymbolInfoFromPlan(g, res)
    if (info.size === 0) {
        printLine('No changes planned')
        return
    }

    if (opt.expectNoChanges) {
        throw new Error('Expected no changes')
    }

    const groups = groupSymbolInfoByPkg(info)
    for (const [pkgRef, files] of Object.entries(groups)) {
        for (const [fileName, group] of Object.entries(files)) {
            printSymbolTable(group)
        }
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
        const template = await maybeRestoreTemplate()
        if (!template) {
            throw new Error(`No deployment template found`)
        }
    
        const graph = createSymbolGraphFromTemplate(template)

        const keys = state.resources.map(r => `${r.type}.${r.name}`)
        for (const k of keys) {
            const sym = graph.hasResource(k) ? getSymbolNodeFromRef(graph, k) : undefined
            const rendered = sym ? ` [${renderSymbol(sym, true, true)}]` : ''
            printLine(`${k}${rendered}`)
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
    printJson(resp)
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
    if (graph.hasResource(ref)) {
        const n = graph.findSymbolFromResourceKey(ref)
        if (n) {
            const r = n.value.resources.filter(x => `${x.type}.${x.name}` === ref)[0]
            if (r) {
                return {
                    ...n.value,
                    id: -1,
                    resources: [r],
                }
            }
        }
    }

    // XXX: ugh what have I done...
    const { name, fileName, index, attribute } = parseSymbolRef(ref)
    const matched = graph.matchSymbolNodes(name, fileName, attribute)
    if (matched.length === 0) {
        throw new Error(`No resources found matching name "${name}"${fileName ? ` in file "${fileName}"` : ''}`)
    }

    if (matched.length > 1 && index === undefined) {
        throw new Error(`Ambiguous match:\n${matched.map(n => '  ' + renderSymbol(n.value, true, true)).join('\n')}`)
    }

    const n = matched[index ?? 0]
    if (!n) {
        throw new Error(`Not a valid index: ${index ?? 0} [length: ${matched.length}]`)
    }

    return n.value
}

export async function deleteResource(id: string, opt?: CombinedOptions & { dryRun?: boolean; force?: boolean }) {
    const getState = memoize(readState)

    async function _deleteResource(id: string) {
        const state = await getState()
        if (!state) {
            return
        }

        const index = state.resources.findIndex(r => `${r.type}.${r.name}` === id)
        if (index === -1) {
            getLogger().log(`Resource not found: ${id}`)
            return
        }

        state.resources.splice(index, 1)
        await putState(state)
    }

    const state = await readState()
    if (!state) {
        return
    }

    if (id === 'ALL_CUSTOM') {
        for (const r of state.resources) {
            if (r.type === 'synapse_resource' && (r.name.endsWith('--Example')) || r.name.endsWith('--Custom')) {
                await _deleteResource(`${r.type}.${r.name}`)
            }
        }

        return 
    }

    const perfectMatch = !!state.resources.find(x => `${x.type}.${x.name}` === id)
    if (opt?.force || perfectMatch) {
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

export async function queryResourceLogs(ref?: string, opt?: { system?: boolean }) {
    const logService = getLogService()
    const session = await getSession(getTargetDeploymentIdOrThrow(), undefined, { loadRegistry: true })
    const state = await session.getState()
    if (!state) {
        throw new Error('No state found')
    }

    async function getTargetsFromRef(ref: string) {
        const template = await session.templateService.getTemplate()
        const graph = createSymbolGraphFromTemplate(template)
        const node = getSymbolNodeFromRef(graph, ref)
        
        return node.resources.map(r => `${r.type}.${r.name}`)
    }

    const targets = ref ? await getTargetsFromRef(ref) : undefined
    const events = await logService.queryLogs(state, { targets, includeSystem: opt?.system })
    if (events.length === 0) {
        throw new Error('No logs found')
    }

    console.log(formatEvents(events))
}

export async function importResource(ref: string, id: string) {
    await compileIfNeeded(undefined, false)

    const session = await getSession(getTargetDeploymentIdOrThrow())
    const template = await session.templateService.getTemplate()
    const graph = createSymbolGraphFromTemplate(template)
    const state = await session.getState()

    // Direct import
    if (graph.hasResource(ref)) {
        if (state?.resources.find(r => `${r.type}.${r.name}` === ref)) {
            throw new Error(`State already exists: ${ref}`)
        }

        const view = await createDeployView(await getMergedGraph(template), 'import')
        const result = await session.importResource(ref, id)
    
        if (result.state) {
            const artifactFs = await bfs.getArtifactFs()
            await artifactFs.commit(result.state)
        }
    
        await shutdownSessions()
        throwIfFailed(view, result.error)
    
        return view.dispose(colorize('green', 'Done!'))
    }

    const targets = getSymbolNodeFromRef(graph, ref).resources.filter(r => {
        const ty = graph.getResourceType(`${r.type}.${r.name}`)

        // These are internal resources and cannot be imported
        return ty.kind !== 'synapse'
    })

    if (targets.length === 0) {
        throw new Error(`No resources found matching ref: ${ref}`)
    }
   
    if (targets.length > 1) {
        const suggestedRefs = targets.map(r => {
            const name = r.scopes[1]?.assignment?.name ?? r.scopes[1]?.callSite.name
            if (!name) {
                throw new Error(`Missing name: ${r.type}.${r.name}`)
            }

            return `${ref}/${name}`
        })

        const msg = `Only a single resource can be imported at a time. Suggestions:\n${suggestedRefs.map(r => `  ${r}`).join('\n')}` 

        throw new Error(msg)
    }

    const addr = `${targets[0].type}.${targets[0].name}`
    const ty = graph.getResourceType(addr)
    if (ty.kind === 'custom') {
        const { result, deployed, getAllDeps } = await getLocallyDeployableResources(session)
        
        if (deployed.has(addr)) {
            throw new Error('Resource state already exists')
        }

        const deps = await getAllDeps(addr)
        const targets = [...deps].filter(x => x !== addr && !x.startsWith('local.') && !x.startsWith('data.'))
        for (const t of targets) {
            if (!result.includes(t) && !deployed.has(t)) {
                throw new Error(`Resource depends on an undeployed resource: ${t}`)
            }
        }

        if (targets.length > 0) {
            await deploy([], { targetResources: targets })
        }
    }

    const view = await createDeployView(await getMergedGraph(template), 'import')
    const result = await session.importResource(addr, id)

    if (result.state) {
        const artifactFs = await bfs.getArtifactFs()
        await artifactFs.commit(result.state)
    }

    await shutdownSessions()
    throwIfFailed(view, result.error)

    view.dispose(colorize('green', 'Done!'))
}

export async function moveResource(from: string, to: string) {
    await compileIfNeeded(undefined, false)

    const afs = await bfs.getArtifactFs()
    const oldTemplate = await afs.maybeRestoreTemplate()
    if (!oldTemplate) {
        throw new Error('No previous template found to move from')
    }

    const session = await getSession(getTargetDeploymentIdOrThrow())
    const state = await session.getState()
    if (!state) {
        throw new Error('No previous state found to move from')
    }

    const template = await session.templateService.getTemplate()
    const graph = createSymbolGraphFromTemplate(template)

    const oldGraph = createSymbolGraphFromTemplate(oldTemplate)

    const oldMoved = await getMoved() ?? []

    if (graph.hasResource(to)) {
        const found = state.resources.find(r => `${r.type}.${r.name}` === from)
        if (!found) {
            throw new Error(`Missing resource in state: ${from}`)
        }

        if (oldMoved.find(x => x.from === from && x.to === to)) {
            return
        }

        const moves = [{ from, to }, ...oldMoved]
        await saveMoved(moves)
        return
    }

    function getResourceKeys(graph: SymbolGraph, node: ReturnType<typeof getSymbolNodeFromRef>) {
        const filtered = node.resources.filter(r => {            
            // Resource definitions aren't cleanly associated with individual resource instantiations
            const ty = graph.getResourceType( `${r.type}.${r.name}`)
            if (ty.kind === 'synapse' && r.name.endsWith('definition')) {
                return false
            }

            return true
        })

        // This is kind of a hack but it's pretty safe
        // Resource nodes returned by `getSymbolNodeFromRef` using slashed refs 
        // should prune scopes so that the returned node acts as a root
        if (filtered.length === 1) {
            const r = filtered[0]

            return [{
                absolute: `${r.type}.${r.name}`,
                relative: `${r.type}.`,
            }]
        }

        return filtered.map(r => {
            const relName = r.scopes.length > 1 ? getKeyFromScopes(r.scopes.slice(1)) : undefined
            if (!relName) {
                return
            }

            return {
                absolute: `${r.type}.${r.name}`,
                relative: `${r.type}.${relName}`,
            }
        }).filter(isNonNullable)
    }

    const fromNode = getSymbolNodeFromRef(oldGraph, from)
    const toNode = getSymbolNodeFromRef(graph, to)

    const fromKeys = getResourceKeys(oldGraph, fromNode)
    const toKeys = getResourceKeys(graph, toNode)

    const toKeysMap = new Map(toKeys.map(x => [x.relative, x.absolute]))
    
    const moves: { from: string; to: string }[] = []
    for (const k of fromKeys) {
        if (!state.resources.find(r => `${r.type}.${r.name}` === k.absolute)) {
            continue
        }

        const to = toKeysMap.get(k.relative)
        if (to && to !== k.absolute) {
            moves.push({ from: k.absolute, to })
        }
    }

    if (moves.length === 0) {
        throw new Error('Nothing to move!')
    }

    const priorMoved = await getMoved()
    if (priorMoved) {
        for (const m of priorMoved) {
            const matchFrom = moves.find(x => x.from === m.from)
            if (!matchFrom) {
                const matchTo = moves.find(x => x.to === m.to)
                if (matchTo) {
                    throw new Error(`Found move conflict [from]: ${matchTo.from} !== ${m.from}`)
                }

                moves.push(m)
                continue
            }

            if (matchFrom.to !== m.to) {
                throw new Error(`Found move conflict [to]: ${matchFrom.to} !== ${m.to}`)
            }
        }
    }

    function showMissedResources() {
        const missedResources: string[] = []
        for (const k of fromKeys) {
            if (!moves.find(m => m.from === k.absolute)) {
                missedResources.push(k.absolute)
            }
        }
    
        const missed = new Set<ReturnType<typeof getSymbolNodeFromRef>>()
        for (const r of missedResources) {
            const scope = fromNode.resources.find(n => `${n.type}.${n.name}` === r)?.scopes[1]
            if (scope) {
                // XXX: this hack could cause issues later
                // TODO: distinguish between "root" symbols and non-roots for symbol nodes
                missed.add({
                    ...(scope.assignment ?? scope.callSite),
                    id: -1,
                    resources: [],
                })
            }
        }
    
        if (missed.size === 0) {
            return
        }

        printLine(colorize('yellow', 'The following resources were not moved:'))
        for (const n of missed) {
            
            printLine(`  * ${renderSym({ ...n, fileName: path.relative(getWorkingDir(), n.fileName) })}`)
        }
    }

    await saveMoved(moves)
    printLine(`Will move ${moves.length} resource${moves.length > 1 ? 's' : ''}`)
    showMissedResources()
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

            await writeTemplate(template.binary)
            await commitProgram()

            await tfSession?.setTemplate(template.binary)

            const view = tfSession ? await getDeployView(template.json) : undefined

            await apply([...changedDeployables].map(f => path.relative(workingDirectory, f))).finally(() => {
                view?.dispose()
            })
        } else {
            await commitProgram()

            // XXX
            await afs.clearCurrentProgramStore()
        }

        await getFileHasher().flush()
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

async function resolveConfigAndDeps(opt?: CombinedOptions & { skipInstall?: boolean }) {
    const config = await resolveProgramConfig(opt)
    const incrementalHost = createIncrementalHost(config.tsc.cmd.options)

    const deps = await runTask('parse', 'deps', async () => {
        return findAllBareSpecifiers(config, await incrementalHost.getTsCompilerHost())
    }, 1)

    async function addImplicitDeps(pkg: PackageJson) {
        const proposedDeps = await getNeededDependencies(deps, pkg, config.csc as any)
        for (const k of Object.keys(proposedDeps.dependencies)) {
            const pkgDeps = (pkg as Mutable<typeof pkg>).dependencies ??= {}
            pkgDeps[k] = proposedDeps.dependencies[k]
        }

        for (const k of Object.keys(proposedDeps.devDependencies)) {
            const pkgDeps = (pkg as Mutable<typeof pkg>).devDependencies ??= {}
            pkgDeps[k] = proposedDeps.devDependencies[k]
        }

        // We persist the target if there are no other sources
        // This is mainly a convenience feature
        if (opt?.deployTarget && !pkg.synapse?.config?.target) {
            const mutable = pkg as Mutable<typeof pkg>
            const synapse: Mutable<NonNullable<typeof mutable.synapse>> = mutable.synapse ??= {}
            const synapseConfig = synapse.config ??= {}
            synapseConfig.target = opt.deployTarget
        }

        await setCompiledPkgJson(pkg)
    }

    const pkg = config.pkg
    if (!opt?.skipInstall && pkg) {
        const view = createInstallView()
        await runTask('package-init', 'add implicit deps', async () => addImplicitDeps(pkg), 1)

        const pkgWithDir: ResolvedPackage = { data: pkg, directory: getWorkingDir() }
        await runTask('package-init', 'download', () => maybeDownloadPackages(pkgWithDir, !!config.csc.noInfra), 1).catch(async e => {
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
    skipWatcher?: boolean
    hideLogs?: boolean
    logSymEval?: boolean
    forcedInfra?: string[]
    forcedSynth?: boolean
}

async function setNeedsSynth(val: boolean) {
    await getProgramFs().writeJson('[#compile]__buildState__.json', {
        needsSynth: val,
    })
}

async function getNeedsSynth() {
    const programState = await getProgramFs().readJson<{ needsSynth?: boolean }>('__buildState__.json').catch(throwIfNotFileNotFoundError)

    return programState?.needsSynth
}

export async function compile(targets: string[], opt?: CompileOptions) {
    const view = createCompileView(opt)

    const { config, incrementalHost } = await resolveConfigAndDeps(opt)

    const shouldRunWatcher = !opt?.skipWatcher && opt?.incremental !== false
    const watcherPromise = shouldRunWatcher
        ? runTask('compile', 'init watcher state', () => initOrUpdateWatcherState(), 1)
        : undefined

    const builder = createProgramBuilder(config, incrementalHost)
    const { entrypointsFile } = await runTask('compile', 'all', () => builder.emit(), 100)

    const deployTarget = config.csc.deployTarget
    const needsSynth = deployTarget && (entrypointsFile.entrypoints.length > 0 || opt?.forcedSynth)
    const shouldSkipSynth = config.csc.sharedLib || opt?.skipSynth || config.csc.noSynth || config.csc.noInfra
    if (needsSynth && !shouldSkipSynth) {
        // Fetch any existing state in the background so we can enhance the output messages
        const previousData = !opt?.skipSummary ? getPreviousDeploymentData() : undefined
        const template = await runTask('infra', 'synth', () => builder.synth(deployTarget, entrypointsFile), 10)

        await Promise.all([
            writeTemplate(template.binary),
            opt?.forcedSynth ? setNeedsSynth(false) : undefined,
            watcherPromise,
        ])

        await commitProgram()

        if (!opt?.skipSummary) {
            const showSummary = async () => view.showSimplePlanSummary(template.json, deployTarget, targets, await previousData)
            await runTask('view', 'show summary', showSummary, 1) 
        } else {
            view.done()
        }
    } else {
        await watcherPromise
        if (needsSynth && opt?.skipSynth) {
            await setNeedsSynth(true)
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
            throw new Error(`No deployment found`)
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
        const data = await getFs().readFile(target).catch(async e => {
            throwIfNotFileNotFoundError(e)

            const indexData = await getDataRepository().readData(path.basename(target))
            const index = JSON.parse(Buffer.from(indexData).toString('utf-8'))

            const dest = path.resolve('.vfs-dump')
            for (const [k, v] of Object.entries(index.files)) {
                await getFs().writeFile(path.resolve(dest, k), await getDataRepository().readData((v as any).hash))
            }    
        })

        if (!data) {
            return
        }

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
        program: await emitBlock(workspaces.toProgramRef(bt), destDir),
        process: deploymentId ? await emitBlock(deploymentId, destDir) : undefined,
    }

    await getFs().writeFile(
        path.resolve(destDir, 'ids.json'), 
        JSON.stringify(ids, undefined, 4)
    )
}

export async function showRemoteArtifact(target: string, opt?: { captured?: boolean; deployed?: boolean; infra?: boolean }) {
    const repo = getDataRepository()

    if (target.startsWith(pointerPrefix)) {
        target = target.slice(pointerPrefix.length)
    }

    if (target.includes(':')) {
        const m = await getMetadata(repo, target)
        printJson(m)

        return
    }

    const hash = await findArtifactByPrefix(repo, target)
    if (!hash) {
        throw new Error(`No artifact found: ${target}`)
    }

    if (!(await repo.hasData(hash))) {
        printLine(`Missing data ${hash}`)
        return
    }

    const contents = await repo.readData(hash)
    const text = Buffer.from(contents).toString('utf-8')
    try {
        const parsed = JSON.parse(text)
        if (opt?.captured) {
            const capturedArray = parsed['@@__moveable__']['captured']
            printJson(capturedArray)
        } else if (opt?.deployed || parsed.kind === 'deployed') {
            printLine(Buffer.from(parsed.rendered, 'base64').toString('utf-8'))
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

function gatherResources(template: TfJson, targetFiles?: Set<string>, excluded?: Set<string>) {
    const resources: Record<string, any> = {}
    for (const [k, v] of Object.entries(template.resource)) {
        for (const [k2, v2] of Object.entries(v)) {
            const id = `${k}.${k2}`
            if (excluded?.has(id)) {
                continue
            }
            if (targetFiles && (v2 as any).module_name) {
                const parsed = parseModuleName((v2 as any).module_name)
                if (!targetFiles.has(parsed.fileName)) continue
            }
            resources[id] = v2
        }
    }
    return resources
}

async function reconstructSourceMap(required: string[]) {
    const rem = new Set(required)
    const sourcemap: TerraformSourceMap = {
        symbols: [],
        resources: {},
    }

    const m = new Map<string, number>()
    function indexSymbol(sym: TerraformSourceMap['symbols'][number]) {
        const key = `${sym.fileName}:${sym.column}:${sym.line}:${sym.name}`
        if (m.has(key)) {
            return m.get(key)!
        }

        const index = sourcemap.symbols.length
        m.set(key, index)
        sourcemap.symbols.push(sym)

        return index
    }

    const template: Record<string, Record<string, any>> = {}

    const commits = await bfs.listCommits(undefined, undefined, 100)
    for (const c of commits) {
        if (rem.size === 0) break

        if (!c.programHash) continue

        const oldTemplate = await bfs.maybeRestoreTemplate(c)
        if (!oldTemplate) continue

        const oldSourceMap = oldTemplate?.['//']?.sourceMap // FIXME: make this a required field
        if (!oldSourceMap) continue

        const oldFormat = isOldSourceMapFormat(oldSourceMap)


        let didAdd = false
        const oldResources = gatherResources(oldTemplate)
        for (const [k, v] of Object.entries(oldResources)) {
            if (!rem.has(k)) continue
            const [type, name] = k.split('.')

            const g2 = sourcemap.resources[type] ??= {}

            g2[name] = oldFormat ? oldSourceMap.resources[k] as any : oldSourceMap.resources[type][name]

            if (!g2[name]) {
                delete g2[name]
                rem.delete(k)
                continue
            }

            const g = template[type] ??= {}
            g[name] = v
            didAdd = true

            for (const scope of g2[name].scopes) {
                scope.callSite = indexSymbol(oldSourceMap.symbols[scope.callSite])

                if (scope.assignment !== undefined) {
                    scope.assignment = indexSymbol(oldSourceMap.symbols[scope.assignment])
                }
                if (scope.namespace !== undefined) {
                    scope.namespace = scope.namespace.map(x => indexSymbol(oldSourceMap.symbols[x]))
                }
                if (scope.declaration !== undefined) {
                    scope.declaration = scope.declaration.map(x => indexSymbol(oldSourceMap.symbols[x]))
                }
            }

            rem.delete(k)
        }

        if (didAdd) {
            normalizeConfigs(oldTemplate)
        }
    }

    return {
        sourcemap,
        template: { resource: template } as TfJson,
    }
}

// FIXME: exclude invalid move sets (e.g. cycles)
// TODO: add way to add overrides (this command is unlikely to cover every scenario)
// TODO: selectively include files
export async function migrateIdentifiers(targets: string[], opt?: CombinedOptions & { reset?: boolean; outfile?: string }) {
    const deploymentId = getBuildTargetOrThrow().deploymentId
    const state = deploymentId ? await readState() : undefined
    if (!deploymentId || !state || state.resources.length === 0) {
        printLine(colorize('brightRed', 'No deployment to migrate'))
        return
    }

    const targetFiles = targets.length > 0 ? new Set(targets) : undefined

    // TODO: automatically compile if stale

    const session = await getSession(deploymentId)

    const reconstructed = await reconstructSourceMap(state.resources.map(r => `${r.type}.${r.name}`))
    const oldTemplate = reconstructed.template
    const oldSourceMap = reconstructed.sourcemap
    if (!oldSourceMap) {
        throw new Error(`No existing source map found`)
    }

    const templateService = session.templateService
    const template = await templateService.getTemplate()
    const newSourceMap = template['//']?.sourceMap
    if (!newSourceMap) {
        throw new Error(`No new source map found`)
    }

    const excludedOld = new Set<string>()
    const excludedNew = new Set<string>()

    for (const [type, v] of Object.entries(template.resource)) {
        for (const k of Object.keys(v)) {
            if ((v[k] as any).input?.kindHint === 'definition') {
                excludedNew.add(`${type}.${k}`)
            }
        }
    }

    const newResources = gatherResources(template, targetFiles, excludedNew)
    normalizeConfigs(template)

    for (const [type, v] of Object.entries(oldTemplate.resource)) {
        for (const k of Object.keys(v)) {
            if (k.endsWith('--definition') || (v[k] as any).input?.kindHint === 'definition') {
                excludedOld.add(`${type}.${k}`)
            }
        }
    }

    const oldResources = gatherResources(oldTemplate, targetFiles, excludedOld)

    for (const k of excludedNew) {
        deleteSourceMapResource(newSourceMap, k)
    }

    for (const k of excludedOld) {
        deleteSourceMapResource(oldSourceMap, k)
    }

    // TODO: we _need_ to cross-reference the template with the actual state before proceeding
    // TODO: check existing moves

    const moves = runTask(
        'refactoring', 
        'tree edits', 
        () => detectRefactors(newResources, newSourceMap, oldResources, oldSourceMap, {}, {}), 
        100
    )

    if (moves.length === 0) {
        printLine(colorize('green', 'No resources need to be moved'))

        return
    }

    if (opt?.outfile) {
        const resolved = path.resolve(getWorkingDir(), opt.outfile)
        const serialized = JSON.stringify(
            Object.fromEntries(moves.map(m => [m.from, m.to]))
        )

        await getFs().writeFile(resolved, serialized)
        return
    }

    showMoves(moves)

    // XXX: remove the symbol info
    const prunedMoves = moves.map(m => ({ from: m.from, to: m.to }))
    await saveMoved(prunedMoves)

    printLine()
    printLine(`The next ${renderCmdSuggestion('deploy', undefined, false)} command will apply these moves.`)
}

function showMoves(moves: MoveWithSymbols[]) {
    function printMove(move: (typeof moves)[number]) {
        const { fromSymbol, toSymbol } = move        

        return renderMove(fromSymbol, toSymbol)
    }

    function getDedupedMoves() {
        const s = new Set<string>()
        for (const m of moves) {
            s.add(printMove(m))
        }

        return [...s]
    }

    printLine(`Will move:`)
    for (const m of getDedupedMoves()) {
        printLine(`  * ${m}`)
    }
}

async function tryFindAutomaticMoves(state: TfState) {
    const [oldTemplate, newTemplate] = await Promise.all([
        bfs.maybeRestoreTemplate(),
        bfs.getCurrentTemplate(),
    ])

    const oldSourceMap = oldTemplate?.['//']?.sourceMap
    const newSourceMap = newTemplate?.['//']?.sourceMap
    if (!oldSourceMap || !newSourceMap) {
        return
    }

    const oldResources = gatherResources(oldTemplate)
    const newResources = gatherResources(newTemplate)

    const autoMoves = findAutomaticMoves(
        state, 
        createSymbolGraph(oldSourceMap, oldResources), 
        createSymbolGraph(newSourceMap, newResources)
    )

    getLogger().debug('Unmatched from state', autoMoves.unmatched.state)
    getLogger().debug('Unmatched from template', autoMoves.unmatched.template)

    return autoMoves.moved
}

async function loadMovedIntoTemplate(fileName: string, merge = true) {
    const [moved = {}, state] = await Promise.all([
        getFs().readFile(fileName, 'utf-8').then(JSON.parse).catch(throwIfNotFileNotFoundError),
        readState()
    ])

    if (!state) {
        return
    }

    if (!moved || typeof moved !== 'object') {
        throw new Error(`Moved file must contain an object`)
    }

    const resourceSet = new Set(state?.resources.map(r => `${r.type}.${r.name}`))

    const [checked = [], autoMoved] = await Promise.all([
        merge ? getMoved() : undefined,
        tryFindAutomaticMoves(state),
    ])

    function addMove(from: string, to: string) {
        const conflicts = checked.filter(x => x.from === from || x.to === to)
        if (conflicts.length === 0) {
            checked.push({ from, to })

            return true
        }

        const withoutDupes = conflicts.filter(x => x.from !== from || x.to !== to)
        if (withoutDupes.length === 0) {
            return false
        }

        if (withoutDupes.length === 1 && withoutDupes[0].from === from) {
            getLogger().log(`Overriding move: ${from} -> ${to} [previvously ${withoutDupes[0].to}]`)
            checked.splice(checked.indexOf(withoutDupes[0]), 1, { from, to })
            return true
        }

        const overrides = withoutDupes.filter(x => x.to === to)
        if (overrides.length === 1) {
            getLogger().log(`Overriding move: ${from} [previvously ${overrides[0].from}] -> ${to}`)
            checked.splice(checked.indexOf(overrides[0]), 1, { from, to })
            return true
        } else {
            getLogger().warn(`Found conflicting move: ${from} -> ${to}`, withoutDupes)
        }

        return false
    }

    if (autoMoved) {
        for (const m of autoMoved) {
            addMove(m.from, m.to)
        }
    }

    for (const [k, v] of Object.entries(moved)) {
        if (typeof v !== 'string') {
            throw new Error(`"from" is not a string: ${JSON.stringify(v)} [key: ${k}]`)
        }

        // TODO: validate that `v` is in the current template

        if (resourceSet.has(v)) {
            getLogger().log(`Resource already exists: ${v}`)
            continue
        }

        addMove(k, v)
    }

    if (checked.length === 0) {
        // We need to persist the empty set to clear out the old state
        if (!merge) {
            await saveMoved(checked)
        }
        return
    }

    await saveMoved(checked)

    for (const m of checked) {
        getLogger().log(`Will move: ${m.from.split('.')[1]} -> ${m.to.split('.')[1]}`)
    }

    return checked
}

export async function loadMoved(fileName: string, merge?: boolean) {
    const moved = await loadMovedIntoTemplate(fileName, merge)
    if (moved) {
        await commitProgram()
    }

    return moved
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

export async function listDeployments(type?: string, opt?: CombinedOptions & { all?: boolean }) {
    const rootDir = workspaces.getRootDir()
    const deployments = await workspaces.listAllDeployments()
    for (const [k, v] of Object.entries(deployments)) {
        const rel = makeRelative(rootDir, v.workingDirectory)

        if (!opt?.all && rel.startsWith('..')) continue

        const stats = await getFs().stat(v.workingDirectory).catch(throwIfNotFileNotFoundError)
        if (stats?.type !== 'directory') {
            getLogger().log('Removing invalid program', v.workingDirectory)
            // TODO: this orphans the app
            await workspaces.deleteProgram(v.projectId, v.programId)
            continue
        }

        const s = await readState(getDeploymentFs(k, v.programId, v.projectId))
        const isRunning = s && s.resources.length > 0
        const status = colorize(isRunning ? 'green' : 'gray', isRunning ? 'RUNNING' : 'STOPPED')
        const info = `(${rel || '.'}) [${status}]${v.environment ? ` [env: ${v.environment}]` : ''}`
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

const examplesRepoUrl = 'https://github.com/Cohesible/synapse'
async function initFromRepo(name: string, dest: string) {
    const repo = await openRemote(examplesRepoUrl)
    const prefix = `examples/${name}/`
    const files = repo.files.filter(f => f.name.startsWith(prefix))
    if (files.length === 0) {
        throw new Error(`No example found named "${name}"`)
    }

    try {
        return await checkFilesAndInit(dest, Object.fromEntries(files.map(f => [f.name.slice(prefix.length), f.read()])))
    } finally {
        await repo.dispose()
    }
}

// `null` means "this is written somewhere else"
async function checkFilesAndInit(dir: string, files: Record<string, string | Uint8Array | Promise<Uint8Array> | null>) {
    const toRootDir = (f: string): string => [f, '.'].includes(path.dirname(f)) ? f : toRootDir(path.dirname(f))

    // Only check top-level directories. Why? Because adding files to existing directories can be very confusing.
    // TODO: log which source file(s) conflict ?
    // Also, checking that the contents don't match would be better. But that's for another day.
    const roots = [...new Set(Object.keys(files).map(toRootDir))]
    const conflicts = (await Promise.all(
        roots.map(async f => await getFs().fileExists(f) ? f : undefined)
    )).filter(isNonNullable)

    if (conflicts.length > 0) {
        const dirName = dir === process.cwd() ? 'The current directory' : path.relative(process.cwd(), dir)
        throw new Error(`${dirName} contains conflicting files:\n${conflicts.map(x => `  ${x}\n`).join('')}`)
    }

    const filtered = Object.entries(files).filter(([_, v]) => v !== null) as [string, string | Uint8Array | Promise<Uint8Array>][]
    await Promise.all(filtered.map(async ([k, v]) => getFs().writeFile(
        path.resolve(dir, k),
        await v
    )))

    return Object.keys(files)
}

export async function init(opt?: { template?: string }) {
    const dir = process.cwd()

    async function compilePrograms(files: string[]) {
        const programDirs = new Set<string>()
        for (const f of files.map(x => path.resolve(dir, x))) {
            if (path.basename(f) === 'package.json' || path.basename(f) === 'tsconfig.json') {
                programDirs.add(path.dirname(f))
            }
        }

        const programs = [...programDirs]
        if (programs.length === 1 && programs[0] === process.cwd()) {
            return compile([], { skipSynth: true })
        }

        if (programs.length === 0) {
            // This is unexpected and likely an error somewhere
            throw new Error('No programs found')
        }

        // Building a project with multiple programs/packages requires more sophisticated logic
        // that I have not yet implemented. We need to construct a package-level dependency
        // graph and compile/publish the nodes. Of course, publishing a package without deployment 
        // leaves the package as a stub which may or may not play nicely with dependent packages.
        getLogger().log('Skipping compile due to multiple programs', programs)
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
        
        printLine(colorize('green', `Created files:`))
        for (const f of filesCreated) {
            printLine(colorize('green', `  ${f}`))
        }

        await compilePrograms(filesCreated)

        printLine()

        const readmeFile = filesCreated.find(f => f.toLowerCase().endsWith('readme.md'))
        if (readmeFile) {
            const relPath = path.relative(process.cwd(), path.resolve(dir, readmeFile))
            const relPathWithDir = path.dirname(relPath) === '.' ? `./${relPath}` : relPath // Little enhancement for `vscode`
            printLine(`Open ${relPathWithDir} to get started`)

            return
        }
    
        const deployCmd = renderCmdSuggestion('deploy')
        const targetOption = colorize('gray', '--target aws')
    
        printLine(`You can now use ${deployCmd} to deploy your code!`)
        printLine()
        printLine(`By default, your code is built for and deployed to a "local" target.`)
    
        const probablyHasAwsCredentials = await detectAwsCredentials()

        if (probablyHasAwsCredentials) {
            printLine(`You can target AWS by adding ${targetOption} to a compile or deploy command.`)
            printLine(`The target is remembered for subsequent commands.`)
        } else {
            const docsLink = colorize('gray', '<placeholder>')
            printLine(`Deploying to other targets requires credentials specific to the target.`)
            printLine(`For more information, see: ${docsLink}`)
        }
    }

    if (opt?.template) {
        const files = await initFromRepo(opt.template, dir)

        return showInstructions(files)
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

    const created = await checkFilesAndInit(dir, { 'hello.ts': text, 'tsconfig.json': JSON.stringify({}) })
    await showInstructions(created)
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
    const commits = await listCommits(opt?.useProgram ? workspaces.toProgramRef(getBuildTargetOrThrow()) : undefined)
    if (commits.length === 0) {
        printLine(colorize('brightRed', 'No commits found'))
        return
    }

    if (!opt?.useProgram) {
        printLine(`${'Timestamp'.padEnd(timestampWidth, ' ')} ${'Deployment'.padEnd(hashWidth, ' ')} ${'Program'.padEnd(hashWidth, ' ')} ${'IsTest?'}`)
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
    for (const l of r) {
        printLine(l)
    }
}

async function runProgramExecutable(fileName: string, args: string[]) {
    const moduleLoader = await runTask('init', 'loader', () => getModuleLoader(false, true), 1) // 8ms on simple hello world no infra
    const m = await moduleLoader.loadModule(fileName)    
    if (typeof m.main !== 'function') {
        throw new Error(`Missing main function in file "${fileName}", found exports: ${Object.keys(m)}`)
    }

    await runTask('ui', 'release tty', () => getDisplay().releaseTty(false), 1)

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

async function getChangedEnvVarsForSynth() {
    const template = await bfs.getCurrentTemplate()
    const envVars = template?.['//']?.envVarHashes
    if (!envVars) {
        getLogger().log('No environment variable hashes found')
        return
    }

    await maybeLoadEnvironmentVariables(bfs.getProgramFs())

    const diff: string[] = []
    for (const [k, v] of Object.entries(envVars)) {
        const current = getEnvVarHash(process.env[k])
        if (current !== v) {
            diff.push(k)
        }
    }

    if (diff.length === 0) {
        return
    }

    return diff
}

async function compileIfNeeded(target?: string, skipSynth = true) {
    // XXX: we should normalize everything at program entrypoints
    if (isWindows() && target) {
        target = target.replaceAll('/', '\\')
    }

    // TODO: we can skip synth if the stale files aren't apart of the synthesis dependency graph
    // TODO: if `run` automatically compiles anything, it should _always_ use the last-used settings
    const { stale, removed, sources } = await getStaleSources() ?? {}
    const compileOpt = { incremental: true, skipSummary: true, skipSynth: !!stale && skipSynth, skipWatcher: !!sources }
    if (!sources || (stale && stale.size > 0) || (!skipSynth && removed && removed.size > 0)) {
        // We don't need to generate a template, we just want updated program analyses
        // TODO: mark the current compilation as "needs synth"
        return compile(target ? [target] : [], compileOpt)
    }

    const workingDir = getWorkingDir()
    const zigGraph = await runTask('zig', 'graph check', 
        () => getZigCompilationGraph(
            Object.keys(sources).map(f => path.resolve(workingDir, f)), 
            workingDir
        ),
        1
    )

    if (zigGraph && zigGraph.changed.size > 0) {
        return compile(target ? [target] : [], compileOpt)
    }

    if (skipSynth) {
        return
    }

    const diff = await getChangedEnvVarsForSynth()
    if (diff) {
        getLogger().log(`Synthesis environment variables changed: ${diff}`)

        return compile(target ? [target] : [], { ...compileOpt, skipSynth: false })
    }
}

async function getDeploymentStatus(target: string, deployables: Record<string, string>) {
    const opt = await getResolvedTsConfig()
    const incr = createIncrementalHost(opt?.options ?? {})

    const [deps, info, sources] = await Promise.all([
        incr.getCachedDependencies(path.resolve(getWorkingDir(), target)),
        getPreviousDeployInfo(),
        bfs.readSources(),
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
        info,
        isTargetDeployable,
        needsDeploy,
        staleDeploys,
        sources,
    }
}

async function validateTargetsForExecution(targets: string, deployables: Record<string, string>, canPrompt = process.stdin.isTTY) {
    const status = await getDeploymentStatus(targets, deployables)
    const resourcesNeedDeployMessage = colorize('brightRed', 'Resources in the target file need to be deployed')

    function printNotDeployedError() {
        function printSuggestion() {
            printLine()

            const deployCmd = renderCmdSuggestion('deploy', status.needsDeploy)
            printLine(`Run ${deployCmd} first and try again.`)
            printLine()
        }

        if (status.needsDeploy.length === 1 && status.needsDeploy[0] === targets) {
            printLine(resourcesNeedDeployMessage)
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
    }

    async function promptForDeploy(message: string) {
        printLine(message)
        print(colorize('blue', 'Deploy now?'))

        const bt = getBuildTargetOrThrow()
        const canDefaultYes = !bt.environmentName || bt.environmentName === 'local'

        const resp = await promptForInput(canDefaultYes ? ' (Y/n): ' : ' (y/N): ')

        function canDeploy() {
            const trimmed = resp.trim().toLowerCase()
            if (!trimmed) {
                return canDefaultYes
            }

            switch (trimmed) {
                case 'n':
                case 'no':
                    return false

                case 'y':
                case 'yes':
                    return true
            }

            return false
        }
    
        if (!canDeploy()) {
            return false
        }
    
        await deploy([targets])
        return true
    }

    if (status.needsDeploy.length > 0) {
        if (!canPrompt) {
            throw new RenderableError('Program not deployed', printNotDeployedError)
        }

        if (!(await promptForDeploy(resourcesNeedDeployMessage))) {
            throw new CancelError('Cancelled deploy')
        }

        return status
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

        const needsUpdateMessage = colorize('brightYellow', 'Deployment has not been updated with the latest changes')
        if (!canPrompt) {
            printLine(needsUpdateMessage)
        } else {
            await promptForDeploy(needsUpdateMessage)
        }
    }

    return status
}

type RunOptions = CombinedOptions & { skipValidation?: boolean; skipCompile?: boolean; noDeploy?: boolean }

export async function run(name: string | undefined, args: string[], opt?: RunOptions) {
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

    // Normalize name relative to cwd
    if (name) {
        name = makeRelative(getBuildTargetOrThrow().workingDirectory, name)
    }

    const deployables = files.deployables ?? {}
    const entries = Object.entries(executables)
    const match = !name ? entries[0] : entries.find(([k, v]) => k === name)
    if (!match) {
        throw new Error(`No executable found matching: ${name} [available: ${entries.map(e => e[0]).join(', ')}]`)
    }

    const [source, output] = match

    if (!opt?.skipValidation) {
        const status = await validateTargetsForExecution(source, deployables, !opt?.noDeploy)

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

export async function replCommand(target?: string, opt?: {}) {
    const repl = await runTask('', 'repl', async () => {
        if (!target) {              
            return enterRepl(undefined, { loadModule: (id) => import(id) }, {})
        }
    
        target = normalizeToRelative(target)
        await compileIfNeeded(target)

        const files = await getEntrypointsFile()
        const typesFile = await getTypesFile()
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
    
        return enterRepl(resolved, moduleLoader, {
            types: typesFile?.[target.replace(/\.tsx?$/, '.d.ts')],
        })
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

// FIXME: this is wrong, we need to track the program hash per-file
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
    const deploySources = await bfs.readSources(oldProgramFs)

    return { state, hash, deploySources }
}

async function getStaleSources(include?: Set<string>) {
    const [sources, changes] = await Promise.all([
        bfs.readSources(),
        maybeDetectChanges()
    ])

    if (!sources) {
        return
    }

    // Check hashes
    const hasher = getFileHasher()
    const workingDir = getWorkingDir()
    const stale = new Set<string>()
    const removed = new Set<string>()
    const shouldSkip = new Set<string>()

    if (changes) {
        for (const k of Object.keys(sources)) {
            shouldSkip.add(k)
        }

        for (const c of changes) {
            if (c.is_added) {
                getLogger().log('Found new source file', c.subpath)
                stale.add(resolveRelative(workingDir, c.subpath))
            } else if (c.is_removed) {
                if (delete sources![c.subpath]) {
                    getLogger().log('Found removed source file', c.subpath)
                    removed.add(c.subpath)
                    shouldSkip.delete(c.subpath)
                } else {
                    getLogger().log('Found extraneous removed file', c.subpath)
                }
            } else {
                getLogger().log('Found changed source file', c.subpath)
                shouldSkip.delete(c.subpath)

                // Needed to handle re-checking potentially "deployable" files
                include?.add(resolveRelative(workingDir, c.subpath))
            }
        }
    }

    async function checkSource(k: string, v: { hash: string }) {
        if (shouldSkip.has(k)) return

        const source = resolveRelative(workingDir, k)
        if (include && !include.has(source)) return

        const hash = await hasher.getHash(source).catch(throwIfNotFileNotFoundError)
        if (!hash) {
            delete sources![k]
        } else if (v.hash !== hash) {
            stale.add(source)
        }
    }

    await Promise.all(Object.entries(sources).map(([k, v]) => checkSource(k, v)))

    return { stale, sources, removed }
}

// This is used to see if we need to re-synth
async function getStaleDeployableSources(targets?: string[]) {
    const deployables = await getDeployables()
    if (!deployables) {
        return getStaleSources()
    }

    const resolvedOptions = await getResolvedTsConfig()
    const deployableSet = new Set(Object.keys(deployables).map(k => resolveRelative(getWorkingDir(), k)))
    const incr = createIncrementalHost(resolvedOptions?.options ?? {})
    const deps = await incr.getCachedDependencies(...(deployableSet))
    const allDeps = getAllDependencies(deps, targets?.map(x => resolveRelative(getWorkingDir(), x)) ?? [...deployableSet])
    const result = await getStaleSources(allDeps.deps)
    if (!result) {
        return
    }

    // Small optimization: we don't need to resynth if the removed files aren't deployable
    const removed = new Set([...result.removed].map(k => resolveRelative(getWorkingDir(), k)).filter(k => deployableSet.has(k)))

    return { ...result, removed }
}

export async function showStatus(opt?: { verbose?: boolean }) {
    // Current env and target?
    // Packages (installation)
    // Compile 
    // Deploy (pending moves)
    // Projects?

    const bt = getBuildTargetOrThrow()
    if (bt.environmentName && bt.environmentName !== 'local') {
        printLine(`env: ${colorize('cyan', bt.environmentName)}`)
        printLine()
    }

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
    const state = info?.state
    if (!info?.deploySources || !state || state.resources.length === 0) {
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
            const resourceSet = new Set(state.resources.map(r => `${r.type}.${r.name}`))
            const filtered = moved.filter(x => resourceSet.has(x.from))
            if (filtered.length > 0) {
                const oldTemplate = await maybeRestoreTemplate()
                if (!oldTemplate) {
                    throw new Error(`Missing template for hash: ${info.hash}`)
                }

                const newTemplate = await bfs.getTemplate(programFs)
                if (!newTemplate) {
                    throw new Error(`Missing template for hash: ${currentHash}`)
                }

                const oldGraph = createSymbolGraphFromTemplate(oldTemplate)
                const newGraph = createSymbolGraphFromTemplate(newTemplate)
                const moves = getMovesWithSymbols(filtered, oldGraph, newGraph)

                printLine()
                showMoves(moves)
            }
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

async function cleanTests(deploymentId = getBuildTargetOrThrow().deploymentId) {
    if (deploymentId) {
        await getDataRepository().deleteHead(`${deploymentId}_test`)
    }
}

async function cleanDeployment(deploymentId = getBuildTargetOrThrow().deploymentId) {
    if (deploymentId) {
        await getDataRepository().deleteHead(`${deploymentId}`)
    }
}

// This is safe because deployments always reference fs hashes not head IDs
export async function clean(opt?: { packages?: boolean; tests?: boolean; deployment?: boolean; program?: boolean }) {
    const bt = getBuildTargetOrThrow()
    if (opt?.tests) {
        return cleanTests(bt.deploymentId)
    }

    // Potentially dangerous, can be difficult to recover
    if (opt?.deployment) {
        return cleanDeployment(bt.deploymentId)
    }

    // Useful for testing that compilation and deployment are deterministic.
    // We preserve the test cache in this case. Fully deterministic builds 
    // should not mutate the deployment nor invalidate any cached tests.
    if (opt?.program) {
        return getDataRepository().deleteHead(workspaces.toProgramRef(bt))
    }

    await Promise.all([
        bt.deploymentId ? clearCachedTestResults() : undefined,
        getDataRepository().deleteHead(workspaces.toProgramRef(bt)),
        getFs().deleteFile(workspaces.getWatcherStateFilePath()).catch(throwIfNotFileNotFoundError),
    ])
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

export async function printFsStats(opt?: { all?: boolean }) {
    if (opt?.all) {
        const repoStats = await collectAllStats(getDataRepository())
        const stats = { ...mergeRepoStats(repoStats), type: 'unknown' as const }
        await printStats('ALL', stats)
        await printTopNLargestObjects(stats)
        return
    }

    const head = workspaces.toProgramRef(getBuildTargetOrThrow())
    const stats = await collectStats(getDataRepository(), head)
    await printStats(head, stats)

    await printTopNLargestObjects(stats)
}

export async function runUserScript(target: string, args: string[]) {
    const loader = createMinimalLoader(target.endsWith('.ts'))
    const module = await loader.loadModule(target)
    if (typeof module?.main !== 'function') {
        return module
    }

    const code = await module.main(...args)
    if (typeof code === 'number' && !isNaN(code)) {
        process.exitCode = code
    }

    return code
}

interface BuildExecutableOpt {
    readonly os?: 'windows' | 'linux' | 'darwin'
    readonly arch?: 'aarch64' | 'x64'
    readonly sea?: boolean
    readonly minify?: boolean
    readonly lazyLoad?: string[]
    readonly synapsePath?: string
}

export async function buildExecutables(targets: string[], opt: BuildExecutableOpt) {
    await compileIfNeeded(targets[0])

    const bt = getBuildTargetOrThrow()
    const pkg = await getCurrentPkg()
    if (!pkg) {
        throw new Error(`No package.json found`)
    }

    const executables = await getExecutables()
    if (!executables) {
        throw new Error(`No executables to build`)
    }

    function getSyntheticBin() {
        if (targets.length === 0) {
            // If there's only one possible option, use it
            const execs = Object.keys(executables!)
            if (execs.length === 1) {
                targets = execs
            }
        }

        if (targets.length !== 1) {
            return
        }

        const outfile = executables![targets[0]]
        if (!outfile) {
            return
        }

        const binName = path.basename(targets[0]).replace(path.extname(targets[0]), '')

        return { [binName]: outfile }
    }

    const bin = getPkgExecutables(pkg.data) ?? getSyntheticBin()
    if (!bin) {
        throw new Error(`Found executables but failed to map them to outputs`)
    }

    const set = new Set(Object.values(executables).map(k => path.resolve(bt.workingDirectory, k)))

    async function _getBasePath() {
        if (opt.synapsePath) {
            return opt.synapsePath
        }

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

    const getBasePath = memoize(_getBasePath)

    // XXX: this is hard-coded to `synapse`
    const bundleOpt: InternalBundleOptions = pkg.data.name === 'synapse' ? {
        ...opt,
        external: ['esbuild', 'typescript', 'postject'], 
        lazyLoad: ['@cohesible/*', 'typescript', 'esbuild', ...lazyNodeModules],
        extraBuiltins: ['typescript', 'esbuild'],
    } : {
        ...opt,
        runtimeExecutable: opt.synapsePath,
    }

    if (pkg.data.name === 'synapse') {
        process.env.CURRENT_PACKAGE_DIR = pkg.directory
    }

    const config = (await getResolvedTsConfig())?.options
    const outDir = config?.outDir ?? 'out'

    const host = resolveBuildTarget()
    const isCrossCompilation = (opt.arch && opt.arch !== host.arch) || (opt.os && opt.os !== host.os)
    if (isCrossCompilation) {
        throw new Error('Cross-compilation is not yet supported')
    }

    const basePath = await getBasePath()

    for (const [k, v] of Object.entries(bin)) {
        const resolved = path.resolve(bt.workingDirectory, v)
        if (!set.has(resolved)) continue

        const outfile = !config?.outDir ? path.resolve(bt.workingDirectory, 'out', v) : undefined

        const res = await bundleExecutable(bt, resolved, outfile, undefined, bundleOpt)
        const dest = path.resolve(bt.workingDirectory, outDir, 'bin', isWindows() ? `${k}.exe` : k)

        if (opt.sea) {
            try {
                await makeSea(res.outfile, basePath, dest, {
                    assets: res.assets, 
                })
            } finally {
                await getFs().deleteFile(res.outfile)
            }
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
    await makeSea(bundledCliPath, nodePath, seaDest, {
        assets,
        sign: true,
    })

    await getFs().deleteFile(nodePath)
    await getFs().deleteFile(path.resolve(dir, 'dist', 'cli.js'))
    await getFs().deleteFile(path.resolve(dir, 'node_modules')).catch(throwIfNotFileNotFoundError)
    if (hasAssets) {
        await getFs().deleteFile(path.resolve(dir, 'assets'))
    }

    await createArchive(dir, `${dir}${process.platform === 'linux' ? `.tgz` : '.zip'}`, false)
}
