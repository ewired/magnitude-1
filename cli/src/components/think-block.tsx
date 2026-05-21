import { memo, useEffect, useRef, useState } from 'react'
import { TextAttributes } from '@opentui/core'
import type { ThinkBlockMessage, ThinkBlockStep, DisplayMessage, ToolKey } from '@magnitudedev/agent'
import { Button } from './button'
import { AgentCommunicationCard } from './agent-communication-card'
import { useTheme } from '../hooks/use-theme'
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
// Cluster summary — consolidated line for groupable tools in default mode
// =============================================================================

function ClusterSummaryRow({ cluster, steps }: { cluster: string; steps: Extract<ThinkBlockStep, { type: 'tool' }>[] }) {
  const theme = useTheme()

  switch (cluster) {
    case 'read': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean)
      const displayPaths = paths.slice(0, 3).join(', ')
      const suffix = paths.length > 3 ? ` +${paths.length - 3} more` : ''
      return <text><span style={{ fg: theme.info }}>{'→ '}</span><span style={{ fg: theme.foreground }}>{`Read ${steps.length} file${steps.length > 1 ? 's' : ''}`}</span>{displayPaths && <span style={{ fg: theme.muted }}>{` (${displayPaths}${suffix})`}</span>}</text>
    }
    case 'search': {
      const totalMatches = steps.reduce((sum, s) => sum + ((s.state as any)?.matchCount ?? 0), 0)
      const uniqueFiles = new Set(steps.flatMap(s => ((s.state as any)?.matches ?? []) as any[]).map((m: any) => m?.file)).size
      const pattern = (steps[0].state as any)?.pattern ?? (steps[0].state as any)?.query
      return <text><span style={{ fg: theme.info }}>{'/ '}</span><span style={{ fg: theme.foreground }}>{`${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${uniqueFiles} file${uniqueFiles !== 1 ? 's' : ''}`}</span>{pattern && <span style={{ fg: theme.muted }}>{` (pattern: "${String(pattern).slice(0, 40)}")`}</span>}</text>
    }
    case 'web_search': {
      const totalSources = steps.reduce((sum, s) => sum + ((s.state as any)?.sources?.length ?? 0), 0)
      const query = (steps[0].state as any)?.query ?? ''
      return <text><span style={{ fg: theme.info }}>{'[⌕] '}</span><span style={{ fg: theme.foreground }}>{`Web searched ${totalSources} source${totalSources !== 1 ? 's' : ''}`}</span>{query && <span style={{ fg: theme.muted }}>{` ("${String(query).slice(0, 40)}")`}</span>}</text>
    }
    case 'web_fetch': {
      const urls = steps.map(s => (s.state as any)?.url).filter(Boolean)
      return <text><span style={{ fg: theme.info }}>{'[↓] '}</span><span style={{ fg: theme.foreground }}>{`Fetched ${urls.length} URL${urls.length > 1 ? 's' : ''}`}</span>{urls.length === 1 && <span style={{ fg: theme.muted }}>{` (${String(urls[0]).slice(0, 50)})`}</span>}</text>
    }
    case 'tree': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean)
      return <text><span style={{ fg: theme.info }}>{'◫ '}</span><span style={{ fg: theme.foreground }}>{`Listed files`}</span>{paths.length > 0 && <span style={{ fg: theme.muted }}>{` (${paths.join(', ')})`}</span>}</text>
    }
    case 'view': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean)
      return <text><span style={{ fg: theme.info }}>{'⚲ '}</span><span style={{ fg: theme.foreground }}>{`Viewed ${steps.length} file${steps.length > 1 ? 's' : ''}`}</span>{paths.length > 0 && <span style={{ fg: theme.muted }}>{` (${paths.join(', ')})`}</span>}</text>
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
}: {
  group: StepGroup
  mode: 'default' | 'transcript'
  onFileClick?: (path: string, section?: string) => void
  isActive?: boolean
  isInterrupted?: boolean
  lastThinkingStepId?: string
}) {
  const theme = useTheme()

  // In default mode, consolidate groupable tool clusters into summary lines
  if (mode === 'default' && group.cluster && group.cluster !== '__subagent_lifecycle__') {
    const toolSteps = group.steps.filter((s): s is Extract<ThinkBlockStep, { type: 'tool' }> => s.type === 'tool')
    if (toolSteps.length > 0) {
      return <ClusterSummaryRow key={group.steps[0].id} cluster={group.cluster!} steps={toolSteps} />
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

  return (
    <box style={{ marginBottom: 1, flexDirection: 'column' }}>
      {/* No header — WorkingTimer at the bottom handles all timing/summary */}

      {/* Content — cluster-grouped, registry-driven rendering */}
      <box style={{ flexDirection: 'column' }}>
        {visibleGroups.map((group, gi) => {
          // Add marginTop when a tool group follows a thinking group (or any previous group with thinking)
          // Consecutive tool groups don't need space between them
          const prevGroup = gi > 0 ? visibleGroups[gi - 1] : null
          const prevHadThinking = prevGroup != null && prevGroup.steps.some(s => s.type === 'thinking')
          const currentHasTool = group.steps.some(s => s.type === 'tool' || s.type === 'subagent_started')
          // Add spacing after shell groups (shell to shell, or shell to non-shell)
          const isShellGroup = group.steps.some(s => s.type === 'tool' && s.toolKey === 'shell')
          const prevIsShellGroup = prevGroup != null && prevGroup.steps.some(s => s.type === 'tool' && s.toolKey === 'shell')
          const hasShellSpacing = (isShellGroup || prevIsShellGroup) && prevGroup != null
          const hasMarginTop = (prevHadThinking && currentHasTool) || hasShellSpacing

          return (
            <ClusterContainer key={gi} cluster={group.cluster} hasMarginTop={hasMarginTop}>
              <StepGroupView
                group={group}
                mode={mode}
                onFileClick={onFileClick}
                isActive={isActive}
                isInterrupted={isInterrupted}
                lastThinkingStepId={lastStepId}
              />
            </ClusterContainer>
          )
        })}
      </box>
    </box>
  )
})
