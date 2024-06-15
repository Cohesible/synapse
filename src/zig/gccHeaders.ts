
// enum encoding {
//     ASCII,
//     UTF8,
//     BASE64,
//     UCS2,
//     BINARY,
//     HEX,
//     BUFFER,
//     BASE64URL,
//     LATIN1 = BINARY
//   };

import ts from 'typescript'
import * as path from 'path'
import { getLogger } from '..'
import { getFs } from '../execution'
import { Mutable, printNodes, toSnakeCase } from '../utils'
import { runCommand } from '../utils/process'

interface StructField {
    readonly name: string
    readonly type: ZigType
    readonly initializer?: ZigExp
}

interface ZigStructTypeExp {
    readonly kind: 'struct-type-exp'
    readonly variant?: 'packed' | 'extern'
    readonly fields: StructField[]
    readonly declarations: (ZigFnDecl | ZigVariableDecl)[]
}

interface ZigEnumValue {
    readonly name: string
    readonly value?: ZigExp
}

interface ZigEnumTypeExp {
    readonly kind: 'enum-type-exp'
    readonly variant?: 'extern'
    readonly tagType?: ZigType
    readonly values: ZigEnumValue[]
    readonly nonExhaustive?: boolean
}


interface ZigVariableDecl {
    readonly kind: 'variable'
    readonly name: string
    readonly type?: ZigType
    readonly isConst?: boolean
    readonly isPublic?: boolean
    readonly initializer?: ZigExp
}

// Arrays have compile-time known lengths, slices are runtime
// []T is a slice (a fat pointer, which contains a pointer of type [*]T and a length). 

// An error set type and normal type can be combined with the ! binary operator to form an error union type.
// e.g. anyerror!u64, error{InvaidChar}!void

interface ZigSliceType {
    readonly sentinel?: number
    readonly length?: number | string
    readonly isPointer?: string // [*]T
}

interface ZigType {
    readonly name: string
    readonly isConst?: boolean
    readonly isOptional?: boolean

    // TODO: flip the order
    readonly pointerType?: 'c' | 'many' | 'single' // [*c]T | [*]T | *T
    readonly sentinel?: number // For slices, e.g. [:0]u8 is a null-terminated string
    readonly length?: number | string
    readonly isArray?: boolean
    readonly errorType?: ZigType

    readonly params?: { name?: string; type: ZigType }[]
    readonly returnType?: ZigType

    readonly typeParams?: ZigType[]
}

type ZigStatement = 
    | ZigFnDecl
    | ZigVariableDecl
    | ZigExpStmt
    | ZigRetStmt

interface ZigFnDecl {
    readonly kind: 'fn'
    // readonly isMethod?: boolean
    readonly name: string
    readonly isPublic?: boolean
    readonly isVariadic?: boolean
    readonly params: ZigParam[]
    readonly returnType: ZigType
    readonly body?: ZigStatement[]
    readonly extern?: string | boolean
}

interface ZigIdent {
    readonly kind: 'ident'
    readonly name: string
}

interface ZigCallExp {
    readonly kind: 'call-exp'
    readonly exp: ZigExp
    readonly args: ZigExp[]
}

type ZigExp = 
    | ZigIdent
    | ZigCallExp
    | ZigStructTypeExp
    | ZigEnumTypeExp
    | ZigLiteralExp

interface ZigExpStmt {
    readonly kind: 'exp-stmt'
    readonly exp: ZigExp
}

interface ZigRetStmt {
    readonly kind: 'ret-stmt'
    readonly exp?: ZigExp
}

interface ZigLiteralExp {
    readonly kind: 'literal-exp'
    readonly literalType: 'number'
    readonly value: string
}

function printZigStatement(stmt: ZigStatement, printer: Printer) {
    switch (stmt.kind) {
        case 'fn':
        case 'variable':
            return printDecl(stmt, printer)
        case 'exp-stmt':
            printExp(stmt.exp, printer)
            return printer.writeLine(';')
        case 'ret-stmt':
            if (stmt.exp) {
                printer.write('return ')
                printExp(stmt.exp, printer)
                printer.writeLine(';')
            } else {
                printer.writeLine('return;')
            }

            return
    }
}

function printBody(body: ZigStatement[], printer: Printer) {
    if (body.length === 0) {
        printer.writeLine('{}')
        return
    }

    printer.writeLine('{')
    printer.indent()
    for (const s of body) {
        printZigStatement(s, printer)
    }
    printer.unindent()
    printer.writeLine('}')

    return
}

function printDelimitedList<T>(elements: T[], printFn: (el: T, printer: Printer) => void, delimeter: string, printer: Printer) {
    elements.forEach((a, i) => {
        printFn(a, printer)
        if (i < elements.length - 1) {
            printer.write(delimeter)
        }
    })
}

function printFnDecl(decl: ZigFnDecl, printer: Printer) {
    // if (decl.isVariadic) {
    //     params.push('...')
    // }

    if (decl.isPublic) {
        printer.write('pub ')
    }

    if (decl.extern) {
        // printer.write('extern "c" ')
        printer.write(`extern ${typeof decl.extern === 'string' ? `"${decl.extern}" ` : ''}`)
    }

    printer.write(`fn ${decl.name}(`)
    printDelimitedList(decl.params, printZigParam, ', ', printer)
    printer.write(') ')

    printZigType(decl.returnType, printer)

    if (decl.body) {
        printer.write(' ')
        printBody(decl.body, printer)
    } else {
        printer.writeLine(';')
    }
}

function printEnumType(exp: ZigEnumTypeExp, printer: Printer) {
    function printEnumValue(v: ZigEnumValue) {
        printer.write(v.name)
        if (v.value) {
            printer.write(' = ')
            printExp(v.value, printer)
        }

        printer.writeLine(',')
    }

    if (exp.variant) {
        printer.write(`${exp.variant} `)
    }

    printer.write('enum')
    
    if (exp.tagType) {
        printer.write('(')
        printZigType(exp.tagType, printer)
        printer.write(')')
    }

    printer.writeLine(' {')
    printer.indent()
    for (const v of exp.values) {
        printEnumValue(v)
    }
    printer.unindent()
    printer.write('}')
}

function printExp(exp: ZigExp, printer: Printer): void {
    switch (exp.kind) {
        case 'literal-exp':
            return printer.write(exp.value)
        case 'enum-type-exp':
            return printEnumType(exp, printer)
        case 'struct-type-exp':
            return printStructType(exp, printer)
        case 'call-exp':
            printExp(exp.exp, printer)
            printer.write('(')
            printDelimitedList(exp.args, printExp, ', ', printer)
            printer.write(')')
            return
        case 'ident':
            return printer.write(exp.name)
    }

}

function printDecl(decl: ZigVariableDecl | ZigFnDecl, printer: Printer) {
    if (decl.kind === 'variable') {
        return printVarDecl(decl, printer)
    }

    return printFnDecl(decl, printer)
}

function printVarDecl(decl: ZigVariableDecl, printer: Printer) {
    const prefix = `${decl.isPublic ? 'pub ' : ''}${decl.isConst ? 'const ' : 'var '}${decl.name}`
    printer.write(prefix)
    if (decl.type) {
        printer.write(': ')
        printZigType(decl.type, printer)
    }

    if (decl.initializer) {
        printer.write(' = ')
        printExp(decl.initializer, printer)
    }

    printer.writeLine(';')
}


function printStructType(exp: ZigStructTypeExp, printer: Printer) {
    if (exp.variant) {
        printer.write(`${exp.variant} `)
    }

    const fields = exp.fields ?? []
    const decls = exp.declarations ?? []
    if (fields.length + decls.length === 0) {
        return printer.write('struct {}')
    }

    printer.writeLine('struct {')
    printer.indent()

    for (const f of fields) {
        printer.write(`${f.name}: `)
        printZigType(f.type, printer)

        if (f.initializer) {
            printer.write(' = ')
            printExp(f.initializer, printer)
        }

        printer.writeLine(',')
    }

    if (fields.length > 0) {
        printer.writeLine('')
    }

    const externDecls = decls.filter(d => d.kind === 'fn' && d.extern)
    for (const d of externDecls) {
        printDecl(d, printer)
    }

    if (externDecls.length > 0) {
        printer.writeLine('')
    }

    for (const d of decls) {
        if (d.kind !== 'fn' || !d.extern) {
            printDecl(d, printer)
        }
    }

    printer.unindent()
    printer.write('}')
}



interface ZigParam {
    readonly name: string
    readonly type: ZigType
    readonly isComptime?: boolean
}


function escapeIdent(name: string) {
    return `@"${name}"`
}

function printZigType(ty: ZigType, printer: Printer) {
    if (ty.returnType) {
        const rt = ty.returnType
        const params = ty.params!

        function printParam(p: { name?: string; type: ZigType }) {
            if (p.name) {
                printer.write(`${p.name}: `)
            }

            printZigType(p.type, printer)
        }

        printer.write('fn (')
        printDelimitedList(params, printParam, ', ', printer)
        printer.write(') ')
        printZigType(rt, printer)

        return
    }

    if (ty.isOptional) {
        printer.write('?')
    }

    if (ty.pointerType === 'c') {
        printer.write('[*c]')
    } else if (ty.pointerType === 'single') {
        printer.write('*')
    } else if (ty.pointerType === 'many') {
        printer.write('[*]')
    }

    if (ty.isConst) {
        printer.write('const ')
    }

    const sentinel = ty.sentinel ? `:${ty.sentinel}` : ''
    const arr = ty.pointerType === 'many' ? `[*${sentinel}]` : ty.length ? `[${ty.length}${sentinel}]` : ty.isArray ? `[${sentinel}]` : ''
    printer.write(arr)
    printer.write(ty.name)
    if (ty.typeParams) {
        printer.write('(')
        printDelimitedList(ty.typeParams, printZigType, ', ', printer)
        printer.write(')')
    }
}

function printZigParam(param: ZigParam, printer: Printer) {
    printer.write(`${param.isComptime ? 'comptime ' : ''}${param.name}: `)
    printZigType(param.type, printer)
}

function createZigGenerator() {
    const statements: ZigStatement[] = []

    function addStatement(stmt: ZigStatement) {
        statements.push(stmt)
    }

    function render() {
        const printer = createPrinter()
        for (const s of statements) {
            printZigStatement(s, printer)
        }

        return printer.getText()
    }
    
    return { addStatement, render }
}

interface Position {
    offset: number
    col: number
    file?: string
    line?: number
    tokLen: number
    includedFrom?: {
        file: string
    }
}

interface MacroPosition {
    readonly spellingLoc: Position
    readonly expansionLoc: Position
}

interface Range {
    readonly begin: Position
    readonly end: Position
}

interface MacroRange {
    readonly begin: MacroPosition
    readonly end: MacroPosition
}

function isMacroPos(p: Position | MacroPosition): p is MacroPosition {
    return 'spellingLoc' in p && 'expansionLoc' in p
}

function isMacroRange(r: Range | MacroRange): r is MacroRange {
    return isMacroPos(r.begin) && isMacroPos(r.end)
}

interface ClangAstNode {
    readonly id: string
    readonly kind: string
    readonly loc?: Position
    readonly range?: Range | MacroRange
    readonly isImplicit?: boolean
    readonly explicitlyDeleted?: boolean
    readonly name?: string
    readonly mangledName?: string
    readonly inner?: ClangAstNode[]
    readonly previousDecl?: string
    // storageClass
}

interface AstRoot extends ClangAstNode {
    readonly kind: 'TranslationUnitDecl'
}

