/**
 * System prompt builder.
 *
 * Constructs the final system prompt string from a RoleDefinition,
 * skills configuration, thinking lenses, and tool documentation.
 */

import type { RoleDefinition } from '@magnitudedev/roles'
import type { Skill } from '@magnitudedev/skills'
import type { ThinkingLens } from './protocol'
import { getProtocol } from './protocol'
import { renderSkillReferenceTable } from './tasks/index'
import fewShotNoteRaw from './protocol/few-shot-note.txt' with { type: 'text' }

function mapProtocolMode(roleDef: RoleDefinition): 'lead' | 'worker' {
  if (roleDef.agentKind === 'lead') return 'lead'
  return 'worker'
}

/**
 * Build the complete system prompt for an agent.
 *
 * Uses the role's prompt template, injects the response protocol,
 * tool documentation, and skills section.
 */
export function buildSystemPrompt(opts: {
  roleDef: RoleDefinition
  skills: Map<string, Skill>
  lenses: ThinkingLens[]
  toolDocs: string
}): string {
  const { roleDef, skills, lenses, toolDocs } = opts

  const protocol = getProtocol(
    lenses,
    mapProtocolMode(roleDef),
    roleDef.defaultRecipient,
  )

  const skillsSection = skills.size > 0
    ? `## Available skills\n\nSkills provide detailed methodologies for specific types of work. Use the \`skill\` tool to activate a skill and load its full guidance into context.\n\n${renderSkillReferenceTable(skills)}`
    : ''

  // The roles package prompt template expects SKILLS_SECTION as a runtime var.
  // Protocol and tool docs are injected via the agent-level template system.
  const basePrompt = roleDef.prompt.render({ SKILLS_SECTION: skillsSection })

  return basePrompt
    .replaceAll('{{RESPONSE_PROTOCOL}}', protocol)
    .replaceAll('{{TOOL_DOCS}}', toolDocs)
    + '\n\n' + fewShotNoteRaw
}
