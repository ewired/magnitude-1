import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { createTaskTool } from '../tools/task-tools'

export interface CreateTaskState extends BaseState {
  id?: string
}

const initial: Omit<CreateTaskState, 'phase'> = {
  id: undefined,
}

export const createTaskModel = defineStateModel(createTaskTool)<CreateTaskState>({
  initial,
  reduce: (state, event): CreateTaskState => {
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
        return { ...state, phase: 'error', errorMessage: event.message }
      case 'ToolEmission':
      case 'ToolInputFieldComplete':
      default:
        return state
    }
  },
})
