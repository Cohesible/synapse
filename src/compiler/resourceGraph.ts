import ts from 'typescript'
import * as path from 'node:path'
import { CompilerOptions } from './host'
import { createSyntheticComment, failOnNode, getNodeLocation, isExported, isWindows, keyedMemoize, makeRelative, resolveRelative, sortRecord, throwIfNotFileNotFoundError } from '../utils'
import { JsonFs } from '../system'
import { createGraphCompiler, Scope, Symbol } from '../static-solver'
import { Compilation } from './incremental'
import { getLogger } from '../logging'
import { getCallableDirective, getResourceDirective } from './transformer'
import { getProgramFs } from '../artifacts'
import { getWorkingDir } from '../workspaces'
import { loadTypes } from '../pm/packages'
import { getOutputFilename } from './config'
import { printLine } from '../cli/ui'
import { annotateNode, compilerError } from './diagnostics'

interface SymbolNameComponents {
    name?: string
    fileName?: string
    specifier?: string
    isImported?: boolean
}

interface ResourceInstantiation {
    readonly kind: string // FQN/Symbol
}

export interface TypeInfo {
    intrinsic?: boolean
    instanceType?: string
    callable?: string // the callable member on the _instance_
    // this describes what resources _would_ be created if the type is instantiated
    instantiations?: ResourceInstantiation[]

    // Used for property/element access expressions
    memberName?: string
    members?: Record<string, TypeInfo>
}

export interface TypesFileData {
    [fileName: string]: Record<string, TypeInfo>
}

function isSimpleAssignmentExpression(node: ts.Node): node is ts.BinaryExpression {
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
}

// Used for incremental builds
interface StoredTypesFilesData {
    [sourceFileName: string]: {
        outfile: string
        exports: Record<string, TypeInfo>
        instantiations: ResourceInstantiation[]
        hasCalledCallable: boolean
    }
}

