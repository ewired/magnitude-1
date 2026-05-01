/**
 * HarnessEvent → AppEvent Adapter
 *
 * Translates harness-level events into agent app events.
 * Maintains per-turn state: message counters, tool tracking,
 * content fingerprinting (circuit breaker), and turn continuation policy.
 */

import { Effect } from 'effect'
import type {
  HarnessEvent,
  ToolLifecycleEvent,
} from '@magnitudedev/harness'
import type {
  AppEvent,
  MessageDestination,
  TurnOutcome as AgentTurnOutcome,
  TurnCompletion,
  TurnFeedback,
} from '../events'

import type { ToolKey } from '../tools/toolkits'
import type { RoleId } from '../agents/role-validation'
import type { ExecuteResult } from './types'
import { IDENTICAL_RESPONSE_BREAKER_THRESHOLD } from './types'


// ── Identical Response Tracker ───────────────────────────────────────

export interface IdenticalResponseTracker {
  lastResponseText: string
  consecutiveCount: number
}

// ── Config ───────────────────────────────────────────────────────────

export interface HarnessAdapterConfig {
  readonly forkId: string | null
  readonly turnId: string
  readonly chainId: string
  readonly roleId: RoleId
  readonly defaultProseDest: MessageDestination
  readonly triggeredByUser: boolean
  readonly publish: (event: AppEvent) => Effect.Effect<void>
  readonly handleTaskDirective: (directive: {
    readonly kind: 'message'
    readonly defaultTopLevelDestination: 'user' | 'parent'
    readonly triggeredByUser: boolean
    readonly directUserRepliesSent: number
  }) => Effect.Effect<{ success: boolean; directUserRepliesSent?: number }>
  readonly identicalResponseTracker: IdenticalResponseTracker | null
  /** Resolve a tool's model-facing name to the internal catalog key. */
  readonly resolveToolKey: (toolName: string) => ToolKey | undefined
}

// ── Adapter ──────────────────────────────────────────────────────────

export interface HarnessAdapter {
  readonly processEvent: (event: HarnessEvent) => Effect.Effect<void>
  readonly getResult: () => ExecuteResult
  readonly getIdenticalResponseTracker: () => IdenticalResponseTracker | null
}

