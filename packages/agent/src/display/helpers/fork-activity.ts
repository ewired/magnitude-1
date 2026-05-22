import type { DisplayMessage, DisplayState, ForkActivityMessage, ForkActivityToolCounts, AgentCommunicationMessage } from '../types'
import { EMPTY_TOOL_COUNTS } from '../constants'
import type { ToolKey } from '../../tools/toolkits'
import { generateId, toPreview, insertBeforeQueuedMessages } from './messages'
import { findLastNonQueuedIndex } from './thinking'

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
  message: Omit<AgentCommunicationMessage, 'id' | 'type' | 'preview' | 'streamId' | 'status' | 'content'>,
  textDelta: string
): DisplayState {
  if (message.forkId === null) return fork

  // Find the last non-queued message — if it's a streaming communication with the same streamId, append
  const lastIdx = findLastNonQueuedIndex(fork.messages)
  const lastMsg = lastIdx >= 0 ? fork.messages[lastIdx] : undefined

  if (lastMsg?.type === 'agent_communication' && lastMsg.streamId === streamId) {
    const content = lastMsg.content + textDelta
    const newMessages = [...fork.messages]
    newMessages[lastIdx] = {
      ...lastMsg,
      content,
      preview: toPreview(content),
      status: 'streaming' as const,
    }
    return { ...fork, messages: newMessages }
  }

  // New communication — insert as top-level message
  const content = textDelta
  const msg: AgentCommunicationMessage = {
    id: generateId(),
    type: 'agent_communication',
    streamId,
    ...message,
    content,
    preview: toPreview(content),
    status: 'streaming' as const,
  }

  return { ...fork, messages: insertBeforeQueuedMessages(fork.messages, msg) }
}

export function finalizeCommunicationStreamInFork(
  fork: DisplayState,
  streamId: string
): DisplayState {
  // Find the communication message with this streamId
  const idx = fork.messages.findIndex(
    (m): m is AgentCommunicationMessage => m.type === 'agent_communication' && m.streamId === streamId
  )
  if (idx === -1) return fork

  const msg = fork.messages[idx]
  if (msg.type !== 'agent_communication') return fork

  const newMessages = [...fork.messages]
  newMessages[idx] = {
    ...msg,
    preview: toPreview(msg.content),
    status: 'completed' as const,
  }
  return { ...fork, messages: newMessages }
}
