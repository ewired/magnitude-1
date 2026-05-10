import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { spawnWorkerTool } from '../tools/task-tools'

export interface SpawnWorkerState extends BaseState {
  taskId?: string
  agentId?: string
  message?: string
  role?: string
  yield?: boolean
  title?: string
}

const initial: Omit<SpawnWorkerState, 'phase'> = {
  taskId: undefined,
  agentId: undefined,
  message: undefined,
  role: undefined,
  yield: undefined,
  title: undefined,
}

export const spawnWorkerModel = defineStateModel(spawnWorkerTool)<SpawnWorkerState>({
  initial,
  reduce: (state, event): SpawnWorkerState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolInputFieldChunk':
        if (event.field === 'taskId') return { ...state, phase: 'streaming', taskId: (state.taskId ?? '') + event.delta }
        if (event.field === 'agentId') return { ...state, phase: 'streaming', agentId: (state.agentId ?? '') + event.delta }
        if (event.field === 'message') return { ...state, phase: 'streaming', message: (state.message ?? '') + event.delta }
        if (event.field === 'role') return { ...state, phase: 'streaming', role: (state.role ?? '') + event.delta }
        return state
      case 'ToolInputReady':
        return state
      case 'ToolExecutionStarted':
        return {
          ...state,
          phase: 'executing',
          taskId: event.input.taskId ?? state.taskId,
          agentId: event.input.agentId ?? state.agentId,
          message: event.input.message ?? state.message,
          role: event.input.role ?? state.role,
        }
      case 'ToolExecutionEnded': {
        switch (event.result._tag) {
          case 'Success':
            return { ...state, phase: 'completed', taskId: event.result.output.taskId, agentId: event.result.output.agentId, title: event.result.output.title }
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
      case 'ToolInputValidationFailed':
        return { ...state, phase: 'error', errorMessage: event.error }
      case 'ToolEmission':
      case 'ToolInputFieldComplete':
      default:
        return state
    }
  },
})