interface Symbol {
    readonly id: string
    readonly fqn: string
    readonly name: string
    readonly decl: ClangAstNode
    readonly isExtern?: boolean
    readonly attributes: Attribute[]
    readonly members: Record<string, Symbol>
    readonly type?: CxxType
    readonly complete?: boolean

    readonly visibility?: 'public' | 'private' | 'protected'
}

interface LinkageSpecDecl extends ClangAstNode {
    readonly kind: 'LinkageSpecDecl'
    readonly language: string
    readonly hasBraces?: boolean
}

interface NamespaceDecl extends ClangAstNode {
    readonly kind: 'NamespaceDecl'
    readonly name?: string
}

interface CxxPointerType {
    readonly kind: 'pointer'
    readonly inner: CxxType
    readonly typeHint?: 'single' | 'multi'
}

interface CxxRecordType {
    readonly kind: 'record'
    readonly variant?: 'union'
    readonly members: { name: string; type: CxxType }[]
}

export interface CxxFnType {
    readonly kind: 'fn'
    readonly returnType: CxxType
    readonly params: {
        readonly name?: string
        readonly type: CxxType
    }[]
    readonly isVariadic?: boolean
}

interface CxxCallExp {
    readonly kind: 'call-exp'
    readonly exp: CxxExp
    readonly args: CxxExp[]
}

interface CxxCommaExp {
    readonly kind: 'comma-exp'
    readonly args: CxxExp[]
}

interface CxxIdentifier {
    readonly kind: 'ident'
    readonly text: string
}

interface CxxTypeExp {
    readonly kind: 'type-exp'
    readonly type: CxxType
}

interface CxxBinaryExp {
    readonly kind: 'binary-exp'
    readonly left: CxxExp
    readonly right: CxxExp
    readonly operator: string
}

interface CxxParenthesizedExp {
    readonly kind: 'paren-exp'
    readonly expression: CxxExp
}

interface CxxIdentWithTypes {
    readonly kind: 'typed-ident'
    readonly ident: CxxIdentifier
    readonly typeArgs: CxxExp[]
}

interface CxxAccessExp {
    readonly kind: 'access-exp'
    readonly exp: CxxExp
    readonly member: string
    readonly variant?: 'arrow'
}

interface CxxElementAccessExp {
    readonly kind: 'element-access-exp'
    readonly exp: CxxExp
    readonly arg: CxxExp
}

interface CxxNewExp {
    readonly kind: 'new-exp'
    readonly exp: CxxExp
    readonly args: CxxExp[]
}

interface CxxStructInitExp {
    readonly kind: 'struct-init-exp'
    readonly exp?: CxxExp
    readonly args: CxxExp[]
}

interface CxxStructInitExpNamed {
    readonly kind: 'struct-init-exp-named'
    readonly members: Record<string, CxxExp>
}

interface CxxDeleteExp {
    readonly kind: 'delete-exp'
    readonly exp: CxxExp
}

interface CxxLiteralExp {
    readonly kind: 'literal-exp'
    readonly value: string
}

interface CxxTernaryExp {
    readonly kind: 'ternary-exp'
    readonly cond: CxxExp
    readonly whenTrue: CxxExp
    readonly whenFalse: CxxExp
}

// This isn't really any expression, more like a directive
interface CxxCastExp {
    readonly kind: 'cast-exp'
    readonly type: CxxType
    readonly exp: CxxExp
}

interface CxxUnaryExp {
    readonly kind: 'unary-exp'
    readonly operator: string
    readonly exp: CxxExp
    readonly postfix?: boolean
}

export type CxxExp = 
    | CxxIdentifier
    | CxxIdentWithTypes
    | CxxCallExp
    | CxxAccessExp
    | CxxNewExp
    | CxxDeleteExp
    | CxxTypeExp
    | CxxStructInitExp
    | CxxLiteralExp
    | CxxBinaryExp
    | CxxParenthesizedExp
    | CxxStructInitExpNamed
    | CxxElementAccessExp
    | CxxTernaryExp
    | CxxCastExp
    | CxxUnaryExp
    | CxxCommaExp

interface CxxExpStatement {
    readonly kind: 'exp-statement'
    readonly exp: CxxExp
}

interface CxxRetStatement {
    readonly kind: 'ret-statement'
    readonly exp?: CxxExp
}

// Doesn't handle multiple declarators
export interface CxxVarStatement {
    readonly kind: 'var-statement'
    readonly name: string
    readonly type: 'auto' | CxxType
    readonly storage?: ('static' | 'thread_local' | 'extern' | 'register')[]
    readonly initializer?: CxxExp
}

interface CxxForStatement {
    readonly kind: 'for-statement'
    readonly initializer?: CxxExp
    readonly condition?: CxxExp
    readonly incrementor?: CxxExp
    readonly statement: CxxStatement
}

interface CxxWhileStatement {
    readonly kind: 'while-statement'
    readonly expression: CxxExp
    readonly statement: CxxStatement
}

interface CxxBlockStatement {
    readonly kind: 'block-statement'
    readonly statements: CxxStatement[]
}

interface ControlStatement {
    readonly kind: 'control-statement'
    readonly variant: 'break' | 'continue'
}

interface IfStatement {
    readonly kind: 'if-statement'
    readonly expression: CxxExp
    readonly statement: CxxStatement
    readonly else?: CxxStatement
}


export type CxxStatement =
    | CxxTypeDefDecl
    | CxxRecordDecl
    | CxxExpStatement
    | CxxRetStatement
    | CxxVarStatement
    | CxxForStatement
    | CxxBlockStatement
    | ControlStatement
    | CxxWhileStatement
    | IfStatement

function printCxxExp(exp: CxxExp, printer: Printer) {
    switch (exp.kind) {
        case 'ident':
            return printer.write(exp.text)
        case 'new-exp':
            printer.write('new ')
            // falls through
        case 'call-exp':
            printCxxExp(exp.exp, printer)
            printer.write('(')
            printDelimitedList(exp.args, printCxxExp, ', ', printer)
            return printer.write(')')
        case 'typed-ident':
            printCxxExp(exp.ident, printer)
            if (exp.typeArgs) {
                printer.write('<')
                printDelimitedList(exp.typeArgs, printCxxExp, ', ', printer)
                printer.write('>')
            }
            return
        case 'element-access-exp':
            printCxxExp(exp.exp, printer)
            printer.write('[')
            printCxxExp(exp.arg, printer)
            return printer.write(']')
        case 'access-exp':
            printCxxExp(exp.exp, printer)
            if (exp.variant === 'arrow') {
                printer.write('->')
            } else {
                printer.write('.')
            }
            return printer.write(exp.member)
        case 'delete-exp':
            printer.write('delete ')
            return printCxxExp(exp.exp, printer)
        case 'type-exp':
            return printCxxType(printer, exp.type)
        case 'struct-init-exp':
            if (exp.exp) {
                printCxxExp(exp.exp, printer)
            }
            printer.write('{')
            printDelimitedList(exp.args, printCxxExp, ', ', printer)
            return printer.write('}')
        case 'struct-init-exp-named':
            printer.write('{')
            printer.indent()
            for (const [k, v] of Object.entries(exp.members)) {
                printer.write(` .${k} = `)
                printCxxExp(v, printer)
                printer.writeLine(',')
            }
            printer.unindent()
            return printer.write(' }')
        case 'literal-exp':
            return printer.write(exp.value)
        case 'binary-exp':
            printCxxExp(exp.left, printer)
            printer.write(` ${exp.operator} `)
            printCxxExp(exp.right, printer)
            return
        case 'paren-exp':
            printer.write('(')
            printCxxExp(exp.expression, printer)
            return printer.write(')')
        case 'ternary-exp':
            printCxxExp(exp.cond, printer)
            printer.write(' ? ')

            printCxxExp(exp.whenTrue, printer)
            printer.write(' : ')

            return printCxxExp(exp.whenFalse, printer)

        case 'cast-exp':
            printer.write('(')
            printCxxType(printer, exp.type)
            printer.write(')')
            return printCxxExp(exp.exp, printer)

        case 'unary-exp':
            if (!exp.postfix) {
                printer.write(exp.operator)
            }
            printCxxExp(exp.exp, printer)
            if (exp.postfix) {
                printer.write(exp.operator)
            }
            return
        case 'comma-exp':
            printer.write('(')
            printDelimitedList(exp.args, printCxxExp, ', ', printer)
            printer.write(')')
            return
    }
}

function printCxxBlock(body: CxxStatement[], printer: Printer) {
    printer.writeLine('{')
    printer.indent()
    for (const s of body) {
        printCxxStatement(s, printer)
    }
    printer.unindent()
    printer.write('}')
}

function printCxxVarStatement(stmt: CxxVarStatement, printer: Printer) {
    if (stmt.storage) {
        for (const keyword of stmt.storage) {
            // Can only use this keyword on C23 or higher, otherwise it is `_Thread_local`
            if (keyword === 'thread_local') {
                printer.write(`_Thread_local `)
            } else {
                printer.write(`${keyword} `)
            }
        }
    }

    if (stmt.type === 'auto') {
        printer.write('auto')
        printer.write(` ${stmt.name}`)
    } else {
        printCxxType(printer, stmt.type, stmt.name)
    }

    if (stmt.initializer) {
        printer.write(' = ')
        printCxxExp(stmt.initializer, printer)
    }

    return printer.writeLine(';')
}

function printCxxStatement(stmt: CxxStatement, printer: Printer) {
    switch (stmt.kind) {
        case 'exp-statement':
            printCxxExp(stmt.exp, printer)
            return printer.writeLine(';')
        case 'ret-statement':
            if (stmt.exp) {
                printer.write('return ')
                printCxxExp(stmt.exp, printer)
            } else {
                printer.write('return')
            }

            return printer.writeLine(';')
        case 'var-statement':
            return printCxxVarStatement(stmt, printer)
        
        case 'for-statement':
            printer.write('for (')

            const exps = [stmt.initializer, stmt.condition, stmt.incrementor]
            printDelimitedList(exps, exp => exp ? printCxxExp(exp, printer) : undefined, '; ', printer)
            printer.write(') ')
            printCxxStatement(stmt.statement, printer)

            return printer.writeLine()
        case 'while-statement':
            printer.write('while (')
            printCxxExp(stmt.expression, printer)
            printer.write(') ')
        
            return printCxxStatement(stmt.statement, printer)

        case 'block-statement':
            return printCxxBlock(stmt.statements, printer)

        case 'control-statement':
            return printer.writeLine(`${stmt.variant};`)

        case 'if-statement':
            printer.write('if (')
            printCxxExp(stmt.expression, printer)
            printer.write(') ')
            printCxxStatement(stmt.statement, printer)
            if (stmt.else) {
                printer.write(' else ')
                printCxxStatement(stmt.else, printer)
                if (stmt.else.kind !== 'if-statement') {
                    printer.writeLine('')
                }
            } else {
                printer.writeLine('')
            }

            return

        case 'record-decl':
        case 'typedef-decl':
            return printCxxDecl(stmt, printer)
    }
}

interface Scope {
    readonly type: 'namespace' | 'enum' | 'record'
    readonly name: string
}

interface CxxRefType {
    readonly kind: 'ref'
    readonly name: string
    readonly params?: CxxType[]
    readonly qualifiers?: string[]

    readonly scopes?: Scope[] // The scopes in which the ref node was _found_ in
    readonly symbol?: Symbol
}

interface CxxArrayType {
    readonly kind: 'array'
    readonly inner: CxxType
    readonly length?: string
}

