// TODO: rewrite mock-cortex for harness paradigm
// This file previously used createTurnStream, drainTurnEventStream, and ExecutionManager.execute()
// which have all been removed. Needs full rewrite to use createHarness + runTurn.

import { Effect, Stream } from 'effect'
import { Worker } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'

export const MockCortex = Worker.defineForked<AppEvent>()({
  name: 'MockCortex',

  forkLifecycle: {
    activateOn: 'agent_created',
  },

  eventHandlers: {
    turn_started: (_event, _publish) => {
      return Effect.die(new Error('MockCortex not yet rewritten for harness paradigm'))
    }
  }
})
