export function expandScratchpadPath(path: string, scratchpadPath: string): string {
  if (path === '$M' || path === '${M}') return scratchpadPath
  if (path.startsWith('$M/')) return scratchpadPath + path.slice(2)
  if (path.startsWith('${M}/')) return scratchpadPath + path.slice(4)

  return path
}
