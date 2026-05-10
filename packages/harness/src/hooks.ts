import type { Effect, Schema } from "effect"
import type { ToolCallId } from "@magnitudedev/ai"
import type { HarnessEvent, ToolResult } from "./events"

export interface ExecuteHookContext {
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly toolKey: string
  readonly input: unknown
}

export type InterceptorDecision =
  | { readonly _tag: "Proceed"; readonly modifiedInput?: unknown }
  | { readonly _tag: "Reject"; readonly rejection: unknown }

export interface HarnessHooks<R = never> {
  readonly beforeExecute?: (ctx: ExecuteHookContext) => Effect.Effect<InterceptorDecision, never, R>
  readonly afterExecute?: (ctx: ExecuteHookContext & { readonly result: ToolResult }) => Effect.Effect<void, never, R>
  readonly onEvent?: (event: HarnessEvent) => Effect.Effect<void, never, R>
  readonly onEmission?: (ctx: {
    readonly toolCallId: ToolCallId
    readonly toolName: string
    readonly toolKey: string
    readonly value: unknown
  }) => Effect.Effect<void, never, R>
}
