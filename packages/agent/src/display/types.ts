/**
 * Display Types
 *
 * All type/interface definitions for the display projection.
 */

import type { ToolKey } from '../tools/toolkits'
import type { ErrorCta } from '../errors'
import type { PendingInboundCommunication } from '../projections/turn'
import type { ToolState } from '../models/index'
import type { ToolDisplay } from '../events'

export interface UserMessageDisplay {
  readonly id: string
  readonly type: 'user_message'
  readonly content: string
  readonly timestamp: number
  readonly taskMode: boolean
  readonly attachments: readonly { readonly type: 'image'; readonly width: number; readonly height: number; readonly filename: string }[]
}

export interface QueuedUserMessageDisplay {
  readonly id: string
  readonly type: 'queued_user_message'
  readonly content: string
  readonly timestamp: number
  readonly taskMode: boolean
  readonly attachments: readonly { readonly type: 'image'; readonly width: number; readonly height: number; readonly filename: string }[]
}

export interface AssistantMessageDisplay {
  readonly id: string
  readonly type: 'assistant_message'
  readonly content: string
  readonly timestamp: number
}

export interface ThinkingStep {
  readonly id: string
  readonly type: 'thinking'
  readonly content: string
  readonly label?: string
}

export interface ToolStep {
  readonly id: string
  readonly type: 'tool'
  readonly toolKey: ToolKey
  readonly cluster?: string
  readonly state?: ToolState
  readonly filter?: string | null  // Filter query that was applied
  readonly resultFilePath?: string | null  // Path to full result file for retroactive disclosure
}

export interface CommunicationStep {
  readonly id: string
  readonly type: 'communication'
  readonly streamId?: string
  readonly direction: 'to_agent' | 'from_agent'
  readonly agentId: string
  readonly agentName?: string
  readonly agentRole?: string
  readonly forkId: string | null
  readonly content: string
  readonly preview: string
  readonly timestamp: number
  readonly status?: 'streaming' | 'completed'
}

export interface StatusIndicatorStep {
  readonly id: string
  readonly type: 'status_indicator'
  readonly message: string
  readonly style: 'dim'
}

export interface SubagentStartedStep {
  readonly id: string
  readonly type: 'subagent_started'
  readonly subagentType: string
  readonly subagentId: string
  readonly title: string
  readonly resumed: boolean
}

export interface SubagentFinishedStep {
  readonly id: string
  readonly type: 'subagent_finished'
  readonly subagentType: string
  readonly subagentId: string
  readonly cumulativeTotalTimeMs: number
  readonly cumulativeTotalToolsUsed: number
  readonly resumed: boolean
}

export interface SubagentKilledStep {
  readonly id: string
  readonly type: 'subagent_killed'
  readonly subagentType: string
  readonly subagentId: string
  readonly title: string
}

export interface SubagentUserKilledStep {
  readonly id: string
  readonly type: 'subagent_user_killed'
  readonly subagentType: string
  readonly subagentId: string
  readonly title: string
}

export type ThinkBlockStep =
  | ThinkingStep
  | ToolStep
  | CommunicationStep
  | StatusIndicatorStep
  | SubagentStartedStep
  | SubagentFinishedStep
  | SubagentKilledStep
  | SubagentUserKilledStep

export interface ThinkBlockMessage {
  readonly id: string
  readonly type: 'think_block'
  readonly status: 'active' | 'completed'
  readonly steps: readonly ThinkBlockStep[]
  readonly timestamp: number
  readonly completedAt?: number
}

export interface InterruptedMessage {
  readonly id: string
  readonly type: 'interrupted'
  readonly timestamp: number
  readonly context: 'root' | 'fork'
  readonly allKilled?: boolean
}

export interface ErrorDisplayMessage {
  readonly id: string
  readonly type: 'error'
  readonly message: string
  readonly timestamp: number
  readonly cta?: ErrorCta
}

export interface ForkResultMessage {
  readonly id: string
  readonly type: 'fork_result'
  readonly forkId: string
  readonly task: string
  readonly result: unknown
  readonly timestamp: number
}

export interface ForkActivityToolCounts {
  readonly commands: number
  readonly reads: number
  readonly writes: number
  readonly edits: number
  readonly searches: number
  readonly webSearches: number
  readonly webFetches: number
  readonly artifactWrites: number
  readonly artifactUpdates: number
  readonly other: number
}

export interface ForkActivityMessage {
  readonly id: string
  readonly type: 'fork_activity'
  readonly forkId: string
  readonly name: string
  readonly role: string
  readonly status: 'running' | 'completed'
  readonly createdAt: number
  readonly activeSince: number
  readonly accumulatedActiveMs: number
  readonly completedAt?: number
  readonly resumeCount?: number
  readonly toolCounts: ForkActivityToolCounts
  readonly timestamp: number
}

export interface AgentCommunicationMessage {
  readonly id: string
  readonly type: 'agent_communication'
  readonly streamId?: string
  readonly direction: 'to_agent' | 'from_agent'
  readonly agentId: string
  readonly agentName?: string
  readonly agentRole?: string
  readonly forkId: string | null
  readonly content: string
  readonly preview: string
  readonly timestamp: number
}

export interface ApprovalRequestMessage {
  readonly id: string
  readonly type: 'approval_request'
  readonly toolCallId: string
  readonly toolKey: ToolKey
  readonly input: unknown
  readonly reason: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly timestamp: number
  readonly display?: ToolDisplay
}

export type DisplayMessage =
  | UserMessageDisplay
  | QueuedUserMessageDisplay
  | AssistantMessageDisplay
  | ThinkBlockMessage
  | InterruptedMessage
  | ErrorDisplayMessage
  | ForkResultMessage
  | ForkActivityMessage
  | AgentCommunicationMessage
  | ApprovalRequestMessage

/** Per-fork display state */
export interface PendingInboundCommunicationDisplay extends PendingInboundCommunication {}

export interface DisplayState {
  readonly status: 'idle' | 'streaming'
  readonly messages: readonly DisplayMessage[]
  readonly pendingInboundCommunications: readonly PendingInboundCommunicationDisplay[]
  readonly currentTurnId: string | null  // Tracks active turn for queuing decision
  readonly streamingMessageId: string | null  // Tracks streaming assistant message
  readonly activeThinkBlockId: string | null
  readonly showButton: 'send' | 'stop'
}
