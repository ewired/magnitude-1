import { Effect, Layer } from 'effect'
import { AgentModelResolver } from '../model/model-resolver'
import { createTestBoundModel, type TestModelConfig } from './test-model'
import type { RoleId } from '../agents/role-validation'
import type { ModelProfile, ReasoningCapability } from '@magnitudedev/magnitude-client'

const DEFAULT_REASONING: ReasoningCapability = { type: 'always', effort: ['low', 'medium', 'high'] }

const DEFAULT_TEST_PROFILE: ModelProfile = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  capabilities: { vision: true, grammar: false, reasoning: DEFAULT_REASONING },
}

export function makeTestModelResolver(config: TestModelConfig = {}): Layer.Layer<AgentModelResolver> {
  const bound = createTestBoundModel(config)
  return Layer.succeed(AgentModelResolver, {
    resolve: (roleId: RoleId) =>
      Effect.succeed({
        model: bound,
        roleId,
        modelId: 'test-model',
        profile: DEFAULT_TEST_PROFILE,
      }),
  })
}
