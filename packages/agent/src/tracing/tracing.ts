import { Layer } from 'effect'
import { TraceListener, type ModelCallTrace } from '@magnitudedev/ai'
import type { AgentCallTrace } from '@magnitudedev/tracing'
import { writeTrace } from '@magnitudedev/tracing'

/**
 * Agent trace context — metadata added to every ModelCallTrace.
 */
export interface AgentTraceContext {
  readonly sessionId: string
  readonly agentId: string
  readonly forkId: string | null
  readonly callType: AgentCallTrace["callType"]
}

/**
 * Create a TraceListener layer that converts ModelCallTrace to AgentCallTrace
 * and persists it to disk via writeTrace.
 */
export function createTraceListenerLayer(context: AgentTraceContext): Layer.Layer<TraceListener> {
  return Layer.succeed(TraceListener, {
    onTrace: (trace: ModelCallTrace) => {
      const agentTrace: AgentCallTrace = {
        ...trace,
        sessionId: context.sessionId,
        agentId: context.agentId,
        forkId: context.forkId,
        callType: context.callType,
      }
      writeTrace(agentTrace)
    },
  })
}

/**
 * Create a no-op layer when tracing is disabled.
 * TraceListener uses Effect.serviceOption so this isn't strictly needed,
 * but useful for explicit opt-out in tests.
 */
export function makeNoopTraceListener(): Layer.Layer<TraceListener> {
  return Layer.succeed(TraceListener, {
    onTrace: () => {},
  })
}

/**
 * Test helper — captures traces for assertions.
 */
export interface TraceStore {
  readonly traces: AgentCallTrace[]
}

export function makeTestTraceListener(context: AgentTraceContext): {
  layer: Layer.Layer<TraceListener>
  store: TraceStore
} {
  const store: TraceStore = { traces: [] }
  const layer = Layer.succeed(TraceListener, {
    onTrace: (trace: ModelCallTrace) => {
      const agentTrace: AgentCallTrace = {
        ...trace,
        sessionId: context.sessionId,
        agentId: context.agentId,
        forkId: context.forkId,
        callType: context.callType,
      }
      store.traces.push(agentTrace)
    },
  })
  return { layer, store }
}