export type ResourceTypeChecker = ReturnType<typeof createResourceGraph>
export function createResourceGraph(
    program: ts.Program,
    compilation: Compilation,
    graphCompiler: ReturnType<typeof createGraphCompiler>
) {
    const importMap = new Map<string, Map<string, string>>()
    for (let i = 0; i < compilation.graph.edges.length; i++) {
        if (compilation.graph.typeEdges.has(i)) {
            continue
        }

        const edge = compilation.graph.edges[i]
        const spec = compilation.graph.specifiers.get(i)
        if (!spec) {
            throw new Error(`Missing specifier from "${edge[0]}" to "${edge[1]}"`)
        }

        const m = importMap.get(edge[0]) ?? new Map()
        importMap.set(edge[0], m)
        m.set(spec, edge[1])
    }

    const runtimeModulesDecls = new Map<string, string>()
    const reverseRuntimeModulesDecls = new Map<string, string>()

    function getFilePathFromSpecifier(spec: string, origin: string) {
        const m = importMap.get(origin)
        // if (!m) {
        //     throw new Error(`No import mapping found for file: ${origin}`)
        // }

        return m?.get(spec) ?? runtimeModulesDecls.get(spec)
    }

    const fileSymbols = new Map<string, Record<string, TypeInfo>>()
    function getFileSymbols(fileName: string) {
        // XXX: windows hack
        if (isWindows()) {
            fileName = fileName.replaceAll('\\', '/')
        }
        if (fileSymbols.has(fileName)) {
            return fileSymbols.get(fileName)!
        }

        const checker = getSourceFileTypeChecker(fileName)
        fileSymbols.set(fileName, checker.exported)
        checker.init()

        return checker.exported
    }

    const fileInstantiations = new Map<string, ResourceInstantiation[]>()
    function getFileResourceInstantiations(fileName: string) {
        // XXX: windows hack
        if (isWindows()) {
            fileName = fileName.replaceAll('\\', '/')
        }
        if (fileInstantiations.has(fileName)) {
            return fileInstantiations.get(fileName)!
        }
    
        const checker = getSourceFileTypeChecker(fileName)
        const insts = checker.getResourceInstantiations()
        fileInstantiations.set(fileName, insts)

        return insts
    }

    const calledCallables = new Map<string, boolean>()
    function hasCalledCallables(fileName: string) {
        // XXX: windows hack
        if (isWindows()) {
            fileName = fileName.replaceAll('\\', '/')
        }
        if (calledCallables.has(fileName)) {
            return calledCallables.get(fileName)!
        }

        const checker = getSourceFileTypeChecker(fileName)
        return checker.hasCalledCallables()
    }

    function toString(components: SymbolNameComponents) {
        // Note that using the specifier isn't correct unless we qualify the origin
        const moduleName = components.specifier ?? components.fileName 
        if (!components.name && !moduleName) {
            throw new Error(`Symbol components contain no module name or symbol name: ${JSON.stringify(components, undefined, 4)}`)
        }

        return moduleName ? `"${moduleName}"${components.name ? `.${components.name}` : ''}` : components.name! 
    }

    function getImportName(sym: Symbol, clause: ts.ImportClause) {
        const parent = sym.declaration?.parent
        if (parent === clause) {
            return 'default'
        }

        if (parent && ts.isImportSpecifier(parent)) {
            const name = parent.propertyName ?? parent.name

            return name.text
        }
    }

    const shouldReplace = isWindows()
    function normalizeFileName(f: string) {
        return shouldReplace ? f.replaceAll('\\', '/') : f
    }

    function resolveModuleSpecifier(node: ts.Node) {
        const origin = normalizeFileName(node.getSourceFile().fileName)
        const moduleSpec = (node as ts.StringLiteral).text
        
        return {
            specifier: moduleSpec,
            fileName: getFilePathFromSpecifier(moduleSpec, origin),
        }
    }

    function getNameComponents(sym: Symbol): SymbolNameComponents {
        if (sym.parent) {
            const parentFqn = getNameComponents(sym.parent)

            return {
                ...parentFqn,
                name: parentFqn.name ? `${parentFqn.name}.${sym.name}` : sym.name,
            }
        }

        if (sym.importClause) {
            const { fileName, specifier } = resolveModuleSpecifier(sym.importClause.parent.moduleSpecifier)
            const name = getImportName(sym, sym.importClause)

            return { fileName, specifier, name, isImported: true }
        }
    
        const fileName = sym.declaration?.getSourceFile().fileName

        return { fileName: fileName ? normalizeFileName(fileName) : undefined, name: sym.name }
    }

    function getNameComponentsFromNode(node: ts.Node): SymbolNameComponents | undefined {
        if (node.kind === ts.SyntaxKind.CallExpression || node.kind === ts.SyntaxKind.NewExpression) {
            return getNameComponentsFromNode((node as ts.CallExpression).expression)
        } else if (node.kind === ts.SyntaxKind.AwaitExpression || node.kind === ts.SyntaxKind.ParenthesizedExpression) {
            return getNameComponentsFromNode((node as ts.AwaitExpression).expression)
        }

        const sym = graphCompiler.getSymbol(node)

        return sym ? getNameComponents(sym) : undefined
    }

    function isDeferCall(components: SymbolNameComponents) {
        return components?.specifier === 'synapse:core' && components.name === 'defer'
    }

    function isUsingCall(components: SymbolNameComponents) {
        return components?.specifier === 'synapse:core' && components.name === 'using'
    }

    function isDefineResource(node: ts.Expression) {
        if (!ts.isCallExpression(node)) {
            return false
        }

        const components = getNameComponentsFromNode(node.expression)

        return components?.specifier === 'synapse:core' && components.name === 'defineResource'
    }

    function isDefineDataSource(node: ts.Expression) {
        if (!ts.isCallExpression(node)) {
            return false
        }

        const components = getNameComponentsFromNode(node.expression)

        return components?.specifier === 'synapse:core' && components.name === 'defineDataSource'
    }

    function getExternalNodeType(name: string, components: SymbolNameComponents) {
        const module = components.specifier
        if (module && (module.startsWith('synapse-provider:') || module === 'synapse:lib')) {
            return { intrinsic: true }
        }

        if (module === 'synapse:core' && name === 'getBuildTarget') {
            return { intrinsic: true }
        } 

        if (!components.fileName) {
            return
        }

        const symbols = getFileSymbols(components.fileName)

        return symbols[name]
    }

    function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
        return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isMethodDeclaration(node)
    }

    interface TypeChecker {
        readonly exported: Record<string, TypeInfo>
        getNodeType(node: ts.Node): TypeInfo | undefined
    }

    function _getSourceFileTypeChecker(fileName: string) {
        const sf = program.getSourceFile(fileName)
        if (!sf) {
            throw new Error(`No source file: ${fileName}`)
        }

        return createSourceFileTypeChecker(sf)
    }

    const getSourceFileTypeChecker = keyedMemoize(_getSourceFileTypeChecker)

    function createSourceFileTypeChecker(sf: ts.SourceFile) {
        const exported: Record<string, TypeInfo> = {}
        const stack: Map<ts.Node, ResourceInstantiation[]>[] = [new Map()]
        const types = new Map<ts.Node, Partial<TypeInfo>>()
        const symbolTypes = new Map<Symbol, Partial<TypeInfo>>()
        const calledCallables = new Map<ts.Node, TypeInfo>()

        function addInstantiations(node: ts.Node, ...instances: ResourceInstantiation[]) {
            const instantiations = stack[stack.length - 1]
            instantiations.set(node, instances)
        }

        function getSymbolType(sym: Symbol) {
            if (symbolTypes.has(sym)) {
                return symbolTypes.get(sym)
            }

            const type: Partial<TypeInfo> = {}
            symbolTypes.set(sym, type)

            if (!sym.variableDeclaration?.initializer) {
                return
            }

            const initializer = sym.variableDeclaration.initializer
            if (isDefineResource(initializer) || isDefineDataSource(initializer)) {
                type.intrinsic = true

                return type
            }

            const initType = visitExpression(initializer)
            if (initType?.instanceType) {
                type.callable = initType.callable
                type.instanceType = initType.instanceType
                type.members = initType.members

                return type
            }

            if (initType) {
                type.callable = initType.callable
                if (initType.intrinsic || (initType.instantiations && initType.instantiations.length > 0)) {
                    const components = getNameComponentsFromNode(initializer)
                    if (!components) {
                        failOnNode(`Missing symbol for node`, initializer)
                    }

                    type.instanceType = toString(components)
                    type.members = initType.members
                }

                return type
            }
        }

        function getNodeType(node: ts.Node): Partial<TypeInfo> | undefined {
            if (types.has(node)) {
                return types.get(node)
            }

            if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
                const type: Partial<TypeInfo> = visitExpression(node) ?? {}
                types.set(node, type)

                return type
            }

            const type: Partial<TypeInfo> = {}
            types.set(node, type)

            if (ts.isVariableDeclaration(node)) {
                const sym = graphCompiler.getSymbol(node)
                if (!sym) {
                    getLogger().warn('missing symbol', getNodeLocation(node))
                    return
                }
    
                const type = getSymbolType(sym)
                if (!type) {
                    return
                }

                types.set(node, type)
                
                return type
            } else if (isSimpleAssignmentExpression(node)) {
                const type = getNodeType(node.right)
                if (!type) {
                    return
                }

                types.set(node, type)

                return type
            }

            const isClassLike = ts.isClassLike(node)
            if (!isClassLike && !isFunctionLikeDeclaration(node)) {
                return
            }

            const resourceDirective = getResourceDirective(node)
            if (resourceDirective) {
                const callable = getCallableDirective(node)
                type.intrinsic = true
                type.callable = callable

                if (isClassLike) {
                    const methods: Record<string, TypeInfo> = {}
                    for (const m of node.members) {
                        if (m.kind === ts.SyntaxKind.MethodDeclaration && getResourceDirective(m)) {
                            methods[m.name!.getText()] = { intrinsic: true }
                        }
                    }
                    type.members = methods
                }

                return type
            }

            stack.push(new Map())

            const declType = isClassLike
                ? visitClassLikeDeclaration(node) 
                : visitFunctionLikeDeclaration(node)

            const instantiations = stack.pop()!
            type.intrinsic = declType?.intrinsic

            const insts = [...instantiations.values()].flat()
            if (insts.length > 0) {
                type.instantiations = insts
            }

            return type
        }

        function checkNode(node: ts.Node) {
            const components = getNameComponentsFromNode(node)
            if (!components || !components.name) {
                return
            }

            if (isDeferCall(components)) {
                return getNodeType((node.parent as ts.CallExpression).arguments[0])
            }

            if (isUsingCall(components)) {
                return getNodeType((node.parent as ts.CallExpression).arguments[1])
            }

            const isLocal = components.fileName === normalizeFileName(node.getSourceFile().fileName)
            if (!isLocal) {
                return getExternalNodeType(components.name, components)
            }

            const sym = graphCompiler.getSymbol(node)
            if (!sym) {
                return
            }

            if (sym.parent) {
                const ty = getSymbolType(sym.parent)
                const memberType = ty?.members?.[sym.name]
                if (sym.parent.name !== 'this' || memberType) { // Need to implement types for `this`
                    return memberType
                }
            }

            const valueDecl = sym?.declaration
            if (!valueDecl) {
                return
            }

            return getNodeType(valueDecl)
        }

        function visitExpression(node: ts.Expression): TypeInfo | undefined {
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                if (node.arguments) {
                    node.arguments.forEach(visitExpression)
                }

                const type = checkNode(node.expression)
                if (type?.intrinsic) {
                    const kind = toString(getNameComponentsFromNode(node.expression)!)
                    addInstantiations(node, { kind })

                    return { instanceType: kind, callable: type.callable, members: type.members }
                }

                if (type?.instantiations) {
                    addInstantiations(node, ...type.instantiations)
                }

                if (type?.callable) {
                    calledCallables.set(node, type)
                }

                return type
            } else if (ts.isFunctionExpression(node) || ts.isClassExpression(node) || ts.isArrowFunction(node)) {
                return getNodeType(node)
            } else if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
                return visitExpression(node.expression)
            } else if (ts.isPropertyAccessExpression(node)) {
                const ty = checkNode(node.expression)

                return ty?.members?.[node.name.text]
            } else {
                node.forEachChild(visit)
            }
        }

        function visitStatements(nodes: readonly ts.Statement[]) {
            const remainder: ts.Statement[] = []
            for (const n of nodes) {
                // TODO: these should be visited in the order of their dependencies
                if (ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n)) {
                    getNodeType(n)
                } else {
                    remainder.push(n)
                }
            }
            
            for (const n of remainder) {
                if (ts.isExpressionStatement(n)) {
                    visitExpression(n.expression)
                } else {
                    n.forEachChild(visit)
                }
            }
        }

        function visitFunctionLikeDeclaration(node: ts.FunctionLikeDeclaration) {
            for (const p of node.parameters) {
                if (p.initializer) {
                    visitExpression(p.initializer)
                }
            }

            if (node.body) {
                if (ts.isExpression(node.body)) {
                    visitExpression(node.body)
                } else {
                    visitStatements(node.body.statements)
                }
            }
        }

        function visitClassLikeDeclaration(node: ts.ClassLikeDeclaration) {
            for (const m of node.members) {
                if (ts.isPropertyDeclaration(m) && m.initializer) {
                    visitExpression(m.initializer)
                }

                if (ts.isConstructorDeclaration(m)) {
                    visitFunctionLikeDeclaration(m)
                }

                // TODO: static block?
            }

            const superClass = node.heritageClauses?.find(x => x.token === ts.SyntaxKind.ExtendsKeyword)?.types[0].expression
            if (superClass) {
                if (isDefineResource(superClass)) {
                    return { intrinsic: true }
                } else {
                    if (ts.isIdentifier(superClass) || ts.isExpressionWithTypeArguments(superClass)) {
                        const ty = checkNode(!ts.isIdentifier(superClass) ? superClass.expression : superClass)
                        if (ty?.instantiations) {
                            addInstantiations(node, ...ty.instantiations)
                        }
                    } else {
                        visitExpression(superClass)
                    }
                }
            }
        }

        function visit(node: ts.Node) {
            if (ts.isExpression(node)) {
                visitExpression(node)
            } else {
                node.forEachChild(visit)
            }
        }

        // XXX: this is a hack to allow for late binding
        function init() {
            function visitExported(node: ts.Node) {
                const type = getNodeType(node)
                if (type?.intrinsic || (type?.instantiations && type.instantiations.length > 0) || type?.instanceType) {
                    exported[getNameComponentsFromNode(node)!.name!] = type
                }
            }

            for (const s of sf.statements) {
                if (ts.isExportDeclaration(s) && !s.isTypeOnly) {
                    if (!s.moduleSpecifier) {
                        if (!s.exportClause || !ts.isNamedExports(s.exportClause)) {
                            continue
                        }

                        for (const spec of s.exportClause.elements) {
                            const exportName = spec.name.text
                            const key = spec.propertyName ?? spec.name
                            const type = checkNode(key)
                            if (type) {
                                exported[exportName] = type
                            }
                        }

                        continue
                    }

                    const fileName = resolveModuleSpecifier(s.moduleSpecifier).fileName
                    if (!fileName) {
                        continue
                    }

                    const symbols = getFileSymbols(fileName)
                    if (!s.exportClause) {
                        for (const [k, v] of Object.entries(symbols)) {
                            exported[k] = v
                        }
                    } else if (ts.isNamedExports(s.exportClause)) {
                        for (const spec of s.exportClause.elements) {
                            const exportName = spec.name.text
                            const key = spec.propertyName?.text ?? exportName
                            exported[exportName] = symbols[key]
                        }
                    } else if (ts.isNamespaceExport(s.exportClause)) {
                        for (const [k, v] of Object.entries(symbols)) {
                            exported[`${s.exportClause.name.text}.${k}`] = v
                        }
                    }

                    continue
                }

                if (!isExported(s)) {
                    if (ts.isVariableStatement(s)) {
                        for (const decl of s.declarationList.declarations) {
                            getNodeType(decl)
                        }
                    }
                    continue
                }

                if (ts.isVariableStatement(s)) {
                    for (const decl of s.declarationList.declarations) {
                        visitExported(decl)
                    }
                } else {
                    visitExported(s)
                }
            }
        }

        function infoToComments(info: Partial<TypeInfo>) {
            const comments: ts.SynthesizedComment[] = []
            if (info.instantiations) {
                comments.push(...info.instantiations.map(x => createSyntheticComment(` ${x.kind}`)))
            }

            return comments
        }

        function printTypes() {
            // function visit(node: ts.Node) {
            //     const info = getNodeType(node)
            //     if (info) {
            //         ts.setSyntheticLeadingComments(node, infoToComments(info))
            //     }

            //     node.forEachChild(visit)
            // }

            // visit(sf)

            for (const [k, v] of types) {
                if (v.callable || v.instanceType || v.intrinsic || v.instantiations) {
                    printLine(getNodeLocation(k), JSON.stringify(v, undefined, 4))
                }
            }

            // getLogger().log(printNodes(sf.statements, sf))
        }

        function getResourceInstantiations() {
            const instantiations = new Map<ts.Node, ResourceInstantiation[]>()
            function visitNode(node: ts.Node) {
                if (ts.isBlock(node)) {
                    return visitStatements(node.statements)
                }

                const type = getNodeType(node)
                if ((type?.instantiations && type.instantiations.length > 0) || type?.instanceType) {
                    const inst = [...type.instantiations ?? []]
                    if (type.instanceType) {
                        inst.push({ kind: type.instanceType })
                    }
                    instantiations.set(node, inst)
                }
            }

            function visitStatements(statements: readonly ts.Statement[]) {
                for (const s of statements) {
                    if (ts.isVariableStatement(s)) {
                        for (const decl of s.declarationList.declarations) {
                            visitNode(decl)
                        }
                    } else if (ts.isExpressionStatement(s)) {
                        visitNode(s.expression)
                    } else if (ts.isIfStatement(s)) {
                        visitNode(s.expression)
                        visitNode(s.thenStatement)

                        if (s.elseStatement) {
                            visitNode(s.elseStatement)
                        }
                    } else if (ts.isForStatement(s) || ts.isForOfStatement(s)) {
                        visitNode(s.statement)
                    } else if (!ts.isFunctionDeclaration(s) && !ts.isClassDeclaration(s)) {
                        visitNode(s)
                    }
                }
            }

            visitStatements(sf.statements)

            // for (const [k, v] of instantiations) {
            //     console.log(getNodeLocation(k), v)
            // }

            return [...instantiations.values()].flat()
        }

        function hasCalledCallables() {
            return calledCallables.size > 0
        }

        getMarkedNodes(sf)

        return {
            exported,
            init,
            getNodeType,
            getSymbolType,
            printTypes,
            getResourceInstantiations,
            hasCalledCallables,
        }
    }

    function registerTypes(dir: string, data: TypesFileData) {
        getLogger().log(`Registered types for: "${dir}"`)

        for (const [k, v] of Object.entries(data)) {
            fileSymbols.set(resolveRelative(dir, k), v)
        }
    }

    async function generateTypes(files: string[], tscRootDir: string, opt: ts.CompilerOptions, incremental = false) {
        const { types, runtimeModules } = await loadTypes()

        for (const [k, v] of Object.entries(runtimeModules)) {
            runtimeModulesDecls.set(k, v)
            reverseRuntimeModulesDecls.set(v, k)
        }

        for (const [k, v] of Object.entries(types)) {
            registerTypes(k, v)
        }

        const workingDirectory = getWorkingDir()
        const outfiles = Object.fromEntries(files.map(fileName => {
            const outfile = getOutputFilename(tscRootDir, opt, fileName)

            return [
                fileName, 
                makeRelative(workingDirectory, outfile).replace(/\.js$/, '.d.ts')
            ]
        }))

        const data: StoredTypesFilesData = {}

        if (incremental) {
            const oldTypes = await getTypes()
            for (const [k, v] of Object.entries(oldTypes ?? {})) {
                const resolved = resolveRelative(workingDirectory, k)
                if (!outfiles[resolved]) {
                    data[k] = v
                    fileSymbols.set(resolved, v.exports)
                    fileInstantiations.set(resolved, v.instantiations)
                    calledCallables.set(resolved, v.hasCalledCallable)
                }
            }
        }

        for (const fileName of files) {
            const outfile = outfiles[fileName]
            data[makeRelative(workingDirectory, fileName)] = {
                outfile,
                exports: getFileSymbols(fileName),
                instantiations: getFileResourceInstantiations(fileName),
                hasCalledCallable: hasCalledCallables(fileName),
            }
        }

        // TODO: don't wait on this
        await setTypes(data)
    }

    function makeTypesRelative(data: StoredTypesFilesData) {
        for (const v of Object.values(data)) {
            for (const info of Object.values(v.exports)) {
                if (info.instanceType) {
                    info.instanceType = makeRelativeId(info.instanceType)
                }

                if (info.instantiations) {
                    info.instantiations = info.instantiations.map(inst => ({ ...inst, kind: makeRelativeId(inst.kind) }))
                }
            }

            v.instantiations = v.instantiations.map(inst => ({ ...inst, kind: makeRelativeId(inst.kind) }))
        }
    }

    function makeRelativeId(typeId: string) {
        const [_, f, n] = typeId.match(/^"([^"]+)"\.(.+)$/) ?? []
        if (!f) {
            return typeId
        }

        const spec = reverseRuntimeModulesDecls.get(f)
        if (spec) {
            return `"${spec}".${n}`
        }

        return typeId
    }

    function getCallableMemberName(sym: Symbol) {
        const components = getNameComponents(sym)
        if (!components.fileName) {
            return
        }

        if (components.isImported) {
            if (!components.name) {
                return
            }

            return getFileSymbols(components.fileName)[components.name]?.callable
        }

        const checker = getSourceFileTypeChecker(components.fileName)
        const type = checker.getSymbolType(sym)

        return type?.callable
    }

    function getNodeType(node: ts.Node) {
        const components = getNameComponentsFromNode(node)
        if (!components?.fileName) {
            return
        }

        if (components.isImported) {
            if (!components.name) {
                return
            }

            return getFileSymbols(components.fileName)[components.name]
        }

        const checker = getSourceFileTypeChecker(components.fileName)

        return checker.getNodeType(node)
    }

    function checkForResourceInstantiations(sym: Symbol) {
        const node = sym.declaration
        if (!node) {
            return
        }
    
        const type = getNodeType(node)
        if (type?.instantiations) {
            failOnNode(`Expression instantiates resources`, node)
        }
    
        const deps = graphCompiler.getAllDependencies(sym)
        for (const d of deps) {
            const node = d.declaration
            if (!node) {
                continue
            }
        
            const type = getNodeType(node)
            if (type?.instantiations) {
                failOnNode(`Expression instantiates resources`, node)
            }    
        }
    }

    function printTypes(f: string) {
        getSourceFileTypeChecker(f).printTypes()
    }

    // This is basically a directive to force captured functions into
    // module scope so they can be annotated. Synthesis can use this
    // annotation to augment captured functions as they are synth'd.
    function getMarkedNodes(node: ts.Node) {
        const marked = new Set<ts.Node>()

        function visit(node: ts.Node) {
            if (!ts.isCallExpression(node)) {
                return void node.forEachChild(visit)
            }

            const sym = graphCompiler.getSymbol(node.expression)
            if (!sym) {
                return void node.forEachChild(visit)
            }

            const components = getNameComponents(sym)
            if (components.specifier !== '@cohesible/synapse-websites' || components.name !== 'useServer') {
                return void node.forEachChild(visit)
            }

            const argNode = node.arguments[0]
            switch (argNode.kind) {
                // These are all OK
                case ts.SyntaxKind.Identifier:
                case ts.SyntaxKind.ElementAccessExpression:
                case ts.SyntaxKind.PropertyAccessExpression:
                    break

                default:
                    compilerError(`"useServer" is only implemented for function declarations and variables referencing functions`, argNode)
            }

            const argSym = graphCompiler.getSymbol(argNode)
            if (!argSym || !argSym.declaration) {
                return // No point in visiting more nodes
            }

            // Argument cases:
            // 1. Identifier
            //  1a. Function decl outside of the containing decl
            //  1b. Function decl inside the containing decl
            //  1c. Variable decl -> treat initializer as the argument
            // 2. Arrow function / Function expression
            // 3. Expression that can be reduced to one of the above (incl. call expression)
            // 
            // For call expressions, we need to handle all possible return values.

            function getContainingDeclarationLike(n: ts.Node) {
                let p = n.parent
                while (p) {
                    // TODO: cover more cases
                    switch (p.kind) {
                        case ts.SyntaxKind.SourceFile:
                        case ts.SyntaxKind.ArrowFunction:
                        case ts.SyntaxKind.FunctionExpression:
                        case ts.SyntaxKind.FunctionDeclaration:
                            return p
                    }

                    p = p.parent
                }

                failOnNode('No container declaration found', n)
            }

            const currentScope = getContainingDeclarationLike(node)
            let targetScope = getContainingDeclarationLike(argSym.declaration)
            while (targetScope) {
                if (targetScope === currentScope) {
                    compilerError(
                        'Target declaration must appear outside of the function scope where "useServer" is called', 
                        annotateNode(currentScope, 'Shared scope'), 
                        annotateNode(argSym.declaration, 'Declared here'), 
                        annotateNode(argNode, 'Referenced here')
                    )
                }
                targetScope = targetScope.parent
            }

            if (ts.isFunctionDeclaration(argSym.declaration)) {
                marked.add(argSym.declaration)

                return
            }

            if (ts.isVariableDeclaration(argSym.declaration)) {
                if (!argSym.declaration.initializer) return

                if (!ts.isVariableStatement(argSym.declaration.parent.parent)) return

                if (ts.isArrowFunction(argSym.declaration.initializer) || ts.isFunctionExpression(argSym.declaration.initializer)) {
                    marked.add(argSym.declaration)
                } else {
                    failOnNode('Not supported with "useServer"', argSym.declaration.initializer)
                }
            }
        }

        visit(node)

        return marked
    }

    return { 
        registerTypes, 
        generateTypes,
        getCallableMemberName, 
        getFileResourceInstantiations, 
        getNodeType, 
        checkForResourceInstantiations, 
        getFileSymbols, 
        printTypes, 
        hasCalledCallables,
        getMarkedNodes,
    }
}

const typesFile = `[#compile]__types__.json`
async function setTypes(types: StoredTypesFilesData) {
    const fs = getProgramFs()
    await fs.writeJson(typesFile, sortRecord(types))
}

async function getTypes(fs: Pick<JsonFs, 'readJson'> = getProgramFs()): Promise<StoredTypesFilesData | undefined> {
    return fs.readJson(typesFile).catch(throwIfNotFileNotFoundError)
}

export async function getTypesFile(fs: Pick<JsonFs, 'readJson'> = getProgramFs()): Promise<TypesFileData | undefined> {
    const types = await getTypes(fs)
    if (!types) {
        return
    }

    return Object.fromEntries(Object.entries(types).map(([k, v]) => [v.outfile, v.exports]))
}
