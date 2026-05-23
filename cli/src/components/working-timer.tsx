import { memo, useEffect, useState } from 'react'
import type { InterruptedMessage, ChainStats } from '@magnitudedev/agent'
import { useTheme } from '../hooks/use-theme'
import { slate } from '../utils/palette'
import { red } from '../utils/theme'

const THINKING_PULSE_COLORS = [
  slate[100], slate[200], slate[300], slate[400], slate[500],
  slate[400], slate[300], slate[200],
] as const

interface WorkingTimerProps {
  chainStartTime: number | null
  chainStatus: 'active' | 'completed' | null
  chainEndTime: number | null
  chainStats: ChainStats | null
  interruptedMessage?: InterruptedMessage | null
  isThinking?: boolean
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

function buildSummaryLine(stats: ChainStats, durationSeconds: number): string {
  const parts: string[] = []

  parts.push(`Worked for ${formatDuration(durationSeconds)}`)

  if (stats.workersStarted > 0) {
    parts.push(`${stats.workersStarted} worker${stats.workersStarted === 1 ? '' : 's'} started`)
  }

  if (stats.editCount > 0) {
    parts.push(`${stats.editCount} edit${stats.editCount === 1 ? '' : 's'}`)
  }

  if (stats.writeCount > 0) {
    parts.push(`${stats.writeCount} write${stats.writeCount === 1 ? '' : 's'}`)
  }

  if (stats.shellCount > 0) {
    parts.push(`${stats.shellCount} command${stats.shellCount === 1 ? '' : 's'}`)
  }

  if (stats.readCount > 0) {
    parts.push(`${stats.readCount} read${stats.readCount === 1 ? '' : 's'}`)
  }

  if (stats.searchCount > 0) {
    parts.push(`${stats.searchCount} search${stats.searchCount === 1 ? '' : 'es'}`)
  }

  if (stats.webSearchCount > 0) {
    parts.push(`${stats.webSearchCount} web search${stats.webSearchCount === 1 ? '' : 'es'}`)
  }

  return parts.join(' \u00b7 ')
}

export const WorkingTimer = memo(function WorkingTimer({
  chainStartTime,
  chainStatus,
  chainEndTime,
  chainStats,
  interruptedMessage,
  isThinking,
}: WorkingTimerProps) {
  const theme = useTheme()
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [pulseIndex, setPulseIndex] = useState(0)

  useEffect(() => {
    if (chainStatus !== 'active' || !chainStartTime) {
      setElapsedSeconds(0)
      return
    }

    const updateElapsed = () => {
      const now = Date.now()
      const elapsed = Math.floor((now - chainStartTime) / 1000)
      setElapsedSeconds(elapsed)
    }

    updateElapsed()

    const interval = setInterval(updateElapsed, 1000)

    return () => clearInterval(interval)
  }, [chainStatus, chainStartTime])

  useEffect(() => {
    if (!isThinking || chainStatus !== 'active') {
      setPulseIndex(0)
      return
    }
    const interval = setInterval(() => {
      setPulseIndex(i => (i + 1) % THINKING_PULSE_COLORS.length)
    }, 200)
    return () => clearInterval(interval)
  }, [isThinking, chainStatus])

  // Active: show running timer
  if (chainStatus === 'active' && chainStartTime) {
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: theme.muted }}>
          Working... {formatElapsed(elapsedSeconds)}
          {isThinking && (
            <>
              {' \u00b7 '}
              <span style={{ fg: THINKING_PULSE_COLORS[pulseIndex] }}>{'◎'}</span>
              {' Thinking'}
            </>
          )}
        </text>
      </box>
    )
  }

  // Interrupted state: show interrupt text in place of the work summary
  if (interruptedMessage) {
    let interruptText: string
    if (interruptedMessage.context === 'fork') {
      interruptText = '■ Agent stopped'
    } else if (interruptedMessage.allKilled) {
      interruptText = '■ All agents interrupted. What would you like to do?'
    } else {
      interruptText = '■ Lead interrupted. What would you like to do?'
    }
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: red[400] }}>{interruptText}</text>
      </box>
    )
  }

  // Completed: show persistent summary from chain stats
  if (chainStatus === 'completed' && chainStartTime && chainEndTime && chainStats) {
    const durationSeconds = Math.floor((chainEndTime - chainStartTime) / 1000)
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: theme.muted }}>
          {buildSummaryLine(chainStats, durationSeconds)}
        </text>
      </box>
    )
  }

  return null
})
