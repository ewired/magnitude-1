import type { DisplayMessage, ToolMessage } from '@magnitudedev/agent'
import { summarizeToolStep } from '../tool-displays/render'

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function joinLabelDetail(label: string, detail: string): string {
  const trimmedDetail = detail.trim()
  if (trimmedDetail.length === 0) return normalize(label)
  if (/^[,.;:!?)]/.test(trimmedDetail) || /^:/.test(trimmedDetail)) return normalize(`${label}${trimmedDetail}`)
  if (/^\(/.test(trimmedDetail)) return normalize(`${label}${trimmedDetail}`)
  if (label.trimEnd().endsWith('(')) return normalize(`${label}${trimmedDetail}`)
  return normalize(`${label} ${trimmedDetail}`)
}

function getToolLiveText(step: ToolMessage): string | null {
  if (step.type !== 'tool') return null
  if (step.state) {
    const value = summarizeToolStep(step.toolKey, step.state)
    if (typeof value === 'string') {
      const normalized = normalize(value)
      if (normalized.length > 0) return normalized
    }

    if (typeof step.state === 'object' && step.state !== null) {
      if ('label' in step.state && typeof step.state.label === 'string') {
        const detail = 'detail' in step.state && typeof step.state.detail === 'string'
          ? step.state.detail
          : ''
        const joined = joinLabelDetail(step.state.label, detail)
        if (joined.length > 0) return joined
      }

      const liveTextToolKey = String(step.toolKey)
      const supportsProgressiveLiveText = (
        liveTextToolKey === 'fileWrite'
        || liveTextToolKey === 'fileEdit'
        || liveTextToolKey === 'artifactWrite'
        || liveTextToolKey === 'artifactUpdate'
      )

      if (supportsProgressiveLiveText && 'phase' in step.state) {
        if ('name' in step.state && typeof step.state.name === 'string' && step.state.name.length > 0) {
          return `Writing artifact ${step.state.name}`
        }
        if ('path' in step.state && typeof step.state.path === 'string' && step.state.path.length > 0) {
          return step.toolKey === 'fileEdit' ? `Editing ${step.state.path}` : 'Writing artifact draft'
        }
      }
    }
  }
  const fallback = normalize(String(step.toolKey))
  if (fallback.length > 0) return fallback
  return null
}

function getMessageLiveText(msg: DisplayMessage): string | null {
  if (msg.type === 'agent_communication') {
    const text = normalize(msg.preview)
    return text.length > 0 ? text : null
  }

  if (msg.type === 'tool') {
    return getToolLiveText(msg)
  }

  if (msg.type === 'thinking' && typeof msg.content === 'string') {
    const text = normalize(msg.content)
    return text.length > 0 ? text : null
  }

  return null
}

export function selectLatestLiveActivityFromMessages(
  messages: readonly DisplayMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = getMessageLiveText(messages[i])
    if (text) return text
  }
  return null
}

export function selectLatestLiveActivityForTask(
  messages: readonly DisplayMessage[],
): string | null {
  return selectLatestLiveActivityFromMessages(messages)
}