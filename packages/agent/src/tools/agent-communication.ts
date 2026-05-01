/**
 * Agent Communication Tool
 */

import { Effect, Schema } from 'effect'
import { defineHarnessTool } from '@magnitudedev/harness'

const MessageWorkerOutput = Schema.Struct({
  ok: Schema.Boolean,
})

export const messageWorkerTool = defineHarnessTool({
  definition: {
    name: 'messageWorker',
    description: 'Send a message to another agent worker.',
    inputSchema: Schema.Struct({
      workerId: Schema.String.annotations({ description: 'ID of the worker to message' }),
      message: Schema.String.annotations({ description: 'Message content to send' }),
    }),
    outputSchema: MessageWorkerOutput,
  },
  execute: (_input, _ctx) =>
    Effect.succeed({ ok: true }),
})
