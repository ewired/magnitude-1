import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'
import { CanonicalAccumulatorReducer, projectCanonical } from '../reducers'
import type { HarnessEvent, ToolInputStarted, ToolInputFieldChunk, ToolInputDecodeFailure, ToolInputValidationFailure } from '../../events'
import type { ProviderToolCallId, ToolCallId } from '@magnitudedev/ai'

// ── Helpers ─────────────────────────────────────────────────────────

function toolInputStarted(id: string, name: string): ToolInputStarted {
  return {
    _tag: 'ToolInputStarted',
    toolCallId: id as ToolCallId,
    providerToolCallId: id as ProviderToolCallId,
    toolName: name,
    toolKey: name,
  }
}

function toolInputFieldChunk(id: string, path: string[], delta: string): ToolInputFieldChunk {
  return {
    _tag: 'ToolInputFieldChunk',
    toolCallId: id as ToolCallId,
    providerToolCallId: id as ProviderToolCallId,
    field: path[path.length - 1],
    path,
    delta,
  }
}

function turnEndWithDecodeFailure(
  toolCallId: string,
  toolName: string,
): HarnessEvent {
  const failure: ToolInputDecodeFailure = {
    _tag: 'ToolInputDecodeFailure',
    toolCallId: toolCallId as ToolCallId,
    providerToolCallId: toolCallId as ProviderToolCallId,
    toolName,
    issue: { path: [], message: 'bad input' },
    inputSchema: {} as any,
    receivedInput: {} as any,
  }
  return {
    _tag: 'TurnEnd',
    outcome: failure,
    usage: null,
  } as HarnessEvent
}

function turnEndWithValidationFailure(
  toolCallId: string,
  toolName: string,
): HarnessEvent {
  const failure: ToolInputValidationFailure = {
    _tag: 'ToolInputValidationFailure',
    toolCallId: toolCallId as ToolCallId,
    providerToolCallId: toolCallId as ProviderToolCallId,
    toolName,
    toolKey: toolName,
    error: 'validation failed',
  }
  return {
    _tag: 'TurnEnd',
    outcome: failure,
    usage: null,
  } as HarnessEvent
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('partial input assembly on failure outcomes', () => {
  // ── Repro: ToolInputDecodeFailure loses partial inputs ───────────

  it('assembles partial inputs into assistantMessage.toolCalls on ToolInputDecodeFailure', () => {
    const reducer = CanonicalAccumulatorReducer
    let state = reducer.initial

    // Stream a tool call with partial input: only "path" is received
    state = reducer.step(state, toolInputStarted('call-1', 'file_edit'))
    state = reducer.step(state, toolInputFieldChunk('call-1', ['path'], '/some/invalid/path'))

    // Turn ends with decode failure — the model sent invalid JSON
    state = reducer.step(state, turnEndWithDecodeFailure('call-1', 'file_edit'))

    const canonical = projectCanonical(state)

    const toolCall = canonical.assistantMessage.toolCalls?.[0]
    expect(toolCall).toBeDefined()
    expect(toolCall!.name).toBe('file_edit')

    // BUG: Currently this is {} because TurnEnd only assembles partials for
    // Interrupted and ToolExecutionError, not ToolInputDecodeFailure.
    // The partial input should contain { path: "/some/invalid/path" }.
    expect(toolCall!.input).toEqual({ path: '/some/invalid/path' })
  })

  // ── Repro: ToolInputValidationFailure loses partial inputs ───────

  it('assembles partial inputs into assistantMessage.toolCalls on ToolInputValidationFailure', () => {
    const reducer = CanonicalAccumulatorReducer
    let state = reducer.initial

    // Stream a tool call with partial input: "path" is received but fails validation
    state = reducer.step(state, toolInputStarted('call-1', 'file_edit'))
    state = reducer.step(state, toolInputFieldChunk('call-1', ['path'], '/some/invalid/path'))

    // Turn ends with validation failure — the path is invalid
    state = reducer.step(state, turnEndWithValidationFailure('call-1', 'file_edit'))

    const canonical = projectCanonical(state)

    const toolCall = canonical.assistantMessage.toolCalls?.[0]
    expect(toolCall).toBeDefined()
    expect(toolCall!.name).toBe('file_edit')

    // BUG: Currently this is {} because TurnEnd only assembles partials for
    // Interrupted and ToolExecutionError, not ToolInputValidationFailure.
    // The partial input should contain { path: "/some/invalid/path" }.
    expect(toolCall!.input).toEqual({ path: '/some/invalid/path' })
  })
})
