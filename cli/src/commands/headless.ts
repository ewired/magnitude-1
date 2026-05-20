/**
 * Headless mode runner — batch job runtime for the agent engine.
 *
 * Uses raw events (not display projection) for output. Events fire once,
 * no dedup needed, no scanning, no boundary detection.
 *
 * Never calls process.exit() — the caller owns that.
 */

import { Layer } from 'effect'
import type { StorageClient } from '@magnitudedev/storage'
import {
  createCodingAgentClient,
  ChatPersistence,
  textParts,
  publishInitialTask,
  type AppEvent,
  type ForkTurnState,
  type AgentStatusState,
  type AutopilotState,
} from '@magnitudedev/agent'
import { createId } from '@magnitudedev/generate-id'
import { initLogger, clearSessionLog } from '@magnitudedev/logger'
import type { SessionStart } from '../app'
import { JsonChatPersistence } from '../persistence'
import {
  renderErrorMessage,
  renderUsageSummary,
  createHeadlessOutputRenderer,
} from '../headless/output'

// ── Types ──────────────────────────────────────────────────────────────

export interface RunHeadlessOptions {
  storage: StorageClient
  debug: boolean
  autopilot: boolean
  initialPrompt?: string
  sessionStart: SessionStart
  disableShellSafeguards: boolean
  disableCwdSafeguards: boolean
}

// ── Runner ─────────────────────────────────────────────────────────────

