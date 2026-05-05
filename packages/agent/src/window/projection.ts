/**
 * WindowProjection (Forked)
 *
 * LLM conversation history, per-fork.
 * Each fork has independent message history and token budget tracking.
 */

import { Projection, Signal } from '@magnitudedev/event-core'
import type { AppEvent, StrategyId, ImageAttachment, ObservationPart } from '../events'
import { present } from '../errors'
import { getAgentByForkId, AgentStatusProjection } from '../projections/agent-status'
import { SubagentActivityProjection } from '../projections/subagent-activity'
import { OutboundMessagesProjection } from '../projections/outbound-messages'
import { CanonicalTurnProjection } from '../projections/canonical-turn'
import { buildSessionContextContent } from '../prompts/session-context'
import { TASK_TREE_COMPLETION_REMINDER } from '../prompts/task-tree'
import { SkillsAmbient } from '../ambient/skills-ambient'
import { ConfigAmbient } from '../ambient/config-ambient'
import { UserPresenceProjection } from '../projections/user-presence'
import { UserMessageResolutionProjection } from '../projections/user-message-resolution'
import { TaskGraphProjection, type TaskGraphState, type TaskRecord } from '../projections/task-graph'

import { formatUserPresence, formatUserReturnedAfterAbsence } from '../prompts/presence'
import type { UserPart, ImageMediaType } from '@magnitudedev/ai'
import { textParts } from '../content'

import { EMPTY_RESPONSE_ERROR } from '../prompts/error-states'
import type {
  TimelineEntry,
  TimelineAttachment,
  AgentAtom,
} from './inbox/types'
import type { CompletedTurn, TurnFeedback } from './types'
import {
  toTimelineUserMessage,
  toTimelineParentMessage,
  toTimelineUserToAgent,
  toTimelineUserBashCommand,
  toTimelineUserPresence,
  toTimelineObservation,
  toTimelineAgentBlock,
  toTimelineSubagentUserKilled,
  toTimelineTaskTypeHook,
  toTimelineTaskIdleHook,
  toTimelineTaskCompleteHook,
  toTimelineTaskTreeDirty,
  toTimelineTaskTreeView,
  toTimelineTaskUpdate,
} from './inbox/compose'

import type { ForkWindowState, WindowEntry, QueuedTimelineEntry } from './types'
import {
  estimateContentEntry,
  estimateTurnEntry,
  estimateContextEntry,
  estimateSystemPromptTokens,
  computeTokenEstimate,
} from './estimate'
import { isRoleId } from '../agents/role-validation'


function extractText(parts: readonly UserPart[]): string {
  return parts
    .filter((p): p is Extract<UserPart, { _tag: 'TextPart' }> => p._tag === 'TextPart')
    .map(p => p.text)
    .join('')
}

function appendTimeline(
  messages: readonly WindowEntry[],
  timeline: readonly TimelineEntry[],
): { messages: readonly WindowEntry[]; addedTokens: number } {
  if (timeline.length === 0) return { messages, addedTokens: 0 }
  const estimatedTokens = estimateContextEntry(timeline)
  return {
    messages: [...messages, { type: 'context', source: 'system', timeline: [...timeline], estimatedTokens }],
    addedTokens: estimatedTokens,
  }
}

function enqueueTimeline(
  fork: ForkWindowState,
  entry: TimelineEntry,
  timestamp: number,
  coalesceKey?: string,
): ForkWindowState {
  const seq = fork.nextQueueSeq
  const queued: QueuedTimelineEntry = { timestamp, seq, entry, coalesceKey }
  const queuedTimeline = coalesceKey
    ? [...fork.queuedTimeline.filter(q => q.coalesceKey !== coalesceKey), queued]
    : [...fork.queuedTimeline, queued]
  return { ...fork, queuedTimeline, nextQueueSeq: seq + 1 }
}

