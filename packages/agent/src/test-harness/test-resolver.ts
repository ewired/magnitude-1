import { Effect, Layer } from 'effect'
import { AgentModelResolver } from '../model/model-resolver'
import { createTestBoundModel, type TestModelConfig } from './test-model'
import type { RoleId } from '../agents/role-validation'
import type { ModelProfile } from '@magnitudedev/magnitude-client'

const DEFAULT_TEST_PROFILE: ModelProfile = {
  contextWindow: 200_000,
  maxOutputTokens: 32_768,
  capabilities: { vision: true, reasoning: true },
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
