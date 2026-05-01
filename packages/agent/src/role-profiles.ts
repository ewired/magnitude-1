import { Effect } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { createMagnitudeClient } from '@magnitudedev/magnitude-client'
import { isRoleId, type RoleId } from './agents/role-validation'

export interface RoleProfile {
  readonly contextWindow: number
  readonly modelId: string
  readonly modelDisplayName: string
}

export async function fetchRoleProfiles(
  apiKey?: string,
  endpoint?: string,
): Promise<Partial<Record<RoleId, RoleProfile>>> {
  const client = createMagnitudeClient({ apiKey, endpoint })
  const models = await Effect.runPromise(
    client.catalog.list.pipe(Effect.provide(FetchHttpClient.layer)),
  )
  const out: Partial<Record<RoleId, RoleProfile>> = {}
  for (const m of models) {
    for (const r of m.roles) {
      if (isRoleId(r)) {
        out[r] = {
          contextWindow: m.contextWindow,
          modelId: m.id,
          modelDisplayName: m.displayName,
        }
      }
    }
  }
  return out
}
