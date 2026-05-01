/**
 * Tool Image Types
 */

import { Schema } from 'effect'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export const ToolImageSchema = Schema.Struct({
  base64: Schema.String,
  mediaType: Schema.Literal('image/png', 'image/jpeg', 'image/webp', 'image/gif'),
  width: Schema.Number,
  height: Schema.Number,
}).annotations({ identifier: 'ToolImage' })
