import * as preact from 'preact'
import { render, renderToStringAsync } from 'preact-render-to-string'
import type { HostedZone } from 'synapse:srl/net'
import { JSXRuntime, createWebsiteHost, WebsiteHost } from '@cohesible/synapse-websites'

const runtime: JSXRuntime<preact.VNode> = {
    createElement: preact.createElement,
    render: renderToStringAsync,
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