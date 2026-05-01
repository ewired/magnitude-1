import {
  AuthFailed,
  ContextLimitExceeded,
  InvalidRequest,
  RateLimited,
  TransportError,
  UsageLimitExceeded,
} from '@magnitudedev/ai'
import {
  SubscriptionRequired,
  TrialExpired,
  MagnitudeUsageLimitExceeded,
  ModelNotGrammarCompatible,
  RoleNotFound,
} from '@magnitudedev/magnitude-client'
import type { MagnitudeConnectionError, MagnitudeStreamError } from '@magnitudedev/magnitude-client'
import { BamlClientHttpError, BamlValidationError } from '@magnitudedev/llm-core'
import type { TurnOutcome } from '../events'

export type NonRetryableReason = 'context-limit' | 'auth' | 'parse' | 'client-error' | null

export function authReconnectMessage(): string {
  return 'Magnitude session expired or became invalid. Please reconnect in /settings.'
}

function truncateUnexpectedError(message: string): string {
  const maxLen = 500
  return message.length > maxLen ? `${message.slice(0, maxLen)}...` : message
}

export function classifyConnectionError(error: MagnitudeConnectionError): TurnOutcome {
  switch (error._tag) {
    case 'AuthFailed':
      return {
        _tag: 'ProviderNotReady',
        detail: { _tag: 'AuthFailed', providerId: 'magnitude', providerName: 'Magnitude' },
      }
    case 'SubscriptionRequired':
      return {
        _tag: 'ProviderNotReady',
        detail: {
          _tag: 'MagnitudeBilling',
          reason: { _tag: 'SubscriptionRequired', message: error.message },
        },
      }
    case 'TrialExpired':
      return {
        _tag: 'ProviderNotReady',
        detail: {
          _tag: 'MagnitudeBilling',
          reason: { _tag: 'SubscriptionRequired', message: error.message },
        },
      }
    case 'MagnitudeUsageLimitExceeded':
      return {
        _tag: 'ProviderNotReady',
        detail: {
          _tag: 'MagnitudeBilling',
          reason: { _tag: 'UsageLimitExceeded', message: error.message },
        },
      }
    case 'UsageLimitExceeded':
      return {
        _tag: 'ProviderNotReady',
        detail: {
          _tag: 'MagnitudeBilling',
          reason: { _tag: 'UsageLimitExceeded', message: error.message },
        },
      }
    case 'RoleNotFound':
      return { _tag: 'ProviderNotReady', detail: { _tag: 'NotConfigured' } }
    case 'ModelNotGrammarCompatible':
      return {
        _tag: 'UnexpectedError',
        message: truncateUnexpectedError(error.message),
        detail: { _tag: 'CortexDefect' },
      }
    case 'ContextLimitExceeded':
      return { _tag: 'ContextWindowExceeded' }
    case 'RateLimited':
      return {
        _tag: 'ConnectionFailure',
        detail: { _tag: 'ProviderError', httpStatus: 429 },
      }
    case 'InvalidRequest':
      return {
        _tag: 'UnexpectedError',
        message: truncateUnexpectedError(error.message),
        detail: { _tag: 'CortexDefect' },
      }
    case 'TransportError':
      return error.status !== null && (error.status === 408 || error.status === 429 || error.status >= 500)
        ? { _tag: 'ConnectionFailure', detail: { _tag: 'ProviderError', httpStatus: error.status } }
        : { _tag: 'ConnectionFailure', detail: { _tag: 'TransportError', ...(error.status !== null ? { httpStatus: error.status } : {}) } }
  }
}

export function classifyStreamError(error: MagnitudeStreamError): TurnOutcome {
  return { _tag: 'ConnectionFailure', detail: { _tag: 'TransportError' } }
}

export function classifyRetryability(error: unknown): NonRetryableReason {
  if (error instanceof ContextLimitExceeded) return 'context-limit'
  if (error instanceof AuthFailed) return 'auth'
  if (error instanceof SubscriptionRequired) return 'client-error'
  if (error instanceof TrialExpired) return 'client-error'
  if (error instanceof MagnitudeUsageLimitExceeded) return 'client-error'
  if (error instanceof UsageLimitExceeded) return 'client-error'

  if (error instanceof TransportError) {
    const s = error.status
    if (s !== null && s >= 400 && s < 500 && s !== 408 && s !== 429) return 'client-error'
    return null
  }
  if (error instanceof InvalidRequest) return 'client-error'
  if (error instanceof BamlClientHttpError) {
    const s = error.status_code
    if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429) return 'client-error'
    return null
  }
  if (error instanceof BamlValidationError) return 'parse'
  if (error instanceof RateLimited) return null
  return null
}
