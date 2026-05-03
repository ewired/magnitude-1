/**
 * Derives a streaming-safe schema from any Effect Schema.
 *
 * Walks the AST and replaces all scalar leaves (numbers, booleans, literals, enums)
 * with strings. Object fields become optional. This allows incremental validation
 * during streaming without rejecting incomplete scalar values.
 *
 * The original schema is used for final validation at end().
 */

import { Schema, SchemaAST as AST } from "effect"

function deriveAST(ast: AST.AST): AST.AST {
  switch (ast._tag) {
    case "StringKeyword":
      return ast

    case "NumberKeyword":
    case "BooleanKeyword":
      return AST.stringKeyword

    case "Literal": {
      const lit = ast.literal
      if (typeof lit === "string" || typeof lit === "number" || typeof lit === "boolean") {
        return AST.stringKeyword
      }
      return AST.unknownKeyword
    }

    case "Union": {
      // If all members are string/number/boolean literals, collapse to string
      const allScalarLiterals = ast.types.every(
        (t: AST.AST) => t._tag === "Literal" && (typeof t.literal === "string" || typeof t.literal === "number" || typeof t.literal === "boolean"),
      )
      if (allScalarLiterals) {
        return AST.stringKeyword
      }
      // Otherwise recurse into each member
      return AST.Union.make(ast.types.map(deriveAST))
    }

    case "TypeLiteral": {
      // Recurse into property types, make all optional
      const props = ast.propertySignatures.map(
        (ps: AST.PropertySignature) =>
          new AST.PropertySignature(
            ps.name,
            deriveAST(ps.type),
            true, // optional
            ps.isReadonly,
          ),
      )
      const indexSigs = ast.indexSignatures.map(
        (is: AST.IndexSignature) => new AST.IndexSignature(is.parameter, deriveAST(is.type), is.isReadonly),
      )
      return new AST.TypeLiteral(props, indexSigs)
    }

    case "TupleType": {
      // Recurse into element types
      const elements = ast.elements.map(
        (el: AST.OptionalType) => new AST.OptionalType(deriveAST(el.type), true),
      )
      const rest = ast.rest.map(
        (r: AST.Type) => new AST.Type(deriveAST(r.type)),
      )
      return new AST.TupleType(elements, rest, ast.isReadonly)
    }

    case "Transformation":
      return deriveAST(ast.from)

    case "Refinement":
      return deriveAST(ast.from)

    case "Suspend":
      return deriveAST(ast.f())

    default:
      return AST.unknownKeyword
  }
}

export function deriveStreamingSchema(schema: Schema.Schema.AnyNoContext): Schema.Schema.AnyNoContext {
  return Schema.make(deriveAST(schema.ast)) as Schema.Schema.AnyNoContext
}
