/**
 * Window-to-prompt mapper.
 *
 * Converts WindowProjection state (WindowEntry[]) into an ai package Prompt
 * suitable for passing to the harness / BoundModel.
 *
 * Strategy:
 * - assistant_turn → AssistantMessage + ToolResultMessages + feedback UserMessage
 * - context → timeline rendered as UserMessage
 * - All other messages (session_context, fork_context, compacted) → UserMessages
 */

import { Prompt, type Message as AiMessage, type TerminalMessages } from '@magnitudedev/ai'
import type { WindowEntry, ForkWindowState } from '../projections/window'
import type { UserPart } from '@magnitudedev/ai'
import type { TurnFeedback } from '../inbox/types'
import { renderTimeline } from '../inbox/render'
import { renderFeedbackText } from './feedback-text'

// ---------------------------------------------------------------------------
// TurnFeedback → UserMessage parts
// ---------------------------------------------------------------------------

function renderFeedback(feedback: readonly TurnFeedback[]): UserPart[] {
  const text = renderFeedbackText(feedback)
  if (!text) return []
  return [{ _tag: 'TextPart', text }]
}

// ---------------------------------------------------------------------------
// context → timeline UserMessage
// ---------------------------------------------------------------------------

function inboxToAiMessages(
  msg: Extract<WindowEntry, { type: 'context' }>,
  timezone: string | null,
  supportsVision: boolean,
): AiMessage[] {
  const inboxContent = renderTimeline({
    timeline: msg.timeline,
    timezone,
    supportsVision,
  })

  const hasContent = inboxContent.some(p => {
    if (p._tag === 'TextPart') return p.text.trim().length > 0
    if (p._tag === 'ImagePart') return true
    return false
  })

  if (!hasContent) return []

  return [{
    _tag: 'UserMessage',
    parts: inboxContent,
  }]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert window state into an ai Prompt.
 *
 * Preserves structured assistant turn information (reasoning, tool calls)
 * and converts tool results into native ToolResultMessages for the model API.
 */
export function windowToPrompt(
  windowState: ForkWindowState,
  systemPrompt: string,
  timezone: string | null,
  supportsVision: boolean,
): Prompt {
  const messages: AiMessage[] = []

  for (const msg of windowState.messages) {
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
        const { turn } = msg
        messages.push(turn.assistant)
        for (const result of turn.toolResults) {
          messages.push(result)
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
    messages: messages as unknown as TerminalMessages,
  })
}
