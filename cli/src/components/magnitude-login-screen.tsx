import { memo, useState, useCallback, useEffect, useRef } from 'react'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useTheme } from '../hooks/use-theme'
import { Button } from './button'
import { SingleLineInput } from './single-line-input'
import { BOX_CHARS } from '../utils/ui-constants'
import { writeTextToClipboard } from '../utils/clipboard'

const MAGNITUDE_URL = 'https://app.magnitude.dev'

function useCopyFeedback() {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const showCopied = useCallback(() => {
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 2000)
  }, [])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  return { copied, showCopied }
}

interface MagnitudeLoginScreenProps {
  onSubmit: (key: string) => Promise<void> | void
  onExit: () => void
}

export const MagnitudeLoginScreen = memo(function MagnitudeLoginScreen({
  onSubmit,
  onExit,
}: MagnitudeLoginScreenProps) {
  const theme = useTheme()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [continueHovered, setContinueHovered] = useState(false)
  const [copyHovered, setCopyHovered] = useState(false)
  const urlCopy = useCopyFeedback()

  const handleSubmit = useCallback(async () => {
    if (submitting) return
    const trimmed = apiKey.trim()
    if (!trimmed) {
      setError('API key is required')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key')
      setSubmitting(false)
    }
  }, [apiKey, onSubmit, submitting])

  useKeyboard(useCallback((key: KeyEvent) => {
    if (key.name === 'escape') {
      key.preventDefault()
      onExit()
      return
    }
    if ((key.name === 'return' || key.name === 'enter') && !key.shift) {
      key.preventDefault()
      handleSubmit()
      return
    }
  }, [onExit, handleSubmit]))

  return (
    <box style={{ flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <box style={{
        flexDirection: 'row',
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
      }}>
        <text style={{ fg: theme.primary, flexGrow: 1 }}>
          <span attributes={TextAttributes.BOLD}>Welcome to Magnitude</span>
        </text>
      </box>

      {/* Divider */}
      <box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.border }}>{'─'.repeat(80)}</text>
      </box>

      {/* Body */}
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, flexGrow: 1, flexDirection: 'column' }}>
        <box style={{ paddingBottom: 1 }}>
          <text style={{ fg: theme.foreground }}>Sign up to get a free API key. No card required.</text>
        </box>

        <box style={{ paddingBottom: 1 }}>
          <text style={{ fg: theme.muted }}>
            Includes $5 of free credits. Pass-through API pricing with no markup after that.
          </text>
        </box>

        <box style={{ paddingBottom: 1, flexDirection: 'row' }}>
          <text style={{ fg: theme.primary }}>{MAGNITUDE_URL}</text>
          <text> </text>
          <Button
            onClick={async () => {
              try {
                await writeTextToClipboard(MAGNITUDE_URL)
                urlCopy.showCopied()
              } catch {}
            }}
            onMouseOver={() => setCopyHovered(true)}
            onMouseOut={() => setCopyHovered(false)}
          >
            <text style={{ fg: urlCopy.copied ? theme.success : (copyHovered ? theme.foreground : theme.muted) }}>
              {urlCopy.copied ? '[Copied ✓]' : '[Copy link]'}
            </text>
          </Button>
        </box>

        <box style={{ paddingBottom: 1 }}>
          <text style={{ fg: theme.foreground }}>Then paste your API key below:</text>
        </box>

        {/* Input field */}
        <box style={{
          borderStyle: 'single',
          borderColor: error ? theme.error : theme.primary,
          paddingLeft: 1,
          paddingRight: 1,
          flexShrink: 0,
          width: 80,
        }}>
          <SingleLineInput
            value={apiKey}
            onChange={(v) => {
              setApiKey(v)
              setError(null)
            }}
            placeholder="Paste API key here"
            focused={true}
          />
        </box>

        {error && (
          <box style={{ paddingTop: 1 }}>
            <text style={{ fg: theme.error }}>{error}</text>
          </box>
        )}

        {/* Continue button */}
        <box style={{ paddingTop: 1, flexDirection: 'row', flexShrink: 0 }}>
          <Button
            onClick={handleSubmit}
            onMouseOver={() => setContinueHovered(true)}
            onMouseOut={() => setContinueHovered(false)}
          >
            <box style={{
              borderStyle: 'single',
              borderColor: continueHovered ? theme.primary : theme.border,
              customBorderChars: BOX_CHARS,
              paddingLeft: 1,
              paddingRight: 1,
            }}>
              <text style={{ fg: continueHovered ? theme.primary : theme.foreground }}>
                {submitting ? 'Saving...' : 'Continue (Enter)'}
              </text>
            </box>
          </Button>
        </box>

        {/* Env-var hint */}
        <box style={{ paddingTop: 2 }}>
          <text style={{ fg: theme.muted }}>
            <span attributes={TextAttributes.DIM}>
              Prefer environment variables? Press Esc to exit, set MAGNITUDE_API_KEY, then relaunch.
            </span>
          </text>
        </box>
      </box>
    </box>
  )
})

export type { MagnitudeLoginScreenProps }
