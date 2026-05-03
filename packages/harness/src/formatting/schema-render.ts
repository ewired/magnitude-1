/**
 * Schema Renderer
 *
 * Renders Effect Schema AST as TypeScript-like type strings.
 * Adapted from @magnitudedev/tools render-tool-docs for use in parse error formatting.
 */

import { Schema, SchemaAST as AST, Option } from 'effect'

// =============================================================================
// AST Helpers
// =============================================================================

/** Unwrap AST to get the structural type (strip Transformation/Refinement) */
function unwrapAst(ast: AST.AST): AST.AST {
  if (ast._tag === 'Transformation') return unwrapAst(ast.from)
  if (ast._tag === 'Refinement') return unwrapAst(ast.from)
  return ast
}

/** Unwrap to find TypeLiteral */
function unwrapToTypeLiteral(ast: AST.AST): AST.TypeLiteral | null {
  if (ast._tag === 'TypeLiteral') return ast
  if (ast._tag === 'Transformation') {
    const from = unwrapToTypeLiteral(ast.from)
    if (from) return from
    return unwrapToTypeLiteral(ast.to)
  }
  if (ast._tag === 'Refinement') return unwrapToTypeLiteral(ast.from)
  return null
}

/** Check for identifier annotation */
function getIdentifier(ast: AST.AST): string | undefined {
  const id = AST.getIdentifierAnnotation(ast)
  return Option.isSome(id) ? id.value : undefined
}

/** Walk AST to find description annotation */
function walkForDescription(a: AST.AST, depth = 0): string | undefined {
  if (depth > 5) return undefined
  const d = AST.getDescriptionAnnotation(a)
  if (Option.isSome(d)) return d.value
  if (a._tag === 'Transformation') {
    const from = walkForDescription(a.from, depth + 1)
    if (from) return from
    return walkForDescription(a.to, depth + 1)
  }
  if (a._tag === 'Union') {
    for (const t of a.types) {
      const r = walkForDescription(t, depth + 1)
      if (r) return r
    }
  }
  if (a._tag === 'Refinement') return walkForDescription(a.from, depth + 1)
  return undefined
}

/** Check if a description is auto-generated noise from Effect Schema */
function isNoiseDescription(desc: string | undefined): boolean {
  if (!desc) return true
  return /^a (string|number|boolean|unknown|void|never|object|array)/.test(desc)
}

/** Get default value from annotation */
function getDefaultValue(node: AST.Annotated): unknown {
  const annotation = AST.getDefaultAnnotation(node)
  if (Option.isSome(annotation)) {
    const thunk = annotation.value as () => unknown
    return thunk()
  }
  return undefined
}

/** Extract defaults from TypeLiteralTransformation (used by Schema.optionalWith) */
function extractDefaultsFromTransformation(ast: AST.AST): Map<string, unknown> {
  const defaults = new Map<string, unknown>()
  if (ast._tag !== 'Transformation') return defaults
  if (ast.transformation._tag !== 'TypeLiteralTransformation') return defaults

  for (const pst of ast.transformation.propertySignatureTransformations) {
    const propName = String(pst.from)
    try {
      const result = pst.decode(Option.none())
      if (Option.isSome(result)) {
        defaults.set(propName, result.value)
      }
    } catch {
      // decode failed, skip
    }
  }
  return defaults
}

// =============================================================================
// Type String Conversion
// =============================================================================

/**
 * Convert Effect Schema AST to a TypeScript-like type string.
 * depth controls formatting: depth=0 means top-level (multi-line), depth>0 means inline.
 */
