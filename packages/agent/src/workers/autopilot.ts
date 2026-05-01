/**
 * Autopilot Worker
 *
 * When the agent completes a turn and autopilot is enabled, generates a continuation
 * message using a perspective-flipped LLM call. The generated message is
 * published as an `autopilot_message_generated` event for the CLI to
 * preview and send after a countdown.
 */

import { Worker } from '@magnitudedev/event-core'
import type { AppEvent } from '../events'

// =============================================================================
// Worker
// =============================================================================

export const Autopilot = Worker.define<AppEvent>()({
  name: 'Autopilot',

  signalHandlers: () => []
})
