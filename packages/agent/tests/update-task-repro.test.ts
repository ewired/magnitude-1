import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { TestHarness, TestHarnessLive } from '../src/test-harness/harness'
import { response } from '../src/test-harness/response-builder'

describe('update_task repro', () => {
  it('shows invalid vs valid behavior', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* TestHarness

        yield* harness.script.next({ xml: '<magnitude:invoke tool="update_task"/>' })
        yield* harness.user('bad update')
        yield* Effect.sleep('200 millis')
        console.log('INVALID EVENTS', JSON.stringify(harness.events(), null, 2))

        yield* harness.script.next(response().createTask('t1', 'Task 1').yield())
        yield* harness.script.next(response().updateTask('t1', 'completed').yield())
        yield* harness.user('create and update')
        yield* Effect.sleep('500 millis')
        console.log('ALL EVENTS', JSON.stringify(harness.events(), null, 2))

        expect(harness.events().length).toBeGreaterThan(0)
      }).pipe(Effect.provide(TestHarnessLive()))
    )
  }, 20000)
})
