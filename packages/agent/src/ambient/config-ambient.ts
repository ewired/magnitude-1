import { Ambient, AmbientServiceTag } from '@magnitudedev/event-core'
import { Effect } from 'effect'
import { ProviderState } from '@magnitudedev/providers'
import type { ProviderStateShape } from '@magnitudedev/providers/src/runtime/contracts'

import { ROLE_IDS, type RoleId } from '../agents/role-validation'

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

export function buildConfigState(opts: {
  providerState: ProviderStateShape<RoleId>
}) {
  const { providerState } = opts

  return Effect.gen(function* () {
    const entries = yield* Effect.forEach(
      ROLE_IDS,
      (roleId) =>
        Effect.gen(function* () {
          const peek = yield* providerState.peek(roleId)
          const { hardCap, softCap } = yield* providerState.contextLimits(roleId)

          const config: RoleConfig = {
            providerId: peek?.model.providerId ?? null,
            modelId: peek?.model.id ?? null,
            hardCap,
            softCap,
          }

          return [roleId, config] as const
        }),
    )

    const byRole = {} as Record<RoleId, RoleConfig>
    for (const [roleId, config] of entries) {
      byRole[roleId] = config
    }

    return {
      byRole,
    }
  })
}

export const ConfigAmbient = Ambient.define<ConfigState, ProviderStateShape<RoleId>>({
  name: 'Config',
  initial: Effect.gen(function* () {
    const providerState = yield* ProviderState
    return yield* buildConfigState({
      providerState: providerState as ProviderStateShape<RoleId>,
    })
  }),
})

export function publishConfig(opts: {
  providerState: ProviderStateShape<RoleId>
}) {
  return Effect.gen(function* () {
    const ambientService = yield* AmbientServiceTag
    const state = yield* buildConfigState(opts)
    yield* ambientService.update(ConfigAmbient, state)
  })
}

export const publishConfigFromProviders = Effect.gen(function* () {
  const providerState = yield* ProviderState
  yield* publishConfig({
    providerState: providerState as ProviderStateShape<RoleId>,
  })
})
