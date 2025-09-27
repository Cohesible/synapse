import * as core from 'synapse:core'
import * as lib from 'synapse:lib'
import * as aws from 'synapse-provider:aws'
import * as path from 'node:path'
import { Vpc } from './ec2'
import * as fs from 'fs'
import * as ECS from '@aws-sdk/client-ecs'
import * as EC2 from '@aws-sdk/client-ec2'
import { DockerfileDeployment, GeneratedDockerfile } from './ecr'
import { Role, spPolicy } from './iam'
import * as net from 'synapse:srl/net'
import * as compute from 'synapse:srl/compute'
import * as storage from 'synapse:srl/storage'
import { addResourceStatement, getPermissions } from '../permissions'

export class ContainerService {
    private readonly client = new ECS.ECS({})
    private readonly ec2 = new EC2.EC2({})
    public readonly cluster: aws.EcsCluster
    public readonly service: aws.EcsService
    public readonly principal: Role

    public static fromEntrypoint(network: Vpc, entryPoint: () => any) {
        return new this(network, entryPoint as any)
    }

    public static fromDockerfile(network: Vpc, entryPoint: string) {
        return new this(network, entryPoint as any) // BROKEN
    }

    public constructor(public readonly network: Vpc, target: () => Promise<void> | void, imageBuilder?: (bundle: lib.Bundle) => any, opt?: any) {
        const id = core.getCurrentId().split('--').slice(0, -1).join('-').slice(0, 62).replaceAll('.', '-')
        this.cluster = new aws.EcsCluster({
            name: lib.generateIdentifier(aws.EcsCluster, 'name', 62),
        })
        const bundle = new lib.Bundle(target)
        const region = new aws.RegionData()
        
        let repoUrl: string

        if (imageBuilder) {
            const repo = imageBuilder(bundle)
            repoUrl = repo.repositoryUrl
        } else {
            const repoAndDeployment = createDefaultImage(id, bundle, region.name, opt?.baseImage)
            repoUrl = `${repoAndDeployment.repo.repositoryUrl}:${repoAndDeployment.deployment.tagName}`
        }
    
        const role = new aws.IamRole({
            assumeRolePolicy: JSON.stringify(spPolicy("ecs-tasks.amazonaws.com")),
            managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
        })

        const identity = new aws.CallerIdentityData()
        const condition = {
            "ArnLike":{
            "aws:SourceArn":`arn:aws:ecs:${region.name}:${identity.accountId}:*`
            },
            "StringEquals":{
                "aws:SourceAccount":`${identity.accountId}`
            }
        }
        const statements = getPermissions(target)
        const taskRole = new Role({
            assumeRolePolicy: JSON.stringify(spPolicy("ecs-tasks.amazonaws.com", condition)),
            inlinePolicy: statements.length > 0 ? [{
                name: 'InlinePolicy', // name is required!!!!!!!
                policy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: statements,
                })
            }] : undefined,
        })

        this.principal = taskRole

        const logs = new aws.CloudwatchLogGroup({
            name: `${id}Logs`
        })

        // When using a public subnet, you can assign a public IP address to the task ENI.
        // When using a private subnet, the subnet can have a NAT gateway attached.
        // When using container images that are hosted in Amazon ECR, you can configure Amazon ECR to use an interface VPC endpoint and the image pull occurs over the task's private IPv4 address. For more information, see Amazon ECR interface VPC endpoints (AWS PrivateLink) in the Amazon Elastic Container Registry User Guide.

        const runtimePlatform = opt?.arch === 'aarch64' ? {
            operatingSystemFamily: "LINUX",
            cpuArchitecture: "ARM64"
        } : undefined
        
        const taskDefinition = new aws.EcsTaskDefinition({
            family:`${id}Task`,
            networkMode: 'awsvpc',
            cpu: opt?.cpu ? String(opt.cpu) : '256',
            memory: opt?.memory ? String(opt.memory) : '512',
            requiresCompatibilities: ["FARGATE"],
            taskRoleArn: taskRole.resource.arn,
            executionRoleArn: role.arn,
            runtimePlatform,
            containerDefinitions: JSON.stringify([{
                // command: string[]
                command: opt?.command,
                workingDirectory: opt?.workingDirectory,
                name: `${id}`,
                image: repoUrl,
                cpu: opt?.cpu ?? 256,
                memory: opt?.memory ?? 512,
                portMappings: opt?.portMappings ?? [{
                    // protocol: 'tcp' | 'udp'
                    // appProtocol: 'http' | 'http2' | 'grpc' //
                    protocol: 'tcp',        // TODO: determine this from `target`
                    appProtocol: 'http',    // TODO: determine this from `target`
                    containerPort: 80,      // TODO: determine this from `target`
                }],
                environment: opt?.environment,
                logConfiguration: {
                    logDriver: 'awslogs',
                    options: {
                        'awslogs-group': logs.name,
                        'awslogs-region': region.name,
                        'awslogs-stream-prefix': "awslogs-example"
                    }
                }
            }]),
        })

        // const alb = new aws.Alb({
        //     loadBalancerType: 'network',
        //     subnets: network.subnets.map(s => s.id),
        //     securityGroups: [network.resource.defaultSecurityGroupId],
        //     internal: true,
        // })
        // this.loadBalancer = alb

        // new aws.AlbListener({
        //     loadBalancerArn: alb.arn,
        //     port: 80,
        //     protocol: 'HTTP',
        //     defaultAction: [
        //         {
        //             type: 'fixed-response',
        //             fixedResponse: {
        //                 contentType: 'text/plain',
        //                 messageBody: 'No containers available',
        //                 statusCode: '500',
        //             }
        //         }
        //     ],
        // })

        // const group = new aws.AlbTargetGroup({
        //     targetType: 'ip',
        //     vpcId: network.id,
        // })

        this.service = new aws.EcsService({
            desiredCount: opt?.desiredCount ?? 0,
            launchType: 'FARGATE',
            name: `${id}Service`,
            cluster: this.cluster.arn,
            taskDefinition: taskDefinition.arn,
            // loadBalancer: [
            //     {
            //         targetGroupArn: group.arn,
            //         containerName: id,
            //         containerPort: 80,
            //     }
            // ],
            networkConfiguration: {
                assignPublicIp: opt?.public ?? false,
                subnets: network.subnets.map(s => s.id),
                securityGroups: [network.resource.defaultSecurityGroupId]
            },
        })

        core.updateLifecycle(this.service, { ignore_changes: ['desiredCount'] })
    }

    public async updateTaskCount(count: number) {
        await this.client.updateService({
            cluster: this.cluster.name,
            service: this.service.name,
            desiredCount: count,
        })
    }

    public async listInstances() {
        const resp = await this.client.listTasks({
            cluster: this.cluster.name,
            serviceName: this.service.name,
        })

        if (resp.taskArns!.length === 0) {
            return []
        }

        const tasks = (await this.client.describeTasks({
            cluster: this.cluster.arn,
            tasks: resp.taskArns! 
        })).tasks!

        const instances: compute.ContainerInstance[] = []
        for (const task of tasks) {
            const attachments = task.attachments ?? []
            const enis = attachments.filter(x => !!x.details?.find(y => y.name === 'networkInterfaceId'))
            console.log('enis', JSON.stringify(enis, undefined, 4))

            const eniIds = enis.map(a => a.details?.find(y => y.name === 'networkInterfaceId')?.value)
                .filter(<T>(x: T | undefined): x is T => x !== undefined)
            const desc = await this.ec2.describeNetworkInterfaces({
                NetworkInterfaceIds: eniIds,
            })

            if (!desc.NetworkInterfaces?.[0]?.Association?.PublicIp) continue

            console.log('describe enis', JSON.stringify(desc, undefined, 4))

            for (const container of task.containers ?? []) {
                console.log('container', JSON.stringify(container, undefined, 4))
                if (container.lastStatus !== 'RUNNING') continue

                instances.push({
                    name: container.name!,
                    publicIp: desc.NetworkInterfaces[0].Association.PublicIp,
                    privateIp: desc.NetworkInterfaces[0].PrivateIpAddress,
                    port: 80,
                })
            }
        }

        return instances
    }
}

