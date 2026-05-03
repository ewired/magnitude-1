/**
 * Agent Communication Tool
 */

import { Effect, Schema } from 'effect'
import { defineHarnessTool } from '@magnitudedev/harness'

const MessageWorkerOutput = Schema.Struct({
  ok: Schema.Boolean,
  yield: Schema.optional(Schema.Boolean),
})

export const messageWorkerTool = defineHarnessTool({
  definition: {
    name: 'messageWorker',
    description: 'Send a message to another agent worker.',
    inputSchema: Schema.Struct({
      workerId: Schema.String.annotations({ description: 'ID of the worker to message' }),
      message: Schema.String.annotations({ description: 'Message content to send' }),
      yield: Schema.optional(Schema.Boolean.annotations({ description: 'When true, yield to this worker — the turn will not retrigger.' })),
    }),
    outputSchema: MessageWorkerOutput,
  },
  execute: (input, _ctx) =>
    Effect.succeed({ ok: true, yield: input.yield || undefined }),
})