export async function runHeadless(options: RunHeadlessOptions): Promise<number> {
  const { storage, debug, autopilot, initialPrompt, sessionStart } = options

  // ── 1. Setup ────────────────────────────────────────────────────

  if (sessionStart._tag === 'new' && !initialPrompt) {
    process.stderr.write('Error: --headless for a new session requires --prompt\n')
    return 1
  }

  let sessionId: string | undefined
  if (sessionStart._tag === 'resume') sessionId = sessionStart.sessionId
  if (sessionStart._tag === 'latest') {
    sessionId = (await storage.sessions.findLatest()) ?? undefined
    if (!sessionId) {
      process.stderr.write('Error: No sessions found to resume\n')
      return 1
    }
  }

  const persistence = new JsonChatPersistence({ storage, workingDirectory: process.cwd(), sessionId })
  const activeSessionId = persistence.getSessionId()
  const persistenceLayer = Layer.succeed(ChatPersistence, persistence)
  initLogger(activeSessionId)
  clearSessionLog(activeSessionId)

  const apiKey = (await storage.auth.getStoredApiKey('magnitude'))
    || process.env.MAGNITUDE_API_KEY
    || process.env.MAGNITUDE_LOCAL_API_KEY
  if (!apiKey) {
    process.stderr.write('Error: No API key found. Set MAGNITUDE_API_KEY or run `magnitude` in TUI mode first.\n')
    return 1
  }

  const client = await createCodingAgentClient({
    persistence: persistenceLayer, storage, debug,
    sessionId: activeSessionId, magnitudeApiKey: apiKey,
    disableShellSafeguards: options.disableShellSafeguards,
    disableCwdSafeguards: options.disableCwdSafeguards,
  })

  // ── 2. State ────────────────────────────────────────────────────

  let completionReason: 'done' | 'sigint' | 'fatal' = 'done'
  const startTime = Date.now()
  let completionTimer: ReturnType<typeof setTimeout> | null = null

  let resolveDone: (() => void) | null = null
  const done = new Promise<void>(r => { resolveDone = r })

  const snapshot = {
    rootTurn: null as ForkTurnState | null,
    agentStatus: null as AgentStatusState | null,
    autopilotState: null as AutopilotState | null,
  }

  // ── Helpers ─────────────────────────────────────────────────────

  const out = (line: string, force = false) => {
    if (force || completionReason === 'done') process.stdout.write(line + '\n')
  }
  const errOut = (line: string) => process.stderr.write(line + '\n')
  const send = async (event: AppEvent) => {
    if (completionReason === 'done') await client.send(event)
  }

  // ── 3. Event handler ────────────────────────────────────────────

  const renderer = createHeadlessOutputRenderer()

  const unsubEvent = client.onEvent((event: AppEvent) => {
    if (completionReason !== 'done') return
    const rendered = renderer.handleEvent(event)
    for (const line of rendered.lines) out(line)
  })

  // ── 4. Projection subscriptions (for completion + autopilot) ───

  const unsubError = client.onError((error) => {
    if (completionReason !== 'done') return
    const msg = renderFrameworkError(error)
    if (msg.includes('sink closed') || msg.includes('runtime destroyed')) {
      completionReason = 'fatal'
      out(renderErrorMessage(`Fatal: ${msg}`), true)
      resolveDone?.()
    } else {
      out(`⚠ ${msg}`)
    }
  })

  // Autopilot + auto-send pendingContent
  let lastSentPending: string | null = null
  const unsubAutopilot = client.state.autopilotState.subscribe((s) => {
    snapshot.autopilotState = s
    if (s.pendingContent !== null && s.pendingContent !== lastSentPending) {
      lastSentPending = s.pendingContent
      void send({
        type: 'user_message', messageId: createId(), timestamp: Date.now(),
        forkId: null, content: textParts(s.pendingContent),
        attachments: [], mode: 'text', synthetic: true, taskMode: false,
      })
    }
    if (s.pendingContent === null) lastSentPending = null
    checkCompletion()
  })

  // Root turn
  const unsubTurn = client.state.turn.subscribeFork(null, (t) => {
    snapshot.rootTurn = t
    checkCompletion()
  })

  // Agent status
  const unsubStatus = client.state.agentStatus.subscribe((s) => {
    snapshot.agentStatus = s
    checkCompletion()
  })

  // ── 5. Completion detection ─────────────────────────────────────

  function checkCompletion() {
    if (completionReason !== 'done') return
    if (isStable()) {
      if (!completionTimer) {
        completionTimer = setTimeout(() => {
          completionTimer = null
          if (completionReason === 'done' && isStable()) {
            resolveDone?.()
          }
        }, 500)
      }
    } else {
      if (completionTimer) {
        clearTimeout(completionTimer)
        completionTimer = null
      }
    }
  }

  function isStable() {
    const { rootTurn, agentStatus, autopilotState } = snapshot
    if (!rootTurn || !agentStatus || !autopilotState) return false
    return rootTurn._tag === 'idle'
      && rootTurn.triggers.length === 0
      && !rootTurn.softInterrupted
      && Array.from(agentStatus.agents.values()).every(a => a.status === 'idle')
      && !autopilotState.generating
      && (!autopilotState.enabled || autopilotState.pendingContent === null)
  }

  // ── 6. SIGINT ──────────────────────────────────────────────────

  const onSigint = () => {
    if (completionReason !== 'done') return
    completionReason = 'sigint'
    void client.send({ type: 'interrupt', forkId: null, allKilled: true })
    out('■ Interrupted by user', true)
    resolveDone?.()
  }
  process.on('SIGINT', onSigint)

  // ── 7. Run + Cleanup ─────────────────────────────────────────

  if (initialPrompt) {
    await send({
      type: 'user_message', messageId: createId(), timestamp: Date.now(),
      forkId: null, content: textParts(initialPrompt),
      attachments: [], mode: 'text', synthetic: false, taskMode: false,
    })
  }
  if (autopilot) {
    if (initialPrompt) {
      await client.runEffect(publishInitialTask(initialPrompt))
    }
    await send({ type: 'autopilot_toggled', forkId: null, enabled: true })
  }

  await done

  process.off('SIGINT', onSigint)
  if (completionTimer) clearTimeout(completionTimer)
  try { unsubEvent() } catch {}
  try { unsubError() } catch {}
  try { unsubAutopilot() } catch {}
  try { unsubTurn() } catch {}
  try { unsubStatus() } catch {}
  try { await client.dispose() } catch {}

  const exitReason: string = completionReason
  if (exitReason === 'sigint') {
    errOut(`\nResume this session with:\nmagnitude --resume ${activeSessionId}\n`)
  }

  const success = exitReason === 'done'
  out(renderUsageSummary(Date.now() - startTime, renderer.getToolCount(), success), true)

  if (exitReason === 'sigint') return 130
  if (exitReason === 'fatal') return 1
  return 0
}

function renderFrameworkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const tag = typeof record._tag === 'string' ? record._tag : 'error'
    const cause = record.cause
    const detail = stringifyErrorDetail(cause ?? record.message ?? error)
    return detail && detail !== '{}' ? `${tag}: ${detail}` : tag
  }
  return String(error)
}

function stringifyErrorDetail(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