function flushQueue(fork: ForkWindowState, taskGraphState: TaskGraphState): ForkWindowState {
  const sorted = [...fork.queuedTimeline].sort((a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq))
  const timeline: TimelineEntry[] = []
  const dirtyTaskIds = new Set<string>()
  let latestDirtyTimestamp: number | null = null

  for (const queued of sorted) {
    if (queued.entry.kind === 'task_tree_dirty') {
      dirtyTaskIds.add(queued.entry.taskId)
      latestDirtyTimestamp = latestDirtyTimestamp === null
        ? queued.entry.timestamp
        : Math.max(latestDirtyTimestamp, queued.entry.timestamp)
      continue
    }

    timeline.push(queued.entry)
  }

  if (dirtyTaskIds.size > 0 && latestDirtyTimestamp !== null) {
    const renderedTree = renderTaskTreesForTaskIds(taskGraphState, Array.from(dirtyTaskIds))
    if (renderedTree) {
      timeline.push(
        toTimelineTaskTreeView({
          timestamp: latestDirtyTimestamp,
          renderedTree,
        }),
      )
    }
  }

  const { messages, addedTokens } = appendTimeline(fork.messages, timeline)
  const messageTokens = fork.messageTokens + addedTokens
  return {
    ...fork,
    messages,
    queuedTimeline: [],
    messageTokens,
    tokenEstimate: computeTokenEstimate(
      fork.systemPromptTokens, messageTokens,
      fork.lastAnchoredTotal, fork.lastAnchoredMessageTokens,
    ),
  }
}

function enqueueAgentAtomBlock(
  fork: ForkWindowState,
  args: {
    timestamp: number
    agentId: string
    role: string
    atoms: readonly AgentAtom[]
  },
): ForkWindowState {
  if (args.atoms.length === 0) return fork

  const last = fork.queuedTimeline[fork.queuedTimeline.length - 1]
  if (
    last
    && last.entry.kind === 'agent_block'
    && last.entry.agentId === args.agentId
  ) {
    const mergedEntry = toTimelineAgentBlock({
      timestamp: last.entry.timestamp,
      firstAtomTimestamp: last.entry.firstAtomTimestamp,
      lastAtomTimestamp: args.atoms[args.atoms.length - 1]!.timestamp,
      agentId: last.entry.agentId,
      role: last.entry.role,
      atoms: [...last.entry.atoms, ...args.atoms],
    })

    const mergedQueued: QueuedTimelineEntry = {
      ...last,
      timestamp: Math.min(last.timestamp, args.timestamp),
      entry: mergedEntry,
    }

    return {
      ...fork,
      queuedTimeline: [...fork.queuedTimeline.slice(0, -1), mergedQueued],
    }
  }

  return enqueueTimeline(
    fork,
    toTimelineAgentBlock({
      timestamp: args.timestamp,
      firstAtomTimestamp: args.atoms[0]!.timestamp,
      lastAtomTimestamp: args.atoms[args.atoms.length - 1]!.timestamp,
      agentId: args.agentId,
      role: args.role,
      atoms: args.atoms,
    }),
    args.timestamp,
  )
}

function toUserPartFromObservation(part: ObservationPart): UserPart {
  if (part.type === 'text') {
    return { _tag: 'TextPart', text: part.text }
  }

  return {
    _tag: 'ImagePart',
    data: part.base64,
    mediaType: part.mediaType as ImageMediaType,
    ...(part.dimensions ? { dimensions: part.dimensions } : {}),
  }
}

function findRootTaskId(state: TaskGraphState, taskId: string): string {
  let current = state.tasks.get(taskId)
  while (current && current.parentId) {
    const parent = state.tasks.get(current.parentId)
    if (!parent) break
    current = parent
  }
  return current?.id ?? taskId
}

function renderTaskSubtree(state: TaskGraphState, taskId: string, depth: number): string[] {
  const task = state.tasks.get(taskId)
  if (!task) return []

  const indent = '  '.repeat(depth)

  const status = task.status === 'completed' ? 'done' : task.status
  const assignedRoleStr = task.worker && task.worker.role !== 'user'
    ? `, assigned: ${task.worker.role}`
    : ''
  const assigneeStr = task.assignee === 'user' ? ', user' : ''
  const line = `${indent}[${status}] ${task.title} (${task.id}${assignedRoleStr}${assigneeStr})`

  const childLines = task.childIds.flatMap(childId => renderTaskSubtree(state, childId, depth + 1))


  return [line, ...childLines]
}

function renderTaskTreesForTaskIds(state: TaskGraphState, taskIds: readonly string[]): string {
  const roots = new Set<string>()
  for (const taskId of taskIds) {
    roots.add(findRootTaskId(state, taskId))
  }

  const renderedTrees = Array.from(roots)
    .map(rootId => renderTaskSubtree(state, rootId, 0).join('\n'))
    .filter(Boolean)
    .join('\n')

  if (!renderedTrees) return ''

  return `${renderedTrees}\n${TASK_TREE_COMPLETION_REMINDER}`
}

