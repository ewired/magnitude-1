/**
 * Convert Magnitude toolkits to ATIF `agent.tool_definitions` format.
 *
 * ATIF expects OpenAI function-calling schema:
 *   { type: "function", function: { name, description, parameters } }
 *
 * Magnitude tools use Effect Schema for inputSchema. We convert via
 * `JSONSchema.make(schema)` and clean up Effect metadata ($id, $schema).
 */

import { JSONSchema } from 'effect'
import { getToolkitForRole } from '../../tools/toolkits'
import type { RoleId } from '../../agents/role-validation'

function toToolJsonSchema(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(toToolJsonSchema)
  if (typeof node !== 'object') return node

  const obj = node as Record<string, unknown>
  const keys = Object.keys(obj)
  const isPlaceholder = keys.every((k) => k === '$id' || k === 'title' || k === '$schema')
  if (isPlaceholder) return {}

  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$id' || k === '$schema') continue
    result[k] = typeof v === 'object' ? toToolJsonSchema(v) : v
  }
  return result
}

function schemaToJsonSchema(schema: any): Record<string, unknown> {
  return toToolJsonSchema(JSONSchema.make(schema)) as Record<string, unknown>
}

export function toolDefinitionsFromToolkit(roleId: RoleId): readonly Record<string, unknown>[] {
  const toolkit = getToolkitForRole(roleId)
  const defs: Record<string, unknown>[] = []

  for (const [key, entry] of Object.entries(toolkit.entries)) {
    // Toolkit entries are generic and type-erased at the catalog level.
    // The `.tool` property contains the HarnessTool definition with
    // name, description, and inputSchema — accessed via runtime duck-typing.
    const tool = (entry as { tool?: { name?: string; description?: string; inputSchema?: unknown } }).tool
    if (!tool) continue

    const parameters = tool.inputSchema
      ? schemaToJsonSchema(tool.inputSchema)
      : { type: 'object', properties: {} }

    defs.push({
      type: 'function',
      function: {
        name: tool.name ?? key,
        description: tool.description ?? '',
        parameters,
      },
    })
  }

  return defs
}
