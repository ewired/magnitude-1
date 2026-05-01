# CLI Scout Report

Explored: `cli/` folder — Magnitude's terminal UI application

---

## Directory Structure (Top-level)

```
cli/
├── src/                     # Main application source
├── dist/                    # Build output (wasm files, native binaries)
├── scripts/                 # Build scripts (binary, version generation)
├── node_modules/
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## Entry Points

### [`cli/src/index.tsx`](cli/src/index.tsx) — Main CLI entry point

- Uses `@commander-js/extra-typings` to define the `magnitude` CLI
- Handles three commands: default (interactive chat), `serve`, `skills`
- Default command:
  - Creates a CLI renderer via `@opentui/core`
  - Detects terminal background color and auto-switches light/dark theme
  - Initializes storage client from `@magnitudedev/storage`
  - Renders the `<App>` React component inside the terminal
- `magnitude serve` command: starts the HTTP API server
- `magnitude skills reset` command: interactive confirmation to reset global skills
- Installs graceful shutdown handlers to save session ID on exit

### [`cli/src/serve.ts`](cli/src/serve.ts) — HTTP API server

- Runs as a Bun HTTP server (`Bun.serve`)
- Uses `@magnitudedev/storage` for session persistence
- Routes handled:
  - `GET /health` — health check (no auth required)
  - `GET/POST /sessions` and `GET /sessions/:id` — session management
  - `GET /events` and `GET /sessions/:id/events` — SSE event stream
- CORS-enabled for cross-origin requests
- Bearer token authentication via middleware
- Graceful shutdown on SIGINT/SIGTERM

### [`cli/src/app.tsx`](cli/src/app.tsx) — Main React application

- Central state manager for the entire TUI
- Key responsibilities:
  - Creates and manages the agent client via `createCodingAgentClient`
  - Subscribes to agent projections: `display`, `toolState`, `compaction`, `agentStatus`, `taskGraph`
  - Manages overlays: settings, recent chats, fork details, browser setup, usage
  - Handles keyboard input for global actions (Ctrl+C, Ctrl+X, Ctrl+R)
  - Renders the chat timeline, file viewer panel, and input composer
  - Handles session start (new / resume / latest)
  - Integrates slash commands and skills
  - Debug mode support (Ctrl+X toggles debug panel)
  - Telemetry tracking (session start, user messages, turn outcomes)
  - Auto-collapsing completed think blocks
  - Sticky header for active think blocks that scroll off-screen

---

## Commands (`cli/src/commands/`)

### [`command-router.ts`](cli/src/commands/command-router.ts)

- Parses slash command input (e.g., `/settings arg`)
- Provides `CommandContext` interface with handlers for all commands:
  - `resetConversation` — start a new session
  - `showSystemMessage` — display ephemeral message
  - `exitApp` — quit the app
  - `openRecentChats` — open recent chats overlay
  - `enterBashMode` — switch to bash mode
  - `activateSkill` — invoke a skill
  - `initProject` — run the project initialization flow
  - `openSettings / openBrowserSetup / openUsage` — open overlays
- `filterSlashCommands(query)` — for autocomplete menu filtering

### [`slash-commands.ts`](cli/src/commands/slash-commands.ts)

- Defines `SLASH_COMMANDS` array (builtin commands): `new`, `resume`, `exit`, `bash`, `init`, `settings`, `usage`, `browser-setup`
- `registerSkillCommands()` — dynamically adds skill commands at runtime
- `getAllCommands()` — merges builtins with registered skills

### [`init-prompt.ts`](cli/src/commands/init-prompt.ts)

- Contains the `INIT_PROMPT` constant used by the `/init` command

---

## Components (`cli/src/components/`)

### Root-level key components

| File | Purpose |
|------|---------|
| `app-overlays.tsx` | Renders all modal overlays (settings, recent chats, fork details, browser setup, usage) |
| `chat/chat-controller.tsx` | **Core input component**: handles text input, attachments, paste, slash commands, file mentions, bash mode, message submission, history navigation |
| `message-view.tsx` | Renders a single message (user, assistant, think block, agent communication, fork activity, approval request, etc.) |
| `assistant-message.tsx` | Renders an assistant's response with markdown, tool calls, and inline diffs |
| `user-message.tsx` | Renders a user message bubble |
| `think-block.tsx` | Renders an agent's thinking/thinking block (collapsible) |
| `multiline-input.tsx` | The text input component with multiline support, cursor positioning, paste/mention segments |
| `file-mention-menu.tsx` | Autocomplete dropdown for `@filename` mentions |
| `slash-command-menu.tsx` | Autocomplete dropdown for `/command` suggestions |
| `file-viewer-panel.tsx` | Side panel for previewing files referenced in the conversation |
| `pending-communications-panel.tsx` | Shows inbound agent-to-agent messages waiting for the user's approval |
| `approval-request.tsx` | Renders a pending tool approval with approve/reject buttons |
| `debug-panel.tsx` | Shows debug event log and snapshots (Ctrl+X) |
| `settings-overlay.tsx` | Settings panel for API keys, roles, provider config |
| `usage-overlay.tsx` | Shows usage limits and current consumption |
| `recent-chats-overlay.tsx` | Full-screen recent sessions list |
| `diff-view.tsx` | Renders unified diffs with hunk headers |
| `bash-output.tsx` | Renders bash command output in the timeline |
| `chat-controls.tsx` | Buttons (load more, etc.) at the top of the chat |
| `attachments-bar.tsx` | Displays attached images at the bottom of input |
| `context-usage-bar.tsx` | Token count / context percentage display |
| `progress-bar.tsx` | ASCII progress bar |
| `error-message.tsx` | Renders error messages |
| `error-boundary.tsx` | React error boundary wrapper |
| `button.tsx` | Generic button component |
| `mini-wave.tsx` | Animated wave for streaming indicator |
| `shimmer-text.tsx` | Shimmer animation for loading placeholders |

### `cli/src/components/chat/` subdirectory

- `chat-controller.tsx` — main input handler (see above)
- `types.ts` — `ChatControllerProps` interface
- `submit-routing.ts` — determines whether a submit goes to root or fork
- `task-list/` — renders the task tree in the chat (task-list.tsx, display.ts, types.ts, index.ts)
- `paste/` — sophisticated paste handling:
  - `content-resolver.ts` — determines paste intent (image path, file reference, plain text)
  - `apply.ts` — applies paste effects to input state
  - `effects.ts` — derives effects from apply results
  - `ingest-coordinator.ts` — coordinates bulk paste processing

---

## Utils (`cli/src/utils/`)

### Key utility files

| File | Purpose |
|------|---------|
| `theme.ts` | Light/dark theme color definitions |
| `ui-constants.ts` | Box-drawing characters and UI constants |
| `strings.ts` | Text manipulation: mention insertion, display width calculation |
| `clipboard.ts` | Read text and bitmap from system clipboard |
| `pasted-image-path.ts` | Detect image file paths in pasted text |
| `image-scaling.ts` | Auto-scale images to reduce token cost |
| `task-tree.ts` | Render ASCII task tree |
| `bash-executor.ts` | Execute bash commands and format output |
| `graceful-shutdown.ts` | SIGINT/SIGTERM handlers with session persistence |
| `start-state.ts` | Determine if the UI is in "fresh start" mode |
| `live-activity.ts` | macOS Live Activity support (not yet fully implemented) |
| `local-browser-selection.ts` | Browser selection for the browser agent |
| `file-lang.ts` | Detect language from filename for syntax highlighting |
| `color-conversion.ts` | RGBA color utilities |
| `format-elapsed.ts` | Format elapsed time strings |
| `diff-utils.ts` | Diff parsing utilities |
| `palette.ts` | Terminal palette detection |
| `subagent-tabs.ts` | Tab management for subagent views |
| `subagent-role-emoji.ts` | Emoji mappings for agent roles |
| `telemetry-state.ts` | Global telemetry tracker |

---

## Hooks (`cli/src/hooks/`)

~30 React hooks covering all aspects of UI state:

| Category | Hooks |
|----------|-------|
| **State** | `use-tasks.ts`, `use-paginated-timeline.ts`, `use-collapsed-blocks.ts` |
| **Input** | `use-slash-commands.ts`, `use-file-mentions.ts`, `use-paste-handler.ts` |
| **Terminal** | `use-terminal-width.ts`, `use-local-width.tsx` |
| **Theme** | `use-theme.tsx` |
| **Agent** | `use-lazy-client.ts`, `use-magnitude-auth.ts` |
| **Navigation** | `use-recent-chats-navigation.ts`, `use-scroll-to-element.ts`, `use-model-select-navigation.ts` |
| **File** | `use-file-viewer.ts`, `use-file-panel.ts` |
| **Streaming** | `use-streaming-reveal.ts`, `use-panel-streaming.ts` |
| **Safety** | `use-safe-async.ts`, `use-safe-event.ts`, `use-safe-timeout.ts`, `use-safe-interval.ts`, `use-unmount-signal.ts` |
| **Animation** | `use-frozen-base-content.ts`, `use-mounted-ref.ts` |

---

## Serve Backend (`cli/src/serve/`)

```
serve/
├── session-manager.ts     # Manages active agent sessions
├── middleware/
│   └── auth.ts            # Bearer token authentication
└── routes/
    ├── health.ts          # GET /health
    ├── sessions.ts        # GET/POST /sessions
    └── events.ts          # SSE event stream
