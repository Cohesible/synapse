import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { Fs, SyncFs } from './system'
import { DeployOptions } from './deploy/deployment'
import { Remote, findRepositoryDir, findRepositoryDirSync, getCurrentBranch, getDefaultBranch, listRemotes } from './git'
import { getLogger } from './logging'
import { getCiType, getHash, keyedMemoize, makeRelative, memoize, throwIfNotFileNotFoundError, tryReadJson, tryReadJsonSync } from './utils'
import { glob } from './utils/glob'
import { getBuildTarget, getBuildTargetOrThrow, getFs, isInContext } from './execution'
import * as projects from '@cohesible/resources/projects'
import * as registry from '@cohesible/resources/registry'
import { getPackageJson } from './pm/packageJson'
import { randomUUID } from 'node:crypto'

// TODO: investigate using a relational db here like sqlite 

// Workspaces are state + source code!!!
// A workspace is directly tied to a source control repo
// State is isolated per-branch. Each branch can be thought as its own 
// independent version of the app.
//
// "Merging" branches _never_ merges state, only source code. State is updated
// using the new source code. Failures to update the state result in a rollback.

// IMPORTANT:
// need to implement this
// https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html

export interface Workspace {
    readonly id: string
    readonly defaultBranch?: string
}

export interface LocalWorkspace extends Workspace {
    readonly directory: string
    readonly currentBranch: string
    readonly buildDirectory?: string
    readonly deployOptions?: DeployOptions
}

export type SynapseConfiguration = DeployOptions & {
    readonly exposeInternal?: boolean
}

const synDirName = '.synapse'

// We should only follow this spec for Linux/macOS
// TODO: what about Windows?
//
// XDG_DATA_HOME - defaults to $HOME/.local/share
// XDG_CONFIG_HOME - defaults to $HOME/.config
// XDG_STATE_HOME - for persisent but not super important data e.g. logs, defaults to $HOME/.local/state
// XDG_CACHE_HOME - defaults to $HOME/.cache
// XDG_RUNTIME_DIR - sockets, named pipes, must have o700 perms
//  - no explicit fallback specified
// * User-specific executable files may be stored in $HOME/.local/bin.
// * If an implementation encounters a relative path in any of these variables it should consider the path invalid and ignore it. 
//
// const shouldUseXdg = true

export function getUserSynapseDirectory() {
    return process.env['SYNAPSE_INSTALL'] ?? path.resolve(os.homedir(), synDirName)
}

export function getPackageCacheDirectory() {
    return path.resolve(getGlobalCacheDirectory(), 'packages')
}

export function getLinkedPackagesDirectory() {
    return path.resolve(getPackageCacheDirectory(), 'linked')
}

export function getLogsDirectory() {
    return path.resolve(getUserSynapseDirectory(), 'logs')
}

export function getDeploymentBuildDirectory(buildTarget: Pick<BuildTarget, 'deploymentId' | 'rootDirectory' | 'buildDir'>) {
    return path.resolve(buildTarget.buildDir, 'deployments', buildTarget.deploymentId!)
}

export function getGlobalCacheDirectory() {
    return path.resolve(getUserSynapseDirectory(), 'cache')
}

export function getV8CacheDirectory() {
    return path.resolve(getGlobalCacheDirectory(), 'v8')
}

export function getProviderTypesDirectory(workingDirectory: string) {
    return path.resolve(workingDirectory, 'node_modules', '@types', 'synapse-providers')
}

export function getProviderCacheDir() {
    return path.resolve(getGlobalCacheDirectory(), 'providers')
}

export function getBinDirectory() {
    return path.resolve(getUserSynapseDirectory(), 'bin')
}

export function getGitDirectory() {
    return path.resolve(getUserSynapseDirectory(), 'git')
}

export function getUserEnvFileName() {
    return path.resolve(getUserSynapseDirectory(), 'env')
}

export function getToolsDirectory() {
    return path.resolve(getUserSynapseDirectory(), 'tools')
}

export function getSocketsDirectory() {
    return path.resolve(getUserSynapseDirectory(), 'sockets')
}

export function getUserConfigFilePath() {
    return path.resolve(getUserSynapseDirectory(), 'config.json')
}

export function getTempZigBuildDir() {
    const bt = getBuildTargetOrThrow()

    return path.resolve(getGlobalZigBuildDir(), getHash(toProgramRef(bt)))
}

export function getGlobalZigBuildDir() {
    return path.resolve(getBuildTargetOrThrow().buildDir, 'zig')
}

export interface Project {
    readonly id: string
    readonly name: string
    readonly apps?: Record<projects.AppInfo['id'], projects.AppInfo>
    readonly programs?: Record<Program['id'], Program>

    // This associates packages with a particular program
    readonly packages?: Record<string, Program['id']>
}

export interface Program {
    readonly id: string
    readonly name?: string
    readonly workingDirectory?: string
    readonly deployOptions?: any
    readonly branch?: string
}

export interface Deployment {
    readonly id: string
    readonly name?: string
    readonly program: Program['id']
    readonly project: Project['id']
}

interface Environment {
    readonly name: string
    readonly config?: Record<string, any>
}

interface BuildTargetOptions {
    // readonly branch?: string
    readonly project?: Project['name'] | Project['id']
    readonly program?: Program['name'] | Program['id']
    readonly deployment?: Deployment['name'] | Deployment['id']
    readonly environmentName?: Environment['name']
}

