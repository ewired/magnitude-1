import { describe, expect, test } from 'vitest'
import type { UserPart } from '@magnitudedev/ai'
import { formatResults } from '../render-results'

describe('formatResults', () => {
  test('formats observed image result with wrapper tags around inner content only', () => {
    const output = formatResults([
      {
        kind: 'tool_observation',
        toolName: 'view',
        toolCallId: 'tc-view-1',
        content: [
          {
            _tag: 'ImagePart',
            data: 'dGVzdA==',
            mediaType: 'image/png',
          },
        ],
      },
    ], true)

    expect(output).toEqual([
      { _tag: 'TextPart', text: '\n<view>' },
      { _tag: 'ImagePart', data: 'dGVzdA==', mediaType: 'image/png' },
      { _tag: 'TextPart', text: '</view>' },
    ] satisfies UserPart[])
  })

  test('keeps runtime execution errors unchanged when no correct tool shape is present', () => {
    const output = formatResults([
      {
        kind: 'tool_error',
        toolName: 'read',
        status: 'error',
        message: 'Failed to read does-not-exist.txt',
      },
    ], true)

    expect(output).toEqual([
      {
        _tag: 'TextPart',
        text: '\n<tool name="read"><error>Failed to read does-not-exist.txt</error></tool>',
      },
    ] satisfies UserPart[])
  })

  test('formats no-tools-or-messages notice as plain text result content', () => {
    const output = formatResults([
      {
        kind: 'no_tools_or_messages',
      },
    ], true)

    expect(output).toEqual([
      {
        _tag: 'TextPart',
        text: '\n(no tools or messages were used this turn)',
      },
    ] satisfies UserPart[])
  })
})