// THESE ARE TYPE NODES
export type CxxType = 
    | CxxArrayType
    | CxxRefType
    | CxxPointerType
    | CxxFnType
    | CxxRecordType

interface CxxParam {
    readonly name: string
    readonly type: CxxType
}

export interface CxxFunctionDecl {
    readonly kind: 'fn-decl'
    readonly name: string
    readonly returnType: CxxType
    readonly parameters: CxxParam[]
    readonly isVariadic?: boolean
    readonly body?: CxxStatement[]
}

export interface CxxRecordDecl {
    readonly kind: 'record-decl'
    readonly name: string
    readonly variant?: 'union'
    readonly members: { name: string; type: CxxType }[] // Order matters!
}

export interface CxxTypeDefDecl {
    readonly kind: 'typedef-decl'
    readonly name: string
    readonly type: CxxType
}


function printCxxType(printer: Printer, type: CxxType, name?: string): void {
    switch (type.kind) {
        case 'ref':
            printer.write(type.name)
            if (type.params) {
                printer.write('<')
                printDelimitedList(type.params, (el, p) => printCxxType(p, el), ', ', printer)
                printer.write('>')
            }
            if (name) {
                printer.write(` ${name}`)
            }
            return
        case 'array':
            printCxxType(printer, type.inner)
            if (name) {
                printer.write(` ${name}`)
            } else {
            }

            printer.write(`[${type.length !== undefined ? `${type.length}` : ''}]`)

            return
        case 'pointer':
            if (type.inner.kind === 'fn') {
                return printCxxType(printer, type.inner, `(*${name ?? ''})`)
            }

            printCxxType(printer, type.inner)

            if (name) {
                printer.write(` *${name}`)
            } else {
                printer.write('*')
            }

            return
        case 'fn':
            // if (type.isVariadic) {
            //     params.push('...')
            // }

            function printParams() {
                printer.write('(')
                printDelimitedList((type as CxxFnType).params, (a, p) => printCxxType(p, a.type, a.name), ', ', printer)
                if ((type as CxxFnType).isVariadic) {
                    if ((type as CxxFnType).params.length > 0) {
                        printer.write(', ')
                    }
                    printer.write('...')
                }
                printer.write(')')
            }

            if (type.returnType.kind === 'array') {
                printCxxType(printer, type.returnType.inner, name)
                printParams()
                printer.write(`[${type.returnType.length !== undefined ? `${type.returnType.length}` : ''}]`)
                return
            }

            printCxxType(printer, type.returnType, name)
            printParams()

            return
        
        case 'record': 
            const shouldIndent = type.members.length > 1
            printer.write(type.variant ?? 'struct')
            shouldIndent ? printer.writeLine(' {') : printer.write(' { ')
            shouldIndent && printer.indent()
            for (const m of type.members) {
                printCxxType(printer, m.type, m.name)
                shouldIndent ? printer.writeLine(';') : printer.write('; ')
            }
            shouldIndent && printer.unindent()
            printer.write('}')

            if (name) {
                printer.write(` ${name}`)
            }

            return
    }
}

function printCxxParam(param: CxxParam, printer: Printer) {
    return printCxxType(printer, param.type, param.name)
}

function printCxxFn(decl: CxxFunctionDecl, printer: Printer) {
    printCxxType(printer, decl.returnType, decl.name)

    printer.write('(')
    printDelimitedList(decl.parameters, printCxxParam, ', ', printer)
    if (decl.isVariadic) {
        if (decl.parameters.length > 0) {
            printer.write(', ')
        }
        printer.write('...')
    }
    printer.write(')')

    if (decl.body) {
        printer.write(' ')
        printCxxBlock(decl.body, printer)
    }

    printer.writeLine(';')

    return
}

function printCxxRecord(decl: CxxRecordDecl, printer: Printer) {
    const tagName = decl.variant ?? 'struct'
    printer.writeLine(`${tagName} ${decl.name} {`)
    for (const m of decl.members) {
        printCxxType(printer, m.type, m.name)
        printer.writeLine(';')
    }

    printer.writeLine('};')

    return
}

function printCxxDecl(decl: CxxDecl, printer: Printer) {
    switch (decl.kind) {
        case 'fn-decl':
            return printCxxFn(decl, printer)
        case 'record-decl':
            return printCxxRecord(decl, printer)
        case 'typedef-decl':
            printer.write('typedef ')
            printCxxType(printer, decl.type, decl.name)
            return printer.writeLine(';')
        case 'var-statement':
            return printCxxVarStatement(decl, printer)
    }
}

type Printer = ReturnType<typeof createPrinter>
function createPrinter() {
    const indentAmount = 4
    const ws = ' '.repeat(indentAmount)
    const lines: string[] = []

    let indentLevel = 0
    let currentLine = 0

    function getText() {
        return lines.join('\n')
    }

    function writeLine(text: string = '') {
        write(text)
        currentLine += 1
    }

    function write(text: string) {
        if (lines[currentLine] === undefined) {
            const indent = ws.repeat(indentLevel)
            lines[currentLine] = `${indent}${text}`
        } else {
            lines[currentLine] += text
        }
    }

    function indent() {
        indentLevel += 1
    }

    function unindent() {
        indentLevel -= 1
    }

    return { write, writeLine, getText, indent, unindent }
}

const operands = ['+', '-', '*', '/', '%', '^', '&', '|' , '~', '!', '<', '>', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '=', '==', '++', '--', '<<', '>>', '>>=', '<<=', '!=', '<=', '>=', '<=>', '&&', '||', ',', '->*', '->', '()', '[]']

function getOperatorOperand(decl: { name: string }) {
    for (const op of operands) {
        if (decl.name === `operator${op}`) {
            return op
        }
    }
}

type CxxDecl =
    | CxxFunctionDecl
    | CxxRecordDecl
    | CxxTypeDefDecl
    | CxxVarStatement

export function createCxxGenerator(cOnly?: boolean) {
    type LateBoundDecl =  () => CxxDecl | undefined
    const statements: (CxxDecl | LateBoundDecl)[] = []
    const includes = new Set<string>()

    function addFn(decl: CxxFunctionDecl) {
        statements.push(decl)
    }

    function addDecl(decl: CxxDecl) {
        statements.push(decl)
    }

    function addLateBoundDecl(cb: LateBoundDecl) {
        statements.push(cb)
    }

    function addInclude(name: string) {
        includes.add(name)
    }

    function render() {
        const printer = createPrinter()
        if (includes.size > 0) {
            for (const n of includes) {
                printer.writeLine(`#include ${n}`)
            }
            printer.writeLine()
        }

        if (!cOnly) {
            printer.writeLine('extern "C" {')
            printer.indent()
        }

        for (const s of statements) {
            const decl = typeof s === 'function' ? s() : s
            if (decl) {
                printCxxDecl(decl, printer)
            }
        }

        if (!cOnly) {
            printer.unindent()
            printer.writeLine('}')
        }

        return printer.getText()
    }

    return { addFn, addDecl, addInclude, addLateBoundDecl, render }
}

function toPrimitiveType(ty: string): string | undefined {
    switch(ty) {
        case 'int8_t':
            return 'i8'
        case 'uint8_t':
        case 'unsigned char':
            return 'u8'
        case 'int16_t':
            return 'i16'
        case 'uint16_t':
            return 'u16'

        case 'int32_t':
            return 'i32'
        case 'uint32_t':
            return 'u32'
        case 'int64_t':
            return 'i64'
        case 'uint64_t':
            return 'u64'

        case '__int128':
            return 'i128'
        case 'unsigned __int128':
            return 'u128'    

        case 'char':
            return 'c_char'
        case 'short':
            return 'c_short'
        case 'unsigned short':
            return 'c_ushort'
        case 'int':
            return 'c_int'
        case 'unsigned int':
            return 'c_uint'
        case 'long':
            return 'c_long'
        case 'unsigned long':
            return 'c_ulong'

        case 'long long':
            return 'c_longlong'
        case 'unsigned long long':
            return 'c_ulonglong'
        case 'long double':
            return 'c_longdouble'
        
        case '_Float16':
            return 'f16'
        case 'float':
            return 'f32'
        case 'double':
            return 'f64' // f80
        case '_Float128':
            return 'f128'


        case 'intptr_t':
            return 'isize'
        case 'size_t':
        case 'uintptr_t':
        case '__darwin_size_t':
            return 'usize'

        case 'ssize_t':
            return 'c_long'
    }
}

function getRootType(ty: CxxRefType): CxxRefType {
    if (ty.symbol?.type?.kind === 'ref') {
        return getRootType(ty.symbol.type)
    }

    return ty
}


