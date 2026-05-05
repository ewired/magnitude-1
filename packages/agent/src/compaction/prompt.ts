/**
 * Compaction prompt construction.
 */

import { Prompt } from '@magnitudedev/ai'
import type { ForkWindowState } from '../window'
import { windowToPrompt } from '../prompts/window-to-prompt'

export const COMPACTION_REFLECTION_PROMPT = `--- CONVERSATION END ---
--- REFLECTION START ---

You are writing a message to your future self. Your response will replace everything above — your future self will see only this message and the recent turns that follow. Everything else from the conversation is permanently lost.

This message serves two purposes: preserving the information your future self needs to continue, and improving on the conversation by reflecting on what happened — mistakes made, approaches that should change, things to do differently next time.

## What you can do this turn

You have exactly one turn. This is it — there is no follow-up.

You have full read-only tool access. Tool results from this turn are preserved in the recent tail and survive into your future self's context. Use tools to read anything your future self will need verbatim: source code, type definitions, configuration, error logs. These are things that cannot survive summarization — read them now so they exist in your future self's context as tool results, rather than as your attempted paraphrase of them.

## Principles

**Loss is irreversible.** Your future self cannot recover anything you omit. It can only act on what you leave behind. This asymmetry means errs of inclusion are far cheaper than errs of omission. When uncertain whether something matters, include it.

**Compress by derivation, not by selection.** Do not select which messages to keep — derive the durable outcomes from them. A long exchange that reaches a conclusion should collapse to that conclusion and the reasoning behind it. The conversation is the process; the reflection should be the product.

**Specificity is how information survives.** Abstract summaries lose the very details that make them actionable. Names, paths, signatures, values, error messages — these are the handles your future self will reach for. Generalities are placeholders that require re-derivation.

**Separate what is known from what is uncertain.** Your future self needs to know what it can rely on versus what still needs validation. Conflate the two and it will either over-trust tentative conclusions or re-derive what was already settled.

**Reflection is not optional — it is where compaction adds value.** A reflection that merely preserves information is a worse version of the original context. The point is to improve on the conversation: identify where reasoning went wrong, what approaches should change, and what your future self should do differently. Mistakes and their root assumptions are the most valuable thing to preserve — your future self faces the same reasoning traps, and naming them is how it avoids them.

## Structure

- **Retention**: What your future self needs to continue — decisions made, work in progress and its current state, user instructions, architectural context. Enough to pick up without re-reading code.
- **Reflection**: What went wrong, what should change, incorrect assumptions, better approaches to take. Not what happened — what your future self should do differently.`

export function buildCompactionPrompt(
  windowState: ForkWindowState,
  systemPrompt: string,
  timezone: string | null,
): Prompt {
  const basePrompt = windowToPrompt(windowState, systemPrompt, timezone)

  return Prompt.from({
    system: basePrompt.system,
    messages: [
      ...basePrompt.messages,
      {
        _tag: 'UserMessage' as const,
        parts: [{ _tag: 'TextPart' as const, text: COMPACTION_REFLECTION_PROMPT }],
      },
    ] as any,
  })
}
