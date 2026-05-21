/**
 * ATIF trajectory serialization
 *
 * Converts the accumulated AtifProjectionState into a valid ATIF v1.7 JSON object.
 */

import type {
  AtifTrajectory,
  AtifForkState,
  AtifStep,
  AtifFinalMetrics,
  AtifAgent,
} from './types'
import { toolDefinitionsFromToolkit } from './tool-definitions'

// =============================================================================
// Helpers
// =============================================================================

function forkToTrajectory(fork: AtifForkState, trajectoryId: string, sessionId?: string): AtifTrajectory {
  const metrics = fork.tokenAccumulator
  const finalMetrics: AtifFinalMetrics | undefined = fork.steps.length > 0
      ? {
          ...(metrics.promptTokens != null ? { total_prompt_tokens: metrics.promptTokens } : {}),
          ...(metrics.completionTokens != null ? { total_completion_tokens: metrics.completionTokens } : {}),
          ...(metrics.cachedTokens != null ? { total_cached_tokens: metrics.cachedTokens } : {}),
          ...(metrics.costUsd != null ? { total_cost_usd: metrics.costUsd } : {}),
          total_steps: fork.steps.length,
        }
      : undefined

  const agent: AtifAgent = {
    name: fork.agentName,
    version: '1.0.0',
    ...(fork.modelId ? { model_name: fork.modelId } : {}),
    ...(fork.agentRole ? { tool_definitions: toolDefinitionsFromToolkit(fork.agentRole) } : {}),
  }

  return {
    schema_version: 'ATIF-v1.7',
    ...(sessionId ? { session_id: sessionId } : {}),
    trajectory_id: trajectoryId,
    agent,
    steps: fork.steps,
    ...(finalMetrics ? { final_metrics: finalMetrics } : {}),
  }
}

// =============================================================================
// Public API
// =============================================================================

export interface SerializeOptions {
  /** Tool definitions in OpenAI function-calling schema format (overrides auto-population) */
  toolDefinitions?: readonly Record<string, unknown>[]
  /** Session identifier */
  sessionId?: string
  /** Optional root-level notes */
  notes?: string
}

/**
 * Serialize the complete ATIF trajectory from fork states.
 *
 * The root fork (forkId=null) becomes the main trajectory. All other forks
 * are embedded as `subagent_trajectories[]`.
 */
export function serializeAtif(
  forks: ReadonlyMap<string | null, AtifForkState>,
  options: SerializeOptions = {}
): AtifTrajectory {
  const rootFork = forks.get(null)
  if (!rootFork) {
    throw new Error('[AtifProjection] No root fork found for serialization')
  }

  // Build subagent trajectories from worker forks
  const subagentTrajectories: AtifTrajectory[] = []
  for (const [forkId, fork] of forks.entries()) {
    if (forkId === null) continue
    // Use the forkId (agentId) as the trajectory_id for workers
    const traj = forkToTrajectory(fork, forkId, options.sessionId)
    subagentTrajectories.push(traj)
  }

  // Build root trajectory
  const rootMetrics = rootFork.tokenAccumulator
  const finalMetrics: AtifFinalMetrics | undefined =
    rootFork.steps.length > 0 || subagentTrajectories.length > 0
      ? {
          ...(rootMetrics.promptTokens != null ? { total_prompt_tokens: rootMetrics.promptTokens } : {}),
          ...(rootMetrics.completionTokens != null ? { total_completion_tokens: rootMetrics.completionTokens } : {}),
          ...(rootMetrics.cachedTokens != null ? { total_cached_tokens: rootMetrics.cachedTokens } : {}),
          ...(rootMetrics.costUsd != null ? { total_cost_usd: rootMetrics.costUsd } : {}),
          total_steps: rootFork.steps.length,
        }
      : undefined

  const agent: AtifAgent = {
    name: rootFork.agentName,
    version: '1.0.0',
    ...(rootFork.modelId ? { model_name: rootFork.modelId } : {}),
    tool_definitions: options.toolDefinitions
      ?? (rootFork.agentRole ? toolDefinitionsFromToolkit(rootFork.agentRole) : undefined),
  }

  return {
    schema_version: 'ATIF-v1.7',
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    trajectory_id: 'main',
    agent,
    steps: rootFork.steps,
    ...(options.notes ? { notes: options.notes } : {}),
    ...(finalMetrics ? { final_metrics: finalMetrics } : {}),
    ...(subagentTrajectories.length > 0
      ? { subagent_trajectories: subagentTrajectories }
      : {}),
  }
}
