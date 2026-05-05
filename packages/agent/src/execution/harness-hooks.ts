/**
 * Shared harness hooks used by Cortex and CompactionWorker.
 *
 * Centralises beforeExecute (policy gate), afterExecute (result persistence),
 * and formatResult (truncation) so the two callers stay in sync.
 */

import { Effect } from 'effect'
import { logger } from '@magnitudedev/logger'
import type { ExecuteHookContext, HarnessHooks, InterceptorDecision, ToolResult } from '@magnitudedev/harness'
import { isImageValue, formatToolResult as defaultFormatToolResult } from '@magnitudedev/harness'
import * as path from 'path'

import { PolicyContextProviderTag } from '../agents/types'
import { persistResult } from '../runtime/result-persistence'
import { describeShape, estimateText } from '../truncation'
import { TRUNCATION_TOKEN_LIMIT } from '../constants'
import type { getAgentDefinition } from '../agents/registry'

export interface StandardHooksContext {
  readonly forkId: string | null
  readonly turnId: string
  readonly agentDef: ReturnType<typeof getAgentDefinition>
  readonly workspacePath: string
}

export function buildStandardHooks(ctx: StandardHooksContext): HarnessHooks<PolicyContextProviderTag> {
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

    afterExecute: (hookCtx: ExecuteHookContext & { readonly result: ToolResult }) =>
      Effect.gen(function* () {
        if (hookCtx.result._tag === 'Success') {
          yield* persistResult(hookCtx.result.output, turnId, hookCtx.toolCallId, resultsDir).pipe(
            Effect.catchAll((e) => Effect.gen(function* () {
              logger.warn({ forkId, turnId, toolCallId: hookCtx.toolCallId, e }, '[Harness] persistResult failed')
            })),
          )
        }
      }),

    formatResult(toolCallId, _toolName, _toolKey, result) {
      if (result._tag !== 'Success' || result.output === undefined) {
        return defaultFormatToolResult(result)
      }
      if (isImageValue(result.output)) {
        return defaultFormatToolResult(result)
      }

      let serialized: string
      try {
        serialized = JSON.stringify(result.output, null, 2)
      } catch {
        return defaultFormatToolResult(result)
      }

      const estimatedTokens = estimateText(serialized)
      if (estimatedTokens <= TRUNCATION_TOKEN_LIMIT) {
        return defaultFormatToolResult(result)
      }

      const resultPath = `$M/results/${turnId}_${toolCallId}.json`
      const shapeSummary = describeShape(result.output)

      const text = [
        `<truncated path="${resultPath}" estimated_tokens="${estimatedTokens}">`,
        shapeSummary,
        `</truncated>`,
      ].join('\n')

      return [{ _tag: 'TextPart' as const, text }]
    },
  }
}
