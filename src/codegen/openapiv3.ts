interface Info {
    readonly title: string;
    readonly description?: string;
    readonly termsOfService?: string;
    readonly contact?: Contact;
    readonly license?: License;
    readonly version: string;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Contact {
    readonly name?: string;
    readonly url?: string;
    readonly email?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
interface License {
    readonly name: string;
    readonly url?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
interface ExternalDocumentation {
    readonly description?: string;
    readonly url: string;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Server {
    readonly url: string;
    readonly description?: string;
    readonly variables?: Record<string, ServerVariable>;
    readonly [name: `x-${string}`]: any | undefined;
}
interface ServerVariable {
    readonly enum?: string[];
    readonly default: string;
    readonly description?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Tag {
    readonly name: string;
    readonly description?: string;
    readonly externalDocs?: ExternalDocumentation;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Paths {
    readonly [name: `/${string}`]: PathItem | undefined;
    readonly [name: `x-${string}`]: any | undefined;
}
interface PathItem {
    readonly $ref?: string;
    readonly summary?: string;
    readonly description?: string;
    readonly servers?: Server[];
    readonly parameters?: ((any & SchemaXORContent & ParameterLocation) | Reference)[];
    readonly "get"?: Operation;
    readonly "put"?: Operation;
    readonly "post"?: Operation;
    readonly "delete"?: Operation;
    readonly "options"?: Operation;
    readonly "head"?: Operation;
    readonly "patch"?: Operation;
    readonly "trace"?: Operation;
    readonly [name: `x-${string}`]: any | undefined;
}
type SchemaXORContent = (any & any & any & any & any);
type ParameterLocation = {
    readonly in?: "path";
    readonly style?: "matrix" | "label" | "simple";
    readonly required: true;
} | {
    readonly in?: "query";
    readonly style?: "form" | "spaceDelimited" | "pipeDelimited" | "deepObject";
} | {
    readonly in?: "header";
    readonly style?: "simple";
} | {
    readonly in?: "cookie";
    readonly style?: "form";
};
interface Reference {
    readonly "$ref"?: string;
}
interface Operation {
    readonly tags?: string[];
    readonly summary?: string;
    readonly description?: string;
    readonly externalDocs?: ExternalDocumentation;
    readonly operationId?: string;
    readonly parameters?: ((any & SchemaXORContent & ParameterLocation) | Reference)[];
    readonly requestBody?: RequestBody | Reference;
    readonly responses: Responses;
    readonly callbacks?: Record<string, Record<string, PathItem> | Reference>;
    readonly deprecated?: boolean;
    readonly security?: Record<string, string[]>[];
    readonly servers?: Server[];
    readonly [name: `x-${string}`]: any | undefined;
}
interface RequestBody {
    readonly description?: string;
    readonly content: Record<string, any>;
    readonly required?: boolean;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Responses {
    readonly default?: Response | Reference;
    readonly [name: `${string}`]: (Response | Reference) | undefined;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Response {
    readonly description: string;
    readonly headers?: Record<string, (any & SchemaXORContent) | Reference>;
    readonly content?: Record<string, any>;
    readonly links?: Record<string, any | Reference>;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Components {
    readonly schemas?: {
        readonly [name: `${string}`]: (Schema | Reference) | undefined;
    };
    readonly responses?: {
        readonly [name: `${string}`]: (Reference | Response) | undefined;
    };
    readonly parameters?: {
        readonly [name: `${string}`]: (Reference | (any & SchemaXORContent & ParameterLocation)) | undefined;
    };
    readonly examples?: {
        readonly [name: `${string}`]: (Reference | Example) | undefined;
    };
    readonly requestBodies?: {
        readonly [name: `${string}`]: (Reference | RequestBody) | undefined;
    };
    readonly headers?: {
        readonly [name: `${string}`]: (Reference | (any & SchemaXORContent)) | undefined;
    };
    readonly securitySchemes?: {
        readonly [name: `${string}`]: (Reference | SecurityScheme) | undefined;
    };
    readonly links?: {
        readonly [name: `${string}`]: (Reference | any) | undefined;
    };
    readonly callbacks?: {
        readonly [name: `${string}`]: (Reference | Record<string, PathItem>) | undefined;
    };
    readonly [name: `x-${string}`]: any | undefined;
}
interface Schema {
    readonly title?: string;
    readonly multipleOf?: number;
    readonly maximum?: number;
    readonly exclusiveMaximum?: boolean;
    readonly minimum?: number;
    readonly exclusiveMinimum?: boolean;
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly pattern?: string;
    readonly maxItems?: number;
    readonly minItems?: number;
    readonly uniqueItems?: boolean;
    readonly maxProperties?: number;
    readonly minProperties?: number;
    readonly required?: string[];
    readonly enum?: any[];
    readonly type?: "array" | "boolean" | "integer" | "number" | "object" | "string";
    readonly not?: Schema | Reference;
    readonly allOf?: (Schema | Reference)[];
    readonly oneOf?: (Schema | Reference)[];
    readonly anyOf?: (Schema | Reference)[];
    readonly items?: Schema | Reference;
    readonly properties?: Record<string, Schema | Reference>;
    readonly additionalProperties?: Schema | Reference | boolean;
    readonly description?: string;
    readonly format?: string;
    readonly default?: any;
    readonly nullable?: boolean;
    readonly discriminator?: Discriminator;
    readonly readOnly?: boolean;
    readonly writeOnly?: boolean;
    readonly example?: any;
    readonly externalDocs?: ExternalDocumentation;
    readonly deprecated?: boolean;
    readonly xml?: XML;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Discriminator {
    readonly propertyName: string;
    readonly mapping?: Record<string, string>;
}
interface XML {
    readonly name?: string;
    readonly namespace?: string;
    readonly prefix?: string;
    readonly attribute?: boolean;
    readonly wrapped?: boolean;
    readonly [name: `x-${string}`]: any | undefined;
}
interface Example {
    readonly summary?: string;
    readonly description?: string;
    readonly value?: any;
    readonly externalValue?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
type SecurityScheme = APIKeySecurityScheme | HTTPSecurityScheme | OAuth2SecurityScheme | OpenIdConnectSecurityScheme;
interface APIKeySecurityScheme {
    readonly type: "apiKey";
    readonly name: string;
    readonly in: "header" | "query" | "cookie";
    readonly description?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
type HTTPSecurityScheme = {
    readonly scheme?: string;
} | any;
interface OAuth2SecurityScheme {
    readonly type: "oauth2";
    readonly flows: OAuthFlows;
    readonly description?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
interface OAuthFlows {
    readonly implicit?: ImplicitOAuthFlow;
    readonly password?: PasswordOAuthFlow;
    readonly clientCredentials?: ClientCredentialsFlow;
    readonly authorizationCode?: AuthorizationCodeOAuthFlow;
    readonly [name: `x-${string}`]: any | undefined;
}
interface ImplicitOAuthFlow {
    readonly authorizationUrl: string;
    readonly refreshUrl?: string;
    readonly scopes: Record<string, string>;
    readonly [name: `x-${string}`]: any | undefined;
}
interface PasswordOAuthFlow {
    readonly tokenUrl: string;
    readonly refreshUrl?: string;
    readonly scopes: Record<string, string>;
    readonly [name: `x-${string}`]: any | undefined;
}
interface ClientCredentialsFlow {
    readonly tokenUrl: string;
    readonly refreshUrl?: string;
    readonly scopes: Record<string, string>;
    readonly [name: `x-${string}`]: any | undefined;
}
interface AuthorizationCodeOAuthFlow {
    readonly authorizationUrl: string;
    readonly tokenUrl: string;
    readonly refreshUrl?: string;
    readonly scopes: Record<string, string>;
    readonly [name: `x-${string}`]: any | undefined;
}
interface OpenIdConnectSecurityScheme {
    readonly type: "openIdConnect";
    readonly openIdConnectUrl: string;
    readonly description?: string;
    readonly [name: `x-${string}`]: any | undefined;
}
export interface OpenApiModel {
    readonly openapi: string;
    readonly info: Info;
    readonly externalDocs?: ExternalDocumentation;
    readonly servers?: Server[];
    readonly security?: Record<string, string[]>[];
    readonly tags?: Tag[];
    readonly paths: Paths;
    readonly components?: Components;
    readonly [name: `x-${string}`]: any | undefined;
}