import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useKeyboard, useRenderer } from '@opentui/react'
import { Effect, Layer, Cause } from 'effect'
import { createCodingAgentClient, ChatPersistence, ImageDescriptionServiceTag, getSessionTitleFromTaskGraph, fetchRoleProfiles, classifyUnknownError, present, publishInitialTask, computeChainStats, type DisplayState, type AgentStatusState, type AppEvent, type ErrorDisplayMessage, type CompactionState, type TurnState, type DebugSnapshot, type RoleProfile, type ActionId, type InterruptedMessage, type ChainStats } from '@magnitudedev/agent'
import { matchKeyToChord } from './utils/chord'
import { loadSkills } from '@magnitudedev/skills'
import { textParts } from '@magnitudedev/agent'
import { JsonChatPersistence, loadSessionMeta } from './persistence'
import { ChatTimeline } from './components/chat-timeline'
import { WorkingTimer } from './components/working-timer'
import { PendingCommunicationsPanel } from './components/pending-communications-panel'
import { LoadPreviousButton } from './components/chat-controls'
import { usePaginatedTimeline } from './hooks/use-paginated-timeline'

import { useTheme } from './hooks/use-theme'
import { SelectedFileProvider } from './hooks/use-file-viewer'
import { BOX_CHARS } from './utils/ui-constants'
import { parseMentionsFromPrompt } from './utils/strings'
import { formatTokensCompact } from './utils/format-tokens'
import { hasConversationActivity } from './utils/start-state'
import { AnimatedLogo } from './components/animated-logo'
import { RecentChatsWidget } from './components/recent-chats-widget'
import { SessionLoadingView } from './components/session-loading-view'
import { routeSlashCommand, type CommandContext } from './commands/command-router'
import { INIT_PROMPT } from './commands/init-prompt'
import { registerSkillCommands, type SlashCommandDefinition } from './commands/slash-commands'
import { useSelectionAutoCopy } from './utils/clipboard'
import { useRecentChatsNavigation } from './hooks/use-recent-chats-navigation'
import { AppOverlays } from './components/app-overlays'
import { AutopilotIndicator } from './components/autopilot-indicator'
import { AutopilotPreviewMessage } from './components/autopilot-preview-message'
import { getRecentChats, type RecentChat } from './data/recent-chats'
import { logger, initLogger, subscribeToLogs, clearSessionLog, getSessionLogPath, type LogEntry } from '@magnitudedev/logger'
import { executeBashCommand, type BashResult } from './utils/bash-executor'

import { FileViewerPanel } from './components/file-viewer-panel'
import type { Attachment } from '@magnitudedev/agent'
import { DebugPanel } from './components/debug-panel'
import { ChatController } from './components/chat/chat-controller'
import { useTasks } from './hooks/use-tasks'
import { useLocalWidth } from './hooks/use-local-width'
import { TextAttributes, type KeyEvent } from '@opentui/core'
import { createId } from '@magnitudedev/generate-id'
import { useStorage } from './providers/storage-provider'
import { useFilePanel } from './hooks/use-file-panel'
import { useLazyClient } from './hooks/use-lazy-client'
import { useMagnitudeAuth } from './hooks/use-magnitude-auth'
import { MagnitudeLoginScreen } from './components/magnitude-login-screen'
import { WindowsWarningScreen } from './components/windows-warning-screen'
import { createRoles, ROLE_IDS, type RoleId } from '@magnitudedev/roles'

export const getSelectedForkContentVersion = (
  selectedForkId: string | null,
  forkDisplay: Pick<DisplayState, 'messages' | 'pendingInboundCommunications'> | null
): string => {
  if (!selectedForkId) return 'main'
  return [
    selectedForkId,
    forkDisplay?.messages.length ?? 0,
    forkDisplay?.pendingInboundCommunications.length ?? 0,
  ].join(':')
}

type AgentClient = Awaited<ReturnType<typeof createCodingAgentClient>>

export type SessionStart =
  | { _tag: 'new' }
  | { _tag: 'latest' }
  | { _tag: 'resume'; sessionId: string }

export function App({ sessionStart, debug, autopilot, initialPrompt, onClientReady, onSessionId, disableShellSafeguards, disableCwdSafeguards, atifPath }: { sessionStart: SessionStart; debug: boolean; autopilot?: boolean; initialPrompt?: string; onClientReady?: (client: AgentClient | null) => void; onSessionId?: (id: string) => void; disableShellSafeguards?: boolean; disableCwdSafeguards?: boolean; atifPath?: string }) {
  const [conversationKey, setConversationKey] = useState(0)
  const [sessionSelection, setSessionSelection] = useState<string | null | undefined>(
    sessionStart._tag === 'new' ? null : sessionStart._tag === 'latest' ? undefined : sessionStart.sessionId
  )
  const hasAnimatedRef = useRef(false)

  const handleReset = useCallback(() => {
    hasAnimatedRef.current = true
    setSessionSelection(null)
    setConversationKey(prev => prev + 1)
  }, [])

  const handleResumeSession = useCallback((sessionId: string) => {
    hasAnimatedRef.current = true
    setSessionSelection(sessionId)
    setConversationKey(prev => prev + 1)
  }, [])

  return (
    <AppInner
      debugMode={debug}
      key={conversationKey}
      skipAnimation={hasAnimatedRef.current}
      sessionSelection={sessionSelection}
      onReset={handleReset}
      onResumeSession={handleResumeSession}
      onClientReady={onClientReady}
      onSessionId={onSessionId}
      autopilot={autopilot ?? false}
      initialPrompt={initialPrompt}
      disableShellSafeguards={disableShellSafeguards ?? false}
      disableCwdSafeguards={disableCwdSafeguards ?? false}
      atifPath={atifPath}
    />
  )
}

