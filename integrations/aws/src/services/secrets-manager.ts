import * as core from 'synapse:core'
import * as SecretsManager from '@aws-sdk/client-secrets-manager'
import * as aws from 'terraform-provider:aws'
import * as storage from 'synapse:srl/storage'

export class Secret<T = unknown> {
    private readonly client = new SecretsManager.SecretsManager({})
    public readonly resource: aws.SecretsmanagerSecret

    public constructor(envVar?: string) {
        this.resource = new aws.SecretsmanagerSecret({})
        if (envVar) {
            new SecretUploader(this, envVar)
        }
    }

    public async get(): Promise<T> {
        const resp = await this.client.getSecretValue({
            SecretId: this.resource.id,
        })

        if (!resp.SecretString) {
            throw new Error('secret value must be a string')
        }

        return JSON.parse(resp.SecretString)
    }

    public async put(val: T): Promise<{ version: string }> {
        const resp = await this.client.putSecretValue({
            SecretId: this.resource.id,
            SecretString: JSON.stringify(val),
        })

        return { version: resp.VersionId! }
    }
}

const SecretUploader = core.defineResource({
    read: async (state: { secret: Secret, version: string }) => state,
    create: async (secret: Secret, envVar: string) => {
        const val = process.env[envVar]
        if (!val) {
            throw new Error(`Environment variable is not set: ${envVar}`)
        }
        const resp = await secret.put(envVar)

        return { secret, ...resp }
    },
    
    delete: async (state) => void await state.secret.put('')
})

core.addTarget(storage.Secret, Secret, 'aws')
// core.bindModel(SecretsManager.SecretsManager, {
//     'getSecretValue': {
//         'Effect': 'Allow',
//         'Action': 'secretsmanager:GetSecretValue',
//         'Resource': 'arn:{context.Partition}:secretsmanager:{context.Region}:{context.Account}:secret:{0.SecretId}' 
//     },
//     'createSecret': {
//         'Effect': 'Allow',
//         'Action': 'secretsmanager:CreateSecret',
//         'Resource': '*' 
//     },
//     'deleteSecret': {
//         'Effect': 'Allow',
//         'Action': 'secretsmanager:DeleteSecret',
//         'Resource': 'arn:{context.Partition}:secretsmanager:{context.Region}:{context.Account}:secret:{0.SecretId}' 
//     },
//     'updateSecret': {
//         'Effect': 'Allow',
//         'Action': 'secretsmanager:UpdateSecret',
//         'Resource': 'arn:{context.Partition}:secretsmanager:{context.Region}:{context.Account}:secret:{0.SecretId}' 
//     },
//     'listSecrets': {
//         'Effect': 'Allow',
//         'Action': 'secretsmanager:ListSecrets',
//         'Resource': '*' 
//     },
//     'putSecretValue': {
//         'Effect': 'Allow',
//         'Action': 'secretsmanager:PutSecretValue',
//         'Resource': 'arn:{context.Partition}:secretsmanager:{context.Region}:{context.Account}:secret:{0.SecretId}'
//     }   
// })
