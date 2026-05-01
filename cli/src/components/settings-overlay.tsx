import { memo, useCallback } from 'react'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { useTheme } from '../hooks/use-theme'

interface SettingsOverlayProps {
  isVisible: boolean
  onClose: () => void
  connectionStatus: {
    connected: boolean
    mode: 'cloud' | 'local' | 'none'
  }
  roles: ReadonlyArray<{
    id: string
    description: string
    model: string
  }>
}

export const SettingsOverlay = memo(function SettingsOverlay({
  isVisible,
  onClose,
  connectionStatus,
  roles,
}: SettingsOverlayProps) {
  const theme = useTheme()

  useKeyboard(useCallback((key: KeyEvent) => {
    if (!isVisible) return
    if (key.name === 'escape') {
      key.preventDefault()
      onClose()
    }
  }, [isVisible, onClose]))

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

      {/* Connection status */}
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingTop: 1, flexShrink: 0 }}>
        <text style={{ fg: theme.foreground }}>
          <span attributes={TextAttributes.BOLD}>Magnitude</span>
        </text>
      </box>
      <box style={{ paddingLeft: 2, paddingRight: 2, paddingBottom: 1, flexShrink: 0 }}>
        {connectionStatus.connected ? (
          <text style={{ fg: theme.success }}>
            {'● Connected'}
            <span attributes={TextAttributes.DIM}>{` (${connectionStatus.mode})`}</span>
          </text>
        ) : (
          <text style={{ fg: theme.muted }}>
            {'○ Not connected — set MAGNITUDE_API_KEY'}
          </text>
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
              <span style={{ fg: theme.muted }}>{' — '}{role.description}</span>
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