function _generateTsBindings(symbols: Record<string, Symbol>) {
    const statements: ts.Statement[] = []

    function generateRecord(sym: Symbol) {
        const d = sym.decl as RecordDeclNode
        if (d.tagUsed === 'union') {
            return
        }

        const isSimple = d.definitionData?.isStandardLayout && d.definitionData.isTrivial

        // const externName = toSnakeCase(sym.name)

        const fields: ts.TypeElement[] = []
        // TODO: bases

        const defaultVisibility = d.tagUsed !== 'class' ? 'public' : 'private'

        // Must be done before adding fields
        const decl = (sym.decl as RecordDeclNode)
        if (decl.bases) {
            let i = 0
            for (const b of decl.bases) {
                const t = (b as any).__type
                // if (t) {
                //     zigStruct.fields.push({
                //         name: `__base${i}`,
                //         type: toZigType(t),
                //     })
                //     i += 1
                // }
            }
        }

        for (const [k, v] of Object.entries(sym.members)) {
            if (!v.type) {
                continue
            }

            const visibility = v.visibility ?? defaultVisibility
            if (v.decl.kind === 'FieldDecl') {
                if (visibility !== 'public' && (v.decl as FieldDeclNode).storageClass === 'static') {
                    continue
                }

                const prefix = visibility !== 'public' ? '_' : ''
                fields.push(ts.factory.createPropertySignature(
                    undefined,
                    `${prefix}${k}`,
                    undefined,
                    toTsType(v.type),
                ))
            }

            if (visibility !== 'public') {
                continue
            }

            if (v.decl.kind === 'CXXConstructorDecl') {

            }

            if (v.decl.kind === 'CXXMethodDecl') {

            }
        }

        return fields
    }

    let opaqueSymName: string | undefined
    function createOpaqueType() {
        if (!opaqueSymName) {
            opaqueSymName = '__opaqueType'
            const decl = ts.factory.createVariableDeclaration(opaqueSymName, undefined, ts.factory.createTypeReferenceNode('unique symbol'))
            statements.unshift(ts.factory.createVariableStatement(
                [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)],
                ts.factory.createVariableDeclarationList([decl], ts.NodeFlags.Const)
            ))
        }

        return ts.factory.createTypeLiteralNode([
            ts.factory.createPropertySignature(
                undefined,
                ts.factory.createComputedPropertyName(ts.factory.createIdentifier(opaqueSymName)),
                ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                ts.factory.createTypeReferenceNode('unknown')
            )
        ])
    }

    const renderedPrimitives = new Set<string>()
    function renderPrimitiveTypeDecl(name: string) {
        if (renderedPrimitives.has(name)) {
            return
        }
        renderedPrimitives.add(name)
        if (name === 'Ptr') {
            statements.unshift(ts.factory.createTypeAliasDeclaration(
                undefined,
                name,
                [ts.factory.createTypeParameterDeclaration(undefined, 'T')],
                ts.factory.createIntersectionTypeNode([
                    ts.factory.createTypeReferenceNode('T'),
                    ts.factory.createTypeLiteralNode([
                        ts.factory.createPropertySignature(
                            undefined,
                            '__ptr',
                            ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                            ts.factory.createTypeReferenceNode('unknown'),
                        )
                    ])
                ])
            ))

            return
        }

        statements.unshift(ts.factory.createTypeAliasDeclaration(
            undefined,
            name,
            undefined,
            ts.factory.createIntersectionTypeNode([
                ts.factory.createTypeReferenceNode('number'),
                ts.factory.createTypeLiteralNode([
                    ts.factory.createPropertySignature(
                        undefined,
                        '__width',
                        ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                        ts.factory.createTypeReferenceNode('unknown'),
                    )
                ])
            ])
        ))
    }

    const renderedUnknowns = new Set<string>()
    function renderUnknownType(name: string) {
        if (renderedUnknowns.has(name)) {
            return
        }
        renderedUnknowns.add(name)

        statements.unshift(ts.factory.createTypeAliasDeclaration(
            undefined,
            name,
            undefined,
            createOpaqueType()
        ))
    }

    function toTsType(ty: CxxType, hint?: 'pointer-single'): ts.TypeNode {
        if (ty.kind === 'ref') {
            const root = getRootType(ty)
            const pt = toPrimitiveType(root.name)
            let name = pt ?? (root.symbol?.fqn ?? root.name)
            if (name.startsWith('struct ')) {
                name = name.slice('struct '.length)
            }

            if (symbols[name]) {
                renderSymbol(symbols[name])
            } else if (pt) {
                renderPrimitiveTypeDecl(pt)
            } else if (name !== 'void') {
                renderUnknownType(name)
            }

            return ts.factory.createTypeReferenceNode(name, root.params?.map(t => toTsType(t)))
        } else  if (ty.kind === 'pointer') {
            if (ty.inner.kind === 'ref' && ty.inner.name === 'void') {
                return ts.factory.createTypeReferenceNode('any')
            }
            if (ty.inner.kind === 'ref' && (ty.inner.name === 'const char' || ty.inner.name === 'char')) {
                return ts.factory.createTypeReferenceNode('string')
            }
            renderPrimitiveTypeDecl('Ptr')

            return ts.factory.createTypeReferenceNode('Ptr', [toTsType(ty.inner)])
        } else if (ty.kind === 'array') {
            // TODO: handle `sizeof...(T)` for array length
            return ts.factory.createArrayTypeNode(toTsType(ty.inner))
        } else if (ty.kind === 'fn') {
            return ts.factory.createFunctionTypeNode(
                undefined,
                ty.params.map((x, i) => ts.factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    x.name ?? `arg_${i}`,
                    undefined,
                    toTsType(x.type),
                    undefined,
                )),
                toTsType(ty.returnType)
            )
        } else if (ty.kind === 'record') {
            if (ty.variant === 'union') {
                return ts.factory.createUnionTypeNode(
                    ty.members.map(m => toTsType(m.type))
                )
            }

            return ts.factory.createTypeLiteralNode(
                ty.members.map(m => ts.factory.createPropertySignature(
                    undefined,
                    m.name,
                    undefined,
                    toTsType(m.type)
                ))
            )
        }

        throw new Error(`Unknown type: ${(ty as any).kind}`)
    }

    function numericLiteral(val: string | number) {
        if ((typeof val === 'number' && val < 0) || (typeof val === 'string' && val.startsWith('-'))) {
            return ts.factory.createPrefixUnaryExpression(
                ts.SyntaxKind.MinusToken,
                ts.factory.createNumericLiteral(typeof val === 'number' ? -val : val.slice(1))
            )
        }
        return ts.factory.createNumericLiteral(val)
    }

    const rendered = new Set<Symbol>()
    function renderSymbol(sym: Symbol) {
        if (rendered.has(sym)) {
            return
        }

        rendered.add(sym)

        if (sym.decl.kind === 'ClassTemplateDecl' && sym.decl.inner) {

        } else if (sym.decl.kind === 'EnumDecl') {
            const ut = (sym.decl as & { fixedUnderylingType?: Type }).fixedUnderylingType
            const tagType = ut ? toPrimitiveType(ut.desugaredQualType ?? ut.qualType) : 'c_int'
            if (tagType === undefined) {
                throw new Error(`Unknown enum tag type: ${ut!.desugaredQualType ?? ut!.qualType}`)
            }

            const members: ts.EnumMember[] = []

            for (const [k, v] of Object.entries(sym.members)) {
                members.push(ts.factory.createEnumMember(
                    k.toLowerCase(),
                    v.decl.inner ? numericLiteral(parseEnumInitializer(v.decl)) : undefined,
                ))
            }

            const decl = ts.factory.createEnumDeclaration(
                [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
                sym.name,
                members,
            )

            statements.push(decl)
        } else if (sym.decl.kind === 'FunctionDecl') {
            const ty = sym.type as CxxFnType
            if (!ty) {
                return
            }

            const lp = ty.params[ty.params.length - 1]?.type 
            const isVariadic = lp?.kind === 'ref' && lp.name === '...'

            const decl = ts.factory.createFunctionDeclaration(
                [
                    ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
                    ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)
                ],
                undefined,
                sym.name,
                undefined,
                ty.params.map((p, i) => ts.factory.createParameterDeclaration(
                    undefined,
                    isVariadic && i === ty.params.length - 1 ? ts.factory.createToken(ts.SyntaxKind.DotDotDotToken) : undefined,
                    p.name ?? `arg_${i}`,
                    undefined,
                    isVariadic && i === ty.params.length - 1 
                        ? ts.factory.createArrayTypeNode(ts.factory.createTypeReferenceNode('any')) 
                        : toTsType(p.type),
                    undefined,
                )),
                toTsType(ty.returnType),
                undefined,
            )

            ts.addSyntheticLeadingComment(decl, ts.SyntaxKind.SingleLineCommentTrivia, ' C', true)

            statements.push(decl)
        } else if (sym.decl.kind === 'CXXRecordDecl' || sym.decl.kind === 'RecordDecl') {
            if (!sym.complete) {
                return
            }

            const v = generateRecord(sym)
            if (!v) {
                return
            }
            statements.push(ts.factory.createInterfaceDeclaration(
                undefined,
                sym.name,
                undefined,
                undefined,
                v,
            ))
        } else if (sym.decl.kind === 'TypedefDecl' && sym.type && sym.type.kind === 'pointer') {
            statements.push(ts.factory.createTypeAliasDeclaration(
                undefined,
                sym.name.replace(/^struct /, ''),
                undefined,
                toTsType(sym.type),
            ))
        } else if (sym.decl.kind === 'TypedefDecl' && sym.type && sym.type.kind === 'ref') {
            if (sym.name === sym.type.name) {

                // Opaque type?
                statements.push(ts.factory.createTypeAliasDeclaration(
                    undefined,
                    sym.name.replace(/^struct /, ''),
                    undefined,
                    createOpaqueType()
                ))
            } else {
                statements.push(ts.factory.createTypeAliasDeclaration(
                    undefined,
                    sym.name.replace(/^struct /, ''),
                    undefined,
                    toTsType(sym.type),
                ))
            }
        } else if (sym.decl.kind === 'TypedefDecl' && sym.type?.kind === 'record') {

        }
    }

    for (const sym of Object.values(symbols)) {
        if (!sym.isExtern) continue

        renderSymbol(sym)
    }

    return printNodes(statements)
}

function parseEnumInitializer(n: ClangAstNode): number | string {
    const exp = n.inner?.[0]
    if (!exp) {
        throw new Error(`No exp to parse`)
    }

    if (exp.kind === 'ImplicitCastExpr') {
        return parseEnumInitializer(exp)
    }

    if (exp.kind === 'ConstantExpr') {
        if (exp.inner) {

        }

        const ty = (exp as any).type.qualType
        if (ty === 'int' || ty === 'uint8_t' || ty === 'uint32_t' || ty === 'uint64_t' || ty === 'unsigned int') {
            return (exp as any).value
        }
    }

    if (exp.kind === 'IntegerLiteral') {
        return (exp as any).value
    }

    throw new Error(`Unknown node kind: ${exp.kind} -> ${JSON.stringify(exp)}`)
} 

