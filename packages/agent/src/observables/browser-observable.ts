import { Effect } from 'effect'
import type { ObservableConfig, ObservablePart } from './types'
import { BrowserHarnessTag } from '../tools/browser-tools'

export const browserObservable: ObservableConfig<BrowserHarnessTag> = {
  name: 'browser',
  observe: () => Effect.gen(function* () {
    const { get } = yield* BrowserHarnessTag
    const harness = yield* get()
    yield* Effect.promise(() => harness.waitForStability())
    const image = yield* Effect.promise(() => harness.screenshot())
    const base64 = image.toBase64('png')
    const imgWidth = image.width
    const imgHeight = image.height
    // If virtual dimensions are set (e.g. Gemini's 1000x1000 grid), report those as the coordinate space
    const virtualDims = harness.virtualDimensions
    const width = virtualDims?.width ?? imgWidth
    const height = virtualDims?.height ?? imgHeight
    const tabState = yield* Effect.promise(() => harness.retrieveTabState())
    const tabLines = tabState.tabs.map((t: { title: string; url: string }, i: number) =>
      `${i === tabState.activeTab ? '[ACTIVE] ' : ''}${i}: ${t.title} (${t.url})`
    )
    const tabText = `Current page: ${tabState.tabs[tabState.activeTab]?.url ?? 'unknown'}\nViewport: ${width}x${height}\nTabs:\n${tabLines.join('\n')}`
    const parts: readonly ObservablePart[] = [
      { _tag: 'TextPart', text: tabText },
      { _tag: 'ImagePart', data: base64, mediaType: 'image/png', dimensions: { width: imgWidth, height: imgHeight } },
    ]
    return parts
  })
}
