import * as core from 'synapse:core'
import { Provider } from './index'

export interface Statement { 
    Effect: 'Allow' | 'Deny'
    Action: string | string[]
    Resource: string | string[]
    Condition?: any 
} 

class IamContext {
    static readonly [core.contextType] = 'aws-iam'
    public readonly statements: Statement[] = []
}

type LifecycleStage = 'create' | 'update' | 'read' | 'delete'

interface ResourceStatement extends ArnProps {
    action: string | string[]
    deny?: boolean
    condition?: any
    lifecycle?: LifecycleStage[]
}

export function addStatement(statement: Statement) {
    const ctx = core.maybeGetContext(IamContext)
    if (ctx) {
        ctx.statements.push(statement)
    }
}

core.stubWhenBundled(addStatement)

export function addResourceStatement(statement: ResourceStatement, receiver?: any) {
    const ctx = core.maybeGetContext(IamContext)
    if (ctx) {
        const prefixAction = (action: string) => action === '*' || action.includes(':') 
            ? action 
            : `${statement.service}:${action}`

        const action = Array.isArray(statement.action) 
            ? statement.action.map(prefixAction)
            : prefixAction(statement.action)

        const boundCtx = receiver ? core.getBoundContext(receiver, Provider) : undefined

        ctx.statements.push({
            Effect: statement.deny ? 'Deny' : 'Allow',
            Action: action,
            Resource: getArn(statement, boundCtx),
            Condition: statement.condition,
        })
    }
}

core.stubWhenBundled(addResourceStatement)

export function getPermissions(target: any) {
    const ctx = new IamContext()
    core.using(ctx, () => core.symEval(target))

    return ctx.statements
}

core.stubWhenBundled(getPermissions)

export function getPermissionsLater(target: any, fn: (statements: Statement[]) => void) {
    core.defer(() => void fn(getPermissions(target)))
}

core.stubWhenBundled(getPermissionsLater)

interface ArnProps {
    partition?: string
    service: string
    region?: string
    account?: string
    resource?: string
}

function getArn(props: ArnProps, ctx?: Provider) {
    const resource = props.resource?.toString()
    if (resource === '*' || resource?.startsWith('arn:')) {
        return props.resource
    }

    ctx ??= core.getContext(Provider)

    return [
        'arn',
        props.partition ?? ctx.partition,
        props.service,
        props.region ?? ctx.regionId,
        props.account ?? ctx.accountId,
        resource ?? '*',
    ].join(':')
}