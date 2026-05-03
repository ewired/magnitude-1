/**
 * Example: Custom HarnessHooks for formatting overrides
 *
 * Shows how to define HarnessHooks with custom formatResult and
 * formatDecodeFailure to control how tool results appear in prompts.
 */

import type { HarnessHooks } from '../src'

// ── Custom hooks with formatting overrides ───────────────────────────

const myHooks: HarnessHooks = {
  // Override how tool execution results are formatted
  formatResult: (toolName, toolKey, result) => {
    if (result._tag === 'Success') {
      // Custom: wrap all success output in a tool-specific tag
      return [{
        _tag: 'TextPart',
        text: `<${toolName}_result>${JSON.stringify(result.output)}</${toolName}_result>`,
      }]
    }

    if (result._tag === 'Error') {
      // Custom: include tool name in error
      return [{
        _tag: 'TextPart',
        text: `<error tool="${toolName}">${result.error.message}</error>`,
      }]
    }

    // Fall through for rejected/interrupted — return default-style
    if (result._tag === 'Interrupted') {
      return [{ _tag: 'TextPart', text: '<interrupted/>' }]
    }

    return [{ _tag: 'TextPart', text: `<rejected>${String(result.rejection)}</rejected>` }]
  },

  // Override how decode failures are formatted
  formatDecodeFailure: (toolName, issue, inputSchema, receivedInput) => {
    // Minimal format — just the problem
    return [{
      _tag: 'TextPart',
      text: [
        `<parse_error>`,
        `Tool "${toolName}" received invalid input.`,
        issue.path.length > 0 ? `Field: ${issue.path.join('.')}` : null,
        `Issue: ${issue.message}`,
        `</parse_error>`,
      ].filter(Boolean).join('\n'),
    }]
  },
}

// ── Hooks with Effect-based interceptors ─────────────────────────────

import { Effect } from 'effect'

const hooksWithInterceptors: HarnessHooks = {
  // Run before every tool execution — can reject or modify input
  beforeExecute: (ctx) =>
    Effect.succeed(
      ctx.toolName === 'shell'
        ? { _tag: 'Proceed' as const, modifiedInput: ctx.input }
        : { _tag: 'Proceed' as const }
    ),

  // Run after every tool execution
  afterExecute: (ctx) =>
    Effect.sync(() => {
      console.log(`Tool ${ctx.toolName} completed with ${ctx.result._tag}`)
    }),

  // Observe every harness event
  onEvent: (event) =>
    Effect.sync(() => {
      if (event._tag === 'ToolExecutionStarted') {
        console.log(`Starting tool: ${event.toolName}`)
      }
    }),
}
