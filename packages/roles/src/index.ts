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

// Autopilot prompts
import autopilotPromptRaw from './prompts/autopilot.txt' with { type: 'text' }
import autopilotTaskPromptRaw from './prompts/autopilot-task.txt' with { type: 'text' }
import { definePrompt } from './prompt'
export { autopilotPromptRaw }
export const autopilotTaskPrompt = definePrompt<'TASK'>(autopilotTaskPromptRaw)
