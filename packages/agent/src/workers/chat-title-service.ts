/**
 * Chat Title Service — AI-generated session titles from first user message.
 *
 * Follows the ImageDescriptionServiceLive architecture pattern:
 * - Layer.scoped service with Context.Tag
 * - Exposes a `generate` method for on-demand title generation
 * - Called by the ChatTitleWorker (thin signal listener) on first user message
 *
 * Fire-and-forget: the title is generated asynchronously and updates
 * session metadata when ready.
 */

import { Cause, Context, Duration, Effect, Layer, Stream } from 'effect'
import * as HttpClient from '@effect/platform/HttpClient'
import { Prompt } from '@magnitudedev/ai'
import type { TextPart, UserPart } from '@magnitudedev/ai'
import { logger } from '@magnitudedev/logger'
import { AgentModelResolver } from '../model/model-resolver'
import { connectionRetrySchedule } from '../util/retry-backoff'
import { isRetryableConnectionError } from '../errors'
import { CHAT_TITLE_PROMPT } from '../util/title-prompts'

// =============================================================================
// Types
// =============================================================================

export interface ChatTitleService {
  /**
   * Generate a title from the user's first message.
   * Returns the generated title string, or null on failure/timeout.
   * Pure library — no side effects (no persistence, no trace updates).
   */
  readonly generate: (userMessage: string) => Effect.Effect<string | null, never, never>
}

export class ChatTitleServiceTag extends Context.Tag('ChatTitleService')<
  ChatTitleServiceTag,
  ChatTitleService
>() {}

// =============================================================================
// Helpers
// =============================================================================

function extractTextFromParts(parts: readonly UserPart[]): string {
  return parts
    .filter((p): p is TextPart => p._tag === 'TextPart')
    .map((p) => p.text)
    .join(' ')
}

// Re-export for worker convenience
export { extractTextFromParts }

// =============================================================================
// Live Layer
// =============================================================================

export const ChatTitleServiceLive = Layer.scoped(
  ChatTitleServiceTag,
  Effect.gen(function* () {
    const modelResolver = yield* AgentModelResolver
    const httpClient = yield* HttpClient.HttpClient

    const generate = (userMessage: string): Effect.Effect<string | null, never, never> =>
      Effect.gen(function* () {
        logger.info('[chat-title-service] generate() called')

        logger.info('[chat-title-service] Resolving title model...')
        const titleModel = yield* modelResolver.resolveTitle().pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        )
        logger.info({ modelId: titleModel.modelId, modelSource: titleModel.modelSource }, '[chat-title-service] Title model resolved')

        const prompt = Prompt.from({
          messages: [
            {
              _tag: 'UserMessage' as const,
              parts: [
                {
                  _tag: 'TextPart' as const,
                  text: `${CHAT_TITLE_PROMPT}\n\nUser message: "${userMessage.slice(0, 500)}"`,
                },
              ],
            },
          ],
        })

        logger.info('[chat-title-service] Starting model stream call...')
        const streamResult = yield* Effect.gen(function* () {
          const result = yield* titleModel.model.stream(prompt, [], { maxTokens: 50 }).pipe(
            Effect.tap(() => Effect.sync(() => logger.info('[chat-title-service] Stream started'))),
            Effect.tapError((e) => Effect.sync(() => logger.error({ error: String(e) }, '[chat-title-service] Stream error before timeout'))),
          )
          logger.info('[chat-title-service] Stream call returned successfully')
          return result
        }).pipe(
          Effect.timeoutTo({
            duration: Duration.seconds(10),
            onSuccess: (result) => result,
            onTimeout: () => {
              logger.info('[chat-title-service] Stream call timed out after 10s')
              return null
            },
          }),
          Effect.retry({
            schedule: connectionRetrySchedule,
            while: isRetryableConnectionError,
          }),
          Effect.catchAll((e) => Effect.sync(() => {
            logger.error({ error: String(e) }, '[chat-title-service] Caught error in stream pipeline')
            return null
          })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        )

        if (!streamResult) {
          logger.info('[chat-title-service] Title generation timed out or failed, keeping default')
          return null
        }

        const text = yield* Stream.runFold(streamResult.events, '', (acc, event) =>
          event._tag === 'message_delta' ? acc + event.text : acc,
        )

        const title = text.trim().slice(0, 50)
        if (!title) {
          logger.info('[chat-title-service] Title generation returned empty, keeping default')
          return null
        }

        logger.info({ title }, '[chat-title-service] Generated chat title')
        return title
      }).pipe(
        Effect.catchAllCause((cause) => {
          if (Cause.isInterruptedOnly(cause)) return Effect.succeed(null)
          logger.error({ cause: Cause.pretty(cause) }, '[chat-title-service] Failed to generate title')
          return Effect.succeed(null)
        }),
      )

    return { generate }
  }),
)
