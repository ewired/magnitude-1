import { BrowserSetupOverlay } from './browser-setup-overlay'
import { RecentChatsOverlay } from './recent-chats-overlay'
import { ForkDetailOverlay } from './fork-detail-overlay'
import { SettingsOverlay } from './settings-overlay'
import type { AgentStatusState } from '@magnitudedev/agent'
import type { RecentChat } from '../data/recent-chats'
import { createCodingAgentClient } from '@magnitudedev/agent'
import { useTheme } from '../hooks/use-theme'
import { BOX_CHARS } from '../utils/ui-constants'

type AgentClient = Awaited<ReturnType<typeof createCodingAgentClient>>

export type AppOverlaysProps = {
  showBrowserSetup: boolean
  setShowBrowserSetup: (v: boolean) => void

  settingsVisible: boolean
  onSettingsClose: () => void
  connectionStatus: {
    connected: boolean
    mode: 'cloud' | 'local' | 'none'
  }
  roles: ReadonlyArray<{
    id: string
    description: string
    model: string
  }>

  showRecentChatsOverlay: boolean
  recentChats: RecentChat[] | null
  recentChatsSelectedIndex: number
  setRecentChatsSelectedIndex: (n: number) => void
  setShowRecentChatsOverlay: (v: boolean | ((prev: boolean) => boolean)) => void
  handleResumeChat: (chat: RecentChat) => void

  expandedForkId: string | null
  client: AgentClient | null
  agentStatusState: AgentStatusState | null
  forkModelSummary: { provider: string; model: string } | null
  forkContextHardCap: number | null
  popForkOverlay: () => void
  pushForkOverlay: (forkId: string) => void
  workspacePath: string | null
  projectRoot: string
  showCopiedToast: boolean
}

export function AppOverlays({
  showBrowserSetup,
  setShowBrowserSetup,
  settingsVisible,
  onSettingsClose,
  connectionStatus,
  roles,
  showRecentChatsOverlay,
  recentChats,
  recentChatsSelectedIndex,
  setRecentChatsSelectedIndex,
  setShowRecentChatsOverlay,
  handleResumeChat,
  expandedForkId,
  client,
  agentStatusState,
  forkModelSummary,
  forkContextHardCap,
  popForkOverlay,
  pushForkOverlay,
  workspacePath,
  projectRoot,
  showCopiedToast,
}: AppOverlaysProps) {
  const theme = useTheme()

  if (showRecentChatsOverlay) {
    return (
      <box style={{ flexDirection: 'column', height: '100%' }}>
        <RecentChatsOverlay
          chats={recentChats ?? []}
          selectedIndex={recentChatsSelectedIndex}
          onSelectedIndexChange={setRecentChatsSelectedIndex}
          onSelect={handleResumeChat}
          onHoverIndex={setRecentChatsSelectedIndex}
          onClose={() => setShowRecentChatsOverlay(false)}
        />
      </box>
    )
  }

  if (expandedForkId && client) {
    const agentId = agentStatusState?.agentByForkId.get(expandedForkId)
    const agent = agentId ? agentStatusState?.agents.get(agentId) : undefined
    return (
      <box style={{ flexDirection: 'column', height: '100%', position: 'relative' }}>
        <ForkDetailOverlay
          forkId={expandedForkId}
          forkName={agent?.name ?? 'Agent'}
          forkRole={agent?.role ?? 'agent'}
          onClose={popForkOverlay}
          onForkExpand={pushForkOverlay}
          modelSummary={forkModelSummary}
          contextHardCap={forkContextHardCap}
          workspacePath={workspacePath}
          projectRoot={projectRoot}
          subscribeForkDisplay={(fId, cb) => client.state.display.subscribeFork(fId, cb)}
          subscribeForkCompaction={(fId, cb) => client.state.compaction.subscribeFork(fId, cb)}
          subscribeForkToolState={(fId, cb) => client.state.toolState.subscribeFork(fId, cb)}
        />

        {showCopiedToast && (
          <box style={{ position: 'absolute', bottom: 1, right: 2 }}>
            <box style={{
              borderStyle: 'single',
              border: ['left'],
              borderColor: theme.success,
              customBorderChars: { ...BOX_CHARS, vertical: '┃' },
            }}>
              <box style={{
                backgroundColor: theme.surface,
                paddingTop: 1,
                paddingBottom: 1,
                paddingLeft: 2,
                paddingRight: 2,
              }}>
                <text style={{ fg: theme.success }}>Copied to clipboard</text>
              </box>
            </box>
          </box>
        )}
      </box>
    )
  }

  if (showBrowserSetup) {
    return (
      <box style={{ flexDirection: 'column', height: '100%' }}>
        <BrowserSetupOverlay
          onClose={() => setShowBrowserSetup(false)}
          onResult={() => setShowBrowserSetup(false)}
        />
      </box>
    )
  }

  if (settingsVisible) {
    return (
      <box style={{ flexDirection: 'column', height: '100%' }}>
        <SettingsOverlay
          isVisible={settingsVisible}
          onClose={onSettingsClose}
          connectionStatus={connectionStatus}
          roles={roles}
        />
      </box>
    )
  }

  return null
}