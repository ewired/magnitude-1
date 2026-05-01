import { Context, Effect, Layer } from 'effect'
import type { BoundModel } from '@magnitudedev/ai'
import type { MagnitudeConnectionError, MagnitudeStreamError, ModelProfile } from '@magnitudedev/magnitude-client'
import { resolveModel } from '@magnitudedev/roles'
import type { RoleId } from '../agents/role-validation'
import { MagnitudeConfig } from './magnitude-config'

export interface AgentBoundModel {
  /** The ai BoundModel — used by harness in Phase 3. */
  readonly model: BoundModel<{}, MagnitudeConnectionError, MagnitudeStreamError>
  readonly roleId: RoleId
  readonly modelId: string
  readonly profile: ModelProfile
  /** The endpoint used for this model (needed to construct NativeBoundModel for TurnEngine). */
  readonly endpoint: string
}

export interface AgentModelResolverService {
  readonly resolve: (roleId: RoleId) => Effect.Effect<AgentBoundModel>
}

export class AgentModelResolver extends Context.Tag('AgentModelResolver')<
  AgentModelResolver,
  AgentModelResolverService
>() {}

export const AgentModelResolverLive = Layer.effect(
  AgentModelResolver,
  Effect.gen(function* () {
    const config = yield* MagnitudeConfig

    return {
      resolve: (roleId: RoleId) =>
        Effect.sync(() => {
          const bound = resolveModel(roleId, config.endpoint, config.auth, config.overrides)
          const override = config.overrides?.[roleId]
          const profile = override?.profile ?? config.defaultProfile
          const modelId = bound.spec.modelId

          return {
            model: bound,
            roleId,
            modelId,
            profile,
            endpoint: config.endpoint,
          }
        }),
    }
  }),
)