function generateBindings(symbols: Record<string, Symbol>) {
    // We generate a header + `.cpp` file to create the bindings on the C++ side
    // Then we generate a zig file to call the exported symbols
    // 
    // The C++ side needs generated code for non-externed functions and any "non-trivial" records
    // For Zig, we need to generate any structs referenced by the exported symbols

    const cxxGen = createCxxGenerator()
    const zigGen = createZigGenerator()

    const symbolTable: Record<string, Symbol> = {}
    for (const s of Object.values(symbols)) {
        symbolTable[s.fqn] = s
    }

    const root: { declarations: (ZigFnDecl | ZigVariableDecl)[] } = { declarations: [] }
    const containers: Record<string, { declarations: (ZigFnDecl | ZigVariableDecl)[] }> = {}

    function findContainer(parent: { declarations: (ZigFnDecl | ZigVariableDecl)[] }, name: string) {
        const decl = parent.declarations.find(x => x.name === name && x.kind === 'variable' && x.initializer?.kind === 'struct-type-exp')
        if (!decl) {
            return
        }

        return (decl as ZigVariableDecl).initializer! as ZigStructTypeExp
    }

    function getContainer(qualifier: string) {
        if (containers[qualifier]) {
            return containers[qualifier]
        }

        let current: { declarations: (ZigFnDecl | ZigVariableDecl)[] } = root
        const parts = qualifier.split('::')

        const fqn: string[] = []
        while (parts.length > 0) {
            const k = parts.shift()!
            fqn.push(k)

            const s = findContainer(current, k)
            if (s) {
                current = s
                continue
            }
    
            const ns: ZigStructTypeExp = { kind: 'struct-type-exp', variant: 'extern', fields: [], declarations: [] }
            current.declarations.push({
                kind: 'variable',
                name: k,
                isConst: true,
                isPublic: true,
                initializer: ns,
            })

            current = ns
            containers[fqn.join('::')] = ns
        }

        return current
    }

    function getParentContainer(fqn: string) {
        const p = fqn.split('::').slice(0, -1).join('::')

        return getContainer(p)
    }

    function toZigType(ty: CxxType, hint?: 'pointer-single'): ZigType {
        let isPointer = false
        let isArray = false
        let arrayLength: string | undefined
        let name: string | undefined
        let typeParams: ZigType[] | undefined
        while (true) {
            if (ty.kind === 'ref') {
                if ((ty as any)._useZigThis) {
                    name = '@This()'
                    hint = 'pointer-single'
                    break
                }

                const root = getRootType(ty)
                name = root.name

                if (isPointer && name === 'void') {
                    name = 'anyopaque'
                } else {
                    name = toPrimitiveType(name)
                    if (!name) {
                        name = root.symbol?.fqn ?? root.name
                    }
                }

                typeParams = root.params?.map(t => toZigType(t))

                break
            }
            if (ty.kind === 'pointer') {
                isPointer = true
                hint ??= ty.typeHint === 'single' ? 'pointer-single' : undefined
                ty = ty.inner
            } else if (ty.kind === 'array') {
                if (isArray) {
                    throw new Error(`converting multi-dimensional array type not implemented: ${JSON.stringify(ty).slice(0, 256)}`)
                }

                // TODO: handle `sizeof...(T)` for array length

                isArray = true
                arrayLength = ty.length
                ty = ty.inner
            } else if (ty.kind === 'fn') {
                return {
                    name: '',
                    params: ty.params.map(x => ({
                        name: x.name,
                        type: toZigType(x.type),
                    })),
                    returnType: toZigType(ty.returnType),
                }
            }
        }

        return {
            name: name.split('::').join('.'),
            typeParams,
            pointerType: isPointer ? hint === 'pointer-single' ? 'single' : 'c' : undefined,
            isArray,
            length: arrayLength,
        }
    }

    function toZigFn(decl: CxxFunctionDecl, hint?: 'method' | 'ctor'): ZigFnDecl {
        return {
            kind: 'fn',
            name: decl.name,
            params: decl.parameters.map((p, i) => ({
                name: p.name,
                type: toZigType(p.type, hint === 'method' && i === 0 ? 'pointer-single' : undefined),
            })),
            returnType: toZigType(decl.returnType, hint === 'ctor' ? 'pointer-single' : undefined),
        }
    }

    // We want to unwrap any smart pointers from the interface
    function convertTypes(decl: CxxFunctionDecl): CxxFunctionDecl {
        function convertUniquePtr(ty: CxxRefType): CxxPointerType {
            return {
                kind: 'pointer',
                inner: ty.params![0],
                typeHint: 'single',
            }
        }

        function expandRef(ty: CxxType): CxxType {
            if (ty.kind === 'pointer' || ty.kind === 'array') {
                return {
                    ...ty,
                    inner: expandRef(ty.inner),
                }
            }

            if (ty.kind === 'fn') {
                return {
                    ...ty,
                    returnType: expandRef(ty.returnType),
                    params: ty.params.map(p => ({ name: p.name, type: expandRef(p.type) })),
                }
            }

            if (ty.kind === 'record') {
                return {
                    ...ty,
                    members: ty.members.map(x => ({ ...x, type: expandRef(x.type) }))
                }
            }

            return {
                ...ty,
                name: ty.symbol?.fqn ?? ty.name,
                params: ty.params?.map(expandRef),
            }
        }


        // std::shared_ptr
        // std::vector
        // std::string
        // std::function
        // std::pair
        // std::initializer_list

        let returnType = expandRef(decl.returnType)
        const body = [...decl.body ?? []]
        const parameters = [...decl.parameters].map(p => ({ name: p.name, type: expandRef(p.type) }))

        const transforms: ((exp: CxxExp) => CxxExp)[] = []

        for (let i = 0; i < parameters.length; i++) {
            const d = parameters[i].type
            if (d.kind === 'ref' && d.name === 'std::unique_ptr') {
                const name = parameters[i].name
                const type = convertUniquePtr(d)
                parameters[i] = { name, type }

                transforms[i] = exp => {
                    return  {
                        kind: 'struct-init-exp',
                        args: [exp],
                        exp: {
                            kind: 'typed-ident',
                            ident: { kind: 'ident', text: 'std::unique_ptr' },
                            typeArgs: [{ kind: 'type-exp', type: type.inner }],
                        },
                    }
                }
            }
        }

        function transformCallLikeExp(exp: CxxExp): CxxExp {
            if (exp.kind !== 'call-exp' && exp.kind !== 'new-exp') {
                return exp
            }

            return {
                ...exp,
                args: exp.args.map((a, i) => {
                    const fn = transforms[i]
                    
                    return fn?.(a) ?? a
                })
            }
        }

        if (returnType.kind === 'ref' && returnType.name === 'std::unique_ptr') {
            returnType = convertUniquePtr(returnType)
            for (let i = 0; i < body.length; i++) {
                const s = body[i]
                if (s.kind === 'ret-statement' && s.exp) {
                    body[i] = {
                        kind: 'ret-statement',
                        exp: {
                            kind: 'call-exp',
                            exp: { kind: 'access-exp', exp: transformCallLikeExp(s.exp), member: 'release' },
                            args: [],
                        }
                    }
                    break
                }
            }
        }

        if (returnType.kind === 'ref' && returnType.name === 'std::vector') {
            returnType = convertUniquePtr(returnType)
            for (let i = 0; i < body.length; i++) {
                const s = body[i]
                if (s.kind === 'ret-statement' && s.exp) {
                    body[i] = {
                        kind: 'ret-statement',
                        exp: {
                            kind: 'call-exp',
                            exp: { kind: 'access-exp', exp: transformCallLikeExp(s.exp), member: 'release' },
                            args: [],
                        }
                    }
                    break
                }
            }
        }

        return {
            kind: 'fn-decl',
            name: decl.name,
            returnType,
            parameters,
            body,
            isVariadic: decl.isVariadic,
        }
    }

    function addMethod(name: string, decl: CxxFunctionDecl, container: { declarations: ZigStructTypeExp['declarations'] }, thisType?: CxxType) {
        if (thisType) {
            decl.parameters.unshift({
                name: 'self', // XXX: we use `self` because `this` is not a valid C++ ident outside of a class scope
                type: thisType,
            })
        }

        decl = convertTypes(decl)

        cxxGen.addFn(decl)

        const externDecl: ZigFnDecl = {
            ...toZigFn(decl, thisType ? undefined : name === 'init' ? 'ctor' : 'method'),
            extern: true,
        }

        container.declarations.push(externDecl)

        container.declarations.push({
            kind: 'fn',
            name,
            isPublic: true,
            params: externDecl.params,
            returnType: externDecl.returnType,
            body: [{
                kind: 'ret-stmt',
                exp: {
                    kind: 'call-exp',
                    exp: { kind: 'ident', name: externDecl.name },
                    args: externDecl.params.map(p => ({ kind: 'ident', name: p.name })),
                }
            }],
        })

        // body: [{
        //     kind: 'exp-stmt',
        //     exp: {
        //         kind: 'call-exp',
        //         exp: { kind: 'ident', name: externDeinit.name },
        //         args: externDeinit.params.map(p => ({ kind: 'ident', name: p.name })),
        //     }
        // }],
    }

    // Instantiating classes can be done in two ways:
    // 1. Heap allocation on the C++ side, returning a pointer
    // 2. Allocation on the C side, pass pointer to C++ function which uses placement new
    //
    // For the first option, the C side must always explicitly deallocate, otherwise it's a memory leak
    // For the second option, the C side needs to explicitly call non-trivial destructors before deallocation
    //  * Failing to do this results in undefined behavior

    function _parseEnumInitializer(n: ClangAstNode): ZigExp {
        return {
            kind: 'literal-exp',
            literalType: 'number',
            value: parseEnumInitializer(n) as any,
        }
    } 

    function generateRecord(sym: Symbol, useZigThis?: boolean) {
        const d = sym.decl as RecordDeclNode
        if (d.tagUsed === 'union') {
            return
        }

        const isSimple = d.definitionData?.isStandardLayout && d.definitionData.isTrivial

        // const externName = toSnakeCase(sym.name)

        const zigStruct: ZigStructTypeExp = { kind: 'struct-type-exp', variant: 'extern', fields: [], declarations: [] }

        const defaultVisibility = d.tagUsed !== 'class' ? 'public' : 'private'
        let didAddCtors = false

        // Must be done before adding fields
        const decl = (sym.decl as RecordDeclNode)
        if (decl.bases) {
            let i = 0
            for (const b of decl.bases) {
                const t = (b as any).__type
                if (t) {
                    zigStruct.fields.push({
                        name: `__base${i}`,
                        type: toZigType(t),
                    })
                    i += 1
                }
            }
        }

        for (const [k, v] of Object.entries(sym.members)) {
            if (!v.type) {
                continue
            }

            const visibility = v.visibility ?? defaultVisibility
            if (v.decl.kind === 'FieldDecl') {
                if (visibility !== 'public' && (v.decl as FieldDeclNode).storageClass === 'static') {
                    continue
                }

                const prefix = visibility !== 'public' ? '_' : ''
                zigStruct.fields.push({
                    name: `${prefix}${k}`,
                    type: toZigType(v.type),
                })
            }

            if (visibility !== 'public') {
                continue
            }

            const thisType: CxxType = {
                kind: 'pointer',
                inner: {
                    kind: 'ref',
                    name: sym.fqn,
                    _useZigThis: useZigThis, // XXX
                } as CxxRefType
            }

            if (v.decl.kind === 'CXXConstructorDecl') {
                if (didAddCtors || v.decl.isImplicit) {
                    continue
                   // throw new Error(`Overloads not implemented`)
                }
                const name = `init_${sym.name}`
                const t = v.type as CxxFnType
                const params = t.params
                const ret: CxxRetStatement = {
                    kind: 'ret-statement',
                    exp: {
                        kind: 'new-exp',
                        exp: { kind: 'ident', text: sym.fqn },
                        args: params.map(p => ({ kind: 'ident', text: p.name! })),
                    }
                }
                const body = [ret]
                const initDecl: CxxFunctionDecl = {
                    kind: 'fn-decl',
                    name,
                    body,
                    returnType: thisType,
                    parameters: params as any,
                }

                addMethod('init', initDecl, zigStruct)

                // deinit
                const deinitName = `deinit_${sym.name}`
                const deinitDecl: CxxFunctionDecl = {
                    kind: 'fn-decl',
                    name: deinitName,
                    body: [{ kind: 'exp-statement', exp: { kind: 'delete-exp', exp: { kind: 'ident', text: 'self' } } }],
                    parameters: [],
                    returnType: {
                        kind: 'ref',
                        name: 'void',
                    },
                }

                addMethod('deinit', deinitDecl, zigStruct, thisType)
                didAddCtors = true
            }

            if (v.decl.kind === 'CXXMethodDecl') {
                const isMaybeOperator = k.startsWith('operator')
                const operand = isMaybeOperator ? getOperatorOperand(v.decl as MethodDeclNode) : undefined
                if (operand) {
                    continue
                }

                const t = v.type as CxxFnType
                const name = `${sym.name}_${k}`
                const returnType = t.returnType
                const params = t.params as any[]
                if ((v.decl as MethodDeclNode).storageClass === 'static') {
                    const ret: CxxRetStatement = {
                        kind: 'ret-statement',
                        exp: {
                            kind: 'call-exp',
                            exp: { kind: 'ident', text: `${sym.fqn}::${k}` },
                            args: params.map(p => ({ kind: 'ident', text: p.name })),
                        }
                    }

                    const fnDecl: CxxFunctionDecl = {
                        kind: 'fn-decl',
                        name,
                        body: [ret],
                        returnType,
                        parameters: params,
                    }
        
                    addMethod(k, fnDecl, zigStruct)
                } else {
                    const ret: CxxRetStatement = {
                        kind: 'ret-statement',
                        exp: {
                            kind: 'call-exp',
                            exp: { kind: 'access-exp', exp: { kind: 'ident', text: 'self' }, member: k, variant: 'arrow' },
                            args: params.map(p => ({ kind: 'ident', text: p.name })),
                        }
                    }

                    const fnDecl: CxxFunctionDecl = {
                        kind: 'fn-decl',
                        name,
                        returnType,
                        parameters: params,
                        body: [ret],
                    }
        
                    addMethod(k, fnDecl, zigStruct, thisType)
                }
            }
        }

        return zigStruct
    }

    function generateFn(sym: Symbol, declName = sym.fqn.replace(/::/g, '_')) {
        const isMaybeOperator = sym.name.startsWith('operator')
        const operand = isMaybeOperator ? getOperatorOperand(sym.decl as FunctionDeclNode) : undefined
        if (operand) {
            return
        }

        const t = sym.type as CxxFnType
        const returnType = t.returnType
        const params = t.params as any[]

        const ret: CxxRetStatement = {
            kind: 'ret-statement',
            exp: {
                kind: 'call-exp',
                exp: { kind: 'ident', text: sym.fqn },
                args: params.map(p => ({ kind: 'ident', text: p.name })),
            }
        }

        const fnDecl: CxxFunctionDecl = {
            kind: 'fn-decl',
            name: declName,
            body: [ret],
            returnType,
            parameters: params,
        }

        return fnDecl
    }

    const rendered = new Set<Symbol>()
    function renderSymbol(sym: Symbol) {
        if (rendered.has(sym)) {
            return
        }

        rendered.add(sym)

        if (sym.decl.kind === 'ClassTemplateDecl' && sym.decl.inner) {
            // TemplateTypeParmDecl

            const typetype: ZigType = { name: 'type' }

            const fn: ZigFnDecl = {
                kind: 'fn',
                body: [],
                params: [],
                name: sym.name,
                returnType: typetype,
            }

            for (const c of sym.decl.inner) {
                if (c.kind === 'TemplateTypeParmDecl' && c.name) {
                    fn.params.push({
                        name: c.name,
                        isComptime: true,
                        type: typetype,
                    })
                }
            }

            const v = generateRecord(sym, true)
            if (!v) {
                throw new Error(`failed to generate record for symbol: ${sym.fqn}`)
            }
            fn.body!.push({
                kind: 'ret-stmt',
                exp: v,
            })

            getParentContainer(sym.fqn).declarations.push(fn)
        } else if (sym.decl.kind === 'EnumDecl') {
            const ut = (sym.decl as & { fixedUnderylingType?: Type }).fixedUnderylingType
            const tagType = ut ? toPrimitiveType(ut.desugaredQualType ?? ut.qualType) : 'c_int'
            if (tagType === undefined) {
                throw new Error(`Unknown enum tag type: ${ut!.desugaredQualType ?? ut!.qualType}`)
            }

            const exp: ZigEnumTypeExp = {
                kind: 'enum-type-exp',
                variant: 'extern',
                tagType: { name: tagType },
                values: [],
            }

            for (const [k, v] of Object.entries(sym.members)) {
                exp.values.push({
                    name: k.toLowerCase(),
                    value: v.decl.inner ? _parseEnumInitializer(v.decl) : undefined,
                })
            }

            getParentContainer(sym.fqn).declarations.push({
                kind: 'variable',
                name: sym.name,
                isConst: true,
                initializer: exp,
            })
        } else if (sym.decl.kind === 'FunctionDecl') {
            const fn = generateFn(sym)
            if (fn) {
                addMethod(sym.name, fn, getParentContainer(sym.fqn))
            }
        } else if (sym.decl.kind === 'CXXRecordDecl') {
            if (!sym.complete) {
                return
            }

            const v = generateRecord(sym)
            if (v) {
                getParentContainer(sym.fqn).declarations.push({
                    kind: 'variable',
                    name: sym.name,
                    isConst: true,
                    initializer: v,
                })
            }
        }
    }

    for (const sym of Object.values(symbols)) {
        if (!sym.isExtern) continue

        renderSymbol(sym)
    }

    for (const d of root.declarations) {
        zigGen.addStatement(d)
    }

    return {
        cxxFile: cxxGen.render(),
        zigFile: zigGen.render(),
    }
}

