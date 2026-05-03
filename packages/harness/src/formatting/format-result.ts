import type { ToolResultPart } from '@magnitudedev/ai'
import type { ToolResult, ToolError } from '../events'
import { isImageValue, toImagePart, renderToolOutput, renderTagged } from './helpers'

/**
 * Format a tool execution result (success/error/rejected/interrupted) into ToolResultParts.
 */
export function formatToolResult<TOutput, TError extends ToolError>(
  result: ToolResult<TOutput, TError>,
): readonly ToolResultPart[] {
  switch (result._tag) {
    case 'Error':
      return [{ _tag: 'TextPart', text: `<error>${result.error.message}</error>` }]

    case 'Rejected':
      return renderTagged('rejected', result.rejection)

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

      return renderToolOutput(output)
    }
  }
}
