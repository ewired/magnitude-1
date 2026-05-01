import { Projection } from '@magnitudedev/event-core'
import type { AppEvent, MessageDestination } from '../events'

export interface ThinkBlock {
  about: string | null
  content: string
}

export interface CanonicalMessage {
  readonly id: string
  readonly destination: MessageDestination
  readonly text: string
  readonly order: number
}

export interface CanonicalToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly toolKey: string
  readonly input: unknown
  readonly order: number
}

export interface CompletedTurn {
  readonly turnId: string
  readonly clean: boolean
  readonly estimatedTokens: number
}

export interface CanonicalTurnState {
  readonly turnId: string | null
  readonly thinkBlocks: readonly ThinkBlock[]
  readonly messages: readonly CanonicalMessage[]
  readonly toolCalls: readonly CanonicalToolCall[]
  readonly orderCounter: number
  readonly lastCompleted: CompletedTurn | null
}

export const createInitialCanonicalTurnState = (): CanonicalTurnState => ({
  turnId: null,
  thinkBlocks: [],
  messages: [],
  toolCalls: [],
  orderCounter: 0,
  lastCompleted: null,
})

const CHARS_PER_TOKEN = 4

function estimateCanonicalTokens(state: CanonicalTurnState): number {
  let chars = 0
  for (const t of state.thinkBlocks) chars += t.content.length
  for (const m of state.messages) chars += m.text.length
  for (const tc of state.toolCalls) {
    chars += tc.toolName.length
    chars += JSON.stringify(tc.input).length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function resetActive(state: CanonicalTurnState): CanonicalTurnState {
  return {
    ...state,
    turnId: null,
    thinkBlocks: [],
    messages: [],
    toolCalls: [],
    orderCounter: 0,
  }
}

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

    thinking_chunk: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      const blocks = [...fork.thinkBlocks]
      if (blocks.length === 0) {
        blocks.push({ about: null, content: event.text })
      } else {
        const last = blocks[blocks.length - 1]
        blocks[blocks.length - 1] = { ...last, content: last.content + event.text }
      }
      return { ...fork, thinkBlocks: blocks }
    },

    thinking_end: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      return fork
    },

    thinking_start: ({ fork }) => fork,

    message_start: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      const nextMessages = [...fork.messages, {
        id: event.id,
        destination: event.destination,
        text: '',
        order: fork.orderCounter,
      }]
      return {
        ...fork,
        messages: nextMessages,
        orderCounter: fork.orderCounter + 1,
      }
    },

    message_chunk: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork
      const idx = fork.messages.findIndex(m => m.id === event.id)
      if (idx === -1) return fork
      const next = [...fork.messages]
      next[idx] = { ...next[idx], text: next[idx].text + event.text }
      return { ...fork, messages: next }
    },

    message_end: ({ fork }) => fork,

    tool_event: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork

      switch (event.event._tag) {
        case 'ToolInputStarted': {
          const nextToolCalls = [...fork.toolCalls, {
            toolCallId: event.toolCallId,
            toolName: event.event.toolName,
            toolKey: event.toolKey,
            input: {},
            order: fork.orderCounter,
          }]
          return {
            ...fork,
            toolCalls: nextToolCalls,
            orderCounter: fork.orderCounter + 1,
          }
        }

        case 'ToolInputReady':
          return fork

        case 'ToolExecutionStarted': {
          const idx = fork.toolCalls.findIndex(tc => tc.toolCallId === event.toolCallId)
          if (idx === -1) return fork
          const next = [...fork.toolCalls]
          next[idx] = { ...next[idx], input: event.event.input }
          return { ...fork, toolCalls: next }
        }

        default:
          return fork
      }
    },

    turn_outcome: ({ event, fork }) => {
      if (fork.turnId !== event.turnId) return fork

      const clean = event.outcome._tag === 'Completed'

      const finalized: CanonicalTurnState = {
        ...fork,
        lastCompleted: {
          turnId: event.turnId,
          clean,
          estimatedTokens: estimateCanonicalTokens(fork),
        }
      }

      return resetActive(finalized)
    },

    interrupt: ({ fork }) => fork,

  }
})