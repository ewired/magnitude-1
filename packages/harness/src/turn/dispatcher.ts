import { Effect, Cause, Layer, Stream, Schema } from "effect"
import type { ResponseStreamEvent, StreamError, ToolCallId, StreamingFieldParser, FinishReason, ValidationIssue } from "@magnitudedev/ai"
import type { StreamingPartial } from "@magnitudedev/ai"
import type { HarnessEvent, ToolError, ToolResult, TurnOutcome } from "../events"
import type { HarnessHooks, ExecuteHookContext } from "../hooks"
import type { Toolkit } from "../tool/toolkit"
import type { HarnessToolErased, ToolContext, StreamHook } from "../tool/tool"
import type { EngineState, ToolOutcome } from "./reducers"
import { formatDecodeFailure } from "../formatting/format-decode-failure"
import { formatToolResult } from "./result-formation"

// ── Config ───────────────────────────────────────────────────────────

export interface DispatchConfig<TStreamError = StreamError> {
  readonly events: Stream.Stream<ResponseStreamEvent<TStreamError>, never>
  readonly parsers: ReadonlyMap<ToolCallId, StreamingFieldParser>
  readonly toolkit: Toolkit
  readonly hooks?: HarnessHooks<unknown>
  // Erased layer — createHarness enforces type coverage at compile time.
  readonly layer?: Layer.Layer<unknown>
  readonly initialEngineState?: EngineState
  readonly emit: (event: HarnessEvent) => Effect.Effect<void>
  readonly mapStreamError: (error: TStreamError) => TurnOutcome
}

// ── Per-tool-call accumulator ────────────────────────────────────────

interface ToolCallAccumulator {
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly toolKey: string
  readonly streamState: unknown
  readonly streamHook: StreamHook<any, any, any, any, any> | undefined
}

// ── Dispatch ─────────────────────────────────────────────────────────

