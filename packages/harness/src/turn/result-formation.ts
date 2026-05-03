import type { ToolCallId, ToolResultPart } from "@magnitudedev/ai"
import type { ToolResult } from "../events"
import type { HarnessHooks } from "../hooks"
import { Effect } from "effect"

/**
 * Formats a tool result into ToolResultParts for the canonical turn,
 * invoking formatResult and onResult hooks when provided.
 */
export function formatToolResult<R>(
  toolCallId: ToolCallId,
  toolName: string,
  toolKey: string,
  result: ToolResult,
  hooks: HarnessHooks<R> | undefined,
): Effect.Effect<readonly ToolResultPart[], never, R> {
  const parts: readonly ToolResultPart[] = hooks?.formatResult
    ? hooks.formatResult(toolName, toolKey, result)
    : defaultFormatResult(result)

  const onResult = hooks?.onResult
    ? hooks.onResult({ toolCallId, toolName, toolKey, result, parts })
    : Effect.void

  return Effect.map(onResult, () => parts)
}

import { formatToolResult as formatToolResultDefault } from "../formatting/format-result"

function defaultFormatResult(result: ToolResult): readonly ToolResultPart[] {
  return formatToolResultDefault(result)
}
