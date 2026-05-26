import type { DisplayMessage, DisplayState, ErrorDisplayMessage } from '../types'
import { createId } from '../../util/id'
import { present, type ErrorCta } from '../../errors'
import type { TurnOutcome } from '../../events'
import type { ToolState, SpawnWorkerState } from '../../models/index'

export const generateId = () => createId()

export const getVisualState = (
  toolStateFork: { readonly toolHandles: { readonly [callId: string]: { readonly state: ToolState } } },
  callId: string
): ToolState | undefined =>
  toolStateFork.toolHandles[callId]?.state

/**
 * Find the index where new content should be inserted (before queued messages).
 * Returns the index of the first queued message, or messages.length if none.
 */
export function findInsertionIndex(messages: readonly DisplayMessage[]): number {
  const queuedIndex = messages.findIndex(m => m.type === 'queued_user_message')
  return queuedIndex === -1 ? messages.length : queuedIndex
}

/**
 * Insert a message before queued messages (or at end if no queued messages).
 * Returns a new array.
 */
export function insertBeforeQueuedMessages(
  messages: readonly DisplayMessage[],
  message: DisplayMessage
): DisplayMessage[] {
  const result = [...messages]
  const insertIndex = findInsertionIndex(result)
  result.splice(insertIndex, 0, message)
  return result
}

export function toErrorDisplayMessage(outcome: TurnOutcome, timestamp: number): ErrorDisplayMessage | null {
  const p = present(outcome)
  if (p.surface !== 'inline') return null
  return {
    id: generateId(),
    type: 'error',
    message: p.message,
    timestamp,
    cta: p.cta,
  }
}

export function moveMessageToEndBeforeQueue<T extends DisplayMessage>(
  messages: readonly DisplayMessage[],
  id: string,
  updater?: (message: T) => DisplayMessage
): DisplayMessage[] {
  const index = messages.findIndex(m => m.id === id)
  if (index === -1) return [...messages]
  const target = messages[index] as T
  const updated = updater ? updater(target) : target
  const remaining = [...messages.slice(0, index), ...messages.slice(index + 1)]
  return insertBeforeQueuedMessages(remaining, updated)
}

export function deriveIsThinking(messages: readonly DisplayMessage[], status: DisplayState['status']): boolean {
  if (status !== 'streaming') return false
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== 'queued_user_message') {
      return messages[i].type === 'thinking'
    }
  }
  return false
}

export function deriveIsWorkerStarting(messages: readonly DisplayMessage[], status: DisplayState['status']): boolean {
  if (status !== 'streaming') return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type === 'tool' && msg.toolKey === 'spawnWorker') {
      const phase = (msg.state as SpawnWorkerState | undefined)?.phase
      return phase === 'streaming' || phase === 'executing'
    }
  }
  return false
}

export function toPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) return normalized
  return normalized.slice(0, 117) + '...'
}

/**
 * Update a message in the messages array by id, returning a new array.
 */
export function updateMessageById<T extends DisplayMessage>(
  messages: readonly DisplayMessage[],
  id: string,
  updater: (msg: T) => T
): DisplayMessage[] {
  return messages.map(m => m.id === id ? updater(m as T) : m)
}
