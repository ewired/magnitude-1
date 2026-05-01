import type { Schema } from "effect"

/**
 * Erased form — for acceptance in collections and function signatures.
 */
export interface ToolDefinitionErased {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema.Schema.Any
  readonly outputSchema: Schema.Schema.Any
}

/**
 * Concrete form — full type safety for input/output schemas.
 */
export interface ToolDefinitionConcrete<
  TInput,
  TOutput,
> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema.Schema<TInput, TInput, never>
  readonly outputSchema: Schema.Schema<TOutput, TOutput, never>
}

/**
 * Never-switched: bare `ToolDefinition` resolves to erased form,
 * `ToolDefinition<I, O>` resolves to concrete form.
 */
export type ToolDefinition<
  TInput = never,
  TOutput = never,
> = [TInput] extends [never]
  ? ToolDefinitionErased
  : ToolDefinitionConcrete<TInput, TOutput>

export function defineTool<
  TInput,
  TOutput,
>(
  definition: ToolDefinitionConcrete<TInput, TOutput>,
): ToolDefinitionConcrete<TInput, TOutput> {
  return definition
}
