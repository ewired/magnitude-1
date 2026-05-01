import { Context } from 'effect'
import type { AuthApplicator } from '@magnitudedev/ai'
import type { ModelOverrides } from '@magnitudedev/roles'
import type { ModelProfile } from '@magnitudedev/magnitude-client'

export interface MagnitudeConfigShape {
  readonly endpoint: string
  readonly apiKey: string
  readonly auth: AuthApplicator
  readonly overrides?: ModelOverrides
  readonly defaultProfile: ModelProfile
}

export class MagnitudeConfig extends Context.Tag('MagnitudeConfig')<
  MagnitudeConfig,
  MagnitudeConfigShape
>() {}
