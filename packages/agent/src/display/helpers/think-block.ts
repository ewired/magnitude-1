import type { DisplayMessage, DisplayState, ThinkBlockMessage, ThinkBlockStep, ThinkingStep } from '../types'
import { flushHeld, heldBuffers } from './thinking'
import { generateId, insertBeforeQueuedMessages } from './messages'
import { finalizeOpenToolStepsAsInterruptedInSteps } from './interrupt'
import type { ToolState } from '../../models/index'

export const findThinkBlock = (messages: readonly DisplayMessage[], id: string): ThinkBlockMessage | undefined =>
  messages.find((m): m is ThinkBlockMessage => m.type === 'think_block' && m.id === id)

export function updateMessageById<T extends DisplayMessage>(
  messages: readonly DisplayMessage[],
  id: string,
  updater: (msg: T) => T
): DisplayMessage[] {
  // NOTE: This generic cast is intentionally retained; TS cannot infer T inside map callback.
  return messages.map(m => m.id === id ? updater(m as T) : m)
}

/**
 * Ensures there's an active ThinkBlock, creating one if needed.
 * New ThinkBlocks are inserted BEFORE queued messages.
 */
export function ensureThinkBlock(
  state: DisplayState,
  timestamp: number
): { fork: DisplayState; thinkBlockId: string } {
  if (state.activeThinkBlockId) {
    // Verify it still exists
    const existing = findThinkBlock(state.messages, state.activeThinkBlockId)
    if (existing && existing.status === 'active') {
      return { fork: state, thinkBlockId: state.activeThinkBlockId }
    }
  }

  const thinkBlockId = generateId()
  const thinkBlock: ThinkBlockMessage = {
    id: thinkBlockId,
    type: 'think_block',
    status: 'active',
    steps: [],
    timestamp
  }

  // Insert before queued messages
  const messages = insertBeforeQueuedMessages(state.messages, thinkBlock)

  return {
    fork: {
      ...state,
      messages,
      activeThinkBlockId: thinkBlockId
    },
    thinkBlockId
  }
}

export function addStepToThinkBlock(
  messages: readonly DisplayMessage[],
  thinkBlockId: string,
  step: ThinkBlockStep
): DisplayMessage[] {
  return updateMessageById<ThinkBlockMessage>(messages, thinkBlockId, (block) => ({
    ...block,
    steps: [...block.steps, step]
  }))
}

export function updateStepInThinkBlock(
  messages: readonly DisplayMessage[],
  thinkBlockId: string,
  stepId: string,
  updater: (step: ThinkBlockStep) => ThinkBlockStep
): DisplayMessage[] {
  return updateMessageById<ThinkBlockMessage>(messages, thinkBlockId, (block) => ({
    ...block,
    steps: block.steps.map(s => s.id === stepId ? updater(s) : s)
  }))
}

function flushAllHeldInBlock(block: ThinkBlockMessage): ThinkBlockMessage {
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

export function addStepToThinkBlockFlush(
  messages: readonly DisplayMessage[],
  thinkBlockId: string,
  step: ThinkBlockStep
): DisplayMessage[] {
  const block = findThinkBlock(messages, thinkBlockId)
  if (block) {
    const lastStep = block.steps[block.steps.length - 1]
    if (lastStep?.type === 'thinking') {
      const flushed = flushHeld(lastStep.id)
      if (flushed) {
        const flushedMessages = updateStepInThinkBlock(
          messages,
          thinkBlockId,
          lastStep.id,
          (s) => s.type === 'thinking' ? { ...s, content: s.content + flushed } : s
        )
        return addStepToThinkBlock(flushedMessages, thinkBlockId, step)
      }
    }
  }
  return addStepToThinkBlock(messages, thinkBlockId, step)
}

export function closeThinkBlock(state: DisplayState, timestamp: number): DisplayState {
  if (!state.activeThinkBlockId) return state

  const block = findThinkBlock(state.messages, state.activeThinkBlockId)
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

  const updatedBlock: ThinkBlockMessage = { ...flushedBlock, steps: filteredSteps }

  // Remove empty think blocks
  if (updatedBlock.steps.length === 0) {
    return {
      ...state,
      messages: state.messages.filter(m => m.id !== state.activeThinkBlockId),
      activeThinkBlockId: null
    }
  }

  return {
    ...state,
    messages: updateMessageById<ThinkBlockMessage>(
      state.messages,
      state.activeThinkBlockId,
      (b) => (b.id === updatedBlock.id ? { ...updatedBlock, status: 'completed', completedAt: timestamp } : b)
    ),
    activeThinkBlockId: null
  }
}

export function finalizeOpenToolStepsAsInterrupted(
  state: DisplayState,
  toolStateFork: { readonly toolHandles: { readonly [callId: string]: { readonly state: ToolState } } }
): DisplayState {
  if (!state.activeThinkBlockId) return state
  const block = findThinkBlock(state.messages, state.activeThinkBlockId)
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
    messages: updateMessageById<ThinkBlockMessage>(
      state.messages, state.activeThinkBlockId,
      (b) => ({ ...b, steps: nextSteps })
    )
  }
}
