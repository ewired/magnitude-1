/**
 * Policy Interceptor
 *
 * Evaluates the agent's tool policy for the current tool call and routes the decision.
 */

import { Effect, Context } from 'effect'
import { Fork } from '@magnitudedev/event-core'
import { PermissionRejection } from './permission-rejection'
import type { RoleDefinition } from '@magnitudedev/roles'
import type { Policy } from '../agents/policy'
import { PolicyContextProviderTag } from '../agents/types'
import { evaluate } from '../agents/policy'

const { ForkContext } = Fork

/** Context provided to the interceptor for each tool call. */
export interface InterceptorContext {
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
  readonly meta: unknown
}

/** Decision returned by the interceptor. */
export type InterceptorDecision =
  | { readonly _tag: 'Proceed' }
  | { readonly _tag: 'Reject'; readonly rejection: unknown }

/** Tool interceptor interface — evaluates policy before tool execution. */
export interface ToolInterceptor {
  readonly beforeExecute: (ctx: InterceptorContext) => Effect.Effect<InterceptorDecision, never, any>
}

/** Service tag for the tool interceptor. */
export class ToolInterceptorTag extends Context.Tag('ToolInterceptor')<
  ToolInterceptorTag, ToolInterceptor
>() {}

/** Resolves the active agent definition for a given fork. */
export type AgentResolver = (forkId: string | null) => RoleDefinition

export function buildPolicyInterceptor(
  resolveAgent: AgentResolver,
) {
  return (ctx: InterceptorContext) =>
    Effect.gen(function* () {
      const { forkId } = yield* ForkContext
      const agentDef = resolveAgent(forkId)
      const policyCtx = yield* (yield* PolicyContextProviderTag).get
      const defKey = getDefKey(ctx.meta)
      if (defKey === null) {
        return reject(PermissionRejection.Forbidden({ reason: 'Invalid tool metadata' }))
      }

      const decision = yield* evaluate(
        agentDef.policy as Policy<unknown, unknown>,
        defKey,
        ctx.input,
        policyCtx,
      )

      if (decision.decision === 'allow') {
        return { _tag: 'Proceed' } satisfies InterceptorDecision
      }

      return reject(PermissionRejection.Forbidden({ reason: decision.reason }))
    })
}

function getDefKey(meta: unknown): string | null {
  const m = meta as { defKey?: unknown }
  return typeof m.defKey === 'string' ? m.defKey : null
}

function reject(rejection: unknown): InterceptorDecision {
  return { _tag: 'Reject', rejection }
}
