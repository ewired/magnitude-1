import { memo, useCallback, useState } from 'react'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useTheme } from '../hooks/use-theme'
import { Button } from './button'
import { SingleLineInput } from './single-line-input'
import type { MagnitudeAuthState } from '../hooks/use-magnitude-auth'

interface SettingsOverlayProps {
  isVisible: boolean
  onClose: () => void
  auth: MagnitudeAuthState
  roles: ReadonlyArray<{
    id: string
    description: string
    model: string
  }>
}

type Mode = 'view' | 'edit' | 'confirm-disconnect'

function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 12) return '•'.repeat(Math.max(trimmed.length, 4))

  // Magnitude keys look like `mg_sk_<hex>`. Show the full prefix (through the
  // last underscore) plus the first 4 chars of the secret, then the last 4.
  // For non-prefixed keys, fall back to first 6 + last 4.
  const lastUnderscore = trimmed.lastIndexOf('_')
  const head = lastUnderscore >= 0 && lastUnderscore < trimmed.length - 8
    ? trimmed.slice(0, lastUnderscore + 1 + 4)
    : trimmed.slice(0, 6)
  const tail = trimmed.slice(-4)
  return `${head}………${tail}`
}

export const SettingsOverlay = memo(function SettingsOverlay({
  isVisible,
  onClose,
  auth,
  roles,
}: SettingsOverlayProps) {
  const theme = useTheme()
  const [mode, setMode] = useState<Mode>('view')
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [updateHovered, setUpdateHovered] = useState(false)
  const [disconnectHovered, setDisconnectHovered] = useState(false)
  const [saveHovered, setSaveHovered] = useState(false)
  const [cancelHovered, setCancelHovered] = useState(false)
  const [confirmHovered, setConfirmHovered] = useState(false)

  const beginEdit = useCallback(() => {
    setInputValue('')
    setError(null)
    setMode('edit')
  }, [])

  const beginDisconnect = useCallback(() => {
    setError(null)
    setMode('confirm-disconnect')
  }, [])

  const cancelInline = useCallback(() => {
    setInputValue('')
    setError(null)
    setMode('view')
  }, [])

  const handleSave = useCallback(async () => {
    if (submitting) return
    const trimmed = inputValue.trim()
    if (!trimmed) {
      setError('API key is required')
      return
    }
    setSubmitting(true)
    try {
      await auth.save(trimmed)
      setInputValue('')
      setMode('view')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key')
    } finally {
      setSubmitting(false)
    }
  }, [auth, inputValue, submitting])

  const handleConfirmDisconnect = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await auth.clear()
      setMode('view')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    } finally {
      setSubmitting(false)
    }
  }, [auth, submitting])

  useKeyboard(useCallback((key: KeyEvent) => {
    if (!isVisible) return
    if (key.name === 'escape') {
      key.preventDefault()
      if (mode === 'edit' || mode === 'confirm-disconnect') {
        cancelInline()
        return
      }
      onClose()
      return
    }
    if (mode === 'edit' && (key.name === 'return' || key.name === 'enter') && !key.shift) {
      key.preventDefault()
      handleSave()
    }
  }, [isVisible, mode, onClose, cancelInline, handleSave]))

  if (!isVisible) return null

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
          <span attributes={TextAttributes.BOLD}>Settings</span>
        </text>
        <text style={{ fg: theme.muted }}>
          <span attributes={TextAttributes.DIM}>Esc to close</span>
        </text>
      </box>

      {/* Divider */}
      <box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.border }}>
          {'─'.repeat(60)}
        </text>
      </box>

      {/* Magnitude section */}
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.foreground }}>
          <span attributes={TextAttributes.BOLD}>Magnitude</span>
        </text>
      </box>

      {/* Status / inline controls */}
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingBottom: 1, flexShrink: 0, flexDirection: 'column' }}>
        {mode === 'view' && (auth.source === 'env' || auth.source === 'env-local') && (
          <>
            <box style={{ flexDirection: 'row' }}>
              <text style={{ fg: theme.success }}>{'● Connected '}</text>
              <text style={{ fg: theme.muted }}>
                {`via ${auth.envVarName} `}
              </text>
              {auth.key && (
                <text style={{ fg: theme.foreground }}>
                  <span attributes={TextAttributes.DIM}>{`(${maskApiKey(auth.key)})`}</span>
                </text>
              )}
            </box>
            <text style={{ fg: theme.muted }}>
              <span attributes={TextAttributes.DIM}>
                To change this key, update the env var and relaunch.
              </span>
            </text>
          </>
        )}

        {mode === 'view' && auth.source === 'config' && (
          <box style={{ flexDirection: 'column' }}>
            <box style={{ flexDirection: 'row' }}>
              <text style={{ fg: theme.success }}>{'● Connected '}</text>
              {auth.key && (
                <text style={{ fg: theme.foreground }}>
                  <span attributes={TextAttributes.DIM}>{`(${maskApiKey(auth.key)})`}</span>
                </text>
              )}
            </box>
            <box style={{ flexDirection: 'row', paddingTop: 1 }}>
              <Button
                onClick={beginEdit}
                onMouseOver={() => setUpdateHovered(true)}
                onMouseOut={() => setUpdateHovered(false)}
              >
                <text style={{ fg: updateHovered ? theme.foreground : theme.muted }}>
                  {'[Update key]'}
                </text>
              </Button>
              <text> </text>
              <Button
                onClick={beginDisconnect}
                onMouseOver={() => setDisconnectHovered(true)}
                onMouseOut={() => setDisconnectHovered(false)}
              >
                <text style={{ fg: disconnectHovered ? theme.foreground : theme.muted }}>
                  {'[Disconnect]'}
                </text>
              </Button>
            </box>
          </box>
        )}

        {mode === 'view' && auth.source === 'none' && (
          <box style={{ flexDirection: 'row' }}>
            <text style={{ fg: theme.muted }}>{'○ Not connected '}</text>
            <text style={{ fg: theme.muted }}>{'· '}</text>
            <Button
              onClick={beginEdit}
              onMouseOver={() => setUpdateHovered(true)}
              onMouseOut={() => setUpdateHovered(false)}
            >
              <text style={{ fg: updateHovered ? theme.foreground : theme.muted }}>
                {'[Set API key]'}
              </text>
            </Button>
          </box>
        )}

        {mode === 'edit' && (
          <box style={{ flexDirection: 'column' }}>
            <box style={{
              borderStyle: 'single',
              borderColor: error ? theme.error : theme.primary,
              paddingLeft: 1,
              paddingRight: 1,
              flexShrink: 0,
              width: 80,
            }}>
              <SingleLineInput
                value={inputValue}
                onChange={(v) => {
                  setInputValue(v)
                  setError(null)
                }}
                placeholder="Paste new API key"
                focused={true}
              />
            </box>
            {error && (
              <box style={{ paddingTop: 1 }}>
                <text style={{ fg: theme.error }}>{error}</text>
              </box>
            )}
            <box style={{ flexDirection: 'row', paddingTop: 1 }}>
              <Button
                onClick={handleSave}
                onMouseOver={() => setSaveHovered(true)}
                onMouseOut={() => setSaveHovered(false)}
              >
                <text style={{ fg: saveHovered ? theme.primary : theme.foreground }}>
                  {submitting ? '[Saving...]' : '[Save]'}
                </text>
              </Button>
              <text> </text>
              <Button
                onClick={cancelInline}
                onMouseOver={() => setCancelHovered(true)}
                onMouseOut={() => setCancelHovered(false)}
              >
                <text style={{ fg: cancelHovered ? theme.foreground : theme.muted }}>
                  {'[Cancel]'}
                </text>
              </Button>
            </box>
            <box style={{ paddingTop: 1 }}>
              <text style={{ fg: theme.muted }}>
                <span attributes={TextAttributes.DIM}>Enter to save, Esc to cancel</span>
              </text>
            </box>
          </box>
        )}

        {mode === 'confirm-disconnect' && (
          <box style={{ flexDirection: 'column' }}>
            <text style={{ fg: theme.foreground }}>
              Disconnect this key? You will need to set another to reconnect.
            </text>
            <box style={{ flexDirection: 'row', paddingTop: 1 }}>
              <Button
                onClick={handleConfirmDisconnect}
                onMouseOver={() => setConfirmHovered(true)}
                onMouseOut={() => setConfirmHovered(false)}
              >
                <text style={{ fg: confirmHovered ? theme.error : theme.foreground }}>
                  {submitting ? '[Disconnecting...]' : '[Yes, disconnect]'}
                </text>
              </Button>
              <text> </text>
              <Button
                onClick={cancelInline}
                onMouseOver={() => setCancelHovered(true)}
                onMouseOut={() => setCancelHovered(false)}
              >
                <text style={{ fg: cancelHovered ? theme.foreground : theme.muted }}>
                  {'[Cancel]'}
                </text>
              </Button>
            </box>
            {error && (
              <box style={{ paddingTop: 1 }}>
                <text style={{ fg: theme.error }}>{error}</text>
              </box>
            )}
          </box>
        )}
      </box>

      {/* Divider */}
      <box style={{ paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.border }}>
          {'─'.repeat(60)}
        </text>
      </box>

      {/* Roles */}
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.foreground }}>
          <span attributes={TextAttributes.BOLD}>Roles</span>
        </text>
      </box>

      <scrollbox
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{
          visible: true,
          trackOptions: { width: 1 },
        }}
        style={{
          flexGrow: 1,
          rootOptions: { flexGrow: 1, backgroundColor: 'transparent' },
          wrapperOptions: { border: false, backgroundColor: 'transparent' },
          contentOptions: { paddingLeft: 2, paddingRight: 2 },
        }}
      >
        {roles.map((role) => (
          <box key={role.id} style={{ flexDirection: 'column', paddingBottom: 1 }}>
            <text style={{ fg: theme.primary }}>
              <span attributes={TextAttributes.BOLD}>{role.id}</span>
              <span style={{ fg: theme.muted }}>{', '}{role.description}</span>
            </text>
            <text style={{ fg: theme.muted }}>
              <span attributes={TextAttributes.DIM}>{'  '}{role.model}</span>
            </text>
          </box>
        ))}
      </scrollbox>
    </box>
  )
})

export type { SettingsOverlayProps }
