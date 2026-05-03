/**
 * Error presentation.
 *
 * Single source of truth for what every TurnOutcome looks like to the user
 * (and what it looks like fed back to the model). All copy lives here.
 */

import type {
  TurnOutcome,
  ProviderNotReadyDetail,
  ConnectionFailureDetail,
  SafetyStopReason,
  MagnitudeBillingReason,
} from '../events'

export type ErrorSurface = 'inline' | 'toast' | 'silent'
export type ErrorSeverity = 'error' | 'warning' | 'info'

export interface ErrorCta {
  readonly label: string
  readonly url: string
}

export interface ErrorPresentation {
  /** Where this should appear, if anywhere. */
  readonly surface: ErrorSurface
  readonly severity: ErrorSeverity
  /** User-facing copy. Empty when surface is 'silent'. */
  readonly message: string
  /** Optional link CTA shown beneath the message. */
  readonly cta?: ErrorCta
  /** Text to feed back to the model as observation. Omit for none. */
  readonly llmFeedback?: string
  /** Whether the underlying condition is auto-retried by the agent loop. */
  readonly retryable: boolean
}

const UPGRADE_CTA: ErrorCta = { label: 'Upgrade to Pro', url: 'https://app.magnitude.dev' }
const MANAGE_SUB_CTA: ErrorCta = { label: 'Manage your subscription', url: 'https://app.magnitude.dev' }

const SILENT: ErrorPresentation = {
  surface: 'silent',
  severity: 'info',
  message: '',
  retryable: false,
}

function presentMagnitudeBilling(reason: MagnitudeBillingReason): ErrorPresentation {
  switch (reason._tag) {
    case 'SubscriptionRequired':
    case 'TrialExpired':
      return {
        surface: 'inline',
        severity: 'error',
        message: reason.message,
        cta: UPGRADE_CTA,
        llmFeedback: reason.message,
        retryable: false,
      }
    case 'UsageLimitExceeded':
      return {
        surface: 'inline',
        severity: 'error',
        message: reason.message,
        cta: MANAGE_SUB_CTA,
        llmFeedback: reason.message,
        retryable: false,
      }
  }
}

function presentProviderNotReady(detail: ProviderNotReadyDetail): ErrorPresentation {
  switch (detail._tag) {
    case 'AuthFailed':
      return {
        surface: 'inline',
        severity: 'error',
        message: 'Authentication failed. Run /settings to update your API key.',
        llmFeedback: 'Authentication failed. API key may be invalid or expired.',
        retryable: false,
      }
    case 'MagnitudeBilling':
      return presentMagnitudeBilling(detail.reason)
  }
}

function presentConnectionFailure(detail: ConnectionFailureDetail): ErrorPresentation {
  // Connection failures are auto-retried by the loop. We render a dim status
  // indicator inside the think block (driven separately in display.ts) and
  // feed a short note back to the model. We do NOT render an inline error
  // for each retry — that's noise.
  let llmFeedback: string
  switch (detail._tag) {
    case 'ProviderError':
      llmFeedback = `Connection issue with provider (HTTP ${detail.httpStatus}); retrying.`
      break
    case 'TransportError':
      llmFeedback = detail.httpStatus !== undefined
        ? `Transport connection issue (HTTP ${detail.httpStatus}); retrying.`
        : 'Transport connection issue; retrying.'
      break
    case 'StreamError':
      llmFeedback = 'Response stream interrupted; retrying.'
      break
  }
  return {
    surface: 'silent',
    severity: 'warning',
    message: '',
    llmFeedback,
    retryable: true,
  }
}

function presentSafetyStop(reason: SafetyStopReason): ErrorPresentation {
  let userMessage: string
  let feedback: string
  switch (reason._tag) {
    case 'IdenticalResponseCircuitBreaker':
      userMessage = `Stopped after ${reason.threshold} identical responses`
      feedback = `Safety stop: repeated identical responses reached threshold ${reason.threshold}.`
      break
    case 'Other':
      userMessage = reason.message
      feedback = `Safety stop: ${reason.message}`
      break
  }
  return {
    surface: 'inline',
    severity: 'error',
    message: userMessage,
    llmFeedback: feedback,
    retryable: false,
  }
}

/**
 * Map a TurnOutcome to its presentation.
 *
 * Pure function. Every variant has a single defined behavior here — change
 * copy or routing in one place and every surface picks it up.
 */
export function present(outcome: TurnOutcome): ErrorPresentation {
  switch (outcome._tag) {
    case 'Completed':
      return SILENT
    case 'Cancelled':
      return { ...SILENT, llmFeedback: 'interrupted' }
    case 'ParseFailure':
      return SILENT
    case 'ContextWindowExceeded':
      return {
        surface: 'silent',
        severity: 'warning',
        message: '',
        llmFeedback: 'Context window exceeded; waiting for compaction or context reduction.',
        retryable: false,
      }
    case 'OutputTruncated':
      return {
        surface: 'inline',
        severity: 'error',
        message: 'Response exceeded output limit',
        llmFeedback: 'Output was truncated. Respond in smaller, more bounded steps.',
        retryable: false,
      }
    case 'SafetyStop':
      return presentSafetyStop(outcome.reason)
    case 'ProviderNotReady':
      return presentProviderNotReady(outcome.detail)
    case 'ConnectionFailure':
      return presentConnectionFailure(outcome.detail)
    case 'UnexpectedError':
      return {
        surface: 'inline',
        severity: 'error',
        message: outcome.message,
        llmFeedback: outcome.message,
        retryable: false,
      }
  }
}
