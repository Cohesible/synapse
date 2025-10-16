import * as aws from 'terraform-provider:aws'
import * as core from 'synapse:core'
import * as STS from '@aws-sdk/client-sts'
import { Fn } from 'synapse:terraform'
import { randomUUID } from 'node:crypto'
import { generateIdentifier } from 'synapse:lib'
import { addStatement } from '../permissions'

interface Statement { 
    Effect: 'Allow' | 'Deny'
    Action: string | string[]
    Resource: string | string[]
    Condition?: any 
} 

export const spPolicy = (principal: string | string[], condition?: any) => ({
    Version: "2012-10-17",
    Statement: [
        {
            Sid: "", // Is this needed?
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: {
                Service: principal
            },
            Condition: condition
        }
    ]
})

export const tagEquals = (name: string, value: string) => {
    const key = `aws:ResourceTag/${name}`

    return {
        // "Null": required ? { [key]: false } : undefined,
        "StringEquals": { [key]: `${value}` }
    }
}

interface InlinePolicy {
    readonly name: string
    readonly policy: string
}

export class Role {
    public readonly resource: aws.IamRole
    private readonly policies: InlinePolicy[] = []
    private readonly managedPolicyArns: string[] = []
    private estimatedPolicySize = 0
    private aggregatePolicy: ManagedPolicy | undefined

    public constructor(...args: ConstructorParameters<typeof aws.IamRole>) {
        this.resource = new aws.IamRole({
            ...args[0],
            inlinePolicy: this.policies,
            managedPolicyArns: this.managedPolicyArns,
        })

        if (args[0].inlinePolicy) {
            if (!Array.isArray(args[0].inlinePolicy)) {
                throw new Error('Resolvable policies are not implemented')
            }
            for (const policy of args[0].inlinePolicy) {
                if (!policy.name || !policy.policy) {
                    throw new Error(`Policy name and policy must be present`)
                }
                this.policies.push(policy as InlinePolicy)
            }
        }

        if (args[0].managedPolicyArns) {
            this.managedPolicyArns.push(...args[0].managedPolicyArns)
        }
    }

    public addPolicy(policy: InlinePolicy) {
        if (!policy.policy) {
            core.getLogger().log(`Skipped adding policy "${policy.name}" because it contains no statements`)
            return
        }
    
        const size = getEstimatedSize(policy.policy)
        if (size) {
            this.estimatedPolicySize += size
        }

        if (this.estimatedPolicySize < maxInlinePolicySize*0.8) {
            this.policies.push(policy)
            return
        }

        this.estimatedPolicySize -= size
        const statements = getSourceStatements(policy.policy)
        if (!statements) {
            const managedPolicy = new aws.IamPolicy({ policy: policy.policy, namePrefix: 'synapse-' })
            this.managedPolicyArns.push(managedPolicy.arn)
            return
        }

        if (!this.aggregatePolicy) {
            this.aggregatePolicy = new ManagedPolicy(statements)
            this.managedPolicyArns.push(this.aggregatePolicy.arn)
        } else {
            this.aggregatePolicy.addStatements(statements)
        }
    }
}

export async function assumeRole(role: string | Role, sessionName?: string) {
    const client = new STS.STS({})

    return client.assumeRole({
        RoleArn: typeof role === 'string' ? role : role.resource.arn,
        RoleSessionName: sessionName ?? randomUUID(),
    })
}

// This is the default quota, I think it can be increased?
const maxInlinePolicySize = 10240
const estimatedSize = Symbol.for('synapse.estimatedSize')
const sourceStatements = Symbol.for('synapse.aws.sourceStatements')

// We're more likely to overestimate rather than underestimate
function getEstimatedSize(data: any): number | undefined {
    if (typeof data === 'string') {
        return data.length
    }

    if ((typeof data === 'object' && !!data) || typeof data === 'function') {
        const estimate = data[estimatedSize]
        if (estimate !== undefined) {
            return estimate
        }

        if (typeof data === 'function') {
            return
        }

        return JSON.stringify(data).length // IMPORTANT: this is _not_ byte length
    }
}

function getSourceStatements(data: any): Statement[] | undefined {
    if ((typeof data === 'object' && !!data) || typeof data === 'function') {
        return data[sourceStatements]
    }
}

export function createSerializedPolicy(statements: Statement[]): string {
    if (statements.length === 0) {
        return ''
    }

    const policy = {
        Version: "2012-10-17",
        Statement: statements,
    }

    return Object.assign(
        Fn.jsonencode(policy), 
        { 
            [estimatedSize]: getEstimatedSize(policy),
            [sourceStatements]: statements,
        }
    )
}

function isEquivalent(a: Statement, b: Statement) {
    // TODO: handle conditions
    if (a.Condition || b.Condition) {
        return false
    }

    return (
        a.Effect === b.Effect &&
        a.Action === b.Action &&
        a.Resource === b.Resource
    )
}

export class ManagedPolicy extends aws.IamPolicy {
    constructor(private readonly statements: Statement[]) {
        super({ 
            policy: createSerializedPolicy(statements),
            namePrefix: 'synapse-',
        })
    }

    public addStatements(statements: Statement[]) {
        for (const s of statements) {
            if (!this.statements.some(other => isEquivalent(s, other))) {
                this.statements.push(s)
            }
        }
    }
}

export class User extends aws.IamUser {
    public readonly accessKey: aws.IamAccessKey

    constructor(props: { name?: string, permissions?: Statement[] }) {
        const policy = props.permissions ? new ManagedPolicy(props.permissions) : undefined

        super({
            name: generateIdentifier(aws.IamUser, 'name', 62),
            forceDestroy: true,
            permissionsBoundary: policy?.arn,
        })

        this.accessKey = new aws.IamAccessKey({ user: this.name })
    }

    addPermissions(permissions: Statement[]) {
        const policy = new ManagedPolicy(permissions)

        new aws.IamUserPolicyAttachment({
            user: this.name,
            policyArn: policy.arn,
        })
    }
}

core.bindModel(STS.STS, {
    assumeRole: function (req) {
        addStatement({ Effect: 'Allow', Action: 'sts:AssumeRole', Resource: req.RoleArn })

        return {}
    }
})