function AppInner({
  debugMode,
  skipAnimation,
  sessionSelection,
  onReset,
  onResumeSession,
  onClientReady,
  onSessionId,
  autopilot,
  initialPrompt,
  disableShellSafeguards,
  disableCwdSafeguards,
  atifPath,
}: {
  debugMode: boolean
  skipAnimation: boolean
  sessionSelection: string | null | undefined
  onReset: () => void
  onResumeSession: (sessionId: string) => void
  onClientReady?: (client: AgentClient | null) => void
  onSessionId?: (id: string) => void
  autopilot: boolean
  initialPrompt?: string
  disableShellSafeguards: boolean
  disableCwdSafeguards: boolean
  atifPath?: string
}) {
  const renderer = useRenderer()
  const storage = useStorage()
  const auth = useMagnitudeAuth()
  const { client, scratchpadPath, send: clientSend, ensureReady: ensureClientReady, setFactory: setClientFactory, setClient: setLazyClient } = useLazyClient()

  const [display, setDisplay] = useState<DisplayState | null>(null)
  const [toolState, setToolState] = useState<TurnState | null>(null)
  const [agentStatusState, setAgentStatusState] = useState<AgentStatusState | null>(null)
  const [expandedForkStack, setExpandedForkStack] = useState<string[]>([])
  const expandedForkId = expandedForkStack.length > 0 ? expandedForkStack[expandedForkStack.length - 1] : null
  const pushForkOverlay = useCallback((forkId: string) => setExpandedForkStack(s => [...s, forkId]), [])
  const popForkOverlay = () => {
    setExpandedForkStack(s => s.slice(0, -1))
  }

  const [forkDisplay, setForkDisplay] = useState<DisplayState | null>(null)
  const [forkTokenEstimate, setForkTokenEstimate] = useState(0)
  const [forkIsCompacting, setForkIsCompacting] = useState(false)

  const [systemMessages, setSystemMessages] = useState<Array<{ id: string; text: string; timestamp: number }>>([])
  const systemMessageTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [showRecentChatsOverlay, setShowRecentChatsOverlay] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [roleProfiles, setRoleProfiles] = useState<Partial<Record<RoleId, RoleProfile>> | null>(null)
  const contextHardCap = roleProfiles?.leader?.contextWindow ?? null

  const [bashMode, setBashMode] = useState(false)
  const [bashOutputs, setBashOutputs] = useState<BashResult[]>([])
  const [debugPanelVisible, setDebugPanelVisible] = useState(false)
  const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot | null>(null)
  const [debugEvents, setDebugEvents] = useState<AppEvent[]>([])
  const [debugLogs, setDebugLogs] = useState<LogEntry[]>([])
  const [composerHasContent, setComposerHasContent] = useState(false)
  const [displayMode, setDisplayMode] = useState<'default' | 'transcript'>('default')
  const [restoredQueuedInputText, setRestoredQueuedInputText] = useState<string | null>(null)
  const [tokenEstimate, setTokenEstimate] = useState(0)
  const [isCompacting, setIsCompacting] = useState(false)
  const hasAnimatedRef = useRef(skipAnimation)

  // ── Autopilot state (TUI-only countdown) ──────────────────────────────
  const [autopilotEnabled, setAutopilotEnabled] = useState(false)
  const [autopilotGenerating, setAutopilotGenerating] = useState(false)
  const [autopilotCountdown, setAutopilotCountdown] = useState<{
    content: string | null
    startTime: number | null
    isRunning: boolean
  }>({ content: null, startTime: null, isRunning: false })
  const [autopilotRetainedContent, setAutopilotRetainedContent] = useState<string | null>(null)

  // Refs for stale closure prevention
  const countdownRunningRef = useRef(false)
  const isRunningRef = useRef(false)

  const formatFooterTokens = formatTokensCompact
  const tokenUsage = tokenEstimate > 0 ? tokenEstimate : null
  const contextPercent = (tokenUsage != null && contextHardCap) ? Math.round((tokenUsage / contextHardCap) * 100) : null
  const contextDisplayText = tokenUsage == null
    ? '-'
    : (contextHardCap
      ? `${contextPercent}% ${formatFooterTokens(tokenUsage)}/${formatFooterTokens(contextHardCap)}`
      : `${formatFooterTokens(tokenUsage)}/Unknown`)
  const contextRenderedText = isCompacting ? `>>> ${contextDisplayText} <<<` : contextDisplayText

  // Always reserve width for the longest possible escape hint so that
  // attachments don't reflow when hints appear/disappear.
  const maxEscHintWidth = 'Press Esc again to interrupt all workers'.length

  const chatColumn = useLocalWidth()
  const chatColumnWidth = chatColumn.width ?? 80
  const footerRightGap = contextRenderedText ? 1 : 0
  const footerHorizontalPadding = 4
  const footerSafetyBuffer = 4
  const attachmentsMaxWidth = Math.max(
    0,
    chatColumnWidth
      - footerHorizontalPadding
      - maxEscHintWidth
      - contextRenderedText.length
      - footerRightGap
      - footerSafetyBuffer,
  )

  const [recentChatsSelectedIndex, setRecentChatsSelectedIndex] = useState(0)
  const [recentChats, setRecentChats] = useState<RecentChat[] | null>(null)

  const refreshRecentChats = useCallback(() => {
    getRecentChats(storage, process.cwd()).then(setRecentChats)
  }, [storage])

  useEffect(() => {
    logger.info('App started')
    if (debugMode) logger.info('Debug mode enabled - press Ctrl+X to toggle debug panel')
    refreshRecentChats()
  }, [debugMode, refreshRecentChats])

  useEffect(() => {
    if (!auth.loaded || !auth.key) return
    let cancelled = false
    fetchRoleProfiles(auth.key)
      .then(profiles => {
        if (!cancelled) setRoleProfiles(profiles)
      })
      .catch(err => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load role profiles'))
    return () => { cancelled = true }
  }, [auth.loaded, auth.key])

  // Subscribe to live logs for debug panel
  useEffect(() => {
    if (!debugMode) return
    return subscribeToLogs((entry) => {
      setDebugLogs(prev => [...prev, entry])
    })
  }, [debugMode])

  useEffect(() => {
    if (showRecentChatsOverlay) {
      refreshRecentChats()
    }
  }, [showRecentChatsOverlay, refreshRecentChats])

  useEffect(() => {
    if (!auth.loaded || !auth.key) {
      return
    }
    let mounted = true
    let c: AgentClient | null = null

    // Register skills as slash commands (fire-and-forget, non-blocking)
    loadSkills(process.cwd()).then((skillsMap) => {
      const commands: SlashCommandDefinition[] = []

      for (const s of skillsMap.values()) {
        commands.push({
          id: s.name,
          label: s.name,
          description: s.description,
          source: 'skill' as const,
          skillPath: s.path,
        })
      }

      if (commands.length > 0) {
        registerSkillCommands(commands)
        logger.info({ count: commands.length, names: commands.map(c => c.id) }, 'Registered skill commands')
      }
    }).catch((err) => {
      logger.warn({ error: err.message }, 'Failed to load skills')
    })

    let resolvedScratchpadPath: string | null = null
    let resolvedSessionId: string | null = null

    const createClient = async () => {
      let sessionId: string | undefined
      if (sessionSelection === undefined) {
        sessionId = await storage.sessions.findLatest() ?? undefined
      } else if (sessionSelection === null) {
        sessionId = undefined
      } else {
        sessionId = sessionSelection
      }

      const persistence = new JsonChatPersistence({
        storage,
        workingDirectory: process.cwd(),
        sessionId,
      })
      const activeSessionId = persistence.getSessionId()
      resolvedSessionId = activeSessionId
      onSessionId?.(activeSessionId)
      resolvedScratchpadPath = storage.sessions.getScratchpadPath(activeSessionId) ?? null
      initLogger(persistence.getSessionId())
      clearSessionLog(persistence.getSessionId())
      logger.info({ logFile: getSessionLogPath(persistence.getSessionId()) }, 'Session logger initialized')
      const persistenceLayer = Layer.succeed(ChatPersistence, persistence)
      return createCodingAgentClient({
        persistence: persistenceLayer,
        storage,
        debug: debugMode,
        sessionId: activeSessionId,
        magnitudeApiKey: auth.key ?? undefined,
        disableShellSafeguards,
        disableCwdSafeguards,
        atifPath,
      })
    }

    const setupClient = (client: AgentClient) => {
      if (!mounted) {
        client.dispose()
        return
      }
      c = client
      setLazyClient(client, resolvedScratchpadPath)
      onClientReady?.(client)
      renderer.setTerminalTitle("Magnitude")

      // Log all events to event log file + collect for debug panel
      client.onEvent((event) => {
        if (debugMode && mounted) {
          setDebugEvents(prev => [...prev, event])
        }
      })

      // Framework errors bypass the event system entirely — render directly in the TUI
      client.onError((error) => {
        if (!mounted) return
        // Log full cause for debugging; surface a friendly message to the user.
        logger.error({ tag: error._tag, cause: Cause.pretty(error.cause) }, 'Framework error')
        const outcome = classifyUnknownError(error.cause)
        const p = present(outcome)
        if (p.surface !== 'inline') return
        const errorMsg: ErrorDisplayMessage = {
          id: createId(),
          type: 'error',
          message: p.message,
          timestamp: Date.now(),
          cta: p.cta,
        }
        setDisplay(prev => prev ? { ...prev, messages: [...prev.messages, errorMsg] } : prev)
      })

      // Subscribe to agent state (global projection)
      client.state.agentStatus.subscribe((state) => {
        if (mounted) {
          setAgentStatusState(state)
        }
      })

      // Subscribe to restore queued messages signal (only for main/root)
      client.on.restoreQueuedMessages(({ forkId, messages }) => {
        // Only restore if this is for the main agent (not a fork)
        if (mounted && forkId === null && messages.length > 0) {
          const restored = messages.join('\n')
          logger.info({ restored, length: restored.length }, 'Restoring queued messages to input')
          setRestoredQueuedInputText(restored)
        }
      })

      // Initial autopilot toggle if --autopilot flag was passed
      if (autopilot) {
        client.send({ type: 'autopilot_toggled', forkId: null, enabled: true })
      }


      client.state.taskGraph.subscribe((state) => {
        if (!mounted) return
        const title = getSessionTitleFromTaskGraph(state)
        if (!title) return
        logger.info({ title }, 'Session title derived from task graph')
        renderer.setTerminalTitle(title)
      })
    }

    if (sessionSelection === null) {
      // NEW SESSION: defer client creation, show empty UI immediately
      setDisplay({
        status: 'idle',
        messages: [],
        pendingInboundCommunications: [],
        currentTurnId: null,
        streamingMessageId: null,

        showButton: 'send',
        chainStartTime: null,
        chainStatus: null,
        chainEndTime: null,
      })
      setClientFactory(async () => {
        const client = await createClient()
        setupClient(client)
        return client
      })
    } else {
      // RESUMED SESSION: create client immediately (existing behavior)
      setClientFactory(null)
      createClient().catch((err) => {
        logger.error({ error: err.message, stack: err.stack }, 'Failed to create agent client');
        throw err;
      }).then(async (client) => {
        logger.info('Agent client created successfully');
        setupClient(client)

        if (!resolvedSessionId) return

        const meta = await loadSessionMeta(storage, resolvedSessionId)
        if (meta?.chatName) {
          renderer.setTerminalTitle(meta.chatName)
        }
      })
    }

    return () => {
      mounted = false
      setClientFactory(null)
      onClientReady?.(null)
      c?.dispose()
    }
  }, [debugMode, onClientReady, onSessionId, renderer, sessionSelection, setClientFactory, setLazyClient, storage, auth.loaded, auth.key])

  // ── Send initial prompt if --prompt flag was provided ──────────────────
  const initialPromptSentRef = useRef(false)
  useEffect(() => {
    if (!initialPrompt || initialPromptSentRef.current || !auth.loaded || !auth.key) return
    initialPromptSentRef.current = true
    const attachments = parseMentionsFromPrompt(initialPrompt, process.cwd())
    // Publish initial task so autopilot uses task-driving prompt
    ensureClientReady().then(({ client }) => client.runEffect(publishInitialTask(initialPrompt)))
    clientSend({
      type: 'user_message',
      messageId: createId(),
      timestamp: Date.now(),
      forkId: null,
      content: textParts(initialPrompt),
      attachments,
      mode: 'text',
      synthetic: false,
      taskMode: false,
    })
  }, [initialPrompt, auth.loaded, auth.key, clientSend])

  // Subscribe to display state for selected fork
  useEffect(() => {
    if (!client) {
      logger.warn("handleInterrupt: no client, returning")
      return
    }

    const unsubscribe = client.state.display.subscribeFork(null, (state) => {
      if (state.streamingMessageId) {
        lastStreamingMessageIdRef.current = state.streamingMessageId
      }
      if (state.status === 'streaming') {
        interruptedMessageIdRef.current = null
      } else if (state.status === 'idle') {
        const lastMsg = state.messages[state.messages.length - 1]
        if (lastMsg?.type === 'interrupted') {
          interruptedMessageIdRef.current = lastStreamingMessageIdRef.current
        } else {
          interruptedMessageIdRef.current = null
        }
      }
      setDisplay(state)
    })

    return unsubscribe
  }, [client])

  useEffect(() => {
    const onFocus = () => {
      client?.send({ type: 'window_focus_changed', forkId: null, focused: true })
    }
    const onBlur = () => {
      client?.send({ type: 'window_focus_changed', forkId: null, focused: false })
    }
    renderer.on('focus', onFocus)
    renderer.on('blur', onBlur)
    return () => {
      renderer.off('focus', onFocus)
      renderer.off('blur', onBlur)
    }
  }, [renderer, client])

  // Subscribe to compaction state for context usage bar
  useEffect(() => {
    if (!client) return

    const unsubWindow = client.state.memory.subscribeFork(null, (state) => {
      setTokenEstimate(state.tokenEstimate)
    })
    const unsubCompaction = client.state.compaction.subscribeFork(null, (state: CompactionState) => {
      setIsCompacting(state._tag !== 'idle')
    })

    return () => { unsubWindow(); unsubCompaction() }
  }, [client])

  // ── Autopilot state subscription ──────────────────────────────────────
  useEffect(() => {
    if (!client) return

    const unsub = client.state.autopilotState.subscribe((state) => {
      setAutopilotEnabled(state.enabled)
      setAutopilotGenerating(state.generating)
      setAutopilotRetainedContent(state.pendingContent)

      if (state.pendingContent && !countdownRunningRef.current) {
        // New preview generated — start countdown
        countdownRunningRef.current = true
        isRunningRef.current = true
        setAutopilotCountdown({
          content: state.pendingContent,
          startTime: Date.now(),
          isRunning: true,
        })
      }

      if (!state.pendingContent && countdownRunningRef.current) {
        // Preview consumed — stop countdown
        countdownRunningRef.current = false
        isRunningRef.current = false
        setAutopilotCountdown({ content: null, startTime: null, isRunning: false })
      }

      // Autopilot disabled — cancel any active countdown
      if (!state.enabled && countdownRunningRef.current) {
        countdownRunningRef.current = false
        isRunningRef.current = false
        setAutopilotCountdown({ content: null, startTime: null, isRunning: false })
      }
    })

    return unsub
  }, [client])

  // ── Autopilot countdown timer (3s) ────────────────────────────────────
  useEffect(() => {
    if (!autopilotCountdown.isRunning || !autopilotCountdown.startTime) return

    const interval = setInterval(() => {
      // Check ref — prevents send after user cancellation
      if (!isRunningRef.current) {
        clearInterval(interval)
        return
      }

      const elapsed = Date.now() - autopilotCountdown.startTime!
      if (elapsed >= 3000) {
        isRunningRef.current = false
        countdownRunningRef.current = false
        clearInterval(interval)
        setAutopilotCountdown({ content: null, startTime: null, isRunning: false })

        // Send synthetic user_message
        if (client && autopilotCountdown.content) {
          client.send({
            type: 'user_message',
            messageId: createId(),
            timestamp: Date.now(),
            forkId: null,
            content: [{ _tag: 'TextPart' as const, text: autopilotCountdown.content }],
            attachments: [],
            mode: 'text',
            synthetic: true,
            taskMode: false,
          })
        }
      }
    }, 100)

    return () => {
      isRunningRef.current = false
      clearInterval(interval)
    }
  }, [autopilotCountdown.isRunning, autopilotCountdown.startTime, autopilotCountdown.content, client])

  // ── User typing override: cancel countdown ──────────────────────────────
  useEffect(() => {
    if (composerHasContent && countdownRunningRef.current) {
      isRunningRef.current = false
      countdownRunningRef.current = false
      setAutopilotCountdown({ content: null, startTime: null, isRunning: false })
    }
  }, [composerHasContent])

  // ── User clears input: restore preview ────────────────────────────────
  useEffect(() => {
    if (
      !composerHasContent &&
      autopilotRetainedContent &&
      !countdownRunningRef.current &&
      autopilotEnabled
    ) {
      // Re-instate preview with fresh timer
      countdownRunningRef.current = true
      isRunningRef.current = true
      setAutopilotCountdown({
        content: autopilotRetainedContent,
        startTime: Date.now(),
        isRunning: true,
      })
    }
  }, [composerHasContent, autopilotRetainedContent, autopilotEnabled])

  const subscribeForkCompaction = useCallback((forkId: string, cb: (state: CompactionState) => void) => {
    if (!client) return () => {}
    return client.state.compaction.subscribeFork(forkId, cb)
  }, [client])

  const subscribeForkWindow = useCallback((forkId: string, cb: (state: { tokenEstimate: number }) => void) => {
    if (!client) return () => {}
    return client.state.memory.subscribeFork(forkId, cb)
  }, [client])

  // Subscribe to tool state for file panel streaming support
  useEffect(() => {
    if (!client) return

    const unsubscribe = client.state.harnessState.subscribeFork(null, (state) => {
      setToolState(state)
    })

    return unsubscribe
  }, [client])

  const tasks = useTasks({
    client,
  })

  const selectedForkId: string | null = null

  // Subscribe to selected fork's display
  useEffect(() => {
    if (!client || !selectedForkId) {
      setForkDisplay(null)
      return
    }
    const unsubscribe = client.state.display.subscribeFork(selectedForkId, (state) => {
      setForkDisplay(state)
    })
    return unsubscribe
  }, [client, selectedForkId])

  // Subscribe to selected fork's compaction state
  useEffect(() => {
    if (!client || !selectedForkId) {
      setForkTokenEstimate(0)
      setForkIsCompacting(false)
      return
    }
    const unsubWindow = client.state.memory.subscribeFork(selectedForkId, (state) => {
      setForkTokenEstimate(state.tokenEstimate)
    })
    const unsubCompaction = client.state.compaction.subscribeFork(selectedForkId, (state: CompactionState) => {
      setForkIsCompacting(state._tag !== 'idle')
    })
    return () => { unsubWindow(); unsubCompaction() }
  }, [client, selectedForkId])

  // Subscribe to debug stream when debug mode is enabled and panel is visible
  useEffect(() => {
    if (!client || !debugMode || !debugPanelVisible) return

    const unsubscribe = client.subscribeDebug(null, (snapshot) => {
      setDebugSnapshot(snapshot)
    })

    return unsubscribe
  }, [client, debugMode, debugPanelVisible])

  const activeDisplay = selectedForkId ? forkDisplay : display

  // Roles data for settings display
  const rolesData = useMemo(() => {
    const roles = createRoles()
    return ROLE_IDS.map(id => ({
      id,
      description: roles[id].description,
      modelDisplayName: roleProfiles?.[id]?.modelDisplayName ?? null,
    }))
  }, [roleProfiles])

  const labelForRole = (id: RoleId): string => id.charAt(0).toUpperCase() + id.slice(1)
  const modelNameForRole = (id: RoleId): string => roleProfiles?.[id]?.modelDisplayName ?? '-'

  const activeModelSummary = useMemo(() => {
    const role: RoleId = (() => {
      if (!selectedForkId || !agentStatusState) return 'leader'
      const agentId = agentStatusState.agentByForkId.get(selectedForkId)
      const agent = agentId ? agentStatusState.agents.get(agentId) : undefined
      const r = agent?.role
      return r && (ROLE_IDS as readonly string[]).includes(r) ? (r as RoleId) : 'leader'
    })()
    return { role: labelForRole(role), model: modelNameForRole(role) }
  }, [selectedForkId, agentStatusState, roleProfiles])

  // Vision support — assume true since Magnitude handles model capabilities server-side
  const activeModelSupportsVision = true

  const forkRole = useMemo(() => {
    if (!expandedForkId || !agentStatusState) return null
    const agentId = agentStatusState.agentByForkId.get(expandedForkId)
    const agent = agentId ? agentStatusState.agents.get(agentId) : undefined
    if (!agent) return null
    return agent.role
  }, [expandedForkId, agentStatusState])

  const forkModelSummary = useMemo(() => {
    if (!forkRole) return null
    return { role: labelForRole(forkRole), model: modelNameForRole(forkRole) }
  }, [forkRole, roleProfiles])

  const forkContextHardCap = forkRole ? (roleProfiles?.[forkRole]?.contextWindow ?? null) : null

  const mainTimelineMessages = useMemo(
    () => (activeDisplay?.messages ?? []).filter(m => {
      if (m.type === 'fork_activity') return false
      if (selectedForkId === null && m.type === 'agent_communication') return false
      return true
    }),
    [activeDisplay?.messages, selectedForkId]
  )

  const { visibleItems, hiddenCount, loadMore, hasMore } = usePaginatedTimeline(
    mainTimelineMessages,
    bashOutputs,
    systemMessages
  )

  // Display mode — no expand/collapse, everything inline

  const theme = useTheme()
  const { showCopiedToast: clipboardToast } = useSelectionAutoCopy()

  // Ephemeral status bar message (auto-dismisses)
  const [ephemeralMessage, setEphemeralMessage] = useState<{ text: string; color: string } | null>(null)
  const ephemeralTimerRef = useRef<NodeJS.Timeout | null>(null)

  const showEphemeral = useCallback((message: string, color: string, durationMs = 5000) => {
    if (ephemeralTimerRef.current) clearTimeout(ephemeralTimerRef.current)
    setEphemeralMessage({ text: message, color })
    ephemeralTimerRef.current = setTimeout(() => setEphemeralMessage(null), durationMs)
  }, [])

  useEffect(() => {
    return () => { if (ephemeralTimerRef.current) clearTimeout(ephemeralTimerRef.current) }
  }, [])

  const hasRunningForks = agentStatusState
    ? Array.from(agentStatusState.agents.values()).some(a => a.status === 'working')
    : false

  // Slash command context
  const resetConversation = useCallback(() => {
    if (client) {
      client.dispose()
    }
    onReset()
  }, [client, onReset])

  const showSystemMessage = useCallback((message: string, durationMs = 10000) => {
    const id = createId()
    const existingTimeout = systemMessageTimeoutsRef.current.get(id)
    if (existingTimeout) clearTimeout(existingTimeout)

    setSystemMessages(prev => [...prev, { id, text: message, timestamp: Date.now() }])

    const timeoutId = setTimeout(() => {
      systemMessageTimeoutsRef.current.delete(id)
      setSystemMessages(prev => prev.filter(m => m.id !== id))
    }, durationMs)

    systemMessageTimeoutsRef.current.set(id, timeoutId)
  }, [])

  useEffect(() => {
    return () => {
      for (const timeoutId of systemMessageTimeoutsRef.current.values()) {
        clearTimeout(timeoutId)
      }
      systemMessageTimeoutsRef.current.clear()
    }
  }, [])

  const exitApp = useCallback(() => {
    process.kill(process.pid, 'SIGINT')
  }, [])

  const openRecentChats = useCallback(() => {
    refreshRecentChats()
    setShowRecentChatsOverlay(true)
  }, [refreshRecentChats])

  const modeColor = theme.modeDefault
  const modeLabel = 'Default'

  const enterBashMode = useCallback(() => {
    setBashMode(true)
  }, [])

  const activateSkill = useCallback((skillName: string, skillPath: string | undefined, args: string) => {
    if (!skillPath) {
      showEphemeral(`Failed to activate /${skillName}: missing skill path`, theme.error, 8000)
      return
    }
    clientSend({
      type: 'skill_activated',
      forkId: null,
      skillName,
      skillPath,
      message: args.trim() || null,
      source: 'user',
    })
    logger.info({ skillName, skillPath, hasArgs: !!args.trim() }, 'Skill activated')
  }, [clientSend, showEphemeral, theme.error])

  const initProject = useCallback(() => {
    clientSend({
      type: 'user_message',
      messageId: createId(),
      timestamp: Date.now(),
      forkId: null,
      content: textParts(INIT_PROMPT),
      attachments: [],
      mode: 'text',
      synthetic: false,
      taskMode: false,
    })
    logger.info('Init project activated')
  }, [clientSend])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [])

  const openUsage = useCallback(() => {
    setUsageOpen(true)
  }, [])

  const dispatchErrorAction = useCallback((actionId: ActionId) => {
    switch (actionId) {
      case 'open-settings':
        openSettings()
        return
      case 'open-usage':
        openUsage()
        return
    }
  }, [openSettings, openUsage])

  const onUsageClose = useCallback(() => {
    setUsageOpen(false)
  }, [])

  const exitBashMode = useCallback(() => {
    setBashMode(false)
  }, [])

  const handleResumeChat = useCallback((chat: RecentChat) => {
    hasAnimatedRef.current = true
    setShowRecentChatsOverlay(false)
    onResumeSession(chat.id)
  }, [onResumeSession])

  const hasActivity = hasConversationActivity({
    displayMessageCount: (display?.messages ?? []).length,
    bashOutputCount: bashOutputs.length,
  })

  // Navigation for startup widget (active when no activity, overlay closed, and input empty)
  const widgetNavActive = !showRecentChatsOverlay && !hasActivity && !composerHasContent
  const widgetNavigation = useRecentChatsNavigation(
    recentChats ? recentChats.slice(0, 5) : [],
    handleResumeChat,
    widgetNavActive,
  )

  useEffect(() => {
    if (showRecentChatsOverlay) {
      setRecentChatsSelectedIndex(0)
    }
  }, [showRecentChatsOverlay])

  const onSettingsClose = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  const toggleAutopilot = useCallback(() => {
    clientSend({
      type: 'autopilot_toggled',
      forkId: null,
      enabled: !autopilotEnabled,
    })
  }, [clientSend, autopilotEnabled])

  const commandContext: CommandContext = useMemo(() => ({
    resetConversation,
    showSystemMessage: (msg: string) => showEphemeral(msg, theme.error, 8000),
    exitApp,
    openRecentChats,
    enterBashMode,
    activateSkill,
    initProject,
    openSettings,
    openUsage,
    toggleAutopilot,
  }), [resetConversation, showEphemeral, theme.error, exitApp, openRecentChats, enterBashMode, activateSkill, initProject, openSettings, openUsage, toggleAutopilot])



  const handleStartImageDescription = useCallback((dataUrl: string) => {
    const effect = Effect.flatMap(ImageDescriptionServiceTag, service => service.start(dataUrl))
    if (client) {
      client.runEffect(effect).catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, '[describe-image] Failed to start image description')
      })
      return
    }
    ensureClientReady()
      .then(({ client }) => client.runEffect(effect))
      .catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, '[describe-image] Failed to start image description')
      })
  }, [client, ensureClientReady])

  const handleCancelImageDescription = useCallback((dataUrl: string) => {
    const effect = Effect.flatMap(ImageDescriptionServiceTag, service => service.cancel(dataUrl))
    if (client) {
      client.runEffect(effect).catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, '[describe-image] Failed to cancel image description')
      })
      return
    }
    ensureClientReady()
      .then(({ client }) => client.runEffect(effect))
      .catch((err) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, '[describe-image] Failed to cancel image description')
      })
  }, [client, ensureClientReady])

  const handleInterruptFork = useCallback((forkId: string | null) => {
    if (!client) return
    logger.info({ forkId }, 'Sending interrupt event')
    client.send({ type: 'interrupt', forkId })
  }, [client])

  const handleInterrupt = useCallback(() => {
    handleInterruptFork(null)
  }, [handleInterruptFork])

  const handleInterruptAll = useCallback(() => {
    if (!client) return
    logger.info('Interrupt all: interrupting all workers')
    // Interrupt root with allKilled flag
    client.send({ type: 'interrupt', forkId: null, allKilled: true })
    // Interrupt every running fork
    if (agentStatusState) {
      for (const agent of agentStatusState.agents.values()) {
        if (agent.status === 'working') {
          client.send({ type: 'interrupt', forkId: agent.forkId })
        }
      }
    }
  }, [client, agentStatusState])

  const activeOverlayKind =
    showRecentChatsOverlay ? 'recent-chats'
    : (expandedForkId && client) ? 'fork-detail'
    : settingsOpen ? 'settings'
    : usageOpen ? 'usage'
    : 'none'

  const isOverlayActive = activeOverlayKind !== 'none'
  const isBlockingOverlayActive = isOverlayActive
  const canToggleRecentChatsWithCtrlR = activeOverlayKind === 'none' || activeOverlayKind === 'recent-chats'

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.defaultPrevented) return

        const isCtrlC = key.ctrl && key.name === 'c' && !key.meta && !key.option
        const isCtrlX = key.ctrl && key.name === 'x' && !key.meta && !key.option
        const isCtrlR = key.ctrl && key.name === 'r' && !key.meta && !key.option
        const isCtrlT = key.ctrl && key.name === 't' && !key.meta && !key.option

        if (isCtrlC) {
          if (composerHasContent) return
          if ((activeDisplay ?? display)?.status === 'streaming') return
          key.preventDefault()
          process.kill(process.pid, 'SIGINT')
          return
        }

        if (isCtrlX && debugMode) {
          key.preventDefault()
          setDebugPanelVisible(prev => !prev)
          return
        }

        if (isCtrlR) {
          if (!canToggleRecentChatsWithCtrlR) return
          key.preventDefault()
          hasAnimatedRef.current = true
          setShowRecentChatsOverlay(prev => !prev)
        }

        if (isCtrlT) {
          key.preventDefault()
          setDisplayMode(prev => prev === 'default' ? 'transcript' : 'default')
        }
      },
      [composerHasContent, debugMode, activeDisplay, display, canToggleRecentChatsWithCtrlR],
    ),
  )

  // Find the most recent inline error with an action CTA — its chord is the
  // active shortcut. Older actionable errors are still clickable via mouse,
  // but their chord is shadowed by the most recent.
  const latestActionableErrorCta = useMemo(() => {
    const messages = (activeDisplay ?? display)?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === 'error' && m.cta?.kind === 'action') return m.cta
    }
    return null
  }, [activeDisplay, display])

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.defaultPrevented) return
        if (activeOverlayKind !== 'none') return
        if (!latestActionableErrorCta) return
        const chord = matchKeyToChord(key)
        if (chord !== latestActionableErrorCta.chord) return
        key.preventDefault()
        dispatchErrorAction(latestActionableErrorCta.actionId)
      },
      [activeOverlayKind, latestActionableErrorCta, dispatchErrorAction],
    ),
  )


  const {
    selectedFile,
    selectedFileContent,
    selectedFileStreaming,
    selectedFileResolvedPath,
    isOpen: isFilePanelOpen,
    canRenderPanel,
    openFile,
    closeFilePanel,
  } = useFilePanel({
    display: activeDisplay ?? display,
    toolState,
    scratchpadPath,
    projectRoot: process.cwd(),
  })

  // Derive chain stats from display state — scoped to current chain
  const chainStats = useMemo(() => {
    const displayState = activeDisplay ?? display
    return computeChainStats(displayState)
  }, [activeDisplay, display])

  // Check if the last message is an interrupted display and agent is idle —
  // it should be shown in the WorkingTimer slot instead of the scrollbox
  const lastInterruptedMessage: InterruptedMessage | null = useMemo(() => {
    const displayState = activeDisplay ?? display
    if (displayState?.status !== 'idle') return null
    const messages = displayState?.messages ?? []
    if (messages.length === 0) return null
    const last = messages[messages.length - 1]
    return last.type === 'interrupted' ? last : null
  }, [activeDisplay, display])

  // Detect if the agent is actively thinking (last non-queued message is a thinking block)
  const isThinking = useMemo(() => {
    const displayState = activeDisplay ?? display
    if (displayState?.status !== 'streaming') return false
    const messages = displayState?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type !== 'queued_user_message') {
        return messages[i].type === 'thinking'
      }
    }
    return false
  }, [activeDisplay, display])

  // Detect if a worker is being started (spawnWorker tool not yet completed)
  const isWorkerStarting = useMemo(() => {
    const displayState = activeDisplay ?? display
    if (displayState?.status !== 'streaming') return false
    const messages = displayState?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.type === 'tool' && msg.toolKey === 'spawnWorker') {
        const phase = (msg.state as any)?.phase
        return phase === 'streaming' || phase === 'executing'
      }
    }
    return false
  }, [activeDisplay, display])

  // Scroll-tracking for sticky header
  const scrollboxRef = useRef<any>(null)

  const lastStreamingMessageIdRef = useRef<string | null>(null)
  const interruptedMessageIdRef = useRef<string | null>(null)


  const snapChatToBottom = useCallback(() => {
    const scrollbox = scrollboxRef.current
    if (!scrollbox) return

    // OpenTUI ScrollBoxRenderable API: use scrollTo(...); scrollTop is a minimal fallback.
    if (typeof scrollbox.scrollTo === 'function') {
      scrollbox.scrollTo(Number.MAX_SAFE_INTEGER)
      return
    }

    if (typeof scrollbox.scrollTop === 'number') {
      scrollbox.scrollTop = Number.MAX_SAFE_INTEGER
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => snapChatToBottom(), 0)
    return () => clearTimeout(t)
  }, [selectedForkId, snapChatToBottom])

  const selectedForkContentVersion = useMemo(
    () => getSelectedForkContentVersion(selectedForkId, forkDisplay),
    [selectedForkId, forkDisplay]
  )

  useEffect(() => {
    if (!selectedForkId) return

    const t1 = setTimeout(() => snapChatToBottom(), 0)
    const t2 = setTimeout(() => snapChatToBottom(), 50)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [selectedForkContentVersion, selectedForkId, snapChatToBottom])

  const handleSubmitViaClientBoundary = useCallback((payload: {
    forkId: string | null
    message: string
    attachments: Attachment[]
  }) => {
    clientSend({
      type: 'user_message',
      messageId: createId(),
      timestamp: Date.now(),
      forkId: payload.forkId,
      content: textParts(payload.message),
      attachments: payload.attachments,
      mode: 'text',
      synthetic: false,
      taskMode: false,
    })
  }, [clientSend])

  if (process.platform === 'win32') {
    return (
      <WindowsWarningScreen onExit={exitApp} />
    )
  }

  if (auth.loaded && !auth.key) {
    return (
      <MagnitudeLoginScreen
        onSubmit={auth.save}
        onExit={exitApp}
      />
    )
  }

  if (!display) {
    return (
      <SessionLoadingView
        sessionSelection={sessionSelection}
        recentChats={recentChats}
      />
    )
  }

  const overlayContent = (
    <AppOverlays
      displayMode={displayMode}
      settingsVisible={settingsOpen}
      onSettingsClose={onSettingsClose}
      auth={auth}
      roles={rolesData}
      showRecentChatsOverlay={showRecentChatsOverlay}
      recentChats={recentChats}
      recentChatsSelectedIndex={recentChatsSelectedIndex}
      setRecentChatsSelectedIndex={setRecentChatsSelectedIndex}
      setShowRecentChatsOverlay={setShowRecentChatsOverlay}
      handleResumeChat={handleResumeChat}
      expandedForkId={expandedForkId}
      client={client}
      agentStatusState={agentStatusState}
      forkModelSummary={forkModelSummary}
      forkContextHardCap={forkContextHardCap}
      popForkOverlay={popForkOverlay}
      pushForkOverlay={pushForkOverlay}
      scratchpadPath={scratchpadPath}
      projectRoot={process.cwd()}
      showCopiedToast={clipboardToast}
      usageVisible={usageOpen}
      onUsageClose={onUsageClose}
      onErrorAction={dispatchErrorAction}
    />
  )

  const chatScrollbox = (
    <scrollbox
      ref={scrollboxRef}
      focusable={false}
      stickyScroll
      stickyStart="bottom"
      scrollX={false}
      scrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        visible: display.status === 'idle',
        trackOptions: { width: 1 },
      }}
      style={{
        flexGrow: 1,
        rootOptions: {
          flexGrow: 1,
          backgroundColor: 'transparent',
        },
        wrapperOptions: {
          border: false,
          backgroundColor: 'transparent',
        },
        contentOptions: {
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          justifyContent: 'flex-end',
        },
      }}
    >
      <box style={{ paddingLeft: 1, paddingBottom: 1 }}>
        <AnimatedLogo />
      </box>

      <box style={{ paddingLeft: 1, flexDirection: 'row' }}>
        <text style={{ fg: theme.muted }}>Current directory: </text>
        <text style={{ fg: theme.muted }} attributes={TextAttributes.BOLD}>{process.cwd().replace(process.env.HOME || '', '~')}</text>
      </box>

      <box style={{ paddingLeft: 1, paddingBottom: (hasActivity || (recentChats !== null && recentChats.length === 0)) ? 1 : 0, flexDirection: 'row' }}>
        <text style={{ fg: theme.foreground }} attributes={TextAttributes.BOLD}>Tip: </text>
        <text style={{ fg: theme.muted }}>Use </text>
        <text style={{ fg: theme.foreground }}>/settings</text>
        <text style={{ fg: theme.muted }}> to view your connection and roles.</text>
      </box>

      {!hasActivity && (
        <box style={{ paddingLeft: 1 }}>
          <RecentChatsWidget
            chats={recentChats ? recentChats.slice(0, 5) : []}
            loading={recentChats === null}
            selectedIndex={widgetNavigation.selectedIndex}
            onSelect={handleResumeChat}
            onHoverIndex={widgetNavigation.setSelectedIndex}
            onOpenAll={openRecentChats}
            isNavigationActive={widgetNavActive}
          />
        </box>
      )}

      {hasMore && (
        <LoadPreviousButton hiddenCount={hiddenCount} onLoadMore={loadMore} />
      )}
      <ChatTimeline
        items={visibleItems}
        displayMode={displayMode}
        isStreaming={display?.status === 'streaming'}
        streamingMessageId={display?.streamingMessageId ?? null}
        lastInterruptedMessage={lastInterruptedMessage}
        interruptedMessageId={interruptedMessageIdRef.current}
        chatColumnWidth={chatColumnWidth}
        themeErrorColor={theme.error}
        themeMutedColor={theme.muted}
        onFileClick={openFile}
        onForkExpand={pushForkOverlay}
        onErrorAction={dispatchErrorAction}
      />
      {selectedForkId !== null && (
        <PendingCommunicationsPanel
          messages={activeDisplay?.pendingInboundCommunications ?? []}
          onFileClick={openFile}
        />
      )}
    </scrollbox>
  )



  const composerCanFocus = !showRecentChatsOverlay
    && !settingsOpen
    && !usageOpen
    && expandedForkId === null

  const debugVisible = debugMode && debugPanelVisible
  return (
    <SelectedFileProvider value={selectedFile}>
    {isOverlayActive && overlayContent}
    <box style={{ visible: !isOverlayActive, flexDirection: 'row', height: '100%', paddingBottom: 0, marginBottom: 0 }}>
      {/* Left column — debug panel (only when enabled and visible) */}
      {debugVisible && (
        <box style={{ width: '35%', flexShrink: 0, paddingLeft: 1, paddingBottom: 1 }}>
          <DebugPanel debugSnapshot={debugSnapshot} events={debugEvents} logs={debugLogs} onToggle={() => setDebugPanelVisible(false)} />
        </box>
      )}

      {/* Center column — chat, status bar, input, footer */}
      <box
        ref={chatColumn.ref}
        onSizeChange={chatColumn.onSizeChange}
        style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, position: 'relative', height: '100%', paddingBottom: 0, marginBottom: 0 }}
      >
        <box style={{ flexGrow: 1, minHeight: 0, flexDirection: 'column' }}>
          {chatScrollbox}
          {autopilotCountdown.isRunning && autopilotCountdown.content && autopilotCountdown.startTime && (
            <AutopilotPreviewMessage
              content={autopilotCountdown.content}
              startTime={autopilotCountdown.startTime}
            />
          )}
          <WorkingTimer
            chainStartTime={display?.chainStartTime ?? null}
            chainStatus={display?.chainStatus ?? null}
            chainEndTime={display?.chainEndTime ?? null}
            chainStats={chainStats}
            interruptedMessage={lastInterruptedMessage}
            isThinking={isThinking}
            isWorkerStarting={isWorkerStarting}
          />
          <ChatController
            isBlockingOverlayActive={isBlockingOverlayActive}
            env={{
              status: (activeDisplay ?? display)?.status ?? 'idle',
              hasRunningForks,
              bashMode,
              modelsConfigured: true,
              modelSummary: activeModelSummary,
              tokenUsage: selectedForkId
                ? (forkTokenEstimate > 0 ? forkTokenEstimate : null)
                : tokenUsage,
              contextHardCap,
              isCompacting: selectedForkId ? forkIsCompacting : isCompacting,
              theme,
              modeColor,
              attachmentsMaxWidth,
              composerCanFocus,
              widgetNavActive,
              isWorkerView: selectedForkId !== null,
              supportsVision: activeModelSupportsVision,
              autopilotEnabled,
              autopilotGenerating,
              displayMode,
            }}
            services={{
              submitUserMessageToFork: ({ forkId, message, attachments }) => handleSubmitViaClientBoundary({ forkId, message, attachments }),
              runSlashCommand: (commandText: string) => routeSlashCommand(commandText, commandContext),
              executeBash: async (command: string) => {
                const { scratchpadPath: wp } = await ensureClientReady()
                return executeBashCommand(command, {
                  scratchpadPath: wp!,
                  projectRoot: process.cwd(),
                })
              },
              appendBashOutput: (result) => setBashOutputs(prev => [...prev, result]),
              recordBashCommand: (result) => {
                clientSend({
                  type: 'user_bash_command',
                  forkId: null,
                  timestamp: result.timestamp,
                  command: result.command,
                  cwd: result.cwd,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                })
              },
              clearSystemBanners: () => {
                setSystemMessages([])
                for (const timeoutId of systemMessageTimeoutsRef.current.values()) {
                  clearTimeout(timeoutId)
                }
                systemMessageTimeoutsRef.current.clear()
                if (ephemeralTimerRef.current) clearTimeout(ephemeralTimerRef.current)
                setEphemeralMessage(null)
              },
              interruptFork: handleInterruptFork,
              interruptAll: handleInterruptAll,
              openSettings,

              handleWidgetKeyEvent: widgetNavigation.handleKeyEvent,
              enterBashMode: () => setBashMode(true),
              exitBashMode: exitBashMode,
              requestIdleWorkerClose: ({ forkId, agentId }) => {
                const agent = agentStatusState
                  ? Array.from(agentStatusState.agents.values()).find((a) => a.forkId === forkId && a.agentId === agentId)
                  : undefined
                const parentForkId = agent?.parentForkId ?? null
                client?.send({
                  type: 'worker_idle_closed',
                  forkId,
                  parentForkId,
                  agentId,
                  source: 'idle_tab_close',
                })
              },
              requestActiveWorkerKill: ({ forkId, agentId }) => {
                const agent = agentStatusState
                  ? Array.from(agentStatusState.agents.values()).find((a) => a.forkId === forkId && a.agentId === agentId)
                  : undefined
                const parentForkId = agent?.parentForkId ?? null
                client?.send({
                  type: 'worker_user_killed',
                  forkId,
                  parentForkId,
                  agentId,
                  source: 'tab_close_confirm',
                })
              },
              showToast: (message: string) => showEphemeral(message, theme.error, 5000),
              toggleAutopilot,
              startImageDescription: handleStartImageDescription,
              cancelImageDescription: handleCancelImageDescription,
            }}
            displayMessages={(activeDisplay ?? display).messages}
            tasks={tasks}
            selectedForkId={selectedForkId}
            pushForkOverlay={pushForkOverlay}
            roleProfiles={roleProfiles}
            subscribeForkCompaction={subscribeForkCompaction}
            subscribeForkWindow={subscribeForkWindow}
            selectedFileOpen={isFilePanelOpen}
            onCloseFilePanel={closeFilePanel}
            onInputHasTextChange={setComposerHasContent}
            restoredQueuedInputText={restoredQueuedInputText}
            onRestoredQueuedInputHandled={() => setRestoredQueuedInputText(null)}
          />
        </box>

        {/* Clipboard copy toast — bottom-right overlay */}
        {clipboardToast && (
          <box style={{ position: 'absolute', bottom: 1, right: 2 }}>
            <box style={{
              borderStyle: 'single',
              border: ['left'],
              borderColor: theme.success,
              customBorderChars: { ...BOX_CHARS, vertical: '┃' },
            }}>
              <box style={{
                backgroundColor: theme.surface,
                paddingTop: 1,
                paddingBottom: 1,
                paddingLeft: 2,
                paddingRight: 2,
              }}>
                <text style={{ fg: theme.success }}>Copied to clipboard</text>
              </box>
            </box>
          </box>
        )}

        {/* Ephemeral toast — bottom-right overlay */}
        {ephemeralMessage && (
          <box style={{ position: 'absolute', bottom: 1, right: 2 }}>
            <box style={{
              borderStyle: 'single',
              border: ['left'],
              borderColor: ephemeralMessage.color,
              customBorderChars: { ...BOX_CHARS, vertical: '┃' },
            }}>
              <box style={{
                backgroundColor: theme.surface,
                paddingTop: 1,
                paddingBottom: 1,
                paddingLeft: 2,
                paddingRight: 2,
              }}>
                <text style={{ fg: ephemeralMessage.color }}>{ephemeralMessage.text}</text>
              </box>
            </box>
          </box>
        )}



      </box>

      {canRenderPanel && selectedFile && (
        <box style={{ width: '45%', flexShrink: 0, paddingRight: 1, paddingBottom: 1 }}>
          <FileViewerPanel
            key={selectedFile.path}
            filePath={selectedFile.path}
            content={selectedFileContent}
            scrollToSection={selectedFile.section}
            onClose={closeFilePanel}
            onOpenFile={openFile}
            streaming={selectedFileStreaming}
          />
        </box>
      )}

    </box>
    </SelectedFileProvider>
  )
}
