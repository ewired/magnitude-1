/**
 * Agent Registry
 *
 * All agent definitions, accessible by RoleId.
 */

import { createRoles, isRoleId, type RoleId, type RoleDefinition } from '@magnitudedev/roles'

import type { AgentStatusState } from '../projections/agent-status'
import type { ToolKey } from '../tools/toolkits'

// Agent-package-level role definition.
// In Phase 1, this is the roles-package RoleDefinition + tool keys.
// In Phase 3, this will be augmented with lenses, turn policy, etc.
export interface AgentRoleDefinition extends RoleDefinition {
  readonly toolKeys: readonly ToolKey[]
}

const LEAD_TOOLS: readonly ToolKey[] = [
  'fileRead', 'fileWrite', 'fileEdit', 'fileTree', 'fileSearch', 'fileView',
  'shell', 'webFetch', 'webSearch',
  'createTask', 'updateTask', 'spawnWorker', 'killWorker',
  'skill', 'messageWorker',
] as const

const WORKER_TOOLS: readonly ToolKey[] = [
  'fileRead', 'fileWrite', 'fileEdit', 'fileTree', 'fileSearch', 'fileView',
  'shell', 'webFetch', 'webSearch',
  'skill',
] as const

const ROLE_TOOL_KEYS: Record<RoleId, readonly ToolKey[]> = {
  leader: LEAD_TOOLS,
  scout: WORKER_TOOLS,
  architect: WORKER_TOOLS,
  engineer: WORKER_TOOLS,
  critic: WORKER_TOOLS,
  scientist: WORKER_TOOLS,
  artisan: WORKER_TOOLS,
  advisor: WORKER_TOOLS,
}

const BASE_ROLES = createRoles()
const ROLES: Record<RoleId, AgentRoleDefinition> = Object.fromEntries(
  Object.entries(BASE_ROLES).map(([id, def]) => [
    id,
    { ...def, toolKeys: ROLE_TOOL_KEYS[id as RoleId] },
  ])
) as Record<RoleId, AgentRoleDefinition>

const _overrides = new Map<string, AgentRoleDefinition>()

export function registerAgentDefinition(roleId: string, def: AgentRoleDefinition): void {
  _overrides.set(roleId, def)
}

export function clearAgentOverrides(): void {
  _overrides.clear()
}

export function getAgentDefinition(roleId: RoleId): AgentRoleDefinition {
  const override = _overrides.get(roleId)
  if (override) return override
  return ROLES[roleId]
}

/**
 * Resolve role for a fork.
 * Returns null when the agent is missing (e.g. already killed).
 * Callers must bail out when null is returned.
 */
export function getForkInfo(
  agentStatus: AgentStatusState,
  forkId: string | null
): { roleId: RoleId } | null {
  if (forkId === null) {
    return { roleId: 'leader' }
  }
  const agentId = agentStatus.agentByForkId.get(forkId)
  const agent = agentId ? agentStatus.agents.get(agentId) : undefined
  if (!agent) return null
  const role = agent.role
  if (!isRoleId(role)) return null
  return { roleId: role as RoleId }
}
