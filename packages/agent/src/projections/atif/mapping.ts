/**
 * AppEvent → ATIF step mapping logic
 */

import type {
  AppEvent,
  UserMessage,
  TurnStarted,
  TurnOutcomeEvent,
  ThinkingChunk,
  MessageChunkEvent,
  ToolEvent,
  AgentCreated,
  CompactionPrepared,
  Interrupt,
  ObservationPart,
  Attachment,
  TurnOutcome,
} from '../../events'
import type {
  AtifStep,
  AtifStepSource,
  AtifMessage,
  AtifToolCall,
  AtifObservationResult,
  AtifMetrics,
  AtifForkState,
  PartialAtifStep,
  PendingToolCall,
  AtifContentPart,
  AtifImagePart,
  AtifImageSource,
} from './types'

// =============================================================================
// Helpers
// =============================================================================

function timestampToIso(ts: number): string {
  return new Date(ts).toISOString()
}

function assertMediaType(mt: string): AtifImageSource['media_type'] {
  switch (mt) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return mt
    default:
      return 'image/png'
  }
}

function partsToAtifMessage(parts: readonly ObservationPart[]): AtifMessage {
  const result: AtifContentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      result.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      result.push({
        type: 'image',
        source: { media_type: assertMediaType(part.mediaType), path: 'inline' },
      })
    }
  }
  return result.length === 1 && result[0].type === 'text' ? result[0].text : result
}

function observationToAtifMessage(parts: readonly ObservationPart[] | undefined): AtifMessage {
  if (!parts || parts.length === 0) return ''
  return partsToAtifMessage(parts)
}

/**
 * Convert UserPart[] (content from events.ts) to ATIF message.
 * Handles TextPart, ImagePart, and other part types.
 */
function userPartsToAtifMessage(
  parts: readonly { readonly _tag: string; readonly text?: string; readonly base64?: string; readonly mediaType?: string }[]
): AtifMessage {
  const result: AtifContentPart[] = []
  for (const part of parts) {
    if (part._tag === 'TextPart') {
      result.push({ type: 'text', text: part.text ?? '' })
    } else if (part._tag === 'ImagePart' && part.base64 && part.mediaType) {
      result.push({
        type: 'image',
        source: { media_type: assertMediaType(part.mediaType), path: 'inline' },
      })
    }
  }
  return result.length === 1 && result[0].type === 'text' ? result[0].text : result
}

/**
 * Convert attachments (images) to ATIF content parts appended to the message.
 */
function attachmentsToContentParts(attachments: readonly Attachment[]): AtifImagePart[] {
  const parts: AtifImagePart[] = []
  for (const att of attachments) {
    if (att.type === 'image') {
      parts.push({
        type: 'image',
        source: { media_type: assertMediaType(att.mediaType), path: att.filename || 'inline' },
      })
    }
  }
  return parts
}

function buildUserMessage(event: UserMessage): AtifMessage {
  const contentParts = userPartsToAtifMessage(event.content)
  const attachmentParts = attachmentsToContentParts(event.attachments)

  if (typeof contentParts === 'string') {
    if (attachmentParts.length > 0) {
      return [{ type: 'text', text: contentParts }, ...attachmentParts]
    }
    return contentParts
  }

  // contentParts is AtifContentPart[]
  if (attachmentParts.length > 0) {
    return [...contentParts, ...attachmentParts]
  }
  return contentParts.length === 1 && contentParts[0].type === 'text' ? contentParts[0].text : contentParts
}

