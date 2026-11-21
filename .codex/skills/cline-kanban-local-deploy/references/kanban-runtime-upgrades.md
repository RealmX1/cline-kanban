# Kanban-Style Runtime Upgrade Checklist

Use this reference for Cline Kanban, Vibe Kanban, or any local runtime that owns task cards, agent sessions, per-task worktrees, terminal streams, or cleanup-on-shutdown behavior.

以下所有部署命令均须先满足 [SKILL.md 的部署请求与确认规则](../SKILL.md#部署请求与确认)；本清单、原生依赖预检通过或后台执行方式均不替代部署授权。

## Before Restart

本次候选包含 `local-deployment-execution.js` 时，按[持久执行与独立复盘合同](../../../../docs/local-deployment-execution-and-retrospective.md)冻结步骤并交给通用所属命令执行；以下检查仍是其步骤必须满足的部署门禁。不能因为有执行器就省略授权、ABI 或逐会话核查。

- Capture the listening process:
  - `lsof -nP -iTCP:<port> -sTCP:LISTEN`
  - `ps -p <pid> -o pid,ppid,command`
  - `lsof -p <pid> -a -d cwd`
  - `ps eww -p <pid>` to inspect PATH and agent/tool env.
- Back up runtime state, for example:
  - `cp -a ~/.cline/kanban ~/.cline/kanban.backup-YYYYMMDD-HHMMSS`
- Create a backup branch before any local source mutation:
  - `git branch codex/before-<upgrade-name> <current-branch>`
- Inventory task worktrees:
  - `git -C <repo> worktree list --porcelain`
  - For each task worktree, collect `git status --short` and `git diff --stat`.
- Locate task patch storage before cleanup:
  - For Cline Kanban, check `~/.cline/kanban/trashed-task-patches/`.

## Scope Boundary

This reference is for rebuilding, relinking, and restarting a running Cline Kanban runtime from the local source checkout that already exists on disk. Do not use it to fetch, rebase, merge, or cherry-pick official upstream source changes. For official source integration, use this project's `cline-kanban-upstream-update` skill, then return to this runtime checklist only when the running instance must be moved to the integrated checkout.

## Custom Branch Changes Are Not Live

When the global `kanban` CLI is symlinked to a local custom branch, source edits are not automatically reflected in the running server:

- TypeScript/React source changes do nothing until `npm run build` updates `dist/`.
- The running Node process has already loaded its current `dist/cli.js` and web bundle.
- The browser may keep the old web bundle until the server restarts and the page refreshes.

### 计划交接前核验实际会话归属

仅在已有明确部署授权后执行以下步骤；预检本身不授予重启权限。先在隔离输出目录构建候选，确认 `dist`、`web-ui/dist` 的 realpath，不能经 task 的软链接覆盖共享 build。

1. 固定实际服务使用的 Node 和 npm，执行 `scripts/verify-notification-archive-native-runtime.mjs`，并保留候选 commit、备份与部署前会话盘点。
2. 用候选源码附带的只读脚本采集本次部署基线。证据必须放持久目录，并绑定本次候选源 commit；不要使用 `latest` 指针。

```sh
KANBAN_RUNTIME_HOST=127.0.0.1 KANBAN_RUNTIME_PORT=3484 \
  "$KANBAN_DEPLOY_NODE_BINARY" scripts/verify-agent-session-pty-host-runtime-readiness.mjs \
  --before-runtime-restart --wait-for-natural-session-exit \
  --candidate-source-commit "$KANBAN_DEPLOY_SOURCE_COMMIT" \
  --evidence-file "$KANBAN_DEPLOY_PERSISTENT_DIRECTORY/before-runtime-restart.json"
```

脚本交叉核对所属 runtime 的当前诊断、OS 进程启动身份、逐会话宿主和待接管记录。关闭偏好仍须接回旧 hosted 会话。环境变量、HTTP 200、socket 文件和历史日志均不能单独放行。遇到非托管会话且缺少中断授权时，保留旧 runtime，每 30 秒只读复查，默认最多等待 30 分钟；预算耗尽保留证据，可在同一授权仍有效时重新检查。明确授权记录在当前部署中，由执行器重验后在正式交接使用。

旧 runtime 若明确返回新诊断 procedure 不存在，脚本改用旧 API 全项目会话 facet、两次原生进程树、固定端口监听 PID/启动命令及 generation 监听检查。已迁移项目可用持久 sessions 与原生进程交叉补证；缺证保留 unknown。此路径只允许无活会话的首次切换，不证明连续性；不响应的旧 host 不能通过新建 controller 连接检查。

3. 即将停止前重新运行上述预检，重新核对同一个监听 PID 与 `lstart`。发布 build/link 后使用 `kanban runtime handover-restart --wait-for-successor-seconds 60`（该命令默认输出 JSON）。它在服务端再次原子核对是否有不能保留的活会话。仅当本执行有明确中断授权，且当前 runtime 诊断的 `acceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions` 为 true 时，执行器才使用 `--authorized-unretainable-session-handover`，传入刚核验的 runtime 代际和不可保留会话身份。该选项走专用 RPC。已验收基线会报告 `enforcesAuthorizedUnretainableSessionHandoverBinding`，但没有这个 procedure，不能用旧字段代替。旧 runtime 不识别该入口，调用失败后保留原件，禁止改走布尔中断。仍有无法保留的会话且缺少专用入口时，只读等待至这些会话退出；会话已经退出后使用默认受保护交接，不传布尔中断。接收端发现代际变化或有未核验会话时拒绝交接。正式交接使用该原生入口保留已托管会话。只有回执的 `outcome` 为 `handover_restart_started`，`runtimeProcessId` 与启动时刻都属于该代际，且接收端确认绑定并在接受清单中列出发起会话时，才把该会话的退出记作本次授权中断。
4. 首次运行的旧 build 若不支持 `runtime handover-restart`，只在上述旧版静默盘点通过、停止前再次通过且监听 PID/启动身份仍一致时，按原 supervisor 的退出契约进行受控停止并重新启动持久服务入口。SIGTERM 可能让旧 supervisor 一并退出；此时显式启动 canonical service runner。不要把 `kill -9` 当作部署成功条件，也不要因为有 Codex 控制宿主或旧 socket 就声称 PTY 已独立托管。
5. 新 runtime 首次启动即读取持久偏好；受支持的固定端口实例在无持久选择、无环境覆盖时默认启用，无需第二次部署。先运行以下只读检查核对当前启动意图、实际模式与逐会话归属；若明确关闭则按关闭意图核验，不能为部署擅自覆盖用户选择。

```sh
KANBAN_RUNTIME_HOST=127.0.0.1 KANBAN_RUNTIME_PORT=3484 \
  "$KANBAN_DEPLOY_NODE_BINARY" scripts/verify-agent-session-pty-host-runtime-readiness.mjs \
  --evidence-file "$KANBAN_DEPLOY_PERSISTENT_DIRECTORY/after-runtime-readiness.json"
```

若部署前有 hosted 会话，再运行只读连续性观察器，绑定同一基线与候选 commit；它不会重启、停止或注入输入。首次没有 hosted 基线时，功能已可使用，跨重启连续性仍待下一次有活 hosted 会话的已授权 redeploy 取证。

```sh
KANBAN_RUNTIME_HOST=127.0.0.1 KANBAN_RUNTIME_PORT=3484 \
  "$KANBAN_DEPLOY_NODE_BINARY" scripts/observe-agent-session-pty-host-runtime-restart-continuity.mjs \
  --before-restart-evidence-file "$KANBAN_DEPLOY_PERSISTENT_DIRECTORY/before-runtime-restart.json" \
  --after-restart-evidence-file "$KANBAN_DEPLOY_PERSISTENT_DIRECTORY/after-runtime-restart.json" \
  --deployed-source-commit "$KANBAN_DEPLOY_SOURCE_COMMIT" --record-for-current-runtime
```

观察器要求原 PID、OS 启动身份、runtime incarnation、native session、host 实例和输出水位连续。新 runtime 的观察起点先写入精确记录；后续输出须超过该起点并实际送达新 runtime，不能用部署前推进的 host 水位或未送达字节补作通过证据。自然输出和新原生输入接受另行报告；加 `--require-session-io-progress` 才把两项都作为通过条件。未出现自然输入时保持待验，不向生产会话注入探针。记录按新 runtime 的 PID 与启动身份绑定，后续 PDV 读取该精确记录。首次无会话切换只能报告实际模式就绪，下一次已有 hosted 基线的已授权 redeploy 才能核验真实连续性。

重启后还须验证真实实例的 `notificationIntelligence.listArchive`、CLI 链接、agent 检测、工作树差异与任务映射。当前健康和已有基线的身份连续性通过后，可用 `kanban deployment record` 如实记录已切换的 build；没有 hosted 基线或尚未出现自然 I/O 的连续性项继续留在 PDV，不得勾选通过。文件存在、HTTP 成功或新 PID 单独不足以宣告成功。

## Shutdown Guardrail

Do not assume `kill <pid>` is non-mutating. Some runtimes run shutdown cleanup that can:

- Mark sessions interrupted/done.
- Move cards between columns.
- Delete task worktrees.
- Extract dirty diffs into saved patch files.
- Leave terminal websocket clients showing "Terminal stream closed".

Prefer restarting the new server with cleanup disabled, e.g. for Cline Kanban:

```sh
kanban --no-open --skip-shutdown-cleanup --port 3484
```

If the old process was not started with cleanup disabled, expect dirty worktree patches may have been moved into `trashed-task-patches`.

## Launch Environment Guardrail

Service managers often run with a smaller PATH than the user's shell. Before deciding an agent is not installed, compare:

```sh
command -v claude codex cline
ps eww -p <runtime-pid> | tr ' ' '\n' | rg '^PATH='
```

For Cline Kanban launched outside the user's interactive shell, include likely user tool paths:

```sh
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/<version>/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
```

Validate through the runtime API/UI, not only the shell. For Cline Kanban:

```sh
curl -sS 'http://127.0.0.1:3484/api/trpc/runtime.getConfig' | jq '.result.data.detectedCommands'
```

## Cline Kanban Specific Recovery

If a task worktree looks clean/empty after upgrade:

1. Stop all cleanup-like actions. Do not Trash/Recover again until artifacts are inspected.
2. Find the task id and worktree:
   - `jq '."<task-id>"' ~/.cline/kanban/workspaces/<workspace-id>/sessions.json`
   - Check timestamped backups too.
3. Search saved patches:
   - `find ~/.cline/kanban* -path '*trashed-task-patches*' -name '<task-id>.*.patch' -print -ls`
4. Check whether the patch applies:
   - `git -C <task-worktree> apply --stat <patch>`
   - `git -C <task-worktree> apply --check <patch>`
5. Restore as dirty work:
   - `git -C <task-worktree> apply <patch>`
   - `git -C <task-worktree> status --short`

Also check Kanban checkpoints:

```sh
git -C <base-repo> show --stat refs/kanban/checkpoints/<encoded-task-id>/turn/<n>
```

Prefer patch restore over reset/cherry-pick when the desired state is uncommitted work in the task worktree.

## Terminal Stream Reality

"Terminal stream closed. Close and reopen to reconnect." means the frontend websocket or underlying PTY stream died. If the old PID no longer exists, the terminal cannot reconnect to the original live process. The task may still have metadata and history, but it needs a new agent session to continue.

Do not equate restarting a task with preserving its old dirty worktree. Verify and restore the worktree diff separately.

Any server restart can disconnect open terminal panels. This is expected and distinct from the earlier worktree-loss failure mode. The dangerous part is shutdown cleanup mutating task worktrees; prevent that with `--skip-shutdown-cleanup` and by inventorying dirty worktrees before restart.

## Post-Upgrade Validation

For each important task:

- Confirm card column and session metadata.
- Confirm worktree path exists.
- Confirm `git status --short` matches expected dirty/clean state.
- Confirm saved patches were not stranded.
- Confirm newly started tasks receive the expected environment variables, e.g. `KANBAN_TASK_ID`, project path, and agent PATH.

For the running Cline Kanban server:

```sh
lsof -nP -iTCP:3484 -sTCP:LISTEN
tmux list-panes -a -F '#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}'
curl -sfI http://127.0.0.1:3484
curl -sS 'http://127.0.0.1:3484/api/trpc/runtime.getConfig' | jq '.result.data.detectedCommands'
```

Confirm the listener PID from `lsof` appears under tmux session `cline-kanban` or `cline-kanban-*`. If it is in another tmux session, or not in tmux, treat the listener as foreign even when the command is `kanban`.

If `claude` exists in the user's shell but not in `detectedCommands`, inspect the runtime process PATH and relaunch with the user's tool directories included.

For agent hooks:

- Ensure hook config points to the upgraded custom CLI, not an old `npx <pkg>@old-version`.
- Add legacy env aliases if old sessions may emit only hook-specific variables such as `KANBAN_HOOK_TASK_ID`.
- Ensure outer hook timeouts exceed inner startup/ensure timeouts, or make inner timeouts shorter and artifact-producing.
