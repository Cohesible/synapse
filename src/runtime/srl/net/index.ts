//# moduleId = synapse:srl/net

//--------------- NETWORKKING ---------------//

interface RouteProps {
    readonly type?: 'ipv4' | 'ipv6'
    readonly destination: string
    // LoadBalancer?
}

// creates a route within a network
//# resource = true
/** @internal */
export declare class Route {
    constructor(network: RouteTable | Network, props: RouteProps)
}

//# resource = true
/** @internal */
export declare class RouteTable {}

interface SubnetProps {
    readonly cidrBlock?: string
    readonly ipv6CidrBlock?: string
}

//# resource = true
/** @internal */
export declare class Subnet {
    constructor(network: Network, props?: SubnetProps)
}

//# resource = true
/** @internal */
export declare class Network {
    readonly subnets: Subnet[]
}

//# resource = true
/** @internal */
export declare class InternetGateway {
    constructor()
}

// For east-west traffic (IGW is north-south)
//# resource = true
/** @internal */
export declare class TransitGateway {
    constructor()

    public addNetwork(network: Network): void
}

// for AWS these are always 'allow'
/** @internal */
export interface NetworkRuleProps {
    readonly type: 'ingress' | 'egress'
    readonly priority?: number
    readonly protocol: 'icmp' | 'tcp' | 'udp' | number // IPv4 protocol id
    // TODO: icmp has extra settings for AWS
    readonly port: number | [number, number] // only applicable to L4 protocols
    // source or destination
    readonly target: string // can be _a lot_ of different things
}

//# resource = true
/** @internal */
export declare class NetworkRule {
    constructor(network: Network, props: NetworkRuleProps) 
}

//# resource = true
/** @internal */
export declare class Firewall {}

//# resource = true
export declare class HostedZone {
    readonly name: string
    constructor(name: string)
    createSubdomain(name: string): HostedZone

    //# resource = true
    createRecord(record: ResourceRecord): void
}

interface NsRecord {
    type: 'NS'
    name: string
    ttl: number
    value: string
}

interface AliasRecord {
    type: 'A'
    name: string
    ttl: number
    value: string
}

interface CNameRecord {
    type: 'CNAME'
    name: string
    ttl: number
    value: string
}

export type ResourceRecord = CNameRecord | NsRecord | AliasRecord