const getCurrentBranchCached = keyedMemoize(async (dir: string) => {
    // Reading the HEAD file directly is a bit faster than calling `git`
    const headPath = path.resolve(dir, '.git', 'HEAD')
    const head = await getFs().readFile(headPath, 'utf-8').catch(throwIfNotFileNotFoundError)
    if (!head) {
        return
    }

    return head.match(/^ref: refs\/heads\/(.+)$/)?.[1]
})

async function getDeploymentById(id: string) {
    const ents = await getEntities()
    const deployment = ents.deployments[id]
    if (!deployment) {
        throw new Error(`No deployment found: ${id}`)
    }

    return deployment
}

async function getProjectDirectory(id: string) {
    const ents = await getEntities()
    const rootDirectory = ents.projects[id]?.directory
    if (!rootDirectory) {
        throw new Error(`Missing project: ${id}`)
    }

    return rootDirectory
}

function getProjectDirectorySync(id: string) {
    const ents = getEntitiesSync()
    const rootDirectory = ents.projects[id]?.directory
    if (!rootDirectory) {
        throw new Error(`Missing project: ${id}`)
    }

    return rootDirectory
}

async function tryInitProject(cwd: string) {
    const gitRepo = findRepositoryDirSync(cwd)
    if (!gitRepo) {
        return
    }

    const remotes = await listRemotes(gitRepo)
    if (remotes.length === 0) {
        return
    }

    return initProject(gitRepo, remotes)
}

async function findProject(cwd: string) {
    const found = await findProjectFromDir(cwd)
    if (!found) {
        return
    }

    return {
        ...found,
        rootDir: found.directory
    }
}

function getProgramIdNoPkg(workingDirectory: string, rootDir: string) {
    const base = makeRelative(rootDir, workingDirectory)
    if (!base) {
        return '__dir__root__'
    }

    return `__dir__${base}`
}

interface FindProgramResult {
    programName: string,
    workingDirectory: string
    branchName?: string
    existing?: projects.ProgramInfo
}

async function findProgram(cwd: string, rootDir: string, projectId: string): Promise<FindProgramResult> {
    const relPath = makeRelative(rootDir, cwd)
    if (relPath.startsWith('..')) {
        throw new Error(`Current directory "${cwd}" is not inside project directory: ${rootDir}`)
    }

    const pkg = await getPackageJson(getFs(), cwd, false)
    const workingDirectory = pkg?.directory ?? cwd
    const programName = pkg?.data.name ?? getProgramIdNoPkg(workingDirectory, rootDir)
    const branchName = await getCurrentBranchCached(rootDir)
    const relativeWorkingDir = cwd === rootDir ? undefined : relPath

    const state = await getProjectState(projectId)
    const base = {
        programName,
        workingDirectory,
        branchName,
    }

    if (!state) {
        return base
    }

    const defaultBranch = await getDefaultBranchCached(projectId)
    if (branchName !== defaultBranch) {
        (state.branches as any) ??= {}
    }

    const programs = branchName && branchName !== defaultBranch 
        ? state.branches![branchName]?.programs
        : state.programs

    const existing = programs?.[programName]
    
    // XXX: temporary backwards compat
    if (existing && process.platform === 'win32' && existing.workingDirectory) {
        existing.workingDirectory = existing.workingDirectory.replaceAll('\\', '/')
    }

    if (existing && existing.workingDirectory !== relativeWorkingDir) {
        throw new Error(`Conflicting programs "${programName}": existing workingDir ${existing.workingDirectory ?? '<root>'} !== ${relativeWorkingDir ?? '<root>'}`)
    }

    if (!existing) {
        if (branchName && branchName !== defaultBranch) {
            getLogger().debug(`Initialized program "${programName}@${branchName}"`)
            const branch = state.branches![branchName] ??= { apps: {}, programs: {} }
            branch.programs[programName] = { workingDirectory: relativeWorkingDir }
        } else {
            getLogger().debug(`Initialized program "${programName}"`)
            state.programs[programName] = { workingDirectory: relativeWorkingDir }
        }

        await setProjectState(state)
    }

    return {
        programName,
        workingDirectory,
        branchName,
        existing,
    }
}

// [<projectId>+:+]<programId>[@<branchName>]
function parseProgramRef(ref: string): { id: string; branchName?: string; projectId?: string } {
    const [projectId, rem] = ref.match(/^([^:\s]+)\+:\+([^\s]+)$/) ?? []
    const [id, branchName] = (rem ?? ref).match(/^([^@\s]+)(?:@([^@\s]+))$/) ?? []
    if (!id) {
        throw new Error(`Failed to parse program ref: ${ref}`)
    }

    return { id, branchName, projectId }
}

export function toProgramRef(bt: Pick<BuildTarget, 'programId' | 'projectId' | 'branchName'>) {
    const base = bt.branchName ? `${bt.programId}@${bt.branchName}` : bt.programId

    return bt.projectId ? `${bt.projectId}+:+${base}` : base
}

// TODO: this should only match if the target source file is included by the config
async function tryFindTsConfig(dir: string, recurse = false) {
    const config = await getFs().readFile(path.resolve(dir, 'tsconfig.json'), 'utf-8').catch(throwIfNotFileNotFoundError)
    if (config) {
        return { directory: dir, data: config }
    }
    
    if (!recurse) {
        return
    }

    const nextDir = path.dirname(dir)
    if (nextDir !== dir) {
        return tryFindTsConfig(nextDir)
    }
}

