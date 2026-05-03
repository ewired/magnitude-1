import type { ToolResultPart } from '@magnitudedev/ai'
import type { ToolResult } from '../events'
import { isImageValue, toImagePart, isScalar, renderObjectOutput, renderWrapped } from './helpers'

/**
 * Format a tool execution result (success/error/rejected/interrupted) into ToolResultParts.
 */
export function formatToolResult(
  result: ToolResult,
): readonly ToolResultPart[] {
  switch (result._tag) {
    case 'Error':
      return [{ _tag: 'TextPart', text: `<error>${result.error.message}</error>` }]

    case 'Rejected':
      return renderWrapped('rejected', result.rejection)

    case 'Interrupted':
      return [{ _tag: 'TextPart', text: '<interrupted/>' }]

    case 'Success': {
      const { output } = result

      if (output === undefined) {
        return [{ _tag: 'TextPart', text: '(no output)' }]
      }

      if (isImageValue(output)) {
        return [toImagePart(output)]
      }

      if (isScalar(output)) {
        return [{ _tag: 'TextPart', text: String(output) }]
      }

      if (Array.isArray(output)) {
        return [{ _tag: 'TextPart', text: JSON.stringify(output) }]
      }

      if (typeof output === 'object') {
        return renderObjectOutput(output as Record<string, unknown>)
      }

      return [{ _tag: 'TextPart', text: JSON.stringify(output) }]
    }
  }
}
