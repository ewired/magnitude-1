import { memo, useCallback, useEffect, useState } from 'react'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useTheme } from '../hooks/use-theme'
import { ProgressBar } from './progress-bar'
import { fetchUsageWindows, type UsageWindowsResponse } from '@magnitudedev/agent'
import { logger } from '@magnitudedev/logger'
import { formatRemaining } from '../utils/format-duration'

interface UsageOverlayProps {
  isVisible: boolean
  onClose: () => void
  apiKey: string | null
}

const WINDOW_LABELS: Record<keyof UsageWindowsResponse['usageWindows'], string> = {
  five_hour: '5-hour window',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

const WINDOW_ORDER: ReadonlyArray<keyof UsageWindowsResponse['usageWindows']> = ['five_hour', 'weekly', 'monthly']

export const UsageOverlay = memo(function UsageOverlay({ isVisible, onClose, apiKey }: UsageOverlayProps) {
  const theme = useTheme()
  const [data, setData] = useState<UsageWindowsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingTick, setLoadingTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)

  useEffect(() => {
    if (!isVisible || !apiKey) return
    let cancelled = false
    setError(null)
    setData(null)
    setLoadingTick(t => t + 1)
    fetchUsageWindows(apiKey)
      .then(res => {
        if (cancelled) return
        setData(res)
        setFetchedAt(Date.now())
      })
      .catch(err => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err: msg }, 'Failed to fetch usage')
        setError(msg)
      })
    return () => { cancelled = true }
  }, [isVisible, apiKey])

  useEffect(() => {
    if (!isVisible) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isVisible])

  useKeyboard(useCallback((key: KeyEvent) => {
    if (!isVisible) return
    if (key.name === 'escape') {
      key.preventDefault()
      onClose()
    }
  }, [isVisible, onClose]))

  if (!isVisible) return null

  const elapsedSinceFetch = fetchedAt != null ? now - fetchedAt : 0

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <box style={{ flexDirection: 'row', paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.primary, flexGrow: 1 }}>
          <span attributes={TextAttributes.BOLD}>Usage</span>
        </text>
        <text style={{ fg: theme.muted }}>
          <span attributes={TextAttributes.DIM}>Esc to close</span>
        </text>
      </box>

      {/* Divider */}
      <box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.border }}>{'─'.repeat(60)}</text>
      </box>

      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, flexDirection: 'column', flexGrow: 1 }}>
        {error && (
          <text style={{ fg: theme.error }}>Failed to load usage: {error}</text>
        )}
        {!error && !data && (
          <text style={{ fg: theme.muted }}>
            <span attributes={TextAttributes.DIM}>Loading{'.'.repeat((loadingTick % 3) + 1)}</span>
          </text>
        )}
        {!error && data && WINDOW_ORDER.map(key => {
          const w = data.usageWindows[key]
          const pct = w.limitCents > 0 ? Math.min(1, w.usedCents / w.limitCents) : 0
          const pctLabel = Math.round(pct * 100)
          const remaining = Math.max(0, w.remainingMs - elapsedSinceFetch)
          return (
            <box key={key} style={{ flexDirection: 'column', paddingBottom: 2 }}>
              <text style={{ fg: theme.foreground }}>
                <span attributes={TextAttributes.BOLD}>{WINDOW_LABELS[key]}</span>
              </text>
              <box style={{ flexDirection: 'row' }}>
                <ProgressBar value={pct} width={40} />
                <text style={{ fg: theme.muted }}>{'  '}</text>
                <text style={{ fg: theme.foreground }}>{pctLabel}% used</text>
              </box>
              <text style={{ fg: theme.muted }}>
                <span attributes={TextAttributes.DIM}>Resets in {formatRemaining(remaining)}</span>
              </text>
            </box>
          )
        })}
      </box>
    </box>
  )
})

export type { UsageOverlayProps }
