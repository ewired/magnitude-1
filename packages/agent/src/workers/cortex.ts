/**
 * Cortex Worker (Forked) — Harness Paradigm
 *
 * Thin orchestrator: resolve model → build harness → run turn → publish events → publish outcome.
 *
 * Uses:
 *  - AgentModelResolver to resolve a model for the role
 *  - createHarness to stream model responses and dispatch tool execution
 *  - createHarnessAdapter to translate HarnessEvent → AppEvent
 */

import { Effect, Stream, Layer } from 'effect'
import { Worker, AmbientServiceTag } from '@magnitudedev/event-core'
import { logger } from '@magnitudedev/logger'
import { createHarness, type ExecuteHookContext, type InterceptorDecision } from '@magnitudedev/harness'
import type { MagnitudeConnectionError, MagnitudeStreamError } from '@magnitudedev/magnitude-client'
import { renderToolDocs } from '../prompts/render-tool-docs'

import type { AppEvent, TurnOutcome } from '../events'

import { WindowProjection } from '../projections/window'
import { SessionContextProjection } from '../projections/session-context'
import { AgentStatusProjection } from '../projections/agent-status'

import { AgentModelResolver } from '../model/model-resolver'
import { getAgentDefinition, getForkInfo } from '../agents/registry'
import { getToolkitForRole } from '../tools/toolkits'
import { createHarnessAdapter } from '../execution/harness-adapter'
import { buildSystemPrompt } from '../prompts/system-prompt-builder'
import { windowToPrompt } from '../prompts/window-to-prompt'

import { ExecutionManager } from '../execution/types'
import { SkillsAmbient } from '../ambient/skills-ambient'
import { buildInterruptedTurnOutcome } from '../util/interrupt-utils'
import type { ObservationPart } from '../events'
import { isToolKey, type ToolKey } from '../tools/toolkits'
import { persistResult } from '../runtime/result-persistence'
import { PolicyContextProviderTag } from '../agents/types'
import { handleTaskDirective } from '../tasks/operations'
import { Fork } from '@magnitudedev/event-core'

import * as path from 'path'

const { ForkContext } = Fork

// =============================================================================
// Error Mapping
// =============================================================================

function mapConnectionErrorToOutcome(err: MagnitudeConnectionError): TurnOutcome {
  switch (err._tag) {
    case 'SubscriptionRequired':
      return {
        _tag: 'ProviderNotReady',
        detail: { _tag: 'MagnitudeBilling', reason: { _tag: 'SubscriptionRequired', message: err.message } },
      }
    case 'TrialExpired':
      return {
        _tag: 'ProviderNotReady',
        detail: { _tag: 'MagnitudeBilling', reason: { _tag: 'TrialExpired', message: err.message } },
      }
    case 'MagnitudeUsageLimitExceeded':
      return {
        _tag: 'ProviderNotReady',
        detail: { _tag: 'MagnitudeBilling', reason: { _tag: 'UsageLimitExceeded', message: err.message } },
      }
    case 'ModelNotGrammarCompatible':
      return { _tag: 'UnexpectedError', message: err.message, detail: { _tag: 'ProviderDefect' } }
    case 'RoleNotFound':
      return { _tag: 'UnexpectedError', message: err.message, detail: { _tag: 'ProviderDefect' } }
    case 'AuthFailed':
      return {
        _tag: 'ProviderNotReady',
        detail: { _tag: 'AuthFailed', providerId: 'magnitude', providerName: 'Magnitude' },
      }
    case 'RateLimited':
      return { _tag: 'ConnectionFailure', detail: { _tag: 'TransportError', httpStatus: err.status } }
    case 'UsageLimitExceeded':
      return { _tag: 'ConnectionFailure', detail: { _tag: 'ProviderError', httpStatus: err.status } }
    case 'ContextLimitExceeded':
      return { _tag: 'ContextWindowExceeded' }
    case 'InvalidRequest':
      return { _tag: 'UnexpectedError', message: err.message, detail: { _tag: 'ProviderDefect' } }
    case 'TransportError':
      return { _tag: 'ConnectionFailure', detail: { _tag: 'TransportError', httpStatus: err.status ?? undefined } }
  }
}

function mapStreamErrorToOutcome(err: MagnitudeStreamError): TurnOutcome {
  return { _tag: 'ConnectionFailure', detail: { _tag: 'StreamError' } }
}

// =============================================================================
// Worker
// =============================================================================

