import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'
import { TestHarness, TestHarnessLive } from '../../src/test-harness/harness'
import { baseContext, getMemory, mkCompactionCompleted, mkCompactionReady, mkCompactionStarted, mkTurnCompleted, mkTurnStarted, mkUserMessage } from './helpers'

const sendAssistantText = (h: Effect.Effect.Success<typeof TestHarness>, turnId: string, text: string) =>
  Effect.gen(function* () {
    yield* h.send({ type: 'message_start', forkId: null, turnId, id: `${turnId}-msg`, destination: { kind: 'user' } })
    yield* h.send({ type: 'message_chunk', forkId: null, turnId, id: `${turnId}-msg`, text })
    yield* h.send({ type: 'message_end', forkId: null, turnId, id: `${turnId}-msg` })
  })

describe('compaction/memory-rewrite', () => {
  it.effect('compaction_completed rewrites as [session_context, ...remaining, reflection]', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      yield* h.send(mkUserMessage({ text: 'first message' }))
      yield* h.send(mkUserMessage({ text: 'second message' }))
      yield* h.send(mkCompactionCompleted({ summary: 'compacted summary', compactedMessageCount: 2, tokensSaved: 20 }))
      const memory = yield* getMemory(h)
      expect(memory.messages[0]?.type).toBe('session_context')
      expect(memory.messages[memory.messages.length - 1]?.type).toBe('compacted')
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('compacted message content preserves summary text exactly', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      const summary = 'line 1\nline 2\nline 3'
      yield* h.send(mkCompactionCompleted({ summary, compactedMessageCount: 0 }))
      const memory = yield* getMemory(h)
      const last = memory.messages[memory.messages.length - 1]
      expect(last?.type).toBe('compacted')
      if (last?.type === 'compacted') {
        const text = last.content.map((p) => (p._tag === 'TextPart' ? p.text : '')).join('')
        expect(text).toBe(`--- REFLECTION START ---\n${summary}\n--- REFLECTION END ---`)
      }
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('remaining message ordering is preserved after rewrite', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      for (const id of [1, 2, 3]) {
        const turnId = `t-${id}`
        yield* h.send(mkTurnStarted({ turnId, chainId: 'chain-order' }))
        yield* sendAssistantText(h, turnId, `assistant-${id}`)
        yield* h.send(mkTurnCompleted({ turnId, chainId: 'chain-order' }))
      }
      const before = yield* getMemory(h)
      const compactedMessageCount = 2
      yield* h.send(mkCompactionCompleted({ summary: 's', compactedMessageCount }))
      const after = yield* getMemory(h)

      const beforeSuffix = before.messages.slice(1 + compactedMessageCount)
      // After rewrite: [session_context, ...remaining, reflection]
      const afterSuffix = after.messages.slice(1, -1)
      expect(afterSuffix.length).toBe(beforeSuffix.length)
      for (let i = 0; i < beforeSuffix.length; i++) {
        expect(afterSuffix[i]).toBe(beforeSuffix[i])
      }
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('refreshedContext replaces existing session_context', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      yield* h.send(mkCompactionCompleted({
        refreshedContext: baseContext({ cwd: '/tmp/new-cwd' }),
      }))
      const memory = yield* getMemory(h)
      expect(memory.messages[0]?.type).toBe('session_context')
      if (memory.messages[0]?.type === 'session_context') {
        const text = memory.messages[0].content.map((p) => (p._tag === 'TextPart' ? p.text : '')).join('')
        expect(text.includes('/tmp/new-cwd')).toBe(true)
      }
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('null refreshedContext preserves prior session_context', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      const before = yield* getMemory(h)
      yield* h.send(mkCompactionCompleted({ refreshedContext: null }))
      const after = yield* getMemory(h)
      expect(after.messages[0]).toBe(before.messages[0])
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('currentChainId resets on compaction_completed', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      yield* h.send(mkTurnStarted({ turnId: 'turn-cid', chainId: 'chain-cid' }))
      yield* h.send(mkTurnCompleted({ turnId: 'turn-cid', chainId: 'chain-cid' }))
      yield* h.send(mkCompactionCompleted())
      const memory = yield* getMemory(h)
      expect(memory.currentChainId).toBeNull()
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('session_context entry has non-zero estimatedTokens', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      const memory = yield* getMemory(h)
      const sessionCtx = memory.messages[0]
      expect(sessionCtx?.type).toBe('session_context')
      expect(sessionCtx?.estimatedTokens).toBeGreaterThan(0)
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('reflection block has non-zero estimatedTokens', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      yield* h.send(mkCompactionCompleted({ summary: 'important reflection about the work done so far' }))
      const memory = yield* getMemory(h)
      const reflection = memory.messages[memory.messages.length - 1]
      expect(reflection?.type).toBe('compacted')
      expect(reflection?.estimatedTokens).toBeGreaterThan(0)
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('messageTokens equals sum of entry estimatedTokens after compaction', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      yield* h.send(mkUserMessage({ text: 'first message' }))
      yield* h.send(mkUserMessage({ text: 'second message' }))
      yield* h.send(mkCompactionCompleted({ summary: 'compacted summary', compactedMessageCount: 2, tokensSaved: 20 }))
      const memory = yield* getMemory(h)
      const sumOfEntries = memory.messages.reduce((acc, entry) => acc + entry.estimatedTokens, 0)
      expect(memory.messageTokens).toBe(sumOfEntries)
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('tokenEstimate is recomputed after compaction_completed', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      yield* h.send(mkUserMessage({ text: 'first message' }))
      yield* h.send(mkUserMessage({ text: 'second message' }))
      const before = yield* getMemory(h)
      const tokensBefore = before.tokenEstimate

      yield* h.send(mkCompactionCompleted({ summary: 'short', compactedMessageCount: 2, tokensSaved: 20 }))
      const after = yield* getMemory(h)

      // tokenEstimate should reflect the new smaller window
      expect(after.tokenEstimate).toBe(after.systemPromptTokens + after.messageTokens)
      // Should be less than before (compacted 2 messages into a short summary)
      expect(after.tokenEstimate).toBeLessThan(tokensBefore)
    }).pipe(Effect.provide(TestHarnessLive())))

  it.effect('stale anchor is cleared on compaction_completed so tokenEstimate does not underflow', () =>
    Effect.gen(function* () {
      const h = yield* TestHarness
      const before = yield* getMemory(h)
      const systemPromptTokens = before.systemPromptTokens

      // Establish an anchor: a completed turn that reports inputTokens
      // This sets lastAnchoredTotal = inputTokens + turnEntryTokens
      // and lastAnchoredMessageTokens = messageTokens at that moment.
      const turnId = 'turn-anchored'
      yield* h.send(mkTurnStarted({ turnId, chainId: 'chain-anchored' }))
      yield* h.send({ type: 'message_start', forkId: null, turnId, id: `${turnId}-msg`, destination: { kind: 'user' } })
      yield* h.send({ type: 'message_end', forkId: null, turnId, id: `${turnId}-msg` })
      yield* h.send(mkTurnCompleted({ turnId, chainId: 'chain-anchored', inputTokens: 5000 }))
      const afterAnchor = yield* getMemory(h)
      expect(afterAnchor.lastAnchoredTotal).not.toBeNull()
      expect(afterAnchor.lastAnchoredMessageTokens).not.toBeNull()
      const anchoredTotal = afterAnchor.lastAnchoredTotal!
      const anchoredMsgTokens = afterAnchor.lastAnchoredMessageTokens!

      // Add more content — messageTokens grows beyond the anchored snapshot.
      yield* h.send(mkUserMessage({ text: 'much longer message that increases messageTokens significantly' }))
      yield* h.send(mkUserMessage({ text: 'another message to push token count further' }))
      const beforeCompaction = yield* getMemory(h)
      expect(beforeCompaction.messageTokens).toBeGreaterThan(anchoredMsgTokens)

      // Run compaction that removes all pre-anchor content (compactedMessageCount = all messages
      // up to and including the anchored turn — effectively the session_context + the turn).
      // After compaction, messageTokens drops sharply.
      yield* h.send(mkCompactionStarted())
      yield* h.send(mkCompactionReady({ compactedMessageCount: beforeCompaction.messages.length - 1 }))
      yield* h.send(mkCompactionCompleted({
        compactedMessageCount: beforeCompaction.messages.length - 1,
        summary: 'compacted everything before re-anchor',
      }))
      const afterCompaction = yield* getMemory(h)

      // Anchor must be cleared so tokenEstimate falls back to the pure heuristic
      // (systemPromptTokens + messageTokens), not lastAnchoredTotal + delta with a
      // now-stale lastAnchoredMessageTokens that would produce a negative delta.
      expect(afterCompaction.lastAnchoredTotal).toBeNull()
      expect(afterCompaction.lastAnchoredMessageTokens).toBeNull()

      // tokenEstimate must be a sane value — at least systemPromptTokens, never negative.
      expect(afterCompaction.tokenEstimate).toBeGreaterThanOrEqual(systemPromptTokens)
      expect(afterCompaction.tokenEstimate).toBe(afterCompaction.systemPromptTokens + afterCompaction.messageTokens)
    }).pipe(Effect.provide(TestHarnessLive())))
})