import type { CompletedTurn } from '../window/types'
import { renderFeedbackText } from '../prompts/feedback-text'
import { estimateText, estimateImageTokens, DEFAULT_IMAGE_TOKENS } from '../truncation/estimate'

export function estimateCompletedTurn(turn: CompletedTurn): number {
  let tokens = 0

  // Assistant reasoning + text
  tokens += estimateText(turn.assistant.reasoning)
  tokens += estimateText(turn.assistant.text)

  // Tool calls: input JSON + framing overhead
  if (turn.assistant.toolCalls) {
    for (const tc of turn.assistant.toolCalls) {
      tokens += estimateText(tc.name)
      tokens += estimateText(JSON.stringify(tc.input))
      tokens += 20 // JSON framing overhead per tool call
    }
  }

  // Tool results
  for (const result of turn.toolResults) {
    for (const part of result.parts) {
      if (part._tag === 'TextPart') {
        tokens += estimateText(part.text)
      } else if (part._tag === 'ImagePart') {
        tokens += part.dimensions
          ? estimateImageTokens(part.dimensions.width, part.dimensions.height)
          : DEFAULT_IMAGE_TOKENS
      }
    }
  }

  // Feedback
  tokens += estimateText(renderFeedbackText(turn.feedback))

  return tokens
}
