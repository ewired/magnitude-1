import { Effect, Schema } from 'effect'
import { defineHarnessTool, defineToolkit } from '@magnitudedev/harness'

// =============================================================================
// Tool Definitions
// =============================================================================

export const simulateUserMessageTool = defineHarnessTool({
  definition: {
    name: 'simulate_user_message',
    description: 'Write the next user message to continue the conversation.',
    inputSchema: Schema.Struct({
      message: Schema.String.annotations({
        description: 'The user message content.',
      }),
    }),
    outputSchema: Schema.Void,
  },
  execute: () => Effect.succeed(undefined),
})

export const finishAutopilotTool = defineHarnessTool({
  definition: {
    name: 'finish',
    description:
      'Signal that the user would be completely satisfied with the current state and no further action is needed. This disables autopilot.',
    inputSchema: Schema.Struct({}),
    outputSchema: Schema.Void,
  },
  execute: () => Effect.succeed(undefined),
})

// =============================================================================
// Toolkit
// =============================================================================

export const autopilotToolkit = defineToolkit({
  simulateUserMessage: { tool: simulateUserMessageTool },
  finishAutopilot: { tool: finishAutopilotTool },
})
