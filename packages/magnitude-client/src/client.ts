import { Context, Effect, Duration } from "effect"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import { Auth } from "@magnitudedev/ai"
import type { RoleId } from "./contract"
import { createModelCatalog, type ModelCatalog } from "./catalog"
import { createRoleSpec } from "./models"

// =============================================================================
// Web Search Types
// =============================================================================

export interface WebSearchResult {
  readonly text: string
  readonly sources: ReadonlyArray<{ readonly title: string; readonly url: string }>
  readonly data?: unknown
}

export class WebSearchError {
  readonly _tag = "WebSearchError"
  constructor(readonly message: string) {}
}

// =============================================================================
// Client Config & Factory
// =============================================================================

export interface MagnitudeClientConfig {
  readonly apiKey?: string
  readonly endpoint?: string
}

const DEFAULT_ENDPOINT = "https://app.magnitude.dev/api/v1"

export interface MagnitudeClientShape {
  readonly catalog: ModelCatalog
  readonly role: (id: RoleId) => {
    stream: ReturnType<ReturnType<ReturnType<typeof createRoleSpec>["bind"]>["stream"]>
    spec: ReturnType<typeof createRoleSpec>
  }
  readonly webSearch: (
    query: string,
    schema?: Record<string, unknown>
  ) => Effect.Effect<WebSearchResult, WebSearchError, HttpClient.HttpClient>
}

export class MagnitudeClient extends Context.Tag("MagnitudeClient")<
  MagnitudeClient,
  MagnitudeClientShape
>() {}

export function createMagnitudeClient(config?: MagnitudeClientConfig): MagnitudeClientShape {
  const apiKey = config?.apiKey ?? process.env.MAGNITUDE_API_KEY
  if (!apiKey) throw new Error("No API key provided. Pass apiKey in config or set MAGNITUDE_API_KEY environment variable.")
  const endpoint = config?.endpoint ?? DEFAULT_ENDPOINT
  const auth = Auth.bearer(apiKey)
  const catalog = createModelCatalog({ endpoint, auth })

  return {
    /** Model catalog — fetch models, look up by role */
    catalog,

    /** Get a bound model for a role — synchronous, no network call needed */
    role: (id: RoleId) => {
      const spec = createRoleSpec(id, endpoint)
      const bound = spec.bind({ auth })
      return {
        stream: bound.stream,
        spec,
      }
    },

    /** Search the web via Magnitude API */
    webSearch: (query, schema) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient

        const headers = new Headers()
        auth(headers)

        const headerRecord: Record<string, string> = {}
        headers.forEach((value, key) => {
          headerRecord[key] = value
        })
        headerRecord["Content-Type"] = "application/json"

        const body = schema ? { query, schema } : { query }

        const request = HttpClientRequest.post(`${endpoint}/web-search`).pipe(
          HttpClientRequest.setHeaders(headerRecord),
          HttpClientRequest.bodyJson(body),
        )

        const response = yield* Effect.flatMap(
          request,
          (req) => http.execute(req)
        ).pipe(
          Effect.mapError((err) => new WebSearchError(`Request failed: ${err}`)),
          Effect.timeoutFail({
            onTimeout: () => new WebSearchError("Request timed out after 10 seconds"),
            duration: Duration.seconds(10),
          }),
        )

        if (response.status < 200 || response.status >= 300) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return yield* Effect.fail(new WebSearchError(`HTTP ${response.status}: ${text}`))
        }

        const text = yield* response.text.pipe(
          Effect.mapError((err) => new WebSearchError(`Failed to read response: ${err}`)),
        )

        let parsed: { text: string; sources: Array<{ title: string; url: string }>; data?: unknown }
        try {
          parsed = JSON.parse(text)
        } catch {
          return yield* Effect.fail(new WebSearchError(`Failed to parse response: ${text.slice(0, 200)}`))
        }

        return {
          text: parsed.text,
          sources: parsed.sources,
          data: parsed.data,
        } satisfies WebSearchResult
      }),
  }
}
