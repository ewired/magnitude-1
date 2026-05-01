import { Projection } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'
import type { CompletedTurn, TurnFeedback } from '../inbox/types'
import type { AssistantMessage, ToolResultMessage, ToolCallPart, ToolCallId, JsonValue } from '@magnitudedev/ai'
import { renderToolOutput } from '../util/render-tool-output'

export interface CanonicalTurnState {
  readonly turnId: string | null

  // Accumulate directly into AI primitive fields
  readonly reasoning: string
  readonly text: string
  readonly toolCalls: readonly ToolCallPart[]
  readonly toolResults: readonly ToolResultMessage[]

  // Minimal streaming bookkeeping
  readonly activeMessageId: string | null
  readonly activeMessageIsParent: boolean
  readonly parentChars: number

  // Output
  readonly lastCompleted: CompletedTurn | null
}

export const createInitialCanonicalTurnState = (): CanonicalTurnState => ({
  turnId: null,
  reasoning: '',
  text: '',
  toolCalls: [],
  toolResults: [],
  activeMessageId: null,
  activeMessageIsParent: false,
  parentChars: 0,
  lastCompleted: null,
})

export const CanonicalTurnProjection = Projection.defineForked<AppEvent, CanonicalTurnState>()({
  name: 'CanonicalTurn',
  reads: [] as const,
  ambients: [] as const,
  initialFork: createInitialCanonicalTurnState(),
  eventHandlers: {
    turn_started: ({ event, fork }) => ({
      ...createInitialCanonicalTurnState(),
      turnId: event.turnId,
      lastCompleted: fork.lastCompleted,
    }),

    thinking_start: ({ fork }) => fork,
    thinking_end: ({ fork }) => fork,

    thinking_chunk: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      return { ...fork, reasoning: fork.reasoning + event.text }
    },

    message_start: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      return {
        ...fork,
        activeMessageId: event.id,
        activeMessageIsParent: event.destination.kind === 'parent',
      }
    },

    message_chunk: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      if (fork.activeMessageId !== event.id) return fork
      return {
        ...fork,
        text: fork.text + event.text,
        parentChars: fork.activeMessageIsParent ? fork.parentChars + event.text.length : fork.parentChars,
      }
    },

    message_end: ({ fork }) => ({
      ...fork,
      activeMessageId: null,
      activeMessageIsParent: false,
    }),

    tool_event: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork

      switch (event.event._tag) {
        case 'ToolInputStarted': {
          return {
            ...fork,
            toolCalls: [...fork.toolCalls, {
              _tag: 'ToolCallPart' as const,
              id: event.toolCallId as ToolCallId,
              name: event.event.toolName,
              input: {} as JsonValue,
            }],
          }
        }

        case 'ToolInputReady':
          return fork

        case 'ToolExecutionStarted': {
          const idx = fork.toolCalls.findIndex(tc => tc.id === event.toolCallId)
          if (idx === -1) return fork
          const next = [...fork.toolCalls]
          next[idx] = { ...next[idx], input: event.event.input as JsonValue }
          return { ...fork, toolCalls: next }
        }

        case 'ToolExecutionEnded': {
          const { toolCallId, toolName, result } = event.event
          return {
            ...fork,
            toolResults: [...fork.toolResults, {
              _tag: 'ToolResultMessage' as const,
              toolCallId: toolCallId as ToolCallId,
              toolName,
              parts: [...renderToolOutput(result)],
            }],
          }
        }

        default:
          return fork
      }
    },

    turn_outcome: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork

      const feedback: TurnFeedback[] = fork.parentChars > 0
        ? [{ kind: 'message_ack', destination: 'parent' as const, chars: fork.parentChars }]
        : []

      const assistant: AssistantMessage = {
        _tag: 'AssistantMessage',
        reasoning: fork.reasoning || undefined,
        text: fork.text || undefined,
        toolCalls: fork.toolCalls.length > 0 ? [...fork.toolCalls] : undefined,
      }

      const completed: CompletedTurn = {
        turnId: event.turnId,
        assistant,
        toolResults: [...fork.toolResults],
        feedback,
        clean: event.outcome._tag === 'Completed',
      }

      return {
        ...createInitialCanonicalTurnState(),
        lastCompleted: completed,
      }
    },

    interrupt: ({ fork }) => fork,
  },
})