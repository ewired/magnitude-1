import { Effect } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { createMagnitudeClient } from '@magnitudedev/magnitude-client'
import type { UsageWindowsResponse } from '@magnitudedev/magnitude-client'

export type { UsageWindowsResponse } from '@magnitudedev/magnitude-client'

export async function fetchUsageWindows(
  apiKey?: string,
  endpoint?: string,
): Promise<UsageWindowsResponse> {
  const client = createMagnitudeClient({ apiKey, endpoint })
  return Effect.runPromise(
    client.usage.pipe(Effect.provide(FetchHttpClient.layer)),
  )
}
