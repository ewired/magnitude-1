import { useMemo, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { type ContentState } from '@magnitudedev/agent/src/models';
import { createToolDisplay } from '../types';
import { Button } from '../../components/button';
import { ShimmerText } from '../../components/shimmer-text';
import { DiffHunk } from '../../components/diff-hunk';
import { useTheme } from '../../hooks/use-theme';
import { useStreamingReveal } from '../../hooks/use-streaming-reveal';
import { green } from '../../utils/theme';

const SHIMMER_INTERVAL_MS = 160;

export const contentDisplay = createToolDisplay<ContentState>({
  render: ({ state, onFileClick }) => {
    const theme = useTheme();
    const path = state.path;
    const content = state.body ?? '';
    const [isHovered, setIsHovered] = useState(false);

    const isStreaming = state.phase === 'streaming' || state.phase === 'executing';
    const isDone = state.phase === 'completed';
    const isError = state.phase === 'error' || state.phase === 'interrupted' || state.phase === 'rejected';

    const { displayedContent, showCursor } = useStreamingReveal(content, isStreaming);

    const lines = useMemo(
      () => displayedContent.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== ''),
      [displayedContent],
    );

    if (isDone) {
      return (
        <box style={{ flexDirection: 'column' }}>
          <box style={{ flexDirection: 'row' }}>
            <text>
              <span style={{ fg: theme.info }}>{'✎ '}</span>
              <span style={{ fg: theme.foreground }}>{'Wrote '}</span>
            </text>
            <Button
              onClick={() => { if (path) onFileClick?.(path) }}
              onMouseOver={() => setIsHovered(true)}
              onMouseOut={() => setIsHovered(false)}
            >
              <text>
                <span style={{ fg: isHovered ? theme.link : theme.primary }} attributes={TextAttributes.UNDERLINE}>{String(path ?? 'file')}</span>
              </text>
            </Button>
            <text>
              <span style={{ fg: green[500] }} attributes={TextAttributes.DIM}>{` +${state.lineCount}`}</span>
            </text>
          </box>

          {lines.length > 0 && (
            <DiffHunk
              removedLines={[]}
              addedLines={lines}
              startLine={1}
            />
          )}
        </box>
      );
    }

    return (
      <box style={{ flexDirection: 'column' }}>
        <Button
          onClick={() => { if (path) onFileClick?.(path) }}
          onMouseOver={() => setIsHovered(true)}
          onMouseOut={() => setIsHovered(false)}
        >
          <box style={{ flexDirection: 'column' }}>
            <text style={{ wrapMode: 'word' }}>
              <span style={{ fg: isError ? theme.error : theme.info }}>{isError ? '✗ ' : '✎ '}</span>
              {isError ? (
                <>
                  <span style={{ fg: theme.foreground }}>{'Wrote '}</span>
                  <span style={{ fg: theme.muted }}>{String(path ?? '...')}</span>
                  <span style={{ fg: theme.error }}>{' · Error'}</span>
                </>
              ) : (
                <>
                  <span style={{ fg: theme.foreground }}>{'Writing '}</span>
                  <span style={{ fg: theme.muted }}>{String(path ?? '...')}</span>
                  <ShimmerText text="..." interval={SHIMMER_INTERVAL_MS} primaryColor={theme.secondary} />
                </>
              )}
            </text>
          </box>
        </Button>

        {isStreaming && lines.length > 0 && (
          <DiffHunk
            removedLines={[]}
            addedLines={lines}
            streamingCursor={showCursor}
            startLine={1}
          />
        )}
      </box>
    );
  },
  summary: (state) => {
    const path = state.path || 'file';
    return `Write ${String(path)}`;
  },
});