```

---

## Other notable files

| File | Purpose |
|------|---------|
| `version.ts` | CLI version (auto-generated by build script) |
| `providers/storage-provider.tsx` | React context for the storage client |
| `markdown/` | Markdown parsing and rendering: `parse.ts`, `blocks.ts`, `block-renderer.tsx`, `streaming.ts`, `highlight-file.ts`, `theme.ts`, `table-layout.ts` |
| `persistence/` | Session persistence: `json-chat-persistence.ts`, `session-utils.ts` |
| `data/` | Recent chats and recent tasks lists |
| `types/` | Shared TypeScript types: `store.ts`, `env.ts`, `timeline.ts`, `theme-system.ts` |

---

## Architecture Patterns & Observations

1. **React + OpenTUI**: The CLI is a React application rendered inside a terminal via `@opentui/core` and `@opentui/react`. Uses custom box/text/box primitives instead of HTML.

2. **Effect Layer**: Uses the Effect library (`effect`) for dependency injection and error handling. The agent client uses `Layer.succeed()` to provide the persistence service.

3. **State Management**: Mix of React `useState`/`useRef` for UI state and Zustand-style stores (via `useThemeStateStore`). Agent state comes from observable subscriptions to agent projections.

4. **Slash Commands**: Both built-in commands and dynamically-loaded skill commands share the same `SlashCommandDefinition` interface. Skills are loaded from `~/.magnitude/skills/` at startup.

5. **Paste Handling**: Sophisticated multi-phase paste processing (detect intent → apply to input state → derive effects). Handles image files, file references, and plain text.

6. **Fork Support**: The UI fully supports concurrent agent forks (subagents). The `ChatController` can route messages to a selected fork. Fork overlays show per-fork display state.

7. **Persistence**: Sessions are persisted via `@magnitudedev/storage` using JSON files. The session manager provides SSE event streams for external consumers.

8. **Keyboard Handling**: Global keyboard handler at the `App` level for Ctrl+C, Ctrl+X (debug), Ctrl+R (recent chats). Input-level handler for arrow navigation, tab completion, paste.

9. **Image Support**: Automatic image scaling to reduce token cost, clipboard bitmap reading, file path detection in pasted text.

10. **Testing**: Extensive test coverage alongside components (`.test.ts`, `.test.tsx`, `.integration.test.tsx`). Uses vitest with Bun.