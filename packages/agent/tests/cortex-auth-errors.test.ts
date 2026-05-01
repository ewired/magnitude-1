import { describe, expect, it } from 'vitest'
import {
  AuthFailed,
  UsageLimitExceeded,
} from '@magnitudedev/ai'
import {
  SubscriptionRequired,
  MagnitudeUsageLimitExceeded,
} from '@magnitudedev/magnitude-client'
import {
  classifyConnectionError,
  classifyRetryability,
} from '../src/workers/cortex-auth'

describe('cortex auth reconnect messaging', () => {
  it('classifyConnectionError maps AuthFailed to ProviderNotReady(AuthFailed)', () => {
    const outcome = classifyConnectionError(
      new AuthFailed({ status: 401, message: 'missing_scope: api.responses.write' }),
    )
    expect(outcome).toEqual({
      _tag: 'ProviderNotReady',
      detail: {
        _tag: 'AuthFailed',
        providerId: 'magnitude',
        providerName: 'Magnitude',
      },
    })
  })

  it('classifyRetryability marks AuthFailed cause as auth', () => {
    const reason = classifyRetryability(
      new AuthFailed({ status: 401, message: 'token expired' }),
    )
    expect(reason).toBe('auth')
  })
})

describe('classifyConnectionError', () => {
  it('maps MagnitudeUsageLimitExceeded to ProviderNotReady(MagnitudeBilling)', () => {
    const cause = new MagnitudeUsageLimitExceeded({
      message: 'Weekly usage limit ($50) exceeded for subscription plan.',
      details: { code: 'usage_limit_exceeded_weekly', limit: '$50', period: 'weekly' } as any,
    })
    const outcome = classifyConnectionError(cause)
    expect(outcome).toEqual({
      _tag: 'ProviderNotReady',
      detail: {
        _tag: 'MagnitudeBilling',
        reason: { _tag: 'UsageLimitExceeded', message: 'Weekly usage limit ($50) exceeded for subscription plan.' },
      },
    })
  })

  it('maps UsageLimitExceeded to ProviderNotReady(MagnitudeBilling)', () => {
    const cause = new UsageLimitExceeded({
      status: 429,
      message: 'Clean user message',
    })
    const outcome = classifyConnectionError(cause)
    expect(outcome).toEqual({
      _tag: 'ProviderNotReady',
      detail: {
        _tag: 'MagnitudeBilling',
        reason: { _tag: 'UsageLimitExceeded', message: 'Clean user message' },
      },
    })
  })
})
