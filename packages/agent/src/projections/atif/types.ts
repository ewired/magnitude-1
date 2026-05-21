/**
 * ATIF (Agent Trajectory Interchange Format) v1.7 types
 * Native Magnitude projection types mirroring the Harbor ATIF spec.
 */

import type { RoleId } from '../../agents/role-validation'

// =============================================================================
// Content / Message Types
// =============================================================================

export interface AtifTextPart {
  readonly type: 'text'
  readonly text: string
}

export interface AtifImageSource {
  readonly media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  readonly path: string
}

export interface AtifImagePart {
  readonly type: 'image'
  readonly source: AtifImageSource
}

export type AtifContentPart = AtifTextPart | AtifImagePart

export type AtifMessage = string | readonly AtifContentPart[]

// =============================================================================
// Tool Call
// =============================================================================

export interface AtifToolCall {
  readonly tool_call_id: string
  readonly function_name: string
  readonly arguments: Record<string, unknown>
  readonly extra?: Record<string, unknown>
}

// =============================================================================
// Observation
// =============================================================================

export interface AtifSubagentTrajectoryRef {
  readonly trajectory_id?: string
  readonly trajectory_path?: string
  readonly session_id?: string
  readonly extra?: Record<string, unknown>
}

export interface AtifObservationResult {
  readonly source_call_id?: string | null
  readonly content?: AtifMessage
  readonly subagent_trajectory_ref?: readonly AtifSubagentTrajectoryRef[]
  readonly extra?: Record<string, unknown>
}

export interface AtifObservation {
  readonly results: readonly AtifObservationResult[]
}

// =============================================================================
// Metrics
// =============================================================================

export interface AtifMetrics {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly cached_tokens?: number
  readonly cost_usd?: number
  readonly prompt_token_ids?: readonly number[]
  readonly completion_token_ids?: readonly number[]
  readonly logprobs?: readonly number[]
  readonly extra?: Record<string, unknown>
}

// =============================================================================
// Step
// =============================================================================

export type AtifStepSource = 'system' | 'user' | 'agent'

export interface AtifStep {
  readonly step_id: number
  readonly timestamp?: string | null
  readonly source: AtifStepSource
  readonly model_name?: string | null
  readonly reasoning_effort?: string | number | null
  readonly message: AtifMessage
  readonly reasoning_content?: string | null
  readonly tool_calls?: readonly AtifToolCall[]
  readonly observation?: AtifObservation
  readonly metrics?: AtifMetrics
  readonly is_copied_context?: boolean
  readonly llm_call_count?: number
  readonly extra?: Record<string, unknown>
}

// =============================================================================
// Agent Info
// =============================================================================

export interface AtifAgent {
  readonly name: string
  readonly version: string
  readonly model_name?: string | null
  readonly tool_definitions?: readonly Record<string, unknown>[]
  readonly extra?: Record<string, unknown>
}

// =============================================================================
// Final Metrics
// =============================================================================

export interface AtifFinalMetrics {
  readonly total_prompt_tokens?: number
  readonly total_completion_tokens?: number
  readonly total_cached_tokens?: number
  readonly total_cost_usd?: number
  readonly total_steps?: number
  readonly extra?: Record<string, unknown>
}

// =============================================================================
// Trajectory
// =============================================================================

export interface AtifTrajectory {
  readonly schema_version: 'ATIF-v1.7'
  readonly session_id?: string
  readonly trajectory_id?: string
  readonly agent: AtifAgent
  readonly steps: readonly AtifStep[]
  readonly notes?: string
  readonly final_metrics?: AtifFinalMetrics
  readonly continued_trajectory_ref?: string
  readonly extra?: Record<string, unknown>
  readonly subagent_trajectories?: readonly AtifTrajectory[]
}

// =============================================================================
// Projection State
// =============================================================================

export interface PendingToolCall {
  readonly toolCallId: string
  readonly function_name: string
  readonly arguments: Record<string, unknown>
  readonly stepId: number
}

export interface AtifForkState {
  /** Fork ID this trajectory belongs to (null = root/leader) */
  readonly forkId: string | null
  /** Agent display name (e.g. 'magnitude', 'magnitude-scout') */
  readonly agentName: string
  /** Agent role ID */
  readonly agentRole: RoleId | null
  /** Resolved model ID */
  readonly modelId: string | null
  /** Sequential ATIF steps */
  readonly steps: AtifStep[]
  /** Next step_id counter */
  readonly nextStepId: number
  /** Pending tool calls awaiting observations */
  readonly pendingToolCalls: ReadonlyMap<string, PendingToolCall>
  /** In-progress agent step being accumulated from chunks */
  readonly currentStep: PartialAtifStep | null
  /**
   * Index into steps[] marking the compaction boundary.
   * Steps before this index will be marked is_copied_context when
   * compaction_injected fires. Set by compaction_prepared, cleared
   * by compaction_injected.
   */
  readonly compactionBoundaryIndex: number | null
  /** Token accumulator for this fork */
  readonly tokenAccumulator: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly cachedTokens: number
    readonly costUsd: number
  }
}

/** Mutable accumulator for the step currently being built from streaming events */
export interface PartialAtifStep {
  readonly step_id: number
  readonly source: 'agent'
  readonly timestamp: string | null
  readonly model_name: string | null
  readonly message: string
  readonly reasoning_content: string
  readonly tool_calls: AtifToolCall[]
  readonly observation_results: AtifObservationResult[]
  readonly metrics: AtifMetrics | null
  readonly llm_call_count: number
}

export interface AtifProjectionState {
  readonly forks: ReadonlyMap<string | null, AtifForkState>
}