async function initProjectlessProgram(id: string, workingDirectory: string) {
    const state = await getOrCreateProjectState('global')
    if (state && !state.programs[id]) {
        getLogger().debug(`Initialized program "${id}"`)
        state.programs[id] = { workingDirectory }
        await setProjectState(state)
    }

    return {
        programId: id,
        workingDirectory,
    }
}

function getProgramIdFromDir(dir: string) {
    const replaced = dir.replaceAll(path.sep, '_')
    if (process.platform !== 'win32') {
        return replaced
    }

    if (replaced.match(/^[a-zA-Z]:/)) {
        return replaced[0] + replaced.slice(2)
    }

    return replaced
}

async function findProjectlessProgram(cwd: string, target?: string) {
    const targetDir = target ? path.dirname(target) : cwd
    const pkg = await getPackageJson(getFs(), targetDir, false)
    if (!pkg) {
        const tsConfig = await tryFindTsConfig(targetDir, false)
        if (tsConfig) {
            const programId = getProgramIdFromDir(tsConfig.directory)

            return initProjectlessProgram(programId, tsConfig.directory)
        }

        if (!target) {
            const programId = getProgramIdFromDir(cwd)

            return initProjectlessProgram(programId, cwd)
            // throw new Error(`No program found in cwd: ${cwd}`)
        }

        if (!(await getFs().fileExists(target))) {
            throw new Error(`Target file not found: ${target}`)
        }

        const programId = getProgramIdFromDir(target)

        return initProjectlessProgram(programId, path.dirname(target))
    }

    const programId = getProgramIdFromDir(pkg.directory)

    return initProjectlessProgram(programId, pkg.directory)
}

export async function findDeployment(programId: string, projectId: string, environmentName?: string, branchName?: string): Promise<string | undefined> {
    const totalState = await getBranchAwareState(projectId, branchName)
    if (!totalState) {
        throw new Error(`No project state found: ${projectId}`)
    }

    const branchState = totalState.branch ?? totalState.state
    const program = branchState.programs[programId]
    if (!program?.appId) {
        return !environmentName ? program?.processId : undefined
    }

    const app = branchState.apps[program.appId]
    if (!app) {
        throw new Error(`Missing application: ${program.appId}`)
    }

    const envName = environmentName ?? app.defaultEnvironment ?? 'local'
    const environment = app.environments[envName]
    if (!environment) {
        return program?.processId
    }

    return (environment as any).process ?? environment.deploymentId
}

function findAppByDeployment(branch: Branch, deploymentId: string) {
    for (const [k, v] of Object.entries(branch.apps)) {
        for (const env of Object.values(v.environments)) {
            if (env.deploymentId === deploymentId || (env as any).process === deploymentId) {
                return k
            }
        }
    }
}

async function repairPrograms(projId: string) {
    const ents = await getEntities()
    const state = await getProjectState(projId)
    if (!state) {
        return
    }

    const defaultBranch = await getDefaultBranchCached(projId)
    for (const [k, v] of Object.entries(ents.deployments)) {
        if (v.projectId !== projId) continue

        if (!v.branchName || v.branchName === defaultBranch) {
            const prog = state.programs[v.programId]
            if (prog && !prog.appId) {
                prog.appId = findAppByDeployment(state, k)
            }
        }
    }

    await setProjectState(state)
}

// TODO: add flag to disable auto-init
export async function resolveProgramBuildTarget(cwd: string, opt?: BuildTargetOptions): Promise<BuildTarget | undefined> {
    // The target deployment is the most specific option so it's resolved first
    if (opt?.deployment) {
        const deployment = await getDeploymentById(opt.deployment)
        const projectId = opt.project ?? deployment.projectId
        // FIXME: handle `global`
        const rootDirectory = await getProjectDirectory(opt.project ?? deployment.projectId)
        const prog = await findProgram(cwd, rootDirectory, projectId)

        return {
            projectId,
            programId: prog.programName,
            deploymentId: opt.deployment,
            rootDirectory,
            workingDirectory: prog.workingDirectory,
            buildDir: path.resolve(rootDirectory, synDirName, 'build'),
            environmentName: opt?.environmentName,
            branchName: prog.branchName,
        }
    }

    const resolvedProgram = opt?.program ? path.resolve(cwd, opt.program) : undefined
    const targetDir = resolvedProgram ? path.dirname(resolvedProgram) : cwd
    const proj = (await findProject(targetDir)) ?? await tryInitProject(cwd)
    if (!proj) {
        const prog = await findProjectlessProgram(cwd, resolvedProgram)
        if (!prog) {
            return
        }

        const projId = 'global'
        const deployment = await findDeployment(prog.programId, projId, opt?.environmentName)

        return {
            projectId: projId,
            programId: prog.programId,
            deploymentId: deployment,
            rootDirectory: prog.workingDirectory,
            workingDirectory: prog.workingDirectory,
            buildDir: path.resolve(getUserSynapseDirectory(), 'build'),
            environmentName: opt?.environmentName,
        }
    }

    const prog = await findProgram(targetDir, proj.rootDir, proj.id)
    const deployment = await findDeployment(prog.programName, proj.id, opt?.environmentName, prog.branchName)

    return {
        projectId: proj.id,
        programId: prog.programName,
        deploymentId: deployment,
        rootDirectory: proj.rootDir,
        workingDirectory: prog.workingDirectory,
        buildDir: path.resolve(getUserSynapseDirectory(), 'build'),
        environmentName: opt?.environmentName,
        branchName: prog.branchName,
    }
}

