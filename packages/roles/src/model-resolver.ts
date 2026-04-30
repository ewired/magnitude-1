import type { AuthApplicator, BoundModel } from '@magnitudedev/ai'
import type { MagnitudeModelSpec, MagnitudeConnectionError, MagnitudeStreamError, ModelProfile, RoleId as ClientRoleId } from '@magnitudedev/magnitude-client'
import { createRoleSpec } from '@magnitudedev/magnitude-client'
import type { RoleId } from './types'

/**
 * A model override entry with explicit auth and metadata.
 */
export interface ModelOverrideEntry {
  readonly spec: MagnitudeModelSpec
  readonly profile: ModelProfile
  readonly auth?: AuthApplicator
}

/**
 * Per-role model overrides.
 */
export type ModelOverrides = Partial<Record<RoleId, ModelOverrideEntry>>

/**
 * Resolve a bound model for a given role.
 */
export function resolveModel(
  roleId: RoleId,
  endpoint: string,
  auth: AuthApplicator,
  overrides?: ModelOverrides,
): BoundModel<{}, MagnitudeConnectionError, MagnitudeStreamError> {
  if (overrides?.[roleId]) {
    const override = overrides[roleId]!
    return override.spec.bind({ auth: override.auth ?? auth })
  }

  const spec = createRoleSpec(roleId as ClientRoleId, endpoint)
  return spec.bind({ auth })
}
