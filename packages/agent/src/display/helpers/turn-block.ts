import type { DisplayMessage, DisplayState, TurnBlockMessage, TurnBlockStep, ThinkingStep } from '../types'
import { flushHeld, heldBuffers } from './thinking'
import { generateId, insertBeforeQueuedMessages } from './messages'
import { finalizeOpenToolStepsAsInterruptedInSteps } from './interrupt'
import type { ToolState } from '../../models/index'

export const findTurnBlock = (messages: readonly DisplayMessage[], id: string): TurnBlockMessage | undefined =>
  messages.find((m): m is TurnBlockMessage => m.type === 'turn_block' && m.id === id)

export function updateMessageById<T extends DisplayMessage>(
  messages: readonly DisplayMessage[],
  id: string,
  updater: (msg: T) => T
): DisplayMessage[] {
  // NOTE: This generic cast is intentionally retained; TS cannot infer T inside map callback.
  return messages.map(m => m.id === id ? updater(m as T) : m)
}

/**
 * Ensures there's an active TurnBlock, creating one if needed.
 * New TurnBlocks are inserted BEFORE queued messages.
 */
export function ensureTurnBlock(
  state: DisplayState,
  timestamp: number
): { fork: DisplayState; turnBlockId: string } {
  if (state.activeTurnBlockId) {
    // Verify it still exists
    const existing = findTurnBlock(state.messages, state.activeTurnBlockId)
    if (existing && existing.status === 'active') {
      return { fork: state, turnBlockId: state.activeTurnBlockId }
    }
  }

  const turnBlockId = generateId()
  const turnBlock: TurnBlockMessage = {
    id: turnBlockId,
    type: 'turn_block',
    status: 'active',
    steps: [],
    timestamp
  }

  // Insert before queued messages
  const messages = insertBeforeQueuedMessages(state.messages, turnBlock)

  return {
    fork: {
      ...state,
      messages,
      activeTurnBlockId: turnBlockId
    },
    turnBlockId
  }
}

export function addStepToTurnBlock(
  messages: readonly DisplayMessage[],
  turnBlockId: string,
  step: TurnBlockStep
): DisplayMessage[] {
  return updateMessageById<TurnBlockMessage>(messages, turnBlockId, (block) => ({
    ...block,
    steps: [...block.steps, step]
  }))
}

export function updateStepInTurnBlock(
  messages: readonly DisplayMessage[],
  turnBlockId: string,
  stepId: string,
  updater: (step: TurnBlockStep) => TurnBlockStep
): DisplayMessage[] {
  return updateMessageById<TurnBlockMessage>(messages, turnBlockId, (block) => ({
    ...block,
    steps: block.steps.map(s => s.id === stepId ? updater(s) : s)
  }))
}

function flushAllHeldInBlock(block: TurnBlockMessage): TurnBlockMessage {
  const newSteps = block.steps.map((step) => {
    if (step.type !== 'thinking') return step
    const flushed = flushHeld(step.id)
    if (flushed) {
      return { ...step, content: step.content + flushed }
    }
    return step
  })
  return { ...block, steps: newSteps }
}

export function addStepToTurnBlockFlush(
  messages: readonly DisplayMessage[],
  turnBlockId: string,
  step: TurnBlockStep
): DisplayMessage[] {
  const block = findTurnBlock(messages, turnBlockId)
  if (block) {
    const lastStep = block.steps[block.steps.length - 1]
    if (lastStep?.type === 'thinking') {
      const flushed = flushHeld(lastStep.id)
      if (flushed) {
        const flushedMessages = updateStepInTurnBlock(
          messages,
          turnBlockId,
          lastStep.id,
          (s) => s.type === 'thinking' ? { ...s, content: s.content + flushed } : s
        )
        return addStepToTurnBlock(flushedMessages, turnBlockId, step)
      }
    }
  }
  return addStepToTurnBlock(messages, turnBlockId, step)
}

export function closeTurnBlock(state: DisplayState, timestamp: number): DisplayState {
  if (!state.activeTurnBlockId) return state

  const block = findTurnBlock(state.messages, state.activeTurnBlockId)
  if (!block) return state

  // Flush held buffers for all thinking steps in the block
  const flushedBlock = flushAllHeldInBlock(block)

  // Remove thinking steps with empty content after flush, and clean up heldBuffers
  const filteredSteps = flushedBlock.steps.filter((step) => {
    if (step.type === 'thinking' && step.content === '') {
      heldBuffers.delete(step.id)
      return false
    }
    return true
  })

  const updatedBlock: TurnBlockMessage = { ...flushedBlock, steps: filteredSteps }

  // Remove empty turn blocks
  if (updatedBlock.steps.length === 0) {
    return {
      ...state,
      messages: state.messages.filter(m => m.id !== state.activeTurnBlockId),
      activeTurnBlockId: null
    }
  }

  return {
    ...state,
    messages: updateMessageById<TurnBlockMessage>(
      state.messages,
      state.activeTurnBlockId,
      (b) => (b.id === updatedBlock.id ? { ...updatedBlock, status: 'completed', completedAt: timestamp } : b)
    ),
    activeTurnBlockId: null
  }
}

export function finalizeOpenToolStepsAsInterrupted(
  state: DisplayState,
  toolStateFork: { readonly toolHandles: { readonly [callId: string]: { readonly state: ToolState } } }
): DisplayState {
  if (!state.activeTurnBlockId) return state
  const block = findTurnBlock(state.messages, state.activeTurnBlockId)
  if (!block) return state

  const nextSteps = finalizeOpenToolStepsAsInterruptedInSteps(block.steps, (_toolKey, currentState, stepId) => {
    if (!stepId) return currentState
    return toolStateFork.toolHandles[stepId]?.state ?? currentState
  })

  if (nextSteps === block.steps || nextSteps.every((step, i) => step === block.steps[i])) {
    return state
  }

  return {
    ...state,
    messages: updateMessageById<TurnBlockMessage>(
      state.messages, state.activeTurnBlockId,
      (b) => ({ ...b, steps: nextSteps })
    )
  }
}