function createDefaultImage(id: string, bundle: lib.Bundle, regionName: string, baseImage?: string) {
    const repoName = id.toLowerCase()
    const repo = new aws.EcrRepository({
        name: repoName,
        forceDelete: true,
    })

    const dockerfile = new GeneratedDockerfile(bundle, { baseImage })

    const deployment = new DockerfileDeployment({
        type: 'ecr',
        dockerfilePath: dockerfile.location,
        region: regionName,
        repositoryUrl: repo.repositoryUrl,
        repoName: repoName,
    })

    core.updateLifecycle(deployment, { replace_triggered_by: [bundle] })

    return { repo, deployment }
}

// Permissions reference: 
// https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html
function addEcsStatement(recv: any, action: string | string[], resource = '*') {
    addResourceStatement({
        service: 'ecs',
        action,
        resource,
    }, recv)
}

core.addTarget(compute.Container, ContainerService, 'aws')
core.bindModel(ECS.ECS, {
    'runTask': function (req) {
        // arn:aws:ecs:us-east-1:111122223333:task-definition/TaskFamilyName:1</code>.
        addEcsStatement(this, 'RunTask', req.taskDefinition)

        return core.createUnknown()
    },
    'stopTask': function (req) {
        addEcsStatement(this, 'StopTask', `task/${req.cluster}/${req.task}`)

        return core.createUnknown()
    },
    'createCluster': function (req) {
        addEcsStatement(this, 'CreateCluster')

        return core.createUnknown()
    },
    'deleteCluster': function (req) {
        addEcsStatement(this, 'DeleteCluster', `cluster/${req.cluster}`)

        return core.createUnknown()
    },
    'listClusters': function (req) {
        addEcsStatement(this, 'ListClusters')

        return core.createUnknown()
    },
    'listTasks': function (req) {
        addEcsStatement(this, 'ListTasks', `container-instance/${req.cluster}/${req.containerInstance ?? '*'}`)

        return core.createUnknown()
    },
    'updateService': function (req) {
        addEcsStatement(this, 'UpdateService', `service/${req.cluster}/${req.service}`)

        return core.createUnknown()
    },
    'describeTasks': function (req) {
        addEcsStatement(this, 'DescribeTasks', `task/${req.cluster}/*`)

        return core.createUnknown()
    }
})

