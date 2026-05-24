import { memo, useEffect, useState } from 'react'
import type { InterruptedMessage, ChainStats } from '@magnitudedev/agent'
import { useTheme } from '../hooks/use-theme'
import { slate } from '../utils/palette'
import { red } from '../utils/theme'

const THINKING_PULSE_COLORS = [
  slate[100], slate[200], slate[300], slate[400], slate[500],
  slate[400], slate[300], slate[200],
] as const

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

interface WorkingTimerProps {
  chainStartTime: number | null
  chainStatus: 'active' | 'completed' | null
  chainEndTime: number | null
  chainStats: ChainStats | null
  interruptedMessage?: InterruptedMessage | null
  isThinking?: boolean
  isWorkerStarting?: boolean
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

  return parts.join(' · ')
}

export const WorkingTimer = memo(function WorkingTimer({
  chainStartTime,
  chainStatus,
  chainEndTime,
  chainStats,
  interruptedMessage,
  isThinking,
  isWorkerStarting,
}: WorkingTimerProps) {
  const theme = useTheme()
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [pulseIndex, setPulseIndex] = useState(0)
  const [brailleIndex, setBrailleIndex] = useState(0)
  const [dotPulseIndex, setDotPulseIndex] = useState(0)

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

  useEffect(() => {
    if (chainStatus !== 'active') {
      setDotPulseIndex(0)
      return
    }
    const interval = setInterval(() => {
      setDotPulseIndex(i => (i + 1) % THINKING_PULSE_COLORS.length)
    }, 300)
    return () => clearInterval(interval)
  }, [chainStatus])

  useEffect(() => {
    if (!isWorkerStarting || chainStatus !== 'active') {
      setBrailleIndex(0)
      return
    }
    const interval = setInterval(() => {
      setBrailleIndex(i => (i + 1) % BRAILLE_FRAMES.length)
    }, 80)
    return () => clearInterval(interval)
  }, [isWorkerStarting, chainStatus])

  // Active: show running timer
  if (chainStatus === 'active' && chainStartTime) {
    return (
      <box style={{ flexShrink: 0, paddingLeft: 2, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: theme.muted }}>
          <span style={{ fg: THINKING_PULSE_COLORS[dotPulseIndex] }}>{'●'}</span>
          {` Working... ${formatElapsed(elapsedSeconds)}`}
          {isThinking && (
            <>
              {' · '}
              <span style={{ fg: THINKING_PULSE_COLORS[pulseIndex] }}>{'◎'}</span>
              {' Thinking'}
            </>
          )}
          {isWorkerStarting && (
            <>
              {' · '}
              <span style={{ fg: theme.muted }}>{BRAILLE_FRAMES[brailleIndex]}</span>
              {' Starting worker'}
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
          <span style={{ fg: slate[600] }}>{'●'}</span>
          {' '}
          {buildSummaryLine(chainStats, durationSeconds)}
        </text>
      </box>
    )
  }

  return null
})
