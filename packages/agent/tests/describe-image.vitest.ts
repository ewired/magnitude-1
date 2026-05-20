import { describe, expect, it } from 'vitest'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import { FetchHttpClient } from '@effect/platform'
import { Prompt, type BoundModel, type ImagePart, type ModelSpec, type ModelStreamResult, type ResponseStreamEvent } from '@magnitudedev/ai'
import type { MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError, ModelProfile } from '@magnitudedev/magnitude-client'
import { AgentModelResolver, type AgentBoundModel } from '../src/model/model-resolver'
import { ImageDescriptionServiceLive, ImageDescriptionServiceTag } from '../src/util/describe-image'

const imagePart: ImagePart = {
  _tag: 'ImagePart',
  mediaType: 'image/png',
  data: 'iVBORw0KGgo=',
}

const promptWithImage = Prompt.from({
  messages: [
    {
      _tag: 'UserMessage',
      parts: [imagePart],
    },
  ],
})

const profile: ModelProfile = {
  contextWindow: 100_000,
  maxOutputTokens: 2048,
  capabilities: { vision: true, grammar: false, reasoning: { type: 'none' } },
}

const testModelSpec: ModelSpec<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError> = {
  modelId: 'util/image',
  endpoint: 'http://test',
  bind: () => { throw new Error('not used') },
  _execute: () => { throw new Error('not used') },
}

function eventsFor(text: string): readonly ResponseStreamEvent<MagnitudeStreamError>[] {
  return [
    { _tag: 'message_start' },
    { _tag: 'message_delta', text },
    { _tag: 'message_end' },
    { _tag: 'stream_end', reason: { _tag: 'completed', finishReason: 'stop' }, usage: null },
  ]
}

function makeModel(responses: readonly string[]) {
  let calls = 0
  const model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError> = {
    spec: testModelSpec,
    stream: () => {
      const text = responses[Math.min(calls, responses.length - 1)] ?? ''
      calls++
      const result: ModelStreamResult<MagnitudeStreamError> = {
        events: Stream.fromIterable(eventsFor(text)),
        parsers: new Map(),
        logprobs: [],
      }
      return Effect.succeed(result)
    },
  }
  return { model, calls: () => calls }
}

function makeNeverThenModel(text: string) {
  let calls = 0
  const model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError> = {
    spec: testModelSpec,
    stream: () => {
      calls++
      if (calls === 1) return Effect.never
      const result: ModelStreamResult<MagnitudeStreamError> = {
        events: Stream.fromIterable(eventsFor(text)),
        parsers: new Map(),
        logprobs: [],
      }
      return Effect.succeed(result)
    },
  }
  return { model, calls: () => calls }
}

function makeResolver(model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError>) {
  const resolved: AgentBoundModel = {
    model,
    modelSource: { type: 'utility', modelId: 'util/image' },
    modelId: 'util/image',
    profile,
  }
  return Layer.succeed(AgentModelResolver, {
    resolve: () => Effect.die('not used'),
    resolveAutopilot: () => Effect.die('not used'),
    resolveImage: () => Effect.succeed(resolved),
  })
}

function runWithModel<A>(
  model: BoundModel<MagnitudeCallOptions, MagnitudeConnectionError, MagnitudeStreamError>,
  effect: Effect.Effect<A, never, ImageDescriptionServiceTag>,
) {
  const layer = Layer.provide(
    ImageDescriptionServiceLive,
    Layer.mergeAll(makeResolver(model), FetchHttpClient.layer),
  )
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)),
  )
}

describe('ImageDescriptionService', () => {
  it('starts eagerly and resolve reuses the in-flight description', async () => {
    const { model, calls } = makeModel(['a small white image'])
    const dataUrl = `data:${imagePart.mediaType};base64,${imagePart.data}`

    const result = await runWithModel(model, Effect.gen(function* () {
      const service = yield* ImageDescriptionServiceTag
      yield* service.start(dataUrl)
      yield* service.start(dataUrl)
      return yield* service.resolve(promptWithImage)
    }))

    expect(calls()).toBe(1)
    expect(result.replacements).toEqual([{ imageDataUrl: dataUrl, description: 'a small white image' }])
    const message = result.prompt.messages[0]
    expect(message?._tag).toBe('UserMessage')
    expect(message?._tag === 'UserMessage' ? message.parts[0] : null).toEqual({
      _tag: 'TextPart',
      text: '[User uploaded an image. Description: a small white image]',
    })
  })

  it('cancel removes pending work so resolve starts a fresh description', async () => {
    const { model, calls } = makeNeverThenModel('fresh description')
    const dataUrl = `data:${imagePart.mediaType};base64,${imagePart.data}`

    const result = await runWithModel(model, Effect.gen(function* () {
      const service = yield* ImageDescriptionServiceTag
      yield* service.start(dataUrl)
      while (calls() === 0) {
        yield* Effect.sleep('1 millis')
      }
      yield* service.cancel(dataUrl)
      return yield* service.resolve(promptWithImage)
    }))

    expect(calls()).toBe(2)
    expect(result.replacements).toEqual([{ imageDataUrl: dataUrl, description: 'fresh description' }])
  })

  it('keeps eager work alive across separate managed runtime calls', async () => {
    const { model, calls } = makeModel(['runtime boundary description'])
    const dataUrl = `data:${imagePart.mediaType};base64,${imagePart.data}`
    const layer = Layer.provide(
      ImageDescriptionServiceLive,
      Layer.mergeAll(makeResolver(model), FetchHttpClient.layer),
    )
    const runtime = ManagedRuntime.make(layer)

    try {
      await runtime.runPromise(Effect.gen(function* () {
        const service = yield* ImageDescriptionServiceTag
        yield* service.start(dataUrl)
      }))

      const result = await runtime.runPromise(Effect.gen(function* () {
        const service = yield* ImageDescriptionServiceTag
        return yield* service.resolve(promptWithImage)
      }))

      expect(calls()).toBe(1)
      expect(result.replacements).toEqual([{ imageDataUrl: dataUrl, description: 'runtime boundary description' }])
    } finally {
      await runtime.dispose()
    }
  })
})
