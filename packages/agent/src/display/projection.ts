/**
 * DisplayProjection (Forked)
 *
 * UI state with messages and ThinkBlocks, per-fork.
 * Each fork has independent display state for its conversation.
 *
 * Key invariants:
 * - Queued messages always appear at the END of the message list
 * - New content (assistant messages, think blocks) is inserted BEFORE queued messages
 * - Queued messages are promoted to user_message on turn_started
 */

import { Signal, Projection } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'
import { textOf } from '../content'
import { outcomeWillChainContinue } from '../events'

import { AgentRoutingProjection } from '../projections/agent-routing'
import { AgentStatusProjection, getAgentByForkId } from '../projections/agent-status'
import { UserMessageResolutionProjection } from '../projections/user-message-resolution'
import { TurnProjection } from '../projections/turn'
import { HarnessStateProjection, getToolHandlesRecord } from '../projections/harness-state'

import { HIDDEN_TOOLS } from '../tools/toolkits'

import {
  UserMessageDisplay,
  QueuedUserMessageDisplay,
  AssistantMessageDisplay,
  ThinkingStep,
  ToolStep,
  CommunicationStep,
  StatusIndicatorStep,
  SubagentStartedStep,
  SubagentFinishedStep,
  SubagentKilledStep,
  SubagentUserKilledStep,
  ThinkBlockMessage,
  DisplayState,
  DisplayMessage,
  ErrorDisplayMessage,
  ForkActivityMessage,
  PendingInboundCommunicationDisplay,
} from './types'

import {
  generateId,
  getVisualState,
  insertBeforeQueuedMessages,
  findInsertionIndex,
  toErrorDisplayMessage,
  moveMessageToEndBeforeQueue,
  toPreview,
} from './helpers/messages'

import {
  findThinkBlock,
  updateMessageById,
  ensureThinkBlock,
  addStepToThinkBlock,
  updateStepInThinkBlock,
  addStepToThinkBlockFlush,
  closeThinkBlock,
  finalizeOpenToolStepsAsInterrupted,
} from './helpers/think-block'

import { processThinkingChunk, heldBuffers } from './helpers/thinking'

import {
  incrementToolCount,
  findLastIndex,
  totalToolsUsed,
  upsertStreamingCommunicationStep,
  finalizeCommunicationStreamInFork,
} from './helpers/fork-activity'

