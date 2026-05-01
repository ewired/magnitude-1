import { Effect } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { createMagnitudeClient } from '@magnitudedev/magnitude-client'
import { isRoleId, type RoleId } from './agents/role-validation'

export async function fetchRoleContextWindows(
  apiKey?: string,
  endpoint?: string,
): Promise<Partial<Record<RoleId, number>>> {
  const client = createMagnitudeClient({ apiKey, endpoint })
  const models = await Effect.runPromise(
    client.catalog.list.pipe(Effect.provide(FetchHttpClient.layer)),
  )
  const out: Partial<Record<RoleId, number>> = {}
  for (const m of models) {
    for (const r of m.roles) {
      if (isRoleId(r)) out[r] = m.contextWindow
    }
  }
  return out
}
