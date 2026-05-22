import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { queryImageTool } from '../tools/query-image'

export interface QueryImageState extends BaseState {
  path?: string
  query?: string
}

const initial: Omit<QueryImageState, 'phase'> = {
  path: undefined,
  query: undefined,
}

export const queryImageModel = defineStateModel(queryImageTool)<QueryImageState>({
  initial,
  reduce: (state, event): QueryImageState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolInputFieldChunk':
        if (event.field === 'path') {
          return { ...state, phase: 'streaming', path: (state.path ?? '') + event.delta }
        }
        if (event.field === 'query') {
          return { ...state, phase: 'streaming', query: (state.query ?? '') + event.delta }
        }
        return state
      case 'ToolInputReady':
        return state
      case 'ToolExecutionStarted':
        return {
          ...state,
          phase: 'executing',
          path: event.input.path ?? state.path,
          query: event.input.query ?? state.query,
        }
      case 'ToolExecutionEnded': {
        switch (event.result._tag) {
          case 'Success':
            return { ...state, phase: 'completed' }
          case 'Error':
            return { ...state, phase: 'error' }
          case 'Denied':
            return { ...state, phase: 'rejected', errorMessage: String(event.result.denial) }
          case 'Interrupted':
            return { ...state, phase: 'interrupted' }
          default:
            return state
        }
      }
      case 'ToolInputRejected':
        return { ...state, phase: 'error', errorMessage: event.issue.message }
      case 'ToolEmission':
      case 'ToolInputFieldComplete':
      default:
        return state
    }
  },
})
