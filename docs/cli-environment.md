# CLI environment variables

Kanban inherits your shell environment when launched from the terminal. Hook subprocesses and automation bridges (RVF, Overwatch, Claude Code hooks) spawn short-lived `kanban` CLI children the same way.

This page documents environment variables that affect **CLI subprocess behavior** — especially timeouts and hook ingest. For runtime server bind options, prefer CLI flags such as `--port` and `--host` when possible.

## Runtime connection

| Variable | Default | Applies to | Description |
|----------|---------|------------|-------------|
| `KANBAN_RUNTIME_HOST` | `127.0.0.1` | CLI subcommands, web UI | Hostname or IP of the Kanban runtime HTTP server. |
| `KANBAN_RUNTIME_PORT` | `3484` | CLI subcommands, web UI | TCP port of the Kanban runtime. `--port` on `kanban` launch overrides this for that process. |

Subcommands such as `kanban task list` and `kanban hooks ingest` reach the runtime through these settings. If nothing is listening, the CLI should fail fast and exit (see timeout variables below).

## CLI subprocess timeouts

These guards apply to **short-lived subcommands** (`kanban task …`, `kanban hooks ingest`, etc.). They do **not** apply to a long-running `kanban` server launch (`kanban`, `kanban --port 3484`, …).

| Variable | Default | Exit behavior | Description |
|----------|---------|---------------|-------------|
| `KANBAN_CLI_HARD_TIMEOUT_MS` | `35000` | `124` | Watchdog: the CLI process must exit within this many milliseconds after start, whether or not the command succeeded. Prevents orphaned `kanban task list` / `hooks ingest` children from running indefinitely. Cancelled as soon as the subcommand finishes so telemetry flush can run with the intended `process.exitCode`. |
| `KANBAN_CLI_TRPC_TIMEOUT_MS` | `28000` | `1` (command error JSON) | Per-request timeout for task-oriented tRPC calls from the CLI (for example `workspace.getState` in `kanban task list`). Must stay below `KANBAN_CLI_HARD_TIMEOUT_MS` with enough margin for subcommand shutdown (telemetry flush is capped at ~500ms). |
| `KANBAN_HOOK_INGEST_TIMEOUT_MS` | `3500` | `1` (stderr + non-zero) | Single-attempt timeout for `kanban hooks ingest` delivery to the runtime. Retries are bounded separately inside the ingest command; see `src/commands/hooks.ts`. |

### Tuning notes

- **Timeout ordering**: Keep `KANBAN_CLI_TRPC_TIMEOUT_MS` well below `KANBAN_CLI_HARD_TIMEOUT_MS`. Defaults leave a **7s** margin (`35000 − 28000`) so a tRPC timeout can print `"ok": false` JSON, flush telemetry (~500ms), and exit with code **1** before the watchdog fires with **124**.
- **Hook ingest budget**: `kanban hooks ingest` may retry transport failures twice with backoff (`src/commands/hooks.ts`). With defaults, worst-case ingest time is about `3500 × 2 + 250 ≈ 7.25s`, which fits inside the 35s hard timeout. If you raise `KANBAN_HOOK_INGEST_TIMEOUT_MS`, ensure `KANBAN_CLI_HARD_TIMEOUT_MS` stays above `(timeout × max_attempts) + backoff + a few seconds`.
- **Automation / hooks**: If ingest frequently logs `timed out after 3500ms` under load, raise `KANBAN_HOOK_INGEST_TIMEOUT_MS` modestly (for example `5000`). The server-side ingest path is usually sub-second; persistent timeouts often mean runtime overload or lock contention, not a need for very large values.
- **RVF / Overwatch `task list`**: Callers should keep their own subprocess timeout (`subprocess.run(timeout=…)`, `execFile` timeout, etc.). Kanban's `KANBAN_CLI_HARD_TIMEOUT_MS` is a second line of defense if the parent is killed and the child becomes an orphan (`PPID=1`).
- **Hard timeout exit code `124`**: Matches common `timeout(1)` convention. Parent scripts can treat `124` as "Kanban CLI watchdog fired."

## Hook ingest context

`kanban hooks ingest` requires hook context from the environment (set by Kanban when wiring agent hooks):

| Variable | Required | Description |
|----------|----------|-------------|
| `KANBAN_HOOK_TASK_ID` | Yes | Kanban task id for the active agent session. |
| `KANBAN_HOOK_WORKSPACE_ID` | Yes | Kanban workspace id for the project. |

If either is missing, ingest fails immediately with a clear stderr message and a non-zero exit code.

## Related documentation

- [`../DEVELOPMENT.md`](../DEVELOPMENT.md) — local dev, dogfood, and hook event overview.
- [`architecture.md`](./architecture.md) — runtime model and CLI vs server split.
