// Types
export type { RoleId, PolicyContext, PolicyRule, RoleDefinition } from './types'
export { ROLE_IDS, isRoleId } from './types'

// Policy
export {
  denyForbiddenCommands,
  denyMutatingGit,
  denyWritesOutside,
  denyMassDestructiveIn,
  allowAll,
  evaluatePolicy,
} from './policy'

// Prompt
export { definePrompt } from './prompt'
export type { PromptTemplate } from './prompt'

// Model resolution
export type { ModelOverrideEntry, ModelOverrides } from './model-resolver'
export { resolveModel } from './model-resolver'

// Re-export model types from magnitude-client for convenience
export type { MagnitudeModelSpec, MagnitudeConnectionError, MagnitudeStreamError, ModelProfile } from '@magnitudedev/magnitude-client'

// Roles
export {
  createRoles,
  createLeaderRole,
  createScoutRole,
  createArchitectRole,
  createEngineerRole,
  createCriticRole,
  createScientistRole,
  createArtisanRole,
  createAdvisorRole,
} from './roles/index'
