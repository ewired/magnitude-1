/**
 * Web Search Tool
 *
 * Searches the web via MagnitudeClient.
 */

import { Effect, Schema } from 'effect'
import { defineHarnessTool } from '@magnitudedev/harness'
import { MagnitudeClient } from '@magnitudedev/magnitude-client'
import { ToolErrorSchema } from './errors'

const WebSearchErrorSchema = ToolErrorSchema('WebSearchError', {})

export const webSearchTool = defineHarnessTool({
  definition: {
    name: 'web_search',
    description: 'Search the web and optionally extract structured data',
    inputSchema: Schema.Struct({
      query: Schema.String.annotations({ description: 'Search query string' }),
      schema: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }).annotations({ description: 'Optional schema for structured data extraction' }))
    }),
    outputSchema: Schema.Struct({
      text: Schema.String,
      sources: Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String })),
      data: Schema.optional(Schema.Unknown),
    }),
  },
  errorSchema: WebSearchErrorSchema,
  execute: ({ query, schema }, _ctx) =>
    Effect.gen(function* () {
      const client = yield* MagnitudeClient
      const result = yield* client.webSearch(query, schema).pipe(
        Effect.mapError((err) => ({
          _tag: 'WebSearchError' as const,
          message: err.message,
        }))
      )
      return {
        text: result.text,
        sources: [...result.sources],
        data: result.data,
      }
    }),
})
