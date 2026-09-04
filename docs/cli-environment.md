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

## Agent terminal rendering

Read from the runtime process environment when a PTY agent session is launched.

| Variable | Default | Applies to | Description |
|----------|---------|------------|-------------|
| `KANBAN_CLAUDE_CODE_TERMINAL_RENDERING_MODE` | `fullscreen` | Claude Code sessions | Which Claude Code TUI renderer Kanban starts sessions on. `inline` falls back to the classic main-screen renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`); any other value, including unset, uses the flicker-free fullscreen alt-screen renderer (`CLAUDE_CODE_NO_FLICKER=1`). |

Kanban writes the corresponding `CLAUDE_CODE_*` variable itself and blanks out the other one, so an inherited value — which is what happens when Kanban is itself launched from inside a Claude Code session — never decides the renderer. Set this variable on the Kanban runtime process, not on the agent.

Under `fullscreen`, Claude Code keeps its history inside the alternate screen buffer like Codex does, so the terminal panel's scrollback reading view has nothing to show for those sessions and hides its entry point. Switch to `inline` if you need session history in terminal scrollback.

## Model providers (credentials Kanban itself calls out with)

A registry of model-provider credentials, addressed **by provider**, that anything inside Kanban can draw on. Today one consumer exists — task naming in the New task dialog — but the shape is deliberately plural: several providers can be configured side by side, and future consumers (other in-app conveniences, other agents' keys) address them by id rather than getting their own bespoke variables.

Read from the **runtime process** environment on every request, so a running Kanban server picks up changes only after a restart. Every endpoint is treated as OpenAI-compatible (`POST {base_url}/chat/completions`), so pointing a provider entry at an aggregating gateway (LiteLLM, OpenRouter, …) works with no code change. The request body stays inside the standard chat-completions schema for exactly that reason: a vendor extension is sent only to providers listed as accepting it (`MODEL_PROVIDER_IDS_ACCEPTING_THINKING_EXTENSION_FIELD` in `src/model-provider-access/request-model-provider-chat-completion.ts` — today `deepseek`, whose thinking mode Kanban turns off to keep these short interactive requests fast). An endpoint that rejects unknown fields with HTTP 400 therefore still works with nothing but the three variables below.

### Per-provider variables

`<ID>` is the provider id upper-cased with hyphens turned into underscores: `deepseek` → `DEEPSEEK`, `my-gateway` → `MY_GATEWAY`. Provider ids are lower-case `[a-z0-9-]+`.

| Variable | Required | Description |
|----------|----------|-------------|
| `KANBAN_MODEL_PROVIDER_<ID>_API_KEY` | Yes | Bearer token. Its presence is what makes a provider "configured" — Kanban discovers providers by scanning for this suffix, so a provider it has never heard of works without a code change. |
| `KANBAN_MODEL_PROVIDER_<ID>_BASE_URL` | Only for unknown providers | Base URL; `/chat/completions` is appended and a trailing slash is stripped. Known providers (below) have a built-in default. |
| `KANBAN_MODEL_PROVIDER_<ID>_MODEL_ID` | Only for unknown providers | Model id sent in the request body. Known providers have a built-in default. |
| `KANBAN_DEFAULT_MODEL_PROVIDER_ID` | Only when several are configured | Which provider a caller gets when it does not name one. With exactly one provider configured this is unnecessary — but once set it is binding: if it names a provider that has no API key, calls degrade instead of falling back to that single configured provider. With several configured and no default declared, calls likewise degrade rather than silently spending on a provider you did not intend. |

Providers with built-in defaults (`KNOWN_MODEL_PROVIDER_DEFAULTS` in `src/model-provider-access/model-provider-credentials-from-environment.ts`) need only the key:

| Provider id | Default base URL | Default model |
|-------------|------------------|---------------|
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` (stable alias for DeepSeek-V4-Flash-0731) |

A provider with a key but no resolvable base URL or model is treated as unusable rather than having an endpoint guessed for it — sending a credential to a guessed address is worse than doing nothing.

Configure the common case with:

```bash
export KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY="sk-..."
```

### Usage metadata

Every call carries a required `modelUsagePurpose` — the role the call plays inside Kanban (`task_name_suggestion` today) — and each call appends one record to the `model-provider-usage` channel of the rotating JSONL journal under `~/.cline/kanban/diagnostic-event-journals/`: purpose, provider id, model id, outcome, failure reason, HTTP status, elapsed ms, prompt character count, and token counts when the provider reports them. Attempts that never reach the network (nothing configured) are recorded too, so "never configured" is distinguishable from "never used" in later analysis.

Purpose is metadata on the call, not part of the variable name, precisely so one key serves many purposes and renaming a feature is not an environment migration.

### Adding another consumer

`src/model-provider-access/` owns credential resolution, provider routing, timeout, JSON mode, degradation semantics and usage journaling. A new feature adds only its own prompt, its own validation of the answer, and its own wording for the failure case — see `src/task-name-suggestion/suggest-task-names-from-task-description.ts` for the pattern. Do not re-implement `fetch` + timeout + fallback per feature.

- `requestModelProviderText(request, options?)` — free-form text back.
- `requestModelProviderJsonObject(request, zodSchema, options?)` — server-side JSON mode plus schema validation. DeepSeek's JSON mode requires the word "json" to appear in the prompt, so keep it in your system prompt.

Both require `modelUsagePurpose` (add a member to `ModelUsagePurpose` — that is the forced declaration point for "how should this call be counted"), accept an optional `modelProviderId` to override routing, and accept `environmentVariables` / `fetchImplementation` overrides so unit tests need neither a polluted process environment nor a network.

Every failure mode — nothing configured, endpoint down, timeout, non-2xx, unparsable answer — degrades to a plain `unavailable` result rather than an error. No feature built on this layer is allowed to block on it: task creation, for instance, creates the card immediately with the title derived from the description and writes a suggested name back afterwards only if the title has not changed in the meantime.

## Related documentation

- [`../DEVELOPMENT.md`](../DEVELOPMENT.md) — local dev, dogfood, and hook event overview.
- [`architecture.md`](./architecture.md) — runtime model and CLI vs server split.
