import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { yieldTool, workerYieldTool } from '../tools/yield'

export interface YieldState extends BaseState {
  target?: string
}

const yieldInitial: Omit<YieldState, 'phase'> = {
  target: undefined,
}

export const yieldModel = defineStateModel(yieldTool)<YieldState>({
  initial: yieldInitial,
  reduce: (state, event): YieldState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolInputFieldChunk':
        return event.field === 'target'
          ? { ...state, phase: 'streaming', target: (state.target ?? '') + event.delta }
          : state
      case 'ToolInputReady':
        return state
      case 'ToolExecutionStarted':
        return { ...state, phase: 'executing', target: event.input.target ?? state.target }
      case 'ToolExecutionEnded': {
        switch (event.result._tag) {
          case 'Success':
            return { ...state, phase: 'completed', target: event.result.output.target }
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

export interface WorkerYieldState extends BaseState {}

export const workerYieldModel = defineStateModel(workerYieldTool)<WorkerYieldState>({
  initial: {},
  reduce: (state, event): WorkerYieldState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolExecutionStarted':
        return { ...state, phase: 'executing' }
      case 'ToolExecutionEnded':
        return { ...state, phase: event.result._tag === 'Success' ? 'completed' : 'error' }
      case 'ToolInputDecodeFailed':
        return { ...state, phase: 'error', errorMessage: event.issue.message }
      default:
        return state
    }
  },
})