export function dispatch<TStreamError = StreamError>(config: DispatchConfig<TStreamError>): Effect.Effect<void> {
  const { toolkit, hooks, emit, initialEngineState } = config

  // Build lookup maps from toolkit
  const toolNameToKey = new Map<string, string>()
  const toolKeyToEntry = new Map<string, { tool: HarnessToolErased }>()
  for (const key of toolkit.keys) {
    const entry = toolkit.entries[key]
    const tool = entry.tool as HarnessToolErased
    toolNameToKey.set(tool.definition.name, key)
    toolKeyToEntry.set(key, { tool })
  }

  // Build cached outcomes map from initial engine state
  const cachedOutcomes = new Map<ToolCallId, ToolOutcome>()
  if (initialEngineState) {
    for (const [toolCallId, outcome] of initialEngineState.toolOutcomes) {
      cachedOutcomes.set(toolCallId, outcome)
    }
  }

  // Mutable dispatch state (scoped to this dispatch invocation)
  const accumulators = new Map<ToolCallId, ToolCallAccumulator>()
  let terminalOverride: TurnOutcome | null = null
  let toolCallCount = 0

  // ── Provide layer to erased effect ───────────────────────────────

  // Erased-boundary layer provision — type coverage enforced by createHarness at compile time.
  function provideLayer<A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> {
    if (config.layer) {
      return Effect.provide(effect, config.layer) as Effect.Effect<A, E, never>
    }
    return effect as Effect.Effect<A, E, never>
  }

  // ── Emit helper for tool context ─────────────────────────────────

  function makeToolEmit(toolCallId: ToolCallId, toolName: string, toolKey: string) {
    return (value: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* emit({ _tag: "ToolEmission", toolCallId, toolName, toolKey, value })
        if (hooks?.onEmission) {
          yield* provideLayer(hooks.onEmission({ toolCallId, toolName, toolKey, value }))
        }
      })
  }

  // ── Tool execution pipeline ──────────────────────────────────────

  function executeTool(
    toolCallId: ToolCallId,
    toolName: string,
    toolKey: string,
    input: Record<string, unknown>,
  ): Effect.Effect<void> {
    const lookup = toolKeyToEntry.get(toolKey)
    if (!lookup) {
      terminalOverride = { _tag: "EngineDefect", message: `Unknown tool key: ${toolKey}` }
      return Effect.void
    }
    const { tool } = lookup

    // Check cached outcome
    const cached = cachedOutcomes.get(toolCallId)
    if (cached && cached._tag === "Completed") {
      return Effect.gen(function* () {
        yield* emit({
          _tag: "ToolExecutionStarted",
          toolCallId, toolName, toolKey,
          input,
          cached: true,
        })
        yield* emit({
          _tag: "ToolExecutionEnded",
          toolCallId, toolName, toolKey,
          result: cached.result,
        })
        const parts = yield* provideLayer(formatToolResult(toolCallId, toolName, toolKey, cached.result, hooks))
        yield* emit({ _tag: "ToolResultFormatted", toolCallId, toolName, toolKey, parts })
      })
    }

    // beforeExecute hook
    const hookCtx: ExecuteHookContext = { toolCallId, toolName, toolKey, input }

    return Effect.gen(function* () {
      const decision = hooks?.beforeExecute
        ? yield* provideLayer(hooks.beforeExecute(hookCtx))
        : { _tag: "Proceed" as const }

      if (decision._tag === "Reject") {
        yield* emit({
          _tag: "ToolExecutionStarted",
          toolCallId, toolName, toolKey,
          input,
          cached: false,
        })
        const result: ToolResult = { _tag: "Rejected", rejection: decision.rejection }
        yield* emit({ _tag: "ToolExecutionEnded", toolCallId, toolName, toolKey, result })
        const parts = yield* provideLayer(formatToolResult(toolCallId, toolName, toolKey, result, hooks))
        yield* emit({ _tag: "ToolResultFormatted", toolCallId, toolName, toolKey, parts })
        terminalOverride = { _tag: "GateRejected", toolCallId, toolName }
        return
      }

      const effectiveInput = (decision.modifiedInput ?? input) as Record<string, unknown>

      yield* emit({
        _tag: "ToolExecutionStarted",
        toolCallId, toolName, toolKey,
        input: effectiveInput,
        cached: false,
      })

      // Build ToolContext with working emit
      const toolCtx: ToolContext<unknown> = {
        emit: makeToolEmit(toolCallId, toolName, toolKey),
      }

      // Execute tool with layer provision
      const result: ToolResult = yield* Effect.gen(function* () {
        const toolEffect = tool.execute(effectiveInput, toolCtx)
        const provided = provideLayer(toolEffect)
        const output = yield* provided
        return { _tag: "Success" as const, output }
      }).pipe(
        Effect.catchAllCause((cause) => {
          const squashed = Cause.squash(cause)
          const error: ToolError = typeof squashed === 'object' && squashed !== null && 'message' in squashed
            ? squashed as ToolError
            : { message: String(squashed) }
          return Effect.succeed({ _tag: "Error" as const, error })
        }),
      )

      yield* emit({ _tag: "ToolExecutionEnded", toolCallId, toolName, toolKey, result })

      // afterExecute hook
      if (hooks?.afterExecute) {
        yield* provideLayer(hooks.afterExecute({ ...hookCtx, result }))
      }

      // Format result
      const parts = yield* provideLayer(formatToolResult(toolCallId, toolName, toolKey, result, hooks))
      yield* emit({ _tag: "ToolResultFormatted", toolCallId, toolName, toolKey, parts })
    })
  }

  // ── Stream event processing ──────────────────────────────────────

  function processEvent(event: ResponseStreamEvent<TStreamError>): Effect.Effect<void> {
    switch (event._tag) {
      case "thought_start":
        return emit({ _tag: "ThoughtStart", level: event.level })

      case "thought_delta":
        return emit({ _tag: "ThoughtDelta", text: event.text })

      case "thought_end":
        return emit({ _tag: "ThoughtEnd" })

      case "message_start":
        return emit({ _tag: "MessageStart" })

      case "message_delta":
        return emit({ _tag: "MessageDelta", text: event.text })

      case "message_end":
        return emit({ _tag: "MessageEnd" })

      case "tool_call_start": {
        const toolKey = toolNameToKey.get(event.toolName)
        if (!toolKey) {
          terminalOverride = { _tag: "EngineDefect", message: `Unknown tool name: ${event.toolName}` }
          return Effect.void
        }
        const entry = toolKeyToEntry.get(toolKey)
        if (!entry) {
          terminalOverride = { _tag: "EngineDefect", message: `No entry for tool key: ${toolKey}` }
          return Effect.void
        }
        toolCallCount++

        const acc: ToolCallAccumulator = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolKey,
          streamState: entry.tool.stream?.initial,
          streamHook: entry.tool.stream,
        }
        accumulators.set(event.toolCallId, acc)

        return emit({
          _tag: "ToolInputStarted",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolKey,
        })
      }

      case "tool_call_field_start":
        return Effect.void

      case "tool_call_field_delta": {
        const acc = accumulators.get(event.toolCallId)
        if (!acc) return Effect.void

        const field = event.path[0] ?? ""

        return Effect.gen(function* () {
          yield* emit({
            _tag: "ToolInputFieldChunk",
            toolCallId: event.toolCallId,
            field,
            path: event.path,
            delta: event.delta,
          })

          // Invoke stream hook onInput if present — read partial from parser
          if (acc.streamHook) {
            const parser = config.parsers.get(event.toolCallId)
            if (parser) {
              const toolCtx: ToolContext<unknown> = {
                emit: makeToolEmit(acc.toolCallId, acc.toolName, acc.toolKey),
              }
              const partial = parser.partial
              if (partial) {
                const newStreamState = yield* provideLayer(
                  acc.streamHook.onInput(partial, acc.streamState, toolCtx),
                ).pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.as(
                      Effect.logWarning("Stream hook onInput failed", { cause: Cause.squash(cause) }),
                      acc.streamState,
                    ),
                  ),
                )
                accumulators.set(event.toolCallId, { ...acc, streamState: newStreamState })
              }
            }
          }
        })
      }

      case "tool_call_field_end": {
        const acc = accumulators.get(event.toolCallId)
        if (!acc) return Effect.void

        const field = event.path[0] ?? ""

        return emit({
          _tag: "ToolInputFieldComplete",
          toolCallId: event.toolCallId,
          field,
          path: event.path,
          value: event.value,
        })
      }

      case "tool_call_ready": {
        const acc = accumulators.get(event.toolCallId)
        if (!acc) return Effect.void

        const parser = config.parsers.get(event.toolCallId)
        if (!parser || parser.decoded === null) {
          terminalOverride = { _tag: "EngineDefect", message: `No decoded input for ${event.toolCallId}` }
          return Effect.void
        }

        return Effect.gen(function* () {
          yield* emit({
            _tag: "ToolInputReady",
            toolCallId: acc.toolCallId,
          })

          // Execute tool inline — sequential ordering required for dependent tools
          yield* executeTool(acc.toolCallId, acc.toolName, acc.toolKey, parser.decoded!)
        })
      }

      case "stream_end": {
        return Effect.gen(function* () {
          let outcome: TurnOutcome | undefined

          switch (event.reason._tag) {
            case "completed": {
              outcome = terminalOverride ?? mapFinishReasonToOutcome(event.reason.finishReason, toolCallCount)
              break
            }
            case "validation_failure": {
              const acc = accumulators.get(event.reason.toolCallId)!
              const toolEntry = toolKeyToEntry.get(acc.toolKey)!
              const parser = config.parsers.get(event.reason.toolCallId)
              const inputSchema = toolEntry.tool.definition.inputSchema
              const receivedInput = parser?.partial ?? ({} as StreamingPartial<Record<string, unknown>>)

              yield* emit({
                _tag: "ToolInputDecodeFailed",
                toolCallId: event.reason.toolCallId,
                toolName: acc.toolName,
                toolKey: acc.toolKey,
                issue: event.reason.issue,
                inputSchema,
                receivedInput,
              })

              // Format the decode failure as a tool result so it appears in the prompt
              const decodeFailureParts = config.hooks?.formatDecodeFailure
                ? config.hooks.formatDecodeFailure(acc.toolName, event.reason.issue, inputSchema, receivedInput)
                : formatDecodeFailure(acc.toolName, event.reason.issue, inputSchema, receivedInput)
              yield* emit({
                _tag: "ToolResultFormatted",
                toolCallId: event.reason.toolCallId,
                toolName: acc.toolName,
                toolKey: acc.toolKey,
                parts: decodeFailureParts,
              })

              yield* interruptAllTools()
              outcome = {
                _tag: "ToolInputDecodeFailure",
                toolCallId: event.reason.toolCallId,
                toolName: event.reason.toolName,
                issue: event.reason.issue,
                inputSchema,
                receivedInput,
              }
              break
            }
            case "error": {
              yield* interruptAllTools()
              outcome = config.mapStreamError(event.reason.error)
              break
            }
          }

          yield* emit({
            _tag: "TurnEnd",
            outcome: outcome!,
            usage: event.usage ?? null,
          })
        })
      }

      default: {
        const _exhaustive: never = event
        return _exhaustive
      }
    }
  }

  // ── Main processing with error/interrupt handling ────────────────

  function interruptAllTools(): Effect.Effect<void> {
    // With inline execution, no detached tool fibers exist to interrupt.
    // Stream errors/validation failures can only occur between tool executions.
    return Effect.void
  }

  return Stream.runForEach(config.events, processEvent).pipe(
    Effect.catchAllCause(() =>
      Effect.gen(function* () {
        yield* interruptAllTools()
        yield* emit({ _tag: "TurnEnd", outcome: { _tag: "Interrupted" }, usage: null })
      }),
    ),
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function mapFinishReasonToOutcome(reason: FinishReason, toolCallCount: number): TurnOutcome {
  switch (reason) {
    case "stop":
    case "end_turn":
    case "tool_calls":
      return { _tag: "Completed", toolCallsCount: toolCallCount }
    case "length":
      return { _tag: "OutputTruncated" }
    case "content_filter":
      return { _tag: "ContentFiltered" }
    case "unknown":
    default:
      return { _tag: "Completed", toolCallsCount: toolCallCount }
  }
}
