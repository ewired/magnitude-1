/**
 * Image description service — preprocesses images for non-vision models.
 *
 * When a user drops/pastes an image, `start()` tracks the image as needing
 * description and kicks off the model call eagerly. The actual replacement
 * happens before the model turn via `resolve()`, which runs in Effect context.
 *
 * Completely transparent to the user — no UI indicators needed.
 */

import { Cause, Context, Deferred, Duration, Effect, Fiber, Layer, Stream, SynchronizedRef } from 'effect'
import * as HttpClient from '@effect/platform/HttpClient'
import { Prompt, type Message, type ImagePart, type TextPart, type ImageMediaType } from '@magnitudedev/ai'
import { isRetryableConnectionError } from '../errors'
import { connectionRetrySchedule } from '../util/retry-backoff'
import { logger } from '@magnitudedev/logger'
import type { MagnitudeConnectionError } from '@magnitudedev/magnitude-client'
import { AgentModelResolver } from '../model/model-resolver'

import { IMAGE_DESCRIPTION_PROMPT } from './image-prompts'

// =============================================================================
// Constants
// =============================================================================

const DESCRIPTION_PROMPT = IMAGE_DESCRIPTION_PROMPT

const FALLBACK_DESCRIPTION = 'Image was uploaded but could not be analyzed.'
const TIMEOUT_MS = 15_000
const DESCRIPTION_MAX_TOKENS = 2048

// =============================================================================
// Types
// =============================================================================

export interface ImageDescriptionReplacement {
  readonly imageDataUrl: string
  readonly description: string
}

export interface ResolvedPrompt {
  readonly prompt: Prompt
  readonly replacements: readonly ImageDescriptionReplacement[]
}

export interface ImageDescriptionService {
  readonly start: (imageDataUrl: string) => Effect.Effect<void>
  readonly cancel: (imageDataUrl: string) => Effect.Effect<void, never, never>
  readonly resolve: (prompt: Prompt) => Effect.Effect<ResolvedPrompt>
}

export class ImageDescriptionServiceTag extends Context.Tag('ImageDescriptionService')<
  ImageDescriptionServiceTag,
  ImageDescriptionService
>() {}

// =============================================================================
// Factory
// =============================================================================

interface RegistryEntry {
  readonly deferred: Deferred.Deferred<string, never>
  readonly fiber: Fiber.RuntimeFiber<boolean, never>
}

