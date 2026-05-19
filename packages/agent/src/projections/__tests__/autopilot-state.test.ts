import { describe, expect, it } from 'bun:test'
import { Effect, Layer } from 'effect'
import {
  ProjectionBusTag,
  makeProjectionBusLayer,
  makeAmbientServiceLayer,
  FrameworkErrorPubSubLive,
  FrameworkErrorReporterLive,
} from '@magnitudedev/event-core'
import type { AppEvent } from '../../events'
import { AutopilotStateProjection, type AutopilotState } from '../autopilot-state'
import { UserMessageResolutionProjection } from '../user-message-resolution'

const ts = (n: number) => 1_700_300_000_000 + n

const makeState = async (events: AppEvent[]): Promise<AutopilotState> => {
  const baseBusLayer = Layer.provideMerge(
    makeProjectionBusLayer<AppEvent>(),
    Layer.provide(FrameworkErrorReporterLive, FrameworkErrorPubSubLive),
  )
  const baseLayer = Layer.provideMerge(
    makeAmbientServiceLayer<AppEvent>(),
    baseBusLayer,
  )

  // UserMessageResolutionProjection must be provided alongside AutopilotStateProjection
  // since AutopilotStateProjection reads from it via signal.
  const runtimeLayer = Layer.mergeAll(
    FrameworkErrorPubSubLive,
    Layer.provide(FrameworkErrorReporterLive, FrameworkErrorPubSubLive),
    baseLayer,
    Layer.provide(UserMessageResolutionProjection.Layer, baseLayer),
    Layer.provide(AutopilotStateProjection.Layer, baseLayer),
  )

  const program = Effect.gen(function* () {
    const bus = yield* ProjectionBusTag<AppEvent>()
    const projection = yield* AutopilotStateProjection.Tag

    for (const event of events) {
      yield* bus.processEvent(event as any)
    }

    return yield* projection.get
  })

  return Effect.runPromise(program.pipe(Effect.provide(runtimeLayer)) as any) as Promise<AutopilotState>
}

describe('AutopilotStateProjection', () => {
  it('initial state: disabled with no pending content', async () => {
    const state = await makeState([])
    expect(state.enabled).toBe(false)
    expect(state.pendingContent).toBeNull()
  })

  it('toggle on → enabled=true, pendingContent stays null', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBeNull()
  })

  it('message generated → pendingContent set', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBe('hello')
  })

  it('raw user_message does NOT clear pending content (only signal does)', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
      {
        type: 'user_message',
        timestamp: ts(3),
        forkId: null,
        messageId: 'msg-1',
        content: [{ _tag: 'TextPart', text: 'real message' }],
        attachments: [],
        mode: 'text',
        synthetic: false,
        taskMode: false,
      } as AppEvent,
    ])
    // pendingContent survives the raw user_message event
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBe('hello')
  })

  it('user_message_ready signal clears pending content (same timing as TurnProjection)', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
      {
        type: 'user_message',
        timestamp: ts(3),
        forkId: null,
        messageId: 'msg-1',
        content: [{ _tag: 'TextPart', text: 'real message' }],
        attachments: [],
        mode: 'text',
        synthetic: false,
        taskMode: false,
      } as AppEvent,
      {
        type: 'user_message_ready',
        timestamp: ts(4),
        forkId: null,
        messageId: 'msg-1',
        resolvedMentions: [],
      } as AppEvent,
    ])
    // pendingContent is cleared by the userMessageResolved signal
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBeNull()
  })

  it('synthetic user_message + user_message_ready clears pending content', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
      {
        type: 'user_message',
        timestamp: ts(3),
        forkId: null,
        messageId: 'auto-msg-1',
        content: [{ _tag: 'TextPart', text: 'synthetic message' }],
        attachments: [],
        mode: 'text',
        synthetic: true,
        taskMode: false,
      } as AppEvent,
      {
        type: 'user_message_ready',
        timestamp: ts(4),
        forkId: null,
        messageId: 'auto-msg-1',
        resolvedMentions: [],
      } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBeNull()
  })

  it('toggle off preserves pending content', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
      { type: 'autopilot_toggled', timestamp: ts(3), forkId: null, enabled: false } as AppEvent,
    ])
    expect(state.enabled).toBe(false)
    expect(state.pendingContent).toBe('hello')
  })

  it('toggle off then on restores same pending content', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
      { type: 'autopilot_toggled', timestamp: ts(3), forkId: null, enabled: false } as AppEvent,
      { type: 'autopilot_toggled', timestamp: ts(4), forkId: null, enabled: true } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBe('hello')
  })

  it('second message generated overwrites previous content', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'first' } } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(3), forkId: null, result: { _tag: 'success', content: 'second' } } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBe('second')
  })

  it('toggle off with no pending content just sets enabled=false', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_toggled', timestamp: ts(2), forkId: null, enabled: false } as AppEvent,
    ])
    expect(state.enabled).toBe(false)
    expect(state.pendingContent).toBeNull()
  })

  it('does not clear pending content on non-user-message events', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
      { type: 'turn_started', timestamp: ts(3), forkId: null, turnId: 't1', chainId: 'c1' } as AppEvent,
      { type: 'thinking_start', timestamp: ts(4), forkId: null, turnId: 't1' } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBe('hello')
  })

  it('autopilot_generation_started sets generating=true', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_generation_started', timestamp: ts(2), forkId: null } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.generating).toBe(true)
    expect(state.pendingContent).toBeNull()
  })

  it('autopilot_outcome error clears generating without setting pendingContent', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_generation_started', timestamp: ts(2), forkId: null } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(3), forkId: null, result: { _tag: 'error', message: 'Connection failed' } } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.generating).toBe(false)
    expect(state.pendingContent).toBeNull()
  })

  it('autopilot_outcome success clears generating and sets pendingContent', async () => {
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_generation_started', timestamp: ts(2), forkId: null } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(3), forkId: null, result: { _tag: 'success', content: 'hello' } } as AppEvent,
    ])
    expect(state.enabled).toBe(true)
    expect(state.generating).toBe(false)
    expect(state.pendingContent).toBe('hello')
  })

  it('no race: raw user_message does not clear, so worker guards block re-generation', async () => {
    // After synthetic user_message, pendingContent is still "hello".
    // TurnProjection will get its trigger from userMessageResolved signal
    // at the same time AutopilotStateProjection clears pendingContent.
    // By the time onProjectionsSettled fires, either:
    //   - pendingContent is still set (guard blocks), OR
    //   - pendingContent is null AND TurnProjection has a trigger (guard blocks)
    const state = await makeState([
      { type: 'autopilot_toggled', timestamp: ts(1), forkId: null, enabled: true } as AppEvent,
      { type: 'autopilot_outcome', timestamp: ts(2), forkId: null, result: { _tag: 'success', content: 'autopilot says hi' } } as AppEvent,
      {
        type: 'user_message',
        timestamp: ts(3),
        forkId: null,
        messageId: 'auto-msg-1',
        content: [{ _tag: 'TextPart', text: 'autopilot says hi' }],
        attachments: [],
        mode: 'text',
        synthetic: true,
        taskMode: false,
      } as AppEvent,
    ])
    // pendingContent survives raw user_message — no race window
    expect(state.enabled).toBe(true)
    expect(state.pendingContent).toBe('autopilot says hi')
  })
})
