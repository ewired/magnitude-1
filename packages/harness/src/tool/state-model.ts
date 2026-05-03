import type { ToolError, ToolLifecycleEvent } from "../events"
import type { Effect } from "effect"

// ── Phase ────────────────────────────────────────────────────────────

export type Phase = "streaming" | "executing" | "completed" | "error" | "rejected" | "interrupted"

// ── Base State ───────────────────────────────────────────────────────

export interface BaseState {
  readonly phase: Phase
  readonly errorMessage?: string | undefined
}

// ── State Model ──────────────────────────────────────────────────────

interface StateModelErased {
  readonly initial: BaseState
  readonly reduce: (state: any, event: any) => any
}

interface StateModelConcrete<
  TState extends BaseState,
  TInput,
  TOutput,
  TEmission,
  TError extends ToolError,
> {
  readonly initial: TState
  readonly reduce: (state: TState, event: ToolLifecycleEvent<TInput, TOutput, TEmission, TError>) => TState
}

export type StateModel<
  TState = never,
  TInput = never,
  TOutput = never,
  TEmission = never,
  TError extends ToolError = never,
> = [TState] extends [never]
  ? StateModelErased
  : StateModelConcrete<TState & BaseState, TInput, TOutput, TEmission, TError>

// ── Inference-only tool shape ────────────────────────────────────────

/**
 * Minimal shape used purely for generic type inference in defineStateModel.
 * Avoids coupling to the full HarnessTool type.
 */
interface ToolTypeCarrier<TInput, TOutput, TEmission, TError extends ToolError = never> {
  readonly execute: (input: TInput, ctx: any) => Effect.Effect<TOutput, any, any>
  readonly emissionSchema?: { readonly Type: TEmission }
  readonly errorSchema?: { readonly Type: TError }
}

interface ToolDefTypeCarrier<TInput, TOutput, TEmission = never, TError extends ToolError = never> {
  readonly inputSchema: { readonly Type: TInput }
  readonly outputSchema: { readonly Type: TOutput }
}

// ── defineStateModel (curried) ───────────────────────────────────────

/**
 * Curried state model definition.
 *
 * First call binds the tool (for type inference of input/output/emission/error).
 * Second call provides the state type and config.
 *
 * ```ts
 * const shellState = defineStateModel(shellTool)<ShellState>({
 *   initial: { lastExitCode: null },
 *   reduce: (state, event) => { ... }
 * })
 * ```
 */
export function defineStateModel<
  TInput,
  TOutput,
  TEmission,
  TError extends ToolError = never,
>(
  _tool: ToolTypeCarrier<TInput, TOutput, TEmission, TError>,
): <TState extends BaseState>(config: {
  readonly initial: Omit<TState, 'phase'>
  readonly reduce: (
    state: TState,
    event: ToolLifecycleEvent<TInput, TOutput, TEmission, TError>,
  ) => TState
}) => StateModel<TState, TInput, TOutput, TEmission, TError>

export function defineStateModel<
  TInput,
  TOutput,
  TEmission = never,
  TError extends ToolError = never,
>(
  _tool: ToolDefTypeCarrier<TInput, TOutput, TEmission, TError>,
): <TState extends BaseState>(config: {
  readonly initial: Omit<TState, 'phase'>
  readonly reduce: (
    state: TState,
    event: ToolLifecycleEvent<TInput, TOutput, TEmission, TError>,
  ) => TState
}) => StateModel<TState, TInput, TOutput, TEmission, TError>

export function defineStateModel<
  TInput,
  TOutput,
  TEmission,
  TError extends ToolError = never,
>(
  _tool: ToolTypeCarrier<TInput, TOutput, TEmission, TError> | ToolDefTypeCarrier<TInput, TOutput, TEmission, TError>,
): <TState extends BaseState>(config: {
  readonly initial: Omit<TState, 'phase'>
  readonly reduce: (
    state: TState,
    event: ToolLifecycleEvent<TInput, TOutput, TEmission, TError>,
  ) => TState
}) => StateModel<TState, TInput, TOutput, TEmission, TError> {
  return <TState extends BaseState>(config: {
    readonly initial: Omit<TState, 'phase'>
    readonly reduce: (
      state: TState,
      event: ToolLifecycleEvent<TInput, TOutput, TEmission, TError>,
    ) => TState
  }): StateModel<TState, TInput, TOutput, TEmission, TError> => {
    const initial = Object.freeze({
      phase: "streaming" as const,
      ...config.initial,
    }) as TState

    return { initial, reduce: config.reduce }
  }
}