function findTaskForAgent(state: TaskGraphState, args: { agentId: string, forkId: string }): TaskRecord | null {
  for (const task of Array.from(state.tasks.values())) {
    if (task.worker?.agentId === args.agentId || task.worker?.forkId === args.forkId) return task
  }
  return null
}

/** Emit tokenEstimateChanged signal when tokenEstimate changes between old and new fork state. */
function emitIfChanged(
  oldFork: ForkWindowState,
  newFork: ForkWindowState,
  forkId: string | null,
  emit: { tokenEstimateChanged: (v: { forkId: string | null; tokenEstimate: number }) => void },
): void {
  if (newFork.tokenEstimate !== oldFork.tokenEstimate) {
    emit.tokenEstimateChanged({ forkId, tokenEstimate: newFork.tokenEstimate })
  }
}


export const WindowProjection = Projection.defineForked<AppEvent, ForkWindowState>()({
  name: 'Window',
  reads: [AgentStatusProjection, SubagentActivityProjection, UserPresenceProjection, OutboundMessagesProjection, UserMessageResolutionProjection, TaskGraphProjection, CanonicalTurnProjection] as const,
  ambients: [SkillsAmbient, ConfigAmbient] as const,
  signals: {
    tokenEstimateChanged: Signal.create<{ forkId: string | null; tokenEstimate: number }>('Window/tokenEstimateChanged'),
  },
  initialFork: {
    messages: [],
    queuedTimeline: [],
    currentTurnId: null,
    currentChainId: null,
    pendingPresenceText: null,
    nextQueueSeq: 0,
    tokenEstimate: 0,
    messageTokens: 0,
    systemPromptTokens: 0,
    lastAnchoredTotal: null,
    lastAnchoredMessageTokens: null,
  },

  eventHandlers: {
    session_initialized: ({ event, fork, emit, ambient }) => {
      const content = buildSessionContextContent(event.context)
      const contentParts = textParts(content)
      const entryTokens = estimateContentEntry(contentParts)
      const sessionMsg: WindowEntry = { type: 'session_context', source: 'system', content: contentParts, estimatedTokens: entryTokens }

      const skills = ambient.get(SkillsAmbient)
      const configState = ambient.get(ConfigAmbient)
      const sysPromptTokens = estimateSystemPromptTokens('leader', skills, configState)
      const messageTokens = fork.messageTokens + entryTokens
      const tokenEstimate = sysPromptTokens + messageTokens

      const result: ForkWindowState = {
        ...fork,
        messages: [sessionMsg, ...fork.messages],
        messageTokens,
        systemPromptTokens: sysPromptTokens,
        tokenEstimate,
      }
      emitIfChanged(fork, result, event.forkId, emit)
      return result
    },

    skill_activated: ({ event, fork }) => {
      if (event.source !== 'user') return fork
      const text = event.message ? `/${event.skillName} ${event.message}` : `/${event.skillName}`
      const entry = toTimelineUserMessage({ timestamp: event.timestamp, text, attachments: [] })
      return enqueueTimeline(fork, entry, event.timestamp)
    },

    user_bash_command: ({ event, fork }) =>
      enqueueTimeline(
        fork,
        toTimelineUserBashCommand({
          timestamp: event.timestamp,
          command: event.command,
          cwd: event.cwd,
          exitCode: event.exitCode,
          stdout: event.stdout,
          stderr: event.stderr,
        }),
        event.timestamp,
      ),

    turn_started: ({ event, fork, read, emit }) => {
      let nextFork = fork

      if (event.forkId === null && nextFork.pendingPresenceText !== null) {
        nextFork = enqueueTimeline(
          nextFork,
          toTimelineUserPresence({ timestamp: event.timestamp, text: nextFork.pendingPresenceText, confirmed: true }),
          event.timestamp,
        )
      } else if (event.forkId === null && read(UserPresenceProjection).currentFocusState === false) {
        nextFork = enqueueTimeline(
          nextFork,
          toTimelineUserPresence({ timestamp: event.timestamp, text: formatUserPresence(false), confirmed: false }),
          event.timestamp,
        )
      }

      const preFlushMessageCount = nextFork.messages.length
      const taskGraphState = read(TaskGraphProjection)
      const flushed = flushQueue(nextFork, taskGraphState)

      let messages = flushed.messages
      const flushProducedInbox = messages.length > preFlushMessageCount
      const lastMessage = messages[messages.length - 1]
      if (!flushProducedInbox && lastMessage?.source === 'agent') {
        messages = [...messages, { type: 'context', source: 'system', timeline: [], estimatedTokens: 0 }]
      }

      const result: ForkWindowState = {
        ...flushed,
        messages,
        currentTurnId: event.turnId,
        currentChainId: event.chainId,
        pendingPresenceText: null,
      }
      emitIfChanged(fork, result, event.forkId, emit)
      return result
    },

    observations_captured: ({ event, fork, read, emit }) => {
      if (fork.currentTurnId !== event.turnId) return fork
      const nextFork = enqueueTimeline(
        fork,
        toTimelineObservation({ timestamp: event.timestamp, parts: event.parts.map(toUserPartFromObservation) }),
        event.timestamp,
      )
      const result = flushQueue(nextFork, read(TaskGraphProjection))
      emitIfChanged(fork, result, event.forkId, emit)
      return result
    },

    turn_outcome: ({ event, fork, read, emit }) => {
      if (fork.currentTurnId !== event.turnId) return fork

      const outcome = 'outcome' in event
        ? event.outcome
        : 'result' in event
          ? (event as any).result
          : { _tag: 'SystemError' as const, message: (event as any).message ?? 'Unknown error' }

      // Read the completed turn from CanonicalTurnProjection
      const canonical = read(CanonicalTurnProjection)
      const completedTurn = canonical.lastCompleted

      // Build feedback from outcome
      const feedback: TurnFeedback[] = [...(completedTurn?.feedback ?? [])]

      switch (outcome._tag) {
        case 'Completed': {
          const hasContent = completedTurn && completedTurn.turnId === event.turnId &&
            (completedTurn.assistant.text || completedTurn.assistant.reasoning || completedTurn.assistant.toolCalls?.length || completedTurn.toolResults.length > 0)

          if (!hasContent) {
            feedback.push({ kind: 'error', message: EMPTY_RESPONSE_ERROR })
          }

          for (const fb of outcome.completion.feedback) {
            switch (fb._tag) {
              case 'InvalidMessageDestination':
                feedback.push({ kind: 'error', message: fb.message })
                break
            }
          }
          break
        }

        case 'ConnectionFailure':
        case 'ProviderNotReady':
        case 'ContextWindowExceeded':
        case 'OutputTruncated':
        case 'SafetyStop':
        case 'UnexpectedError': {
          const fb = present(outcome).llmFeedback
          if (fb) feedback.push({ kind: 'error', message: fb })
          break
        }

        case 'Cancelled':
          feedback.push({ kind: 'interrupted' })
          break

        case 'SystemError':
          feedback.push({ kind: 'error', message: outcome.message })
          break
      }

      // Build the final CompletedTurn with feedback
      const newMessages: WindowEntry[] = [...fork.messages]
      let turnEntryTokens = 0

      if (completedTurn && completedTurn.turnId === event.turnId) {
        const turn: CompletedTurn = { ...completedTurn, feedback }
        turnEntryTokens = estimateTurnEntry(turn)
        newMessages.push({
          type: 'assistant_turn',
          source: 'agent',
          turn,
          strategyId: event.strategyId,
          estimatedTokens: turnEntryTokens,
        })
      } else if (feedback.length > 0) {
        const emptyTurn: CompletedTurn = {
          turnId: event.turnId,
          assistant: { _tag: 'AssistantMessage' as const },
          toolResults: [],
          feedback,
          clean: false,
        }
        turnEntryTokens = estimateTurnEntry(emptyTurn)
        newMessages.push({
          type: 'assistant_turn',
          source: 'agent',
          turn: emptyTurn,
          strategyId: event.strategyId,
          estimatedTokens: turnEntryTokens,
        })
      }

      const messageTokens = fork.messageTokens + turnEntryTokens

      // Apply API anchor if available
      let nextFork: ForkWindowState
      if (event.inputTokens != null) {
        // Anchor: API measured inputTokens for this turn's prompt.
        // The new turn entry wasn't in the prompt, so anchor total includes it separately.
        nextFork = {
          ...fork,
          messages: newMessages,
          currentTurnId: null,
          messageTokens,
          lastAnchoredTotal: event.inputTokens + turnEntryTokens,
          lastAnchoredMessageTokens: messageTokens,
          tokenEstimate: event.inputTokens + turnEntryTokens,
        }
      } else {
        nextFork = {
          ...fork,
          messages: newMessages,
          currentTurnId: null,
          messageTokens,
          tokenEstimate: computeTokenEstimate(
            fork.systemPromptTokens, messageTokens,
            fork.lastAnchoredTotal, fork.lastAnchoredMessageTokens,
          ),
        }
      }

      // Flush queued entries on top of (possibly anchored) base
      nextFork = flushQueue(nextFork, read(TaskGraphProjection))
      emitIfChanged(fork, nextFork, event.forkId, emit)
      return nextFork
    },

    interrupt: ({ fork }) => fork,

    compaction_completed: ({ event, fork, emit }) => {
      const sessionContext: WindowEntry = event.refreshedContext
        ? (() => {
            const content = textParts(buildSessionContextContent(event.refreshedContext))
            return { type: 'session_context' as const, source: 'system' as const, content, estimatedTokens: estimateContentEntry(content) }
          })()
        : fork.messages[0]

      const remainingMessages = fork.messages.slice(1 + event.compactedMessageCount)

      const reflectionContent = textParts(`--- REFLECTION START ---\n${event.summary}\n--- REFLECTION END ---`)
      const reflectionBlock: WindowEntry = {
        type: 'compacted',
        source: 'system',
        content: reflectionContent,
        estimatedTokens: estimateContentEntry(reflectionContent),
      }

      const newMessages = [sessionContext, ...remainingMessages, reflectionBlock]
      const messageTokens = newMessages.reduce((sum, e) => sum + e.estimatedTokens, 0)

      const result: ForkWindowState = {
        ...fork,
        messages: newMessages,
        currentChainId: null,
        messageTokens,
        lastAnchoredTotal: null,
        lastAnchoredMessageTokens: null,
        tokenEstimate: fork.systemPromptTokens + messageTokens,
      }
      emitIfChanged(fork, result, event.forkId, emit)
      return result
    },
  },

  globalEventHandlers: {
    task_assigned: ({ event, state }) => {
      if (!event.workerInfo) return state
      return state
    },

    agent_created: ({ event, state, ambient }) => {
      const { forkId, parentForkId } = event
      const parentState = state.forks.get(parentForkId)
      if (!parentState) throw new Error(`Parent fork ${parentForkId} not found in WindowProjection`)

      const normalizedContext = typeof event.context === 'string' ? event.context : ''
      const contextMessage: WindowEntry[] = normalizedContext
        ? (() => {
            const content = textParts(normalizedContext)
            return [{ type: 'fork_context' as const, source: 'system' as const, content, estimatedTokens: estimateContentEntry(content) }]
          })()
        : []

      const entryTokens = contextMessage.reduce((sum, e) => sum + e.estimatedTokens, 0)

      // Seed systemPromptTokens for the child fork
      const skills = ambient.get(SkillsAmbient)
      const configState = ambient.get(ConfigAmbient)
      const sysPromptTokens = isRoleId(event.role)
        ? estimateSystemPromptTokens(event.role, skills, configState)
        : 0

      const parentMessageContent = textParts(event.message)
      const parentMessageEntry = toTimelineParentMessage({ timestamp: event.timestamp, text: event.message })

      let newForkState: ForkWindowState = {
        messages: [...contextMessage],
        queuedTimeline: [],
        currentTurnId: null,
        currentChainId: null,
        pendingPresenceText: null,
        nextQueueSeq: 0,
        messageTokens: entryTokens,
        systemPromptTokens: sysPromptTokens,
        tokenEstimate: sysPromptTokens + entryTokens,
        lastAnchoredTotal: null,
        lastAnchoredMessageTokens: null,
      }

      newForkState = enqueueTimeline(
        newForkState,
        parentMessageEntry,
        event.timestamp,
      )

      return { ...state, forks: new Map(state.forks).set(forkId, newForkState) }
    },
  },

  signalHandlers: on => [
    on(OutboundMessagesProjection.signals.messageCompleted, ({ value, state, read }) => {
      if (value.userFacing) return state

      const targetForkId = value.targetForkId
      if (targetForkId === undefined) return state
      const targetState = state.forks.get(targetForkId)
      if (!targetState) return state

      const agentState = read(AgentStatusProjection)
      const sender = value.forkId === null ? null : getAgentByForkId(agentState, value.forkId)
      const senderAgentId = sender?.agentId ?? 'lead'

      if (value.destination.kind === 'worker') {
        return {
          ...state,
          forks: new Map(state.forks).set(
            targetForkId,
            enqueueTimeline(
              targetState,
              toTimelineParentMessage({ timestamp: value.timestamp, text: value.text }),
              value.timestamp,
            ),
          ),
        }
      }

      const atom: AgentAtom = {
        kind: 'message',
        timestamp: value.timestamp,
        direction: 'to_lead',
        text: value.text,
      }

      return {
        ...state,
        forks: new Map(state.forks).set(
          targetForkId,
          enqueueAgentAtomBlock(targetState, {
            timestamp: value.timestamp,
            agentId: senderAgentId,
            role: sender?.role ?? 'lead',
            atoms: [atom],
          }),
        ),
      }
    }),

    on(SubagentActivityProjection.signals.unseenActivityAvailable, ({ value, state, read }) => {
      const parentState = state.forks.get(value.parentForkId)
      if (!parentState) return state

      let nextParent = parentState
      for (const item of value.entries) {
        const atoms: AgentAtom[] = []
        if (item.prose) {
          atoms.push({ kind: 'thought', timestamp: value.timestamp, text: item.prose })
        }

        if (atoms.length === 0) continue

        const agentState = read(AgentStatusProjection)
        const agent = agentState.agents.get(item.agentId)
        if (!agent) continue

        nextParent = enqueueAgentAtomBlock(nextParent, {
          timestamp: value.timestamp,
          agentId: item.agentId,
          role: agent.role,
          atoms,
        })
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.parentForkId, nextParent),
      }
    }),

    on(AgentStatusProjection.signals.agentBecameIdle, ({ value, state, read }) => {
      const parentState = state.forks.get(value.parentForkId)
      if (!parentState) return state

      const idleAtom: AgentAtom = {
        kind: 'idle',
        timestamp: value.timestamp,
        reason: value.reason === 'error' ? 'error' : value.reason === 'interrupt' ? 'interrupt' : 'stable',
      }

      let nextParent = enqueueAgentAtomBlock(parentState, {
        timestamp: value.timestamp,
        agentId: value.agentId,
        role: value.role,
        atoms: [idleAtom],
      })

      const taskGraphState = read(TaskGraphProjection)
      const linkedTask = findTaskForAgent(taskGraphState, { agentId: value.agentId, forkId: value.forkId })
      if (linkedTask) {
        nextParent = enqueueTimeline(
          nextParent,
          toTimelineTaskIdleHook({
            timestamp: value.timestamp,
            taskId: linkedTask.id,
            title: linkedTask.title,
            agentId: value.agentId,
          }),
          value.timestamp,
        )

        nextParent = enqueueTimeline(
          nextParent,
          toTimelineTaskTreeDirty({ timestamp: value.timestamp, taskId: linkedTask.id }),
          value.timestamp,
        )
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.parentForkId, nextParent),
      }
    }),

    on(AgentStatusProjection.signals.subagentUserKilled, ({ value, state }) => {
      const parentState = state.forks.get(value.parentForkId)
      if (!parentState) return state
      return {
        ...state,
        forks: new Map(state.forks).set(
          value.parentForkId,
          enqueueTimeline(
            parentState,
            toTimelineSubagentUserKilled({ timestamp: value.timestamp, agentId: value.agentId, agentType: value.role }),
            value.timestamp,
          ),
        ),
      }
    }),

    on(UserPresenceProjection.signals.userReturnedAfterAbsence, ({ state }) => {
      const rootState = state.forks.get(null)
      if (!rootState) return state
      return {
        ...state,
        forks: new Map(state.forks).set(null, {
          ...rootState,
          pendingPresenceText: formatUserReturnedAfterAbsence(),
        }),
      }
    }),

    on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state, read }) => {
      const targetFork = state.forks.get(value.forkId)
      if (!targetFork) return state

      const text = extractText(value.content)
      const imageAttachments: TimelineAttachment[] = (value.attachments ?? [])
        .filter((a): a is ImageAttachment => a.type === 'image')
        .map(a => ({ kind: 'image' as const, image: { _tag: 'ImagePart' as const, data: a.base64, mediaType: a.mediaType, dimensions: { width: a.width, height: a.height } }, filename: a.filename }))
      const mentionAttachments: TimelineAttachment[] = value.resolvedMentions.map(m => ({
        kind: 'mention' as const,
        ...m,
      }))
      const attachments = [...imageAttachments, ...mentionAttachments]
      const userEntry = toTimelineUserMessage({ timestamp: value.timestamp, text, attachments })

      let nextFork = enqueueTimeline(targetFork, userEntry, value.timestamp)

      if (value.forkId !== null) {
        const agent = getAgentByForkId(read(AgentStatusProjection), value.forkId)
        if (agent) {
          nextFork = enqueueTimeline(
            nextFork,
            toTimelineUserToAgent({ timestamp: value.timestamp, agentId: agent.agentId, text }),
            value.timestamp,
          )
        }
      }

      return {
        ...state,
        forks: new Map(state.forks).set(value.forkId, nextFork),
      }
    }),

    on(TaskGraphProjection.signals.taskCreated, ({ value, state, read }) => {
      const leadFork = state.forks.get(null)
      if (!leadFork) return state

      const taskGraphState = read(TaskGraphProjection)
      const task = taskGraphState.tasks.get(value.taskId)
      if (!task) return state

      let nextLead = enqueueTimeline(
        leadFork,
        toTimelineTaskTypeHook({
          timestamp: value.timestamp,
          taskId: task.id,
          title: task.title,
        }),
        value.timestamp,
      )

      nextLead = enqueueTimeline(
        nextLead,
        toTimelineTaskUpdate({
          timestamp: value.timestamp,
          action: 'created',
          taskId: task.id,
          title: task.title,
        }),
        value.timestamp,
      )

      nextLead = enqueueTimeline(
        nextLead,
        toTimelineTaskTreeDirty({ timestamp: value.timestamp, taskId: task.id }),
        value.timestamp,
      )

      return {
        ...state,
        forks: new Map(state.forks).set(null, nextLead),
      }
    }),

    on(TaskGraphProjection.signals.taskCompleted, ({ value, state, read, ambient }) => {
      const leadFork = state.forks.get(null)
      if (!leadFork) return state

      const task = read(TaskGraphProjection).tasks.get(value.taskId)

      let nextLead = enqueueTimeline(
        leadFork,
        toTimelineTaskUpdate({
          timestamp: value.timestamp,
          action: 'completed',
          taskId: value.taskId,
          title: task?.title,
        }),
        value.timestamp,
      )

      if (task) {
        nextLead = enqueueTimeline(
          nextLead,
          toTimelineTaskCompleteHook({
            timestamp: value.timestamp,
            taskId: task.id,
            title: task.title,
          }),
          value.timestamp,
        )
      }

      nextLead = enqueueTimeline(
        nextLead,
        toTimelineTaskTreeDirty({ timestamp: value.timestamp, taskId: value.taskId }),
        value.timestamp,
      )

      return {
        ...state,
        forks: new Map(state.forks).set(null, nextLead),
      }
    }),

    on(TaskGraphProjection.signals.taskCancelled, ({ value, state }) => {
      const leadFork = state.forks.get(null)
      if (!leadFork) return state

      let nextLead = enqueueTimeline(
        leadFork,
        toTimelineTaskUpdate({
          timestamp: value.timestamp,
          action: 'cancelled',
          taskId: value.taskId,
          cancelledCount: value.cancelledSubtree.length,
        }),
        value.timestamp,
      )

      nextLead = enqueueTimeline(
        nextLead,
        toTimelineTaskTreeDirty({ timestamp: value.timestamp, taskId: value.taskId }),
        value.timestamp,
      )

      return {
        ...state,
        forks: new Map(state.forks).set(null, nextLead),
      }
    }),

    on(TaskGraphProjection.signals.taskStatusChanged, ({ value, state, read }) => {
      const leadFork = state.forks.get(null)
      if (!leadFork) return state
      if (value.next === 'completed') return state

      const task = read(TaskGraphProjection).tasks.get(value.taskId)
      const action = 'status_changed'

      const nextLead = enqueueTimeline(
        leadFork,
        toTimelineTaskUpdate({
          timestamp: value.timestamp,
          action,
          taskId: value.taskId,
          title: task?.title,
          previousStatus: value.previous,
          nextStatus: value.next,
        }),
        value.timestamp,
      )

      return {
        ...state,
        forks: new Map(state.forks).set(null, nextLead),
      }
    }),
  ],
})
