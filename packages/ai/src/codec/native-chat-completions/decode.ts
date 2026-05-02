
import { Cause, Stream } from "effect"
import type { Schema } from "effect"
import { createStreamingFieldParser, type StreamingFieldParser } from "../../streaming/field-parser"
import type { ToolCallId } from "../../prompt/ids"
import type { FinishReason, ResponseStreamEvent } from "../../response/events"
import type { ResponseUsage } from "../../response/usage"
import type { StreamFailure } from "../../errors/failure"
import type { ToolDefinition } from "../../tools/tool-definition"
import type { ChatCompletionsStreamChunk } from "../../wire/chat-completions"
import type { FieldEvent } from "../../streaming/types"
import type { TokenLogprob } from "../../trace"

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolCallState {
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly parser: StreamingFieldParser
}

interface DecoderState {
  readonly nextToolOrdinal: number
  readonly thoughtOpen: boolean
  readonly messageOpen: boolean
  readonly openToolCalls: ReadonlyMap<number, ToolCallState>
  readonly toolSchemas: ReadonlyMap<string, Schema.Schema.Any>
  readonly terminated: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInitialState(
  tools?: readonly ToolDefinition[],
): DecoderState {
  const toolSchemas = new Map<string, Schema.Schema.Any>()
  if (tools) {
    for (const tool of tools) {
      toolSchemas.set(tool.name, tool.inputSchema)
    }
  }
  return {
    nextToolOrdinal: 0,
    thoughtOpen: false,
    messageOpen: false,
    openToolCalls: new Map(),
    toolSchemas,
    terminated: false,
  }
}

function toUsage(
  usage: NonNullable<ChatCompletionsStreamChunk["usage"]>,
): ResponseUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  }
}

function mapReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
    case "end_turn":
      return reason
    default:
      return "unknown"
  }
}

/** Wrap FieldEvents from the parser with a toolCallId to produce ResponseStreamEvents. */
function wrapFieldEvents<TStreamError>(
  fieldEvents: readonly FieldEvent[],
  toolCallId: ToolCallId,
): ResponseStreamEvent<TStreamError>[] {
  return fieldEvents.map((fe) => {
    switch (fe._tag) {
      case "field_start":
        return { _tag: "tool_call_field_start" as const, toolCallId, path: fe.path }
      case "field_delta":
        return { _tag: "tool_call_field_delta" as const, toolCallId, path: fe.path, delta: fe.delta }
      case "field_end":
        return { _tag: "tool_call_field_end" as const, toolCallId, path: fe.path, value: fe.value }
    }
  })
}

// ---------------------------------------------------------------------------
// Chunk processing
// ---------------------------------------------------------------------------