// * `rootDir` -> project root e.g. a `git` repo
// * `workingDir` -> how should we resolve relative paths
// * `buildDir` -> where can we put cache/build data

export interface BuildTarget {
    readonly projectId: string | 'global'
    readonly programId: string // This is unique per-branch
    readonly deploymentId?: string
    readonly branchName?: string
    readonly environmentName?: string
    readonly rootDirectory: string // `rootDirectory` === `workingDirectory` when using a global project
    readonly workingDirectory: string
    readonly buildDir: string
}

// This is captured during a heap snapshot
const shouldUseRemote = !!process.env['SYNAPSE_SHOULD_USE_REMOTE']
const shouldCreateRemoteDeployment = false
const shouldCreateRemoteProject = shouldUseRemote

async function createDeployment(): Promise<{ id: string; local?: boolean }> {
    if (!shouldCreateRemoteDeployment || process.env['SYNAPSE_FORCE_NO_REMOTE']) {
        return { id: randomUUID(), local: true }
    }

    throw new Error('Remote deployments not implemented')
}

async function _createProject(name: string, params: { url: string }): ReturnType<ReturnType<typeof getProjectsClient>['createProject']> {
    if (!shouldCreateRemoteProject || process.env['SYNAPSE_FORCE_NO_REMOTE']) {
        return { id: randomUUID(), kind: 'project', programs: {}, owner: '', serial: 0 }
    }

    return getProjectsClient().createProject(name, params)
}

async function getOrCreateApp(state: Branch, bt: BuildTarget) {
    const program = state.programs[bt.programId] ??= {}
    if (program.appId) {
        const app = state.apps[program.appId]
        if (!app) {
            throw new Error(`Missing application: ${program.appId} [${bt.rootDirectory}]`)
        }

        return app
    }

    const app: projects.AppInfo = { id: randomUUID(), environments: {} }
    program.appId = app.id
    state.apps[app.id] = app
 
    return app
}

const getProjectsClient = memoize(() => {
    if (isRemoteDisabled()) {
        return projects.createClient({ authorization: () => 'none' })
    }
    return projects.createClient()
})

const defaultBranchName = 'main'

async function getDefaultBranchCached(projectId: string) {
    if (projectId === 'global') {
        return defaultBranchName
    }

    const ents = await getEntities()
    const proj = ents.projects[projectId]
    if (!proj) {
        throw new Error(`Missing project: ${projectId}`)
    }

    if (proj.defaultBranch) {
        return proj.defaultBranch
    }

    if (!proj.url) {
        getLogger().debug(`Searching for git repo in ${proj.directory}`)
        const gitRepo = await findRepositoryDir(proj.directory)
        if (gitRepo) {
            getLogger().debug(`Searching for remotes in ${gitRepo}`)
            const remotes = await listRemotes(gitRepo)
            proj.url = remotes[0]?.fetchUrl
        }
    }

    if (!proj.url) {
        getLogger().debug(`No remote URL found for project ${proj.directory}`)
        return defaultBranchName
    }

    const defaultBranch = await getDefaultBranch(proj.url)
    proj.defaultBranch = defaultBranch
    await setEntities(ents)

    return defaultBranch
}

async function migratePrograms(state: ProjectState) {
    if (state.branches) {
        return state
    }

    const branches = new Map<string, Branch>()
    function addProgram(name: string, info: projects.ProgramInfo, branchName: string, isLegacy?: boolean) {
        const branch = branches.get(branchName) ?? {
            apps: {},
            programs: {},
        }
        branches.set(branchName, branch)
        if (info.appId) {
            branch.apps[info.appId] = state.apps[info.appId]
        }
        branch.programs[name] = isLegacy ? { ...info, isLegacy } as any : info
    }

    function getOldProgramIdNoPkg(workingDirectory: string, rootDir: string) {
        const base = path.relative(rootDir, workingDirectory)
        if (!base) {
            return 'dir___root'
        }
    
        return `dir__${base}`
    }

    const rootDir = state.id !== 'global' ? await getProjectDirectory(state.id) : '/'
    const defaultBranch = await getDefaultBranchCached(state.id)
    for (const [k, v] of Object.entries(state.programs)) {
        const workingDir = v.workingDirectory ? path.resolve(rootDir, v.workingDirectory) : rootDir

        if (!(await getFs().fileExists(workingDir))) {
            getLogger().log(`Program "${k}" no longer exists`, workingDir)
            continue
        }

        const pkg = await getPackageJson(getFs(), workingDir, false)

        const newId = pkg?.data.name || getProgramIdNoPkg(workingDir, rootDir)
        if (k === newId) {
            addProgram(k, v, defaultBranch)
            continue
        }

        const oldId = pkg?.data.name || getOldProgramIdNoPkg(workingDir, rootDir)
        const cleaned = k.replace(oldId, '')
        if (!cleaned.endsWith('_')) {
            addProgram(k, v, defaultBranch, true)
            addProgram(newId, v, defaultBranch)
            continue
        }

        const branchName = cleaned.slice(0, -1)
        addProgram(k, v, branchName, true)
        addProgram(newId, v, branchName)
    }

    const defaultData = branches.get(defaultBranch)
    if (defaultData) {
        Object.assign(state, defaultData)
        branches.delete(defaultBranch)
    }

    if (!state.branches) {
        Object.assign(state, { branches: {} })
    }

    for (const [k, v] of branches) {
        state.branches![k] = v
    }

    await updateProjectState(state, [...branches.keys()])

    return state
}

