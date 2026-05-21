import { test, expect, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('../hooks/use-theme', () => ({
  useTheme: () => ({
    muted: '#888888',
    secondary: '#5e81ac',
    warning: '#ebcb8b',
    success: '#a3be8c',
    error: '#bf616a',
    border: '#4c566a',
    terminalBg: '#2e3440',
    primary: '#88c0d0',
  }),
}))

const { TurnBlock } = await import('./turn-block')

const htmlToText = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<>{node}</>)
}

test('TurnBlock renders worker started/finished/killed rows with structured fields', () => {
  const html = render(
    <TurnBlock
      block={{
        id: 'tb-1',
        type: 'turn_block',
        status: 'completed',
        timestamp: 1000,
        completedAt: 9000,
        steps: [
          {
            id: 's1',
            type: 'worker_resumed',
            workerRole: 'builder',
            workerId: 'agent-7',
            title: 'Investigate flaky test',
            resumed: false,
          },
          {
            id: 's2',
            type: 'worker_finished',
            workerRole: 'builder',
            workerId: 'agent-7',
            cumulativeTotalTimeMs: 125000,
            cumulativeTotalToolsUsed: 3,
            resumed: false,
          },
        ],
      }}
      mode="default"
    />
  )

  const text = htmlToText(html)
  expect(text).toContain('▶ Worker started: ⚒ [builder] agent-7 · Investigate flaky test')
  expect(text).toContain('✓ Worker finished: ⚒ [builder] agent-7 · 2m 5s · 3 tools')
})

test('TurnBlock includes resumed marker for worker lifecycle rows', () => {
  const html = render(
    <TurnBlock
      block={{
        id: 'tb-2',
        type: 'turn_block',
        status: 'completed',
        timestamp: 1000,
        completedAt: 9000,
        steps: [
          {
            id: 's1',
            type: 'worker_resumed',
            workerRole: 'researcher',
            workerId: 'agent-3',
            title: 'Trace root cause',
            resumed: true,
          },
          {
            id: 's2',
            type: 'worker_finished',
            workerRole: 'researcher',
            workerId: 'agent-3',
            cumulativeTotalTimeMs: 60000,
            cumulativeTotalToolsUsed: 1,
            resumed: true,
          },
        ],
      }}
      mode="default"
    />
  )

  const text = htmlToText(html)
  expect(text).toContain('▶ Worker started: [researcher] agent-3 (resumed) · Trace root cause')
  expect(text).toContain('✓ Worker finished: [researcher] agent-3 (resumed) · ↺ 1m · 1 tool')
})

test('TurnBlock completed summary includes singular worker lifecycle counts', () => {
  const html = render(
    <TurnBlock
      block={{
        id: 'tb-3',
        type: 'turn_block',
        status: 'completed',
        timestamp: 1000,
        completedAt: 9000,
        steps: [
          {
            id: 's1',
            type: 'worker_resumed',
            workerRole: 'builder',
            workerId: 'agent-1',
            title: 'Do thing',
            resumed: false,
          },
          {
            id: 's2',
            type: 'worker_finished',
            workerId: 'agent-1',
            cumulativeTotalTimeMs: 1000,
            cumulativeTotalToolsUsed: 1,
            resumed: false,
          },
        ],
      }}
      mode="default"
    />
  )

  const text = htmlToText(html)
  expect(text).toContain('Completed in 8s (1 worker started, 1 worker finished)')
})

test('TurnBlock completed summary includes plural worker lifecycle counts', () => {
  const html = render(
    <TurnBlock
      block={{
        id: 'tb-4',
        type: 'turn_block',
        status: 'completed',
        timestamp: 1000,
        completedAt: 9000,
        steps: [
          {
            id: 's1',
            type: 'worker_resumed',
            workerRole: 'builder',
            workerId: 'agent-1',
            title: 'Do thing',
            resumed: false,
          },
          {
            id: 's2',
            type: 'worker_resumed',
            workerRole: 'researcher',
            workerId: 'agent-2',
            title: 'Do another thing',
            resumed: false,
          },
          {
            id: 's3',
            type: 'worker_finished',
            workerId: 'agent-1',
            cumulativeTotalTimeMs: 1000,
            cumulativeTotalToolsUsed: 1,
            resumed: false,
          },
          {
            id: 's4',
            type: 'worker_finished',
            workerId: 'agent-2',
            cumulativeTotalTimeMs: 2000,
            cumulativeTotalToolsUsed: 2,
            resumed: false,
          },
        ],
      }}
      mode="default"
    />
  )

  const text = htmlToText(html)
  expect(text).toContain('Completed in 8s (2 workers started, 2 workers finished)')
})

test('TurnBlock summary includes killed worker counts from both kill sources', () => {
  const now = Date.now()
  const markup = render(
    <TurnBlock
      block={{
        id: 't5',
        type: 'turn_block',
        timestamp: now,
        status: 'completed',
        completedAt: now + 8000,
        steps: [
          {
            id: 's1',
            type: 'worker_resumed',
            workerId: 'researcher',
            title: 'gather evidence',
            resumed: false,
            timestamp: now + 1000,
            label: '',
          },
          {
            id: 's2',
            type: 'worker_killed',
            workerRole: 'researcher',
            workerId: 'researcher',
            title: 'gather evidence',
            timestamp: now + 2000,
            label: '',
          },
          {
            id: 's3',
            type: 'worker_user_killed',
            workerRole: 'builder',
            workerId: 'builder',
            title: 'fix tests',
            timestamp: now + 3000,
            label: '',
          },
        ],
      }}
      mode="default"
    />,
  )

  const text = htmlToText(markup)
  expect(text).toContain('Completed in 8s (1 worker started, 2 workers killed)')
})

test('TurnBlock renders user-killed worker row with dedicated text', () => {
  const now = Date.now()
  const markup = render(
    <TurnBlock
      block={{
        id: 't-user-killed',
        type: 'turn_block',
        timestamp: now,
        status: 'completed',
        completedAt: now + 1000,
        steps: [
          {
            id: 's1',
            type: 'worker_user_killed',
            workerRole: 'researcher',
            workerId: 'researcher',
            title: 'gather evidence',
            timestamp: now + 500,
            label: '',
          },
        ],
      }}
      mode="default"
    />,
  )

  const text = htmlToText(markup)
  expect(text).toContain('■ Worker killed by user: [researcher] researcher - gather evidence')
})

test('TurnBlock applies spacing around consecutive worker lifecycle rows, not between each row', () => {
  const html = render(
    <TurnBlock
      block={{
        id: 'tb-5',
        type: 'turn_block',
        status: 'completed',
        timestamp: 1000,
        completedAt: 9000,
        steps: [
          {
            id: 's1',
            type: 'worker_resumed',
            workerRole: 'builder',
            workerId: 'agent-1',
            title: 'First',
            resumed: false,
          },
          {
            id: 's2',
            type: 'worker_resumed',
            workerRole: 'researcher',
            workerId: 'agent-2',
            title: 'Second',
            resumed: false,
          },
          {
            id: 's3',
            type: 'worker_finished',
            workerId: 'agent-1',
            cumulativeTotalTimeMs: 1000,
            cumulativeTotalToolsUsed: 1,
            resumed: false,
          },
          {
            id: 's4',
            type: 'worker_finished',
            workerId: 'agent-2',
            cumulativeTotalTimeMs: 2000,
            cumulativeTotalToolsUsed: 2,
            resumed: false,
          },
        ],
      }}
      mode="default"
    />
  )

  expect((html.match(/margin-top:1/g) ?? []).length).toBe(0)
})
