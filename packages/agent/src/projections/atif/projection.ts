/**
 * AtifProjection (Forked)
 *
 * ATIF (Agent Trajectory Interchange Format) v1.7 projection derived from the
 * AppEvent stream. Each fork (leader=null, workers by agentId) accumulates its
 * own steps independently.
 *
 * Ambient-gated: every event handler checks AtifAmbient and short-circuits if
 * disabled. Zero cost when ATIF is not enabled.
 */

import { Projection } from '@magnitudedev/event-core'
import type { AppEvent } from '../../events'
import { outcomeWillChainContinue } from '../../events'
import { AtifAmbient, type AtifConfig } from '../../ambient/atif-ambient'
import { AgentRoutingProjection } from '../agent-routing'
import { AgentStatusProjection, getAgentByForkId } from '../agent-status'

import type {
  AtifForkState,
  AtifProjectionState,
  AtifStep,
  PartialAtifStep,
  PendingToolCall,
} from './types'
import { atifSignals } from './signals'
import {
  userMessageToStep,
  beginAgentStep,
  accumulateThinkingChunk,
  accumulateMessageChunk,
  addToolCallToStep,
  addObservationToStep,
  finalizeAgentStep,
  agentCreatedToStep,
  compactionPreparedToStep,
  interruptToStep,
  agentKilledToStep,
} from './mapping'

// =============================================================================
// Helpers
// =============================================================================

function isEnabled(ambient: { get: (a: typeof AtifAmbient) => AtifConfig }): boolean {
  return ambient.get(AtifAmbient).enabled
}

function createInitialFork(forkId: string | null, agentName: string = 'magnitude'): AtifForkState {
  return {
    forkId,
    agentName,
    agentRole: forkId === null ? 'leader' : null,
    modelId: null,
    steps: [],
    nextStepId: 1,
    pendingToolCalls: new Map(),
    currentStep: null,
    compactionBoundaryIndex: null,
    tokenAccumulator: {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    },
  }
}

function emitStep(
  fork: AtifForkState,
  step: AtifStep,
  emit: { readonly stepAdded: (value: { forkId: string | null; step: AtifStep; stepIndex: number }) => void }
): AtifForkState {
  emit.stepAdded({ forkId: fork.forkId, step, stepIndex: fork.steps.length })
  return {
    ...fork,
    steps: [...fork.steps, step],
    nextStepId: fork.nextStepId + 1,
  }
}

function timestampToIso(ts: number): string {
  return new Date(ts).toISOString()
}

// =============================================================================
// Projection
// =============================================================================

