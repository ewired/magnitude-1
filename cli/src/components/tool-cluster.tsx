import { memo } from 'react'
import stringWidth from 'string-width'
import type { ToolMessage } from '@magnitudedev/agent'
import { useTheme } from '../hooks/use-theme'
import { slate } from '../utils/palette'
import { renderToolStep } from '../tool-displays/render'

// =============================================================================
// Width-aware item fitting (from turn-block.tsx)
// =============================================================================

export function fitItems(items: string[], maxWidth: number): { shown: string[]; remaining: number } {
  if (items.length === 0) return { shown: [], remaining: 0 }

  const MIN_ITEM_WIDTH = 4
  const shown: string[] = []
  let used = 0
  let i = 0

  while (i < items.length) {
    const item = items[i]
    const itemWidth = stringWidth(item)
    const sepWidth = shown.length > 0 ? 2 : 0
    const suffixWidth = i < items.length - 1 ? stringWidth(`${shown.length > 0 ? ', ' : ''}+${items.length - i - 1} more`) : 0
    const available = maxWidth - used - sepWidth - suffixWidth

    if (available < MIN_ITEM_WIDTH) break

    if (itemWidth <= available) {
      shown.push(item)
      used += sepWidth + itemWidth
      i++
    } else {
      const truncated = truncateToWidth(item, available)
      shown.push(truncated)
      used += sepWidth + stringWidth(truncated)
      i++
    }
  }

  return { shown, remaining: items.length - i }
}

