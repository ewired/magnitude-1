/**
 * Agentic compaction turn — runs a normal agent turn for reflection/summarization.
 */

import { Effect, Stream, Ref } from 'effect'
import { AmbientServiceTag } from '@magnitudedev/event-core'
import { logger } from '@magnitudedev/logger'
import { createHarness } from '@magnitudedev/harness'

import { renderToolDocs } from '../prompts/render-tool-docs'

import type { AppEvent } from '../events'
import { mapStreamErrorToOutcome } from '../errors/classify'

import type { ForkWindowState } from '../window'
import { SessionContextProjection } from '../projections/session-context'
import { AgentModelResolver } from '../model/model-resolver'
import { getAgentDefinition } from '../agents/registry'
import { getToolkitForRole } from '../tools/toolkits'
import { buildSystemPrompt } from '../prompts/system-prompt-builder'
import { buildCompactionPrompt } from './prompt'

import { ExecutionManager } from '../execution/types'
import { SkillsAmbient } from '../ambient/skills-ambient'
import { buildStandardHooks } from '../execution/harness-hooks'
import type { RoleId } from '../agents/role-validation'

export function runCompactionTurn(
  forkId: string | null,
  roleId: RoleId,
  windowState: ForkWindowState,
  publish: (event: AppEvent) => Effect.Effect<void>,
  read: any,
): Effect.Effect<string, any, any> {
  return Effect.gen(function* () {
    const agentDef = getAgentDefinition(roleId)

    // Resolve model (same as Cortex)
    const modelResolver = yield* AgentModelResolver
    const agentModel = yield* modelResolver.resolve(roleId)

    // Get toolkit and fork layer (same as Cortex)
    const toolkit = getToolkitForRole(roleId)
    const execManager = yield* ExecutionManager
    const forkLayer = execManager.getForkLayer(forkId)
    if (!forkLayer) {
      return yield* Effect.fail(new Error('Fork layer not initialized'))
    }

    // Session context
    const sessionCtx = yield* read(SessionContextProjection)
    const workspacePath = sessionCtx.context?.workspacePath ?? process.cwd()
    const ambientService = yield* AmbientServiceTag
    const skills = ambientService.getValue(SkillsAmbient)

    // Create harness (same config as Cortex — preserves prefix cache)
    const compactionTurnId = `compaction-${Date.now()}`
    const harness = createHarness({
      model: agentModel.model,
      toolkit,
      mapStreamError: mapStreamErrorToOutcome,
      layer: forkLayer,
      hooks: buildStandardHooks({ forkId, turnId: compactionTurnId, agentDef, workspacePath }),
    })

    // Build system prompt (identical to normal turns → prefix cache preserved)
    const toolDefs = harness.getToolDefinitions()
    const toolDocs = toolDefs.length > 0 ? renderToolDocs(toolDefs) : ''
    const systemPrompt = buildSystemPrompt({
      roleDef: agentDef,
      skills,
      lenses: [],
      toolDocs,
    })

    // Build compaction prompt: full window + reflection instruction appended
    const timezone = sessionCtx.context?.timezone ?? null
    const compactionPrompt = buildCompactionPrompt(windowState, systemPrompt, timezone)

    // Run turn — MagnitudeConnectionError propagates to caller
    const liveTurn = yield* harness.runTurn(compactionPrompt)

    // Drain events (tools execute automatically via harness)
    yield* Stream.runForEach(liveTurn.events, () => Effect.void)

    // Extract assistant response text from canonical turn state
    const canonical = yield* Ref.get(liveTurn.canonicalTurn)
    const responseText = canonical.assistantMessage.text ?? ''

    if (!responseText || responseText.trim().length === 0) {
      return yield* Effect.fail(new Error('Empty compaction response'))
    }

    return responseText
  })
}


