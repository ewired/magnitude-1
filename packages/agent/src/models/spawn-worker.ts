import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { spawnWorkerTool } from '../tools/task-tools'

export interface SpawnWorkerState extends BaseState {
  id?: string
  message?: string
  role?: string
  title?: string
}

const initial: Omit<SpawnWorkerState, 'phase'> = {
  id: undefined,
  message: undefined,
  role: undefined,
  title: undefined,
}

export const spawnWorkerModel = defineStateModel(spawnWorkerTool)<SpawnWorkerState>({
  initial,
  reduce: (state, event): SpawnWorkerState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolInputFieldChunk':
        if (event.field === 'id') return { ...state, phase: 'streaming', id: (state.id ?? '') + event.delta }
        if (event.field === 'message') return { ...state, phase: 'streaming', message: (state.message ?? '') + event.delta }
        if (event.field === 'role') return { ...state, phase: 'streaming', role: (state.role ?? '') + event.delta }
        return state
      case 'ToolInputReady':
        return state
      case 'ToolExecutionStarted':
        return {
          ...state,
          phase: 'executing',
          id: event.input.id ?? state.id,
          message: event.input.message ?? state.message,
          role: event.input.role ?? state.role,
        }
      case 'ToolExecutionEnded': {
        switch (event.result._tag) {
          case 'Success':
            return { ...state, phase: 'completed', id: event.result.output.id, title: event.result.output.title }
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