export function createHarnessAdapter(config: HarnessAdapterConfig): HarnessAdapter {
  const {
    forkId,
    turnId,
    defaultProseDest,
    triggeredByUser,
    publish,
    handleTaskDirective,
    resolveToolKey,
  } = config

  // ── Per-turn mutable state ───────────────────────────────────────

  let messageCounter = 0
  let currentMessageId: string | null = null

  const toolsCalledKeys: ToolKey[] = []
  let lastToolKey: ToolKey | null = null
  let hasToolErrors = false
  let hasAnyResponseContent = false
  let directUserRepliesSent = 0

  // toolCallId → ToolKey tracking
  const toolCallKeys = new Map<string, ToolKey>()

  // Content fingerprint for circuit breaker
  let contentFingerprint = ''

  const feedback: TurnFeedback[] = []

  // Result state
  let executionResult: AgentTurnOutcome = {
    _tag: 'Completed',
    completion: { toolCallsCount: 0, finishReason: 'stop', feedback: [] },
  }
  let turnUsage: ExecuteResult['usage'] = null

  // Circuit breaker state (mutated, returned via getter)
  let trackerState = config.identicalResponseTracker
    ? { ...config.identicalResponseTracker }
    : null

  // ── Helpers ──────────────────────────────────────────────────────

  const resolveDestination = (): MessageDestination => {
    return defaultProseDest
  }

  const emitToolEvent = (toolCallId: string, toolKey: ToolKey, event: ToolLifecycleEvent): Effect.Effect<void> =>
    publish({
      type: 'tool_event' as const,
      forkId,
      turnId,
      toolCallId,
      toolKey,
      event,
    })

  // ── Process ──────────────────────────────────────────────────────

  const processEvent = (event: HarnessEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (event._tag) {
        // ── Thinking ─────────────────────────────────────────────
        case 'ThoughtStart': {
          hasAnyResponseContent = true
          yield* publish({
            type: 'thinking_start',
            forkId,
            turnId,
          })
          break
        }

        case 'ThoughtDelta': {
          contentFingerprint += event.text
          yield* publish({
            type: 'thinking_chunk',
            forkId,
            turnId,
            text: event.text,
          })
          break
        }

        case 'ThoughtEnd': {
          yield* publish({
            type: 'thinking_end',
            forkId,
            turnId,
          })
          break
        }

        // ── Messages ─────────────────────────────────────────────
        case 'MessageStart': {
          hasAnyResponseContent = true
          messageCounter++
          const messageId = `${turnId}-msg-${messageCounter}`
          currentMessageId = messageId

          const destination = resolveDestination()

          // Run task directive for non-worker messages
          if (destination.kind !== 'worker') {
            const directiveResult = yield* handleTaskDirective({
              kind: 'message',
              defaultTopLevelDestination: destination.kind === 'user' ? 'user' : 'parent',
              triggeredByUser,
              directUserRepliesSent,
            })

            if (!directiveResult.success) {
              currentMessageId = null
              break
            }

            if (
              directiveResult.directUserRepliesSent !== undefined
              && typeof directiveResult.directUserRepliesSent === 'number'
            ) {
              directUserRepliesSent = directiveResult.directUserRepliesSent
            }
          }

          yield* publish({
            type: 'message_start',
            forkId,
            turnId,
            id: messageId,
            destination,
          })
          break
        }

        case 'MessageDelta': {
          if (currentMessageId === null) break
          contentFingerprint += event.text
          yield* publish({
            type: 'message_chunk',
            forkId,
            turnId,
            id: currentMessageId,
            text: event.text,
          })
          break
        }

        case 'MessageEnd': {
          if (currentMessageId === null) break
          yield* publish({
            type: 'message_end',
            forkId,
            turnId,
            id: currentMessageId,
          })
          currentMessageId = null
          break
        }

        // ── Tool Input Lifecycle ─────────────────────────────────
        case 'ToolInputStarted': {
          hasAnyResponseContent = true
          const toolKey = resolveToolKey(event.toolName)
          if (!toolKey) break
          toolCallKeys.set(event.toolCallId, toolKey)
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        case 'ToolInputFieldChunk': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break
          contentFingerprint += event.delta
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        case 'ToolInputFieldComplete': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        case 'ToolInputReady': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        // ── Tool Execution Lifecycle ─────────────────────────────
        case 'ToolExecutionStarted': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        case 'ToolEmission': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        case 'ToolExecutionEnded': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break

          // Track tool calls
          toolsCalledKeys.push(toolKey)
          lastToolKey = toolKey

          // Track errors
          if (event.result._tag === 'Error') {
            hasToolErrors = true
          }

          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        case 'ToolResultFormatted': {
          const toolKey = toolCallKeys.get(event.toolCallId)
          if (!toolKey) break
          yield* emitToolEvent(event.toolCallId, toolKey, event)
          break
        }

        // ── Turn End ─────────────────────────────────────────────
        case 'TurnEnd': {
          const outcome = event.outcome

          // Capture usage
          if (event.usage) {
            turnUsage = {
              inputTokens: event.usage.inputTokens ?? null,
              outputTokens: event.usage.outputTokens ?? null,
              cacheReadTokens: event.usage.cacheReadTokens ?? null,
              cacheWriteTokens: null,
            }
          }

          const completed = (toolCallsCount: number): AgentTurnOutcome => ({
            _tag: 'Completed',
            completion: {
              toolCallsCount,
              finishReason: toolCallsCount > 0 ? 'tool_calls' : 'stop',
              feedback: [...feedback],
            } satisfies TurnCompletion,
          })

          switch (outcome._tag) {
            case 'Completed': {
              let willContinue: boolean

              if (hasToolErrors || feedback.length > 0) {
                willContinue = true
              } else if (!hasAnyResponseContent) {
                willContinue = true
              } else {
                // Continue if any tools were called, stop otherwise
                willContinue = outcome.toolCallsCount > 0
              }

              executionResult = completed(willContinue ? Math.max(outcome.toolCallsCount, 1) : 0)
              break
            }

            case 'ToolInputDecodeFailure': {
              executionResult = {
                _tag: 'ParseFailure',
                error: {
                  _tag: 'ToolInputDecodeFailure' as const,
                  toolCallId: outcome.toolCallId,
                  toolName: outcome.toolName,
                  issue: outcome.issue,
                },
              }
              break
            }

            case 'GateRejected': {
              executionResult = completed(1)
              break
            }

            case 'EngineDefect': {
              executionResult = {
                _tag: 'UnexpectedError',
                message: outcome.message,
                detail: { _tag: 'EngineDefect' },
              }
              break
            }

            case 'OutputTruncated': {
              executionResult = { _tag: 'OutputTruncated' }
              break
            }

            case 'ContentFiltered': {
              executionResult = {
                _tag: 'SafetyStop',
                reason: { _tag: 'Other', message: 'Content filtered by provider' },
              }
              break
            }

            case 'SafetyStop': {
              executionResult = {
                _tag: 'SafetyStop',
                reason: outcome.reason,
              }
              break
            }

            case 'Interrupted': {
              executionResult = {
                _tag: 'Cancelled',
                reason: { _tag: 'UserInterrupt' },
              }
              break
            }
          }

          // ── Circuit breaker ──────────────────────────────────
          const willRetrigger =
            (executionResult._tag === 'Completed' && executionResult.completion.toolCallsCount > 0)
            || executionResult._tag === 'ParseFailure'

          if (willRetrigger) {
            const prevCount = trackerState && trackerState.lastResponseText === contentFingerprint
              ? trackerState.consecutiveCount + 1
              : 1

            trackerState = {
              lastResponseText: contentFingerprint,
              consecutiveCount: prevCount,
            }

            if (prevCount >= IDENTICAL_RESPONSE_BREAKER_THRESHOLD) {
              executionResult = {
                _tag: 'SafetyStop',
                reason: {
                  _tag: 'IdenticalResponseCircuitBreaker',
                  threshold: prevCount,
                },
              }
              trackerState = null
            }
          } else {
            trackerState = null
          }

          break
        }
      }
    })

  const getResult = (): ExecuteResult => ({
    result: executionResult,
    usage: turnUsage,
  })

  const getIdenticalResponseTracker = (): IdenticalResponseTracker | null => trackerState

  return { processEvent, getResult, getIdenticalResponseTracker }
}