export const Cortex = Worker.defineForked<AppEvent>()({
  name: 'Cortex',

  forkLifecycle: {
    activateOn: 'agent_created',
    completeOn: ['agent_killed', 'subagent_user_killed', 'subagent_idle_closed'],
  },

  eventHandlers: {
    subagent_user_killed: (event) => Effect.gen(function* () {
      if (event.forkId === null) return
      return yield* Effect.interrupt
    }),

    subagent_idle_closed: (event) => Effect.gen(function* () {
      if (event.forkId === null) return
      return yield* Effect.interrupt
    }),

    turn_started: (event, publish, read) => {
      const { forkId, turnId, chainId } = event

      return Effect.gen(function* () {
        // ──────────────────────────────────────────────────────────────────────
        // 1. Read projections
        // ──────────────────────────────────────────────────────────────────────
        const sessionCtx   = yield* read(SessionContextProjection)
        const agentState   = yield* read(AgentStatusProjection)
        const windowState  = yield* read(WindowProjection, forkId)
        // TODO(Phase 3E): Pass replay state to harness for crash recovery.
        // ReplayProjection uses turn-engine EngineState; harness uses its own EngineState.
        // Needs type migration before it can be wired through.
        // const replayState = yield* read(ReplayProjection, forkId)

        const forkInfo = getForkInfo(agentState, forkId)
        if (!forkInfo) return

        const { roleId } = forkInfo
        const agentDef = getAgentDefinition(roleId)

        // ──────────────────────────────────────────────────────────────────────
        // 2. Resolve model
        // ──────────────────────────────────────────────────────────────────────
        const modelResolver = yield* AgentModelResolver
        const agentModel = yield* modelResolver.resolve(roleId)

        // ──────────────────────────────────────────────────────────────────────
        // 3. Observations
        // ──────────────────────────────────────────────────────────────────────
        const execManager = yield* ExecutionManager
        const observations: ObservationPart[] = []
        const boundObs = execManager.getObservables(forkId)
        for (const obs of boundObs) {
          const parts = yield* obs.observe()
          observations.push(...parts)
        }
        if (observations.length > 0) {
          yield* publish({ type: 'observations_captured', forkId, turnId, parts: observations })
        }

        // ──────────────────────────────────────────────────────────────────────
        // 4. Get toolkit and fork layer
        // ──────────────────────────────────────────────────────────────────────
        const toolkit = getToolkitForRole(roleId)
        const forkLayer = execManager.getForkLayer(forkId)
        if (!forkLayer) {
          logger.error({ forkId, turnId }, '[Cortex] Fork layer not initialized — aborting turn')
          yield* publish({
            type: 'turn_outcome', forkId, turnId, chainId,
            strategyId: 'native',
            outcome: { _tag: 'UnexpectedError', message: 'Fork layer not initialized', detail: { _tag: 'CortexDefect' } },
            inputTokens: null, outputTokens: null,
            cacheReadTokens: null, cacheWriteTokens: null,
            providerId: 'magnitude', modelId: agentModel.modelId,
          })
          return
        }

        // ──────────────────────────────────────────────────────────────────────
        // 5. Build system prompt
        // ──────────────────────────────────────────────────────────────────────
        const ambientService = yield* AmbientServiceTag
        const skills = ambientService.getValue(SkillsAmbient)

        const workspacePath = sessionCtx.context?.workspacePath ?? process.cwd()

        const harness = createHarness({
          model: agentModel.model,
          toolkit,
          mapStreamError: mapStreamErrorToOutcome,
          layer: forkLayer as Layer.Layer<never>,
          hooks: buildHarnessHooks({
            forkId,
            turnId,
            agentDef,
            workspacePath,
          }),
        })

        const toolDefs = harness.getToolDefinitions()
        const toolDocs = toolDefs.length > 0
          ? renderToolDocs(toolDefs)
          : ''

        const systemPrompt = buildSystemPrompt({
          roleDef: agentDef,
          skills,
          lenses: [],
          toolDocs,
        })

        // ──────────────────────────────────────────────────────────────────────
        // 6. Build prompt from memory
        // ──────────────────────────────────────────────────────────────────────
        const timezone = sessionCtx.context?.timezone ?? null
        const supportsVision = agentModel.profile.capabilities.vision
        const prompt = windowToPrompt(windowState, systemPrompt, timezone, supportsVision)

        // ──────────────────────────────────────────────────────────────────────
        // 7. Build adapter
        // ──────────────────────────────────────────────────────────────────────
        const agentKind = agentDef.agentKind
        const defaultProseDest = agentKind === 'worker'
          ? { kind: 'parent' as const }
          : { kind: 'user' as const }

        // Build toolName → ToolKey map from toolkit
        const toolNameToKey = new Map<string, ToolKey>()
        for (const key of toolkit.keys) {
          if (isToolKey(key)) {
            const entry = toolkit.entries[key]
            const toolName = entry.tool.definition.name
            toolNameToKey.set(toolName, key as ToolKey)
          }
        }

        const adapter = createHarnessAdapter({
          forkId,
          turnId,
          chainId,
          roleId,
          defaultProseDest,
          triggeredByUser: chainId === turnId,
          publish,
          handleTaskDirective: (directive) =>
            handleTaskDirective(directive, {
              forkId,
              timestamp: Date.now(),
              graph: { tasks: new Map() },
              skills,
            }).pipe(
              Effect.provideService(ForkContext, { forkId, roleId }),
              Effect.provide(forkLayer),
            ),
          identicalResponseTracker: null,
          resolveToolKey: (toolName: string) => toolNameToKey.get(toolName),
        })

        // ──────────────────────────────────────────────────────────────────────
        // 8. Run turn
        // ──────────────────────────────────────────────────────────────────────
        const liveTurn = yield* harness.runTurn(prompt).pipe(
          Effect.catchAll((err: MagnitudeConnectionError) => Effect.gen(function* () {
            logger.error({ forkId, turnId, err }, '[Cortex] Pre-stream connection error')
            yield* publish({
              type: 'turn_outcome', forkId, turnId, chainId,
              strategyId: 'native',
              outcome: mapConnectionErrorToOutcome(err),
              inputTokens: null, outputTokens: null,
              cacheReadTokens: null, cacheWriteTokens: null,
              providerId: 'magnitude', modelId: agentModel.modelId,
            })
            return null
          })),
        )

        if (liveTurn === null) return

        // ──────────────────────────────────────────────────────────────────────
        // 9. Consume events via adapter
        // ──────────────────────────────────────────────────────────────────────
        yield* Stream.runForEach(liveTurn.events, (event) => adapter.processEvent(event))

        // ──────────────────────────────────────────────────────────────────────
        // 10. Publish turn_outcome
        // ──────────────────────────────────────────────────────────────────────
        const executeResult = adapter.getResult()

        yield* publish({
          type: 'turn_outcome', forkId, turnId, chainId,
          strategyId: 'native',
          outcome: executeResult.result,
          inputTokens:      executeResult.usage?.inputTokens ?? null,
          outputTokens:     executeResult.usage?.outputTokens ?? null,
          cacheReadTokens:  executeResult.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: executeResult.usage?.cacheWriteTokens ?? null,
          providerId: 'magnitude',
          modelId:    agentModel.modelId,
        })
      }).pipe(
        Effect.onInterrupt(() => Effect.gen(function* () {
          const turnOutcome = yield* buildInterruptedTurnOutcome({ forkId, turnId, chainId })
          yield* publish(turnOutcome)
        }).pipe(Effect.orDie)),
        Effect.catchAll((error: unknown) => Effect.gen(function* () {
          const message = error instanceof Error ? error.message : String(error)
          logger.error({ context: 'Cortex', forkId, turnId, error: message }, '[Cortex] Unexpected error in turn_started')
          yield* publish({
            type: 'turn_outcome', forkId, turnId, chainId,
            strategyId: 'native',
            outcome: { _tag: 'UnexpectedError', message, detail: { _tag: 'CortexDefect' } },
            inputTokens: null, outputTokens: null,
            cacheReadTokens: null, cacheWriteTokens: null,
            providerId: null, modelId: null,
          })
        })),
      )
    },
  },
})

