---
name: cline-kanban-upstream-update
description: Safely integrate official Cline/Kanban upstream source changes into this local cline-kanban checkout or custom branch while preserving local custom commits, rollback points, dirty work, and lockfile intent. Use in this project when asked to take the latest official cline/kanban update, fetch/rebase/cherry-pick upstream changes, compare local custom commits against official upstream, or prepare the source checkout for a later local runtime rebuild. Do not use to rebuild, relink, restart, or mutate a running Kanban instance; use the local runtime update workflow after source integration when the runtime must be refreshed.
---

# Cline Kanban Upstream Update

## Core Rule

Treat an official upstream update as source-history integration only. Protect local custom work and produce a checkout that can be handed to the local runtime update workflow later.

Do not stop, restart, relink, or clean up a running Kanban runtime in this skill. If a running instance must use the updated checkout, finish this skill first and then use the safe local runtime update workflow.

默认用用户偏好的主要语言回复；如果当前项目要求中文，就用中文描述计划、风险、验证结果和后续操作。

## Boundary

This project-local skill owns:

- Discovering and verifying the official upstream source target.
- Preserving rollback points before source-history mutation.
- Rebasing, merging, or cherry-picking local custom commits onto upstream.
- Resolving source and dependency conflicts.
- Validating the resulting checkout with source-level checks.

This skill does not own:

- Restarting servers.
- Killing tmux sessions or PIDs.
- Relinking global CLIs.
- Declaring runtime task/worktree state safe after restart.
- Running shutdown cleanup or recovery flows.

## Workflow

1. Snapshot the current source checkout.
   - Run `git status --short --branch`, `git log --oneline --decorate -n 20`, and `git remote -v`.
   - Identify the current branch, upstream tracking branch, and whether the worktree is dirty.
   - If this checkout has linked worktrees, run `git worktree list --porcelain` so branch operations do not accidentally collide with active task worktrees.
   - If a Kanban runtime is running, record that fact but do not restart it here.

2. Verify the official upstream target.
   - Use existing remotes first; do not assume `origin` or `upstream` is official without checking `git remote -v`.
   - Fetch the chosen official remote with tags before comparing: `git fetch <remote> --tags --prune`.
   - Verify the default branch or requested tag/commit before assuming what "latest" means.
   - If no official remote exists, add or ask for the correct official URL rather than guessing from package names.

3. Preserve rollback points.
   - Create a backup branch at the current commit, using the repo's branch-prefix convention when known, for example `git branch codex/before-official-kanban-update-YYYYMMDD-HHMMSS HEAD`.
   - Preserve uncommitted work before rebasing or merging. Prefer a patch file or stash with a clear name; never discard dirty changes.
   - Record the old base and new upstream target SHAs.

4. Identify local custom commits.
   - Find the merge base between the current branch and the official target.
   - Use `git log --left-right --cherry-pick --oneline <official-target>...HEAD` to separate upstream-only and local-only commits.
   - Use `git range-diff` when rebasing a stack of local custom commits so the post-update stack can be compared with the original.

5. Integrate source changes safely.
   - Prefer rebasing local custom commits onto the official target when the branch is meant to remain a custom branch on top of upstream.
   - Prefer creating a new branch from the official target and cherry-picking custom commits when the existing branch should remain untouched.
   - Resolve conflicts in the smallest scope needed.
   - Keep lockfile churn only when required by the dependency manager or upstream dependency changes.
   - Do not remove or downgrade code to satisfy old dependency types; inspect installed package types and upgrade dependencies when that is the real fix.
   - Do not bump local version files unless the user explicitly asks for a release/version bump.

6. Validate the integrated checkout.
   - Install dependencies using the repo's documented package-manager command when dependency metadata changed.
   - Run source-level checks such as typecheck, lint, focused tests, and build according to the repo's documented commands.
   - Treat a production build here as validation of the checkout, not as proof that a running runtime has been updated.
   - Confirm the custom commits still exist on top of the official target, or explicitly report any commits intentionally dropped.

7. Hand off runtime refresh separately.
   - If the user wants the local server or CLI to run the integrated code, use the safe local runtime update workflow after this source integration is complete.
   - Pass along the old commit, new commit, backup branch, validation results, and any runtime risks discovered during the snapshot.

## Output Expectations

Report:

- Official remote, branch/tag/commit, and resolved new upstream SHA.
- Previous local HEAD and backup branch.
- Dirty-work preservation location if any existed.
- Integration method used: rebase, merge, or cherry-pick onto a new branch.
- Whether version files were intentionally changed.
- Whether custom commits remain on top of upstream.
- Validation commands and results.
- Explicit note that no running runtime was restarted or relinked by this skill.
