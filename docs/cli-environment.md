# CLI environment variables

Kanban inherits your shell environment when launched from the terminal. Hook subprocesses and automation bridges (RVF, Overwatch, Claude Code hooks) spawn short-lived `kanban` CLI children the same way.

This page documents environment variables that affect **CLI subprocess behavior** — especially timeouts and hook ingest. For runtime server bind options, prefer CLI flags such as `--port` and `--host` when possible.

## Runtime connection

| Variable | Default | Applies to | Description |
|----------|---------|------------|-------------|
| `KANBAN_RUNTIME_HOST` | `127.0.0.1` | CLI subcommands, web UI | Hostname or IP of the Kanban runtime HTTP server. |
| `KANBAN_RUNTIME_PORT` | `3484` | CLI subcommands, web UI | TCP port of the Kanban runtime. `--port` on `kanban` launch overrides this for that process. |

Subcommands such as `kanban task list` and `kanban hooks ingest` reach the runtime through these settings. If nothing is listening, the CLI should fail fast and exit (see timeout variables below).

To reach the runtime from other devices, keep it bound to `127.0.0.1` and put `tailscale serve` in front of it with `--additional-trusted-browser-origin`. There is deliberately no environment variable for that trust list, so agent subprocesses never inherit it. Recipe: [`remote-access-via-tailscale-serve.md`](./remote-access-via-tailscale-serve.md).

## CLI subprocess timeouts

These guards apply to **short-lived subcommands** (`kanban task …`, `kanban hooks ingest`, etc.). They do **not** apply to a long-running `kanban` server launch (`kanban`, `kanban --port 3484`, …).

| Variable | Default | Exit behavior | Description |
|----------|---------|---------------|-------------|
| `KANBAN_CLI_HARD_TIMEOUT_MS` | `35000` | `124` | Watchdog: the CLI process must exit within this many milliseconds after the watchdog is armed at the start of `run()` in `src/cli.ts` (after the static import graph has been evaluated, so module load time is not counted), whether or not the command succeeded. Prevents orphaned `kanban task list` / `hooks ingest` children from running indefinitely. Cancelled as soon as the subcommand finishes so telemetry flush can run with the intended `process.exitCode`. |
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

Kanban 按 provider 管理档案与凭据，供任务辅助、通知判断等用途复用。项目归属、查卡两阶段、任务起名和关系分析使用 [任务辅助 API 主备路由](task-assistance-api-provider-routing.md)：默认 MiniMax 优先、DeepSeek 备用，MiniMax 未配置时直接使用 DeepSeek。该路由不受 `KANBAN_DEFAULT_MODEL_PROVIDER_ID` 或旧 CLI 配置驱动。

环境凭据由运行时进程读取，修改进程外的环境变量后需重启；设置页保存的 provider 档案与主备路由对新请求生效。OpenAI 兼容端点使用 `POST {base_url}/chat/completions`。DeepSeek 关闭思考并使用 JSON 模式；MiniMax 按实际型号适配推理参数，以 schema 指令和最终正文校验约束 JSON；未知网关只接收标准协议字段。

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
| `deepseek` | `https://api.deepseek.com` | `deepseek-v4-flash` (a floating DeepSeek-side alias — which model serves it and at what rate is whatever the [official pricing page](https://api-docs.deepseek.com/quick_start/pricing) says today) |

A provider with a key but no resolvable base URL or model is treated as unusable rather than having an endpoint guessed for it — sending a credential to a guessed address is worse than doing nothing.

Configure the common case with:

```bash
export KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY="sk-..."
```

### Usage metadata

每次外部模型请求必须携带 `modelUsagePurpose`，并在 `~/.cline/kanban/diagnostic-event-journals/model-provider-usage.jsonl` 记录用途、provider、请求与实际模型、操作与阶段、结果、耗时及上游返回的用量。辅助模型的尝试、未配置和冷却跳过另记在 `task-assistance-routing.jsonl`，缺失的缓存字段保持未知。

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
