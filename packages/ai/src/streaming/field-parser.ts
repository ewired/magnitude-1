/**
 * StreamingFieldParser<A> — the public API for streaming JSON field parsing.
 *
 * Combines:
 * - Incremental JSON parsing (json-parser.ts)
 * - Snapshot diffing → FieldEvent production (from codec walkAndDiff)
 * - Schema validation (progressive + final)
 * - Typed partial access via StreamingPartial<A>
 *
 * Never-switching generic: erased when no schema, concrete when schema provided.
 */

import { ParseResult, Schema } from "effect"
import { deriveStreamingSchema } from "./streaming-schema"
import type { JsonValue } from "../prompt/parts"
import type { ValidationIssue } from "../response/events"
import { createIncrementalJsonParser } from "./parser"
import type { FieldEvent, ParsedValue, StreamingPartial } from "./types"

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface StreamingFieldParserErased {
  push(chunk: string): readonly FieldEvent[]
  end(): readonly FieldEvent[]
  readonly partial: StreamingPartial<Record<string, unknown>> | undefined
  readonly decoded: Record<string, unknown> | null
  readonly valid: boolean
  readonly validationIssue: ValidationIssue | null
}

export interface StreamingFieldParserConcrete<A> {
  push(chunk: string): readonly FieldEvent[]
  end(): readonly FieldEvent[]
  readonly partial: StreamingPartial<A>
  readonly decoded: A | null
  readonly valid: boolean
  readonly validationIssue: ValidationIssue | null
}

export type StreamingFieldParser<A = never> = [A] extends [never]
  ? StreamingFieldParserErased
  : StreamingFieldParserConcrete<A>

// ---------------------------------------------------------------------------
// ParsedValue → plain JSON conversion
// ---------------------------------------------------------------------------

function parsedValueToJson(node: ParsedValue): JsonValue {
  switch (node._tag) {
    case "string": return node.value
    case "number": return Number(node.value)
    case "boolean": return node.value
    case "null": return null
    case "array": return node.items.map(parsedValueToJson)
    case "object":
      return Object.fromEntries(
        node.entries.map(([key, value]) => [key, parsedValueToJson(value)]),
      )
  }
}

// ---------------------------------------------------------------------------
// ParsedValue → StreamingPartial conversion
// ---------------------------------------------------------------------------

function parsedValueToStreamingPartial(node: ParsedValue): unknown {
  switch (node._tag) {
    case "string":
      return node.state === "complete"
        ? { isFinal: true, value: node.value }
        : { isFinal: false, value: node.value }
    case "number":
      return node.state === "complete"
        ? { isFinal: true, value: Number(node.value) }
        : { isFinal: false, value: node.value }
    case "boolean":
      return { isFinal: true, value: node.value }
    case "null":
      return { isFinal: true, value: null }
    case "object": {
      const result: Record<string, unknown> = {}
      for (const [key, value] of node.entries) {
        result[key] = parsedValueToStreamingPartial(value)
      }
      return result
    }
    case "array":
      return node.items.map(parsedValueToStreamingPartial)
  }
}

// ---------------------------------------------------------------------------
// Snapshot diffing → FieldEvent production
// ---------------------------------------------------------------------------

interface FieldState {
  seenText: string
  complete: boolean
}

function walkAndDiff(
  node: ParsedValue,
  path: readonly string[],
  snapshot: Map<string, FieldState>,
  events: FieldEvent[],
): void {
  const key = path.join("\0")
  let state = snapshot.get(key)

  if (!state) {
    events.push({ _tag: "field_start", path })
    state = { seenText: "", complete: false }
    snapshot.set(key, state)
  }

  if (node._tag === "object") {
    for (const [childKey, childValue] of node.entries) {
      walkAndDiff(childValue, [...path, childKey], snapshot, events)
    }
  } else if (node._tag === "array") {
    for (let index = 0; index < node.items.length; index += 1) {
      walkAndDiff(node.items[index], [...path, String(index)], snapshot, events)
    }
  } else if (node._tag === "string" || node._tag === "number") {
    if (node.value.length > state.seenText.length) {
      const delta = node.value.slice(state.seenText.length)
      events.push({ _tag: "field_delta", path, delta })
      state.seenText = node.value
    }
  }

  if (node.state === "complete" && !state.complete) {
    events.push({ _tag: "field_end", path, value: parsedValueToJson(node) })
    state.complete = true
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStreamingFieldParser(): StreamingFieldParserErased
export function createStreamingFieldParser<A>(schema: Schema.Schema<A, A, never>): StreamingFieldParserConcrete<A>
export function createStreamingFieldParser(schema?: Schema.Schema.AnyNoContext): StreamingFieldParserErased {
  const jsonParser = createIncrementalJsonParser()
  const snapshot = new Map<string, FieldState>()

  // Schema validation setup
  const schemas = schema
    ? { full: schema, streaming: deriveStreamingSchema(schema) }
    : null

  let _valid = true
  let _validationIssue: ValidationIssue | null = null
  let _decoded: Record<string, unknown> | null = null

  function validatePartial(): void {
    if (!schemas || !_valid) return
    const partial = jsonParser.partial
    if (!partial || partial._tag !== "object") return
    const raw = parsedValueToJson(partial)
    const result = Schema.decodeUnknownEither(schemas.streaming)(raw)
    if (result._tag === "Left") {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left)
      if (issues.length > 0) {
        _valid = false
        _validationIssue = { path: issues[0].path, message: issues[0].message }
      }
    }
  }

  function validateFinal(): void {
    if (!schemas) return
    const partial = jsonParser.partial
    if (!partial) return
    const raw = parsedValueToJson(partial)
    const decode = Schema.decodeUnknownEither(schemas.full)
    const result = decode(raw)
    if (result._tag === "Left") {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left)
      if (issues.length > 0) {
        _valid = false
        _validationIssue = { path: issues[0].path, message: issues[0].message }
      }
    } else {
      _decoded = result.right
    }
  }

  function diffPartial(): FieldEvent[] {
    const events: FieldEvent[] = []
    const partial = jsonParser.partial
    if (partial !== undefined) {
      walkAndDiff(partial, [], snapshot, events)
    }
    return events
  }

  return {
    push(chunk: string): readonly FieldEvent[] {
      jsonParser.push(chunk)
      const events = diffPartial()
      if (schemas && _valid) {
        validatePartial()
      }
      return events
    },

    end(): readonly FieldEvent[] {
      jsonParser.end()
      const events = diffPartial()
      if (schemas && _valid) {
        validateFinal()
      }
      return events
    },

    get partial(): StreamingPartial<Record<string, unknown>> | undefined {
      const p = jsonParser.partial
      if (p === undefined) return undefined
      return parsedValueToStreamingPartial(p) as StreamingPartial<Record<string, unknown>>
    },

    get decoded(): Record<string, unknown> | null {
      return _decoded
    },

    get valid(): boolean {
      return _valid
    },

    get validationIssue(): ValidationIssue | null {
      return _validationIssue
    },
  }
}
