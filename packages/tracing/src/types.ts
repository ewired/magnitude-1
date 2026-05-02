import type { ModelCallTrace, AssembledToolCall, TokenLogprob } from "@magnitudedev/ai"

export type { ModelCallTrace, AssembledToolCall, TokenLogprob } from "@magnitudedev/ai"

export interface AgentCallTrace extends ModelCallTrace {
  readonly sessionId: string
  readonly agentId: string
  readonly forkId: string | null
  readonly callType: "chat" | "compact" | "autopilot" | "title" | "extract-memory-diff"
  readonly [key: string]: unknown
}

export interface TraceSessionMeta {
  sessionId: string
  created: string
  cwd: string | null
  platform: string | null
  gitBranch: string | null
  chatName?: string
  [key: string]: unknown
}
