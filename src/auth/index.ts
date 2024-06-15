import * as path from 'node:path'
import { homedir } from 'node:os'
import { getLogger } from '../logging'
import { type Identity, type Credentials, createIdentityClient } from '@cohesible/auth'
import { getBackendClient } from '../backendClient'
import { getFs } from '../execution'
import { memoize } from '../utils'
import { getUserSynapseDirectory } from '../workspaces'

export interface StoredCredentials extends Credentials {
    readonly expiresAt: number // Epoch ms
}

// Specific to the current machine
interface AccountConfig {
    // Time in minutes
    sessionDuration?: number
}

interface Account extends Identity {
    readonly config?: AccountConfig
}

interface AuthState {
    currentAccount?: Account['id']
    readonly accounts: Record<Account['id'], Account>
}

// This is the client-side portion of auth

export type Auth = ReturnType<typeof createAuth>

export const getAuth = memoize(() => createAuth())

function getClient(): ReturnType<typeof createIdentityClient> {
    try {
        return createIdentityClient()
    } catch {
        return getBackendClient() as any
    }
}

export const getAuthClient = getClient

export function createAuth() {
    const fs = getFs()
    const client = getClient()
    const credsDir = path.resolve(getUserSynapseDirectory(), 'credentials')
    const statePath = path.resolve(credsDir, 'state.json')

    async function getAuthState(): Promise<AuthState> {
        try {
            return JSON.parse(await fs.readFile(statePath, 'utf-8'))
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }

            return { accounts: {} }
        }
    }

    async function setAuthState(state: AuthState): Promise<void> {
        await fs.writeFile(statePath, JSON.stringify(state, undefined, 4))
    }

    async function putAccount(account: Account, makeCurrent = false) {
        const state = await getAuthState()
        state.accounts[account.id] = account
        if (makeCurrent) {
            state.currentAccount = account.id
        }
        await setAuthState(state)
    }

    async function deleteAccount(id: Account['id']) {
        const state = await getAuthState()
        const account = state.accounts[id]
        if (!account) {
            return
        }

        delete state.accounts[id]

        if (state.currentAccount === id) {
            state.currentAccount = undefined
        }

        if (account.subtype === 'machine') {
            await client.deleteMachineIdentity(account.id)
            await fs.deleteFile(getMachineKeyPath(account.id)).catch(e => {
                if ((e as any).code !== 'ENOENT') {
                    throw e
                }
            })
        }

        await fs.deleteFile(path.resolve(credsDir, `${id}.json`)).catch(e => {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }
        })

        await setAuthState(state)
    }

    async function saveCredentials(identity: Pick<Identity, 'id'>, credentials: Credentials) {
        const stored: StoredCredentials = {
            ...credentials,
             // The `- 60` is so we refresh a little earlier than needed
            expiresAt: Date.now() + ((credentials.expires_in - 60) * 1000),
        }

        await fs.writeFile(
            path.resolve(credsDir, `${identity.id}.json`), 
            JSON.stringify(stored, undefined, 4)
        )

        return stored
    }

    async function refreshCredentials(identity: Pick<Identity, 'id'>, refreshToken: string) {
        const creds = await client.refreshCredentials(refreshToken)

        return saveCredentials(identity, creds)
    }

    async function getCredentials(identity: Pick<Identity, 'id'>) {
        try {
            const data = await fs.readFile(path.resolve(credsDir, `${identity.id}.json`), 'utf-8')
            const creds: StoredCredentials = JSON.parse(data)

            if (creds.expiresAt <= Date.now()) {
                const acc = await getAccount(identity.id)
                if (isMachineIdentity(acc)) {
                    return getMachineCredentials(acc)
                }

                if (creds.refresh_token) {
                    getLogger().debug(`Refreshing credentials for identity "${identity.id}"`)

                    return refreshCredentials(identity, creds.refresh_token)
                }

                getLogger().debug(`Credentials "${identity.id}" expired without a refresh`)

                return
            }
            
            return creds
        } catch (e) {
            if ((e as any).code !== 'ENOENT') {
                throw e
            }

            const acc = await getAccount(identity.id)
            if (isMachineIdentity(acc)) {
                return getMachineCredentials(acc)
            }
        }
    }

    async function getMachineCredentials(account: Account & { subtype: 'machine'}) {
        const privateKey = await getMachineKey(account)
        const creds = await client.getMachineCredentials(account.id, privateKey, account.config?.sessionDuration)

        return saveCredentials(account, creds)
    }

    const getMachineKeyPath = (id: string) => path.resolve(getUserSynapseDirectory(), 'machine-identities', id)

    async function getMachineKey(account: Account) {
        if (account.subtype !== 'machine') {
            throw new Error(`Not a machine identity: ${account.id}`)
        }

        const keyPath = getMachineKeyPath(account.id)

        return await fs.readFile(keyPath, 'utf-8') as string
    }

    async function createMachineIdentity(makeCurrent?: boolean) {
        const identity = await client.createMachineIdentity()
        await fs.writeFile(getMachineKeyPath(identity.id), identity.privateKey)
        const acc = { ...identity, privateKey: undefined, subtype: 'machine' } as Account & { subtype: 'machine' }
        await putAccount(acc, makeCurrent)

        return acc
    }

    function isMachineIdentity(account: Account | undefined): account is Account & { subtype: 'machine' } {
        return account?.subtype === 'machine'
    }

    function mergeAccountConfig(account: Account, config: AccountConfig) {
        const merged = { ...account.config, ...config }
        if (Object.keys(merged).filter(k => (merged as any)[k] !== undefined).length === 0) {
            return { ...account, config: undefined }
        }

        return { ...account, config: merged }
    }

    async function updateAccountConfig(account: Account, config: AccountConfig) {
        const merged = mergeAccountConfig(account, config)
        await putAccount(merged)
    }

    async function machineLogin() {
        const accounts = await listAccounts()
        const existingAccount = accounts.find(isMachineIdentity)
        if (existingAccount) {
            const active = await getActiveAccount()
            if (active?.id !== existingAccount.id) {
                await setActiveAccount(existingAccount)
            }

            await getCredentials(existingAccount)

            return
        }

        const account = await createMachineIdentity(true)
        await getMachineCredentials(account)
    }

    async function listAccounts() {
        const state = await getAuthState()

        return Object.values(state.accounts)
    }

    async function listIdentityProviders() {
        return client.listProviders()
    }

    async function getAccount(id: string): Promise<Account | undefined> {
        const state = await getAuthState()
        const account = state.accounts[id]
        // if (!account) {
        //     throw new Error('No such account exists')
        // }

        return account
    }

    async function setActiveAccount(account: Account) {
        const state = await getAuthState()
        if (!state.accounts[account.id]) {
            throw new Error(`No such account exists: ${account.id}`)
        }

        state.currentAccount = account.id
        await setAuthState(state)

        return account
    }
    
    async function getActiveAccount() {
        const state = await getAuthState()
        if (!state.currentAccount) {
            return
        }

        return state.accounts[state.currentAccount]
    }

    async function startLogin() {
        const type = 'github'
        const { providers } = await client.listProviders()
        const filtered = providers.filter(p => !type || p.type === type)
        if (filtered.length === 0) {
            throw new Error(`No identity providers available`)
        }
    
        const providerId = filtered[0].id
        const { pollToken, redirectUrl } = await client.startLogin(providerId)
        getLogger().log('Open URL to login:', redirectUrl)
    
        const startTime = Date.now()
        while (Date.now() - startTime < 60_000) {
            await new Promise<void>(r => setTimeout(r, 2500))
            const token = await client.getToken(providerId, pollToken)
            if (token) {
                const identity = await client.whoami(token.access_token)
                await putAccount(identity, true)
                await saveCredentials(identity, token)

                return identity
            }
        }
    
        throw new Error(`Timed out waiting for login`)
    }

    async function login(target?: string) {
        if (!target) {
            return startLogin()
        }

        const accounts = await listAccounts()
        const match = accounts.find(a => a.attributes['username'] === target)
        if (!match) {
            throw new Error(`No account found with username: ${target}`)
        }

        // TODO: refresh credentials
        await setActiveAccount(match)
    }

    async function logout() {
        const state = await getAuthState()
        const id = state.currentAccount
        if (!id) {
            return
        }

        await deleteAccount(id)
    }

    interface ExportedIdentity {
        readonly account: Account
        readonly privateKey: string
    }

    async function exportIdentity(dest: string) {
        const activeAccount = await getActiveAccount()
        if (!activeAccount) {
            throw new Error(`Nothing to export`)
        }

        if (!isMachineIdentity(activeAccount)) {
            throw new Error(`Account "${activeAccount.id}" is not a machine identity`)
        }

        const data: ExportedIdentity = {
            account: activeAccount,
            privateKey: await getMachineKey(activeAccount),
        }

        await getFs().writeFile(dest, JSON.stringify(data, undefined, 4))
    }

    // Validation is incomplete
    async function readExportedIdentity(filePath: string): Promise<ExportedIdentity> { 
        const data = await getInputData(filePath).then(JSON.parse)
        if (!data || typeof data !== 'object' || !data.account || !data.privateKey) {
            const keys = typeof data === 'object' && !!data ? Object.keys(data) : undefined
            throw new Error(`Unknown format: ${typeof data} ${keys ? ` [keys: ${keys.join(', ')}]` : ''}`)
        }

        return data
    }

    async function getInputData(filePath: string) {
        if (filePath !== '-') {
            return await getFs().readFile(filePath, 'utf-8')
        }

        const chunks: any[] = []

        return new Promise<string>((resolve, reject) => {
            process.stdin.on('data', d => chunks.push(d))
            process.stdin.on('end', () => resolve(chunks.join('')))
        })
    }

    async function importIdentity(filePath: string) {
        const exported = await readExportedIdentity(filePath)
        const state = await getAuthState()
        const id = exported.account.id
        if (state.accounts[id]) {
            throw new Error(`Already imported account: ${id}`) // TODO: only throw if there's a mis-match somewhere
        }

        await fs.writeFile(getMachineKeyPath(id), exported.privateKey)
        await putAccount(exported.account, true)

        // Make sure the import worked
        const creds = await getCredentials(exported.account)
        if (!creds) {
            throw new Error(`Missing credentials for identity: ${id}`)
        }

        const resp = await client.whoami(creds.access_token)
        if (resp.id !== id) {
            throw new Error(`Imported identity ID does not match the ID reported by the authentication service`)
        }
    }

    return {
        login, 
        logout,
        getAccount,
        getActiveAccount,
        getCredentials,
        machineLogin,
        listAccounts,
        listIdentityProviders,
        updateAccountConfig,

        // Internal-only for now
        exportIdentity,
        importIdentity,
    }
}

