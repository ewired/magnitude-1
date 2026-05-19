/**
 * Full window-to-prompt mapper for the leader agent.
 *
 * Preserves structured assistant turn information (reasoning, tool calls)
 * and converts semantic tool results into native ToolResultMessages for the model API.
 *
 * Composes shared helpers from ./shared.ts and formatters from ./formatters.ts.
 */

import { Prompt, type Message as AiMessage, type TerminalMessages } from '@magnitudedev/ai'
import type { ForkWindowState } from '../types'
import type { ToolResultEntry } from '@magnitudedev/harness'
import type { ToolResultFormatter } from '@magnitudedev/harness'
import type { AgentStatusState } from '../../projections/agent-status'
import { createTruncatingFormatter } from './formatters'
import {
  systemEntryToMessages,
  contextEntryToMessages,
  renderFeedback,
  ensureTerminalUserMessage,
} from './shared'

// ---------------------------------------------------------------------------
// ToolResultEntry → ToolResultMessage conversion
// ---------------------------------------------------------------------------

function toolResultEntryToMessage(
  entry: ToolResultEntry,
  formatter: ToolResultFormatter,
  turnId: string,
): AiMessage {
  const parts = formatter(entry)

  return {
    _tag: 'ToolResultMessage',
    toolCallId: entry.toolCallId,
    providerToolCallId: entry.providerToolCallId,
    toolName: entry.toolName,
    parts,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert window state into an ai Prompt.
 *
 * Preserves structured assistant turn information (reasoning, tool calls)
 * and converts semantic tool results into native ToolResultMessages for the model API.
 */
export function windowToPrompt(
  windowState: ForkWindowState,
  systemPrompt: string,
  timezone: string | null,
  agentStatus: AgentStatusState,
  formatter: ToolResultFormatter,
): Prompt {
  const messages: AiMessage[] = []

  for (const msg of windowState.messages) {
    switch (msg.type) {
      case 'session_context':
      case 'fork_context':
      case 'compacted': {
        messages.push(...systemEntryToMessages(msg))
        break
      }

      case 'assistant_turn': {
        const { turn } = msg
        messages.push(turn.assistant)
        const turnFormatter = createTruncatingFormatter(formatter, turn.turnId)
        for (const entry of turn.toolResults) {
          messages.push(toolResultEntryToMessage(entry, turnFormatter, turn.turnId))
        }
        const feedbackParts = renderFeedback(turn.feedback)
        if (feedbackParts.length > 0) {
          messages.push({
            _tag: 'UserMessage',
            parts: feedbackParts,
          })
        }
        break
      }

      case 'context': {
        messages.push(...contextEntryToMessages(msg, timezone, agentStatus))
        break
      }
    }
  }

  const terminal = ensureTerminalUserMessage(messages, '(continue)')

  return Prompt.from({
    system: systemPrompt,
    messages: terminal,
  })
}
