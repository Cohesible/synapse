import * as aws from 'terraform-provider:aws'
import * as core from 'synapse:core'
import * as Organizations from '@aws-sdk/client-organizations'

export class Organization {
    public get id() {
        return this.resource.id
    }

    // https://docs.aws.amazon.com/organizations/latest/userguide/orgs_getting-started_concepts.html
    // "Currently, you can have only one root. AWS Organizations automatically creates it for you when you create an organization."
    public get root() {
        return this.resource.roots[0]
    }

    public readonly resource: aws.OrganizationsOrganization
    public constructor() {
        this.resource = new aws.OrganizationsOrganization({ 
            featureSet: 'ALL'
        })
    }

    public static import(id: string) {
        throw new Error('TODO')
    }
}

function getParentId(parent: Organization | OrganizationalUnit) {
    if (parent instanceof Organization) {
        return parent.root.id
    }

    return parent.id
}

interface OrganizationalUnitProps {
    readonly name: string
    readonly parent: Organization | OrganizationalUnit
}

export class OrganizationalUnit {
    public get id() {
        return this.resource.id
    }

    public readonly resource: aws.OrganizationsOrganizationalUnit
    public constructor(props: OrganizationalUnitProps) {
        this.resource = new aws.OrganizationsOrganizationalUnit({
            name: props.name,
            parentId: getParentId(props.parent)
        })
    }
}

interface AccountProps {
    readonly name: string
    readonly email: string
    readonly parent?: Organization | OrganizationalUnit
    readonly closeOnDeletion?: boolean

    /** @internal */
    readonly id?: string
}

export class Account {
    private readonly resource?: aws.OrganizationsAccount
    public readonly id: string
    public readonly managementRoleName: string

    public constructor(props: AccountProps) {
        if (!props.id) {
            this.resource = new aws.OrganizationsAccount({
                name: props.name,
                email: props.email,
                closeOnDeletion: props.closeOnDeletion,
                iamUserAccessToBilling: 'ALLOW', // 'DENY'
                parentId: props.parent ? getParentId(props.parent) : undefined,
            })
            this.id = this.resource.id
        } else {
            this.id = props.id
        }

        this.managementRoleName = 'OrganizationAccountAccessRole'
    }

    public static import(id: string) {
        const account = importAccount({ id })

        return new Account({
            id: account.id!,
            name: account.name!,
            email: account.email!,
        })
    }
}

type UncapitalizeObject<T extends object> = { [P in Uncapitalize<keyof T & string>]: T[Capitalize<P> & keyof T] }

function uncapitalize<T extends object>(o: T): UncapitalizeObject<T> {
    return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k[0].toLowerCase().concat(k.slice(1)), v])
    ) as any
}

const importAccount = core.defineDataSource(async (identity: { id: string }) => {
    const client = new Organizations.Organizations({})
    const resp = await client.describeAccount({ AccountId: identity.id })

    return uncapitalize(resp.Account!)
})