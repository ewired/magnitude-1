
/**
 * ResolvedToolSet — Single source of truth for tool availability per role
 *
 * Replaces the `excludeTools` band-aid with a bundled type that ensures
 * all 4 tool consumers stay in sync.
 *
 * INVARIANT: The 4 consumers must stay in sync:
 * 1. Tool registry (buildRegisteredTools) — tools available at runtime
 * 2. XML grammar (generateToolGrammar) — tools the model can generate
 * 3. System prompt / tool docs (generateXmlActToolDocs) — tools described to model
 * 4. Binding registry (getBindingRegistry) — XML bindings for serialization
 *
 * If a tool is unavailable for a role, it must be absent from all four.
 * If a tool is available, it must be present in all four.
 */

import type { AgentRoleDefinition } from '../agents/registry'
import type { RoleId } from '../agents/role-validation'
import type { ConfigState } from '../ambient/config-ambient'

/**
 * ResolvedToolSet bundles all 4 tool representations for a specific role.
 * Built once per turn. All consumers read from the same availableKeys.
 */
export interface ResolvedToolSet {
  readonly agentDef: AgentRoleDefinition
  readonly availableKeys: ReadonlySet<string>  // filtered defKeys for this role
  readonly roleId: RoleId
}

/**
 * Build a ResolvedToolSet for a role.
 * Single decision site for tool availability.
 */
export function buildResolvedToolSet(
  agentDef: AgentRoleDefinition,
  configState: ConfigState,
  roleId: RoleId,
): ResolvedToolSet {
  const roleConfig = configState.byRole[roleId]
  const isMagnitudeProvider = roleConfig.providerId === 'magnitude'
  const hasExaKey = !!process.env.EXA_API_KEY
  
  // Compute available keys by filtering agentDef.toolKeys
  const availableKeys = new Set<string>()
  for (const defKey of agentDef.toolKeys) {
    // webSearch excluded when no Magnitude provider AND no EXA key
    if (defKey === 'webSearch' && !isMagnitudeProvider && !hasExaKey) {
      continue
    }
    availableKeys.add(defKey)
  }

  return {
    agentDef,
    availableKeys,
    roleId,
  }
}
