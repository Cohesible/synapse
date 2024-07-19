import * as stream from 'node:stream'
import type { HostedZone } from 'synapse:srl/net'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToPipeableStream, renderToString } from 'react-dom/server'
import { JSXRuntime, createWebsiteHost, WebsiteHost } from '@cohesible/synapse-websites'
import { createElement } from 'react'

const runtime: JSXRuntime<React.ReactNode> = {
    createElement,
    mount: (container, children, opt) => {
        if (opt.rehydrate) {
            return hydrateRoot(container, children)
        }

        const root = createRoot(container as any)
        root.render(children)

        return root
    },
    render: node => renderToString(node as React.ReactElement),
    renderStream: (node, opt) => {
        return new Promise((resolve, reject) => {
            const s = renderToPipeableStream(node, {
                ...opt,
                onShellError: reject,
                onShellReady: () => {
                    const pass = new stream.PassThrough() // FIXME: why is this needed

                    resolve(stream.Readable.toWeb(s.pipe(pass)) as any)
                },
            })
        })
    },
}

export function createWebsite(props?: { domain?: HostedZone }): WebsiteHost {
    return createWebsiteHost(runtime, props)
}
