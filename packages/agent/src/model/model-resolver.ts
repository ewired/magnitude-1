import { Context, Effect, Layer } from 'effect'
import type { BoundModel } from '@magnitudedev/ai'
import * as HttpClient from '@effect/platform/HttpClient'
import type { MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError, ModelProfile, MagnitudeAdditionalOptions } from '@magnitudedev/magnitude-client'
import { MagnitudeClient, toModelProfile, bindWithMagnitudeOptions } from '@magnitudedev/magnitude-client'
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

function withAgentId(
  model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError>,
  agentId: string,
): BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError> {
  return {
    ...model,
    stream: (prompt, tools, callOptions?) =>
      model.stream(prompt, tools, {
        ...callOptions,
        magnitudeAdditionalOptions: {
          ...callOptions?.magnitudeAdditionalOptions,
          agent_id: agentId,
        },
      }),
  }
}

export interface AgentModelResolverService {
  readonly resolve: (roleId: RoleId, agentId?: string) => Effect.Effect<AgentBoundModel, never, AmbientService>
  readonly resolveAutopilot: () => Effect.Effect<AgentBoundModel, Error, HttpClient.HttpClient>
  readonly resolveImage: () => Effect.Effect<AgentBoundModel, Error, HttpClient.HttpClient>
  readonly resolveTitle: () => Effect.Effect<AgentBoundModel, Error, HttpClient.HttpClient>
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
        resolve: (roleId: RoleId, agentId?: string) =>
          Effect.gen(function* () {
            const ambientService = yield* AmbientServiceTag
            const configState = ambientService.getValue(ConfigAmbient)
            const roleConfig = getRoleConfig(configState, roleId)
            const defaults = {
              maxTokens: roleConfig.profile.maxOutputTokens,
            }
            const capabilities = { vision: roleConfig.profile.capabilities.vision }

            const boundModel = client.role(roleId, { defaults, capabilities })
            const withTraits = roleId === 'leader'
              ? bindWithMagnitudeOptions(boundModel, LEADER_TRAITS)
              : boundModel
            const wrappedModel = agentId ? withAgentId(withTraits, agentId) : withTraits

            return {
              model: wrappedModel,
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
            const model = client.model('util/autopilot', { defaults })
            return {
              model: withAgentId(model, 'autopilot'),
              modelSource: { type: 'utility', modelId: 'util/autopilot' },
              modelId: 'util/autopilot',
              profile,
            }
          }),

        resolveImage: () =>
          Effect.gen(function* () {
            const info = yield* client.catalog.get('util/image')
            const profile = toModelProfile(info)
            const model = client.model('util/image')
            return {
              model: withAgentId(model, 'image-desc'),
              modelSource: { type: 'utility', modelId: 'util/image' },
              modelId: 'util/image',
              profile,
            }
          }),

        resolveTitle: () =>
          Effect.gen(function* () {
            const info = yield* client.catalog.get('util/title')
            const profile = toModelProfile(info)
            const model = client.model('util/title')
            return {
              model: withAgentId(model, 'title-gen'),
              modelSource: { type: 'utility', modelId: 'util/title' },
              modelId: 'util/title',
              profile,
            }
          }),
      }
    }),
  )
