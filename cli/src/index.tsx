import fs from 'fs'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { Command } from '@commander-js/extra-typings'
import { createStorageClient } from '@magnitudedev/storage'
import { App, type SessionStart } from './app'
import { initThemeStore, useThemeStateStore } from './hooks/use-theme'
import { CLI_VERSION } from './version'
import { StorageProvider } from './providers/storage-provider'
import { isLightBackground } from './utils/theme'
import { installGracefulShutdownHandlers } from './utils/graceful-shutdown'
import { runHeadless } from './commands/headless'

async function main() {
  // Initialize theme store before rendering (defaults to dark)
  initThemeStore()

  const program = new Command()
    .name('magnitude')
    .version(CLI_VERSION)
    .option('--resume [id]', 'Resume the most recent chat session or a specific session by ID')
    .option('--debug', 'Enable debug mode with debug panel')
    .option('--autopilot', 'Launch with autopilot enabled')
    .option('--prompt <text>', 'Start session with an initial user message')
    .option('--headless', 'Run in headless mode (no TUI, output to stdout)')
    .option('--disable-shell-safeguards', 'Disable shell command classification safeguards')
    .option('--disable-cwd-safeguards', 'Disable working directory boundary safeguards')

    .action(async (opts) => {

      const storage = await createStorageClient({ cwd: process.cwd(), currentVersion: CLI_VERSION })
      const sessionStart: SessionStart = opts.resume === undefined
        ? { _tag: 'new' }
        : opts.resume === true
          ? { _tag: 'latest' }
          : { _tag: 'resume', sessionId: opts.resume }

      // Headless mode: skip TUI entirely
      if (opts.headless) {
        const exitCode = await runHeadless({
          storage,
          debug: opts.debug ?? false,
          autopilot: opts.autopilot ?? true, // default ON in headless
          initialPrompt: opts.prompt,
          sessionStart,
          disableShellSafeguards: opts.disableShellSafeguards ?? false,
          disableCwdSafeguards: opts.disableCwdSafeguards ?? false,
        })
        process.exit(exitCode)
      }

      const renderer = await createCliRenderer({
        exitOnCtrlC: false, // We handle Ctrl+C manually for two-tap exit
      })

      // Non-blocking: detect terminal background, switch to light theme if needed
      renderer.getPalette({ timeout: 1000 }).then((colors) => {
        if (colors?.defaultBackground) {
          useThemeStateStore.getState().setTerminalDetectedBg(colors.defaultBackground)
          if (isLightBackground(colors.defaultBackground)) {
            useThemeStateStore.getState().setThemeName('light')
          }
        }
      }).catch(() => {})

      let clientRef: { dispose: () => Promise<void> } | null = null
      let activeSessionId: string | null = null

      installGracefulShutdownHandlers(
        renderer,
        async () => {
          await clientRef?.dispose()
        },
        () => {
          if (!activeSessionId) {
            return
          }
          fs.writeSync(1, `\nResume this session with:\nmagnitude --resume ${activeSessionId}\n`)
        }
      )

      createRoot(renderer).render(
        <StorageProvider client={storage}>
          <App
            sessionStart={sessionStart}
            debug={opts.debug ?? false}
            autopilot={opts.autopilot ?? false}
            initialPrompt={opts.prompt ?? undefined}
            disableShellSafeguards={opts.disableShellSafeguards ?? false}
            disableCwdSafeguards={opts.disableCwdSafeguards ?? false}
            onClientReady={(client) => {
              clientRef = client
            }}
            onSessionId={(id) => {
              activeSessionId = id
            }}
          />
        </StorageProvider>
      )
    })

  program
    .command('serve')
    .description('Start the magnitude API server')
    .option('-p, --port <port>', 'Port to listen on', '8080')
    .option('--host <host>', 'Host to bind to', '127.0.0.1')
    .option('--token <token>', 'Bearer token for authentication')
    .option('--debug', 'Enable debug mode')
    .action(async (options) => {
      const { startServer } = await import('./serve')
      await startServer({
        port: parseInt(options.port),
        host: options.host,
        token: options.token ?? process.env.MAGNITUDE_SERVE_TOKEN,
        debug: options.debug ?? false
      })
    })

  program.parse()
}

main()

