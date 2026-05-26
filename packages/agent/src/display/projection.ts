/**
 * DisplayProjection (Forked)
 *
 * UI state with flat messages, per-fork.
 * Each fork has independent display state for its conversation.
 *
 * Key invariants:
 * - Queued messages always appear at the END of the message list
 * - New content (assistant messages, thinking, tools) is inserted BEFORE queued messages
 * - Queued messages are promoted to user_message on turn_started
 */

import { Signal, Projection } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'
import { textOf } from '../content'
import { outcomeWillChainContinue } from '../events'

import { AgentRoutingProjection } from '../projections/agent-routing'
import { AgentStatusProjection, getAgentByForkId, type AgentStatusState } from '../projections/agent-status'
import { UserMessageResolutionProjection } from '../projections/user-message-resolution'
import { TurnProjection } from '../projections/turn'
import { HarnessStateProjection, getToolHandlesRecord } from '../projections/harness-state'

import { HIDDEN_TOOLS } from '../tools/toolkits'

import {
  UserMessageDisplay,
  QueuedUserMessageDisplay,
  AssistantMessageDisplay,
  ThinkingMessage,
  ToolMessage,
  StatusIndicatorMessage,
  WorkerResumedMessage,
  WorkerFinishedMessage,
  WorkerKilledMessage,
  WorkerUserKilledMessage,
  DisplayState,
  DisplayMessage,
  ErrorDisplayMessage,
  ForkActivityMessage,
  PendingInboundCommunicationDisplay,
  AgentCommunicationMessage,
} from './types'

import {
  generateId,
  getVisualState,
  insertBeforeQueuedMessages,
  findInsertionIndex,
  toErrorDisplayMessage,
  moveMessageToEndBeforeQueue,
  toPreview,
  updateMessageById,
} from './helpers/messages'
import type { ToolKey } from '../tools/toolkits'

import { processThinkingChunk, heldBuffers, flushLastThinking, removeEmptyThinkingMessages, findLastNonQueuedIndex } from './helpers/thinking'

import {
  incrementToolCount,
  findLastIndex,
  totalToolsUsed,
  upsertStreamingCommunicationStep,
  finalizeCommunicationStreamInFork,
} from './helpers/fork-activity'

import { finalizeOpenToolMessagesAsInterrupted } from './helpers/interrupt'

import { EMPTY_TOOL_COUNTS } from './constants'


function anyAgentsWorking(agentState: AgentStatusState): boolean {
  for (const agent of agentState.agents.values()) {
    if (agent.status === 'working') return true
  }
  return false
}

function closeChain(fork: DisplayState, timestamp: number): DisplayState {
  if (fork.chainStatus !== 'active') return fork
  return {
    ...fork,
    chainStatus: 'completed',
    chainEndTime: timestamp,
  }
}

function getToolCluster(toolKey: ToolKey): string | undefined {
  switch (toolKey) {
    case 'fileRead': return 'read'
    case 'fileSearch': return 'search'
    case 'webSearch': return 'web_search'
    case 'webFetch': return 'web_fetch'
    case 'fileTree': return 'tree'
    case 'fileView': return 'view'
    default: return undefined
  }
}

// Standalone signal definition (needed for self-referencing in signalHandlers)
const forkToolStepSignalDef = Signal.create<{ forkId: string | null; toolKey: import('../tools/toolkits').ToolKey }>('Display/forkToolStep')
// Convert to Signal for use in signalHandlers on() calls (which expect Signal, not SignalDef)
const forkToolStepSignal = Signal.fromDef<{ forkId: string | null; toolKey: import('../tools/toolkits').ToolKey }, unknown>(forkToolStepSignalDef, 'Display')

