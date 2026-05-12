---
name: safe-version-update
description: Project-local workflow for safely refreshing this Cline Kanban running instance from an already-present local source checkout while preserving runtime state, task metadata, worktrees, dirty diffs, CLI links, PATH, and agent detection. Use in this project when asked to rebuild, relink, reinstall, restart, or switch the running local instance to code that is already in this checkout. Do not use for fetching, rebasing, cherry-picking, or taking new code from official upstream; use this project's cline-kanban-upstream-update skill for official source integration first.
---

# Safe Local Runtime Update

## Core Rule

Treat a local runtime update as a state migration, not just a build. Protect three things before changing builds, links, or processes:

1. The current local source checkout and any dirty source diffs.
2. Runtime data: config, databases, task metadata, sessions, patches, caches.
3. Live work: worktrees, dirty diffs, running process state, and agent/tool PATH.

If the runtime manages tasks or worktrees, read `references/kanban-runtime-upgrades.md` before stopping or restarting it.

默认用用户偏好的主要语言回复；如果当前项目要求中文，就用中文描述计划、风险、验证结果和后续操作。

## Boundary

This skill is only for making a running local instance use code that already exists on disk.

Do not fetch, pull, rebase, cherry-pick, merge, or otherwise integrate official upstream code in this skill. Do not bump version files as part of this skill. If the user asks to take a new official Cline/Kanban upstream update, use this project's `cline-kanban-upstream-update` skill first, then return here only if the running instance must be rebuilt, relinked, or restarted.

## Default Proposal

When proposing options for a local runtime that is already linked to a local source checkout, make the first/default proposal:

**Default:** rebuild/relink the current local CLI, then restart the running runtime with state-preserving flags.

Present this as the default because source edits are not live until the build/link target is refreshed, and the running process will not load the new build until it is restarted.

## Workflow

1. Snapshot the current situation.
   - Run `git status --short --branch`, `git log --oneline --decorate -n 12`, `git remote -v`.
   - Identify the running process, cwd, command, and environment: use `lsof`, `ps`, and `ps eww` where appropriate.
   - Identify global links: `readlink $(command -v <cli>)`, `npm ls -g --depth=0 <pkg>`, or equivalent.
   - Record the currently running build/version if the CLI or API exposes one.

2. Preserve rollback points before mutation.
   - If the source checkout has local edits, preserve a patch or create a backup branch at the current commit using the repo's branch-prefix convention when known.
   - Copy runtime state directories with timestamped names.
   - For task/worktree runtimes, inventory every active worktree and dirty diff before shutdown.
   - Do not rely on app metadata backups alone; preserve dirty worktree content or patch files too.

3. Build and install deliberately.
   - Install dependencies using the repo's documented command.
   - Build using the repo's production build command.
   - Link or install the CLI only after a successful build.
   - Confirm the executable path and version after link/install.
   - Do not assume a symlinked global CLI hot-reloads source edits. Running processes keep the build they already loaded; source changes usually require rebuild plus process restart.

4. Restart with state-preserving flags.
   - Before stopping the old process, check whether shutdown cleanup mutates worktrees or task state.
   - Prefer `--skip-shutdown-cleanup` or the tool's equivalent for upgrade restarts.
   - Preserve the user's PATH when launching via service managers. GUI/launchd/launchctl environments often miss `~/.local/bin`, nvm, asdf, pyenv, Homebrew, or custom tool directories.
   - Expect terminal/websocket clients to disconnect during restart. Treat this as separate from worktree preservation: disconnects are normal; missing dirty diffs are not.
   - After restart, verify HTTP/API health, CLI version, global link path, and detected agent/tool commands.

5. Validate behavior and state.
   - Run focused tests for the local changes and runtime-sensitive paths.
   - Verify runtime data counts and task/worktree mappings before declaring success.
   - For task systems, inspect a known task's worktree and session metadata, not just the card list.
   - Confirm installed agents are detected through the runtime API/UI, not only through the interactive shell.

6. If something looks wiped, stop and recover from artifacts.
   - Do not move cards, trash tasks, run cleanup, or reset worktrees again.
   - Look for saved task patches, checkpoints, stashes, and timestamped runtime backups.
   - Use `git apply --check` before applying any recovered patch.
   - Restore the worktree dirty diff as uncommitted work unless the user asks for a commit.

## Output Expectations

Report:

- Old version/build and new version/build.
- Whether any source files or version files were intentionally changed; normally this skill should not change version files.
- Where runtime backups were saved.
- Which service/process is now running and how it was launched.
- Which local checkout/commit the runtime is now using.
- Validation commands and results.
- Any residual risk, especially tasks that lost live processes and need manual resume.

Never say uncommitted work is safe just because task metadata was restored. Verify the actual worktree diff.
