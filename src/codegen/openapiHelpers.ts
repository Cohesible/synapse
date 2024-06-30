type ParameterLocation = {
    readonly in?: "path";
    readonly style?: "matrix" | "label" | "simple";
    readonly required: true;
    readonly 'x-multi-segment'?: boolean
} | {
    readonly in?: "query";
    readonly style?: "form" | "spaceDelimited" | "pipeDelimited" | "deepObject";
    readonly required?: boolean;
    readonly 'x-multi-segment'?: boolean
    readonly deprecated?: boolean

} | {
    readonly in?: "header";
    readonly style?: "simple";
} | {
    readonly in?: "cookie";
    readonly style?: "form";
};

type Param = ParameterLocation & {
    name: string
}

function buildRequest(pathTemplate: string, params: Param[], req: Record<string, any>) {
    const query = new URLSearchParams()
    for (const p of params) {
        const val = req[p.name]
        if (val === undefined) {
            if ((p as any).required) {
                throw new Error(`Missing parameter: ${p.name}`)
            }
            continue
        }

        switch (p.in) {
            case 'path':
                pathTemplate = pathTemplate.replace(`{${p.name}}`, val)
                continue

            case 'query':
                if (p.style) {
                    throw new Error(`Query style not implemented: ${p.style}`)
                }
                query.set(p.name, val)
                continue

            default:
                throw new Error(`Param type not implemented: ${p.in}`)
        }
    }

    const queryStr = query.size > 0 ? `?${query.toString()}` : ''

    return {
        path: `${pathTemplate}${queryStr}`,
        body: req.body,
    }
}

async function sendRequest(
    baseUrl: string,
    method: string,
    pathTemplate: string, 
    params: Param[], 
    req: Record<string, any>,
    authorization?: string | (() => string | Promise<string>)
) {
    const built = buildRequest(pathTemplate, params, req)
    const headers: Record<string, string> = { 'user-agent': 'synapse' }
    const auth = typeof authorization === 'string' ? authorization : await authorization?.()
    if (auth) {
        headers['authorization'] = auth
    }

    const url = new URL(built.path, baseUrl)

    return fetch(url, {
        headers,
        method,
        body: built.body,
    })
}
