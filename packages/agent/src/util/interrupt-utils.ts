import { Effect } from 'effect'
import type { TurnOutcomeEvent } from '../events'
import { isRoleId, type RoleId } from '../agents/role-validation'
import { getAgentDefinition } from '../agents/registry'
import { CanonicalTurnProjection } from '../projections/canonical-turn'
import { AgentStatusProjection, getAgentByForkId } from '../projections/agent-status'

export const buildInterruptedTurnOutcome = (params: {
  forkId: string | null
  turnId: string
  chainId: string | null
}) => Effect.gen(function* () {
  const { forkId, turnId, chainId } = params

  const canonicalProjection = yield* CanonicalTurnProjection.Tag
  const agentProjection = yield* AgentStatusProjection.Tag

  yield* canonicalProjection.getFork(forkId)
  const agentState = yield* agentProjection.get

  const roleId: RoleId = forkId
    ? (() => {
        const role = getAgentByForkId(agentState, forkId)?.role
        return role && isRoleId(role) ? role : 'engineer'
      })()
    : 'leader'

  getAgentDefinition(roleId)

  const event: TurnOutcomeEvent = {
    type: 'turn_outcome',
    forkId,
    turnId,
    chainId: chainId ?? '',
    strategyId: 'native',
    outcome: { _tag: 'Cancelled', reason: { _tag: 'UserInterrupt' } },
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    providerId: null,
    modelId: null,
  }

  return event
})