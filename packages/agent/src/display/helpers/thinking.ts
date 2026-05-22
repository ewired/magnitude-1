import type { ThinkingMessage, DisplayMessage } from '../types'
import { HIDE_THINKING_LABELS, TRAIT_LABELS } from '../constants'

/** Module-level map for held buffer state during streaming — keyed by thinking message ID.
 *  Used to avoid flicker when labels are split across chunk boundaries.
 */
export const heldBuffers = new Map<string, string>()

export function processThinkingChunk(
  step: ThinkingMessage,
  newText: string
): { contentToAppend: string; shouldSuppress: boolean } {
  if (!HIDE_THINKING_LABELS) {
    return { contentToAppend: newText, shouldSuppress: false }
  }

  const raw = (heldBuffers.get(step.id) ?? '') + newText

  // Only check [SKIP] suppression if step has no visible content yet
  if (step.content === '' && raw.includes('[SKIP]')) {
    heldBuffers.delete(step.id)
    return { contentToAppend: '', shouldSuppress: true }
  }

  // Strip known labels (+ optional trailing whitespace) from raw
  // Skip [SKIP] if step already has content — treat as ordinary text then
  let cleaned = raw
  for (const label of TRAIT_LABELS) {
    if (label === '[SKIP]' && step.content !== '') continue
    cleaned = cleaned.replaceAll(label + ' ', '')
    cleaned = cleaned.replaceAll(label + '\n', '')
    cleaned = cleaned.replaceAll(label + '\t', '')
    cleaned = cleaned.replaceAll(label, '')
  }

  // Check tail for potential label prefix
  const lastBracket = cleaned.lastIndexOf('[')
  if (lastBracket === -1) {
    heldBuffers.delete(step.id)
    return { contentToAppend: cleaned, shouldSuppress: false }
  }

  const suffix = cleaned.slice(lastBracket)
  const isPrefix = TRAIT_LABELS.some(l => l.startsWith(suffix))

  if (!isPrefix) {
    heldBuffers.delete(step.id)
    return { contentToAppend: cleaned, shouldSuppress: false }
  }

  heldBuffers.set(step.id, suffix)
  return { contentToAppend: cleaned.slice(0, lastBracket), shouldSuppress: false }
}

export function flushHeld(stepId: string): string {
  const held = heldBuffers.get(stepId)
  if (held !== undefined) {
    heldBuffers.delete(stepId)
    return held
  }
  return ''
}

/**
 * Find index of the last message that is NOT a queued_user_message.
 * Returns -1 if no such message exists.
 */
export function findLastNonQueuedIndex(messages: readonly DisplayMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== 'queued_user_message') return i
  }
  return -1
}

/**
 * If the last non-queued message is a thinking message, flush any
 * held buffer into it and return the updated messages array.
 */
export function flushLastThinking(
  messages: readonly DisplayMessage[]
): readonly DisplayMessage[] {
  const idx = findLastNonQueuedIndex(messages)
  if (idx === -1) return messages
  const msg = messages[idx]
  if (msg.type !== 'thinking') return messages

  const held = heldBuffers.get(msg.id)
  if (!held) return messages
  heldBuffers.delete(msg.id)

  const result = [...messages]
  result[idx] = { ...msg, content: msg.content + held }
  return result
}

/** Remove any thinking messages whose content is empty, cleaning heldBuffers. */
export function removeEmptyThinkingMessages(
  messages: readonly DisplayMessage[]
): readonly DisplayMessage[] {
  return messages.filter(m => {
    if (m.type === 'thinking' && m.content === '') {
      heldBuffers.delete(m.id)
      return false
    }
    return true
  })
}
