/**
 * AUTO-GENERATED — do not edit manually.
 */

import type { RoleId } from "./roles"

export type EffortLevel = "low" | "medium" | "high" | "max"

export type ReasoningConfig =
  | { type: "off" }
  | { type: "on"; budget?: number }
  | { type: "auto"; budget?: number }
  | { type: "effort"; level: EffortLevel }

export type ReasoningCapability =
  | { readonly type: "none" }
  | { readonly type: "always"; readonly effort: readonly EffortLevel[] }
  | { readonly type: "toggleable"; readonly default: "on" | "off"; readonly effort: readonly EffortLevel[]; readonly budget: boolean }

export interface ModelCapabilities {
  readonly vision: boolean
  readonly grammar: boolean
  readonly reasoning: ReasoningCapability
}

export interface MagnitudeModelInfo {
  readonly id: string
  readonly displayName: string
  readonly object: "model"
  readonly owned_by: string
  readonly roles: readonly RoleId[]
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly capabilities: ModelCapabilities
  /** Optional type field distinguishing utility endpoints from regular models */
  readonly type?: "utility"
}

export interface ModelListResponse {
  readonly object: "list"
  readonly data: readonly MagnitudeModelInfo[]
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | NamedFunctionToolChoice
  | AllowedToolsToolChoice

export type NamedFunctionToolChoice = {
  type: "function"
  function: { name: string }
}

export type AllowedToolsToolChoice = {
  type: "allowed_tools"
  allowed_tools: {
    mode: "auto" | "required"
    tools: Array<{ type: "function"; function: { name: string } }>
  }
}

export type TurnConstraintMessage = "force" | "allow" | "forbid"

export type TurnConstraints = {
  message?: TurnConstraintMessage
}

export type MagnitudeAdditionalOptions = {
  /** Override the default trait labels used in grammar-constrained reasoning. */
  traits?: string[]
  /** Controls whether message/prose content is required, optional, or forbidden. */
  turn_constraints?: TurnConstraints
}
