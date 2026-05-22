/**
 * Image Query Tool
 *
 * Sends an image file to the `util/image` model with an optional query
 * and returns a text description. Used when the active model lacks vision.
 */

import { Effect, Schema, Stream } from 'effect'
import * as HttpClient from '@effect/platform/HttpClient'
import { defineHarnessTool, StreamValidationError } from '@magnitudedev/harness'
import { WorkingDirectoryTag } from '../execution/working-directory'
import { readImageFileForModel } from '../util/read-image-file'
import { Fs, resolveFsPath } from '../services/fs'
import { Prompt } from '@magnitudedev/ai'
import { AgentModelResolver } from '../model/model-resolver'
import { IMAGE_DESCRIPTION_PROMPT } from '../util/image-prompts'

// =============================================================================
// Error helper
// =============================================================================

type ImageQueryError = { readonly _tag: 'ImageQueryError'; readonly message: string }

function imageError(message: string): ImageQueryError {
  return { _tag: 'ImageQueryError', message }
}

// =============================================================================
// queryImage
// =============================================================================

export const queryImageTool = defineHarnessTool({
  definition: {
    name: 'query_image',
    description: 'Query an image file by sending it to an image utility model along with an optional question. Use this to inspect images when the active model does not support direct vision. Supports PNG, JPEG, WebP, GIF, and SVG files. When no query is provided, a detailed description of the image is returned.',
    inputSchema: Schema.Struct({
      path: Schema.String.annotations({
        description: 'Relative path to an image file from cwd. Use $M/ prefix for scratchpad path.'
      }),
      query: Schema.optional(Schema.String).annotations({
        description: 'Question or instruction about what to look for in the image. Defaults to a general description request.'
      }),
    }),
    outputSchema: Schema.String,
  },
  stream: {
    initial: {},
    onInput: (input, _state, _ctx) => Effect.gen(function* () {
      if (!input.path?.isFinal) return {}
      const { cwd, scratchpadPath } = yield* WorkingDirectoryTag
      const fs = yield* Fs
      const fullPath = resolveFsPath(input.path.value, cwd, scratchpadPath)
      const exists = yield* fs.exists(fullPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (!exists) {
        return yield* Effect.fail(new StreamValidationError({ message: `File not found: ${input.path.value}` }))
      }
      return {}
    }),
  },
  execute: ({ path: filePath, query }, _ctx) => Effect.gen(function* () {
    const { cwd, scratchpadPath } = yield* WorkingDirectoryTag
    const fs = yield* Fs
    const fullPath = resolveFsPath(filePath, cwd, scratchpadPath)

    yield* fs.readFile(fullPath).pipe(
      Effect.catchAll(() => Effect.fail(imageError(`Failed to read image: ${filePath}`)))
    )

    const imageResult = yield* Effect.tryPromise({
      try: () => readImageFileForModel(fullPath),
      catch: (e) => imageError(e instanceof Error ? e.message : `Failed to read image: ${filePath}`),
    })

    const modelResolver = yield* AgentModelResolver
    const httpClient = yield* HttpClient.HttpClient
    const imageModel = yield* modelResolver.resolveImage().pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    )

    const prompt = Prompt.from({
      messages: [{
        _tag: 'UserMessage',
        parts: [
          { _tag: 'TextPart', text: query ?? IMAGE_DESCRIPTION_PROMPT },
          { _tag: 'ImagePart', mediaType: imageResult.mediaType, data: imageResult.base64 },
        ],
      }],
    })

    const streamResult = yield* imageModel.model.stream(prompt, [], { maxTokens: 2048 }).pipe(
      Effect.mapError((err) => imageError(`Image query failed: ${err.message}`))
    )

    const text = yield* Stream.runFold(streamResult.events, '', (acc, event) =>
      event._tag === 'message_delta'
        ? acc + event.text
        : acc,
    ).pipe(
      Effect.mapError((err) => imageError(`Failed to collect image query response: ${err.message}`))
    )

    return text.trim() || `[No response from image model for: ${filePath}]`
  }),
})
