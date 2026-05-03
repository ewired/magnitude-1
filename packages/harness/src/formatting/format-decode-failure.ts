import type { ToolResultPart, ValidationIssue, StreamingPartial } from '@magnitudedev/ai'
import type { Schema } from 'effect'
import { renderExpectedParams } from './schema-render'

/**
 * Format a tool input decode failure into a <parse_error> block.
 */
export function formatDecodeFailure<TInput, R>(
  toolName: string,
  issue: ValidationIssue,
  inputSchema: Schema.Schema<TInput, TInput, R>,
  receivedInput: StreamingPartial<TInput>,
): readonly ToolResultPart[] {
  let schemaDescription: string
  try {
    schemaDescription = renderExpectedParams(inputSchema)
  } catch {
    schemaDescription = 'Expected parameters: (schema unavailable)'
  }

  const sections: string[] = [
    `<parse_error>`,
    `Invalid input for tool "${toolName}"`,
    ``,
  ]

  if (issue.path.length > 0) {
    sections.push(`Parameter: ${issue.path.join('.')}`)
  }
  sections.push(`Problem: ${issue.message}`)
  sections.push(``)
  sections.push(schemaDescription)
  sections.push(``)
  sections.push(`Received:`)
  sections.push(JSON.stringify(receivedInput, null, 2))
  sections.push(`</parse_error>`)

  return [{ _tag: 'TextPart' as const, text: sections.join('\n') }]
}
