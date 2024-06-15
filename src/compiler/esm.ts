import ts from 'typescript'
import { createVariableStatement } from '../utils'

// 1. normalize all import declarations to the namespace form e.g. `import * as foo from 'foo'`
// 2. change the namespace identifier e.g. `__foo_namespace` instead of `foo`
// 3. emit a wrapped assignment `const foo = __wrapExports('foo', import.meta.__importer, __foo_namespace)
// 4. use wrapped namespace to create original bindings, e.g. for default use `__wrapExports('foo', import.meta.__importer, __foo_namespace).default`


// TODO: wrap dynamic imports too

export function transformImports(sf: ts.SourceFile) {
    const imports: ts.Statement[] = []
    const wraps: ts.Statement[] = []
    const bindings: ts.Statement[] = []

    const didEmit = new Set<string>()
    const specMap = new Map<string, string>()
    function specToIdent(spec: string) {
        if (specMap.has(spec)) {
            return specMap.get(spec)!
        }

        const val = `__import_${specMap.size}`
        specMap.set(spec, val)

        return val
    }

    function createWrap(spec: ts.Expression, namespace: ts.Expression) {
        const importer = ts.factory.createPropertyAccessExpression(
            ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier('import'),
                'meta'
            ),
            '__virtualId'
        )

        return ts.factory.createCallExpression(
            ts.factory.createIdentifier('__wrapExports'),
            undefined,
            [spec, importer, namespace]
        )
    }

    function wrapNamespace(spec: string, attributes?: ts.ImportAttributes) {
        const name = specToIdent(spec)
        if (didEmit.has(spec)) {
            return name
        }

        didEmit.add(spec)

        const namespace = name + '_namespace'

        const importDecl = ts.factory.createImportDeclaration(
            undefined,
            ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(ts.factory.createIdentifier(namespace))),
            ts.factory.createStringLiteral(spec),
            attributes
        )

        imports.push(importDecl)

        const wrapped = createWrap(ts.factory.createStringLiteral(spec), ts.factory.createIdentifier(namespace))
        wraps.push(createVariableStatement(name, wrapped))

        return name
    }

    function createAlias(spec: string, name: string, propertyName = name, attributes?: ts.ImportAttributes) {
        const wrappedName = wrapNamespace(spec, attributes)

        return createVariableStatement(
            name,
            ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier(wrappedName),
                propertyName,
            )
        )
    }

    function transform(decl: ts.ImportDeclaration) {
        const clause = decl.importClause
        if (!clause) { // `import 'foo'`
            return decl
        }

        if (clause.isTypeOnly) {
            return decl
        }

        const spec = (decl.moduleSpecifier as ts.StringLiteral).text

        const currentBindings: ts.Statement[] = []
        if (clause.name) { // import foo from 'foo'
            currentBindings.push(
                createAlias(spec, clause.name.text, 'default', decl.attributes)
            )
        }

        const namedBindings = clause.namedBindings
        if (namedBindings) {
            if (ts.isNamedImports(namedBindings)) {
                for (const binding of namedBindings.elements) {
                    if (binding.isTypeOnly) continue
    
                    currentBindings.push(
                        createAlias(spec, binding.name.text, binding.propertyName?.text, decl.attributes)
                    )
                }
            } else {
                currentBindings.push(
                    createVariableStatement(
                        namedBindings.name,
                        ts.factory.createIdentifier(wrapNamespace(spec, decl.attributes)),
                    )
                )
            }
        }

        if (currentBindings.length === 0) {
            return decl
        }

        bindings.push(...currentBindings)

        return ts.factory.createNotEmittedStatement(decl)
    }

    function wrapDynamicImport(node: ts.CallExpression) {
        return ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(node, 'then'),
            undefined,
            [
                ts.factory.createArrowFunction(
                    undefined,
                    undefined,
                    [ts.factory.createParameterDeclaration(undefined, undefined, 'namespace')],
                    undefined,
                    undefined,
                    // TODO: this evaluates the specifier expression twice (which can cause problems!!!)
                    createWrap(node.arguments[0], ts.factory.createIdentifier('namespace'))
                )
            ]
        )
    }

    const mapped = sf.statements.map(s => {
        if (!ts.isImportDeclaration(s)) {
            return s
        }

        return transform(s)
    })

    if (imports.length === 0) {
        return sf
    }

    return ts.factory.updateSourceFile(
        sf,
        [
            ...imports,
            ...wraps,
            ...bindings,
            ...mapped,
        ]
    )
}