function getExtraFromOutcome(outcome: TurnOutcome): Record<string, unknown> | undefined {
  switch (outcome._tag) {
    case 'Completed':
      return { finishReason: 'stop', toolCallsCount: outcome.completion.toolCallsCount }
    case 'ParseFailure':
      return { error: 'parse_failure', toolCallId: outcome.error.toolCallId, toolName: outcome.error.toolName }
    case 'ToolInputValidationFailure':
      return { error: 'tool_input_validation_failure', toolCallId: outcome.toolCallId, toolName: outcome.toolName }
    case 'ToolExecutionError':
      return { error: 'tool_execution_error', toolCallId: outcome.toolCallId, toolName: outcome.toolName, message: outcome.error.message }
    case 'GateRejected':
      return { error: 'gate_rejected', toolCallId: outcome.toolCallId, toolName: outcome.toolName }
    case 'ProviderNotReady':
      return { error: 'provider_not_ready', detail: outcome.detail._tag }
    case 'ConnectionFailure':
      return { error: 'connection_failure', detail: outcome.detail._tag }
    case 'ContextWindowExceeded':
      return { error: 'context_window_exceeded' }
    case 'OutputTruncated':
      return { error: 'output_truncated' }
    case 'SafetyStop':
      return { error: 'safety_stop', reason: outcome.reason._tag }
    case 'Cancelled':
      return { error: 'cancelled', reason: outcome.reason._tag }
    case 'Overthinking':
      return { error: 'overthinking', limit: outcome.limit }
    case 'UnexpectedError':
      return { error: 'unexpected_error', message: outcome.message, detail: outcome.detail?._tag }
    default:
      return undefined
  }
}

// =============================================================================
// User message → user step
// =============================================================================

export function userMessageToStep(event: UserMessage, stepId: number): AtifStep {
  const message = buildUserMessage(event)
  return {
    step_id: stepId,
    timestamp: timestampToIso(event.timestamp),
    source: 'user' as AtifStepSource,
    message,
    extra: {
      ...(event.synthetic ? { autopilot: true } : {}),
      ...(event.taskMode ? { taskMode: true } : {}),
    },
  }
}

// =============================================================================
// Turn started → initialize partial agent step
// =============================================================================

export function beginAgentStep(event: TurnStarted, stepId: number, modelId: string | null): PartialAtifStep {
  return {
    step_id: stepId,
    source: 'agent',
    timestamp: timestampToIso(Date.now()),
    model_name: modelId,
    message: '',
    reasoning_content: '',
    tool_calls: [],
    observation_results: [],
    metrics: null,
    llm_call_count: 1,
  }
}

// =============================================================================
// Accumulate streaming chunks into partial step
// =============================================================================

export function accumulateThinkingChunk(step: PartialAtifStep, event: ThinkingChunk): PartialAtifStep {
  return {
    ...step,
    reasoning_content: step.reasoning_content + event.text,
  }
}

export function accumulateMessageChunk(step: PartialAtifStep, event: MessageChunkEvent): PartialAtifStep {
  return {
    ...step,
    message: step.message + event.text,
  }
}

// =============================================================================
// Tool input ready → add tool call to current step
// =============================================================================

export function addToolCallToStep(step: PartialAtifStep, event: ToolEvent): PartialAtifStep {
  const lifecycle = event.event as { _tag: string; toolName?: string; toolKey?: string; cached?: boolean }

  const toolCall: AtifToolCall = {
    tool_call_id: event.toolCallId,
    function_name: lifecycle.toolName ?? String(event.toolKey),
    arguments: {}, // populated later from ToolExecutionStarted
  }
  return {
    ...step,
    tool_calls: [...step.tool_calls, toolCall],
  }
}

// =============================================================================
// Tool execution ended → add observation to current step
// =============================================================================

