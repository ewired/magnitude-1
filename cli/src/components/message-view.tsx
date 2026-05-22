import { memo } from 'react'
import type { DisplayMessage, ActionId, ToolMessage } from '@magnitudedev/agent'
import { UserMessage } from './user-message'
import { QueuedUserMessage } from './queued-user-message'
import { AssistantMessage } from './assistant-message'
import { ToolStepView } from './tool-cluster'
import { AgentCommunicationCard } from './agent-communication-card'
import { ErrorMessage } from './error-message'
import { useTheme } from '../hooks/use-theme'
import { red, violet } from '../utils/theme'
import { TextAttributes } from '@opentui/core'

interface MessageViewProps {
  message: DisplayMessage
  isStreaming: boolean
  isInterrupted?: boolean
  nextMessageInterrupted?: boolean
  onFileClick?: (path: string, section?: string) => void
  onForkExpand?: (forkId: string) => void
  onErrorAction?: (actionId: ActionId) => void
  mode?: 'default' | 'transcript'
}

const WorkerResumedRow = ({ message }: { message: Extract<DisplayMessage, { type: 'worker_resumed' }> }) => {
  const theme = useTheme()
  return (
    <box style={{ marginBottom: 1 }}>
      <text>
        <span style={{ fg: violet[300] }}>▶ </span>
        <span style={{ fg: theme.muted }}>Worker </span>
        <span style={{ fg: theme.foreground }}>{message.workerId}</span>
        <span style={{ fg: theme.muted }}> resumed</span>
        <span style={{ fg: theme.muted }}> · {message.workerRole}</span>
      </text>
    </box>
  )
}

const StatusIndicatorRow = ({ message }: { message: Extract<DisplayMessage, { type: 'status_indicator' }> }) => {
  const theme = useTheme()
  return (
    <box style={{ marginBottom: 1 }}>
      <text attributes={TextAttributes.DIM}>
        <span style={{ fg: theme.muted }}>{message.message}</span>
      </text>
    </box>
  )
}

export const MessageView = memo(function MessageView({
  message,
  isStreaming,
  isInterrupted,
  nextMessageInterrupted,
  onFileClick,
  onForkExpand,
  onErrorAction,
  mode = 'default',
}: MessageViewProps) {
  const theme = useTheme()
  const isUserType = message.type === 'user_message' || message.type === 'queued_user_message'

  const content = (() => {
    switch (message.type) {
      case 'user_message':
        return <UserMessage content={message.content} timestamp={message.timestamp} taskMode={message.taskMode} attachments={message.attachments} />

      case 'queued_user_message':
        return <QueuedUserMessage content={message.content} />

      case 'assistant_message':
        return (
          <AssistantMessage
            content={message.content}
            isStreaming={isStreaming}
            isInterrupted={isInterrupted}
            onFileClick={onFileClick}
          />
        )

      case 'thinking': {
        // Thinking is hidden in default mode
        if (mode === 'default') return null
        // In transcript mode, show thinking content (dim, italic)
        return (
          <box style={{ marginBottom: 1 }}>
            <text attributes={TextAttributes.ITALIC}>
              <span style={{ fg: theme.muted }}>{message.content}</span>
            </text>
          </box>
        )
      }

      case 'tool': {
        return (
          <box style={{ marginBottom: 1 }}>
            <ToolStepView step={message} mode={mode} onFileClick={onFileClick} />
          </box>
        )
      }

      case 'status_indicator':
        return <StatusIndicatorRow message={message} />

      case 'worker_resumed':
        return <WorkerResumedRow message={message} />

      case 'worker_finished':
      case 'worker_killed':
      case 'worker_user_killed':
        // These are data messages, not visually rendered inline
        return null

      case 'interrupted': {
        let interruptText: string
        if (message.context === 'fork') {
          interruptText = '■ Agent stopped'
        } else if (message.allKilled) {
          interruptText = '■ All agents interrupted. What would you like to do?'
        } else {
          interruptText = '■ Lead interrupted. What would you like to do?'
        }
        const noBottomGap = nextMessageInterrupted
        return (
          <box style={{ marginBottom: noBottomGap ? 0 : 1 }}>
            <text style={{ fg: red[400] }}>{interruptText}</text>
          </box>
        )
      }

      case 'error':
        return <ErrorMessage message={message.message} timestamp={message.timestamp} cta={message.cta} onAction={onErrorAction} />

      case 'agent_communication':
        return (
          <box style={{ marginBottom: 1 }}>
            <AgentCommunicationCard message={message} onFileClick={onFileClick} />
          </box>
        )

    }
  })()

  if (isUserType) {
    return content
  }

  return <box style={{ paddingLeft: 1 }}>{content}</box>
})