async function updateProjectState(state: ProjectState, updatedBranches: string[] = []) {
    await setProjectState(state)

    if (isRemoteDisabled()) {
        return
    }

    const ents = await getEntities()
    const remote = ents.projects[state.id]?.remote
    if (remote) {
        if (updatedBranches.length === 0) {
            await getProjectsClient().updateProject(remote, {
                apps: state.apps,
                packages: state.packages,
                programs: state.programs,
                importedPackages: state.importedPackages,
            })
        }

        for (const b of updatedBranches) {
            const branch = state.branches?.[b]
            if (branch) {
                await getProjectsClient().putBranch({
                    name: b,
                    projectId: remote,
                    ...branch,
                })
            }
        }
    }
}

export async function getOrCreateDeployment(bt: BuildTarget = getBuildTargetOrThrow(), useDefaultBranch?: boolean) {
    if (bt.deploymentId) {
        return bt.deploymentId
    }

    const totalState = await getBranchAwareState(bt.projectId, useDefaultBranch ? undefined : bt.branchName)
    if (!totalState) {
        throw new Error(`Missing project state: ${bt.projectId} [${bt.rootDirectory}${bt.branchName ? `@${bt.branchName}` : ''}]`)
    }

    const branchState = totalState.branch ?? totalState.state
    const program = branchState.programs[bt.programId] ??= {}
    if (program.processId && !bt.environmentName) {
        return program.processId
    }

    const app = await getOrCreateApp(branchState, bt)

    const environmentName = bt.environmentName ?? app.defaultEnvironment ?? 'local'
    const environment = app.environments[environmentName]
    if (environment) {
        return (environment as any).process as string ?? environment.deploymentId
    }

    const deployment = await createDeployment()
    app.environments[environmentName] = {
        name: environmentName,
        deploymentId: deployment.id,
    }

    await updateProjectState(totalState.state, bt.branchName ? [bt.branchName] : undefined)

    const ents = await getEntities()
    ents.deployments[deployment.id] = {
        programId: bt.programId,
        projectId: bt.projectId,
        branchName: bt.branchName,
        local: deployment.local,
    }

    await setEntities(ents)

    return deployment.id
}

interface LocalProject {
    readonly directory: string
    remote?: string
    url?: string
    defaultBranch?: string
}

interface EntitiesFile {
    readonly projects: Record<string, LocalProject>
    readonly deployments: Record<string, {
        programId: string // program name
        projectId: string
        branchName?: string
        local?: boolean
    }>
}

const getEntitiesFilePath = () => path.resolve(getUserSynapseDirectory(), 'entities.json')

async function readEntities() {
    const ents = await tryReadJson<EntitiesFile>(getFs(), getEntitiesFilePath())

    // Backwards compat
    if (ents && (ents as any).processes && !ents.deployments) {
        return { ...ents, deployments: (ents as any).processes as EntitiesFile['deployments'] }
    }

    return ents ?? { projects: {}, deployments: {} }
}

let entitiesCached: EntitiesFile | Promise<EntitiesFile>
async function getEntities() {
    return entitiesCached ??= readEntities()
}

// TODO: project directories within the home dir should be made relative
async function setEntities(data: EntitiesFile) {
    entitiesCached = data
    await getFs().writeFile(getEntitiesFilePath(), JSON.stringify(data, undefined, 4))
}

async function addProject(data: EntitiesFile, id: string, attr: EntitiesFile['projects'][string]) {
    const entries = Object.entries(data.projects)
    entries.push([id, attr])
    entries.sort((a, b) => a[1].directory.length - b[1].directory.length)
    await setEntities({ ...data, projects: Object.fromEntries(entries) })
}

function getEntitiesSync(fs: SyncFs = getFs()) {
    const ents = tryReadJsonSync<EntitiesFile>(fs, getEntitiesFilePath())
    if (!ents) {
        throw new Error(`No projects found`)
    }

    // Backwards compat
    if (ents && (ents as any).processes && !ents.deployments) {
        return { ...ents, deployments: (ents as any).processes as EntitiesFile['deployments'] }
    }

    return ents
}

function getStateFilePath(projectId: string) {
    return path.resolve(getUserSynapseDirectory(), 'projects', `${projectId}.json`)
}

function migrateState(state: ProjectState): ProjectState {
    if (!state.apps) {
        return Object.assign(state, { apps: {} })
    }
    return state
}

async function migrateState2(state: ProjectState): Promise<ProjectState> {
    state = migrateState(state)
    await migratePrograms(state)

    return state
}

async function getProjectState(projectId: string, fs = getFs()): Promise<ProjectState | undefined> {
    return tryReadJson<ProjectState>(fs, getStateFilePath(projectId)).then(s => s ? migrateState2(s) : undefined)
}