function processChunk<TStreamError>(
  chunk: ChatCompletionsStreamChunk,
  state: DecoderState,
  parsers: Map<ToolCallId, StreamingFieldParser>,
  logprobs: TokenLogprob[],
): readonly [DecoderState, readonly ResponseStreamEvent<TStreamError>[]] {
  const events: ResponseStreamEvent<TStreamError>[] = []
  let nextState = state

  if (nextState.terminated) {
    return [nextState, events]
  }

  const choice = chunk.choices[0]
  if (!choice) {
    return [nextState, events]
  }

  // Accumulate logprobs from chunk
  if (choice.logprobs?.content) {
    for (const lp of choice.logprobs.content) {
      logprobs.push({
        token: lp.token,
        logprob: lp.logprob,
        topLogprobs: lp.top_logprobs.map((tp) => ({ token: tp.token, logprob: tp.logprob })),
      })
    }
  }

  const delta = choice.delta

  // Thought content
  if (delta.reasoning_content) {
    if (!nextState.thoughtOpen) {
      nextState = { ...nextState, thoughtOpen: true }
      events.push({ _tag: "thought_start", level: "medium" })
    }
    events.push({ _tag: "thought_delta", text: delta.reasoning_content })
  }

  // Message content
  if (delta.content) {
    if (nextState.thoughtOpen) {
      events.push({ _tag: "thought_end" })
      nextState = { ...nextState, thoughtOpen: false }
    }
    if (!nextState.messageOpen) {
      nextState = { ...nextState, messageOpen: true }
      events.push({ _tag: "message_start" })
    }
    events.push({ _tag: "message_delta", text: delta.content })
  }

  // Tool calls
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    if (nextState.thoughtOpen) {
      events.push({ _tag: "thought_end" })
      nextState = { ...nextState, thoughtOpen: false }
    }
    if (nextState.messageOpen) {
      events.push({ _tag: "message_end" })
      nextState = { ...nextState, messageOpen: false }
    }

    const calls = new Map(nextState.openToolCalls)
    let nextToolOrdinal = nextState.nextToolOrdinal

    for (const toolCallDelta of delta.tool_calls) {
      let toolCall = calls.get(toolCallDelta.index)

      if (!toolCall) {
        nextToolOrdinal += 1
        const name = toolCallDelta.function?.name ?? ""
        const schema = nextState.toolSchemas.get(name)
        const parser = schema
          ? createStreamingFieldParser(schema as Schema.Schema<any, any, never>)
          : createStreamingFieldParser()
        const toolCallId = (toolCallDelta.id ?? `tool_call_${nextToolOrdinal}`) as ToolCallId
        toolCall = { toolCallId, toolName: name, parser }
        calls.set(toolCallDelta.index, toolCall)
        parsers.set(toolCallId, parser)
        events.push({
          _tag: "tool_call_start",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        })
      } else if (toolCallDelta.function?.name && toolCall.toolName.length === 0) {
        const name = toolCallDelta.function.name
        const schema = nextState.toolSchemas.get(name)
        const parser = schema
          ? createStreamingFieldParser(schema as Schema.Schema<any, any, never>)
          : createStreamingFieldParser()
        toolCall = { ...toolCall, toolName: name, parser }
        calls.set(toolCallDelta.index, toolCall)
        parsers.set(toolCall.toolCallId, parser)
      }

      if (toolCallDelta.function?.arguments) {
        const fieldEvents = toolCall.parser.push(toolCallDelta.function.arguments)
        events.push(...wrapFieldEvents<TStreamError>(fieldEvents, toolCall.toolCallId))

        if (!toolCall.parser.valid) {
          events.push({
            _tag: "stream_end",
            reason: {
              _tag: "validation_failure",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              issue: toolCall.parser.validationIssue!,
            },
            usage: chunk.usage ? toUsage(chunk.usage) : null,
          })
          nextState = { ...nextState, terminated: true }
          return [nextState, events]
        }
      }
    }

    nextState = {
      ...nextState,
      nextToolOrdinal,
      openToolCalls: calls,
    }
  }

  // Finish reason
  if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
    if (nextState.thoughtOpen) {
      events.push({ _tag: "thought_end" })
      nextState = { ...nextState, thoughtOpen: false }
    }
    if (nextState.messageOpen) {
      events.push({ _tag: "message_end" })
      nextState = { ...nextState, messageOpen: false }
    }

    for (const toolCall of nextState.openToolCalls.values()) {
      const fieldEvents = toolCall.parser.end()
      events.push(...wrapFieldEvents<TStreamError>(fieldEvents, toolCall.toolCallId))

      if (!toolCall.parser.valid) {
        events.push({
          _tag: "stream_end",
          reason: {
            _tag: "validation_failure",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            issue: toolCall.parser.validationIssue!,
          },
          usage: chunk.usage ? toUsage(chunk.usage) : null,
        })
        nextState = { ...nextState, terminated: true, openToolCalls: new Map() }
        return [nextState, events]
      }

      events.push({
        _tag: "tool_call_ready",
        toolCallId: toolCall.toolCallId,
      })
    }

    nextState = {
      ...nextState,
      openToolCalls: new Map(),
      terminated: true,
    }
    events.push({
      _tag: "stream_end",
      reason: {
        _tag: "completed",
        finishReason: mapReason(choice.finish_reason),
      },
      usage: chunk.usage ? toUsage(chunk.usage) : null,
    })
  }

  return [nextState, events]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decode<E, TStreamError>(
  chunks: Stream.Stream<ChatCompletionsStreamChunk, E>,
  options: {
    tools?: readonly ToolDefinition[]
    classifyStreamError: (failure: StreamFailure | E) => TStreamError
  },
): {
  readonly events: Stream.Stream<ResponseStreamEvent<TStreamError>, never>
  readonly parsers: ReadonlyMap<ToolCallId, StreamingFieldParser>
  readonly logprobs: TokenLogprob[]
} {
  const parsers = new Map<ToolCallId, StreamingFieldParser>()
  const logprobs: TokenLogprob[] = []

  const raw: Stream.Stream<ResponseStreamEvent<TStreamError>, E> = Stream.flatMap(
    Stream.mapAccum(
      chunks,
      makeInitialState(options.tools),
      (state, chunk): readonly [DecoderState, readonly ResponseStreamEvent<TStreamError>[]] => {
        return processChunk<TStreamError>(chunk, state, parsers, logprobs)
      },
    ),
    (events) => Stream.fromIterable(events),
  )

  // Catch all errors, classify, and emit as stream_end { error }
  const withErrorHandling = Stream.catchAllCause(raw, (cause) => {
    const failure = Cause.failureOption(cause)
    let streamError: TStreamError
    if (failure._tag === "Some") {
      streamError = options.classifyStreamError(failure.value)
    } else {
      const squashed = Cause.squash(cause)
      const syntheticFailure: StreamFailure = {
        _tag: "ReadFailure",
        cause: squashed instanceof Error
          ? squashed
          : new Error("Stream terminated unexpectedly"),
      }
      streamError = options.classifyStreamError(syntheticFailure as StreamFailure | E)
    }
    const endEvent: ResponseStreamEvent<TStreamError> = {
      _tag: "stream_end",
      reason: { _tag: "error", error: streamError },
      usage: null,
    }
    return Stream.make(endEvent)
  })

  // stream_end is the terminal event — include it then stop
  const events = Stream.takeUntil(withErrorHandling, (event) => event._tag === "stream_end")

  return { events, parsers, logprobs }
}
