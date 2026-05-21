import { TextAttributes } from '@opentui/core'

import { useTheme } from '../hooks/use-theme'
import { BOX_CHARS } from '../utils/ui-constants'

export type DiffHunkProps = {
  contextBefore?: readonly string[]
  removedLines: readonly string[]
  addedLines: readonly string[]
  contextAfter?: readonly string[]
  streamingCursor?: boolean
  maxHeight?: number
  startLine?: number
}

function padLineNum(n?: number): string {
  return n !== undefined ? String(n).padStart(3, ' ') : '   '
}

type DiffRow = {
  oldNum?: number
  newNum?: number
  prefix: string
  text: string
  fg: string
  dim?: boolean
}

export function DiffHunk({
  contextBefore = [],
  removedLines,
  addedLines,
  contextAfter = [],
  streamingCursor = false,
  maxHeight = 12,
  startLine = 1,
}: DiffHunkProps) {
  const theme = useTheme()

  const contextRadius = contextBefore.length
  const oldLineStart = startLine - contextRadius
  const newLineStart = oldLineStart

  let oldLineNum = oldLineStart
  let newLineNum = newLineStart

  const rows: DiffRow[] = []

  for (const line of contextBefore) {
    rows.push({
      oldNum: oldLineNum,
      newNum: newLineNum,
      prefix: ' ',
      text: line,
      fg: theme.muted,
      dim: true,
    })
    oldLineNum++
    newLineNum++
  }

  for (const line of removedLines) {
    rows.push({
      oldNum: oldLineNum,
      newNum: undefined,
      prefix: '-',
      text: line,
      fg: theme.error,
    })
    oldLineNum++
  }

  for (let i = 0; i < addedLines.length; i++) {
    const line = addedLines[i]
    const isLast = i === addedLines.length - 1
    rows.push({
      oldNum: undefined,
      newNum: newLineNum,
      prefix: '+',
      text: line + (streamingCursor && isLast ? '▍' : ''),
      fg: theme.syntax.string,
    })
    newLineNum++
  }

  for (const line of contextAfter) {
    rows.push({
      oldNum: oldLineNum,
      newNum: newLineNum,
      prefix: ' ',
      text: line,
      fg: theme.muted,
      dim: true,
    })
    oldLineNum++
    newLineNum++
  }

  return (
    <box
      style={{
        borderStyle: 'single',
        borderColor: theme.border || theme.muted,
        customBorderChars: BOX_CHARS,
        height: maxHeight,
      }}
    >
      <scrollbox
        onMouseScroll={(e) => e.stopPropagation()}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        scrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{ visible: false }}
        style={{
          flexGrow: 1,
          rootOptions: { flexGrow: 1, backgroundColor: 'transparent' },
          wrapperOptions: { border: false, backgroundColor: 'transparent', paddingLeft: 1, paddingRight: 1 },
          contentOptions: { justifyContent: 'flex-start' },
        }}
      >
        <box style={{ flexDirection: 'column' }}>
          {rows.map((row, index) => (
            <text
              key={`row-${index}`}
              style={{ fg: row.fg }}
              attributes={row.dim ? TextAttributes.DIM : undefined}
            >
              <span>{`${padLineNum(row.oldNum)} │ ${padLineNum(row.newNum)} │ ${row.prefix} ${row.text}`}</span>
            </text>
          ))}
        </box>
      </scrollbox>
    </box>
  )
}