export function addObservationToStep(
  step: PartialAtifStep,
  event: ToolEvent,
  pendingToolCalls: ReadonlyMap<string, PendingToolCall>
): PartialAtifStep {
  const lifecycle = event.event as {
    _tag: string
    result?: unknown
  }
  const rawResult = lifecycle.result

  let content: AtifMessage = ''
  let extra: Record<string, unknown> | undefined

  if (rawResult != null && typeof rawResult === 'object') {
    const result = rawResult as Record<string, unknown>

    // Dispatch on _tag for well-typed handling of all ToolResult variants
    switch (result._tag) {
      case 'Success': {
        const output = result.output
        if (typeof output === 'string') {
          content = output
        } else if (output != null && typeof output === 'object') {
          const out = output as Record<string, unknown>
          if ('parts' in out && Array.isArray(out.parts)) {
            content = observationToAtifMessage(out.parts as readonly ObservationPart[])
          } else {
            try {
              content = JSON.stringify(output)
            } catch {
              content = String(output)
            }
          }
        } else {
          content = String(output ?? '')
        }
        break
      }
      case 'Error': {
        const error = result.error as Record<string, unknown> | undefined
        content = `Error: ${error?.message ?? 'Unknown error'}`
        extra = { error: true }
        break
      }
      case 'Denied': {
        const denial = result.denial
        if (typeof denial === 'string') {
          content = `Denied: ${denial}`
        } else {
          content = 'Denied'
          extra = { denial }
        }
        break
      }
      case 'Interrupted': {
        content = 'Interrupted'
        extra = { interrupted: true }
        break
      }
      case 'InputRejected': {
        const issue = result.issue as Record<string, unknown> | undefined
        content = `Input rejected: ${issue?.message ?? 'Validation failed'}`
        extra = { inputRejected: true }
        break
      }
      default: {
        // Fallback for unknown result shapes
        if ('parts' in result && Array.isArray(result.parts)) {
          content = observationToAtifMessage(result.parts as readonly ObservationPart[])
        } else if ('output' in result) {
          content = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
        } else {
          try {
            content = JSON.stringify(rawResult)
          } catch {
            content = String(rawResult)
          }
        }
      }
    }
  } else if (typeof rawResult === 'string') {
    content = rawResult
  }

  const atifResult: AtifObservationResult = {
    source_call_id: event.toolCallId,
    content,
    ...(extra ? { extra } : {}),
  }

  return {
    ...step,
    observation_results: [...step.observation_results, atifResult],
  }
}

// =============================================================================
// Turn outcome → finalize step with metrics
// =============================================================================

/**
 * Whether a turn outcome indicates the LLM call failed without producing
 * any output (e.g., connection failure, unexpected transport error).
 * These steps record that an LLM call was attempted but no inference
 * completed, so llm_call_count is set to 0 and metrics/reasoning are
 * omitted since no tokens were processed.
 *
 * NOTE: ATIF has no standard mechanism for recording LLM call errors.
 * Using llm_call_count=0 is a pragmatic choice — it correctly signals
 * that no LLM inference occurred on this step, and allows consumers to
 * distinguish these from real behavioral turns (llm_call_count > 0).
 * Error details are carried in extra.error.
 */
function isFailedLlmCall(outcome: TurnOutcome): boolean {
  return outcome._tag === 'ConnectionFailure' || outcome._tag === 'UnexpectedError'
}

export function finalizeAgentStep(
  partial: PartialAtifStep,
  event: TurnOutcomeEvent
): AtifStep {
  const extra = getExtraFromOutcome(event.outcome)

  // Failed LLM calls (connection failure, transport error) with no output
  // get llm_call_count=0 and omit metrics/reasoning since no inference completed.
  const isNoLlm = isFailedLlmCall(event.outcome) &&
    partial.message.trim().length === 0 &&
    partial.tool_calls.length === 0 &&
    partial.observation_results.length === 0

  const llmCallCount = isNoLlm ? 0 : partial.llm_call_count

  // Use modelId from turn_outcome if model_name wasn't set at turn_started
  const modelName = partial.model_name ?? event.modelId ?? null

  // Only compute metrics when an LLM inference actually occurred
  let finalMetrics: AtifMetrics | undefined
  if (!isNoLlm) {
    const metrics: AtifMetrics | undefined =
      event.inputTokens != null || event.outputTokens != null
        ? {
            ...(event.inputTokens != null ? { prompt_tokens: event.inputTokens } : {}),
            ...(event.outputTokens != null ? { completion_tokens: event.outputTokens } : {}),
            ...(event.cacheReadTokens != null ? { cached_tokens: event.cacheReadTokens } : {}),
          }
        : undefined

    const providerMetrics: Record<string, unknown> = {}
    if (event.cacheWriteTokens != null) {
      providerMetrics.cache_creation_input_tokens = event.cacheWriteTokens
    }
    if (event.providerId) {
      providerMetrics.provider_id = event.providerId
    }
    if (event.modelId) {
      providerMetrics.model_id = event.modelId
    }

    finalMetrics =
      metrics || Object.keys(providerMetrics).length > 0 || event.cost != null
        ? {
            ...(metrics ?? {}),
            ...(Object.keys(providerMetrics).length > 0 ? { extra: providerMetrics } : {}),
            ...(event.cost != null ? { cost_usd: event.cost } : {}),
          }
        : undefined
  }

  const step: AtifStep = {
    step_id: partial.step_id,
    timestamp: partial.timestamp,
    source: 'agent',
    ...(modelName ? { model_name: modelName } : {}),
    message: partial.message.trim() || '',
    // reasoning_content omitted when no LLM inference completed
    ...(!isNoLlm && partial.reasoning_content.trim()
      ? { reasoning_content: partial.reasoning_content.trim() }
      : {}),
    ...(partial.tool_calls.length > 0
      ? { tool_calls: partial.tool_calls }
      : {}),
    ...(partial.observation_results.length > 0
      ? {
          observation: {
            results: partial.observation_results,
          },
        }
      : {}),
    ...(finalMetrics ? { metrics: finalMetrics } : {}),
    llm_call_count: llmCallCount,
    ...(extra ? { extra } : {}),
  }

  return step
}

