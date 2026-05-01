import type { ToolDefinition } from "@magnitudedev/ai"
import type { Schema } from "effect"
import type { Effect } from "effect"
import type { StreamingPartial } from "@magnitudedev/ai"

// --- ToolContext ---

export interface ToolContext<TEmission = never> {
  readonly emit: [TEmission] extends [never]
    ? never
    : (emission: TEmission) => Effect.Effect<void>
}

// --- StreamHook ---

export interface StreamHook<TInput, TEmission, TStreamState, E = never, R = never> {
  readonly initial: TStreamState
  readonly onInput: (
    input: StreamingPartial<TInput>,
    state: TStreamState,
    ctx: ToolContext<TEmission>
  ) => Effect.Effect<TStreamState, E, R>
}

// --- HarnessTool (split into erased and concrete) ---

export interface HarnessToolErased {
  readonly definition: ToolDefinition
  readonly execute: (input: any, ctx: any) => Effect.Effect<any, any, any>
  readonly stream?: StreamHook<any, any, any, any, any>
  readonly emissionSchema?: Schema.Schema<any, any, any> | undefined
  readonly errorSchema?: Schema.Schema<any, any, any> | undefined
}

export interface HarnessToolConcrete<
  TInput,
  TOutput,
  TEmission,
  E,
  R,
> {
  readonly definition: ToolDefinition<TInput, TOutput>
  readonly execute: (input: TInput, ctx: ToolContext<TEmission>) => Effect.Effect<TOutput, E, R>
  readonly stream?: StreamHook<TInput, TEmission, unknown, E, R>
  readonly emissionSchema?: [TEmission] extends [never] ? undefined : Schema.Schema<TEmission, any, never>
  readonly errorSchema?: [E] extends [never] ? undefined : Schema.Schema<E, any, never>
}

export type HarnessTool<
  TInput = never,
  TOutput = never,
  TEmission = never,
  E = never,
  R = never,
> = [TInput] extends [never]
  ? HarnessToolErased
  : HarnessToolConcrete<TInput, TOutput, TEmission, E, R>

// Note: HarnessToolConcrete is NOT structurally assignable to HarnessToolErased due to
// function parameter contravariance (ToolContext<TEmission> vs unknown for ctx).
// The erased form is only constructed via defineHarnessTool, which handles the boundary.

// --- defineHarnessTool ---

interface DefineHarnessToolConfig<TInput, TOutput, TEmission, E, R> {
  readonly definition: ToolDefinition<TInput, TOutput>
  readonly execute: (input: TInput, ctx: ToolContext<TEmission>) => Effect.Effect<TOutput, E, R>
  readonly stream?: StreamHook<TInput, TEmission, unknown, E, R>
  readonly emissionSchema?: [TEmission] extends [never] ? undefined : Schema.Schema<TEmission, any, never>
  readonly errorSchema?: [E] extends [never] ? undefined : Schema.Schema<E, any, never>
}

export function defineHarnessTool<
  TInput,
  TOutput,
  TEmission = never,
  E = never,
  R = never,
>(
  config: DefineHarnessToolConfig<TInput, TOutput, TEmission, E, R>
): HarnessToolConcrete<TInput, TOutput, TEmission, E, R> {
  return {
    definition: config.definition,
    execute: config.execute,
    stream: config.stream,
    emissionSchema: config.emissionSchema,
    errorSchema: config.errorSchema,
  }
}
