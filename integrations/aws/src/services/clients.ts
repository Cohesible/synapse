import * as core from 'synapse:core'
import { Provider, getManagementRoleArn } from '..'
import { RegionInputConfig } from '@smithy/config-resolver'
import { AwsAuthInputConfig } from '@aws-sdk/middleware-signing'
import { assumeRole } from './iam'
import { Account } from './organizations'

function createCredentialsProvider(roleArn: string) {
    return async function getCredentials() {
        const resp = await assumeRole(roleArn)

        return {
            accessKeyId: resp.Credentials!.AccessKeyId!,
            secretAccessKey: resp.Credentials!.SecretAccessKey!,
            sessionToken: resp.Credentials!.SessionToken,
            expiration: resp.Credentials!.Expiration,
        }
    }
}

type ClientConfig = RegionInputConfig & AwsAuthInputConfig
export function createClient<T>(Client: new (config: ClientConfig) => T, opt?: { roleArn?: string }): T {
    const ctx = core.getContext(Provider)
    const roleArn = opt?.roleArn ?? ctx.roleArn
    const config: ClientConfig = { 
        region: ctx.regionId,
        credentials: roleArn ? createCredentialsProvider(roleArn) : undefined,
    }

    return new Client(config)
}

export function createCrossAccountClient<T>(account: Account, Client: new (config: ClientConfig) => T): T {
    const roleArn = getManagementRoleArn(account)

    core.bindModel(
        Client, 
        Object.fromEntries(
            Object.keys(Client.prototype).map(k => [k, {
                Effect: 'Allow',
                Action: 'sts:AssumeRole',
                Resource: roleArn,
            }] as const)
        ) as any
    )

    return core.using(
        Provider.fromAccount(account), 
        () => createClient(Client, { roleArn })
    )
}