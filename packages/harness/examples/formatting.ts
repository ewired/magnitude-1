/**
 * Example: Formatting tool results and decode failures
 *
 * Shows formatToolResult for success/error/rejected/interrupted results,
 * and formatDecodeFailure for parse errors with schema + received input.
 */

import { Schema } from 'effect'
import { formatToolResult, formatDecodeFailure } from '../src'
import type { ToolResult, ToolError } from '../src'

// ── formatToolResult: success with scalar output ─────────────────────

const scalarResult: ToolResult = { _tag: 'Success', output: 'file contents here' }
const scalarParts = formatToolResult(scalarResult)
// → [{ _tag: 'TextPart', text: 'file contents here' }]

// ── formatToolResult: success with object output ─────────────────────

const objectResult: ToolResult = {
  _tag: 'Success',
  output: {
    path: '/src/index.ts',
    type: 'file',
    size: 1024,
  },
}
const objectParts = formatToolResult(objectResult)
// → [{ _tag: 'TextPart', text: '<path>/src/index.ts</path>\n<type>file</type>\n<size>1024</size>' }]

// ── formatToolResult: success with image output ──────────────────────

const imageResult: ToolResult = {
  _tag: 'Success',
  output: {
    base64: 'iVBORw0KGgo...',
    mediaType: 'image/png',
    width: 800,
    height: 600,
  },
}
const imageParts = formatToolResult(imageResult)
// → [{ _tag: 'ImagePart', data: 'iVBORw0KGgo...', mediaType: 'image/png' }]

// ── formatToolResult: error ──────────────────────────────────────────

const errorResult: ToolResult = {
  _tag: 'Error',
  error: { _tag: 'FsError', message: 'file not found' },
}
const errorParts = formatToolResult(errorResult)
// → [{ _tag: 'TextPart', text: '<error>file not found</error>' }]

// ── formatToolResult: rejected / interrupted ─────────────────────────

const rejectedParts = formatToolResult({ _tag: 'Rejected', rejection: 'not allowed' })
// → [{ _tag: 'TextPart', text: '<rejected>not allowed</rejected>' }]

const interruptedParts = formatToolResult({ _tag: 'Interrupted' })
// → [{ _tag: 'TextPart', text: '<interrupted/>' }]

// ── formatDecodeFailure ──────────────────────────────────────────────

const UpdateTaskInput = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal('pending', 'completed', 'cancelled'),
})

const decodeFailureParts = formatDecodeFailure(
  'update_task',
  { path: ['id'], message: 'Expected string, received undefined' },
  UpdateTaskInput,
  {} as any, // the model sent an empty object
)
// → [{ _tag: 'TextPart', text: '<parse_error>\nInvalid input for tool "update_task"\n\nParameter: id\nProblem: Expected string, received undefined\n\nExpected parameters:\n  id: string\n  status: "pending" | "completed" | "cancelled"\n\nReceived:\n{}\n</parse_error>' }]

// ── Concrete typed result ────────────────────────────────────────────

// With generics, the result is fully typed
type FsError = { readonly _tag: 'FsError'; readonly message: string }
const typedResult: ToolResult<string, FsError> = { _tag: 'Success', output: 'hello' }

// formatToolResult accepts both erased and concrete results
const typedParts = formatToolResult(typedResult)