async function getOrCreateProjectState(projectId: string): Promise<ProjectState> {
    return await getProjectState(projectId) ?? {
        id: projectId,
        apps: {},
        programs: {},
        packages: {},
        branches: {},
    }
}

async function setProjectState(newState: ProjectState, fs = getFs()) {
    await fs.writeFile(getStateFilePath(newState.id), JSON.stringify(newState, undefined, 4))
}

function getProjectStateSync(projectId: string, fs: SyncFs = getFs()) {
    const state = tryReadJsonSync<ProjectState>(fs, getStateFilePath(projectId))
    if (!state) {
        throw new Error(`No project state found: ${projectId}`)
    }

    return migrateState(state)
}

function findProgramByDeployment(state: ProjectState, deploymentId: string, branchName?: string) {
    const branchState = branchName ? state.branches?.[branchName] : undefined
    if (branchState) {
        return worker(branchState) ?? worker(state)
    }

    return worker(state)

    function worker(branch: Branch) {
        for (const [k, v] of Object.entries(branch.programs)) {
            if (v.processId === deploymentId) {
                return k
            }
    
            if (v.appId) {
                const app = branch.apps[v.appId]
                if (!app) continue
    
                if (Object.values(app.environments).some(x => ((x as any).process ?? x.deploymentId) === deploymentId)) {
                    return k
                }
            }
        }
    }
}

function findDeploymentById(deploymentId: string) {
    const ents = getEntitiesSync()
    const deployment = ents.deployments[deploymentId]
    if (!deployment) {
        return
    }

    const state = getProjectStateSync(deployment.projectId)
    const programId = findProgramByDeployment(state, deploymentId, deployment.branchName)
    if (!programId) {
        return
    }

    return { 
        directory: ents.projects[deployment.projectId]?.directory,
        programId,
        projectId: deployment.projectId,
        branchName: deployment.branchName,
    }
}

export function getProgramInfoFromDeployment(deploymentId: string) {
    const res = findDeploymentById(deploymentId)
    if (!res) {
        throw new Error(`No deployment found: ${deploymentId}`)
    }

    return {
        programId: res.programId,
        branchName: res.branchName,
    }
}

export function getRootDir(programId?: string) {
    if (!programId) {
        return getRootDirectory()
    }

    return getRootDirectory()
}

export function getWorkingDir(programId?: string, projectId?: string, branchName?: string) {
    if (!programId) {
        return getBuildTarget()?.workingDirectory ?? process.cwd()
    }

    projectId ??= getBuildTargetOrThrow().projectId
    const state = getProjectStateSync(projectId)
    const branch = branchName ? state.branches?.[branchName] : undefined
    const prog = branch?.programs[programId] ?? state.programs[programId]
    if (!prog) {
        // This can happen if the program attached to a process got moved
        // TODO: automatically fix things for the user
        throw new Error(`No program found: ${programId}`)
    }

    if (projectId === 'global') {
        if (!prog.workingDirectory) {
            throw new Error(`Missing working directory. Corrupted program data?: ${programId}`)
        }

        return prog.workingDirectory
    }

    const rootDir = getProjectDirectorySync(projectId)

    return path.resolve(rootDir, prog.workingDirectory ?? '')
}

export function getRootDirectory() {
    return getBuildTargetOrThrow().rootDirectory
}

export function getSynapseDir() {
    const bt = getBuildTargetOrThrow()
    if (bt.projectId === 'global') {
        return getUserSynapseDirectory()
    }

    return path.resolve(bt.rootDirectory, synDirName)
}

export function getBuildDir() {
    const bt = getBuildTarget()
    if (!bt) {
        return path.resolve(getUserSynapseDirectory(), 'build')   
    }

    return bt.buildDir
}

export function getTargetDeploymentIdOrThrow(): string {
    const bt = getBuildTargetOrThrow()
    if (bt.deploymentId === undefined) {
        throw new Error(`No deployment associated with build target: ${bt.workingDirectory}`)
    }

    return bt.deploymentId
}   

interface Branch {
    readonly apps: Record<projects.AppInfo['id'], projects.AppInfo>
    readonly programs: Record<Program['id'], projects.ProgramInfo>
}

interface ProjectState {
    readonly id: string
    readonly apps: Record<projects.AppInfo['id'], projects.AppInfo>
    readonly programs: Record<Program['id'], projects.ProgramInfo>
    readonly packages: Record<string, string> // package name -> program id
    readonly importedPackages?: Record<string, string>
    readonly branches?: Record<string, Branch>
}

async function findProjectFromDir(dir: string) {
    const ents = await getEntities()
    const projects = new Map(Object.entries(ents.projects).map(([k, v]) => [v.directory, { ...v, id: k }]))

    let currentDir = dir
    while (true) {
        if (projects.has(currentDir)) {
            return projects.get(currentDir)!
        }

        const next = path.dirname(currentDir)
        if (next === currentDir) {
            break
        }

        currentDir = next
    }
}

async function createProject(rootDir: string, remotes?: Omit<Remote, 'headBranch'>[]) {
    if (!remotes) {
        getLogger().warn('No git repositories found. Creating a new project without a git repo is not recommended.')

        const project = await _createProject(path.dirname(rootDir), {
            url: '',
        })

        return project
    }

    if (remotes.length === 0) {
        // getLogger().warn('No git repositories found. Creating a new project without a git repo is not recommended.')
        throw new Error(`A git repo is required to create a new project`)
    }

    if (remotes.length > 1) {
        // TODO: prompt user
        throw new Error(`Not implemented`)
    }

    const target = remotes[0]
    const inferredName = target.fetchUrl.match(/\/([^\/]+)\.git$/)?.[1] ?? path.dirname(rootDir)
    const project = await _createProject(inferredName, {
        url: target.fetchUrl,
    })

    return project
}

