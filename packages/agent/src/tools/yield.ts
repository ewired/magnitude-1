/**
 * Yield Tool
 *
 * Allows an agent to explicitly end its turn without retriggering.
 * Lead version takes a target (user, advisor, workers).
 * Worker version is parameterless — always yields to parent.
 */

import { Effect, Schema } from 'effect'
import { defineHarnessTool } from '@magnitudedev/harness'
import { Fork } from '@magnitudedev/event-core'
import { AgentStateReaderTag } from './fork'
import { ToolErrorSchema } from './errors'

const YieldToolErrorSchema = ToolErrorSchema('YieldToolError', {})

const { ForkContext } = Fork

const YieldTargetSchema = Schema.Literal('user', 'advisor', 'workers')

export const yieldTool = defineHarnessTool({
  definition: {
    name: 'yield',
    description: 'End the current turn and yield control. Prevents the turn from automatically continuing (retriggering) after tool results come back.\n\n- user: Wait for the user to respond before taking another turn.\n- advisor: Wait for advisor input. Currently same behavior as user.\n- workers: Wait for a worker to follow up. Errors if no non-idle workers exist.',
    inputSchema: Schema.Struct({
      target: YieldTargetSchema.annotations({ description: 'Who to yield control to.' }),
    }),
    outputSchema: Schema.Struct({
      target: Schema.String,
    }),
  },
  errorSchema: YieldToolErrorSchema,
  execute: (input, _ctx) =>
    Effect.gen(function* () {
      if (input.target === 'workers') {
        const { forkId } = yield* ForkContext
        const agentStateReader = yield* AgentStateReaderTag
        const agentState = yield* agentStateReader.getAgentState()
        const hasWorkingWorkers = [...agentState.agents.values()]
          .some(a => a.parentForkId === forkId && a.status === 'working')
        if (!hasWorkingWorkers) {
          return yield* Effect.fail({
            _tag: 'YieldToolError' as const,
            message: 'Cannot yield to workers: no non-idle workers exist.',
          })
        }
      }
      return { target: input.target }
    }),
})

export const workerYieldTool = defineHarnessTool({
  definition: {
    name: 'yield',
    description: 'End the current turn and yield control back to the parent agent. The turn will not retrigger.',
    inputSchema: Schema.Struct({}),
    outputSchema: Schema.Struct({
      ok: Schema.Boolean,
    }),
  },
  errorSchema: YieldToolErrorSchema,
  execute: (_input, _ctx) =>
    Effect.succeed({ ok: true }),
})
