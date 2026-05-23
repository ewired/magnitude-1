import { defineStateModel, type BaseState } from '@magnitudedev/harness'
import { writeTool } from '../tools/fs'

export interface FileWriteState extends BaseState {
  path?: string
  body: string
  charCount: number
  lineCount: number
  isScratchpad: boolean
  scratchpadDisplayPath?: string
}

/** Detect $M/ or ${M}/ prefix and extract display path */
function detectScratchpad(path: string): { isScratchpad: boolean; scratchpadDisplayPath?: string } {
  const s = path.replace(/^\.\/+/, '').replace(/^\.\.\/+/, '')
  if (s.startsWith('$M/')) {
    return { isScratchpad: true, scratchpadDisplayPath: s.slice('$M/'.length) || undefined }
  }
  if (s.startsWith('${M}/')) {
    return { isScratchpad: true, scratchpadDisplayPath: s.slice('${M}/'.length) || undefined }
  }
  if (s === '$M' || s === '${M}') {
    return { isScratchpad: true, scratchpadDisplayPath: undefined }
  }
  return { isScratchpad: false }
}

const initial: Omit<FileWriteState, 'phase'> = {
  path: undefined,
  body: '',
  charCount: 0,
  lineCount: 0,
  isScratchpad: false,
  scratchpadDisplayPath: undefined,
}

export const fileWriteModel = defineStateModel(writeTool)<FileWriteState>({
  initial,
  reduce: (state, event): FileWriteState => {
    switch (event._tag) {
      case 'ToolInputStarted':
        return { ...state, phase: 'streaming' }
      case 'ToolInputFieldChunk': {
        if (event.field === 'path') {
          const path = (state.path ?? '') + event.delta
          const { isScratchpad, scratchpadDisplayPath } = detectScratchpad(path)
          return { ...state, phase: 'streaming', path, isScratchpad, scratchpadDisplayPath }
        }
        if (event.field === 'content') {
          const content = state.body + event.delta
          return {
            ...state,
            phase: 'streaming',
            body: content,
            charCount: content.length,
            lineCount: content.length > 0 ? content.split('\n').length : 0,
          }
        }
        return state
      }
      case 'ToolInputReady':
        return state
      case 'ToolExecutionStarted': {
        const content = event.input.content ?? state.body
        const path = event.input.path ?? state.path
        const { isScratchpad, scratchpadDisplayPath } = path ? detectScratchpad(path) : { isScratchpad: state.isScratchpad, scratchpadDisplayPath: state.scratchpadDisplayPath }
        return {
          ...state,
          phase: 'executing',
          path,
          isScratchpad,
          scratchpadDisplayPath,
          body: content,
          charCount: content.length,
          lineCount: content.length > 0 ? content.split('\n').length : 0,
        }
      }
      case 'ToolEmission': {
        const v = event.value as { type?: string; path?: string; linesWritten?: number }
        return v.type === 'write_stats'
          ? { ...state, phase: 'executing', path: v.path ?? state.path, lineCount: v.linesWritten ?? state.lineCount }
          : state
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
      case 'ToolInputFieldComplete':
      default:
        return state
    }
  },
})
