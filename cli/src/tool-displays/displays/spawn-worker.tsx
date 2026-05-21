import { TextAttributes } from '@opentui/core';
import { type SpawnWorkerState } from '@magnitudedev/agent/src/models';
import { createToolDisplay } from '../types';
import { ShimmerText } from '../../components/shimmer-text';
import { useTheme } from '../../hooks/use-theme';
import { useStreamingReveal } from '../../hooks/use-streaming-reveal';
import { BOX_CHARS } from '../../utils/ui-constants';
import { violet } from '../../utils/theme';

const SHIMMER_INTERVAL_MS = 160;

export const spawnWorkerDisplay = createToolDisplay<SpawnWorkerState>({
  render: ({ state, mode }) => {
    const theme = useTheme();
    const message = state.message ?? '';
    const isStreaming = state.phase === 'streaming' || state.phase === 'executing';
    const isError = state.phase === 'error' || state.phase === 'rejected' || state.phase === 'interrupted';
    const isCompleted = state.phase === 'completed';

    const { displayedContent, showCursor } = useStreamingReveal(message, isStreaming);

    // Default mode: only show lifecycle stubs, no prompt content
    if (mode === 'default') {
      if (isStreaming || isError) {
        const wordCount = displayedContent.trim() ? displayedContent.trim().split(/\s+/).length : 0;
        return (
          <text>
            <span style={{ fg: violet[300] }}>{'▶ '}</span>
            <span style={{ fg: theme.muted }}>{'Starting worker '}</span>
            <span style={{ fg: theme.foreground }}>{state.agentId}</span>
            {state.role && (
              <span style={{ fg: theme.muted }}>{' · '}{state.role}</span>
            )}
            {isStreaming && (
              <>
                <ShimmerText text="…" interval={SHIMMER_INTERVAL_MS} primaryColor={theme.muted} />
                <span style={{ fg: theme.muted }}>{' · '}{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
              </>
            )}
            {isError && <span style={{ fg: theme.error }}>{' · Error'}</span>}
          </text>
        );
      }

      if (isCompleted) {
        return (
          <text>
            <span style={{ fg: violet[300] }}>{'▶ '}</span>
            <span style={{ fg: theme.muted }}>{'Worker '}</span>
            <span style={{ fg: theme.foreground }}>{state.agentId}</span>
            <span style={{ fg: theme.muted }}>{' started'}</span>
            {state.role && (
              <span style={{ fg: theme.muted }}>{' · '}{state.role}</span>
            )}
          </text>
        );
      }

      return null;
    }

    // Transcript mode: show full streaming prompt as it currently works
    // Completed state: worker has started
    if (isCompleted) {
      return (
        <text>
          <span style={{ fg: violet[300] }}>{'▶ '}</span>
          <span style={{ fg: theme.muted }}>{'Start worker '}</span>
          <span style={{ fg: theme.foreground }}>{state.agentId}</span>
          {state.title && <span style={{ fg: theme.muted }}>{' — '}{state.title}</span>}
        </text>
      );
    }

    return (
      <box style={{ flexDirection: 'column' }}>
        <text style={{ wrapMode: 'word' }}>
          {isError ? (
            <>
              <span style={{ fg: theme.error }}>{'✗ '}</span>
              <span style={{ fg: theme.muted }}>{'Start worker '}</span>
              {state.agentId && <span style={{ fg: theme.foreground }}>{state.agentId}</span>}
              <span style={{ fg: theme.muted }}>{' with prompt'}</span>
              <span style={{ fg: theme.error }}>{' · Error'}</span>
            </>
          ) : (
            <>
              <span style={{ fg: theme.muted }}>{'Start worker '}</span>
              {state.agentId && <span style={{ fg: theme.foreground }}>{state.agentId}</span>}
              <span style={{ fg: theme.muted }}>{' with prompt'}</span>
              <ShimmerText text="..." interval={SHIMMER_INTERVAL_MS} primaryColor={theme.muted} />
            </>
          )}
        </text>
        {isStreaming && displayedContent.length > 0 && (
          <box style={{
            borderStyle: 'single',
            borderColor: theme.border,
            customBorderChars: BOX_CHARS,
            height: 8,
          }}>
            <scrollbox
              onMouseScroll={(e) => e.stopPropagation()}
              stickyScroll
              stickyStart="bottom"
              scrollX={false}
              scrollbarOptions={{ visible: false }}
              verticalScrollbarOptions={{ visible: false }}
              style={{
                flexGrow: 1,
                rootOptions: { flexGrow: 1, backgroundColor: 'transparent' },
                wrapperOptions: { border: false, backgroundColor: 'transparent', paddingLeft: 1, paddingRight: 1 },
                contentOptions: { justifyContent: 'flex-start' },
              }}
            >
              <text style={{ fg: theme.muted, wrapMode: 'word' }} attributes={TextAttributes.DIM}>
                {displayedContent}
                {showCursor && <span style={{ fg: theme.info }}>{'▎'}</span>}
              </text>
            </scrollbox>
          </box>
        )}
      </box>
    );
  },
  summary: (state) => {
    const id = state.agentId ? ` ${state.agentId}` : '';
    if (state.phase === 'completed') {
      return `Worker${id} started${state.role ? ` · ${state.role}` : ''}`;
    }
    if (state.phase === 'streaming' || state.phase === 'executing') return `Starting worker${id}${state.role ? ` · ${state.role}` : ''}...`;
    if (state.phase === 'error') return `Starting worker${id} · Error`;
    if (state.phase === 'rejected') return `Starting worker${id} · Rejected`;
    if (state.phase === 'interrupted') return `Starting worker${id} · Interrupted`;
    return `Starting worker${id}`;
  },
});
