import type { DisplayMessage, DisplayState, ForkActivityMessage, ForkActivityToolCounts, CommunicationStep } from '../types'
import { EMPTY_TOOL_COUNTS } from '../constants'
import type { ToolKey } from '../../tools/toolkits'
import { findTurnBlock, ensureTurnBlock, updateStepInTurnBlock, addStepToTurnBlockFlush } from './turn-block'
import { generateId, toPreview } from './messages'

export function incrementToolCount(counts: ForkActivityToolCounts, toolKey: ToolKey): ForkActivityToolCounts {
  switch (toolKey) {
    case 'shell': return { ...counts, commands: counts.commands + 1 }
    case 'fileRead':
    case 'fileTree': return { ...counts, reads: counts.reads + 1 }
    case 'fileWrite': return { ...counts, writes: counts.writes + 1 }
    case 'fileEdit': return { ...counts, edits: counts.edits + 1 }
    case 'fileSearch': return { ...counts, searches: counts.searches + 1 }
    case 'webFetch': return { ...counts, webFetches: counts.webFetches + 1 }
    case 'webSearch': return { ...counts, webSearches: counts.webSearches + 1 }
    case 'fileView':
      return { ...counts, other: counts.other + 1 }
    default:
      return { ...counts, other: counts.other + 1 }
  }
}

export function findLastIndex<T>(arr: readonly T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}

export function totalToolsUsed(counts: ForkActivityToolCounts): number {
  return counts.commands
    + counts.reads
    + counts.writes
    + counts.edits
    + counts.searches
    + counts.webSearches
    + counts.webFetches
    + counts.artifactWrites
    + counts.artifactUpdates
    + counts.other
}

export function upsertStreamingCommunicationStep(
  fork: DisplayState,
  streamId: string,
  message: Omit<CommunicationStep, 'id' | 'type' | 'preview' | 'streamId' | 'status' | 'content'>,
  textDelta: string
): DisplayState {
  if (message.forkId === null) return fork
  const { fork: stateWithBlock, turnBlockId } = ensureTurnBlock(fork, message.timestamp)
  const block = findTurnBlock(stateWithBlock.messages, turnBlockId)
  const last = block?.steps[block.steps.length - 1]

  if (last?.type === 'communication' && last.streamId === streamId) {
    const content = last.content + textDelta
    return {
      ...stateWithBlock,
      messages: updateStepInTurnBlock(
        stateWithBlock.messages,
        turnBlockId,
        last.id,
        (s) => s.type === 'communication'
          ? { ...s, content, preview: toPreview(content), status: 'streaming' }
          : s
      )
    }
  }

  const content = textDelta
  const step: CommunicationStep = {
    id: generateId(),
    type: 'communication',
    streamId,
    ...message,
    content,
    preview: toPreview(content),
    status: 'streaming',
  }

  return {
    ...stateWithBlock,
    messages: addStepToTurnBlockFlush(stateWithBlock.messages, turnBlockId, step)
  }
}

export function finalizeCommunicationStreamInFork(
  fork: DisplayState,
  streamId: string
): DisplayState {
  if (!fork.activeTurnBlockId) return fork
  const block = findTurnBlock(fork.messages, fork.activeTurnBlockId)
  if (!block) return fork
  const step = block.steps.find((s): s is CommunicationStep => s.type === 'communication' && s.streamId === streamId)
  if (!step) return fork

  return {
    ...fork,
    messages: updateStepInTurnBlock(
      fork.messages,
      fork.activeTurnBlockId,
      step.id,
      (s) => s.type === 'communication'
        ? { ...s, preview: toPreview(s.content), status: 'completed' }
        : s
    )
  }
}
