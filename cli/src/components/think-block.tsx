import { memo, useEffect, useRef, useState } from 'react'
import { TextAttributes } from '@opentui/core'
import stringWidth from 'string-width'
import type { ThinkBlockMessage, ThinkBlockStep, DisplayMessage, ToolKey } from '@magnitudedev/agent'
import { Button } from './button'
import { AgentCommunicationCard } from './agent-communication-card'
import { useTheme } from '../hooks/use-theme'
import { useLocalWidth } from '../hooks/use-local-width'
import { violet } from '../utils/theme'

import { renderToolStep } from '../tool-displays/render'





type AgentCommunicationMessage = Extract<DisplayMessage, { type: 'agent_communication' }>

interface ThinkBlockProps {
  block: ThinkBlockMessage
  mode: 'default' | 'transcript'
  onFileClick?: (path: string, section?: string) => void
  isInterrupted?: boolean
}

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

const WorkerStartedRow = ({ step }: { step: Extract<ThinkBlockStep, { type: 'subagent_started' }> }) => {
  const theme = useTheme()
  return (
    <text>
      <span style={{ fg: violet[300] }}>▶ </span>
      <span style={{ fg: theme.muted }}>Worker </span>
      <span style={{ fg: theme.foreground }}>{step.subagentId}</span>
      <span style={{ fg: theme.muted }}> started</span>
      <span style={{ fg: theme.muted }}> · {step.subagentType}</span>
    </text>
  )
}

const StatusIndicatorRow = ({ step }: { step: Extract<ThinkBlockStep, { type: 'status_indicator' }> }) => {
  const theme = useTheme()
  return (
    <text attributes={TextAttributes.DIM}>
      <span style={{ fg: theme.muted }}>{step.message}</span>
    </text>
  )
}

// =============================================================================
// Cluster-based step grouping
// =============================================================================

interface StepGroup {
  /** Cluster key from the visual definition, or null for thinking/unregistered tools */
  cluster: string | null
  steps: ThinkBlockStep[]
}

/**
 * Group consecutive steps by visual cluster.
 * Consecutive tool steps with the same non-null cluster share a group.
 * Thinking steps and tools without a cluster get their own singleton group.
 */
function groupByCluster(steps: readonly ThinkBlockStep[]): StepGroup[] {
  const groups: StepGroup[] = []
  for (const step of steps) {
    const cluster = step.type === 'tool' ? (step.cluster ?? null) : null
    const syntheticCluster = step.type === 'subagent_started' || step.type === 'subagent_finished' || step.type === 'subagent_killed' || step.type === 'subagent_user_killed'
      ? '__subagent_lifecycle__'
      : cluster
    const last = groups[groups.length - 1]
    if (last && syntheticCluster !== null && last.cluster === syntheticCluster) {
      last.steps.push(step)
    } else {
      groups.push({ cluster: syntheticCluster, steps: [step] })
    }
  }
  return groups
}

// =============================================================================
// Step rendering — direct display dispatch
// =============================================================================

const ToolStepView = memo(function ToolStepView({
  step,
  mode,
  onFileClick,
}: {
  step: Extract<ThinkBlockStep, { type: 'tool' }>
  mode: 'default' | 'transcript'
  onFileClick?: (name: string, section?: string) => void
}) {
  const theme = useTheme()
  if (step.state) {
    return <>{renderToolStep(step.toolKey, step.state, {
      mode,
      onFileClick: onFileClick ?? (() => {}),
    })}</>
  }

  return (
    <text>
      <span style={{ fg: theme.warning }}>{step.toolKey}</span>
    </text>
  )
})

const THINKING_FADE_WINDOW = 15
const THINKING_TICK_MS = 33
const THINKING_LINEAR_DRAIN = 8

