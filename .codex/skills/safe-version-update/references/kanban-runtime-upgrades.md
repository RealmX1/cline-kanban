# Kanban-Style Runtime Upgrade Checklist

Use this reference for Cline Kanban, Vibe Kanban, or any local runtime that owns task cards, agent sessions, per-task worktrees, terminal streams, or cleanup-on-shutdown behavior.

## Before Restart

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

Safe rebuild/restart shape:

```sh
cd /Users/bominzhang/Documents/GitHub/cline-kanban
git status --short --branch
npm run typecheck
npm run build

tmux kill-session -t cline-kanban-3484
tmux new-session -d -s cline-kanban-3484 -c /Users/bominzhang/Documents/GitHub/review-validate-fix \
'export PATH="/Users/bominzhang/.local/bin:/Users/bominzhang/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"; exec /Users/bominzhang/.nvm/versions/node/v24.12.0/bin/kanban --no-open --skip-shutdown-cleanup --port 3484 > /tmp/cline-kanban-3484.log 2> /tmp/cline-kanban-3484.err'
```

Adjust paths and ports for the local machine. The important properties are: rebuild first, restart with cleanup disabled, preserve user PATH, and verify the new process. For Cline Kanban, launch the long-lived server inside a tmux session named `cline-kanban` or `cline-kanban-<port>`; RVF uses that tmux session name as the ownership signal for an existing Kanban listener and intentionally does not use the listener cwd as the repo boundary.

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

Confirm the listener PID from `lsof` appears under tmux session `cline-kanban` or `cline-kanban-*`. If it is in another tmux session, or not in tmux, RVF should treat the listener as foreign even when the command is `kanban`.

If `claude` exists in the user's shell but not in `detectedCommands`, inspect the runtime process PATH and relaunch with the user's tool directories included.

For RVF-style stop hooks:

- Ensure hook config points to the upgraded custom CLI, not an old `npx <pkg>@old-version`.
- Add legacy env aliases if old sessions may emit only hook-specific variables such as `KANBAN_HOOK_TASK_ID`.
- Ensure outer hook timeouts exceed inner startup/ensure timeouts, or make inner timeouts shorter and artifact-producing.
