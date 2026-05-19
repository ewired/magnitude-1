/**
 * Autopilot window-to-prompt mapper.
 *
 * Builds a filtered Prompt from WindowProjection state for the autopilot worker.
 *
 * Format: the model sees its OWN action history — user messages rendered as
 * prior simulate_user_message tool calls it made, assistant prose as
 * <assistant> UserMessages. This establishes the action pattern so the model
 * naturally continues by calling simulate_user_message again.
 *
 * - Skips session_context and fork_context
 * - compacted → UserMessage verbatim (can't reconstruct tool calls)
 * - context → filtered timeline; user_message becomes simulate_user_message
 *   tool call + ToolResultMessage, observations/bash between user messages
 *   become UserMessage showing what happened
 * - assistant_turn → UserMessage with <assistant>${text}</assistant>
 * - Terminal: empty AssistantMessage (model fills in tool call)
 *
 * Cache-friendly: native message structure, stable prefix reused across generations.
 * Compaction-aware: reads from WindowProjection, sees compacted entry verbatim.
 */

import { Prompt, type Message as AiMessage, createToolCallId } from '@magnitudedev/ai'
import type { ProviderToolCallId } from '@magnitudedev/ai'
import type { ForkWindowState } from '../types'
import type { TimelineEntry } from '../inbox/types'
import type { AgentStatusState } from '../../projections/agent-status'
import {
  systemEntryToMessages,
  filteredAutopilotTimeline,
  ensureTerminalUserMessage,
} from './shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a synthetic simulate_user_message tool call + result pair.
 * Uses deterministic IDs for cache stability.
 */
function userMessageToToolCallPair(
  text: string,
): readonly [AiMessage, AiMessage] {
  const toolCallId = createToolCallId()
  const providerToolCallId = toolCallId as unknown as ProviderToolCallId

  const assistantMsg: AiMessage = {
    _tag: 'AssistantMessage',
    toolCalls: [{
      _tag: 'ToolCallPart',
      id: toolCallId,
      providerToolCallId,
      name: 'simulate_user_message',
      input: { message: text },
    }],
  }

  const toolResultMsg: AiMessage = {
    _tag: 'ToolResultMessage',
    toolCallId,
    providerToolCallId,
    toolName: 'simulate_user_message',
    parts: [{ _tag: 'TextPart', text: 'Message sent.' }],
  }

  return [assistantMsg, toolResultMsg]
}

/**
 * Convert a filtered timeline into simulate_user_message tool call pairs.
 */
function filteredTimelineToMessages(
  timeline: readonly TimelineEntry[],
  timezone: string | null,
  agentStatus: AgentStatusState,
): AiMessage[] {
  const messages: AiMessage[] = []

  for (const entry of timeline) {
    if (entry.kind === 'user_message') {
      const [assistantMsg, toolResultMsg] = userMessageToToolCallPair(entry.text)
      messages.push(assistantMsg, toolResultMsg)
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function autopilotWindowToPrompt(
  windowState: ForkWindowState,
  systemPrompt: string,
  timezone: string | null,
  agentStatus: AgentStatusState,
): Prompt {
  const messages: AiMessage[] = []

  for (const msg of windowState.messages) {
    switch (msg.type) {
      case 'compacted': {
        messages.push(...systemEntryToMessages(msg))
        break
      }

      case 'assistant_turn': {
        // Assistant prose becomes a UserMessage with <assistant> tags
        const text = msg.turn.assistant.text
        if (text) {
          messages.push({
            _tag: 'UserMessage',
            parts: [{ _tag: 'TextPart', text: `<assistant>${text}</assistant>` }],
          })
        }
        break
      }

      case 'context': {
        const filtered = filteredAutopilotTimeline(msg.timeline)
        if (filtered.length > 0) {
          messages.push(...filteredTimelineToMessages(filtered, timezone, agentStatus))
        }
        break
      }

      // session_context and fork_context deliberately skipped
    }
  }

  const terminal = ensureTerminalUserMessage(messages)
  return Prompt.from({
    system: systemPrompt,
    messages: terminal,
  })
}
