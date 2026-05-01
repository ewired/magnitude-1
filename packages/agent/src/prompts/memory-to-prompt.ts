/**
 * Memory-to-prompt mapper.
 *
 * Converts MemoryProjection state (Message[]) into an ai package Prompt
 * suitable for passing to the harness / BoundModel.
 *
 * Strategy:
 * - assistant_turn messages are converted structurally, preserving reasoning,
 *   text, and tool calls as native AssistantMessage fields.
 * - inbox messages are split: tool observations become ToolResultMessages,
 *   and the remaining content (timeline, errors, feedback) is rendered via
 *   formatInbox into a UserMessage.
 * - All other messages (session_context, fork_context, compacted) become
 *   UserMessages.
 */

import { Prompt, type AssistantMessage, type ToolResultMessage, type Message as AiMessage, type TerminalMessages } from '@magnitudedev/ai'
import type { Message, ForkMemoryState } from '../projections/memory'
import type { UserPart, ToolCallPart as AiToolCallPart, JsonValue } from '@magnitudedev/ai'
import { formatInbox } from '../inbox/render'

// ---------------------------------------------------------------------------
// assistant_turn → structured AssistantMessage
// ---------------------------------------------------------------------------

function assistantTurnToAiMessage(msg: Extract<Message, { type: 'assistant_turn' }>): AssistantMessage {
  let reasoning: string | undefined
  let text: string | undefined
  const toolCalls: AiToolCallPart[] = []

  for (const part of msg.parts) {
    switch (part.type) {
      case 'thought':
        reasoning = reasoning ? reasoning + '\n' + part.text : part.text
        break
      case 'message':
        text = text ? text + '\n' + part.text : part.text
        break
      case 'tool_call':
        toolCalls.push({
          _tag: 'ToolCallPart',
          id: part.id,
          name: part.toolName,
          input: part.input as JsonValue,
        })
        break
    }
  }

  return {
    _tag: 'AssistantMessage',
    reasoning,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  }
}

// ---------------------------------------------------------------------------
// inbox → ToolResultMessages + UserMessage for remaining content
// ---------------------------------------------------------------------------

function inboxToAiMessages(
  msg: Extract<Message, { type: 'inbox' }>,
  timezone: string | null,
  supportsVision: boolean,
): AiMessage[] {
  const aiMessages: AiMessage[] = []

  // Extract tool observations as native ToolResultMessages
  const toolObservationIds = new Set<string>()
  for (const result of msg.results) {
    if (result.kind === 'turn_results') {
      for (const item of result.items) {
        if (item.kind === 'tool_observation') {
          toolObservationIds.add(item.toolCallId)
          aiMessages.push({
            _tag: 'ToolResultMessage',
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            parts: item.content,
          } satisfies ToolResultMessage)
        }
      }
    }
  }

  // Render the full inbox as text for non-tool-result content (timeline, errors, feedback).
  // formatInbox includes tool results in its output, but the model needs them as
  // ToolResultMessages for native tool calling. We still include the text rendering
  // because it contains timeline entries, error messages, and other feedback that
  // doesn't map to ToolResultMessages.
  const inboxContent = formatInbox({
    results: msg.results,
    timeline: msg.timeline,
    timezone,
    supportsVision,
  })

  const hasText = inboxContent.some(
    (p): p is Extract<UserPart, { _tag: 'TextPart' }> => p._tag === 'TextPart' && p.text.trim().length > 0,
  )

  if (hasText) {
    aiMessages.push({
      _tag: 'UserMessage',
      parts: inboxContent,
    })
  }

  return aiMessages
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert memory state into an ai Prompt.
 *
 * Preserves structured assistant turn information (reasoning, tool calls)
 * and converts tool results into native ToolResultMessages for the model API.
 */
export function memoryToPrompt(
  memoryState: ForkMemoryState,
  systemPrompt: string,
  timezone: string | null,
  supportsVision: boolean,
): Prompt {
  const messages: AiMessage[] = []

  for (const msg of memoryState.messages) {
    switch (msg.type) {
      case 'session_context':
      case 'fork_context':
      case 'compacted': {
        messages.push({
          _tag: 'UserMessage',
          parts: msg.content,
        })
        break
      }

      case 'assistant_turn': {
        messages.push(assistantTurnToAiMessage(msg))
        break
      }

      case 'inbox': {
        messages.push(...inboxToAiMessages(msg, timezone, supportsVision))
        break
      }
    }
  }

  // Ensure terminal message constraint: last message must be UserMessage or ToolResultMessage
  const lastMsg = messages[messages.length - 1]
  if (!lastMsg || lastMsg._tag === 'AssistantMessage') {
    messages.push({
      _tag: 'UserMessage',
      parts: [{ _tag: 'TextPart', text: '(continue)' }],
    })
  }

  return Prompt.from({
    system: systemPrompt,
    messages: messages as TerminalMessages,
  })
}
