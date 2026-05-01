import { Context, Effect, Layer } from 'effect'
import type { BoundModel } from '@magnitudedev/ai'
import type { MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError, ModelProfile } from '@magnitudedev/magnitude-client'
import { MagnitudeClient } from '@magnitudedev/magnitude-client'
import type { ModelOverrides } from '@magnitudedev/roles'
import { AmbientServiceTag, type AmbientService } from '@magnitudedev/event-core'
import type { RoleId } from '../agents/role-validation'
import { ConfigAmbient, getRoleConfig } from '../ambient/config-ambient'

export interface AgentBoundModel {
  readonly model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError>
  readonly roleId: RoleId
  readonly modelId: string
  readonly profile: ModelProfile
}

export interface AgentModelResolverService {
  readonly resolve: (roleId: RoleId) => Effect.Effect<AgentBoundModel, never, AmbientService>
}

export class AgentModelResolver extends Context.Tag('AgentModelResolver')<
  AgentModelResolver,
  AgentModelResolverService
>() {}

export const AgentModelResolverLive = (overrides?: ModelOverrides) =>
  Layer.effect(
    AgentModelResolver,
    Effect.gen(function* () {
      const client = yield* MagnitudeClient

      return {
        resolve: (roleId: RoleId) =>
          Effect.gen(function* () {
            const ambientService = yield* AmbientServiceTag
            const configState = ambientService.getValue(ConfigAmbient)
            const roleConfig = getRoleConfig(configState, roleId)
            const defaults = { maxTokens: roleConfig.profile.maxOutputTokens }

            const override = overrides?.[roleId]
            const model = override
              ? override.spec.bind({ auth: override.auth ?? client.auth, defaults })
              : client.role(roleId, defaults)

            return {
              model,
              roleId,
              modelId: override?.spec.modelId ?? `role/${roleId}`,
              profile: roleConfig.profile,
            }
          }),
      }
    }),
  )
