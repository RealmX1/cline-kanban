---
name: cline-kanban-local-deploy
description: Project-local workflow for safely deploying this Cline Kanban running instance from an already-present local source checkout while preserving runtime state, task metadata, worktrees, dirty diffs, CLI links, PATH, and agent detection. Use in this project when asked to deploy locally, rebuild, relink, reinstall, restart, or switch the running local instance to code that is already in this checkout (the "local deploy"). Do not use for fetching, rebasing, cherry-picking, or taking new code from official upstream; use this project's cline-kanban-upstream-update skill for official source integration first.
---

# Cline Kanban Local Deploy

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
   - 读取部署标记文件 `~/.cline/kanban/last-deployed-source-commit.json`(runtime home 见 `src/config/runtime-config.ts` 的 `getRuntimeHomePath()`),取其中 `deployedSourceCommit` 作为「上一次运行 build 对应的源 commit」(本次 delta 的 OLD 基线)。
   - 若标记不存在(首次启用本流程)或字段缺失,如实记为「无基线」。不要用当前 `git rev-parse HEAD` 假冒 OLD:运行 build 是无 git SHA 的构建产物(`dist/cli.js` 经 `npm link` 软链回源 checkout),当源码已前移时当前 HEAD 即是 NEW、并非运行 build 反映的 commit;`package.json` 是纯 semver、`kanban --version` 也无法反推 commit。
   - 同时记录 CLI/API 暴露的运行版本号(如 `kanban --version`)作为辅助信息,但版本号不替代 commit。

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

6. 实际部署后:汇总本次运行 build 新反映的源 commit,并记录本次部署点。
   - 门控:仅在步骤 3 的 build/link、步骤 4 的 restart、步骤 5 的 Validate 都成功后执行;若在上述任一边界中止、运行 build 并未真正切换,跳过本汇总。
   - 取两端 commit:OLD = 步骤 1.4 读到的基线(可能为「无基线」);NEW = 本次构建所用源 checkout 的 `git rev-parse HEAD`。
   - 逐条汇报 commit 级 delta(commit 级,不要只报 old/new 版本字符串):
     - 正向新增:`git log --oneline --no-decorate <OLD>..<NEW>` —— 列为「本次新投入使用的 N 个源 commit」。
     - 反向兜底:`git log --oneline --no-decorate <NEW>..<OLD>` —— 若非空说明发生回滚/分叉,标为「⚠️ M 个 commit 被回退」并如实给出方向,别只报单向。
   - 诚实覆盖三类边界:① OLD 为「无基线」→ 报「无基线(首次/不可知),仅列出本次 NEW 所在的源 commit」;② 正向与反向区间皆空 → 报「与上次部署为同一 commit,无新增」;③ 区间命令失败(OLD 已不在本 repo,git 报 `unknown revision`)→ 退化为直接给出 OLD/NEW 两个 SHA、不做区间。
   - 汇报后写/覆盖部署标记:把本次 NEW 写进 `~/.cline/kanban/last-deployed-source-commit.json`,字段 `deployedSourceCommit`(NEW SHA)、`deployedAtIso`(当前时间)、`sourceCheckoutPath`(源 checkout 绝对路径)、`packageVersion`(`package.json` 版本)。NEW 即成为下一次部署的 OLD 基线。
   - 措辞锚在 runtime 语义:「现在运行的 build 反映了这些源 commit」,不要写成「源码集成了这些 commit」(那是 upstream-update skill 的语义)。

7. If something looks wiped, stop and recover from artifacts.
   - Do not move cards, trash tasks, run cleanup, or reset worktrees again.
   - Look for saved task patches, checkpoints, stashes, and timestamped runtime backups.
   - Use `git apply --check` before applying any recovered patch.
   - Restore the worktree dirty diff as uncommitted work unless the user asks for a commit.

## Output Expectations

Report:

- 本次相对上一次部署、现在运行的 build 新反映的源 commit:逐条列出 old→new 之间新投入使用的 commit(commit 级,而非仅 old/new 版本字符串),并按三类边界如实标注(无基线 / 无新增 / 有回退)。运行版本号(semver)可附带,但不替代 commit 列表。
- Whether any source files or version files were intentionally changed; normally this skill should not change version files.
- Where runtime backups were saved.
- Which service/process is now running and how it was launched.
- 现在运行的 build 对应的源 commit(NEW),以及部署标记文件 `~/.cline/kanban/last-deployed-source-commit.json` 的更新情况(供下次部署作 OLD 基线)。
- Validation commands and results.
- Any residual risk, especially tasks that lost live processes and need manual resume.

Never say uncommitted work is safe just because task metadata was restored. Verify the actual worktree diff.
