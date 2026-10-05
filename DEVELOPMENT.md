# Development

## Requirements

- Node.js 22 or newer (`package.json` declares `engines: node >=22`); the CI matrix also runs on Node 20, so treat Node 20 as the floor when using newer Node APIs
- npm 10+
- 运行 runtime（`dev:full`、`dogfood`、`node dist/cli.js`）和根项目测试时，Node 的大版本必须与安装 `node_modules` 时一致：关系账本用的 better-sqlite3 是原生模块，ABI 不符就打不开，runtime 会把 board 置为只读，报错里带 `NODE_MODULE_VERSION`。`dev:full` / `dogfood` 按 PATH 取 node，PATH 上的版本与装依赖时不同就会撞上。task worktree 的 `node_modules` 软链到主 checkout，不要在 worktree 里 `npm rebuild`，那会改掉正在服务的 runtime 所用的那份。

## Install

See [`installation.md`](installation.md) (the single source for prerequisites, installing all three npm projects, and the global `kanban` link). The short version:

```bash
npm run install:all
```

### Working on the exploration thread graph core package

会话结构建模不在本仓库——它是独立包 `agent-conversation-exploration-thread-graph`，经 `github:` 依赖
钉 SHA 引入（见 `docs/exploratory-mode-host-integration.md` §9）。日常开发本仓库时**不需要**任何额外步骤，
`npm ci` 会自动从 GitHub 装并跑它的 `prepare` 构建。

只有当你要**同时改那个包**时，才在装完依赖后接上本地副本：

```bash
npm link agent-conversation-exploration-thread-graph   # 需先在该包目录跑过 npm link
```

改完记得解除（`npm unlink` 后重新 `npm ci`），否则本仓库会一直编译在一份未提交的包上。
升级该包 = 换根 `package.json` 里那个 SHA，然后跑 `npm run typecheck`——契约对账会在形状漂移时当场报错。

## Hot reload workflow

Fast path:

```bash
npm run dev:full
```

- Starts the runtime in watch mode and the Vite web UI dev server together
- Auto-picks free runtime and web UI ports so multiple checkouts can run side by side
- Best for day-to-day source development, especially web UI work and runtime changes that benefit from fast iteration

Manual equivalent in two terminals:

1. Runtime server (API + PTY agent runtime):

```bash
npm run dev
```

- Runs on `http://127.0.0.1:3484`

2. Web UI (Vite HMR):

```bash
npm run web:dev
```

- Runs on `http://127.0.0.1:4173`
- `/api/*` requests from Vite are proxied to `http://127.0.0.1:3484`

Use `http://127.0.0.1:4173` while developing UI so changes hot reload.

## Choose the right workflow

Use `npm run dev:full` when you are actively developing Kanban and want fast iteration. It runs the source checkout with `tsx watch` plus the Vite web UI dev server, so runtime changes reload and web UI changes get HMR.

Shutdown is non-destructive by default: stopping a debug/dev instance does not move cards or delete task worktrees.

If `node_modules` has not been installed in this worktree, `dev:full` auto-runs `npm ci` before launch.

Use `npm run dogfood` when you want to validate the latest built CLI behavior more realistically. It builds the current checkout and launches `dist/cli.js`, which is better for checking packaged behavior, startup and shutdown flows, multi-instance dogfooding, and launch behavior against a target project.

## VS Code F5 debugging

The repo includes `.vscode/launch.json` with two configurations:

- `Dev (Full Stack)`: Launches the same workflow as `npm run dev:full`, starting both the runtime and Vite in one terminal.
- `Run Tests`: Runs `vitest run` with the debugger so you can set breakpoints in tests.

## Build and run packaged CLI

```bash
npm run build
node dist/cli.js
```

This mode serves built web assets from `dist/web-ui` and does not hot reload the web UI.

Runtime port options:

```bash
# fixed port
node dist/cli.js --port 3484

# pick the first free port starting at 3484
node dist/cli.js --port auto
```

You can still use `KANBAN_RUNTIME_PORT` if needed, but `--port` is preferred for local multi-instance runs.

## Long-lived tmux launch

When launching a reusable local Kanban server for automation or RVF, run it in tmux session `cline-kanban` or `cline-kanban-<port>`. For the default port:

```bash
tmux new-session -d -s cline-kanban-3484 -c "$PWD" \
  'exec kanban --no-open --port 3484'
```

RVF uses the tmux session name, not the server process cwd, to decide whether an existing listener is a Cline Kanban runtime it may reuse. A listener in an unrelated tmux session, a legacy `vibe-kanban` session, or no tmux session should be treated as foreign even if the command line contains `kanban`.

