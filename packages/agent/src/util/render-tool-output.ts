import type { ToolResult } from '@magnitudedev/harness'
import type { ContentPart } from '../content'

// =============================================================================
// renderToolOutput
//
// Converts a ToolResult into ContentPart[] for memory/LLM consumption.
//
// Format (for Success with object output):
//   <fieldName>scalar value, raw and unescaped</fieldName>
//   <fieldName>{"json":"for non-scalar values"}</fieldName>
//
// No outer wrapper — the chat template or codec provides the boundary.
// =============================================================================

function isImageOutput(output: unknown): output is ContentPart & { type: 'image' } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as Record<string, unknown>).type === 'image' &&
    typeof (output as Record<string, unknown>).base64 === 'string' &&
    typeof (output as Record<string, unknown>).mediaType === 'string'
  )
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function renderField(name: string, value: unknown): string {
  if (!isScalar(value)) {
    return `<${name}>${JSON.stringify(value)}</${name}>`
  }
  const raw = String(value)
  if (raw.includes('\n')) {
    return `<${name}>\n${raw}\n</${name}>`
  }
  return `<${name}>${raw}</${name}>`
}

function renderObjectOutput(output: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(output)) {
    if (value === undefined) continue
    lines.push(renderField(key, value))
  }
  return lines.join('\n')
}

function renderRejection(rejection: unknown): string {
  const inner = isScalar(rejection) ? String(rejection) : JSON.stringify(rejection)
  return `<rejected>${inner}</rejected>`
}

/**
 * Convert a ToolResult into ContentPart[] for memory/LLM consumption.
 */
export function renderToolOutput(result: ToolResult): readonly ContentPart[] {
  switch (result._tag) {
    case 'Error':
      return [{ type: 'text', text: `<error>${result.error}</error>` }]

    case 'Rejected':
      return [{ type: 'text', text: renderRejection(result.rejection) }]

    case 'Interrupted':
      return [{ type: 'text', text: '<interrupted/>' }]

    case 'Success': {
      const { output } = result

      if (output === undefined) {
        return [{ type: 'text', text: '(no output)' }]
      }

      if (isImageOutput(output)) {
        return [{ type: 'image', base64: output.base64, mediaType: output.mediaType, width: output.width, height: output.height }]
      }

      if (isScalar(output)) {
        return [{ type: 'text', text: String(output) }]
      }

      if (Array.isArray(output)) {
        return [{ type: 'text', text: JSON.stringify(output) }]
      }

      if (typeof output === 'object') {
        const text = renderObjectOutput(output as Record<string, unknown>)
        return [{ type: 'text', text }]
      }

      return [{ type: 'text', text: JSON.stringify(output) }]
    }
  }
}
