import * as preact from 'preact'
import { render } from 'preact-render-to-string'
import type { HostedZone } from 'synapse:srl/net'
import { JSXRuntime, createWebsiteHost, WebsiteHost } from '@cohesible/synapse-websites'

const runtime: JSXRuntime<preact.VNode> = {
    render,
    mount: (container, children, opt) => {
        if (opt.rehydrate) {
            preact.hydrate(children, container)
        } else {
            preact.render(children, container)
        }

        return {}
    },
}

export function createWebsite(props?: { domain?: HostedZone }): WebsiteHost {
    return createWebsiteHost(runtime, props)
}