const ThinkingStep = memo(function ThinkingStep({ content, label, isActive, isInterrupted }: { content: string; label?: string; isActive: boolean; isInterrupted?: boolean }) {
  const theme = useTheme()
  const [displayedLength, setDisplayedLength] = useState(content.length)
  const isLinearDrainRef = useRef(!isActive)

  useEffect(() => {
    if (isInterrupted || !isActive) setDisplayedLength(content.length)
  }, [isInterrupted, isActive, content.length])

  useEffect(() => {
    isLinearDrainRef.current = !isActive
  }, [isActive])

  useEffect(() => {
    if (!isActive && displayedLength >= content.length) return

    const interval = setInterval(() => {
      setDisplayedLength((prev) => {
        const target = content.length
        if (prev >= target) return prev
        if (isLinearDrainRef.current) {
          return Math.min(target, prev + THINKING_LINEAR_DRAIN)
        }
        const remaining = target - prev
        const speed = Math.max(1, Math.floor(remaining * 0.15))
        return Math.min(target, prev + speed)
      })
    }, THINKING_TICK_MS)

    return () => clearInterval(interval)
  }, [content.length, displayedLength, isActive])

  const displayed = content.slice(0, displayedLength)
  const isAnimating = displayedLength < content.length

  if (!isAnimating) {
    return (
      <text attributes={TextAttributes.ITALIC}>

        <span style={{ fg: theme.muted }}>{displayed}</span>
      </text>
    )
  }

  const fadeWindowStart = Math.max(0, displayedLength - THINKING_FADE_WINDOW)
  const settled = displayed.slice(0, fadeWindowStart)
  const fading = displayed.slice(fadeWindowStart)

  return (
    <text attributes={TextAttributes.ITALIC}>
      <span style={{ fg: theme.muted }}>{settled}</span>
      <span style={{ fg: theme.border }} attributes={TextAttributes.DIM}>
        {fading}
      </span>
    </text>
  )
})

// =============================================================================
// Cluster container styling
// =============================================================================

function ClusterContainer({
  cluster,
  hasMarginTop,
  children,
}: {
  cluster: string | null
  hasMarginTop: boolean
  children: React.ReactNode
}) {
  const theme = useTheme()

  return (
    <box
      style={{
        flexDirection: 'column',
        marginTop: hasMarginTop ? 1 : 0,
        ...(cluster === 'shell'
          ? {
              backgroundColor: theme.terminalBg,
              paddingRight: 1,
            }
          : {}),
      }}
    >
      {children}
    </box>
  )
}

// =============================================================================
// Width-aware item fitting
// =============================================================================

/**
 * Fit a list of display items into a maximum width, truncating items and
 * dropping items as needed. Always reserves room for "+N more" suffix when
 * items are dropped.
 *
 * Returns the items to show (potentially truncated with …) and the count of
 * items that were dropped.
 */
function fitItems(items: string[], maxWidth: number): { shown: string[]; remaining: number } {
  if (items.length === 0) return { shown: [], remaining: 0 }

  const MIN_ITEM_WIDTH = 4 // minimum width to show anything useful (e.g. "a…")
  const shown: string[] = []
  let used = 0
  let i = 0

  while (i < items.length) {
    const item = items[i]
    const itemWidth = stringWidth(item)
    // Separator width: ", " between items
    const sepWidth = shown.length > 0 ? 2 : 0
    // Reserve space for "+N more" if there are items after this one
    const suffixWidth = i < items.length - 1 ? stringWidth(` +${items.length - i - 1} more`) : 0
    const available = maxWidth - used - sepWidth - suffixWidth

    if (available < MIN_ITEM_WIDTH) break

    if (itemWidth <= available) {
      shown.push(item)
      used += sepWidth + itemWidth
      i++
    } else {
      // Truncate with … to fit
      const truncated = truncateToWidth(item, available)
      shown.push(truncated)
      used += sepWidth + stringWidth(truncated)
      i++
      // Continue — there may still be room for shorter items after a truncated one
    }
  }

  return { shown, remaining: items.length - i }
}

/**
 * Truncate a string to fit within `maxWidth` columns, appending …
 */
function truncateToWidth(s: string, maxWidth: number): string {
  const w = stringWidth(s)
  if (w <= maxWidth) return s
  if (maxWidth <= 1) return '…'
  // Binary search for the truncation point
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (stringWidth(s.slice(0, mid) + '…') <= maxWidth) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return s.slice(0, lo) + '…'
}

// =============================================================================
// Cluster summary — consolidated line for groupable tools in default mode
// =============================================================================

