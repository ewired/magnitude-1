import { safeRenderableAccess, safeRenderableCall } from './safe-renderable-access'

export interface AnchorInfo {
  id: string | null
  offsetRatio: number
}

/**
 * Compute a node's Y offset relative to a given ancestor by walking
 * up the yoga node chain and summing getComputedTop() values.
 */
function getContentRelativeY(node: any, ancestor: any): number {
  let offsetY = 0
  let current: any = node
  while (current && current !== ancestor) {
    const yogaNode = current.yogaNode || current.getLayoutNode?.()
    if (yogaNode) {
      offsetY += yogaNode.getComputedTop()
    }
    current = current.parent
  }
  return offsetY
}

/**
 * Get the content-relative height of a node via its yoga node.
 */
function getNodeHeight(node: any): number {
  const yogaNode = node.yogaNode || node.getLayoutNode?.()
  if (yogaNode) {
    return yogaNode.getComputedHeight()
  }
  return node.height ?? 0
}

// Pattern for OpenTUI auto-generated IDs: box-NNN, text-NNN, scroll-box-*, renderable-NNN
const AUTO_ID_RE = /^(box|text|renderable|scroll-box)-\d+$/

/**
 * Check if an ID is a custom message ID (not an OpenTUI auto-generated one).
 */
function isCustomId(id: string | null | undefined): boolean {
  if (!id) return false
  return !AUTO_ID_RE.test(id)
}

/**
 * Recursively walk the renderable tree and collect nodes that have
 * custom (non-auto-generated) IDs. Skips the contentNode itself.
 */
function collectCustomIdNodes(
  node: any,
  contentNode: any,
): Array<{ node: any; offsetY: number; height: number }> {
  const results: Array<{ node: any; offsetY: number; height: number }> = []

  function walk(n: any) {
    if (!n) return
    // Skip the contentNode itself — it spans the entire content
    if (n === contentNode) {
      const children = n.getChildren?.() ?? []
      for (const child of children) walk(child)
      return
    }
    if (isCustomId(n.id)) {
      results.push({
        node: n,
        offsetY: getContentRelativeY(n, contentNode),
        height: getNodeHeight(n),
      })
    }
    const children = n.getChildren?.() ?? []
    for (const child of children) walk(child)
  }

  walk(node)
  return results
}

/**
 * Capture which content child is at the viewport center.
 * Only considers nodes with custom (message) IDs, not OpenTUI auto-generated ones.
 */
export function captureScrollAnchor(
  scrollbox: any,
  options?: { mountedRef?: React.RefObject<boolean> },
): AnchorInfo | null {
  return safeRenderableAccess(
    scrollbox,
    (sb) => {
      const viewportHeight = sb.viewport?.height ?? 0
      const scrollTop = sb.scrollTop ?? 0
      const scrollHeight = sb.scrollHeight ?? 0
      if (scrollHeight <= viewportHeight) return null

      const contentNode = sb.content
      if (!contentNode) return null

      const viewportCenter = scrollTop + viewportHeight / 2

      const idNodes = collectCustomIdNodes(contentNode, contentNode)

      // Find the node whose Y range contains the viewport center
      for (const entry of idNodes) {
        const { node, offsetY, height } = entry
        const bottom = offsetY + height
        if (viewportCenter >= offsetY && viewportCenter <= bottom) {
          return {
            id: node.id ?? null,
            offsetRatio: height > 0 ? (viewportCenter - offsetY) / height : 0,
          }
        }
      }

      // If center falls between nodes, find the nearest one
      let nearest: { node: any; offsetY: number; height: number; dist: number } | null = null
      for (const entry of idNodes) {
        const midY = entry.offsetY + entry.height / 2
        const dist = Math.abs(midY - viewportCenter)
        if (!nearest || dist < nearest.dist) {
          nearest = { ...entry, dist }
        }
      }

      if (nearest) {
        return {
          id: nearest.node.id ?? null,
          offsetRatio: nearest.height > 0
            ? Math.max(0, Math.min(1, (viewportCenter - nearest.offsetY) / nearest.height))
            : 0.5,
        }
      }

      return null
    },
    { mountedRef: options?.mountedRef, fallback: null },
  )
}

/**
 * Restore scroll position to a previously captured anchor.
 * Uses findDescendantById + yoga node offset computation.
 */
export function restoreScrollToAnchor(
  scrollbox: any,
  anchor: AnchorInfo | null,
): boolean {
  if (!anchor?.id) return false

  return safeRenderableCall(
    scrollbox,
    (sb) => {
      const contentNode = sb.content
      if (!contentNode) return

      const targetEl = contentNode.findDescendantById(anchor.id!)
      if (!targetEl) return

      const offsetY = getContentRelativeY(targetEl, contentNode)
      const targetHeight = getNodeHeight(targetEl)
      const viewportHeight = sb.viewport?.height ?? 0

      const targetScrollTop = offsetY + targetHeight * anchor.offsetRatio - viewportHeight / 2

      sb.scrollTo(Math.max(0, targetScrollTop))
    },
    {},
  )
}