interface Attribute {
    readonly kind: string
    readonly value?: string
}

// static_cast<int&&>(n)
// & Lvalue reference
// && Rvalue reference

// #include <stdarg.h>

function maybeParseTemplate(ty: string): CxxType | undefined {
    const m = ty.match(/^([^<>\s\(\)]+)(?:<(.*)>)(?: (?<pointer>[\*&]+))?(?<qualifiers>[a-z\s]+)?$/)
    if (!m) {
        return
    }

    const ref = {
        ...parseRef(m[1]),
        params: m[2] ? m[2].split(',').map(x => parseTypeStr(x)) : undefined,
    }

    const isPointer = m.groups?.pointer === '*'
    if (isPointer) {
        return {
            kind: 'pointer',
            inner: ref,
        }
    }

    return ref
}

function parseFnType(ty: string): CxxFnType | CxxPointerType {
    const parsed = maybeParseFnType(ty)
    if (!parsed) {
        throw new Error(`Bad type parse: ${ty}`)
    }

    return parsed
}

function splitParams(p: string): string[] {
    let i = 0, j = 0
    let parenCount = 0
    const parts: string[] = []
    for (; i < p.length; i++) {
        if (p[i] === ',') {
            if (parenCount === 0) {
                parts.push(p.slice(j, i))
                j = i + 1
            }
        } else if (p[i] === '(') {
            parenCount += 1
        } else if (p[i] === ')') {
            parenCount -= 1
        }
    }

    if (j < i) {
        parts.push(p.slice(j, i))
    }

    return parts
}

function maybeParseFnType(ty: string): CxxFnType | CxxPointerType | undefined {
    const ret = ty.match(/^(.+?) (?<pointer>[\*&]+)?(?:\((?<pointer2>(?:\*|&)(?: [A-Za-z0-9_-]+)?)\))?\((?<params>.*?)\)(?: (?<qualifiers>[a-z\s]+))?(?: [&]{1,2})?$/) // XXX: NOT ROBUST
    if (!ret || !ret.groups) {
        return
    }

    const p = ret.groups.pointer
    const params = ret.groups.params
    const rt = parseTypeStr(ret[1])

    try {
        const t: CxxFnType = {
            kind: 'fn',
            params: params === 'void' ? [] : splitParams(params).map(x => x.trim()).filter(x => !!x).map(x => ({ type: parseTypeStr(x) })),
            returnType: p ? { // FIXME: need to handle double pointers
                kind: 'pointer',
                inner: rt,
            } : rt,
        }

        // Function pointer
        if (ret.groups.pointer2 === '*') {
            return { kind: 'pointer', inner: t }
        }

        return t
    } catch (e) {
        console.log(ty, 'params', ret.groups.params)
        throw e
    }

}

// XXX: NOT ROBUST
function maybeParseArrayType(ty: string): CxxArrayType | undefined {
    const ret = ty.match(/^(.+?)(?: (?<pointer>[\*&]+))?\[(.*)\]$/) 
    if (!ret || !ret.groups) {
        return
    }

    const p = ret.groups.pointer
    const lhs = parseTypeStr(ret[1])
    const inner: CxxType = p === '*' ? { kind: 'pointer', inner: lhs } : lhs

    return {
        kind: 'array',
        inner: inner,
        length: ret[2] ? ret[2] : undefined,
    }
}
// lol
// The destruction/deallocation syntax is different from what most programmers are used to, so they’ll probably screw it up.


// Things that should be unwrapped:
// std::unique_ptr (use `release`)
// std::shared_ptr (probably have to dyn alloc)
// std::vector -> &x[0]

// the base class object appears first (in left-to-right order in the event of multiple inheritance), and member objects follow.
// C++ classes that contain a virtual function will have a vp somewhere in the record. It's either the
// first field or at the location of the first virtual function.

// declarator:
//  pointeropt direct-declarator
// direct-declarator:
//  identifier
//  ( declarator )
//  direct-declarator [ type-qualifier-listopt assignment-expressionopt ]
//  direct-declarator [ static type-qualifier-listopt assignment-expression ]
//  direct-declarator [ type-qualifier-list static assignment-expression ]
//  direct-declarator [ type-qualifier-listopt * ]
//  direct-declarator ( parameter-type-list )
//  direct-declarator ( identifier-listopt )
// pointer:
// * type-qualifier-listopt
// * type-qualifier-listopt pointer
// type-qualifier-list:
// type-qualifier
// type-qualifier-list type-qualifier
// parameter-type-list:
// parameter-list
// parameter-list , ...
// parameter-list:
// parameter-declaration
// parameter-list , parameter-declaration
// parameter-declaration:
// declaration-specifiers declarator
// declaration-specifiers abstract-declaratoropt

// identifier-list:
// identifier
// identifier-list , identifier

// A declaration is [type] [ident]

// whitespace-separated list of, in any order,
// zero or one storage-class specifiers: typedef, constexpr, auto, register, static, extern, _Thread_local
// zero or more type qualifiers: const, volatile, restrict, _Atomic
// (only when declaring functions), zero or more function specifiers: inline, _Noreturn
// zero or more alignment specifiers: _Alignas 

function parseTypeSpec(ty: string): void {

}

interface EmptyDeclarator {
    readonly kind: 'empty'
}

interface IdentifierDeclarator {
    readonly kind: 'identifier'
    readonly text: string
}

// * declarator
interface PointerDeclarator {
    readonly kind: 'pointer'
    readonly qualifiers?: string[]
    readonly target: Declarator
}

// & declarator
interface ReferenceDeclarator {
    readonly kind: 'reference'
    readonly qualifiers?: string[]
    readonly target: Declarator
}

// declarator []
interface ArrayDeclarator {
    readonly kind: 'array'
    readonly target: Declarator
    readonly qualifiers?: string[]
    readonly length?: '*' | string | number
    readonly isStatic?: boolean
}

// declarator ()
interface FunctionDeclarator {
    readonly kind: 'function'
    readonly target: Declarator
    readonly params: any[]
    readonly qualifiers?: string[]
}


type Declarator = 
    | IdentifierDeclarator
    | ReferenceDeclarator
    | PointerDeclarator
    | ArrayDeclarator
    | FunctionDeclarator

type NoPtrDeclarator = Exclude<Declarator, PointerDeclarator>

function parseDeclarator(ty: string): void {
    interface ParseState {
        readonly tokens: string[]
        readonly refTokens: ('*' | '&')[]
        readonly target?: Declarator
        readonly goalType?: 'function' | 'array'
    }

    const states: ParseState[] = []

    function consumeRefTokens(refTokens: ('*' | '&')[], target: Declarator) {
        while (refTokens.length > 0) {
            const token = refTokens.pop()!
            target = {
                kind: token === '*' ? 'pointer' : 'reference',
                target,
            }
        }

        return target
    }

    function convertDecl(s: ParseState): Declarator {
        if (!s.goalType) {
            return {
                kind: 'identifier',
                text: s.tokens.join(''),
            }
        }

        if (s.goalType === 'function') {
            if (!s.target) {
                throw new Error(`Missing target`)
            }

            return {
                kind: 'function',
                target: s.target,
                params: [],
            }
        }

        if (s.goalType === 'array') {
            if (!s.target) {
                throw new Error(`Missing target`)
            }

            return {
                kind: 'array',
                target: s.target,
                
            }
        }

        throw new Error()
    }

    function finishDeclarator(): Declarator {
        const s = states.pop()!

        return consumeRefTokens(s.refTokens, convertDecl(s))
    }

    for (let i = 0; i < ty.length; i++) {
        if (ty[i] === '*' || ty[i] === '&') {
            const cs = states[states.length - 1]
            cs.refTokens.push(ty[i] as '*' | '&')
        } else if (ty[i] === '(') {
            // Parse fn declarator
            const cs = states[states.length - 1]

            if (cs.refTokens.length === 0) {
                const d = finishDeclarator()
                states.push({
                    tokens: [],
                    refTokens: [],
                    target: d,
                    goalType: 'function',
                })
            } else {
                // Parse inner declarator
                states.push({
                    tokens: [],
                    refTokens: [],
                })
            }
        } else if (ty[i] === ')' || ty[i] === ']') {
            const d = finishDeclarator()
            const cs = states[states.length - 1]
            if (!cs.target) {
                (cs as any).target = d
            }
        } else if (ty[i] === '[') {
            const cs = states[states.length - 1]

            if (cs.refTokens.length === 0) {
                const d = finishDeclarator()
                states.push({
                    tokens: [],
                    refTokens: [],
                    target: d,
                    goalType: 'array',
                })
            } else {
                (cs as any).goalType === 'array'
            }
        }
    }
}

