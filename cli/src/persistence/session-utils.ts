import type { StorageClient, StoredSessionMeta } from '@magnitudedev/storage'

export async function listAllSessions(storage: StorageClient, limit?: number): Promise<StoredSessionMeta[]> {
  const ids = await storage.sessions.list()
  const metas: StoredSessionMeta[] = []

  for (const id of ids) {
    try {
      const meta = await storage.sessions.readMeta(id)
      if (meta) {
        metas.push(meta)
      }
    } catch (error) {
      console.error(`Failed to load session ${id}:`, error)
    }
  }

  metas.sort((a, b) => {
    const ta = Date.parse(a.updated)
    const tb = Date.parse(b.updated)
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
  })
  return limit ? metas.slice(0, limit) : metas
}

export async function loadSessionMeta(storage: StorageClient, sessionId: string): Promise<StoredSessionMeta | null> {
  return storage.sessions.readMeta(sessionId)
}
