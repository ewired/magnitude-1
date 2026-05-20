import { Schema } from 'effect'

export const ApiKeyAuthSchema = Schema.Struct({
  type: Schema.Literal('api'),
  key: Schema.String,
})
export type ApiKeyAuth = Schema.Schema.Type<typeof ApiKeyAuthSchema>

export const AuthInfoSchema = ApiKeyAuthSchema
export type AuthInfo = ApiKeyAuth

export function isValidAuthInfo(value: unknown): value is AuthInfo {
  return Schema.is(AuthInfoSchema)(value)
}