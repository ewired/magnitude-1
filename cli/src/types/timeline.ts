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
 * Group consecutive tool messages with the same cluster property into ClusterItems.
 * Pure data transform — no React dependencies.
 */
export function groupClusters(items: readonly TimelineItem[]): MergedItem[] {
  const result: MergedItem[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    if (item.kind === 'chat' && item.message.type === 'tool' && item.message.cluster) {
      const cluster = item.message.cluster
      const steps: ToolMessage[] = [item.message as ToolMessage]
      let j = i + 1
      while (j < items.length && items[j].kind === 'chat' && (items[j].message as ToolMessage).type === 'tool' && (items[j].message as ToolMessage).cluster === cluster) {
        steps.push(items[j].message as ToolMessage)
        j++
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