function typeToString(ast: AST.AST, isOptional: boolean = false, depth: number = 0): string {
  const unwrapped = unwrapAst(ast)

  const identifier = getIdentifier(ast) || getIdentifier(unwrapped)
  if (identifier) {
    const nameMap: Record<string, string> = {
      'ToolImage': 'image',
    }
    return nameMap[identifier] ?? identifier
  }

  switch (unwrapped._tag) {
    case 'StringKeyword':
      return 'string'
    case 'NumberKeyword':
      return 'number'
    case 'BooleanKeyword':
      return 'boolean'
    case 'VoidKeyword':
      return 'void'
    case 'NeverKeyword':
      return 'never'
    case 'UnknownKeyword':
      return 'unknown'
    case 'AnyKeyword':
      return 'any'
    case 'UndefinedKeyword':
      return 'undefined'

    case 'Literal':
      return JSON.stringify(unwrapped.literal)

    case 'Union': {
      const nonUndefined = unwrapped.types.filter(t => unwrapAst(t)._tag !== 'UndefinedKeyword')
      if (nonUndefined.length === 1 && isOptional) {
        return typeToString(nonUndefined[0], false, depth)
      }
      const allStringLit = nonUndefined.every(t => {
        const u = unwrapAst(t)
        return u._tag === 'Literal' && typeof u.literal === 'string'
      })
      if (allStringLit) {
        return nonUndefined.map(t => JSON.stringify((unwrapAst(t) as AST.Literal).literal)).join(' | ')
      }
      return nonUndefined.map(t => typeToString(t, false, depth)).join(' | ')
    }

    case 'TypeLiteral': {
      if (depth > 0) {
        const props = unwrapped.propertySignatures.map(p => {
          const opt = p.isOptional ? '?' : ''
          return `${String(p.name)}${opt}: ${typeToString(p.type, p.isOptional, depth + 1)}`
        })
        return `{ ${props.join(', ')} }`
      }
      const props = unwrapped.propertySignatures.map(p => {
        const opt = p.isOptional ? '?' : ''
        return `  ${String(p.name)}${opt}: ${typeToString(p.type, p.isOptional, 1)}`
      })
      return `{\n${props.join(',\n')}\n}`
    }

    case 'TupleType': {
      if (unwrapped.elements.length === 0 && unwrapped.rest.length > 0) {
        return `${typeToString(unwrapped.rest[0].type, false, depth)}[]`
      }
      const elements = unwrapped.elements.map(e => typeToString(e.type, false, depth))
      const rest = unwrapped.rest.length > 0
        ? [`...${typeToString(unwrapped.rest[0].type, false, depth)}[]`]
        : []
      return `[${[...elements, ...rest].join(', ')}]`
    }

    case 'Declaration': {
      const id = getIdentifier(unwrapped)
      if (id === 'Array' || id === 'ReadonlyArray') {
        if (unwrapped.typeParameters.length > 0) {
          return `${typeToString(unwrapped.typeParameters[0], false, depth)}[]`
        }
        return 'unknown[]'
      }
      if (id === 'Record' || id === 'ReadonlyMap') {
        if (unwrapped.typeParameters.length >= 2) {
          return `Record<${typeToString(unwrapped.typeParameters[0], false, depth)}, ${typeToString(unwrapped.typeParameters[1], false, depth)}>`
        }
        return 'Record<string, unknown>'
      }
      if (id) {
        const typeArgs = unwrapped.typeParameters.map(p => typeToString(p, false, depth))
        return typeArgs.length > 0 ? `${id}<${typeArgs.join(', ')}>` : id
      }
      return 'unknown'
    }

    case 'Enums':
      return unwrapped.enums.map(([_, v]) => JSON.stringify(v)).join(' | ')

    case 'Suspend':
      return typeToString(unwrapped.f(), isOptional, depth)

    default:
      return 'unknown'
  }
}

// =============================================================================
// Parameter Rendering
// =============================================================================

interface ParamInfo {
  readonly name: string
  readonly optional: boolean
  readonly type: string
  readonly description: string | undefined
  readonly defaultValue: unknown
}

function extractParams(schema: Schema.Schema.AnyNoContext): ParamInfo[] {
  const transformDefaults = extractDefaultsFromTransformation(schema.ast)

  const inputAst = unwrapToTypeLiteral(schema.ast)
  if (!inputAst) return []

  // For optionalWith, descriptions live on the `from` side
  const fromDescriptions = new Map<string, string>()
  const topAst = schema.ast
  if (topAst._tag === 'Transformation' && topAst.from._tag === 'TypeLiteral') {
    for (const p of topAst.from.propertySignatures) {
      const desc = walkForDescription(p.type)
      if (desc && !isNoiseDescription(desc)) {
        fromDescriptions.set(String(p.name), desc)
      }
    }
  }

  return inputAst.propertySignatures.map(p => {
    const name = String(p.name)
    const optional = p.isOptional
    const type = typeToString(p.type, optional, 1)
    const desc = walkForDescription(p.type)
    const propDesc = !desc ? Option.getOrUndefined(AST.getDescriptionAnnotation(p)) : undefined
    const description = desc || (isNoiseDescription(propDesc) ? undefined : propDesc) || fromDescriptions.get(name)
    const defaultValue = getDefaultValue(p) || transformDefaults.get(name)

    return { name, optional, type, description, defaultValue }
  })
}

/**
 * Render expected parameters from an Effect Schema in a TS-like format.
 *
 * Example output:
 * ```
 * Expected parameters:
 *   id: string
 *   status: "pending" | "completed" | "cancelled"
 *   title?: string  // optional
 * ```
 */
export function renderExpectedParams(inputSchema: Schema.Schema.AnyNoContext): string {
  const params = extractParams(inputSchema)

  if (params.length === 0) {
    return 'Expected parameters: (none)'
  }

  const lines = params.map(p => {
    const opt = p.optional ? '?' : ''
    let line = `  ${p.name}${opt}: ${p.type}`

    const commentParts: string[] = []
    if (p.description) commentParts.push(p.description)
    if (p.defaultValue !== undefined) commentParts.push(`default: ${JSON.stringify(p.defaultValue)}`)

    if (commentParts.length > 0) {
      line += ` // ${commentParts.join(' — ')}`
    }

    return line
  })

  return `Expected parameters:\n${lines.join('\n')}`
}
