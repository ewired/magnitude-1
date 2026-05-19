import { memo, useState, useEffect } from 'react'
import { TextAttributes } from '@opentui/core'
import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { blue, slate } from '../utils/palette'

// Same pulse animation as subagent working state in task-list.tsx
const PULSE_BLUE_SHADES = [
  blue[50], blue[100], blue[200], blue[300], blue[400], blue[500], blue[600], blue[700], blue[800], blue[900],
  blue[800], blue[700], blue[600], blue[500], blue[400], blue[300], blue[200], blue[100], blue[50],
] as const

// Braille spinner frames (same as deleted workflow-phase-bar.tsx)
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface AutopilotIndicatorProps {
  enabled: boolean
  generating: boolean
  onToggle: () => void
}

export const AutopilotIndicator = memo(function AutopilotIndicator({
  enabled,
  generating,
  onToggle,
}: AutopilotIndicatorProps) {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Animate when enabled: spinner when generating, pulse otherwise
  useEffect(() => {
    if (!enabled) return
    const intervalMs = generating ? 80 : 200
    const interval = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(interval)
  }, [enabled, generating])

  const iconContent = generating
    ? SPINNER_FRAMES[Math.floor(now / 80) % SPINNER_FRAMES.length]
    : '●'

  const iconColor = generating
    ? theme.foreground
    : enabled
      ? PULSE_BLUE_SHADES[Math.floor(now / 200) % PULSE_BLUE_SHADES.length]
      : slate[600]

  const textColor = hovered ? theme.foreground : enabled ? theme.foreground : theme.muted
  const textAttributes = (!enabled && !hovered) ? TextAttributes.DIM : TextAttributes.NONE

  return (
    <Button
      onClick={onToggle}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      cursor="pointer"
    >
      <text style={{ fg: textColor }} attributes={textAttributes}>
        <span style={{ fg: iconColor }}>{iconContent + ' '}</span>
        {enabled ? 'Autopilot ON' : 'Autopilot OFF'}
      </text>
    </Button>
  )
})