// =============================================================================
// Harness Hooks
// =============================================================================

function buildHarnessHooks(ctx: {
  readonly forkId: string | null
  readonly turnId: string
  readonly agentDef: ReturnType<typeof getAgentDefinition>
  readonly workspacePath: string
}): import('@magnitudedev/harness').HarnessHooks<PolicyContextProviderTag> {
  const { forkId, turnId, agentDef, workspacePath } = ctx
  const resultsDir = path.join(workspacePath, 'results')

  return {
    beforeExecute: (hookCtx: ExecuteHookContext) =>
      Effect.gen(function* () {
        const policyCtxProvider = yield* PolicyContextProviderTag
        const policyContext = yield* policyCtxProvider.get

        for (const rule of agentDef.policy) {
          const decision = yield* rule({ ...hookCtx, policyContext })
          if (decision !== null) return decision
        }
        return { _tag: 'Proceed' as const } satisfies InterceptorDecision
      }),

    afterExecute: (hookCtx: ExecuteHookContext & { readonly result: import('@magnitudedev/harness').ToolResult }) =>
      Effect.gen(function* () {
        if (hookCtx.result._tag === 'Success') {
          yield* persistResult(hookCtx.result.output, turnId, hookCtx.toolCallId, resultsDir).pipe(
            Effect.catchAll((e) => Effect.gen(function* () {
              logger.warn({ forkId, turnId, toolCallId: hookCtx.toolCallId, e }, '[Cortex] persistResult failed')
            })),
          )
        }
      }),
  }
}
