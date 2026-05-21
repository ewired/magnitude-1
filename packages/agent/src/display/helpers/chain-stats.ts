import type { DisplayState, ToolKey } from '../types'

export interface ChainStats {
  readonly workersStarted: number
  readonly editCount: number
  readonly writeCount: number
  readonly shellCount: number
  readonly readCount: number
  readonly searchCount: number
  readonly webSearchCount: number
}

export const EMPTY_CHAIN_STATS: ChainStats = {
  workersStarted: 0,
  editCount: 0,
  writeCount: 0,
  shellCount: 0,
  readCount: 0,
  searchCount: 0,
  webSearchCount: 0,
}

/**
 * Derive chain stats from display state.
 * Scans turn blocks within the current chain's time range only.
 * Counts lead's tool usage + workers started (from spawnWorker tool steps).
 * Pure function — deterministic, no incremental state.
 */
export function computeChainStats(state: DisplayState | null | undefined): ChainStats {
  const stats = { ...EMPTY_CHAIN_STATS }
  if (!state || state.chainStatus === null || state.chainStartTime === null) {
    return stats
  }

  const endTime = state.chainStatus === 'completed' && state.chainEndTime !== null
    ? state.chainEndTime
    : Infinity

  for (const msg of state.messages) {
    if (msg.type !== 'turn_block') continue
    if (msg.timestamp < state.chainStartTime || msg.timestamp > endTime) continue
    for (const step of msg.steps) {
      if (step.type === 'tool') {
        if (step.toolKey === 'spawnWorker') {
          stats.workersStarted++
        } else {
          incrementToolCount(stats, step.toolKey)
        }
      }
    }
  }
  return stats
}

function incrementToolCount(stats: Record<string, number>, toolKey: ToolKey): void {
  switch (toolKey) {
    case 'fileEdit': stats.editCount++; break
    case 'fileWrite': stats.writeCount++; break
    case 'shell': stats.shellCount++; break
    case 'fileRead': stats.readCount++; break
    case 'fileSearch': stats.searchCount++; break
    case 'webSearch': stats.webSearchCount++; break
  }
}