// =============================================================================
// Agent created → agent step with spawnWorker
// =============================================================================

export function agentCreatedToStep(event: AgentCreated, stepId: number, toolCallId: string): AtifStep {
  return {
    step_id: stepId,
    timestamp: timestampToIso(Date.now()),
    source: 'agent',
    message: '',
    tool_calls: [
      {
        tool_call_id: toolCallId,
        function_name: 'spawnWorker',
        arguments: {
          role: event.role,
          taskId: event.taskId,
          mode: event.mode,
          ...(event.message ? { message: event.message } : {}),
        },
      },
    ],
    observation: {
      results: [
        {
          source_call_id: toolCallId,
          subagent_trajectory_ref: [
            {
              trajectory_id: event.agentId,
            },
          ],
        },
      ],
    },
    llm_call_count: 0,
  }
}

// =============================================================================
// Interrupt → user step (user intervention)
// =============================================================================

export function interruptToStep(event: Interrupt, stepId: number): AtifStep {
  return {
    step_id: stepId,
    timestamp: timestampToIso(Date.now()),
    source: 'user',
    message: event.allKilled ? 'All agents interrupted' : 'Agent interrupted',
    extra: {
      allKilled: event.allKilled ?? false,
    },
    llm_call_count: 0,
  }
}

// =============================================================================
// Compaction prepared → system step (ATIF context_management boundary)
// =============================================================================

export function compactionPreparedToStep(event: CompactionPrepared, stepId: number): AtifStep {
  const observationResults: AtifObservationResult[] = []

  // If not a fallback, extract the compaction summary from compactResult
  if (!event.isFallback && event.compactResult) {
    const result = event.compactResult as Record<string, unknown>
    const summary = result.summary ?? result.content ?? ''
    if (summary) {
      observationResults.push({
        source_call_id: `compaction-${stepId}`,
        content: typeof summary === 'string' ? summary : JSON.stringify(summary),
      })
    }
  }

  return {
    step_id: stepId,
    timestamp: timestampToIso(Date.now()),
    source: 'system',
    message: 'Context compaction performed',
    ...(observationResults.length > 0
      ? { observation: { results: observationResults } }
      : {}),
    extra: {
      context_management: {
        type: 'compaction',
        boundary: 'replace',
        compactedMessageCount: event.compactedMessageCount,
        ...(event.isFallback ? { isFallback: true } : {}),
        ...(event.inputTokens != null ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens != null ? { outputTokens: event.outputTokens } : {}),
      },
    },
    llm_call_count: 0,
  }
}

// =============================================================================
// Agent killed → terminal agent step
// =============================================================================

export function agentKilledToStep(agentId: string, reason: string, stepId: number): AtifStep {
  return {
    step_id: stepId,
    timestamp: timestampToIso(Date.now()),
    source: 'agent',
    message: `Agent killed: ${reason}`,
    extra: {
      agentKilled: true,
      agentId,
      reason,
    },
    llm_call_count: 0,
  }
}