import { EMPTY_TOOL_COUNTS } from './constants'

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
    activeThinkBlockId: null,
    showButton: 'send',
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

      // If promoting queued messages, close the current think block first
      // so the new think block appears AFTER the promoted user messages
      const stateBeforePromotion = hasQueuedMessages ? closeThinkBlock(fork, event.timestamp) : fork

      // Promote queued messages to user messages
      const messages = stateBeforePromotion.messages.map(msg => {
        if (msg.type === 'queued_user_message') {
          return {
            ...msg,
            type: 'user_message' as const
          }
        }
        return msg
      })

      // Ensure ThinkBlock exists - reuse existing if there is one, create if not
      const stateWithMessages = { ...stateBeforePromotion, messages }
      const { fork: newState } = ensureThinkBlock(stateWithMessages, event.timestamp)

      return {
        ...newState,
        currentTurnId: event.turnId,  // Track the turn for queuing
        status: 'streaming' as const,
        showButton: 'stop' as const,
        pendingInboundCommunications: [],
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

      // Close any active ThinkBlock before starting assistant message
      const closedState = closeThinkBlock(fork, event.timestamp)

      const msgId = generateId()
      const assistantMessage: AssistantMessageDisplay = {
        id: msgId,
        type: 'assistant_message',
        content: '',
        timestamp: event.timestamp
      }

      const messages = insertBeforeQueuedMessages(closedState.messages, assistantMessage)

      return {
        ...closedState,
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

      // Don't create optimistic ThinkBlock if there are queued messages.
      // turn_started will create it at the correct position after promoting them.
      const hasQueuedMessages = fork.messages.some(m => m.type === 'queued_user_message')
      if (hasQueuedMessages) {
        return {
          ...fork,
          streamingMessageId: null  // Message streaming done
        }
      }

      // Create optimistic ThinkBlock for potential follow-up work
      // It will be removed if empty when the turn outcome arrives
      const { fork: newState } = ensureThinkBlock(fork, event.timestamp)

      return {
        ...newState,
        streamingMessageId: null  // Message streaming done
      }
    },

    thinking_chunk: ({ event, fork }) => {
      // Ignore if not for current turn
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      const { fork: newState, thinkBlockId } = ensureThinkBlock(fork, event.timestamp)
      const block = findThinkBlock(newState.messages, thinkBlockId)

      if (!block) return newState

      // Find existing thinking step or create new one
      const lastStep = block.steps[block.steps.length - 1]
      if (lastStep?.type === 'thinking') {
        const { contentToAppend, shouldSuppress } = processThinkingChunk(lastStep, event.text)

        if (shouldSuppress) {
          // Remove the empty thinking step entirely
          const filteredSteps = block.steps.filter((s) => s.id !== lastStep.id)
          heldBuffers.delete(lastStep.id)
          return {
            ...newState,
            messages: updateMessageById<ThinkBlockMessage>(
              newState.messages,
              thinkBlockId,
              (b) => ({ ...b, steps: filteredSteps })
            ),
          }
        }

        if (contentToAppend === '') {
          // Nothing visible to append, but we're still buffering — don't modify content
          return newState
        }

        return {
          ...newState,
          messages: updateStepInThinkBlock(
            newState.messages,
            thinkBlockId,
            lastStep.id,
            (s) => s.type === 'thinking'
              ? { ...s, content: s.content + contentToAppend }
              : s
          )
        }
      }

      // Create new thinking step
      const stepId = generateId()
      const tempStep: ThinkingStep = {
        id: stepId,
        type: 'thinking',
        content: '',
      }
      const { contentToAppend, shouldSuppress } = processThinkingChunk(tempStep, event.text)

      if (shouldSuppress) {
        heldBuffers.delete(stepId)
        return newState
      }

      if (contentToAppend === '' && heldBuffers.has(stepId)) {
        // Only buffered content, step hasn't visibly started yet
        // Add the step with empty content so future chunks can append to it
        return {
          ...newState,
          messages: addStepToThinkBlock(newState.messages, thinkBlockId, {
            id: stepId,
            type: 'thinking',
            content: '',
          })
        }
      }

      return {
        ...newState,
        messages: addStepToThinkBlock(newState.messages, thinkBlockId, {
          id: stepId,
          type: 'thinking',
          content: contentToAppend,
        })
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

          const { fork: newState, thinkBlockId } = ensureThinkBlock(fork, event.timestamp)
          return {
            ...newState,
            messages: addStepToThinkBlockFlush(newState.messages, thinkBlockId, {
              id: event.toolCallId,
              type: 'tool',
              toolKey: event.toolKey,
              state: getVisualState(toolStateFork, event.toolCallId),
              filter: null,
              resultFilePath: null,
            })
          }
        }

        case 'ToolInputReady': {
          if (fork.currentTurnId !== event.turnId) return fork
          if (!fork.activeThinkBlockId) return fork

          return {
            ...fork,
            messages: updateStepInThinkBlock(
              fork.messages,
              fork.activeThinkBlockId,
              event.toolCallId,
              (s) => s.type === 'tool'
                ? {
                    ...s,
                    state: getVisualState(toolStateFork, event.toolCallId) ?? s.state,
                  }
                : s
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

          if (!fork.activeThinkBlockId) return fork

          return {
            ...fork,
            messages: updateStepInThinkBlock(
              fork.messages,
              fork.activeThinkBlockId,
              event.toolCallId,
              (s) => {
                if (s.type !== 'tool') return s

                return {
                  ...s,
                  state: getVisualState(toolStateFork, event.toolCallId) ?? s.state,
                }
              }
            )
          }
        }

        default: {
          if (fork.currentTurnId !== event.turnId) return fork
          if (!fork.activeThinkBlockId) return fork

          const vs = getVisualState(toolStateFork, event.toolCallId)
          if (!vs) return fork

          return {
            ...fork,
            messages: updateStepInThinkBlock(
              fork.messages,
              fork.activeThinkBlockId,
              event.toolCallId,
              (s) => s.type === 'tool'
                ? { ...s, state: vs }
                : s
            )
          }
        }
      }
    },

    turn_outcome: ({ event, fork }) => {
      if (fork.currentTurnId !== event.turnId) {
        return fork
      }

      if (event.outcome._tag === 'Completed' && outcomeWillChainContinue(event.outcome)) {
        // Turn will chain-continue (has tool calls and no yield target) —
        // keep the think block open for the next turn to reuse.
        return {
          ...fork,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      if (event.outcome._tag === 'ConnectionFailure') {
        const { fork: stateWithBlock, thinkBlockId } = ensureThinkBlock(fork, event.timestamp)
        return {
          ...stateWithBlock,
          messages: addStepToThinkBlockFlush(stateWithBlock.messages, thinkBlockId, {
            type: 'status_indicator' as const,
            id: generateId(),
            message: 'Connection issue: retrying',
            style: 'dim' as const,
          }),
        }
      }

      if (event.outcome._tag === 'Overthinking') {
        const { fork: stateWithBlock, thinkBlockId } = ensureThinkBlock(fork, event.timestamp)
        const withIndicator = addStepToThinkBlockFlush(stateWithBlock.messages, thinkBlockId, {
          type: 'status_indicator' as const,
          id: generateId(),
          message: `Thinking exceeded ${event.outcome.limit} character limit — continuing with feedback`,
          style: 'dim' as const,
        })
        const closedState = closeThinkBlock({ ...stateWithBlock, messages: withIndicator }, event.timestamp)
        return {
          ...closedState,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      const closedState = closeThinkBlock(fork, event.timestamp)

      if (event.outcome._tag === 'Completed') {
        return {
          ...closedState,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      if (event.outcome._tag === 'Cancelled') {
        const alreadyInterrupted = closedState.messages.some(
          (message) => message.type === 'interrupted' && message.timestamp === event.timestamp,
        )
        return {
          ...closedState,
          messages: alreadyInterrupted
            ? closedState.messages
            : [
                ...closedState.messages,
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
          ...closedState,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      const errorMessage = toErrorDisplayMessage(event.outcome, event.timestamp)

      return {
        ...closedState,
        messages: errorMessage ? [...closedState.messages, errorMessage] : closedState.messages,
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

      // Finalize any still-open tool steps as interrupted before closing think block
      const harnessState = read(HarnessStateProjection)
      const toolStateFork = { toolHandles: harnessState ? getToolHandlesRecord(harnessState) : {} }
      const interruptedState = finalizeOpenToolStepsAsInterrupted(fork, toolStateFork)

      // Close think block and remove queued messages
      const closedState = closeThinkBlock(interruptedState, event.timestamp)
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

      const { fork: newState, thinkBlockId } = ensureThinkBlock(fork, event.timestamp)
      return {
        ...newState,
        messages: addStepToThinkBlockFlush(newState.messages, thinkBlockId, {
          id: generateId(),
          type: 'communication',
          direction: 'from_agent',
          agentId: event.agentId,
          agentName: event.name,
          agentRole: event.role,
          forkId: event.forkId,
          content,
          preview: toPreview(content),
          timestamp: event.timestamp,
          status: 'completed',
        })
      }
    },

    agent_killed: ({ fork }) => fork,
    subagent_user_killed: ({ fork }) => fork,
    subagent_idle_closed: ({ fork }) => fork,

  },

  signalHandlers: (on) => [
    on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state }) => {
      const displayFork = state.forks.get(value.forkId)
      if (!displayFork) return state

      const messageId = generateId()
      const content = textOf(value.content)
      const messageType: 'user_message' | 'queued_user_message' =
        displayFork.currentTurnId !== null ? 'queued_user_message' : 'user_message'

      return {
        ...state,
        forks: new Map(state.forks).set(value.forkId, {
          ...displayFork,
          messages: [
            ...displayFork.messages,
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

      let nextParentState: DisplayState = {
        ...parentState,
        messages: insertBeforeQueuedMessages(parentState.messages, msg)
      }

      if (parentForkId === null) {
        const withBlock = ensureThinkBlock(nextParentState, value.timestamp)
        nextParentState = withBlock.fork
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
    on(AgentStatusProjection.signals.agentBecameIdle, ({ value, state }) => {
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
        const withBlock = ensureThinkBlock(nextParentState, value.timestamp)
        const step: SubagentFinishedStep = {
          id: generateId(),
          type: 'subagent_finished',
          subagentType: value.role,
          subagentId: value.agentId,
          cumulativeTotalTimeMs,
          cumulativeTotalToolsUsed: totalToolsUsed(msg.toolCounts),
          resumed: (msg.resumeCount ?? 0) > 0,
        }
        nextParentState = {
          ...withBlock.fork,
          messages: addStepToThinkBlockFlush(withBlock.fork.messages, withBlock.thinkBlockId, step),
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
        const withBlock = ensureThinkBlock(nextParentState, value.timestamp)
        const step: SubagentStartedStep = {
          id: generateId(),
          type: 'subagent_started',
          subagentType: value.role,
          subagentId: value.agentId,
          title: message.name,
          resumed: true,
        }
        nextParentState = {
          ...withBlock.fork,
          messages: addStepToThinkBlockFlush(withBlock.fork.messages, withBlock.thinkBlockId, step),
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
      let nextParentState: DisplayState = { ...parentState, messages }

      const withBlock = ensureThinkBlock(nextParentState, value.timestamp)
      const step: SubagentKilledStep = {
        id: generateId(),
        type: 'subagent_killed',
        subagentType: value.role,
        subagentId: value.agentId,
        title: value.title,
      }
      nextParentState = {
        ...withBlock.fork,
        messages: addStepToThinkBlockFlush(withBlock.fork.messages, withBlock.thinkBlockId, step),
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
      let nextParentState: DisplayState = { ...parentState, messages }

      const withBlock = ensureThinkBlock(nextParentState, value.timestamp)
      const step: SubagentUserKilledStep = {
        id: generateId(),
        type: 'subagent_user_killed',
        subagentType: value.role,
        subagentId: value.agentId,
        title: value.title,
      }
      nextParentState = {
        ...withBlock.fork,
        messages: addStepToThinkBlockFlush(withBlock.fork.messages, withBlock.thinkBlockId, step),
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.parentForkId, nextParentState)
      }
    }),

    on(AgentStatusProjection.signals.subagentIdleClosed, ({ value, state }) => {
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
          const withBlock = ensureThinkBlock(nextFork, value.timestamp)
          nextFork = {
            ...withBlock.fork,
            messages: addStepToThinkBlockFlush(withBlock.fork.messages, withBlock.thinkBlockId, {
              id: pending.id,
              type: 'communication',
              direction: 'from_agent',
              agentId: pending.agentId,
              agentName: pending.agentName ?? targetAgent?.name,
              agentRole: pending.agentRole ?? targetAgent?.role,
              forkId: pending.forkId,
              content: pending.content,
              preview: pending.preview,
              timestamp: pending.timestamp,
              status: 'completed',
            })
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
