import { definePrompt } from '../prompt'
import { denyForbiddenCommands, denyMutatingGit, denyWritesOutside, denyMassDestructiveIn, allowAll } from '../policy'
import type { RoleDefinition } from '../types'
import scientistPromptRaw from '../prompts/scientist.txt' with { type: 'text' }
import { homedir } from 'node:os'
import { join } from 'node:path'

export function createScientistRole(): RoleDefinition {
  return {
    id: 'scientist',
    description: 'Debugs and diagnoses issues',
    prompt: definePrompt<'SKILLS_SECTION' | 'THINKING_LIMIT'>(scientistPromptRaw),
    defaultRecipient: 'parent',
    agentKind: 'worker',
    spawnable: true,
    maxThoughtChars: 5000,
    policy: [
      denyForbiddenCommands(),
      denyMutatingGit(),
      denyWritesOutside(ctx => [ctx.cwd, ctx.scratchpadPath, join(homedir(), '.magnitude')]),
      denyMassDestructiveIn(ctx => [join(homedir(), '.magnitude')]),
      allowAll(),
    ],
    lifecycle: {
      parentOnSpawn: undefined,
      parentOnIdle: "Review the scientist's diagnosis and determine next steps.",
    },
    initialContext: { parentConversation: true },
  }
}
