import { describe, expect, it } from 'bun:test'
import type { DisplayMessage, ToolMessage } from '@magnitudedev/agent'
import {
  selectLatestLiveActivityForTask,
  selectLatestLiveActivityFromMessages,
} from './live-activity'

describe('live-activity selector', () => {
  it('selects latest displayable activity by recency across message types', () => {
    const messages = [
      { id: '1', type: 'thinking', content: 'first thought', timestamp: 1 },
      { id: '2', type: 'agent_communication', preview: 'latest communication', content: '', timestamp: 2, direction: 'to_agent', agentId: 'a', forkId: null },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(messages)).toBe('latest communication')
  })

  it('uses agent communication preview in live activity', () => {
    const messages = [
      { id: '1', type: 'agent_communication', preview: 'pending inbound', content: 'pending inbound full', timestamp: 1, direction: 'to_agent', agentId: 'a', forkId: null },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(messages)).toBe('pending inbound')
  })

  it('uses most recent producible activity for task status', () => {
    const messages = [
      { id: '1', type: 'thinking', content: 'older think activity', timestamp: 1 },
      { id: '2', type: 'agent_communication', preview: 'newer communication activity', content: '', timestamp: 2, direction: 'to_agent', agentId: 'a', forkId: null },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityForTask(messages)).toBe('newer communication activity')
  })

  it('falls back to latest communication when task has no think activity', () => {
    const messages = [
      { id: '1', type: 'thinking', content: '   ', timestamp: 1 },
      { id: '2', type: 'agent_communication', preview: 'latest communication', content: '', timestamp: 2, direction: 'to_agent', agentId: 'a', forkId: null },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityForTask(messages)).toBe('latest communication')
  })

  it('uses tool live-text semantics before fallback label', () => {
    const messages = [
      {
        id: '1',
        type: 'tool',
        toolKey: 'navigate',
        timestamp: 1,
        state: { label: 'Navigate to ', detail: 'https://example.com' },
      },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(messages)).toBe('Navigate to https://example.com')
  })

  it('falls back to tool label when no visual live text exists', () => {
    const messages = [
      {
        id: '1',
        type: 'tool',
        toolKey: 'unknownTool',
        timestamp: 1,
      },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(messages)).toBe('unknownTool')
  })

  it('uses progressive live text for active artifact/file tools', () => {
    const activeArtifactWrite = [
      {
        id: '1',
        type: 'tool',
        toolKey: 'artifactWrite',
        timestamp: 1,
        state: { phase: 'streaming', name: 'draft' },
      },
    ] as any as DisplayMessage[]

    const activeFileEdit = [
      {
        id: '1',
        type: 'tool',
        toolKey: 'fileEdit',
        timestamp: 1,
        state: { phase: 'running', path: 'src/app.ts' },
      },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(activeArtifactWrite)).toBe('Writing artifact draft')
    expect(selectLatestLiveActivityFromMessages(activeFileEdit)).toBe('Editing src/app.ts')
  })

  it('uses shell fallback labels as provided by the producer', () => {
    const messages = [
      {
        id: '1',
        type: 'tool',
        toolKey: 'shell',
        timestamp: 1,
        state: { label: '$ bun test cli/src/utils/live-activity.test.ts' },
      },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(messages)).toBe('$ bun test cli/src/utils/live-activity.test.ts')
  })

  it('ignores worker lifecycle message types', () => {
    const messages = [
      { id: '1', type: 'thinking', content: 'active thought', timestamp: 1 },
      { id: '2', type: 'worker_resumed', workerRole: 'researcher', workerId: 'w1', title: 't', timestamp: 2 },
      { id: '3', type: 'worker_finished', workerRole: 'researcher', workerId: 'w1', cumulativeTotalTimeMs: 100, cumulativeTotalToolsUsed: 0, resumed: false, timestamp: 3 },
    ] as any as DisplayMessage[]

    expect(selectLatestLiveActivityFromMessages(messages)).toBe('active thought')
  })
})