export function isRemoteDisabled() {
    return !process.env['SYNAPSE_FORCE_REMOTE_PROJECTS'] && (!shouldUseRemote || process.env['SYNAPSE_FORCE_NO_REMOTE'])
}

async function listRemoteProjects() {
    if (isRemoteDisabled()) {
        return []
    }
    return getProjectsClient().listProjects()
}

export async function getRemoteProjectId(projectId: string) {
    const ents = await getEntities()
    const proj = ents.projects[projectId]

    return proj?.remote
}

async function getRemoteProject(projectId: string) {
    const ents = await getEntities()
    const proj = ents.projects[projectId]
    if (!proj?.url) {
        return
    }

    return getProjectByUrl(proj.url)
}

function normalizeUrl(url: string) {
    return url.replace(/\.git$/, '')
}

async function getProjectByUrl(url: string) {
    try {
        return await getProjectsClient().getProjectByUrl(normalizeUrl(url))
    } catch (e) {
        if ((e as any).statusCode !== 404) {
            throw e
        }
    }
}

async function getOrCreateRemoteProject(dir: string, remotes?: Omit<Remote, 'headBranch'>[]) {
    const remoteUrl = remotes?.[0].fetchUrl
    if (!remoteUrl) {
        return
    }

    const existing = await getProjectByUrl(remoteUrl)
    if (existing !== undefined) {
        return existing
    }

    const existingProjects = await listRemoteProjects()
    getLogger().debug('Existing projects', existingProjects)

    const match = remoteUrl 
        ? existingProjects.find(p => p.gitRepository && normalizeUrl(remoteUrl) === normalizeUrl(p.gitRepository.url))
        : undefined

    if (match) {
        getLogger().log(`Restoring existing project bound to remote: ${remoteUrl}`)
    } else {
        // We don't want to init projects in CI (usually)
        if (getCiType() === 'github') {
            return
        }

        getLogger().log(`Initializing new project with remote: ${remoteUrl}`)
    }

    return match ?? await createProject(dir, remotes)
}

export async function initProject(dir: string, remotes?: Omit<Remote, 'headBranch'>[]) {
    const remote = !isRemoteDisabled() 
        ? await getOrCreateRemoteProject(dir, remotes) 
        : undefined

    const proj = { id: randomUUID(), kind: 'project', apps: remote?.apps, programs: remote?.programs, packages: remote?.packages, owner: '' }

    const ents = await getEntities()

    if (remote?.apps) {
        const appMap = new Map<string, string>()
        for (const [k, v] of Object.entries(remote.programs)) {
            if (k.startsWith('main_')) continue // XXX: temporary hack to fix CI
            if (v.appId) {
                appMap.set(v.appId, k)
            }
        }

        for (const app of Object.values(remote.apps)) {
            for (const env of Object.values(app.environments)) {
                const deploymentId = (env as any).process ?? env.deploymentId
                ents.deployments[deploymentId] = {
                    projectId: proj.id,
                    programId: appMap.get(app.id)!,
                }
            }
        }
    }

    const remoteUrl = remotes?.[0].fetchUrl
    await addProject(ents, proj.id, { 
        directory: dir, 
        remote: remote?.id,
        url: remoteUrl ? normalizeUrl(remoteUrl) : undefined,
    })

    const state = await getOrCreateProjectState(proj.id)

    if (remote?.apps) {
        for (const [k, v] of Object.entries(remote.programs)) {
            if (k.startsWith('main_')) continue // XXX: temporary hack to fix CI
            state.programs[k] = v
            if (v.appId && remote.apps[v.appId]) {
                state.apps[v.appId] = remote.apps[v.appId]
            }
        }
    }

    await setProjectState(state)

    return { id: proj.id, rootDir: dir }
}

async function getCurrentProjectId() {
    const bt = isInContext() ? getBuildTarget() : undefined
    if (bt) {
        return bt.projectId
    }

    const proj = await findProjectFromDir(process.cwd())

    return proj?.id ?? 'global'
}

export async function setPackage(pkgName: string, programId: string) {
    const projectId = await getCurrentProjectId()
    const state = await getOrCreateProjectState(projectId)
    state.packages[pkgName] = programId

    await setProjectState(state)
}

export async function listPackages(projectId?: string) {
    projectId ??= await getCurrentProjectId()
    const state = await getProjectState(projectId)

    return state?.packages ?? {}
}

export async function listRemotePackages(projectId?: string) {
    projectId ??= await getCurrentProjectId()
    const state = await getProjectState(projectId)
    if (!state) {
        return
    }

    const importedPkgs = state.importedPackages ?? (await getRemoteProject(projectId))?.importedPackages

    const packages = state?.packages ?? {}
    const result: Record<string, string> = {}

    for (const [k, v] of Object.entries(packages)) {
        const imported = importedPkgs?.[k]
        if (imported) {
            result[k] = imported
        }

        const pkgId = getRemotePackageId(state, v)    
        if (!pkgId) continue
        
        // Overrides imported packages
        result[k] = pkgId
    }

    return result
}


