/**
 * Autopilot Worker
 *
 * When the leader and all workers are idle and autopilot is enabled,
 * generates a continuation message using a perspective-flipped LLM call.
 * The generated message is published as an `autopilot_message_generated`
 * event for the TUI to preview and auto-send after a countdown.
 *
 * Mechanism: `onProjectionsSettled` fires on every bus event. The worker
 * checks the idle condition on each invocation and only proceeds when
 * all agents are idle AND the root fork is stable AND autopilot is enabled.
 *
 * LLM call: Uses `createHarness` with a no-op autopilot toolkit.
 * `createHarness` returns a `Harness` object. `runTurn(prompt)` returns
 * `Effect<LiveTurn, ConnectionError, HttpClient>`. `LiveTurn` has an
 * `events: Stream<HarnessEvent>` that ends with `TurnEnd`.
 * The dispatcher handles the full tool-call loop internally:
 *   model streams → parse tool calls → execute no-ops → feed results back
 *   → model responds again → repeat until model stops → TurnEnd.
 * Tool arguments are extracted from `ToolExecutionStarted` harness events.
 * The `LiveTurn.events` stream must be consumed to completion to avoid leaks.
 */

import { Effect, Stream, Cause } from 'effect'
import { Worker } from '@magnitudedev/event-core'
import { createHarness, type HarnessEvent } from '@magnitudedev/harness'
import { logger } from '@magnitudedev/logger'
import { Prompt } from '@magnitudedev/ai'

import type { AppEvent } from '../events'
import { AgentStatusProjection } from '../projections/agent-status'
import { TurnProjection } from '../projections/turn'
import { AutopilotStateProjection } from '../projections/autopilot-state'
import { ConversationProjection } from '../projections/conversation'
import { buildAutopilotSystemPrompt } from '../util/autopilot-prompts'
import { buildConversationSummary } from '../prompts/agents'
import { AgentModelResolver } from '../model/model-resolver'
import { autopilotToolkit } from '../tools/autopilot'
import { mapStreamErrorToOutcome } from '../errors'

// =============================================================================
// Concurrent call guard
// =============================================================================

// Safety net: prevents overlapping LLM calls if onProjectionsSettled
// re-enters while a harness turn is still running.
let isGenerating = false

// =============================================================================
// Worker
// =============================================================================

export const Autopilot = Worker.define<AppEvent>()({
  name: 'Autopilot',

  signalHandlers: () => [],

  onProjectionsSettled: ({ publish, read }) =>
    Effect.gen(function* () {
      // Guard: concurrent call
      if (isGenerating) return

      // Guard: autopilot enabled
      const autopilotState = yield* read(AutopilotStateProjection)
      if (!autopilotState.enabled) return

      // Guard: pending preview exists
      if (autopilotState.pendingContent !== null) return

      // Guard: all agents idle
      const agentStatus = yield* read(AgentStatusProjection)
      const allAgentsIdle = Array.from(agentStatus.agents.values()).every(
        (agent) => agent.status === 'idle',
      )
      if (!allAgentsIdle) return

      // Guard: root fork stable
      const rootTurn = yield* read(TurnProjection, null)
      if (!rootTurn) return
      if (
        !(
          rootTurn._tag === 'idle' &&
          rootTurn.triggers.length === 0 &&
          !rootTurn.softInterrupted
        )
      ) {
        return
      }

      // All conditions met: generate autopilot message
      const modelResolver = yield* AgentModelResolver
      const autopilotModel = yield* modelResolver.resolveAutopilot()

      const systemPrompt = buildAutopilotSystemPrompt()

      // Build conversation context (same mechanism as sub-agents)
      const conversationState = yield* read(ConversationProjection)
      const conversationSummary = buildConversationSummary(conversationState.entries)

      const userPrompt = conversationSummary
        ? `Here is the recent conversation:\n\n${conversationSummary}\n\nGenerate the next user message.`
        : 'Generate the next user message to continue the conversation.'

      const prompt = Prompt.from({
        system: systemPrompt,
        messages: [
          { _tag: 'UserMessage' as const, parts: [{ _tag: 'TextPart' as const, text: userPrompt }] },
        ],
      })

      // Run harness turn
      // createHarness returns a Harness. runTurn(prompt) returns
      // Effect<LiveTurn, ConnectionError, HttpClient>. LiveTurn has
      // `events: Stream<HarnessEvent>` ending with TurnEnd.
      // The dispatcher handles the full loop internally:
      //   stream response → parse tool calls → execute no-ops → feed
      //   results back → model responds again → until stop → TurnEnd.
      isGenerating = true

      // Notify TUI that generation is starting (for spinner state)
      yield* publish({ type: 'autopilot_generation_started', forkId: null })

      try {
        const harness = createHarness({
          model: autopilotModel.model,
          toolkit: autopilotToolkit,
          mapStreamError: mapStreamErrorToOutcome,
        })

        let finished = false
        let generatedMessage: string | null = null

        // runTurn returns Effect<LiveTurn>, NOT a Stream directly.
        // LiveTurn.events is the Stream we consume.
        const liveTurn = yield* harness.runTurn(prompt, { toolChoice: "required" }).pipe(
          Effect.catchAll((err) =>
            Effect.gen(function* () {
              logger.error({ err }, '[Autopilot] Connection error')
              yield* publish({
                type: 'autopilot_outcome',
                forkId: null,
                result: { _tag: 'error', message: err instanceof Error ? err.message : String(err) },
              })
              return null
            }),
          ),
        )

        if (liveTurn === null) return

        yield* Stream.runForEach(liveTurn.events, (event: HarnessEvent) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case 'ToolExecutionStarted': {
                const { toolName, input } = event
                if (toolName === 'finish') {
                  finished = true
                }
                if (toolName === 'simulate_user_message') {
                  const args = input as Record<string, unknown>
                  if (typeof args.message === 'string' && args.message.trim().length > 0) {
                    generatedMessage = args.message
                  }
                }
                break
              }
            }
          }),
        )

        // Publish results
        if (finished) {
          yield* publish({ type: 'autopilot_toggled', forkId: null, enabled: false })
          return
        }

        if (generatedMessage !== null) {
          yield* publish({
            type: 'autopilot_outcome',
            forkId: null,
            result: { _tag: 'success', content: generatedMessage },
          })
        } else {
          yield* publish({
            type: 'autopilot_outcome',
            forkId: null,
            result: { _tag: 'error', message: 'Model produced no message' },
          })
        }
      } finally {
        isGenerating = false
      }
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          isGenerating = false
          logger.error({ cause: Cause.pretty(cause) }, '[Autopilot] Error in generation')
          yield* publish({
            type: 'autopilot_outcome',
            forkId: null,
            result: { _tag: 'error', message: Cause.pretty(cause) },
          })
        }),
      ),
    ),
})
