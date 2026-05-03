import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { killWorkerTool } from '../tools/task-tools'

export interface KillWorkerState extends BaseState {
  id?: string
}

const initial: Omit<KillWorkerState, 'phase'> = {
  id: undefined,
}

export const killWorkerModel = defineStateModel(killWorkerTool)<KillWorkerState>({
  initial,
  reduce: (state, event): KillWorkerState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolInputFieldChunk':
        return event.field === 'id'
          ? { ...state, phase: 'streaming', id: (state.id ?? '') + event.delta }
          : state
      case 'ToolInputReady':
        return state
      case 'ToolExecutionStarted':
        return { ...state, phase: 'executing', id: event.input.id ?? state.id }
      case 'ToolExecutionEnded': {
        switch (event.result._tag) {
          case 'Success':
            return { ...state, phase: 'completed', id: event.result.output.id }
          case 'Error':
            return { ...state, phase: 'error' }
          case 'Rejected':
            return { ...state, phase: 'rejected' }
          case 'Interrupted':
            return { ...state, phase: 'interrupted' }
          default:
            return state
        }
      }
      case 'ToolInputDecodeFailed':
        return { ...state, phase: 'error', errorMessage: event.issue.message }
      case 'ToolEmission':
      case 'ToolInputFieldComplete':
      default:
        return state
    }
  },
})