export async function findRemotePackage(spec: string): Promise<string | undefined> {
    const bt = getBuildTargetOrThrow()
    const s = await getBranchAwareState(bt.projectId, bt.branchName)
    const state = s?.branch ?? s?.state
    if (!state) {
        return
    }

    for (const [k, v] of Object.entries(state.programs)) {
        if (!v.appId) continue

        const app = state.apps[v.appId]
        if (!app) continue

        const env = app.environments[bt.environmentName ?? app.defaultEnvironment ?? 'local']
        if (!env?.packageId) continue

        const dir = v.workingDirectory ? path.resolve(bt.rootDirectory, v.workingDirectory) : bt.rootDirectory
        const pkgJson = await getPackageJson(getFs(), dir, false)
        if (!pkgJson) continue

        if (pkgJson.data.name === spec) {
            return env.packageId
        }
    }
}

async function tryGetBranch(projId: string, branchName: string) {
    if (isRemoteDisabled()) {
        return
    }

    return getProjectsClient().getBranch(projId, branchName)
}

async function getBranchAwareState(projId: string, branchName?: string) {
    const state = await getProjectState(projId)
    if (!branchName || !state || projId === 'global') {
        return state ? { state } : undefined
    }

    const defaultBranch = await getDefaultBranchCached(projId)
    if (defaultBranch === branchName) {
        return { state }
    }

    if (!state.branches) {
        Object.assign(state, { branches: {} })
    }

    if (!state.branches![branchName]) {
        const branch = await tryGetBranch(projId, branchName)
        if (branch) {
            state.branches![branchName] = branch
            await setProjectState(state)
        }
    }
    
    const branch = state.branches![branchName] ??= { apps: {}, programs: {} }

    return { state, branch }
}

export async function listAllDeployments() {
    const entities = await getEntities()
    const res: Record<string, { 
        workingDirectory: string
        programId: string 
        projectId: string
        branchName?: string
        environment?: string
    }> = {}

    for (const [k, v] of Object.entries(entities.deployments)) {
        const projDir = v.projectId !== 'global' 
            ? entities.projects[v.projectId]?.directory
            : '/'

        if (!projDir) {
            continue
        }

        const proj = await getProjectState(v.projectId)
        if (!proj) {
            continue
        }

        const prog = proj.programs[v.programId]
        if (!prog || !prog.appId) {
            continue
        }

        const app = proj.apps[prog.appId]
        const pair = app ? Object.entries(app.environments).find(([k, v]) => v.deploymentId === v.deploymentId) : undefined
        const workingDirectory = path.resolve(projDir, prog.workingDirectory ?? '') 
        res[k] = { 
            workingDirectory, 
            programId: v.programId, 
            projectId: proj.id, 
            branchName: v.branchName,
            environment: pair?.[0],
        }
    }

    return res
}

export async function deleteProject(id?: string) {
    const projectId = id ?? await getCurrentProjectId()
    const state = await getProjectState(projectId)
    if (!state) {
        return
    }

    await getProjectsClient().deleteProject(state.id)
    const ent = await getEntities()
    delete ent.projects[state.id]
    await setEntities(ent)

    await getFs().deleteFile(getStateFilePath(projectId))
}

export async function isPublished(programId: string) {
    const projectId = await getCurrentProjectId()
    const state = await getProjectState(projectId)
    if (!state) {
        return false
    }

    for (const [k, v] of Object.entries(state.packages)) {
        if (v === programId) {
            return true
        }
    }

    return false
}

function getRemotePackageId(branch: Branch, programId: string) {
    const bt = getBuildTargetOrThrow()
    const appId = branch.programs[programId]?.appId
    if (!appId) {
        return
        // throw new Error(`No app id found for program: ${programId}`)
    }

    const app = branch.apps[appId]
    if (!app) {
        throw new Error(`Missing app: ${appId}`)
    }

    const envName = bt.environmentName ?? app.defaultEnvironment ?? 'local'
    const environment = app.environments[envName]
    if (!environment) {
        throw new Error(`Missing environment "${envName}" in app: ${appId}`)
    }

    return environment.packageId
}

export async function getOrCreateRemotePackage(useDefaultBranch?: boolean) {
    const bt = getBuildTargetOrThrow()

    await getOrCreateDeployment(bt, useDefaultBranch)

    const totalState = await getBranchAwareState(bt.projectId, useDefaultBranch ? undefined : bt.branchName)
    if (!totalState) {
        throw new Error(`No project state found: ${bt.projectId}`)
    }

    const branchState = totalState.branch ?? totalState.state
    const app = await getOrCreateApp(branchState, bt)

    const envName = bt.environmentName ?? app.defaultEnvironment ?? 'local'
    const environment = app.environments[envName]
    if (!environment) {
        throw new Error(`Missing environment "${envName}" in app: ${app.id}`)
    }

    if (environment.packageId) {
        return environment.packageId
    }

    if (isRemoteDisabled()) {
        throw new Error(`Unable to create new remote package for app: ${app.id}`)
    }

    getLogger().log('Creating new package for app', app.id)
    const pkg = await registry.createClient().createPackage()
    app.environments[envName] = {
        ...environment,
        packageId: pkg.id,
    }

    await updateProjectState(totalState.state, totalState.branch ? [bt.branchName!] : undefined)

    return pkg.id
}
