import type { ImagePart, ImageMediaType, ToolResultPart } from '@magnitudedev/ai'
import { ContentBuilder } from '../content'

export function isImageValue(value: unknown): value is Record<string, unknown> & { mediaType: string } {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.mediaType === 'string' &&
    (typeof o.data === 'string' || typeof o.base64 === 'string')
  )
}

export function toImagePart(value: Record<string, unknown> & { mediaType: string }): ImagePart {
  const data = typeof value.data === 'string' ? value.data : value.base64 as string
  const w = value.width, h = value.height
  const dimensions = typeof w === 'number' && typeof h === 'number' ? { width: w, height: h } : undefined
  return {
    _tag: 'ImagePart' as const,
    data,
    mediaType: value.mediaType as ImageMediaType,
    ...(dimensions ? { dimensions } : {}),
  }
}

export function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export function renderField(name: string, value: unknown): string {
  if (!isScalar(value)) {
    return `<${name}>${JSON.stringify(value)}</${name}>`
  }
  const raw = String(value)
  if (raw.includes('\n')) {
    return `<${name}>\n${raw}\n</${name}>`
  }
  return `<${name}>${raw}</${name}>`
}

export function renderObjectOutput(output: Record<string, unknown>): readonly ToolResultPart[] {
  const builder = new ContentBuilder()
  const entries = Object.entries(output).filter(([, v]) => v !== undefined)
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i]
    if (isImageValue(value)) {
      builder.pushText(`<${key}>`)
      builder.pushPart(toImagePart(value))
      builder.pushText(`</${key}>`)
    } else {
      builder.pushText(renderField(key, value))
    }
    if (i < entries.length - 1) builder.pushText('\n')
  }
  return builder.build()
}

export function renderWrapped(tag: string, value: unknown): readonly ToolResultPart[] {
  if (typeof value === 'string') {
    return [{ _tag: 'TextPart', text: `<${tag}>${value}</${tag}>` }]
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const builder = new ContentBuilder()
    builder.pushText(`<${tag}>\n`)
    builder.pushParts(renderObjectOutput(value as Record<string, unknown>))
    builder.pushText(`\n</${tag}>`)
    return builder.build()
  }
  const inner = value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value)
  return [{ _tag: 'TextPart', text: `<${tag}>${inner}</${tag}>` }]
}
