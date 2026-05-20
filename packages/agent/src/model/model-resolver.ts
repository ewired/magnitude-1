import { Context, Effect, Layer } from 'effect'
import type { BoundModel } from '@magnitudedev/ai'
import * as HttpClient from '@effect/platform/HttpClient'
import type { MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError, ModelProfile, MagnitudeAdditionalOptions } from '@magnitudedev/magnitude-client'
import { MagnitudeClient, toModelProfile } from '@magnitudedev/magnitude-client'
import { AmbientServiceTag, type AmbientService } from '@magnitudedev/event-core'
import type { RoleId } from '../agents/role-validation'
import { ConfigAmbient, getRoleConfig } from '../ambient/config-ambient'

export interface AgentBoundModel {
  readonly model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError>
  readonly modelSource:
    | { readonly type: 'role'; readonly roleId: RoleId }
    | { readonly type: 'utility'; readonly modelId: string }
  readonly modelId: string
  readonly profile: ModelProfile
}

const LEADER_TRAITS: MagnitudeAdditionalOptions = {
  traits: ['ATTENTIVE', 'STRATEGIC', 'PROACTIVE', 'RESPECTFUL', 'GROUNDED', 'INTROSPECTIVE', 'TASK'],
}

export interface AgentModelResolverService {
  readonly resolve: (roleId: RoleId) => Effect.Effect<AgentBoundModel, never, AmbientService>
  readonly resolveAutopilot: () => Effect.Effect<AgentBoundModel, Error, HttpClient.HttpClient>
  readonly resolveImage: () => Effect.Effect<AgentBoundModel, Error, HttpClient.HttpClient>
}

export class AgentModelResolver extends Context.Tag('AgentModelResolver')<
  AgentModelResolver,
  AgentModelResolverService
>() {}

export const AgentModelResolverLive = () =>
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
            const defaults = {
              maxTokens: roleConfig.profile.maxOutputTokens,
              magnitudeAdditionalOptions: roleId === 'leader' ? LEADER_TRAITS : undefined,
            }
            const capabilities = { vision: roleConfig.profile.capabilities.vision }

            return {
              model: client.role(roleId, { defaults, capabilities }),
              modelSource: { type: 'role', roleId },
              modelId: `role/${roleId}`,
              profile: roleConfig.profile,
            }
          }),

        resolveAutopilot: () =>
          Effect.gen(function* () {
            const info = yield* client.catalog.get('util/autopilot')
            const profile = toModelProfile(info)
            const defaults = { maxTokens: profile.maxOutputTokens }
            return {
              model: client.model('util/autopilot', { defaults }),
              modelSource: { type: 'utility', modelId: 'util/autopilot' },
              modelId: 'util/autopilot',
              profile,
            }
          }),

        resolveImage: () =>
          Effect.gen(function* () {
            const info = yield* client.catalog.get('util/image')
            const profile = toModelProfile(info)
            return {
              model: client.model('util/image'),
              modelSource: { type: 'utility', modelId: 'util/image' },
              modelId: 'util/image',
              profile,
            }
          }),
      }
    }),
  )