function ClusterSummaryRow({ cluster, steps, width }: { cluster: string; steps: Extract<ThinkBlockStep, { type: 'tool' }>[]; width: number }) {
  const theme = useTheme()

  switch (cluster) {
    case 'read': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean) as string[]
      const prefix = `→ Read ${steps.length} file${steps.length > 1 ? 's' : ''}`
      const prefixWidth = stringWidth(prefix)
      const detailWidth = width - prefixWidth - 2 // 2 for parens
      const { shown, remaining } = detailWidth > 0 ? fitItems(paths, detailWidth) : { shown: [], remaining: paths.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'→ '}</span><span style={{ fg: theme.foreground }}>{`Read ${steps.length} file${steps.length > 1 ? 's' : ''}`}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'search': {
      const totalMatches = steps.reduce((sum, s) => sum + ((s.state as any)?.matchCount ?? 0), 0)
      const uniqueFiles = new Set(steps.flatMap(s => ((s.state as any)?.matches ?? []) as any[]).map((m: any) => m?.file)).size
      const patterns = steps.map(s => (s.state as any)?.pattern ?? (s.state as any)?.query).filter(Boolean) as string[]
      const label = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${uniqueFiles} file${uniqueFiles !== 1 ? 's' : ''}`
      const labelWidth = stringWidth('/ ') + stringWidth(label)
      const detailWidth = width - labelWidth - 2
      const quotedPatterns = patterns.map(p => `"${p}"`)
      const { shown, remaining } = detailWidth > 0 ? fitItems(quotedPatterns, detailWidth) : { shown: [], remaining: patterns.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'/ '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (pattern: ${detail})`}</span>}</text>
    }
    case 'web_search': {
      const totalSources = steps.reduce((sum, s) => sum + ((s.state as any)?.sources?.length ?? 0), 0)
      const queries = steps.map(s => (s.state as any)?.query).filter(Boolean) as string[]
      const count = steps.length
      const label = `${count} web search${count !== 1 ? 'es' : ''}, ${totalSources} total source${totalSources !== 1 ? 's' : ''}`
      const labelWidth = stringWidth('[⌕] ') + stringWidth(label)
      const detailWidth = width - labelWidth - 2
      const quotedQueries = queries.map(q => `"${q}"`)
      const { shown, remaining } = detailWidth > 0 ? fitItems(quotedQueries, detailWidth) : { shown: [], remaining: queries.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'[⌕] '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'web_fetch': {
      const urls = steps.map(s => (s.state as any)?.url).filter(Boolean) as string[]
      const label = `Fetched ${urls.length} URL${urls.length > 1 ? 's' : ''}`
      const labelWidth = stringWidth('[↓] ') + stringWidth(label)
      const detailWidth = width - labelWidth - 2
      const { shown, remaining } = detailWidth > 0 ? fitItems(urls, detailWidth) : { shown: [], remaining: urls.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'[↓] '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'tree': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean) as string[]
      const label = `Listed files`
      const labelWidth = stringWidth('◫ ') + stringWidth(label)
      const detailWidth = width - labelWidth - 2
      const { shown, remaining } = detailWidth > 0 ? fitItems(paths, detailWidth) : { shown: [], remaining: paths.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'◫ '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'view': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean) as string[]
      const label = `Viewed ${steps.length} file${steps.length > 1 ? 's' : ''}`
      const labelWidth = stringWidth('⚲ ') + stringWidth(label)
      const detailWidth = width - labelWidth - 2
      const { shown, remaining } = detailWidth > 0 ? fitItems(paths, detailWidth) : { shown: [], remaining: paths.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'⚲ '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    default:
      return null
  }
}

// =============================================================================
// Group rendering — cluster renderer or per-step fallback
// =============================================================================

const StepGroupView = memo(function StepGroupView({
  group,
  mode,
  onFileClick,
  isActive,
  isInterrupted,
  lastThinkingStepId,
  width,
}: {
  group: StepGroup
  mode: 'default' | 'transcript'
  onFileClick?: (path: string, section?: string) => void
  isActive?: boolean
  isInterrupted?: boolean
  lastThinkingStepId?: string
  width: number
}) {
  const theme = useTheme()

  // In default mode, consolidate groupable tool clusters into summary lines
  if (mode === 'default' && group.cluster && group.cluster !== '__subagent_lifecycle__') {
    const toolSteps = group.steps.filter((s): s is Extract<ThinkBlockStep, { type: 'tool' }> => s.type === 'tool')
    if (toolSteps.length > 0) {
      return <ClusterSummaryRow key={group.steps[0].id} cluster={group.cluster!} steps={toolSteps} width={width} />
    }
    return null
  }

  return (
    <>
      {group.steps.map((step) => {
        if (step.type === 'thinking') {
          // Hide thinking in default mode
          if (mode === 'default') return null
          const isLastThinkingStep = step.id === lastThinkingStepId
          return (
            <box key={step.id}>
              <ThinkingStep content={step.content ?? ''} label={step.label} isActive={(isActive ?? false) && isLastThinkingStep} isInterrupted={isInterrupted} />
            </box>
          )
        }

        if (step.type === 'subagent_started') {
          return <WorkerStartedRow key={step.id} step={step} />
        }

        if (step.type === 'subagent_finished') {
          return null
        }

        if (step.type === 'subagent_killed' || step.type === 'subagent_user_killed') {
          return null
        }

        if (step.type === 'communication') {
          // Never show from_agent comms; only show to_agent in transcript mode
          if (step.direction === 'from_agent' || mode === 'default') return null
          const message: AgentCommunicationMessage = {
            id: step.id,
            type: 'agent_communication',
            direction: step.direction,
            agentId: step.agentId,
            agentName: step.agentName,
            agentRole: step.agentRole,
            forkId: step.forkId ?? null,
            content: step.content,
            preview: step.preview || step.content,
            timestamp: step.timestamp,
          }

          return <AgentCommunicationCard key={step.id} message={message} widthAdjustment={2} onFileClick={onFileClick} />
        }

        if (step.type === 'status_indicator') {
          return <StatusIndicatorRow key={step.id} step={step} />
        }

        if (step.type !== 'tool') return null

        return (
          <ToolStepView
            key={step.id}
            step={step}
            mode={mode}
            onFileClick={onFileClick}
          />
        )
      })}
    </>
  )
})

// =============================================================================
// Sticky Working Header
// =============================================================================


// =============================================================================
// ThinkBlock
// =============================================================================

export const ThinkBlock = memo(function ThinkBlock({
  block,
  mode,
  onFileClick,
  isInterrupted
}: ThinkBlockProps) {
  const theme = useTheme()
  const isActive = block.status === 'active'
  const localWidth = useLocalWidth()

  // Group steps by visual cluster
  const groups = groupByCluster(block.steps)
  const lastStepId = block.steps.length > 0 ? block.steps[block.steps.length - 1].id : undefined

  // In default mode, filter out groups with no visible content
  // (thinking, comms, status indicators render as null but still occupy container space)
  const visibleGroups = mode === 'default'
    ? groups.filter(group => group.steps.some(step => {
        if (step.type === 'thinking' || step.type === 'communication' || step.type === 'status_indicator' || step.type === 'subagent_finished' || step.type === 'subagent_killed' || step.type === 'subagent_user_killed') return false
        return true // tools, subagent_started are visible
      }))
    : groups

  // In default mode, hide the entire ThinkBlock if there are no visible groups
  if (mode === 'default' && visibleGroups.length === 0) return null

  // Use measured width, fall back to 80 if not yet measured
  const contentWidth = localWidth.width ?? 80

  return (
    <box ref={localWidth.ref} onSizeChange={localWidth.onSizeChange} style={{ marginBottom: 1, flexDirection: 'column' }}>
      {/* No header — WorkingTimer at the bottom handles all timing/summary */}

      {/* Content — cluster-grouped, registry-driven rendering */}
      <box style={{ flexDirection: 'column' }}>
        {visibleGroups.map((group, gi) => {
          // Add marginTop when a tool group follows a thinking group (or any previous group with thinking)
          // Consecutive tool groups don't need space between them
          const prevGroup = gi > 0 ? visibleGroups[gi - 1] : null
          const prevHadThinking = prevGroup != null && prevGroup.steps.some(s => s.type === 'thinking')
          const currentHasTool = group.steps.some(s => s.type === 'tool' || s.type === 'subagent_started')
          // Add spacing between block-level tool groups (shell, edit, write)
          const BLOCK_TOOLS = new Set(['shell', 'fileEdit', 'fileWrite'])
          const isBlockGroup = group.steps.some(s => s.type === 'tool' && BLOCK_TOOLS.has(s.toolKey))
          const prevIsBlockGroup = prevGroup != null && prevGroup.steps.some(s => s.type === 'tool' && BLOCK_TOOLS.has(s.toolKey))
          const hasBlockSpacing = (isBlockGroup || prevIsBlockGroup) && prevGroup != null
          const prevHadTool = prevGroup != null && prevGroup.steps.some(s => s.type === 'tool' || s.type === 'subagent_started')
          const currentHasThinking = group.steps.some(s => s.type === 'thinking')
          const hasMarginTop = (prevHadThinking && currentHasTool) || hasBlockSpacing || (prevHadTool && currentHasThinking)

          return (
            <ClusterContainer key={gi} cluster={group.cluster} hasMarginTop={hasMarginTop}>
              <StepGroupView
                group={group}
                mode={mode}
                onFileClick={onFileClick}
                isActive={isActive}
                isInterrupted={isInterrupted}
                lastThinkingStepId={lastStepId}
                width={contentWidth}
              />
            </ClusterContainer>
          )
        })}
      </box>
    </box>
  )
})
