/**
 * Format a duration (in milliseconds) into a human-readable "Resets in" string.
 *
 * Used by the usage overlay and inline error messages for live countdowns.
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Resetting now…'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const weeks = Math.floor(days / 7)
  if (weeks > 0) {
    const remDays = days % 7
    return `${weeks} week${weeks !== 1 ? 's' : ''}, ${remDays} day${remDays !== 1 ? 's' : ''}`
  }
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}, ${hours} hour${hours !== 1 ? 's' : ''}`
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}, ${minutes} minute${minutes !== 1 ? 's' : ''}`
  if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`
  return `${seconds} second${seconds !== 1 ? 's' : ''}`
}