## Dogfooding with two Kanban instances

Run your stable orchestrator first (main checkout):

```bash
cd /path/to/kanban-main
npm run build
node dist/cli.js --port 3484
```

Then run a test checkout against a target project (feature worktree):

```bash
cd /path/to/kanban-feature-worktree
npm run dogfood -- --project /path/to/target/repo --port auto
```

If `--project` is omitted, the launcher starts Kanban from a non-git cwd so runtime behaves like launching outside a git repo and opens the first indexed project (if any):

```bash
npm run dogfood -- --port auto
```

Dogfood launcher behavior:

- builds the current checkout by default
- launches `dist/cli.js` with `cwd` set to the target project
- supports `--port <number|auto>`
- supports `--no-open`
- supports `--skip-build` when you already built and want faster restarts
- is the right choice when you want to test the latest built CLI rather than the source-mode dev server

## Run `kanban` from any directory

The global CLI link workflow (`npm run link`, verifying with `which kanban` / `kanban --version`, rebuilding after code changes, re-linking when switching worktrees, and `npm run unlink`) is documented in [`installation.md`](installation.md).

For sidebar agent automation guidance, inspect `src/prompts/append-system-prompt.ts`.

## Scripts

- `npm run build`: build runtime and bundled web UI into `dist`
- `npm run dogfood -- [--project <path>] [--port <number|auto>] [--no-open] [--skip-build]`: build and launch this checkout, optionally targeting a specific project path
- `npm run dev`: run CLI in watch mode
- `npm run dev:full`: run the runtime watch server and Vite web UI dev server together
- `npm run web:dev`: run web UI dev server
- `npm run web:build`: build web UI
- `npm run typecheck`: typecheck runtime
- `npm run web:typecheck`: typecheck web UI
- `npm run test`: run runtime tests
- `npm run web:test`: run web UI tests
- `npm run check`: lint, typecheck, and test runtime package
- `npm run install:agent-skills [-- --dry-run]`: link this checkout's globally invocable agent skills into `~/.claude/skills`, `~/.codex/skills` and (when present) `~/.hermes/skills`

## Agent skills

Skills live in `.codex/skills/<name>/`. Most are project-local and are exposed through a committed `.claude/skills/<name>` symlink, so they are only visible while working inside this repository.

A skill that must be callable from *another* repository's task worktree is instead installed globally with `npm run install:agent-skills`, and must not also carry a project-local `.claude/skills` symlink — a skill belongs to exactly one scope. `cline-kanban-survey-sibling-task-work-in-same-workspace` is such a skill: agents planning work in any repository use it to see, read-only, what the other kanban tasks in that repository are doing.

Run the installer from this durable main checkout only. It refuses to run from a linked git worktree or from anywhere under `~/.cline/worktrees/`, because a global symlink into a task worktree breaks as soon as that worktree is removed.

## Manual probes against real agents

These are **not** part of `npm run check` or CI: they drive real agent binaries and depend on real TUI
rendering. Run them by hand when you touch the code they cover, or after an agent's major version bump.

- `npx tsx scripts/acp-protocol-smoke.ts`: protocol-level smoke against a real ACP agent (`omp` by default).
- `npx tsx scripts/claude-terminal-input-box-grammar-drift-probe.ts`: drift sentinel for the Claude TUI
  input-box grammar and paste-folding thresholds that W1 (honest terminal delivery) and W2 (Ctrl+S stash)
  are built on. Makes **zero API calls** — it never submits a message, it only observes the empty input
  box and bracketed-paste folding. Run it after changing `CLAUDE_TERMINAL_INPUT_BOX_GRAMMAR`
  (`src/terminal/terminal-input-box-reader.ts`) or when Claude Code updates: the in-repo unit tests feed
  hand-built screen snapshots, so they stay green even when the real grammar has drifted out from under them.

## Tests

- `test/agent-skills`: tests for the agent skills shipped in `.codex/skills` and their installer
- `test/integration`: integration tests for runtime behavior and startup flows
- `test/runtime`: runtime unit tests
- `test/utilities`: shared test helpers

## Agent tracking and runtime hooks

Kanban tracks agent session state with runtime hook events. The core transition model is:

- `in_progress -> review`
- `review -> in_progress`

Internal runtime session states are named `running` and `awaiting_review`, and hook events are transition intents:

- `to_in_progress` for `review -> in_progress`
- `to_review` for `in_progress -> review`

How it works end to end:

