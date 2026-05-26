import type { DisplayMessage, ToolMessage } from '@magnitudedev/agent'
import type { BashResult } from '../utils/bash-executor'

export interface ChatMessageItem {
  readonly kind: 'chat'
  readonly id: string
  readonly timestamp: number
  readonly message: DisplayMessage
}

export interface BashOutputItem {
  readonly kind: 'bash'
  readonly id: string
  readonly timestamp: number
  readonly result: BashResult
}

export interface SystemMessageItem {
  readonly kind: 'system'
  readonly id: string
  readonly text: string
  readonly timestamp: number
}

export interface ClusterItem {
  readonly kind: 'cluster'
  readonly id: string
  readonly timestamp: number
  readonly steps: ToolMessage[]
  readonly cluster: string
}

export type TimelineItem = ChatMessageItem | BashOutputItem | SystemMessageItem

export type MergedItem = TimelineItem | ClusterItem

/**
 * Message types that are invisible in default mode.
 * They should not break tool clustering AND should not appear in the
 * output array in default mode (since they'd create invisible layout space).
 * In transcript mode, thinking IS visible so it stays.
 */
const DEFAULT_INVISIBLE_TYPES: ReadonlySet<string> = new Set([
  'thinking',
  'status_indicator',
  'worker_resumed',
  'agent_communication',
])

/**
 * Tool keys that are invisible in default mode.
 * They are dropped from the timeline entirely (no ghost space), but visible in transcript mode.
 */
const DEFAULT_INVISIBLE_TOOL_KEYS: ReadonlySet<string> = new Set([
  'spawnWorker',
])

/**
 * Message types that are always invisible regardless of mode.
 * These never render anything in MessageView.
 */
const ALWAYS_INVISIBLE_TYPES: ReadonlySet<string> = new Set([
  'worker_finished',
  'worker_killed',
  'worker_user_killed',
])

function isInvisibleInMode(message: DisplayMessage, mode: 'default' | 'transcript'): boolean {
  if (ALWAYS_INVISIBLE_TYPES.has(message.type)) return true
  if (mode === 'default' && DEFAULT_INVISIBLE_TYPES.has(message.type)) return true
  if (mode === 'default' && message.type === 'tool' && DEFAULT_INVISIBLE_TOOL_KEYS.has(message.toolKey)) return true
  return false
}

/**
 * Group consecutive tool messages with the same cluster property into ClusterItems.
 *
 * In default mode:
 * - Invisible messages (thinking, status_indicator, worker_resumed, worker_finished, etc.)
 *   are dropped entirely — they neither break clustering nor appear in output
 * - This means tools separated by thinking in the raw array will cluster together
 *
 * In transcript mode:
 * - Thinking/status_indicator are visible and DO break the chain
 * - Always-invisible types (worker_finished, etc.) are still dropped
 *
 * Pure data transform — no React dependencies.
 */
export function groupClusters(
  items: readonly TimelineItem[],
  mode: 'default' | 'transcript' = 'default',
): MergedItem[] {
  const result: MergedItem[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]

    // Skip invisible messages entirely (they won't render and would only create layout space)
    if (item.kind === 'chat' && isInvisibleInMode(item.message, mode)) {
      i++
      continue
    }

    if (item.kind === 'chat' && item.message.type === 'tool' && item.message.cluster) {
      const cluster = item.message.cluster
      const steps: ToolMessage[] = [item.message as ToolMessage]
      let j = i + 1

      while (j < items.length) {
        const next = items[j]

        // Skip invisible messages — they don't break the chain
        if (next.kind === 'chat' && isInvisibleInMode(next.message, mode)) {
          j++
          continue
        }

        if (next.kind === 'chat' && next.message.type === 'tool' && next.message.cluster === cluster) {
          steps.push(next.message as ToolMessage)
          j++
        } else {
          break
        }
      }

      result.push({ kind: 'cluster', id: `cluster-${item.message.id}`, timestamp: item.timestamp, steps, cluster })
      i = j
    } else {
      result.push(item)
      i++
    }
  }
  return result
}