function parseRef(ref: string): CxxRefType {
    const parts = ref.split(' ')

    return {
        kind: 'ref',
        name: parts.pop()!,
        qualifiers: parts,
    }
}

function parseTypeStr(ty: string): CxxType {
    const t2 = maybeParseArrayType(ty)
    if (t2) {
        return t2
    }

    const t1 = maybeParseFnType(ty)
    if (t1) {
        return t1
    }

    const t = maybeParseTemplate(ty)
    if (t) {
        return t
    }

    const r = ty.match(/^(?:struct )?([^&\*]+)(?: (?<constPointer>\*const))?(?: (?<pointer>[\*&]+))?(?: (?<qualifier>[a-z]+))?$/)
    if (!r) {
        if (ty.endsWith('*restrict')) {
            return parseTypeStr(ty.slice(0, -'restrict'.length))
        }
        return { kind: 'ref', name: 'unknown' }
        throw new Error(`Bad parse: ${ty}`)
    }

    const ptrType = r.groups?.pointer
    if (ptrType === '*' || r.groups?.constPointer) {
        return { kind: 'pointer', inner: parseRef(r[1]) }
    } else if (ptrType === '**') {
        return { kind: 'pointer', inner: { kind: 'pointer', inner: parseRef(r[1]) } }
    }

    return parseRef(r[1])
}

// Converts the AST into a symbolic program
function resolveAst(ast: AstRoot, targetFiles: string[]) {
    let currentFile: string | undefined
    let isExtern = false
    let prevNode: ClangAstNode | undefined = undefined

    const scopes: Scope[] = []
    const visibility: ('public' | 'private' | 'protected' | undefined)[] = []
    const symbols: Record<string, Symbol> = {}

    const namespaces: Record<string, Record<string, Symbol>> = {}

    function getNamespace(depth?: number) {
        const fqn = scopes.map(s => s.name).slice(0, depth).join('::')

        return namespaces[fqn] ??= {}
    }

    function getGlobalNamespace() {
        return namespaces[''] ??= {}
    }

    if (!ast.inner) {
        throw new Error(`AST has no children nodes`)
    }

    function visitChildren(n: ClangAstNode) {
        if (n.inner) {
            for (const c of n.inner) {
                visit(c)
            }
        }
    }

    function getSource() {
        if (!currentFile) {
            throw new Error(`No source found`)
        }
        return getFs().readFileSync(currentFile, 'utf-8')
    }

    function parseAttr(n: ClangAstNode) {
        if (!n.range) {
            throw new Error(`Missing range in attr node: ${n}`)
        }

        const start = isMacroRange(n.range) ? n.range.begin.spellingLoc.offset : n.range.begin.offset
        const end = isMacroRange(n.range) ? n.range.end.expansionLoc.offset : n.range.end.offset        
        const text = getSource().slice(start, end)
        const m = text.match(/(.*)(?:\((.*)\))?/)
        if (!m) {
            throw new Error(`Bad attr parse: ${text}`)
        }

        return {
            kind: m[1],
            value: m[2],
        }
    }

    const targets = new Set(targetFiles)
    function isTargetSym() {
        if (!currentFile) {
            return false
        }
        
        return targets.has(currentFile)
    }

    const currentAttrs: Attribute[] = []

    visitChildren(ast)

    function createSymbol(n: ClangAstNode, fqn = [...scopes.map(s => s.name), n.name].join('::')) {
        const id = n.previousDecl ?? n.id
        if (symbols[id]) {
            return symbols[id]
        }

        if (!n.name) {
            throw new Error(`Expected node to have a name: ${JSON.stringify(n)}`)
        }

        const sym: Symbol = {
            id: id,
            fqn,
            name: n.name,
            decl: n,
            isExtern: isTargetSym(),
            attributes: [],
            members: {},
            visibility: visibility[visibility.length - 1],
        }

        symbols[id] = sym

        return sym
    }

    function createGlobalSymbol(n: ClangAstNode) {
        const sym = createSymbol(n)
        getNamespace()[sym.name] = sym

        return sym
    }

    function getSymbol(name: string) {
        return getNamespace()[name]
    }

    function getContainerSymbol(name: string) {
        return getNamespace(-1)[name]
    }

    function addToParent(sym: Symbol) {
        if (scopes.length === 0) {
            return
        }

        const p = getContainerSymbol(scopes[scopes.length - 1].name)
        if (p) {
            p.members[sym.name] = sym
        }
    }

    function addNamespaceToType(ty: CxxType): void {
        if (ty.kind === 'ref') {
            if (ty.scopes !== undefined) {
                return
            }

            ;(ty as Mutable<CxxRefType>).scopes = [...scopes]
        } else if (ty.kind === 'pointer' || ty.kind === 'array') {
            return addNamespaceToType(ty.inner)
        } else if (ty.kind === 'fn') {
            addNamespaceToType(ty.returnType)
            for (const p of ty.params) {
                addNamespaceToType(p.type)
            }
        }
    }

    // Should only be called after parsing everything
    function addSymbolToRef(ref: CxxRefType, scopes = ref.scopes): void {
        if (ref.symbol !== undefined || scopes === undefined) {
            return
        }

        if (ref.params) {
            for (const p of ref.params) {
                if (p.kind === 'ref') {
                    addSymbolToRef(p, scopes)
                }
            }
        }

        // Only check in the global scope
        if (ref.name.startsWith('::')) {
            const sym = namespaces['']?.[ref.name.slice(2)]
            ;(ref as Mutable<CxxRefType>).symbol = sym

            return
        }

        const parts = ref.name.split('::')
        const symName = parts.pop()!

        const scope = scopes.map(x => x.name)
        for (let i = scope.length; i >= 0; i--) {
            const ns = [...scope.slice(0, i), ...parts].join('::')
            const sym = namespaces[ns]?.[symName]
            if (sym) {
                ;(ref as Mutable<CxxRefType>).symbol = sym
                break
            }
        }
    }

    function addSymbols(ty: CxxType): void {
        if (ty.kind === 'ref') {
            addSymbolToRef(ty)
        } else if (ty.kind === 'array' || ty.kind === 'pointer') {
            addSymbols(ty.inner)
        } else if (ty.kind === 'fn') {
            addSymbols(ty.returnType)
            for (const p of ty.params) {
                addSymbols(p.type)
            }
        }
    }

    function visit(n: ClangAstNode) {
        if (!n.loc) {
            return
        }

        if (n.loc.file) {
            currentFile = n.loc.file
        } else if (n.range && isMacroPos(n.range.begin) && n.range.begin.expansionLoc.file) {
            currentFile = n.range.begin.expansionLoc.file
        }

        if (n.kind === 'NamespaceDecl') {
            const d = n as NamespaceDecl
            const name = d.name ?? `__${Object.keys(namespaces).length}` // XXX: MAKE THIS GOOD
            const ns = createGlobalSymbol({ ...d, name })
            addToParent(ns)
            scopes.push({ type: 'namespace', name })
            visitChildren(n)
            scopes.pop()

            return
        }

        if (n.kind === 'EnumDecl') {
            // Enums effectively create a namespace
            const s = n.name ? createGlobalSymbol(n) : createGlobalSymbol({ ...n, name: `__anon_${n.id}` })
            addToParent(s)
            scopes.push({ type: 'enum', name: s.name })
            visitChildren(n)
            scopes.pop()

            return
        }

        if (n.kind === 'FriendDecl') {
            return
        }

        if (n.kind === 'ClassTemplateDecl' && n.name) {
            const record = n.inner?.find(c => c.kind === 'CXXRecordDecl')
            if (!record?.inner || !(record as RecordDeclNode).completeDefinition) {
                return
            }
            
            ;(n as any).bases = (record as any).bases
            ;(n as any).tagUsed = (record as any).tagUsed
            ;(n as any).definitionData = (record as any).definitionData
            const ns = createGlobalSymbol(n)

            addToParent(ns)
            visibility.push(undefined)
            scopes.push({ type: 'record', name: ns.name })
            visitChildren(record)
            scopes.pop()
            visibility.pop()

            ;(ns as Mutable<Symbol>).complete = true

            // TemplateTypeParmDecl
            return
        }

        // FunctionTemplateDecl

        if (n.kind === 'EnumConstantDecl' && n.name) {
            addToParent(createSymbol(n))
            return
        }

        if (n.kind === 'LinkageSpecDecl' && (n as LinkageSpecDecl).language === 'C') {
            isExtern = true
            visitChildren(n)
            isExtern = false

            return
        }

        // [[nodiscard]]
        // [[no_unique_address]] <-- can change record layout
        // [[clang::trivial_abi]]
        // __attribute__((trivial_abi))

        // Attributes affect the next decl we see
        if (n.kind === 'VisibilityAttr') {
            const attr = parseAttr(n)
            currentAttrs.push(attr)
            return
        }

        function _addParamNames(fnType: CxxFnType, p: ClangAstNode) {
            if (!p.inner) {
                return
            }

            let i = 0
            for (const c of p.inner) {
                const t = fnType.params[i]?.type ?? { kind: 'ref', name: 'unknown' }
                if (c.kind === 'ParmVarDecl') {
                    fnType.params[i] = {
                        name: c.name ?? `arg_${i}`,
                        type: t,
                    }
                    i += 1
                }
            }
        }

        function addParamNames(fnType: CxxType, p: ClangAstNode): void {
            if (!p.inner) {
                return
            }

            if (fnType.kind === 'fn') {
                return _addParamNames(fnType, p)
            }

            if (fnType.kind === 'pointer') {
                return addParamNames(fnType.inner, p)
            }

            throw new Error(`Unknown type kind: ${fnType.kind}`)
        }

        if (n.kind === 'CXXMethodDecl' && n.name) {
            if ((n as any).isImplicit || n.explicitlyDeleted) {
                return
            }

            const s = getContainerSymbol(scopes[scopes.length - 1].name)

            if (s && (s.decl.kind === 'CXXRecordDecl' || s.decl.kind === 'ClassTemplateDecl')) {
                const ms = s.members[n.name] = createSymbol(n)
                if ((n as any).type) {
                    const ty = (n as any).type as Type
                    const fnType = parseFnType(ty.desugaredQualType ?? ty.qualType)
                    ;(ms as Mutable<Symbol>).type = fnType

                    addParamNames(fnType, n)
                    addNamespaceToType(fnType)
                }
            }

            return
        }

        if (n.kind === 'CXXConstructorDecl') {
            if ((n as any).isImplicit || n.explicitlyDeleted) {
                return
            }

            const s = getContainerSymbol(scopes[scopes.length - 1].name)
            const symName = '__constructor__'
            if (s && (s.decl.kind === 'CXXRecordDecl' || s.decl.kind === 'ClassTemplateDecl')) {
                const ms = s.members[symName] = createSymbol(n)
                if ((n as any).type) {
                    const ty = (n as any).type as Type
                    const fnType = parseFnType(ty.desugaredQualType ?? ty.qualType)
                    ;(ms as Mutable<Symbol>).type = fnType

                    addParamNames(fnType, n)
                    addNamespaceToType(fnType)
                }
            }

            return
        }

        if (n.kind === 'FieldDecl' && n.name) {
            const d = (n as FieldDeclNode)
            const s = getContainerSymbol(scopes[scopes.length - 1].name)
            if (s && (s.decl.kind === 'CXXRecordDecl' || s.decl.kind === 'ClassTemplateDecl' || s.decl.kind === 'RecordDecl')) {
                const ms = s.members[d.name] = createSymbol(n)
                const x = d.type.qualType.match(/\(unnamed (union|struct) at (.+):([0-9]+):([0-9]+)\)/)
                if (x && prevNode?.kind === 'RecordDecl' && (prevNode as any).completeDefinition) {
                    const r = prevNode as RecordDeclNode
                    const members: { name: string; type: CxxType }[] = []
                    for (const z of r.inner ?? []) {
                        if (z.kind === 'FieldDecl' && z.name) {
                            members.push({
                                name: z.name,
                                type: parseTypeStr((z as FieldDeclNode).type.desugaredQualType ?? (z as FieldDeclNode).type.qualType),
                            })
                        }
                    }

                    ;(ms as Mutable<Symbol>).type = {
                        kind: 'record',
                        variant: r.tagUsed === 'union' ? 'union' : undefined,
                        members,
                    }

                    addNamespaceToType(ms.type!)

                    return
                }

                //const type = parseTypeStr(d.type.desugaredQualType ?? d.type.qualType)
                const type = parseTypeStr(d.type.desugaredQualType ?? d.type.qualType)
                ;(ms as Mutable<Symbol>).type = type

                addNamespaceToType(type)
            }

            return
        }

        function createBuiltinSymbol(r: ClangAstNode) {
            const sym = symbols[r.id]
            if (sym) {
                return sym
            }

            const ty = ((r as any).type as Type).qualType
            const s = createSymbol({ ...r, name: ty }, ty)
            ;(s as Mutable<Symbol>).type = { kind: 'ref', name: ty }
            getGlobalNamespace()[ty] = s

            return s
        }

        function getDeclSym(d: { id: string; name: string }) {
            const sym = symbols[d.id]
            if (sym) {
                return sym
            }
        }

        if (n.kind === 'AccessSpecDecl' && visibility.length > 0) {
            visibility[visibility.length - 1] = (n as any).access

            return
        }

        if (n.kind === 'TypedefDecl') {
            const ty = (n as { type?: Type }).type?.desugaredQualType
            if (ty && n.name) {
                if (n.inner && n.inner[0].kind === 'ElaboratedType') {
                    const r = n.inner[0]
                    if ((r as any).ownedTagDecl) {
                        const target = symbols[(r as any).ownedTagDecl.id]
                        if (target && target.name === `__anon_${target.id}`) {
                            ;(target as any).name = n.name
                            ;(target as any).fqn = [
                                ...(target as any).fqn.split('::').slice(0, -1),
                                n.name,
                            ].join('::')

                            getNamespace()[n.name] = target
                            symbols[n.id] = target

                            return
                        }

                        if (target?.name === n.name) {
                            return
                        }

                        if (target && target.type) {
                            const s = createSymbol(n)
                            getNamespace()[n.name] = s
                            ;(s as Mutable<Symbol>).type = {
                                kind: 'ref',
                                name: target.name,
                                symbol: target,
                            }

                            return
                        }

                        const s = createSymbol(n)
                        getNamespace()[n.name] = s
                        ;(s as Mutable<Symbol>).type = {
                            kind: 'ref',
                            name: (r as any).ownedTagDecl.name,
                        }

                        return
                    }

                    if ((r as any).inner?.[0]?.kind === 'RecordType') {
                        const s = createSymbol(n)
                        getNamespace()[n.name] = s
                        ;(s as Mutable<Symbol>).type = {
                            kind: 'ref',
                            name: ty.replace(/^(struct|union) /, ''),
                        }

                        return
                    }
                }

                const s = createBuiltinSymbol(n)

                getNamespace()[n.name] = s
                symbols[n.id] = s

                return
            }

            if (n.name && n.inner) {
                const r = n.inner[0]
                if (r.kind === 'BuiltinType') {
                    const s = createBuiltinSymbol(r)

                    getNamespace()[n.name] = s
                    symbols[n.id] = s
                } else if (r.kind === 'ElaboratedType') {

                    const r2 = r.inner?.[0]
                    if (r2?.kind === 'TypedefType' || r2?.kind === 'RecordType' || r2?.kind === 'EnumType') {
                        const d = (r2 as any).decl
                        const z = d ? symbols[d.id] : undefined
                        if (z) {
                            const sym = createSymbol(n)
                            ;(sym as Mutable<Symbol>).type = { kind: 'ref', name: d.name, symbol: z }
                            getNamespace()[n.name] = sym
    
                            return
                        }
                        const s = getDeclSym(d)
                        if (s) {
                            getNamespace()[n.name] = s
                        }else {
                            getLogger().log('no symbol found inner', r2)
                        }
                    } else {
                        getLogger().log('unknown typedef inner', r2)
                    }
                } else if (r.kind === 'RecordType') {
                    const d = (r as any).decl
                    const z = d ? symbols[d.id] : undefined
                    if (z) {
                        const sym = createSymbol(n)
                        ;(sym as Mutable<Symbol>).type = { kind: 'ref', name: d.name, symbol: z }
                        getNamespace()[n.name] = sym

                        return
                    }
                    const s = d ? getDeclSym(d) : undefined
                    if (s) {
                        getNamespace()[n.name] = s
                    } else {
                        getLogger().log('no symbol found', r)
                    }
                } else if (r.kind === 'PointerType'  && (r as any).type) {
                    const sym = createSymbol(n)
                    ;(sym as Mutable<Symbol>).type = parseTypeStr((r as any).type.qualType)
                    getNamespace()[n.name] = sym
                } else {
                    if (n.name === 'ssize_t') {
                        getLogger().log('unknown typedef', r)
                    }
                }
            }

            return
        }

        // Note: external structs aren't relevant
        if (n.kind === 'CXXRecordDecl' || n.kind === 'FunctionDecl' || n.kind === 'VarDecl' || n.kind === 'RecordDecl') {
            const name =  n.name ?? `__anon_${n.previousDecl ?? n.id}`
            if (!n.name) {
                // Add an anonymous symbol
                // if (n.kind === 'CXXRecordDecl' || n.kind === 'RecordDecl') {
                //     createGlobalSymbol({ ...n, name: `__anon_${n.previousDecl ?? n.id}` })
                // }
                prevNode = n

                // return
            }

            const s = getSymbol(name)
            if (s) {
                // if (n.kind === 'CXXRecordDecl' && n.isImplicit && !(n as RecordDeclNode).completeDefinition && !n.inner) {
                //     return
                // }

                while (currentAttrs.length > 0) {
                    s.attributes.push(currentAttrs.shift()!)
                }
            }

            if (s?.complete) {
                return
            }

            // Forward decl
            if ((n.kind === 'CXXRecordDecl' || n.kind === 'RecordDecl') && !n.inner) {
                return
            }

            const ns = s ?? createGlobalSymbol(!n.name ? { ...n, name } : n)
            if (n.kind === 'FunctionDecl' && (n as any).type) {
                const ty = (n as any).type as Type
                const fnType = parseFnType(ty.desugaredQualType ?? ty.qualType)
                ;(ns as Mutable<Symbol>).type = fnType

                if (!s) {
                    addToParent(ns)
                }

                addParamNames(fnType, n)
                addNamespaceToType(fnType)

                return
            }

            if (n.kind === 'VarDecl') {
                return
            }

            addToParent(ns)
            visibility.push(undefined)
            scopes.push({ type: 'record', name: ns.name })
            visitChildren(n)
            scopes.pop()
            visibility.pop()

            ;(ns as Mutable<Symbol>).complete = true
        }
    }

    const visited = new Set<Symbol>()
    function visitSym(sym: Symbol) {
        visited.add(sym)

        if (sym.type) {
            addSymbols(sym.type)
        }

        // Super hacky
        if ((sym.decl as RecordDeclNode).bases) {
            for (const b of (sym.decl as RecordDeclNode).bases!) {
                try {
                    const t = Object.assign(
                        parseTypeStr(b.type.desugaredQualType ?? b.type.qualType), 
                        { scopes: sym.fqn.split('::').slice(0, -1).map(x => ({ name: x, type: 'namespace' })) }
                    )
                    addSymbols(t)
                    Object.assign(b, { __type: t })
                } catch {}
            }
        }

        for (const m of Object.values(sym.members)) {
            if (!visited.has(m)) {
                visitSym(m)
            }
        }
    }

    // Re-map symbols to use FQN
    const table: Record<string, Symbol> = {}
    for (const sym of Object.values(symbols)) {
        if (!visited.has(sym)) {
            visitSym(sym)
        }
        table[sym.fqn] = sym
    }

    return table
}


