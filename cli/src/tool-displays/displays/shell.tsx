import { TextAttributes } from '@opentui/core';
import { type ShellState } from '@magnitudedev/agent/src/models';
import { createToolDisplay } from '../types';
import { ShimmerText } from '../../components/shimmer-text';
import { useTheme } from '../../hooks/use-theme';
import { useTerminalWidth } from '../../hooks/use-terminal-width';
import { shortenCommandPreview, wrapTextToVisualLines } from '../../utils/strings';

const SHIMMER_INTERVAL_MS = 160;
const MAX_COMMAND_DISPLAY_LEN = 80;
const PREVIEW_LINE_CAP = 3;
const TRANSCRIPT_LINE_CAP = 1000;

function countVisualLines(line: string, width: number): number {
  if (line.length === 0) return 1;
  return wrapTextToVisualLines(line, width).length;
}

function buildShellPreview(
  lines: string[],
  availableWidth: number,
  maxVisualLines: number,
): { text: string; truncatedCount: number } {
  if (lines.length === 0) {
    return { text: '', truncatedCount: 0 };
  }

  const counts = lines.map((l) => countVisualLines(l, availableWidth));
  const totalVisual = counts.reduce((a, b) => a + b, 0);

  if (totalVisual <= maxVisualLines) {
    return { text: lines.join('\n'), truncatedCount: 0 };
  }

  // Need truncation. Indicator costs 1 visual line.
  let budget = maxVisualLines - 1;

  // Greedy prefix
  let prefixCount = 0;
  let prefixVisual = 0;
  const prefixBudget = Math.ceil(budget / 2);
  while (
    prefixCount < lines.length &&
    prefixVisual + counts[prefixCount] <= prefixBudget
  ) {
    prefixVisual += counts[prefixCount];
    prefixCount++;
  }
  budget -= prefixVisual;

  // Greedy suffix from the remaining lines
  let suffixCount = 0;
  let suffixVisual = 0;
  while (
    suffixCount < lines.length - prefixCount &&
    suffixVisual + counts[lines.length - 1 - suffixCount] <= budget
  ) {
    suffixVisual += counts[lines.length - 1 - suffixCount];
    suffixCount++;
  }

  // Edge case: single logical line exceeds the whole budget
  if (prefixCount === 0 && suffixCount === 0 && lines.length > 0) {
    const wrapped = wrapTextToVisualLines(lines[0], availableWidth);
    const visibleWrapped = wrapped.slice(0, budget);
    const remainingWrapped = wrapped.length - visibleWrapped.length;
    const remainingLogical = lines.length - 1;
    const totalCollapsedLogical =
      remainingLogical + (remainingWrapped > 0 ? 1 : 0);
    return {
      text:
        visibleWrapped.join('\n') +
        (totalCollapsedLogical > 0
          ? `\n… ${totalCollapsedLogical} lines collapsed`
          : ''),
      truncatedCount: totalCollapsedLogical,
    };
  }

  const truncatedCount = lines.length - prefixCount - suffixCount;
  const displayed = [
    ...lines.slice(0, prefixCount),
    `… ${truncatedCount} lines collapsed`,
    ...lines.slice(-suffixCount),
  ];
  return { text: displayed.join('\n'), truncatedCount };
}

export const shellDisplay = createToolDisplay<ShellState>({
  render: ({ state, mode }) => {
    const theme = useTheme();
    const terminalWidth = useTerminalWidth();
    const availableWidth = Math.max(10, terminalWidth - 2); // paddingLeft: 2
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
      // Transcript mode: show up to TRANSCRIPT_LINE_CAP lines
      if (nonEmptyLines.length > TRANSCRIPT_LINE_CAP) {
        const truncatedCount = nonEmptyLines.length - TRANSCRIPT_LINE_CAP;
        outputDisplayText = [...nonEmptyLines.slice(0, TRANSCRIPT_LINE_CAP), `…${truncatedCount} lines hidden. Output capped at ${TRANSCRIPT_LINE_CAP} lines`].join('\n');
      } else {
        outputDisplayText = nonEmptyLines.join('\n');
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

        {/* Output block — single <text> node with newlines instead of one node per line */}
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
