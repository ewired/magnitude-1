import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { compactTool } from '../tools/compact'

export interface CompactState extends BaseState {
  readonly errorMessage?: string
}

export const compactModel = defineStateModel(compactTool)<CompactState>({
  initial: {},
  reduce: (state, event) => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' as const }
      case 'ToolExecutionStarted':
        return { ...state, phase: 'executing' as const }
      case 'ToolExecutionEnded':
        return { ...state, phase: event.result._tag === 'Success' ? 'completed' as const : 'error' as const }
      case 'ToolInputRejected':
        return { ...state, phase: 'error' as const, errorMessage: event.issue.message }
      default:
        return state
    }
  },
})
