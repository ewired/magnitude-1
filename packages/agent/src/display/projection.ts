/**
 * DisplayProjection (Forked)
 *
 * UI state with messages and TurnBlocks, per-fork.
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
import { AgentStatusProjection, getAgentByForkId, type AgentStatusState } from '../projections/agent-status'
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
  WorkerResumedStep,
  WorkerFinishedStep,
  WorkerKilledStep,
  WorkerUserKilledStep,
  TurnBlockMessage,
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
import type { ToolKey } from '../tools/toolkits'


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

import {
  findTurnBlock,
  updateMessageById,
  ensureTurnBlock,
  addStepToTurnBlock,
  updateStepInTurnBlock,
  addStepToTurnBlockFlush,
  closeTurnBlock,
  finalizeOpenToolStepsAsInterrupted,
} from './helpers/turn-block'

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
    activeTurnBlockId: null,
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

      // If promoting queued messages, close the current think block first
      // so the new think block appears AFTER the promoted user messages
      const stateBeforePromotion = hasQueuedMessages ? closeTurnBlock(fork, event.timestamp) : fork

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

      // Ensure TurnBlock exists - reuse existing if there is one, create if not
      const stateWithMessages = { ...stateBeforePromotion, messages }
      const { fork: newState } = ensureTurnBlock(stateWithMessages, event.timestamp)

      // Start chain if not already active
      const chainStarting = newState.chainStatus !== 'active'
      return {
        ...newState,
        currentTurnId: event.turnId,  // Track the turn for queuing
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

      // Close any active TurnBlock before starting assistant message
      const closedState = closeTurnBlock(fork, event.timestamp)

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

      // Don't create optimistic TurnBlock if there are queued messages.
      // turn_started will create it at the correct position after promoting them.
      const hasQueuedMessages = fork.messages.some(m => m.type === 'queued_user_message')
      if (hasQueuedMessages) {
        return {
          ...fork,
          streamingMessageId: null  // Message streaming done
        }
      }

      // Create optimistic TurnBlock for potential follow-up work
      // It will be removed if empty when the turn outcome arrives
      const { fork: newState } = ensureTurnBlock(fork, event.timestamp)

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

      const { fork: newState, turnBlockId } = ensureTurnBlock(fork, event.timestamp)
      const block = findTurnBlock(newState.messages, turnBlockId)

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
            messages: updateMessageById<TurnBlockMessage>(
              newState.messages,
              turnBlockId,
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
          messages: updateStepInTurnBlock(
            newState.messages,
            turnBlockId,
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
          messages: addStepToTurnBlock(newState.messages, turnBlockId, {
            id: stepId,
            type: 'thinking',
            content: '',
          })
        }
      }

      return {
        ...newState,
        messages: addStepToTurnBlock(newState.messages, turnBlockId, {
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

          const { fork: newState, turnBlockId } = ensureTurnBlock(fork, event.timestamp)
          return {
            ...newState,
            messages: addStepToTurnBlockFlush(newState.messages, turnBlockId, {
              id: event.toolCallId,
              type: 'tool',
              toolKey: event.toolKey,
              cluster: getToolCluster(event.toolKey),
              state: getVisualState(toolStateFork, event.toolCallId),
              filter: null,
              resultFilePath: null,
            })
          }
        }

        case 'ToolInputReady': {
          if (fork.currentTurnId !== event.turnId) return fork
          if (!fork.activeTurnBlockId) return fork

          return {
            ...fork,
            messages: updateStepInTurnBlock(
              fork.messages,
              fork.activeTurnBlockId,
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

          if (!fork.activeTurnBlockId) return fork

          return {
            ...fork,
            messages: updateStepInTurnBlock(
              fork.messages,
              fork.activeTurnBlockId,
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
          if (!fork.activeTurnBlockId) return fork

          const vs = getVisualState(toolStateFork, event.toolCallId)
          if (!vs) return fork

          return {
            ...fork,
            messages: updateStepInTurnBlock(
              fork.messages,
              fork.activeTurnBlockId,
              event.toolCallId,
              (s) => s.type === 'tool'
                ? { ...s, state: vs }
                : s
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
        // keep the think block open for the next turn to reuse.
        return {
          ...fork,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
          // Chain stays active — lead idle but chain continues
        }
      }

      if (event.outcome._tag === 'ConnectionFailure') {
        const { fork: stateWithBlock, turnBlockId } = ensureTurnBlock(fork, event.timestamp)
        return {
          ...stateWithBlock,
          messages: addStepToTurnBlockFlush(stateWithBlock.messages, turnBlockId, {
            type: 'status_indicator' as const,
            id: generateId(),
            message: 'Connection issue: retrying',
            style: 'dim' as const,
          }),
        }
      }

      if (event.outcome._tag === 'Overthinking') {
        const { fork: stateWithBlock, turnBlockId } = ensureTurnBlock(fork, event.timestamp)
        const withIndicator = addStepToTurnBlockFlush(stateWithBlock.messages, turnBlockId, {
          type: 'status_indicator' as const,
          id: generateId(),
          message: `Thinking exceeded ${event.outcome.limit} character limit — continuing with feedback`,
          style: 'dim' as const,
        })
        const closedState = closeTurnBlock({ ...stateWithBlock, messages: withIndicator }, event.timestamp)
        return {
          ...closedState,
          currentTurnId: null,
          status: 'idle' as const,
          streamingMessageId: null,
          showButton: 'send' as const,
        }
      }

      const closedState = closeTurnBlock(fork, event.timestamp)

      // Close chain if no agents are still working — the chain is complete.
      // When lead yields to workers, agents ARE working so chain stays open.
      // When workers finish and lead resumes, next turn_outcome will check again.
      let withChain: DisplayState = closedState
      if (closedState.chainStatus === 'active') {
        const agentState = read(AgentStatusProjection)
        if (!anyAgentsWorking(agentState)) {
          withChain = closeChain(closedState, event.timestamp)
        }
      }

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

      // Finalize any still-open tool steps as interrupted before closing think block
      const harnessState = read(HarnessStateProjection)
      const toolStateFork = { toolHandles: harnessState ? getToolHandlesRecord(harnessState) : {} }
      const interruptedState = finalizeOpenToolStepsAsInterrupted(fork, toolStateFork)

      // Close think block and remove queued messages
      const closedTurnBlock = closeTurnBlock(interruptedState, event.timestamp)
      // Close chain on interrupt
      const closedState = closedTurnBlock.chainStatus === 'active' ? closeChain(closedTurnBlock, event.timestamp) : closedTurnBlock
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

      const { fork: newState, turnBlockId } = ensureTurnBlock(fork, event.timestamp)
      return {
        ...newState,
        messages: addStepToTurnBlockFlush(newState.messages, turnBlockId, {
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

      let nextParentState: DisplayState = {
        ...parentState,
        messages: insertBeforeQueuedMessages(parentState.messages, msg)
      }

      if (parentForkId === null) {
        const withBlock = ensureTurnBlock(nextParentState, value.timestamp)
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
        const withBlock = ensureTurnBlock(nextParentState, value.timestamp)
        const step: WorkerFinishedStep = {
          id: generateId(),
          type: 'worker_finished',
          workerRole: value.role,
          workerId: value.agentId,
          cumulativeTotalTimeMs,
          cumulativeTotalToolsUsed: totalToolsUsed(msg.toolCounts),
          resumed: (msg.resumeCount ?? 0) > 0,
        }
        nextParentState = {
          ...withBlock.fork,
          messages: addStepToTurnBlockFlush(withBlock.fork.messages, withBlock.turnBlockId, step),
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

          let nextParentState = { ...parentState, messages: newMessages }

          return {
            ...state,
            forks: new Map(state.forks).set(parentForkId, nextParentState)
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
        const withBlock = ensureTurnBlock(nextParentState, value.timestamp)
        const step: WorkerResumedStep = {
          id: generateId(),
          type: 'worker_resumed',
          workerRole: value.role,
          workerId: value.agentId,
          title: message.name,
        }
        nextParentState = {
          ...withBlock.fork,
          messages: addStepToTurnBlockFlush(withBlock.fork.messages, withBlock.turnBlockId, step),
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

      const withBlock = ensureTurnBlock(nextParentState, value.timestamp)
      const step: WorkerKilledStep = {
        id: generateId(),
        type: 'worker_killed',
        workerRole: value.role,
        workerId: value.agentId,
        title: value.title,
      }
      nextParentState = {
        ...withBlock.fork,
        messages: addStepToTurnBlockFlush(withBlock.fork.messages, withBlock.turnBlockId, step),
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

      const withBlock = ensureTurnBlock(nextParentState, value.timestamp)
      const step: WorkerUserKilledStep = {
        id: generateId(),
        type: 'worker_user_killed',
        workerRole: value.role,
        workerId: value.agentId,
        title: value.title,
      }
      nextParentState = {
        ...withBlock.fork,
        messages: addStepToTurnBlockFlush(withBlock.fork.messages, withBlock.turnBlockId, step),
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
          const withBlock = ensureTurnBlock(nextFork, value.timestamp)
          nextFork = {
            ...withBlock.fork,
            messages: addStepToTurnBlockFlush(withBlock.fork.messages, withBlock.turnBlockId, {
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
