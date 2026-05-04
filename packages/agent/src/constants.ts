/**
 * Agent Configuration Constants
 */

/** Default chat name before title generation */
export const DEFAULT_CHAT_NAME = 'New Chat'

/** Characters per token upper bound (for truncation budgets — higher = fewer tokens per char = more conservative truncation) */
export const CHARS_PER_TOKEN_UPPER = 4

/** Characters per token lower bound (for compaction estimation — lower = more tokens estimated = safer) */
export const CHARS_PER_TOKEN_LOWER = 3

/** Max tokens for a resolved ref in an inspect block */
export const TRUNCATION_TOKEN_LIMIT = 25_000

/** Character equivalent of TRUNCATION_TOKEN_LIMIT */
export const TRUNCATION_CHAR_LIMIT = TRUNCATION_TOKEN_LIMIT * CHARS_PER_TOKEN_UPPER


// =============================================================================
// JS-ACT Prose Delimiters
// =============================================================================

/** Opening prose delimiter for JS-ACT string literals */
export const PROSE_DELIM_OPEN = '<raw>'

/** Closing prose delimiter for JS-ACT string literals */
export const PROSE_DELIM_CLOSE = '</raw>'


// =============================================================================
// Compaction
// =============================================================================

/** Fraction of soft cap to keep as recent messages during compaction */
export const KEEP_MESSAGE_RATIO = 0.1

/** Fraction of messages to trim from compaction input on each retry when input exceeds context window */
export const EMERGENCY_COMPACT_CONTEXT_TRIM_RATIO = 0.2

// =============================================================================
// User Presence
// =============================================================================

/** How long the window must be blurred before a return is considered an extended absence (ms) */
export const USER_AWAY_RETURN_THRESHOLD_MS = 60_000
export const USER_PRESENCE_CONFIRM_DELAY_MS = 3_000
export const USER_BLUR_DEBOUNCE_MS = 5_000

// =============================================================================
