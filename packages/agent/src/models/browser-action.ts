import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import {
  clickTool,
  doubleClickTool,
  rightClickTool,
  typeTool,
  scrollTool,
  dragTool,
  navigateTool,
  goBackTool,
  switchTabTool,
  newTabTool,
  screenshotTool,
  evaluateTool,
} from '../tools/browser-tools'
import { formatBrowserActionVisualFromStreaming } from '../tools/browser-action-visuals'

export interface BrowserActionState extends BaseState {
  label?: string
  detail?: string
  errorDetail?: string
  /** @internal accumulated raw text per field for streaming visual computation */
  _fields: Record<string, string>
}

const initial: Omit<BrowserActionState, 'phase'> = {
  label: undefined,
  detail: undefined,
  errorDetail: undefined,
  _fields: {},
}

export function createBrowserActionModel<
  K extends string,
  TInput,
  TOutput,
  TEmission,
>(
  config: { readonly toolKey: K; readonly tool: { inputSchema: { Type: TInput }; outputSchema: { Type: TOutput } } },
) {
  return defineStateModel(config.tool)<BrowserActionState>({
    initial,
    reduce: (state, event): BrowserActionState => {
      switch (event._tag) {
        case 'ToolInputStarted':
          return { ...state, phase: 'streaming', errorDetail: undefined }
        case 'ToolInputFieldChunk': {
          const fields = { ...state._fields, [event.field]: (state._fields[event.field] ?? '') + event.delta }
          const visual = formatBrowserActionVisualFromStreaming(config.toolKey, fields)
          return { ...state, phase: 'streaming', _fields: fields, label: visual.label, detail: visual.detail }
        }
        case 'ToolInputReady':
          return state
        case 'ToolExecutionStarted': {
          const input = event.input as Record<string, unknown>
          const fields: Record<string, string> = {}
          for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
            if (v !== null && v !== undefined) fields[k] = String(v)
          }
          const visual = formatBrowserActionVisualFromStreaming(config.toolKey, fields)
          return { ...state, phase: 'executing', _fields: fields, label: visual.label, detail: visual.detail }
        }
        case 'ToolExecutionEnded': {
          switch (event.result._tag) {
            case 'Success':
              return { ...state, phase: 'completed' }
            case 'Error':
              return { ...state, phase: 'error', errorDetail: event.result.error }
            case 'Rejected':
              return { ...state, phase: 'rejected' }
            case 'Interrupted':
              return { ...state, phase: 'interrupted' }
            default:
              return state
          }
        }
        case 'ToolInputDecodeFailed':
          return { ...state, phase: 'error', errorDetail: event.issue.message }
        case 'ToolEmission':
        case 'ToolInputFieldComplete':
        default:
          return state
      }
    },
  })
}

export const clickModel = createBrowserActionModel({ toolKey: 'click', tool: clickTool })
export const doubleClickModel = createBrowserActionModel({ toolKey: 'doubleClick', tool: doubleClickTool })
export const rightClickModel = createBrowserActionModel({ toolKey: 'rightClick', tool: rightClickTool })
export const typeModel = createBrowserActionModel({ toolKey: 'type', tool: typeTool })
export const scrollModel = createBrowserActionModel({ toolKey: 'scroll', tool: scrollTool })
export const dragModel = createBrowserActionModel({ toolKey: 'drag', tool: dragTool })
export const navigateModel = createBrowserActionModel({ toolKey: 'navigate', tool: navigateTool })
export const goBackModel = createBrowserActionModel({ toolKey: 'goBack', tool: goBackTool })
export const switchTabModel = createBrowserActionModel({ toolKey: 'switchTab', tool: switchTabTool })
export const newTabModel = createBrowserActionModel({ toolKey: 'newTab', tool: newTabTool })
export const screenshotModel = createBrowserActionModel({ toolKey: 'screenshot', tool: screenshotTool })
export const evaluateModel = createBrowserActionModel({ toolKey: 'evaluate', tool: evaluateTool })
