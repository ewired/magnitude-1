import type { ToolKey } from '@magnitudedev/agent'
import type { BaseState } from '@magnitudedev/harness'
import type { CommonToolProps, ToolDisplay } from './types'
import { createToolDisplay } from './types'
import { shellDisplay } from './displays/shell'
import { diffDisplay } from './displays/diff'
import { contentDisplay } from './displays/content'
import { fileSearchDisplay } from './displays/file-search'
import { fileTreeDisplay } from './displays/file-tree'
import { webSearchDisplay } from './displays/web-search'
import { webFetchDisplay } from './displays/web-fetch'
import { skillDisplay } from './displays/skill'
import { defaultDisplay } from './displays/default'
import { reassignWorkerDisplay } from './displays/reassign-worker'

import { useTheme } from '../hooks/use-theme'
import { violet } from '../utils/theme'

const MESSAGE_LINE_CAP = 300

/** Spawn worker display — invisible in default mode (shown as badge in WorkingTimer), renders in transcript mode */
const spawnWorkerDisplay = createToolDisplay<BaseState>({
  render: ({ state, mode }) => {
    if (mode === 'default') return null
    const theme = useTheme()
    const s = state as any
    const isCompleted = s.phase === 'completed'
    const isStreaming = s.phase === 'streaming' || s.phase === 'executing'
    const isError = s.phase === 'error' || s.phase === 'rejected' || s.phase === 'interrupted'
    const wordCount = s.message?.trim() ? s.message.trim().split(/\s+/).length : 0

    const message = s.message ?? ''
    const messageLines = message.split('\n')
    const isTruncated = messageLines.length > MESSAGE_LINE_CAP
    const visibleLines = isTruncated ? messageLines.slice(0, MESSAGE_LINE_CAP) : messageLines
    const truncatedCount = messageLines.length - MESSAGE_LINE_CAP

    return (
      <box style={{ flexDirection: 'column' }}>
        <text>
          <span style={{ fg: violet[300] }}>{'▶ '}</span>
          <span style={{ fg: theme.muted }}>{isCompleted ? 'Started worker ' : 'Starting worker '}</span>
          {s.agentId && <span style={{ fg: theme.foreground }}>{s.agentId}</span>}
          {isStreaming && wordCount > 0 && (
            <span style={{ fg: theme.muted }}>{` · ${wordCount} ${wordCount === 1 ? 'word' : 'words'}`}</span>
          )}
          {isError && <span style={{ fg: theme.error }}>{' · Error'}</span>}
        </text>
        {message && (
          <box style={{ borderStyle: 'single', border: ['left'], borderColor: theme.muted, paddingLeft: 1 }}>
            <text style={{ fg: theme.muted }}>
              {isTruncated
                ? [...visibleLines, `…${truncatedCount} lines hidden. Output capped at ${MESSAGE_LINE_CAP} lines`].join('\n')
                : visibleLines.join('\n')}
            </text>
          </box>
        )}
      </box>
    )
  },
  summary: (state) => {
    const s = state as any
    const id = s.agentId ? ` ${s.agentId}` : ''
    if (s.phase === 'completed') return `Started worker${id}`
    return `Starting worker${id}`
  },
})

/**
 * Wraps a typed ToolDisplay to accept BaseState.
 * Safe because the toolKey-based dispatch guarantees the correct state shape.
 */
function eraseStateType<T extends BaseState>(display: ToolDisplay<T>): ToolDisplay<BaseState> {
  return {
    render: (props) => display.render({ ...props, state: props.state as T }),
    summary: (state) => display.summary(state as T),
  }
}

const displaysByToolKey: Partial<Record<string, ToolDisplay<BaseState>>> = {
  shell: eraseStateType(shellDisplay),
  fileWrite: eraseStateType(contentDisplay),
  fileEdit: eraseStateType(diffDisplay),
  fileTree: eraseStateType(fileTreeDisplay),
  fileSearch: eraseStateType(fileSearchDisplay),
  webSearch: eraseStateType(webSearchDisplay),
  webFetch: eraseStateType(webFetchDisplay),
  skill: eraseStateType(skillDisplay),
  spawnWorker: eraseStateType(spawnWorkerDisplay),
  reassignWorker: eraseStateType(reassignWorkerDisplay),
}

const fallback = eraseStateType(defaultDisplay)

function getDisplay(toolKey: ToolKey): ToolDisplay<BaseState> {
  return displaysByToolKey[toolKey] ?? fallback
}

export function renderToolStep(toolKey: ToolKey, state: BaseState, common: CommonToolProps) {
  return getDisplay(toolKey).render({ state, ...common })
}

export function summarizeToolStep(toolKey: ToolKey, state: BaseState): string {
  return getDisplay(toolKey).summary(state)
}
