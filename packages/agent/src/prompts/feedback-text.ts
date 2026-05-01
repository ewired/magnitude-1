import type { TurnFeedback } from '../inbox/types'

/**
 * Render TurnFeedback items to plain text.
 * Shared between window-to-prompt (for UserMessage parts) and compaction (for token estimation).
 */
export function renderFeedbackText(feedback: readonly TurnFeedback[]): string {
  const lines: string[] = []
  for (const fb of feedback) {
    switch (fb.kind) {
      case 'message_ack':
        lines.push(`<message-sent to="${fb.destination}" chars="${fb.chars}"/>`)
        break
      case 'no_tools_or_messages':
        lines.push('You did not use any tools or send any messages. Please take action.')
        break
      case 'error':
        lines.push(`<error>${fb.message}</error>`)
        break
      case 'interrupted':
        lines.push('Turn was interrupted.')
        break
      case 'yield_worker_retrigger':
        lines.push('Error: yield was re-triggered. Use <end-turn> with <idle/> to properly yield.')
        break
    }
  }
  return lines.join('\n')
}
