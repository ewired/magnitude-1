import { Ambient, AmbientServiceTag } from '@magnitudedev/event-core'
import { Effect } from 'effect'
import { resolveModel } from '@magnitudedev/roles'

import { ROLE_IDS, type RoleId } from '../agents/role-validation'
import { MagnitudeConfig, type MagnitudeConfigShape } from '../model/magnitude-config'

export interface RoleConfig {
  readonly providerId: string | null
  readonly modelId: string | null
  readonly hardCap: number
  readonly softCap: number
}

export interface ConfigState {
  readonly byRole: Readonly<Record<RoleId, RoleConfig>>
}

export function getRoleConfig(state: ConfigState, roleId: RoleId): RoleConfig {
  return state.byRole[roleId]
}

export function buildConfigState(config: MagnitudeConfigShape) {
  return Effect.sync(() => {
    const byRole = {} as Record<RoleId, RoleConfig>
    for (const roleId of ROLE_IDS) {
      const override = config.overrides?.[roleId]
      const profile = override?.profile ?? config.defaultProfile
      const modelId = override ? override.spec.modelId : `role/${roleId}`

      byRole[roleId] = {
        providerId: 'magnitude',
        modelId,
        hardCap: profile.contextWindow,
        softCap: Math.floor(profile.contextWindow * 0.9),
      }
    }
    return { byRole }
  })
}

export const ConfigAmbient = Ambient.define<ConfigState, MagnitudeConfigShape>({
  name: 'Config',
  initial: Effect.gen(function* () {
    const config = yield* MagnitudeConfig
    return yield* buildConfigState(config)
  }),
})

export function publishConfig(config: MagnitudeConfigShape) {
  return Effect.gen(function* () {
    const ambientService = yield* AmbientServiceTag
    const state = yield* buildConfigState(config)
    yield* ambientService.update(ConfigAmbient, state)
  })
}

export const publishConfigFromMagnitude = Effect.gen(function* () {
  const config = yield* MagnitudeConfig
  yield* publishConfig(config)
})