export const DisplayProjection = Projection.defineForked<AppEvent, DisplayState>()({
  name: 'Display',

  ambients: [],

  reads: [AgentRoutingProjection, AgentStatusProjection, UserMessageResolutionProjection, TurnProjection, HarnessStateProjection] as const,

  initialFork: {
    status: 'idle',
    messages: [],
    pendingInboundCommunications: [],
    currentTurnId: null,
    streamingMessageId: null,
    showButton: 'send',
    chainStartTime: null,
    chainStatus: null,
    chainEndTime: null,
  },

  signals: {
    restoreQueuedMessages: Signal.create<{ forkId: string | null; messages: string[] }>('Display/restoreQueuedMessages'),
    forkToolStep: forkToolStepSignalDef
  },

  eventHandlers: {

    skill_activated: ({ event, fork }) => {
      // Only show as user message when activated by user slash command
      if (event.source !== 'user') return fork

      const messageId = generateId()
      const content = event.message ? `/${event.skillName} ${event.message}` : `/${event.skillName}`
      return {
        ...fork,
        messages: [
          ...fork.messages,
          {
            id: messageId,
            type: 'user_message' as const,
            content,
            timestamp: event.timestamp,
            taskMode: false,
            attachments: [],
          }
        ]
      }
    },

    turn_started: ({ event, fork }) => {
      // Check if there are queued messages to promote
      const hasQueuedMessages = fork.messages.some(m => m.type === 'queued_user_message')

      // If promoting queued messages, flush thinking and remove empty thinking first
      const messagesBeforePromotion = hasQueuedMessages
        ? removeEmptyThinkingMessages(flushLastThinking(fork.messages))
        : fork.messages

      // Promote queued messages to user messages
      const messages = messagesBeforePromotion.map(msg => {
        if (msg.type === 'queued_user_message') {
          return {
            ...msg,
            type: 'user_message' as const
          }
        }
        return msg
      })

      const stateWithMessages = { ...fork, messages }

      // Start chain if not already active
      const chainStarting = stateWithMessages.chainStatus !== 'active'
      return {
        ...stateWithMessages,
        currentTurnId: event.turnId,
        status: 'streaming' as const,
        showButton: 'stop' as const,
        pendingInboundCommunications: [],
        ...(chainStarting ? {
          chainStartTime: event.timestamp,
          chainStatus: 'active' as const,
          chainEndTime: null,
        } : {}),
      }
    },

    message_start: ({ event, fork }) => {
      // Ignore if not for current turn
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      // Skip messages not targeting user
      if (event.destination.kind !== 'user') {
        return fork
      }

      // Flush any thinking before starting assistant message
      const flushedMessages = flushLastThinking(fork.messages)

      const msgId = generateId()
      const assistantMessage: AssistantMessageDisplay = {
        id: msgId,
        type: 'assistant_message',
        content: '',
        timestamp: event.timestamp
      }

      const messages = insertBeforeQueuedMessages(flushedMessages, assistantMessage)

      return {
        ...fork,
        streamingMessageId: msgId,
        messages
      }
    },

    message_chunk: ({ event, fork }) => {
      // Ignore if not for current turn
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      // Append chunk to current streaming message (if any)
      if (!fork.streamingMessageId) {
        return fork
      }
      return {
        ...fork,
        messages: updateMessageById<AssistantMessageDisplay>(
          fork.messages,
          fork.streamingMessageId,
          (msg) => ({ ...msg, content: msg.content + event.text })
        )
      }
    },

    message_end: ({ event, fork }) => {
      // Ignore if not for current turn
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      // Drop whitespace-only assistant messages — they serve no visual purpose
      // and would otherwise break tool clustering and create ghost spacing.
      if (fork.streamingMessageId) {
        const msg = fork.messages.find(m => m.id === fork.streamingMessageId)
        if (msg && msg.type === 'assistant_message' && !msg.content.trim()) {
          return {
            ...fork,
            messages: fork.messages.filter(m => m.id !== fork.streamingMessageId),
            streamingMessageId: null,
          }
        }
      }

      return {
        ...fork,
        streamingMessageId: null
      }
    },

    thinking_chunk: ({ event, fork }) => {
      // Ignore if not for current turn
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      // Find the last non-queued message
      const lastIdx = findLastNonQueuedIndex(fork.messages)
      const lastMsg = lastIdx >= 0 ? fork.messages[lastIdx] : undefined

      // If last non-queued message is thinking, append to it
      if (lastMsg?.type === 'thinking') {
        const { contentToAppend, shouldSuppress } = processThinkingChunk(lastMsg, event.text)

        if (shouldSuppress) {
          // Remove the empty thinking message entirely
          heldBuffers.delete(lastMsg.id)
          const newMessages = fork.messages.filter(m => m.id !== lastMsg.id)
          return { ...fork, messages: newMessages }
        }

        if (contentToAppend === '') {
          // Nothing visible to append, still buffering
          return fork
        }

        const newMessages = [...fork.messages]
        newMessages[lastIdx] = { ...lastMsg, content: lastMsg.content + contentToAppend }
        return { ...fork, messages: newMessages }
      }

      // Create new thinking message
      const stepId = generateId()
      const tempStep: ThinkingMessage = {
        id: stepId,
        type: 'thinking',
        content: '',
        timestamp: event.timestamp,
      }
      const { contentToAppend, shouldSuppress } = processThinkingChunk(tempStep, event.text)

      if (shouldSuppress) {
        heldBuffers.delete(stepId)
        return fork
      }

      if (contentToAppend === '' && heldBuffers.has(stepId)) {
        // Only buffered content — add empty thinking message so future chunks can find it
        const thinkingMsg: ThinkingMessage = {
          id: stepId,
          type: 'thinking',
          content: '',
          timestamp: event.timestamp,
        }
        return {
          ...fork,
          messages: insertBeforeQueuedMessages(fork.messages, thinkingMsg)
        }
      }

      const thinkingMsg: ThinkingMessage = {
        id: stepId,
        type: 'thinking',
        content: contentToAppend,
        timestamp: event.timestamp,
      }
      return {
        ...fork,
        messages: insertBeforeQueuedMessages(fork.messages, thinkingMsg)
      }
    },

    tool_event: ({ event, fork, read, emit }) => {
      const inner = event.event
      const harnessState = read(HarnessStateProjection)
      const toolStateFork = { toolHandles: harnessState ? getToolHandlesRecord(harnessState) : {} }
      switch (inner._tag) {
        case 'ToolInputStarted': {
          // Emit signal for parent fork activity tracking (before any early returns)
          emit.forkToolStep({ forkId: event.forkId, toolKey: event.toolKey })

          // Ignore if not for current turn
          if (fork.currentTurnId !== event.turnId) {
            return fork
          }

          // Skip hidden tools
          if (HIDDEN_TOOLS.has(event.toolKey)) {
            return fork
          }

          // Flush any thinking before adding tool
          const flushedMessages = flushLastThinking(fork.messages)
          const toolMsg: ToolMessage = {
            id: event.toolCallId,
            type: 'tool',
            toolKey: event.toolKey,
            cluster: getToolCluster(event.toolKey),
            state: getVisualState(toolStateFork, event.toolCallId),
            filter: null,
            resultFilePath: null,
            timestamp: event.timestamp,
          }
          return {
            ...fork,
            messages: insertBeforeQueuedMessages(flushedMessages, toolMsg)
          }
        }

        case 'ToolInputReady': {
          if (fork.currentTurnId !== event.turnId) return fork

          return {
            ...fork,
            messages: updateMessageById<ToolMessage>(
              fork.messages,
              event.toolCallId,
              (msg) => ({
                ...msg,
                state: getVisualState(toolStateFork, event.toolCallId) ?? msg.state,
              })
            )
          }
        }

        case 'ToolExecutionEnded': {
          // Ignore if not for current turn
          if (fork.currentTurnId !== event.turnId) {
            return fork
          }

          // Skip hidden tools
          if (HIDDEN_TOOLS.has(event.toolKey)) {
            return fork
          }

          return {
            ...fork,
            messages: updateMessageById<ToolMessage>(
              fork.messages,
              event.toolCallId,
              (msg) => ({
                ...msg,
                state: getVisualState(toolStateFork, event.toolCallId) ?? msg.state,
              })
            )
          }
        }

        default: {
          if (fork.currentTurnId !== event.turnId) return fork

          const vs = getVisualState(toolStateFork, event.toolCallId)
          if (!vs) return fork

          return {
            ...fork,
            messages: updateMessageById<ToolMessage>(
              fork.messages,
              event.toolCallId,
              (msg) => ({ ...msg, state: vs })
            )
          }
        }
      }
    },

    turn_outcome: ({ event, fork, read }) => {
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      if (event.outcome._tag === 'Completed' && outcomeWillChainContinue(event.outcome)) {
        // Turn will chain-continue (has tool calls and no yield target) —
        // keep state open for the next turn to reuse.
        return {
          ...fork,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      if (event.outcome._tag === 'ConnectionFailure') {
        // Flush thinking, add status indicator message
        const flushedMessages = flushLastThinking(fork.messages)
        const statusMsg: StatusIndicatorMessage = {
          type: 'status_indicator' as const,
          id: generateId(),
          message: 'Connection issue: retrying',
          style: 'dim' as const,
          timestamp: event.timestamp,
        }
        return {
          ...fork,
          messages: insertBeforeQueuedMessages(flushedMessages, statusMsg),
        }
      }

      if (event.outcome._tag === 'Overthinking') {
        // Flush thinking, add status indicator, clean up
        const flushedMessages = flushLastThinking(fork.messages)
        const statusMsg: StatusIndicatorMessage = {
          type: 'status_indicator' as const,
          id: generateId(),
          message: `Thinking exceeded ${event.outcome.limit} character limit — continuing with feedback`,
          style: 'dim' as const,
          timestamp: event.timestamp,
        }
        const withIndicator = insertBeforeQueuedMessages(flushedMessages, statusMsg)
        const cleanedMessages = removeEmptyThinkingMessages(withIndicator)
        return {
          ...fork,
          messages: cleanedMessages,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      // Flush thinking and remove empty thinking messages
      const flushedMessages = flushLastThinking(fork.messages)
      const cleanedMessages = removeEmptyThinkingMessages(flushedMessages)
      const cleanedState = { ...fork, messages: cleanedMessages }

      // Close chain if no agents are still working — the chain is complete.
      let withChain: DisplayState = cleanedState
      if (cleanedState.chainStatus === 'active') {
        const agentState = read(AgentStatusProjection)
        if (!anyAgentsWorking(agentState)) {
          withChain = closeChain(cleanedState, event.timestamp)
        }
      }

      const finalizedMessages = finalizeOpenToolMessagesAsInterrupted(
        withChain.messages,
        (_toolKey, currentState, stepId) => {
          if (!stepId) return currentState
          if (currentState && typeof currentState === 'object' && 'phase' in currentState) {
            return { ...currentState, phase: 'interrupted' as const }
          }
          return currentState
        }
      )
      withChain = { ...withChain, messages: finalizedMessages }

      if (event.outcome._tag === 'Completed') {
        return {
          ...withChain,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      if (event.outcome._tag === 'Cancelled') {
        const alreadyInterrupted = withChain.messages.some(
          (message) => message.type === 'interrupted' && message.timestamp === event.timestamp,
        )
        return {
          ...withChain,
          messages: alreadyInterrupted
            ? withChain.messages
            : [
                ...withChain.messages,
                {
                  id: generateId(),
                  type: 'interrupted' as const,
                  timestamp: event.timestamp,
                  context: event.forkId === null ? 'root' as const : 'fork' as const,
                },
              ],
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      if (
        event.outcome._tag === 'ParseFailure'
        || event.outcome._tag === 'ContextWindowExceeded'
      ) {
        return {
          ...withChain,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      const errorMessage = toErrorDisplayMessage(event.outcome, event.timestamp)

      return {
        ...withChain,
        messages: errorMessage ? [...withChain.messages, errorMessage] : withChain.messages,
        currentTurnId: null,
        status: 'idle' as const,
        streamingMessageId: null,
        showButton: 'send' as const
      }
    },

    compaction_failed: ({ event, fork }) => {
      if (!event.presentation || event.presentation.surface !== 'inline') return fork

      const errorMsg: ErrorDisplayMessage = {
        id: generateId(),
        type: 'error',
        message: event.presentation.message,
        timestamp: event.timestamp,
        cta: event.presentation.cta,
      }

      return {
        ...fork,
        messages: [...fork.messages, errorMsg],
      }
    },

    interrupt: ({ event, fork, emit, read }) => {
      // Find queued messages before removing them
      const queuedMessages = fork.messages.filter(
        (m): m is QueuedUserMessageDisplay => m.type === 'queued_user_message'
      )

      // Emit restore signal if there are queued messages
      if (queuedMessages.length > 0) {
        emit.restoreQueuedMessages({
          forkId: event.forkId,
          messages: queuedMessages.map(m => m.content)
        })
      }

      // Finalize any still-open tool steps as interrupted
      const harnessState = read(HarnessStateProjection)
      const toolStateFork = { toolHandles: harnessState ? getToolHandlesRecord(harnessState) : {} }
      const interruptedToolMessages = finalizeOpenToolMessagesAsInterrupted(
        fork.messages,
        (_toolKey, currentState, stepId) => {
          if (!stepId) return currentState
          return toolStateFork.toolHandles[stepId]?.state ?? currentState
        }
      )
      const stateWithInterruptedTools = { ...fork, messages: interruptedToolMessages }

      // Flush thinking and remove empty thinking
      const flushedMessages = flushLastThinking(stateWithInterruptedTools.messages)
      const cleanedMessages = removeEmptyThinkingMessages(flushedMessages)
      const cleanedState = { ...stateWithInterruptedTools, messages: cleanedMessages }

      // Close chain on interrupt
      const closedState = cleanedState.chainStatus === 'active' ? closeChain(cleanedState, event.timestamp) : cleanedState
      const messagesWithoutQueued = closedState.messages.filter(
        m => m.type !== 'queued_user_message'
      )

      return {
        ...closedState,
        currentTurnId: null,
        status: 'idle' as const,
        streamingMessageId: null,
        showButton: 'send' as const,
        messages: [
          ...messagesWithoutQueued,
          {
            id: generateId(),
            type: 'interrupted' as const,
            timestamp: event.timestamp,
            context: event.forkId === null ? 'root' as const : 'fork' as const,
            ...(event.allKilled ? { allKilled: true } : {}),
          }
        ]
      }
    },

    agent_created: ({ event, fork }) => {
      if (event.message === null) return fork
      const content = event.message.trim()
      if (!content) return fork
      if (event.forkId === null) return fork

      // Flush thinking and add communication message directly
      const flushedMessages = flushLastThinking(fork.messages)
      const commMsg: AgentCommunicationMessage = {
        id: generateId(),
        type: 'agent_communication',
        direction: 'from_agent',
        agentId: event.agentId,
        agentName: event.name,
        agentRole: event.role,
        forkId: event.forkId,
        content,
        preview: toPreview(content),
        timestamp: event.timestamp,
        status: 'completed',
      }
      return {
        ...fork,
        messages: insertBeforeQueuedMessages(flushedMessages, commMsg)
      }
    },

    agent_killed: ({ fork }) => fork,
    worker_user_killed: ({ fork }) => fork,
    worker_idle_closed: ({ fork }) => fork,

  },

  signalHandlers: (on) => [
    on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state }) => {
      const displayFork = state.forks.get(value.forkId)
      if (!displayFork) return state

      // Close chain if active (new user message = new chain)
      let workingFork = displayFork
      if (displayFork.chainStatus === 'active') {
        workingFork = closeChain(displayFork, value.timestamp)
      }

      const messageId = generateId()
      const content = textOf(value.content)
      const messageType: 'user_message' | 'queued_user_message' =
        workingFork.currentTurnId !== null ? 'queued_user_message' : 'user_message'

      return {
        ...state,
        forks: new Map(state.forks).set(value.forkId, {
          ...workingFork,
          messages: [
            ...workingFork.messages,
            {
              id: messageId,
              type: messageType,
              content,
              timestamp: value.timestamp,
              taskMode: value.taskMode,
              attachments: (value.attachments ?? [])
                .filter((attachment): attachment is Extract<typeof attachment, { type: 'image' }> => attachment.type === 'image')
                .map(attachment => ({
                  type: attachment.type,
                  width: attachment.width,
                  height: attachment.height,
                  filename: attachment.filename,
                })),
            },
          ]
        }),
      }
    }),

    // Insert inline fork activity block in parent's display when agent is created
    on(AgentStatusProjection.signals.agentCreated, ({ value, state }) => {
      const { forkId, parentForkId, name, role } = value
      const parentState = state.forks.get(parentForkId)
      if (!parentState) return state

      const msg: ForkActivityMessage = {
        id: generateId(),
        type: 'fork_activity',
        forkId,
        name,
        role,
        status: 'running',
        createdAt: value.timestamp,
        activeSince: value.timestamp,
        accumulatedActiveMs: 0,
        resumeCount: 0,
        toolCounts: EMPTY_TOOL_COUNTS,
        timestamp: value.timestamp
      }

      const nextParentState: DisplayState = {
        ...parentState,
        messages: insertBeforeQueuedMessages(parentState.messages, msg)
      }

      return {
        ...state,
        forks: new Map(state.forks).set(parentForkId, nextParentState)
      }
    }),

    // Update tool counts in parent's ForkActivityMessage when a tool step runs
    on(forkToolStepSignal, ({ value, state, read }) => {
      const { forkId, toolKey } = value
      if (forkId === null) return state  // root fork tools, no parent activity to update

      const agentState = read(AgentStatusProjection)
      const agent = getAgentByForkId(agentState, forkId)
      if (!agent) return state

      const parentState = state.forks.get(agent.parentForkId)
      if (!parentState) return state

      const msgIndex = findLastIndex(parentState.messages, (m: DisplayMessage) =>
        m.type === 'fork_activity' && m.forkId === forkId && m.status === 'running')
      if (msgIndex === -1) return state

      const msg = parentState.messages[msgIndex]
      if (msg?.type !== 'fork_activity') return state
      const newCounts = incrementToolCount(msg.toolCounts, toolKey)
      const newMessages = [...parentState.messages]
      newMessages[msgIndex] = { ...msg, toolCounts: newCounts }

      return {
        ...state,
        forks: new Map(state.forks).set(agent.parentForkId, { ...parentState, messages: newMessages })
      }
    }),

    // Mark fork activity as completed when agent becomes idle
    on(AgentStatusProjection.signals.agentBecameIdle, ({ value, state, read }) => {
      const { forkId, parentForkId } = value

      const parentState = state.forks.get(parentForkId)
      if (!parentState) return state

      const msgIndex = findLastIndex(parentState.messages, (m: DisplayMessage) =>
        m.type === 'fork_activity' && m.forkId === forkId && m.status === 'running')
      if (msgIndex === -1) return state

      const msg = parentState.messages[msgIndex]
      if (msg?.type !== 'fork_activity') return state
      const stintMs = Math.max(0, value.timestamp - msg.activeSince)
      const cumulativeTotalTimeMs = msg.accumulatedActiveMs + stintMs
      const newMessages = [...parentState.messages]
      newMessages[msgIndex] = {
        ...msg,
        status: 'completed',
        completedAt: value.timestamp,
        accumulatedActiveMs: cumulativeTotalTimeMs,
      }

      let nextParentState: DisplayState = { ...parentState, messages: newMessages }

      if (parentForkId === null && value.reason !== 'interrupt') {
        const finishedMsg: WorkerFinishedMessage = {
          id: generateId(),
          type: 'worker_finished',
          workerRole: value.role,
          workerId: value.agentId,
          cumulativeTotalTimeMs,
          cumulativeTotalToolsUsed: totalToolsUsed(msg.toolCounts),
          resumed: (msg.resumeCount ?? 0) > 0,
          timestamp: value.timestamp,
        }
        nextParentState = {
          ...nextParentState,
          messages: insertBeforeQueuedMessages(nextParentState.messages, finishedMsg),
        }
      }

      return {
        ...state,
        forks: new Map(state.forks).set(parentForkId, nextParentState)
      }
    }),

    on(AgentStatusProjection.signals.agentBecameWorking, ({ value, state }) => {
      const { forkId, parentForkId } = value
      const parentState = state.forks.get(parentForkId)
      if (!parentState) return state

      const msgIndex = findLastIndex(parentState.messages, (m: DisplayMessage) =>
        m.type === 'fork_activity' && m.forkId === forkId)
      if (msgIndex === -1) return state

      const message = parentState.messages[msgIndex]
      if (message?.type !== 'fork_activity') return state
      if (!message.completedAt) {
        // First transition into working (post-create): start active stint clock here.
        if ((message.resumeCount ?? 0) === 0) {
          const newMessages = [...parentState.messages]
          newMessages[msgIndex] = {
            ...message,
            activeSince: value.timestamp,
            timestamp: value.timestamp,
          }

          return {
            ...state,
            forks: new Map(state.forks).set(parentForkId, { ...parentState, messages: newMessages })
          }
        }
        return state
      }

      const nextResumeCount = (message.resumeCount ?? 0) + 1
      const resumedBlock: ForkActivityMessage = {
        id: generateId(),
        type: 'fork_activity',
        forkId,
        name: message.name,
        role: message.role,
        status: 'running',
        createdAt: value.timestamp,
        activeSince: value.timestamp,
        accumulatedActiveMs: message.accumulatedActiveMs,
        resumeCount: nextResumeCount,
        toolCounts: message.toolCounts,
        timestamp: value.timestamp
      }

      let nextParentState: DisplayState = {
        ...parentState,
        messages: insertBeforeQueuedMessages(parentState.messages, resumedBlock)
      }

      if (parentForkId === null) {
        const step: WorkerResumedMessage = {
          id: generateId(),
          type: 'worker_resumed',
          workerRole: value.role,
          workerId: value.agentId,
          title: message.name,
          timestamp: value.timestamp,
        }
        nextParentState = {
          ...nextParentState,
          messages: insertBeforeQueuedMessages(nextParentState.messages, step),
        }
      }

      return {
        ...state,
        forks: new Map(state.forks).set(parentForkId, nextParentState)
      }
    }),

    on(AgentStatusProjection.signals.agentKilled, ({ value, state }) => {
      const parentState = state.forks.get(value.parentForkId)
      if (!parentState) return state

      const messages = parentState.messages.filter((m) => !(m.type === 'fork_activity' && m.forkId === value.forkId))

      const step: WorkerKilledMessage = {
        id: generateId(),
        type: 'worker_killed',
        workerRole: value.role,
        workerId: value.agentId,
        title: value.title,
        timestamp: value.timestamp,
      }

      const nextParentState: DisplayState = {
        ...parentState,
        messages: insertBeforeQueuedMessages(messages, step),
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.parentForkId, nextParentState)
      }
    }),

    on(AgentStatusProjection.signals.subagentUserKilled, ({ value, state }) => {
      const parentState = state.forks.get(value.parentForkId)
      if (!parentState) return state

      const messages = parentState.messages.filter((m) => !(m.type === 'fork_activity' && m.forkId === value.forkId))

      const step: WorkerUserKilledMessage = {
        id: generateId(),
        type: 'worker_user_killed',
        workerRole: value.role,
        workerId: value.agentId,
        title: value.title,
        timestamp: value.timestamp,
      }

      const nextParentState: DisplayState = {
        ...parentState,
        messages: insertBeforeQueuedMessages(messages, step),
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.parentForkId, nextParentState)
      }
    }),

    on(AgentStatusProjection.signals.workerIdleClosed, ({ value, state }) => {
      const parentState = state.forks.get(value.parentForkId)
      if (!parentState) return state

      const messages = parentState.messages.filter((m) => !(m.type === 'fork_activity' && m.forkId === value.forkId))
      return {
        ...state,
        forks: new Map(state.forks).set(value.parentForkId, { ...parentState, messages }),
      }
    }),

    on(AgentRoutingProjection.signals.communicationStreamStarted, ({ value, state, read }) => {
      const displayFork = state.forks.get(value.targetForkId)
      if (!displayFork) return state

      if (value.direction === 'from_agent') return state

      const agentState = read(AgentStatusProjection)
      const targetAgent = getAgentByForkId(agentState, value.targetForkId)
      const nextFork = upsertStreamingCommunicationStep(
        displayFork,
        value.streamId,
        {
          direction: value.direction,
          agentId: value.agentId,
          agentName: targetAgent?.name,
          agentRole: targetAgent?.role,
          forkId: value.targetForkId,
          timestamp: value.timestamp,
        },
        value.textDelta
      )

      return {
        ...state,
        forks: new Map(state.forks).set(value.targetForkId, nextFork)
      }
    }),

    on(AgentRoutingProjection.signals.communicationStreamChunk, ({ value, state, read }) => {
      const displayFork = state.forks.get(value.targetForkId)
      if (!displayFork) return state

      if (value.direction === 'from_agent') return state

      const agentState = read(AgentStatusProjection)
      const targetAgent = getAgentByForkId(agentState, value.targetForkId)
      const nextFork = upsertStreamingCommunicationStep(
        displayFork,
        value.streamId,
        {
          direction: value.direction,
          agentId: value.agentId,
          agentName: targetAgent?.name,
          agentRole: targetAgent?.role,
          forkId: value.targetForkId,
          timestamp: value.timestamp,
        },
        value.textDelta
      )

      return {
        ...state,
        forks: new Map(state.forks).set(value.targetForkId, nextFork)
      }
    }),

    on(AgentRoutingProjection.signals.communicationStreamCompleted, ({ value, state }) => {
      const displayFork = state.forks.get(value.targetForkId)
      if (!displayFork) return state
      if (value.direction === 'from_agent') return state

      return {
        ...state,
        forks: new Map(state.forks).set(
          value.targetForkId,
          finalizeCommunicationStreamInFork(displayFork, value.streamId)
        )
      }
    }),

    on(AgentRoutingProjection.signals.agentMessage, ({ value, state, read }) => {
      const displayFork = state.forks.get(value.targetForkId)
      if (!displayFork) return state
      const agentState = read(AgentStatusProjection)
      const turnState = read(TurnProjection)
      const turnFork = turnState.forks.get(value.targetForkId)
      const targetAgent = getAgentByForkId(agentState, value.targetForkId)

      const pending = (turnFork?.pendingInboundCommunications ?? []).map((message): PendingInboundCommunicationDisplay => ({
        ...message,
        agentName: message.agentName ?? targetAgent?.name,
        agentRole: message.agentRole ?? targetAgent?.role,
      }))

      return {
        ...state,
        forks: new Map(state.forks).set(value.targetForkId, {
          ...displayFork,
          pendingInboundCommunications: pending,
        })
      }
    }),

    on(AgentRoutingProjection.signals.agentResponse, ({ value, state, read }) => {
      const displayFork = state.forks.get(value.targetForkId)
      if (!displayFork) return state
      const agentState = read(AgentStatusProjection)
      const turnState = read(TurnProjection)
      const turnFork = turnState.forks.get(value.targetForkId)
      const targetAgent = value.targetForkId ? getAgentByForkId(agentState, value.targetForkId) : undefined

      const pending = (turnFork?.pendingInboundCommunications ?? []).map((message): PendingInboundCommunicationDisplay => ({
        ...message,
        agentName: message.agentName ?? targetAgent?.name,
        agentRole: message.agentRole ?? targetAgent?.role,
      }))

      return {
        ...state,
        forks: new Map(state.forks).set(value.targetForkId, {
          ...displayFork,
          pendingInboundCommunications: pending,
        })
      }
    }),

    on(TurnProjection.signals.pendingInboundCommunicationsRead, ({ value, state, read }) => {
      const displayFork = state.forks.get(value.forkId)
      if (!displayFork) return state

      const agentState = read(AgentStatusProjection)
      let nextFork = { ...displayFork }

      if (value.forkId !== null) {
        for (const pending of value.messages.filter((message) => message.source === 'agent')) {
          const targetAgent = getAgentByForkId(agentState, value.forkId)
          const commMsg: AgentCommunicationMessage = {
            id: pending.id,
            type: 'agent_communication',
            direction: 'from_agent',
            agentId: pending.agentId,
            agentName: pending.agentName ?? targetAgent?.name,
            agentRole: pending.agentRole ?? targetAgent?.role,
            forkId: pending.forkId,
            content: pending.content,
            preview: pending.preview,
            timestamp: pending.timestamp,
            status: 'completed',
          }
          nextFork = {
            ...nextFork,
            messages: insertBeforeQueuedMessages(nextFork.messages, commMsg)
          }
        }
      }

      const pendingIds = new Set(value.messages.map(m => m.id))
      nextFork = {
        ...nextFork,
        pendingInboundCommunications: nextFork.pendingInboundCommunications.filter(m => !pendingIds.has(m.id))
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.forkId, nextFork)
      }
    }),

  ]
})
