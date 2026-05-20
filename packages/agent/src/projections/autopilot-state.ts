import { Projection, Signal } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'
import { UserMessageResolutionProjection } from './user-message-resolution'
import { InitialTaskAmbient } from '../ambient/initial-task-ambient'

export interface AutopilotState {
  readonly enabled: boolean
  readonly pendingContent: string | null
  readonly generating: boolean
}

export const AutopilotStateProjection = Projection.define<AppEvent, AutopilotState>()({
  name: 'AutopilotState',

  reads: [UserMessageResolutionProjection] as const,

  ambients: [InitialTaskAmbient] as const,

  initial: {
    enabled: false,
    pendingContent: null,
    generating: false,
  },

  signals: {
    autopilotStateChanged: Signal.create<{
      enabled: boolean
      pendingContent: string | null
      generating: boolean
    }>('AutopilotState/changed'),
  },

  eventHandlers: {
    autopilot_toggled: ({ event, state, emit }) => {
      const next = { ...state, enabled: event.enabled, generating: false }
      emit.autopilotStateChanged({
        enabled: next.enabled,
        pendingContent: next.pendingContent,
        generating: next.generating,
      })
      return next
    },

    autopilot_generation_started: ({ event, state, emit }) => {
      const next = { ...state, generating: true }
      emit.autopilotStateChanged({
        enabled: next.enabled,
        pendingContent: next.pendingContent,
        generating: next.generating,
      })
      return next
    },

    autopilot_outcome: ({ event, state, emit }) => {
      if (event.result._tag === 'success') {
        const next = { ...state, pendingContent: event.result.content, generating: false }
        emit.autopilotStateChanged({
          enabled: next.enabled,
          pendingContent: next.pendingContent,
          generating: next.generating,
        })
        return next
      }
      // error
      const next = { ...state, generating: false }
      emit.autopilotStateChanged({
        enabled: next.enabled,
        pendingContent: next.pendingContent,
        generating: next.generating,
      })
      return next
    },
  },

  signalHandlers: (on) => [
    on(UserMessageResolutionProjection.signals.userMessageResolved, ({ value, state, emit }) => {
      // When a user message is resolved (same timing as TurnProjection's trigger),
      // the context has changed — clear the preview.
      if (state.pendingContent !== null) {
        const next = { ...state, pendingContent: null, generating: false }
        emit.autopilotStateChanged({
          enabled: next.enabled,
          pendingContent: next.pendingContent,
          generating: next.generating,
        })
        return next
      }
      return state
    }),
  ],
})
