import type { ToolResultPart, ValidationIssue, StreamingPartial } from '@magnitudedev/ai'
import type { Schema } from 'effect'
import { renderExpectedParams } from './schema-render'
import { renderToolOutput } from './helpers'
import { ContentBuilder } from '../content'

/**
 * Unwrap StreamingPartial wrappers ({ isFinal, value }) recursively to plain values.
 */
function unwrapStreamingPartial(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(unwrapStreamingPartial)
  const record = obj as Record<string, unknown>
  if ('isFinal' in record && 'value' in record && Object.keys(record).length === 2) {
    return record.value
  }
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    result[k] = unwrapStreamingPartial(v)
  }
  return result
}

/**
 * Format a tool input decode failure into a <parse_error> block.
 */
export function formatDecodeFailure<TInput>(
  toolName: string,
  issue: ValidationIssue,
  inputSchema: Schema.Schema<TInput, TInput, never>,
  receivedInput: StreamingPartial<TInput>,
): readonly ToolResultPart[] {
  let schemaDescription: string
  try {
    schemaDescription = renderExpectedParams(inputSchema)
  } catch {
    schemaDescription = 'Expected parameters: (schema unavailable)'
  }

  const headerSections: string[] = [
    `<parse_error>`,
    `Invalid input for tool "${toolName}"`,
    ``,
  ]

  if (issue.path.length > 0) {
    headerSections.push(`Parameter: ${issue.path.join('.')}`)
  }
  headerSections.push(`Problem: ${issue.message}`)
  headerSections.push(``)
  headerSections.push(schemaDescription)
  headerSections.push(``)
  headerSections.push(`Received:`)

  const builder = new ContentBuilder()
  builder.pushText(headerSections.join('\n'))
  builder.pushText('\n')
  builder.pushParts(renderToolOutput(unwrapStreamingPartial(receivedInput)))
  builder.pushText('\n</parse_error>')
  return builder.build()
}