// clang++ -fno-exceptions -c

//   -vfsoverlay <value>     Overlay the virtual filesystem described by file over the real file system. Additionally, pass this overlay file to the linker if it supports it

interface ParseOpt {
    readonly include?: string[]
    readonly mode?: 'c' | 'c++'
}

export async function getAst(file: string, opt?: ParseOpt) {
    const mode = opt?.mode ?? 'c++'
    const args: string[] = []
    for (const dir of opt?.include ?? []) {
        args.push('-I', `${dir}`)
    }

    const executable = mode === 'c' ? 'clang' : 'clang++'
    const res = await runCommand(executable, [...args, '-Xclang', '-ast-dump=json', file])
    const ast: AstRoot = JSON.parse(res)

    return ast
}

export async function generateZigBindings(file: string) {
    const ast = await getAst(file)
    const symbols = resolveAst(ast, [file])
    const bindings = generateBindings(symbols)
    console.log(bindings.cxxFile)
    console.log('--------------')
    console.log(bindings.zigFile)
}

export async function generateTsBindings(file: string) {
    const ast = await getAst(file, { mode: 'c', include: [path.dirname(file)] })
    const symbols = resolveAst(ast, [file])
    const bindings = _generateTsBindings(symbols)
    
    return bindings
}

interface Type {
    readonly qualType: string
    readonly desugaredQualType?: string
    readonly typeAliasDeclId?: string
}

interface FunctionDeclNode extends ClangAstNode {
    readonly kind: 'FunctionDecl'
    readonly name: string
    readonly type: Type
    readonly inline?: boolean // CXX
}

interface MethodDeclNode extends ClangAstNode {
    readonly kind: 'CXXMethodDecl'
    readonly name: string
    readonly type: Type
    readonly inline?: boolean // CXX
    readonly virtual?: boolean
    readonly pure?: boolean
    readonly explicitlyDeleted?: boolean
    readonly storageClass?: 'static'
}

interface FieldDeclNode extends ClangAstNode {
    readonly kind: 'FieldDecl'
    readonly name: string
    readonly type: Type
    readonly storageClass?: 'static'
}




interface RecordBaseClause {
    readonly access: 'public' | 'private' | 'protected'
    readonly type: Type
    readonly writtenAccess: 'none'
}

// explicitlyDefaulted
// CXX
interface RecordDeclNode extends ClangAstNode {
    readonly kind: 'CXXRecordDecl'
    readonly tagUsed: 'struct' | 'union' | 'class'
    readonly bases?: RecordBaseClause[]
    readonly completeDefinition?: boolean
    readonly definitionData?: {
        isPOD?: boolean // deprecated
        isTrivial?: boolean
        isStandardLayout?: boolean
        isAbstract?: boolean
        isPolymorphic?: boolean
        hasUserDeclaredConstructor?: boolean
        defaultCtor: {
            defaultedIsConstexpr?: boolean
            exists?: boolean
            isConstexpr?: boolean
            needsImplicit?: boolean
            trivial?: boolean
        }
        dtor: {
            irrelevant?: boolean
            needsImplicit?: boolean
            simple?: boolean
            trivial?: boolean
            nonTrivial?: boolean
            userDeclared?: boolean
        }
    }
}

