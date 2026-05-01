import type { ToolResult } from '@magnitudedev/harness'
import type { UserPart, ImageMediaType } from '@magnitudedev/ai'

// =============================================================================
// renderToolOutput
//
// Converts a ToolResult into UserPart[] for memory/LLM consumption.
//
// Format (for Success with object output):
//   <fieldName>scalar value, raw and unescaped</fieldName>
//   <fieldName>{"json":"for non-scalar values"}</fieldName>
//
// No outer wrapper — the chat template or codec provides the boundary.
// =============================================================================

function isImageOutput(output: unknown): output is { _tag: 'ImagePart'; data: string; mediaType: ImageMediaType } {
  return (
    typeof output === 'object' &&
    output !== null &&
    (output as Record<string, unknown>)._tag === 'ImagePart' &&
    typeof (output as Record<string, unknown>).data === 'string' &&
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
 * Convert a ToolResult into UserPart[] for memory/LLM consumption.
 */
export function renderToolOutput(result: ToolResult): readonly UserPart[] {
  switch (result._tag) {
    case 'Error':
      return [{ _tag: 'TextPart', text: `<error>${result.error}</error>` }]

    case 'Rejected':
      return [{ _tag: 'TextPart', text: renderRejection(result.rejection) }]

    case 'Interrupted':
      return [{ _tag: 'TextPart', text: '<interrupted/>' }]

    case 'Success': {
      const { output } = result

      if (output === undefined) {
        return [{ _tag: 'TextPart', text: '(no output)' }]
      }

      if (isImageOutput(output)) {
        return [{ _tag: 'ImagePart', data: output.data, mediaType: output.mediaType }]
      }

      if (isScalar(output)) {
        return [{ _tag: 'TextPart', text: String(output) }]
      }

      if (Array.isArray(output)) {
        return [{ _tag: 'TextPart', text: JSON.stringify(output) }]
      }

      if (typeof output === 'object') {
        const text = renderObjectOutput(output as Record<string, unknown>)
        return [{ _tag: 'TextPart', text }]
      }

      return [{ _tag: 'TextPart', text: JSON.stringify(output) }]
    }
  }
}
