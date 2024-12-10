import ts from 'typescript'
import * as path from 'node:path'
import { Fs, SyncFs } from '../system'
import { getWorkingDir } from '../workspaces'
import { SourceMapHost } from '../static-solver/utils'
import { SourceMapV3, mergeSourcemaps } from '../runtime/sourceMaps'
import { AmbientDeclarationFileResult, isRelativeSpecifier, makeRelative, memoize, resolveRelative, strcmp, toAmbientDeclarationFile } from '../utils'


function getLongestCommonPrefix(paths: string[]) {
    if (paths.length === 0) {
        return ''
    }

    const res: string[] = []
    const split = paths.map(p => p.split(path.sep)).sort((a, b) => a.length - b.length)
    outer: for (let i = 0; i < split[0].length; i++) {
        for (let j = 1; j < split.length; j++) {
            if (split[j][i] !== split[j - 1][i]) {
                break outer
            }
        }

        res.push(split[0][i])
    }

    return res.join(path.sep)
}

export type DeclarationFileHost = ReturnType<typeof createDeclarationFileHost>
export function createDeclarationFileHost(fs: Fs & SyncFs, sourcemapHost: SourceMapHost) {
    // Maps filename -> module id e.g. `/foo/qaz/bar.d.ts` -> `foo:bar`
    const ambientDeclFileMap = new Map<string, AmbientDeclarationFileResult>()
    const sourcemaps = new Map<string, string>()
    const declarations = new Map<string, { fileName: string; text: string }>()
    const declarationsInversed = new Map<string, string>()
    const references = new Map<string, Set<string>>()

    function addSourcemap(declarationFile: string, text: string) {
        sourcemaps.set(declarationFile, text)
    }

    function addDeclaration(source: string, fileName: string, text: string) {
        declarations.set(source, { fileName, text })
    }

    function setBinding(fileName: string, moduleId: string) {
        // XXX: windows hack
        if (process.platform === 'win32') {
            fileName = fileName.replaceAll('\\', '/')
        }
        declarationsInversed.set(fileName, moduleId)
    }

    function resolve(spec: string, importer: string) {
        const p = resolveRelative(path.dirname(importer), spec)
        const candidates = [
            `${p}.ts`,
            `${p}.d.ts`,
            resolveRelative(p, 'index.ts'),
            resolveRelative(p, 'index.d.ts')
        ]

        for (const c of candidates) {
            if (ambientDeclFileMap.has(c)) {
                return c
            }

            if (declarationsInversed.has(c)) {
                return c
            }

            if (fs.fileExistsSync(c)) {
                return c
            }
        }

        throw new Error(`Failed to resolve "${spec}" [importer: ${importer}]`)
    }

    function getDeclarationSourceFile(fileName: string) {
        const contents = fs.readFileSync(fileName, 'utf-8')

        return ts.createSourceFile(fileName, contents, ts.ScriptTarget.ES2022)
    }

    const deps = new Map<string, Set<string>>()
    function getRelativeDependencies(fileName: string) {
        if (deps.has(fileName)) {
            return deps.get(fileName)!
        }
        
        const d = new Set<string>()
        deps.set(fileName, d)

        const sf = getDeclarationSourceFile(fileName)
        for (const s of sf.statements) {
            if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) {
                continue
            }

            const spec = (s.moduleSpecifier as ts.StringLiteral | undefined)?.text
            if (!spec || !isRelativeSpecifier(spec)) {
                continue
            }

            const resolved = resolve(spec, fileName)
            if (declarationsInversed.has(resolved)) {
                continue
            }

            d.add(resolved)
        }

        return d
    }

    function addRef(moduleId: string, ref: string) {
        const s = references.get(moduleId) ?? new Set()
        references.set(moduleId, s)

        if (references.has(ref)) {
            return
        }

        s.add(ref)
        const deps = getRelativeDependencies(ref)
        for (const d of deps) {
            addRef(moduleId, d)
        }
    }

    const getOutputPrefix = memoize(() => getLongestCommonPrefix([...declarationsInversed.keys()]))

    function transform(declFile: ts.SourceFile, moduleId: string): AmbientDeclarationFileResult {
        const key = declFile.fileName
        if (ambientDeclFileMap.has(key)) {
            return ambientDeclFileMap.get(key)!
        }

        const result = toAmbientDeclarationFile(moduleId, declFile, sourcemapHost, (spec, importer) => {
            const fileName = resolve(spec, importer)
            if (declarationsInversed.has(fileName)) {
                return declarationsInversed.get(fileName)!
            }

            addRef(moduleId, fileName)

            return spec
        })
       
        ambientDeclFileMap.set(key, result)

        return result
    }

    function getDeclaration(source: string) {
        const decl = declarations.get(source)
        if (!decl) {
            throw new Error(`Missing declaration file for: ${source}`)
        }

        return decl
    }

    function getSourcemap(fileName: string) {
        const text = sourcemaps.get(fileName)
        if (!text) {
            throw new Error(`Missing sourcemap for declaration file: ${fileName}`)
        }

        return text
    }

    function mergeMapping(source: string, sourcemap: SourceMapV3) {
        const decl = getDeclaration(source)
        const text = getSourcemap(decl.fileName)
        const originalMap: SourceMapV3 = JSON.parse(text)

        return mergeSourcemaps(originalMap, sourcemap)
    }

    function finalizeResult(source: string, result: AmbientDeclarationFileResult) {
        const dest = makeRelative(
            getOutputPrefix(),
            path.resolve(getWorkingDir(), getDeclaration(source).fileName)
        )

        const merged = mergeMapping(source, result.sourcemap)
        merged.file = path.basename(dest)
        merged.sources[0] = source

        const mappedRefs = [...references.get(result.id) ?? []].map(r => {
            const f = makeRelative(getOutputPrefix(), r)
            if (f.startsWith('..')) {
                throw new Error(`Cannot reference file outside of the root module directory: ${r}`)
            }
            return [f, makeRelative(getWorkingDir(), r)]
        })

        return {
            name: dest,
            text: result.text,
            sourcemap: JSON.stringify(merged),
            references: Object.fromEntries(mappedRefs),
        }
    }

    async function createAmbientDeclarations() {
        const files: Record<string, { name: string; text: string; sourcemap: string }> = {}
        const sorted = Array.from(ambientDeclFileMap.entries()).sort((a, b) => strcmp(a[1].id, b[1].id))
        for (const [k, v] of sorted) {
            files[v.id] = finalizeResult(k, v)
        }

        return files
    }
    
    function transformModuleBinding(source: string, moduleBinding: string) {
        const decl = getDeclaration(source)
        const sf = ts.createSourceFile(decl.fileName, decl.text, ts.ScriptTarget.ES2022)
        const result = transform(sf, moduleBinding)

        return finalizeResult(source, result)
    }

    return {
        setBinding,
        addSourcemap,
        addDeclaration,
        emitAmbientDeclarations: createAmbientDeclarations,
        transformModuleBinding,
    }
}