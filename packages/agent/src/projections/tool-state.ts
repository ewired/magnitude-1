/**
 * ToolStateProjection (Forked)
 *
 * Canonical owner of per-tool-call lifecycle state and model-backed parsed tool state.
 * This projection is intentionally display-agnostic: it tracks all tool calls,
 * including hidden tools, and exposes canonical handles keyed by tool call id.
 */

import { Projection } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'
import type { ToolHandle } from '@magnitudedev/harness'
import { ToolkitAmbient } from '../ambient/toolkit-ambient'
import { createToolHandleFromToolkit } from '../tools/tool-handle'

export interface ToolStateProjectionState {
  readonly toolHandles: { readonly [callId: string]: ToolHandle }
}

export const ToolStateProjection = Projection.defineForked<AppEvent, ToolStateProjectionState>()({
  name: 'ToolState',

  ambients: [ToolkitAmbient],

  initialFork: {
    toolHandles: {},
  },

  eventHandlers: {
    tool_event: ({ event, fork, ambient }) => {
      const inner = event.event
      const toolkit = ambient.get(ToolkitAmbient)

      if (inner._tag === 'ToolInputStarted') {
        const handle = createToolHandleFromToolkit(inner.toolCallId, event.toolKey, toolkit)
        if (!handle) return fork
        const nextHandle = handle.process(inner)
        return {
          ...fork,
          toolHandles: {
            ...fork.toolHandles,
            [event.toolCallId]: nextHandle,
          },
        }
      }

      const handle = fork.toolHandles[event.toolCallId]
      if (!handle) return fork

      const nextHandle = handle.process(inner)
      return {
        ...fork,
        toolHandles: {
          ...fork.toolHandles,
          [event.toolCallId]: nextHandle,
        },
      }
    },

    turn_outcome: ({ fork }) => {
      // Decode failures are now handled via ToolInputDecodeFailed lifecycle event
      // which flows through tool_event → handle.process() naturally
      return fork
    },

    interrupt: ({ fork }) => {
      const nextToolHandles = Object.fromEntries(
        Object.entries(fork.toolHandles).map(([toolCallId, handle]) => [
          toolCallId,
          handle.interrupt(),
        ])
      )

      return {
        ...fork,
        toolHandles: nextToolHandles,
      }
    },
  },
})
