import { TextAttributes } from '@opentui/core';
import { type ShellState } from '@magnitudedev/agent/src/models';
import { createToolDisplay } from '../types';
import { ShimmerText } from '../../components/shimmer-text';
import { useTheme } from '../../hooks/use-theme';
import { useTerminalWidth } from '../../hooks/use-terminal-width';
import { shortenCommandPreview, truncateToDisplayWidth } from '../../utils/strings';

const SHIMMER_INTERVAL_MS = 160;
const MAX_COMMAND_DISPLAY_LEN = 80;
const PREVIEW_LINE_CAP = 3;
const TRANSCRIPT_LINE_CAP = 1000;

function buildShellPreview(
  lines: string[],
  availableWidth: number,
  maxLines: number,
): { text: string; truncatedCount: number } {
  if (lines.length === 0) {
    return { text: '', truncatedCount: 0 };
  }

  const truncated = lines.map((l) =>
    l.length <= availableWidth ? l : truncateToDisplayWidth(l, availableWidth),
  );

  if (truncated.length <= maxLines) {
    return { text: truncated.join('\n'), truncatedCount: 0 };
  }

  const budget = maxLines - 1; // indicator costs 1 line
  const prefixBudget = Math.ceil(budget / 2);
  const suffixBudget = budget - prefixBudget;

  const prefix = truncated.slice(0, prefixBudget);
  const suffix = truncated.slice(-suffixBudget);
  const collapsedCount = truncated.length - prefixBudget - suffixBudget;

  const displayed = [
    ...prefix,
    `… ${collapsedCount} lines collapsed`,
    ...suffix,
  ];
  return { text: displayed.join('\n'), truncatedCount: collapsedCount };
}

export const shellDisplay = createToolDisplay<ShellState>({
  render: ({ state, mode }) => {
    const theme = useTheme();
    const terminalWidth = useTerminalWidth();
    // paddingLeft: 2 on output text + paddingLeft: 1 in MessageView + 1 for scrollbar
    const availableWidth = Math.max(10, terminalWidth - 4);
    const command = state.command || '';

    const isStreaming = state.phase === 'streaming';
    const isExecuting = state.phase === 'executing';
    const isCompleted = state.phase === 'completed';
    const isError = state.phase === 'error';
    const isRejected = state.phase === 'rejected';
    const isInterrupted = state.phase === 'interrupted';
    const isFailed = isError || (isCompleted && state.exitCode !== undefined && state.exitCode !== 0);

    // Determine output content
    let outputText = '';
    let errorText = '';
    if (isCompleted) {
      if (state.stdout) outputText = state.stdout;
      if (isFailed && state.stderr) errorText = state.stderr;
    } else if (isExecuting) {
      if (state.partialStdout) outputText = state.partialStdout;
      if (state.partialStderr) errorText = state.partialStderr;
    }

    // Build display lines
    const allLines = errorText
      ? errorText.split('\n').concat(outputText ? outputText.split('\n') : [])
      : outputText.split('\n');

    const nonEmptyLines = allLines.filter((l) => l.length > 0);

    // Build the text to display based on mode
    let outputDisplayText: string;
    if (mode === 'default') {
      const { text } = buildShellPreview(
        nonEmptyLines,
        availableWidth,
        PREVIEW_LINE_CAP * 2 + 1,
      );
      outputDisplayText = text;
    } else {
      const hTruncated = nonEmptyLines.map((l) =>
        l.length <= availableWidth ? l : truncateToDisplayWidth(l, availableWidth),
      )
      if (hTruncated.length > TRANSCRIPT_LINE_CAP) {
        const truncatedCount = hTruncated.length - TRANSCRIPT_LINE_CAP;
        outputDisplayText = [...hTruncated.slice(0, TRANSCRIPT_LINE_CAP), `…${truncatedCount} lines hidden. Output capped at ${TRANSCRIPT_LINE_CAP} lines`].join('\n');
      } else {
        outputDisplayText = hTruncated.join('\n');
      }
    }

    return (
      <box style={{ flexDirection: 'column' }}>
        {/* Command line */}
        <text>
          <span style={{ fg: theme.muted }}>{'$ '}</span>
          <span style={{ fg: isStreaming ? theme.muted : theme.foreground }}>
            {mode === 'transcript' ? command : shortenCommandPreview(command, MAX_COMMAND_DISPLAY_LEN)}
          </span>
          {isStreaming && <span style={{ fg: theme.muted }}>{'▍'}</span>}
          {isExecuting && (
            <>
              <span style={{ fg: theme.muted }}>{' · '}</span>
              <ShimmerText
                text="Running…"
                interval={SHIMMER_INTERVAL_MS}
                primaryColor={theme.secondary}
              />
            </>
          )}
          {isCompleted && (
            <span style={{ fg: isFailed ? theme.error : theme.success }}>
              {' '}{isFailed ? `✗ Exit ${state.exitCode}` : '✓'}
            </span>
          )}
          {isError && <span style={{ fg: theme.error }}>{' ✗ Error'}</span>}
          {isRejected && <span style={{ fg: theme.muted }}>{' · Rejected (Permission Policy)'}</span>}
          {isInterrupted && <span style={{ fg: theme.muted }}>{' · Interrupted'}</span>}
        </text>

        {/* Output block */}
        {(isExecuting || isCompleted) && (outputText || errorText) && (
          mode === 'transcript' ? (
            <box style={{ borderStyle: 'single', border: ['left'], borderColor: theme.muted, paddingLeft: 1 }}>
              <text style={{ fg: isFailed ? theme.error : theme.muted }}>
                {outputDisplayText}
              </text>
            </box>
          ) : (
            <text style={{ fg: isFailed ? theme.error : theme.muted, paddingLeft: 2 }}>
              {outputDisplayText}
            </text>
          )
        )}

        {/* Tool error message */}
        {isError && state.errorMessage && (
          <text style={{ fg: theme.error, marginTop: 1, paddingLeft: 2 }}>
            {state.errorMessage}
          </text>
        )}


      </box>
    );
  },
  summary: (state) => {
    const command = state.command.trim();
    if (state.phase === 'streaming' || state.phase === 'executing') return command ? `$ ${command}` : 'Run shell command';
    if (state.phase === 'error') return command ? `Shell error: $ ${command}` : 'Shell error';
    if (state.phase === 'rejected') return command ? `Rejected (Permission Policy): $ ${command}` : 'Shell command rejected';
    return command ? `$ ${command}` : 'Run shell command';
  },
});
