/**
 * Recent chats data layer
 * 
 * Uses centralized session utilities to load session summaries
 */

import type { StorageClient, StoredSessionMeta } from '@magnitudedev/storage'
import { listAllSessions } from '../persistence/session-utils'

export interface RecentChat {
  id: string
  title: string
  lastMessage: string
  timestamp: number
  messageCount: number
  workingDirectory: string
}

const MAX_RECENT_CHATS = 100

/**
 * Get recent chats from sessions that were started in the given cwd.
 */
export async function getRecentChats(storage: StorageClient, cwd: string, limit = MAX_RECENT_CHATS): Promise<RecentChat[]> {
  const metas = await listAllSessions(storage)
  const filtered = metas.filter(m => m.workingDirectory === cwd)
  
  return filtered.slice(0, limit).map(meta => ({
    id: meta.sessionId,
    title: meta.chatName,
    lastMessage: meta.lastMessage ?? 'No messages yet',
    timestamp: Date.parse(meta.updated) || Date.parse(meta.created),
    messageCount: meta.messageCount,
    workingDirectory: meta.workingDirectory,
  }))
}

/**
 * Format a timestamp as relative time
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMinutes = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'yesterday'
  return `${diffDays}d ago`
}