1. `prepareAgentLaunch` wires each agent with hook commands or hook-aware wrappers.
2. Hook handlers call `kanban hooks ...` subcommands.
3. `kanban hooks ingest --event <to_review|to_in_progress>` reads hook context from env:
   - `KANBAN_HOOK_TASK_ID`
   - `KANBAN_HOOK_WORKSPACE_ID`
4. The ingest command calls runtime TRPC `hooks.ingest`.
5. The runtime applies guarded transitions and ignores duplicates or invalid transitions as no-ops.

CLI timeout and runtime connection env vars (`KANBAN_CLI_HARD_TIMEOUT_MS`, `KANBAN_CLI_TRPC_TIMEOUT_MS`, `KANBAN_HOOK_INGEST_TIMEOUT_MS`, `KANBAN_RUNTIME_HOST`, `KANBAN_RUNTIME_PORT`) are documented in [`docs/cli-environment.md`](docs/cli-environment.md).

Current agent mappings:

These are external agent/file-hook names where the agent config requires them.
They are distinct from Cline SDK plugin runtime hooks such as `beforeRun`,
`beforeTool`, `afterTool`, and `afterRun`.

The authoritative wiring lives in `src/terminal/agent-session-adapters.ts` (per-agent
adapters) and `src/terminal/kimi-hook-config.ts` (Kimi's TOML hooks) — update this list
when those change.

- Claude
  - `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` emit `to_in_progress`
  - `Stop`, `PermissionRequest`, and `Notification` with `permission_prompt` emit `to_review`
- Codex
  - wrapper enables TUI session logging and maps:
    - `task_started` and `exec_command_begin` to `to_in_progress`
    - `*_approval_request` to `to_review`
  - Codex `notify` completion path also emits `to_review`
- Cursor
  - no hook surface: the adapter only prepares launch args (`cursorAdapter`, `agent-session-adapters.ts:1188`)
  - no prompt detector either: `detectOutputTransition` is registered only for claude (`:1006`), codex (`:1182`), kimi (`:1963`), and omp (`:2030`), so Cursor emits no `agent.prompt-ready` adapter events
  - the only automatic path into Review is the idle-stall self-heal `transitionToReview(taskId, "idle_stall")` (`session-manager.ts:4648`, reason gate at `:4060-4062`); anything else is the user's manual review action
- Gemini
  - `BeforeAgent` and `AfterTool` emit `to_in_progress`
  - `AfterAgent` emits `to_review`
  - hook command writes `{}` to stdout immediately to satisfy Gemini hook contract, then notifies in background
- OpenCode
  - plugin maps busy activity to `to_in_progress`
  - plugin maps idle/error and permission ask to `to_review`
  - plugin filters child sessions to avoid false transitions from nested runs
- Droid
  - `PreToolUse` for active tools like `Read`, `Grep`, `Glob`, `FetchUrl`, `WebSearch`, `Execute`, `Task`, `Edit`, and `Create` emits `to_in_progress`
  - `PreToolUse` for `AskUser` and `Stop` emit `to_review`
  - `PostToolUse` for `AskUser` and `UserPromptSubmit` emit `to_in_progress`
- Kimi
  - TOML `[[hooks]]` tables written into a Kanban-managed seeded `KIMI_CODE_HOME` (Kimi only reads hooks from its resolved home `config.toml`, not from the project)
  - `UserPromptSubmit`, `PostToolUse`, and `PostToolUseFailure` emit `to_in_progress`; `PreToolUse` emits `activity`
  - `PermissionRequest`, `Stop`, and `StopFailure` emit `to_review`

Important behavior details:

- Hooks are best-effort and should not crash or block the underlying agent process.
- Hook notify paths are asynchronous to keep agent UX responsive.
- Runtime transition guards are authoritative and prevent state flapping from duplicate events.
- Hook transport is implemented in Node and invoked through `kanban hooks ...`, so the behavior is consistent across Windows and non-Windows environments.

For a full technical breakdown, see:

- `.plan/docs/runtime-hooks-architecture.md`

## PostHog telemetry config

The web UI reads PostHog settings at build time:

- `POSTHOG_KEY`
- `POSTHOG_HOST`

Local development:
- Set these in `web-ui/.env.local` (see `web-ui/.env.example`).
- If `POSTHOG_KEY` is missing, telemetry does not initialize.

Release builds:
- The publish workflow injects `POSTHOG_KEY` and `POSTHOG_HOST` from GitHub Secrets.
- `POSTHOG_HOST` is optional and defaults to `https://data.cline.bot`.

Result:
- Official releases have telemetry enabled.
- Forks and source builds have telemetry disabled unless a key is explicitly provided.