export function truncateToWidth(s: string, maxWidth: number): string {
  const w = stringWidth(s)
  if (w <= maxWidth) return s
  if (maxWidth <= 1) return '…'
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
// ToolStepView — renders a single tool via the registry
// =============================================================================

export const ToolStepView = memo(function ToolStepView({
  step,
  mode,
  onFileClick,
}: {
  step: ToolMessage
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

// =============================================================================
// ClusterSummaryRow — consolidated line for groupable tools
// =============================================================================

export const ClusterSummaryRow = memo(function ClusterSummaryRow({ cluster, steps, width, mode }: { cluster: string; steps: ToolMessage[]; width: number; mode: 'default' | 'transcript' }) {
  const theme = useTheme()

  switch (cluster) {
    case 'read': {
      const anyInProgress = steps.some(s => {
        const phase = (s.state as any)?.phase
        return phase === 'streaming' || phase === 'executing'
      })
      const anyError = steps.some(s => (s.state as any)?.phase === 'error')
      const verb = anyInProgress ? 'Reading' : 'Read'
      const icon = anyError ? '✗ ' : '→ '
      const iconColor = anyError ? theme.error : theme.info

      const items: { display: string; path: string; rangeSuffix?: string; isError?: boolean }[] = []
      for (const s of steps) {
        const state = s.state as any
        const path = state?.path
        if (!path) continue
        const phase = state?.phase

        if (phase === 'error') {
          items.push({ display: `✗ ${path}`, path: `✗ ${path}`, isError: true })
          continue
        }

        if (phase === 'streaming' || phase === 'executing') {
          items.push({ display: path, path })
          continue
        }

        const offset = state?.offset
        const limit = state?.limit
        const lineCount = state?.lineCount ?? 0
        const isPartial = (offset != null && offset > 1) || limit != null
        if (isPartial) {
          const startLine = offset ?? 1
          const endLine = startLine + lineCount - 1
          const rangeSuffix = `:${startLine}-${endLine}`
          items.push({ display: `${path}${rangeSuffix}`, path, rangeSuffix })
        } else {
          items.push({ display: path, path })
        }
      }

      const fileWord = steps.length === 1 ? 'file' : 'files'
      const prefix = `${icon}${verb} ${steps.length} ${fileWord}`
      const prefixWidth = stringWidth(prefix)

      const renderItem = (item: typeof items[number]) => {
        if (item.isError) {
          return <span style={{ fg: theme.error }}>{item.display}</span>
        }
        if (item.rangeSuffix) {
          return <><span style={{ fg: slate[400] }}>{item.path}</span><span style={{ fg: slate[500] }}>{item.rangeSuffix}</span></>
        }
        return <span style={{ fg: slate[400] }}>{item.path}</span>
      }

      if (mode === 'default') {
        const displayStrings = items.map(i => i.display)
        const detailWidth = width - prefixWidth - 3 // ' (' + ')'
        const { shown, remaining } = detailWidth > 0 ? fitItems(displayStrings, detailWidth) : { shown: [], remaining: displayStrings.length }
        const shownItems = items.slice(0, shown.length)
        return (
          <text>
            <span style={{ fg: iconColor }}>{icon}</span>
            <span style={{ fg: theme.foreground }}>{`${verb} ${steps.length} ${fileWord}`}</span>
            {shownItems.length > 0 && <span style={{ fg: slate[400] }}>{' ('}</span>}
            {shownItems.map((item, i) => (
              <span key={i}>
                {i > 0 && <span style={{ fg: slate[400] }}>{', '}</span>}
                {renderItem(item)}
              </span>
            ))}
            {remaining > 0 && <span style={{ fg: slate[400] }}>{`${shown.length > 0 ? ', ' : ''}+${remaining} more`}</span>}
            {shownItems.length > 0 && <span style={{ fg: slate[400] }}>{')'}</span>}
          </text>
        )
      }

      // Transcript mode: show all items, wrap with indent alignment
      const indentWidth = prefixWidth + 2
      const lineItems: (typeof items[number])[][] = []
      let currentItems: (typeof items[number])[] = []
      let currentLineWidth = 0
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const sepWidth = currentLineWidth > 0 ? 2 : 0
        const itemWidth = stringWidth(item.display)
        const isLast = i === items.length - 1
        const capacity = isLast ? width - indentWidth - 1 : width - indentWidth
        if (currentLineWidth + sepWidth + itemWidth <= capacity) {
          currentItems.push(item)
          currentLineWidth += sepWidth + itemWidth
        } else {
          if (currentItems.length > 0) lineItems.push(currentItems)
          currentItems = [item]
          currentLineWidth = itemWidth
        }
      }
      if (currentItems.length > 0) lineItems.push(currentItems)

      if (lineItems.length === 0) {
        return <text><span style={{ fg: iconColor }}>{icon}</span><span style={{ fg: theme.foreground }}>{`${verb} ${steps.length} ${fileWord}`}</span></text>
      }

      const indent = ' '.repeat(indentWidth)
      return (
        <box style={{ flexDirection: 'column' }}>
          <text>
            <span style={{ fg: iconColor }}>{icon}</span>
            <span style={{ fg: theme.foreground }}>{`${verb} ${steps.length} ${fileWord}`}</span>
            <span style={{ fg: slate[400] }}>{' ('}</span>
            {lineItems[0].map((item, j) => (
              <span key={j}>
                {j > 0 && <span style={{ fg: slate[400] }}>{', '}</span>}
                {renderItem(item)}
              </span>
            ))}
            {lineItems.length === 1 && <span style={{ fg: slate[400] }}>{')'}</span>}
          </text>
          {lineItems.slice(1, -1).map((line, i) => (
            <text key={i}>
              <span>{indent}</span>
              {line.map((item, j) => (
                <span key={j}>
                  {j > 0 && <span style={{ fg: slate[400] }}>{', '}</span>}
                  {renderItem(item)}
                </span>
              ))}
            </text>
          ))}
          {lineItems.length > 1 && (
            <text>
              <span>{indent}</span>
              {lineItems[lineItems.length - 1].map((item, j) => (
                <span key={j}>
                  {j > 0 && <span style={{ fg: slate[400] }}>{', '}</span>}
                  {renderItem(item)}
                </span>
              ))}
              <span style={{ fg: slate[400] }}>{')'}</span>
            </text>
          )}
        </box>
      )
    }
    case 'search': {
      const totalMatches = steps.reduce((sum, s) => sum + ((s.state as any)?.matchCount ?? 0), 0)
      const uniqueFiles = new Set(steps.flatMap(s => ((s.state as any)?.matches ?? []) as any[]).map((m: any) => m?.file)).size
      const patterns = steps.map(s => (s.state as any)?.pattern ?? (s.state as any)?.query).filter(Boolean) as string[]
      const label = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''} in ${uniqueFiles} file${uniqueFiles !== 1 ? 's' : ''}`
      const labelWidth = stringWidth('/ ') + stringWidth(label)
      const detailWidth = width - labelWidth - stringWidth(` (pattern: )`) // ' (' + 'pattern: ' + ')'
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
      const detailWidth = width - labelWidth - 3 // ' (' + ')'
      const quotedQueries = queries.map(q => `"${q}"`)
      const { shown, remaining } = detailWidth > 0 ? fitItems(quotedQueries, detailWidth) : { shown: [], remaining: queries.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'[⌕] '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'web_fetch': {
      const urls = steps.map(s => (s.state as any)?.url).filter(Boolean) as string[]
      const label = `Fetched ${urls.length} URL${urls.length > 1 ? 's' : ''}`
      const labelWidth = stringWidth('[↓] ') + stringWidth(label)
      const detailWidth = width - labelWidth - 3 // ' (' + ')'
      const { shown, remaining } = detailWidth > 0 ? fitItems(urls, detailWidth) : { shown: [], remaining: urls.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'[↓] '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'tree': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean) as string[]
      const label = `Listed files`
      const labelWidth = stringWidth('◫ ') + stringWidth(label)
      const detailWidth = width - labelWidth - 3 // ' (' + ')'
      const { shown, remaining } = detailWidth > 0 ? fitItems(paths, detailWidth) : { shown: [], remaining: paths.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'◫ '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    case 'view': {
      const paths = steps.map(s => (s.state as any)?.path).filter(Boolean) as string[]
      const label = `Viewed ${steps.length} file${steps.length > 1 ? 's' : ''}`
      const labelWidth = stringWidth('⚲ ') + stringWidth(label)
      const detailWidth = width - labelWidth - 3 // ' (' + ')'
      const { shown, remaining } = detailWidth > 0 ? fitItems(paths, detailWidth) : { shown: [], remaining: paths.length }
      const detail = shown.join(', ') + (remaining > 0 ? `${shown.length > 0 ? ', ' : ''}+${remaining} more` : '')
      return <text><span style={{ fg: theme.info }}>{'⚲ '}</span><span style={{ fg: theme.foreground }}>{label}</span>{detail && <span style={{ fg: theme.muted }}>{` (${detail})`}</span>}</text>
    }
    default:
      return null
  }
})
