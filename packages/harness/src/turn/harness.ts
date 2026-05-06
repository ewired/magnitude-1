import { Effect, Stream, Layer, Ref, Queue } from "effect"
import type * as HttpClient from "@effect/platform/HttpClient"
import type {
  BoundModel,
  ConnectionError,
  StreamError,
  ToolDefinition,
  Prompt,
} from "@magnitudedev/ai"
import type { TurnOutcome } from "../events"
import type { HarnessEvent } from "../events"
import type { HarnessHooks } from "../hooks"
import type { Toolkit, ToolkitRequirements } from "../tool/toolkit"
import type { HarnessToolErased } from "../tool/tool"
import { dispatch } from "./dispatcher"
import {
  createTurnReducer,
  type TurnState,
  type EngineState,
} from "./reducers"

// ── Config ───────────────────────────────────────────────────────────

export interface HarnessConfig<
  TToolkit extends Toolkit<any> = Toolkit<any>,
  RHooks = never,
  TInitialError = ConnectionError,
  TStreamError = StreamError,
> {
  readonly model: BoundModel<any, TInitialError, TStreamError>
  readonly toolkit: TToolkit
  readonly hooks?: HarnessHooks<RHooks>
  readonly layer?: Layer.Layer<ToolkitRequirements<TToolkit> | RHooks>
  readonly initialState?: EngineState
  readonly mapStreamError: (error: TStreamError) => TurnOutcome
}

// ── Harness ──────────────────────────────────────────────────────────

export interface Harness<TInitialError = ConnectionError> {
  /** Stream a model response, dispatch tool calls, and produce events.
   *  Returns a LiveTurn whose events stream is driven by the harness —
   *  the consumer reads events, reducers update refs automatically. */
  readonly runTurn: (
    prompt: Prompt,
  ) => Effect.Effect<
    LiveTurn,
    TInitialError,
    HttpClient.HttpClient
  >
  /** Create an empty turn for replaying a recorded event sequence.
   *  The consumer drives the turn by calling `feed` with each event. */
  readonly createReplayTurn: () => Effect.Effect<ReplayTurn>
  /** Tool definitions derived from the toolkit, for prompt assembly. */
  readonly getToolDefinitions: () => readonly ToolDefinition[]
}

/** A turn driven by the harness — events flow from the model stream
 *  through the dispatch pipeline. Consume `events` to observe progress;
 *  the state ref is updated automatically before each event is emitted. */
export interface LiveTurn {
  /** Stream of harness events, ending with TurnEnd. */
  readonly events: Stream.Stream<HarnessEvent>
  /** Unified turn state — canonical message, engine bookkeeping, tool handles.
   *  Updated after each event. Access sub-state via `.canonical`, `.engine`, `.handles`. */
  readonly state: Ref.Ref<TurnState>
}

/** A turn driven by the consumer — call `feed` with recorded events
 *  to reconstruct state without running the model. Same reducer,
 *  same ref, same final state as a LiveTurn that saw the same events. */
export interface ReplayTurn {
  /** Feed a single event through the unified reducer and hooks. */
  readonly feed: (event: HarnessEvent) => Effect.Effect<void>
  /** Unified turn state — canonical message, engine bookkeeping, tool handles.
   *  Updated after each feed. Access sub-state via `.canonical`, `.engine`, `.handles`. */
  readonly state: Ref.Ref<TurnState>
}

// ── createHarness ────────────────────────────────────────────────────

export function createHarness<
  TToolkit extends Toolkit<any>,
  RHooks = never,
  TInitialError = ConnectionError,
  TStreamError = StreamError,
>(config: HarnessConfig<TToolkit, RHooks, TInitialError, TStreamError>): Harness<TInitialError> {
  const { toolkit, hooks, model } = config

  // Build tool definitions array from toolkit
  const toolDefs: ToolDefinition[] = []
  for (const key of toolkit.keys) {
    const entry = toolkit.entries[key]
    const tool = entry.tool as HarnessToolErased
    toolDefs.push(tool.definition)
  }

  const turnReducer = createTurnReducer(toolkit)

  // ── Shared ref creation ──────────────────────────────────────────

  function makeStateRef(initialOverride?: { engine?: EngineState }) {
    const initial = initialOverride?.engine
      ? { ...turnReducer.initial, engine: initialOverride.engine }
      : turnReducer.initial
    return Ref.make(initial)
  }

  // ── Shared event feeding (reducer + optional hooks + optional queue) ──

  function makeFeedEvent(
    stateRef: Ref.Ref<TurnState>,
    eventQueue?: Queue.Queue<HarnessEvent>,
  ): (event: HarnessEvent) => Effect.Effect<void> {
    return (event: HarnessEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Step 1: Update unified reducer
        yield* Ref.update(stateRef, (s) => turnReducer.step(s, event))

        // Step 2: onEvent hook — erased boundary, type coverage enforced by createHarness.
        if (hooks?.onEvent) {
          const onEventEffect = hooks.onEvent(event) as Effect.Effect<void, never, unknown>
          if (config.layer) {
            yield* (Effect.provide(onEventEffect, config.layer as Layer.Layer<unknown>) as Effect.Effect<void>)
          } else {
            yield* (onEventEffect as Effect.Effect<void>)
          }
        }

        // Step 3: Enqueue for stream consumers (live turns only)
        if (eventQueue) {
          yield* Queue.offer(eventQueue, event)
        }
      })
  }

  // ── createReplayTurn ─────────────────────────────────────────────

  function createReplayTurn(): Effect.Effect<ReplayTurn> {
    return Effect.gen(function* () {
      const stateRef = yield* makeStateRef()
      const feed = makeFeedEvent(stateRef)
      return { feed, state: stateRef }
    })
  }

  // ── runTurn ──────────────────────────────────────────────────────

  function runTurn(
    prompt: Prompt,
  ): Effect.Effect<
    LiveTurn,
    TInitialError,
    HttpClient.HttpClient
  > {
    return Effect.gen(function* () {
      // Get the model stream + parsers (may fail with ConnectionError)
      const { events: modelEvents, parsers } = yield* model.stream(prompt, toolDefs)

      const stateRef = yield* makeStateRef(
        config.initialState ? { engine: config.initialState } : undefined,
      )
      const eventQueue = yield* Queue.unbounded<HarnessEvent>()
      const emitEvent = makeFeedEvent(stateRef, eventQueue)

      // Build dispatch — delegates all event processing and tool execution
      const processing = dispatch({
        events: modelEvents,
        parsers,
        toolkit,
        hooks: hooks as HarnessHooks<unknown> | undefined,
        layer: config.layer as Layer.Layer<unknown> | undefined,
        initialEngineState: config.initialState,
        emit: emitEvent,
        mapStreamError: config.mapStreamError as (error: unknown) => TurnOutcome,
      })

      // Fork the dispatch processing and ensure queue shutdown on completion
      yield* Effect.fork(
        processing.pipe(
          Effect.ensuring(Queue.shutdown(eventQueue)),
        ),
      )

      // Build event stream from queue, ending at TurnEnd
      const eventStream: Stream.Stream<HarnessEvent> = Stream.fromQueue(eventQueue).pipe(
        Stream.takeUntil((event) => event._tag === "TurnEnd"),
      )

      return {
        events: eventStream,
        state: stateRef,
      }
    })
  }

  return {
    runTurn,
    createReplayTurn,
    getToolDefinitions: () => toolDefs,
  }
}
