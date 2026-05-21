import { TextAttributes } from '@opentui/core';
import { type ShellState } from '@magnitudedev/agent/src/models';
import { createToolDisplay } from '../types';
import { ShimmerText } from '../../components/shimmer-text';
import { useTheme } from '../../hooks/use-theme';
import { shortenCommandPreview } from '../../utils/strings';

const SHIMMER_INTERVAL_MS = 160;
const MAX_COMMAND_DISPLAY_LEN = 80;
const PREVIEW_LINE_CAP = 3;

export const shellDisplay = createToolDisplay<ShellState>({
  render: ({ state, mode }) => {
    const theme = useTheme();
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

    const nonEmptyLines = allLines.filter(l => l.length > 0);
    const previewLimit = mode === 'transcript' ? Infinity : PREVIEW_LINE_CAP;
    const showPreview = mode === 'default' && nonEmptyLines.length > previewLimit * 2 + 1;
    const displayedLines = showPreview
      ? [
          ...nonEmptyLines.slice(0, previewLimit),
          '…',
          ...nonEmptyLines.slice(-previewLimit),
        ]
      : nonEmptyLines;

    return (
      <box style={{ flexDirection: 'column' }}>
        {/* Command line */}
        <text>
          <span style={{ fg: theme.muted }}>{'$ '}</span>
          <span style={{ fg: isStreaming ? theme.muted : theme.foreground }}>
            {shortenCommandPreview(command, MAX_COMMAND_DISPLAY_LEN)}
          </span>
          {isStreaming && <span style={{ fg: theme.muted }}>{'▍'}</span>}
          {isCompleted && (
            <span style={{ fg: isFailed ? theme.error : theme.success }}>
              {' '}{isFailed ? `✗ Exit ${state.exitCode}` : '✓'}
            </span>
          )}
          {isError && <span style={{ fg: theme.error }}>{' ✗ Error'}</span>}
          {isRejected && <span style={{ fg: theme.muted }}>{' · Rejected'}</span>}
          {isInterrupted && <span style={{ fg: theme.muted }}>{' · Interrupted'}</span>}
        </text>

        {/* Executing: Running… shimmer + live output */}
        {isExecuting && (
          <text style={{ marginTop: 1 }}>
            <span style={{ fg: theme.muted }}>{'  '}</span>
            <ShimmerText
              text="Running…"
              interval={SHIMMER_INTERVAL_MS}
              primaryColor={theme.secondary}
            />
          </text>
        )}

        {/* Output block */}
        {(isExecuting || isCompleted) && (outputText || errorText) && (
          <box style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 2 }}>
            {displayedLines.map((line, i) => {
              // Determine if this line is from stderr (errorText) or stdout
              const errorLineCount = errorText ? errorText.split('\n').length : 0;
              const isErrorLine = errorText && i < errorLineCount && line !== '…';
              return (
                <text key={i} style={{ fg: isErrorLine ? theme.error : theme.muted }}>
                  {line}
                </text>
              );
            })}
            {showPreview && (
              <text style={{ fg: theme.muted }}>
                {`— ${nonEmptyLines.length} lines total`}
              </text>
            )}
          </box>
        )}

        {/* Tool error message */}
        {isError && state.errorMessage && (
          <text style={{ fg: theme.error, marginTop: 1, paddingLeft: 2 }}>
            {state.errorMessage}
          </text>
        )}

        {/* Rejected message */}
        {isRejected && state.errorMessage && (
          <text style={{ fg: theme.muted, marginTop: 1, paddingLeft: 2 }}>
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
    if (state.phase === 'rejected') return command ? `Rejected: $ ${command}` : 'Shell command rejected';
    return command ? `$ ${command}` : 'Run shell command';
  },
});
