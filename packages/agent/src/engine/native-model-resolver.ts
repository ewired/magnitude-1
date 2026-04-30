/**
 * NativeModelResolver — Context.Tag for resolving NativeBoundModels.
 *
 * Resolves a roleId to a NativeBoundModel by reading provider config and auth.
 */

import { Context, Effect, Layer, Schema } from 'effect'
import type { NativeBoundModel } from './native-bound-model'

// =============================================================================
// Errors
// =============================================================================

export class NativeModelNotConfigured extends Schema.TaggedError<NativeModelNotConfigured>()(
  'NativeModelNotConfigured',
  { roleId: Schema.String },
) {}

// =============================================================================
// Service shape
// =============================================================================

export interface NativeModelResolverShape {
  readonly resolve: (
    roleId: string,
  ) => Effect.Effect<NativeBoundModel, NativeModelNotConfigured>
}

export class NativeModelResolver extends Context.Tag('NativeModelResolver')<
  NativeModelResolver,
  NativeModelResolverShape
>() {}

