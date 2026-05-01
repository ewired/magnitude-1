import type { BrowserActionState } from '@magnitudedev/agent/src/models/browser-action';
import { getBrowserActionBaseLabel, getBrowserActionIcon } from '@magnitudedev/agent/src/tools/browser-action-visuals';
import { createToolDisplay } from '../types';
import { ShimmerText } from '../../components/shimmer-text';
import { useTheme } from '../../hooks/use-theme';

const SHIMMER_INTERVAL_MS = 160;

export const browserActionDisplay = createToolDisplay<BrowserActionState>({
  render: ({ state }) => {
    const theme = useTheme();
    const isRunning = state.phase === 'streaming' || state.phase === 'executing';
    const isError = state.phase === 'error';
    const label = state.label ?? 'Browser action';

    if (isRunning) {
      return (
        <box style={{ flexDirection: 'column' }}>
          <text style={{ wrapMode: 'word' }}>
            <span style={{ fg: theme.info }}>🌐 </span>
            <span style={{ fg: theme.foreground }}>{label}</span>
            {state.detail && (
              <span style={{ fg: theme.muted }}>
                {' '}
                {state.detail}
              </span>
            )}
            <ShimmerText text="..." interval={SHIMMER_INTERVAL_MS} primaryColor={theme.secondary} />
          </text>
        </box>
      );
    }

    return (
      <box style={{ flexDirection: 'column' }}>
        <text style={{ wrapMode: 'word' }}>
          <span style={{ fg: isError ? theme.error : theme.info }}>{isError ? '✗ ' : '🌐 '}</span>
          <span style={{ fg: theme.foreground }}>{label}</span>
          {state.detail && (
            <span style={{ fg: theme.muted }}>
              {' '}
              {state.detail}
            </span>
          )}
          {isError && <span style={{ fg: theme.error }}>{' · Error'}</span>}
        </text>
      </box>
    );
  },
  summary: (state) => {
    const label = (state.label ?? '').trim().replace(/\s+/g, ' ');
    const detail = (state.detail ?? '').trim().replace(/\s+/g, ' ');
    if (label.length === 0) return 'Browser action';
    if (detail.length === 0) return label;
    const noSpaceBeforeDetail = /^[,.;:!?)]/.test(detail);
    const noSpaceAfterLabel = /[([]$/.test(label);
    const separator = (noSpaceBeforeDetail || noSpaceAfterLabel) ? '' : ' ';
    return `${label}${separator}${detail}`;
  },
});