class ImageDescriptionPhaseTimeoutError {
  readonly _tag = 'ImageDescriptionTimeoutError'
  constructor(
    readonly phase: 'resolveImage' | 'openStream' | 'collectStream',
    readonly timeoutMs: number,
  ) {}
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function refResult<A, B>(value: A, state: B): readonly [A, B] {
  return [value, state]
}

function imageDataUrlInfo(imageDataUrl: string): { mediaType: ImageMediaType; base64: string; bytes: number } | null {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const [, rawMediaType, base64] = match
  const mediaType = rawMediaType && isImageMediaType(rawMediaType) ? rawMediaType : 'image/png'
  return {
    mediaType,
    base64,
    bytes: Math.floor((base64.length * 3) / 4),
  }
}

export const ImageDescriptionServiceLive = Layer.scoped(
  ImageDescriptionServiceTag,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const modelResolver = yield* AgentModelResolver
    const httpClient = yield* HttpClient.HttpClient
    const registry = yield* SynchronizedRef.make<Map<string, RegistryEntry>>(new Map())

    function withPhaseTimeout<A, E, R>(
      phase: 'resolveImage' | 'openStream' | 'collectStream',
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | ImageDescriptionPhaseTimeoutError, R> {
      return effect.pipe(
        Effect.timeoutFail({
          duration: Duration.millis(TIMEOUT_MS),
          onTimeout: () => new ImageDescriptionPhaseTimeoutError(phase, TIMEOUT_MS),
        }),
      )
    }

    function shouldRetryImageDescriptionError(
      err: MagnitudeConnectionError | Error | ImageDescriptionPhaseTimeoutError,
    ): boolean {
      if (err instanceof Error) return false
      if (err._tag === 'ImageDescriptionTimeoutError') return false
      return isRetryableConnectionError(err)
    }

    function describe(imageDataUrl: string): Effect.Effect<string> {
      const info = imageDataUrlInfo(imageDataUrl)
      if (!info) return Effect.succeed(FALLBACK_DESCRIPTION)

      return Effect.gen(function* () {
        const startedAt = Date.now()
        logger.info({
          mediaType: info.mediaType,
          imageBytes: info.bytes,
          descriptionMaxTokens: DESCRIPTION_MAX_TOKENS,
        }, '[describe-image] Calling image description utility')
        const resolved = yield* withPhaseTimeout('resolveImage', modelResolver.resolveImage())
        logger.info({
          modelId: resolved.modelId,
          source: resolved.modelSource,
        }, '[describe-image] Resolved image description model')
        const prompt = Prompt.from({
          messages: [{
            _tag: 'UserMessage',
            parts: [
              { _tag: 'TextPart', text: DESCRIPTION_PROMPT },
              { _tag: 'ImagePart', mediaType: info.mediaType, data: info.base64 },
            ],
          }],
        })
        const streamResult = yield* withPhaseTimeout(
          'openStream',
          resolved.model.stream(prompt, [], { maxTokens: DESCRIPTION_MAX_TOKENS }),
        )
        const text = yield* withPhaseTimeout(
          'collectStream',
          Stream.runFold(streamResult.events, '', (acc, event) =>
            event._tag === 'message_delta'
              ? acc + event.text
              : acc),
        )
        logger.info({
          elapsedMs: Date.now() - startedAt,
          textLength: text.length,
        }, '[describe-image] Image description utility returned')
        return text.trim() || FALLBACK_DESCRIPTION
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.retry({
          schedule: connectionRetrySchedule,
          while: shouldRetryImageDescriptionError,
        }),
        Effect.catchAllCause((cause) => {
          if (Cause.isInterruptedOnly(cause)) return Effect.interrupt
          return Effect.sync(() => {
            logger.error({
              cause: Cause.pretty(cause),
              mediaType: info.mediaType,
              imageBytes: info.bytes,
            }, '[describe-image] Vision model call failed')
            return FALLBACK_DESCRIPTION
          })
        }),
      )
    }

    function ensureStarted(imageDataUrl: string): Effect.Effect<RegistryEntry> {
      return SynchronizedRef.modifyEffect(registry, (entries) => {
        const existing = entries.get(imageDataUrl)
        if (existing) return Effect.succeed(refResult(existing, entries))

        return Effect.gen(function* () {
          const deferred = yield* Deferred.make<string, never>()
          const fiber = yield* describe(imageDataUrl).pipe(
            Effect.intoDeferred(deferred),
            Effect.forkIn(scope),
          )
          const entry: RegistryEntry = { deferred, fiber }
          const next = new Map(entries)
          next.set(imageDataUrl, entry)
          return refResult(entry, next)
        })
      })
    }

    function resolveParts(
      parts: readonly (TextPart | ImagePart)[],
    ): Effect.Effect<{ parts: readonly (TextPart | ImagePart)[]; replacements: readonly ImageDescriptionReplacement[]; didChange: boolean }> {
      return Effect.gen(function* () {
        const imageEntries: { readonly index: number; readonly part: ImagePart }[] = []
        const descriptions: Effect.Effect<string, never, never>[] = []

        for (let i = 0; i < parts.length; i++) {
          const part = parts[i]
          if (part._tag === 'ImagePart') {
            imageEntries.push({ index: i, part })
            const imageDataUrl = `data:${part.mediaType};base64,${part.data}`
            const entry = yield* ensureStarted(imageDataUrl)
            descriptions.push(Deferred.await(entry.deferred))
          }
        }

        if (imageEntries.length === 0) {
          return { parts, replacements: [], didChange: false }
        }

        const resolved = yield* Effect.all(descriptions, { concurrency: 'unbounded' })

        const result: (TextPart | ImagePart)[] = [...parts]
        const replacements: ImageDescriptionReplacement[] = []

        for (let idx = 0; idx < imageEntries.length; idx++) {
          const { index, part } = imageEntries[idx]
          const description = resolved[idx]
          const imageDataUrl = `data:${part.mediaType};base64,${part.data}`

          replacements.push({ imageDataUrl, description })

          yield* SynchronizedRef.update(registry, (entries) => {
            const next = new Map(entries)
            next.delete(imageDataUrl)
            return next
          })

          result[index] = {
            _tag: 'TextPart',
            text: `[User uploaded an image. Description: ${description}]`,
          }
        }

        return { parts: result, replacements, didChange: true }
      })
    }

    return {
      start: (imageDataUrl: string) =>
        Effect.asVoid(ensureStarted(imageDataUrl)),

      cancel: (imageDataUrl: string) =>
        Effect.gen(function* () {
          const entries = yield* SynchronizedRef.get(registry)
          const entry = entries.get(imageDataUrl)
          if (!entry) return
          yield* SynchronizedRef.update(registry, (current) => {
            const next = new Map(current)
            next.delete(imageDataUrl)
            return next
          })
          yield* Fiber.interruptFork(entry.fiber)
        }),

      resolve: (prompt) => Effect.gen(function* () {
        let changed = false
        const allReplacements: ImageDescriptionReplacement[] = []
        const messages: Message[] = []

        for (const msg of prompt.messages) {
          switch (msg._tag) {
            case 'UserMessage': {
              const { parts, replacements, didChange } = yield* resolveParts(msg.parts)
              allReplacements.push(...replacements)
              if (didChange) {
                changed = true
                messages.push({ _tag: 'UserMessage', parts })
              } else {
                messages.push(msg)
              }
              break
            }
            case 'ToolResultMessage': {
              const { parts, replacements, didChange } = yield* resolveParts(msg.parts)
              allReplacements.push(...replacements)
              if (didChange) {
                changed = true
                messages.push({
                  _tag: 'ToolResultMessage',
                  toolCallId: msg.toolCallId,
                  providerToolCallId: msg.providerToolCallId,
                  toolName: msg.toolName,
                  parts,
                })
              } else {
                messages.push(msg)
              }
              break
            }
            case 'AssistantMessage': {
              messages.push(msg)
              break
            }
          }
        }

        if (!changed) {
          return { prompt, replacements: allReplacements }
        }

        return {
          prompt: new Prompt({
            system: prompt.system ?? '',
            messages,
          }),
          replacements: allReplacements,
        }
      }),
    }
  }),
)
