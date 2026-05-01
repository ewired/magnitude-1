import { CHARS_PER_TOKEN_LOWER } from '../constants'
import type { UserPart } from '@magnitudedev/ai'
import type { CompletedTurn } from '../inbox/types'
import { renderFeedbackText } from '../prompts/feedback-text'

/**
 * Kimi K2.6 image token estimation.
 * Derived from MoonViT config: patch_size=14, merge_kernel_size=[2,2]
 * Source: https://huggingface.co/moonshotai/Kimi-K2.6/raw/main/config.json
 */
export const DEFAULT_IMAGE_TOKENS = 1000 // fallback when dimensions unknown

export function estimateImageTokens(width: number | null, height: number | null): number {
  if (width == null || height == null) return DEFAULT_IMAGE_TOKENS
  const mergedH = Math.ceil(Math.ceil(height / 14) / 2)
  const mergedW = Math.ceil(Math.ceil(width / 14) / 2)
  return mergedH * mergedW
}

export function estimateText(s: string | undefined): number {
  if (!s) return 0
  return Math.ceil(s.length / CHARS_PER_TOKEN_LOWER)
}

export function estimateContentTokens(content: string): number
export function estimateContentTokens(content: UserPart[]): number
export function estimateContentTokens(content: string | UserPart[]): number {
  // Note: ImagePart doesn't carry dimensions, so we always use DEFAULT_IMAGE_TOKENS.
  // If a future part type includes dimensions, use estimateImageTokens(w, h) instead.
  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN_LOWER)
  }
  let tokens = 0
  for (const part of content) {
    switch (part._tag) {
      case 'TextPart':
        tokens += Math.ceil(part.text.length / CHARS_PER_TOKEN_LOWER)
        break
      case 'ImagePart':
        tokens += part.dimensions
          ? estimateImageTokens(part.dimensions.width, part.dimensions.height)
          : DEFAULT_IMAGE_TOKENS
        break
    }
  }
  return tokens
}

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