export const AtifProjection = Projection.defineForked<AppEvent, AtifForkState>()({
  name: 'Atif',

  reads: [AgentRoutingProjection, AgentStatusProjection] as const,
  ambients: [AtifAmbient] as const,

  signals: atifSignals,

  initialFork: createInitialFork(null),

  eventHandlers: {
    user_message: ({ event, fork, ambient, emit }) => {
      if (!isEnabled(ambient)) return fork
      const step = userMessageToStep(event, fork.nextStepId)
      return emitStep(fork, step, emit)
    },

    turn_started: ({ event, fork, ambient }) => {
      if (!isEnabled(ambient)) return fork
      // model_name is resolved from turn_outcome (which carries modelId from the provider)
      const partial = beginAgentStep(event, fork.nextStepId, null)
      return { ...fork, currentStep: partial }
    },

    thinking_chunk: ({ event, fork, ambient }) => {
      if (!isEnabled(ambient)) return fork
      if (!fork.currentStep) return fork
      if (fork.currentStep.step_id !== fork.nextStepId) return fork
      return { ...fork, currentStep: accumulateThinkingChunk(fork.currentStep, event) }
    },

    message_chunk: ({ event, fork, ambient }) => {
      if (!isEnabled(ambient)) return fork
      if (!fork.currentStep) return fork
      if (fork.currentStep.step_id !== fork.nextStepId) return fork
      return { ...fork, currentStep: accumulateMessageChunk(fork.currentStep, event) }
    },

    tool_event: ({ event, fork, ambient }) => {
      if (!isEnabled(ambient)) return fork
      if (!fork.currentStep) return fork
      if (fork.currentStep.step_id !== fork.nextStepId) return fork

      const lifecycle = event.event as {
        _tag: string
        toolName?: string
        toolKey?: string
        input?: Record<string, unknown>
        cached?: boolean
      }

      if (lifecycle._tag === 'ToolInputReady') {
        const toolCall: PendingToolCall = {
          toolCallId: event.toolCallId,
          function_name: lifecycle.toolName ?? String(event.toolKey),
          arguments: {},
          stepId: fork.nextStepId,
        }
        return {
          ...fork,
          pendingToolCalls: new Map(fork.pendingToolCalls).set(event.toolCallId, toolCall),
          currentStep: addToolCallToStep(fork.currentStep, event),
        }
      }

      if (lifecycle._tag === 'ToolExecutionStarted') {
        const pending = fork.pendingToolCalls.get(event.toolCallId)
        if (pending) {
          const updatedPending: PendingToolCall = { ...pending, arguments: lifecycle.input ?? {} }
          const toolCallIndex = fork.currentStep.tool_calls.findIndex(
            tc => tc.tool_call_id === event.toolCallId
          )
          let updatedStep = fork.currentStep
          if (toolCallIndex >= 0) {
            const updatedToolCalls = [...fork.currentStep.tool_calls]
            updatedToolCalls[toolCallIndex] = {
              ...updatedToolCalls[toolCallIndex],
              arguments: lifecycle.input ?? {},
              ...(lifecycle.cached != null ? { extra: { ...(updatedToolCalls[toolCallIndex].extra ?? {}), cached: lifecycle.cached } } : {}),
            }
            updatedStep = { ...fork.currentStep, tool_calls: updatedToolCalls }
          }
          return {
            ...fork,
            currentStep: updatedStep,
            pendingToolCalls: new Map(fork.pendingToolCalls).set(event.toolCallId, updatedPending),
          }
        }
        return fork
      }

      if (lifecycle._tag === 'ToolExecutionEnded') {
        const updatedStep = addObservationToStep(fork.currentStep, event, fork.pendingToolCalls)
        const nextPending = new Map(fork.pendingToolCalls)
        nextPending.delete(event.toolCallId)
        return { ...fork, currentStep: updatedStep, pendingToolCalls: nextPending }
      }

      return fork
    },

    turn_outcome: ({ event, fork, ambient, emit }) => {
      if (!isEnabled(ambient)) return fork
      if (!fork.currentStep) return fork
      if (fork.currentStep.step_id !== fork.nextStepId) return fork

      const step = finalizeAgentStep(fork.currentStep, event)
      const stepCost = step.metrics?.cost_usd ?? 0

      const nextAccumulator = {
        promptTokens: fork.tokenAccumulator.promptTokens + (event.inputTokens ?? 0),
        completionTokens: fork.tokenAccumulator.completionTokens + (event.outputTokens ?? 0),
        cachedTokens: fork.tokenAccumulator.cachedTokens + (event.cacheReadTokens ?? 0),
        costUsd: fork.tokenAccumulator.costUsd + stepCost,
      }

      const nextFork = emitStep({ ...fork, tokenAccumulator: nextAccumulator }, step, emit)
      return { ...nextFork, currentStep: null }
    },

    tool_approved: ({ event, fork, ambient, emit }) => {
      if (!isEnabled(ambient)) return fork
      const step: AtifStep = {
        step_id: fork.nextStepId,
        timestamp: timestampToIso(Date.now()),
        source: 'user',
        message: `Approved tool call ${event.toolCallId}`,
        extra: { toolCallId: event.toolCallId, action: 'approved' },
        llm_call_count: 0,
      }
      return emitStep(fork, step, emit)
    },

    tool_rejected: ({ event, fork, ambient, emit }) => {
      if (!isEnabled(ambient)) return fork
      const step: AtifStep = {
        step_id: fork.nextStepId,
        timestamp: timestampToIso(Date.now()),
        source: 'user',
        message: event.reason
          ? `Rejected tool call ${event.toolCallId}: ${event.reason}`
          : `Rejected tool call ${event.toolCallId}`,
        extra: { toolCallId: event.toolCallId, action: 'rejected', ...(event.reason ? { reason: event.reason } : {}) },
        llm_call_count: 0,
      }
      return emitStep(fork, step, emit)
    },

    interrupt: ({ event, fork, ambient, emit }) => {
      if (!isEnabled(ambient)) return fork
      const step = interruptToStep(event, fork.nextStepId)
      return emitStep(fork, step, emit)
    },

    compaction_prepared: ({ event, fork, ambient, emit }) => {
      if (!isEnabled(ambient)) return fork
      const step = compactionPreparedToStep(event, fork.nextStepId)
      // Record the boundary index — steps before this will get is_copied_context
      // when compaction_injected fires
      return emitStep(
        { ...fork, compactionBoundaryIndex: fork.steps.length },
        step,
        emit,
      )
    },

    compaction_injected: ({ event, fork, ambient }) => {
      if (!isEnabled(ambient)) return fork
      // Mark steps before the compaction boundary as is_copied_context: true
      const boundary = fork.compactionBoundaryIndex
      if (boundary == null || boundary === 0) return fork

      const updatedSteps = fork.steps.map((step, i) =>
        i < boundary ? { ...step, is_copied_context: true } : step
      )
      return { ...fork, steps: updatedSteps, compactionBoundaryIndex: null }
    },
  },

  globalEventHandlers: {
    turn_outcome: ({ event, state, ambient, emit }) => {
      if (!isEnabled(ambient)) return state
      if (event.forkId === null) return state
      if (outcomeWillChainContinue(event.outcome)) return state
      const fork = state.forks.get(event.forkId)
      if (!fork) return state
      emit.forkCompleted({ forkId: event.forkId, stepCount: fork.steps.length })
      return state
    },

    agent_killed: ({ event, state, ambient, emit }) => {
      if (!isEnabled(ambient)) return state
      const fork = state.forks.get(event.forkId)
      if (!fork) return state
      // Emit a terminal system step before marking the fork completed
      const terminalStep = agentKilledToStep(event.agentId, event.reason, fork.nextStepId)
      const nextFork = emitStep(fork, terminalStep, emit)
      emit.forkCompleted({ forkId: event.forkId, stepCount: nextFork.steps.length })
      return { ...state, forks: new Map(state.forks).set(event.forkId, nextFork) }
    },

    subagent_user_killed: ({ event, state, ambient, emit }) => {
      if (!isEnabled(ambient)) return state
      const fork = state.forks.get(event.forkId)
      if (!fork) return state
      const terminalStep = agentKilledToStep(event.agentId, 'user_killed', fork.nextStepId)
      const nextFork = emitStep(fork, terminalStep, emit)
      emit.forkCompleted({ forkId: event.forkId, stepCount: nextFork.steps.length })
      return { ...state, forks: new Map(state.forks).set(event.forkId, nextFork) }
    },

    agent_created: ({ event, state, ambient, emit }) => {
      if (!isEnabled(ambient)) return state

      // The spawnWorker step belongs on the parent's trajectory
      const parentForkId = event.parentForkId
      const parentFork = state.forks.get(parentForkId)
      if (!parentFork) return state

      const step = agentCreatedToStep(event, parentFork.nextStepId, event.agentId)
      const nextParentFork = emitStep(parentFork, step, emit)

      // Create the child fork with proper agent name derived from role
      const childFork = {
        ...createInitialFork(event.forkId, `magnitude-${event.role}`),
        agentRole: event.role,
      }

      return {
        ...state,
        forks: new Map(state.forks)
          .set(parentForkId, nextParentFork)
          .set(event.forkId, childFork),
      }
    },
  },

  signalHandlers: (on) => [
    on(AgentRoutingProjection.signals.agentRegistered, ({ value, state, ambient, read }) => {
      if (!isEnabled(ambient)) return state
      const { forkId } = value
      if (state.forks.has(forkId)) return state

      // Derive agentName from AgentStatusProjection if available
      let agentName = 'magnitude'
      const agentStatus = read(AgentStatusProjection)
      const agent = getAgentByForkId(agentStatus, forkId)
      if (agent) {
        agentName = agent.name || `magnitude-${agent.role}`
      }

      const newFork: AtifForkState = {
        ...createInitialFork(forkId),
        agentName,
        agentRole: agent ? agent.role : null,
      }
      return { ...state, forks: new Map(state.forks).set(forkId, newFork) }
    }),
  ],
})
