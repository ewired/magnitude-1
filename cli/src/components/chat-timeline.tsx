import { memo, useMemo } from 'react'
import type { InterruptedMessage, ActionId } from '@magnitudedev/agent'
import { groupClusters, type TimelineItem } from '../types/timeline'
import { MessageView } from './message-view'
import { ClusterSummaryRow } from './tool-cluster'
import { ErrorBoundary } from './error-boundary'
import { BashOutput } from './bash-output'

interface ChatTimelineProps {
  items: readonly TimelineItem[]
  displayMode: 'default' | 'transcript'
  isStreaming: boolean
  streamingMessageId: string | null
  lastInterruptedMessage: InterruptedMessage | null
  interruptedMessageId: string | null
  chatColumnWidth: number
  themeErrorColor: string
  themeMutedColor: string
  onFileClick: (path: string, section?: string) => void
  onForkExpand: (forkId: string) => void
  onErrorAction: (actionId: ActionId) => void
}

export const ChatTimeline = memo(function ChatTimeline({
  items,
  displayMode,
  isStreaming,
  streamingMessageId,
  lastInterruptedMessage,
  interruptedMessageId,
  chatColumnWidth,
  themeErrorColor,
  themeMutedColor,
  onFileClick,
  onForkExpand,
  onErrorAction,
}: ChatTimelineProps) {
  const mergedItems = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp)
    return groupClusters(sorted, displayMode)
  }, [items, displayMode])

  return mergedItems.map((merged, idx) => {
    const nextIsCluster = idx + 1 < mergedItems.length && mergedItems[idx + 1]?.kind === 'cluster'

    switch (merged.kind) {
      case 'chat': {
        const msg = merged.message
        // Skip the last interrupted message — it renders in WorkingTimer slot instead
        if (msg.type === 'interrupted' && lastInterruptedMessage && msg.id === lastInterruptedMessage.id) return null
        const isStreamingMsg = isStreaming && streamingMessageId === msg.id
        const isInterrupted = interruptedMessageId === msg.id
        const nextMerged = idx + 1 < mergedItems.length ? mergedItems[idx + 1] : null
        const nextMsgInterrupted = nextMerged?.kind === 'chat' && nextMerged.message.type === 'interrupted'
        return (
          <ErrorBoundary key={msg.id} fallback={(err) => (
            <box style={{ paddingLeft: 1 }}>
              <text style={{ fg: themeErrorColor }}>[Render error: {err.message}]</text>
            </box>
          )}>
            <MessageView
              message={msg}
              isStreaming={isStreamingMsg}
              isInterrupted={isInterrupted}
              nextMessageInterrupted={nextMsgInterrupted}
              mode={displayMode}
              onFileClick={onFileClick}
              onForkExpand={onForkExpand}
              onErrorAction={onErrorAction}
            />
          </ErrorBoundary>
        )
      }
      case 'cluster': {
        return (
          <ErrorBoundary key={merged.id} fallback={(err) => (
            <box style={{ paddingLeft: 1 }}>
              <text style={{ fg: themeErrorColor }}>[Render error: {err.message}]</text>
            </box>
          )}>
            <box style={{ paddingLeft: 1, marginBottom: nextIsCluster ? 0 : 1 }}>
              <ClusterSummaryRow
                cluster={merged.cluster}
                steps={merged.steps}
                width={chatColumnWidth - 2}
                mode={displayMode}
              />
            </box>
          </ErrorBoundary>
        )
      }
      case 'bash':
        return (
          <box key={merged.id} style={{ paddingLeft: 1 }}>
            <BashOutput result={merged.result} />
          </box>
        )
      case 'system':
        return (
          <box key={merged.id} style={{ paddingLeft: 1, marginBottom: 1 }}>
            <text style={{ fg: themeMutedColor }}>{merged.text}</text>
          </box>
        )
    }
  })
})
