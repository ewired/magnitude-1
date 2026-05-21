import { memo, useEffect, useState } from 'react'
import type { ThinkBlockMessage, InterruptedMessage } from '@magnitudedev/agent'
import { useTheme } from '../hooks/use-theme'

interface WorkingTimerProps {
  startTime: number | null
  visible: boolean
  completedThinkBlock: ThinkBlockMessage | null
  interruptedMessage?: InterruptedMessage | null
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (remainingSeconds === 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

function computeSummary(block: ThinkBlockMessage): {
  durationSeconds: number
  workerCount: number
  editCount: number
  writeCount: number
  shellCount: number
  readCount: number
  searchCount: number
} {
  let workerCount = 0
  let editCount = 0
  let writeCount = 0
  let shellCount = 0
  let readCount = 0
  let searchCount = 0

  for (const step of block.steps) {
    switch (step.type) {
      case 'subagent_started':
        workerCount++
        break
      case 'tool':
        switch (step.toolKey) {
          case 'fileEdit':
            editCount++
            break
          case 'fileWrite':
            writeCount++
            break
          case 'shell':
            shellCount++
            break
          case 'fileRead':
            readCount++
            break
          case 'fileSearch':
          case 'webSearch':
            searchCount++
            break
        }
        break
    }
  }

  const durationSeconds = block.completedAt
    ? Math.floor((block.completedAt - block.timestamp) / 1000)
    : 0

  return { durationSeconds, workerCount, editCount, writeCount, shellCount, readCount, searchCount }
}

function buildSummaryLine(summary: ReturnType<typeof computeSummary>): string {
  const parts: string[] = []

  parts.push(`Worked for ${formatDuration(summary.durationSeconds)}`)

  if (summary.workerCount > 0) {
    parts.push(`${summary.workerCount} worker${summary.workerCount === 1 ? '' : 's'} ran`)
  }

  if (summary.editCount > 0) {
    parts.push(`${summary.editCount} edit${summary.editCount === 1 ? '' : 's'}`)
  }

  if (summary.writeCount > 0) {
    parts.push(`${summary.writeCount} write${summary.writeCount === 1 ? '' : 's'}`)
  }

  if (summary.shellCount > 0) {
    parts.push(`${summary.shellCount} command${summary.shellCount === 1 ? '' : 's'}`)
  }

  if (summary.readCount > 0) {
    parts.push(`${summary.readCount} read${summary.readCount === 1 ? '' : 's'}`)
  }

  if (summary.searchCount > 0) {
    parts.push(`${summary.searchCount} search${summary.searchCount === 1 ? '' : 'es'}`)
  }

  return parts.join(' \u00b7 ')
}

export const WorkingTimer = memo(function WorkingTimer({
  startTime,
  visible,
  completedThinkBlock,
  interruptedMessage,
}: WorkingTimerProps) {
  const theme = useTheme()
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  useEffect(() => {
    if (!visible || !startTime) {
      setElapsedSeconds(0)
      return
    }

    const updateElapsed = () => {
      const now = Date.now()
      const elapsed = Math.floor((now - startTime) / 1000)
      setElapsedSeconds(elapsed)
    }

    updateElapsed()

    const interval = setInterval(updateElapsed, 1000)

    return () => clearInterval(interval)
  }, [visible, startTime])

  // Working state: show running timer
  if (visible && startTime) {
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: theme.muted }}>
          Working... {formatElapsed(elapsedSeconds)}
        </text>
      </box>
    )
  }

  // Interrupted state: show interrupt text in place of the work summary
  if (interruptedMessage) {
    let interruptText: string
    if (interruptedMessage.context === 'fork') {
      interruptText = '[Stopped] · Agent was stopped by user'
    } else if (interruptedMessage.allKilled) {
      interruptText = '[Interrupted] · All agents were stopped. What would you like to do?'
    } else {
      interruptText = '[Interrupted] · What would you like to do instead?'
    }
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: theme.warning }}>{interruptText}</text>
      </box>
    )
  }

  // Completed state: show persistent summary from the last completed think block
  if (completedThinkBlock) {
    const summary = computeSummary(completedThinkBlock)
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: theme.muted }}>
          {buildSummaryLine(summary)}
        </text>
      </box>
    )
  }

  return null
})
