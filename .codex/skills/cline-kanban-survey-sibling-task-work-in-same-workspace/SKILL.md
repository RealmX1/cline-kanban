---
name: cline-kanban-survey-sibling-task-work-in-same-workspace
description: Read-only survey of what the other Cline Kanban tasks in the same workspace (one workspace = one git repository = one kanban project) are assigned to do and have already changed, including their prompts, columns, session states, unlanded commits and uncommitted work. Use when planning or re-planning inside a task worktree and you must avoid duplicating or colliding with a sibling task, or when asked what the other tasks in this repository are currently doing. Never mutates another task worktree and never merges another task's work.
---

# Survey sibling task work in the same kanban workspace

一个 **workspace** = 一个 git repository = kanban 里的一个 project，下面挂着多个 task，每个被 start 的 task 有自己的 git worktree。本 skill 只做一件事：**只读**地采集同一个 workspace 里**其它** task 在做什么，交给调用方当作规划依据。

## 硬边界

```text
SIBLING_WORKTREE_MUTATION=FORBIDDEN
COMMITTED_WORK_READ_FROM=PROJECT_MAIN_CHECKOUT_SHARED_OBJECT_DATABASE
UNCOMMITTED_WORK_READ_WITH=NO_OPTIONAL_LOCKS
KANBAN_CLI_WRITE_SUBCOMMANDS=FORBIDDEN
SIBLING_TASK_WORK_IS_CONTEXT_NOT_MERGE_SOURCE=REQUIRED
```

- sibling task 的 worktree 里可能正跑着另一个 agent。**已提交历史一律在项目主 checkout 里借共享 object database 读**，绝不进入对方 worktree；唯一需要触碰对方 worktree 的是未提交 WIP，必须 `--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`，否则会与对方抢 index lock。
- 只允许 `kanban task list`。`start / message / trash / delete / link / park` 等写子命令一律禁止——本 skill 不指挥别的任务。
- 采集结果**只是规划上下文**。绝不 merge、cherry-pick、rebase 或以任何方式把 sibling 的分支引入本任务。

## 1. 采集

```bash
SURVEY_SKILL_DIRECTORY="<本次加载的 SKILL.md 所在绝对目录>"
node "$SURVEY_SKILL_DIRECTORY/scripts/collect-sibling-task-work-snapshot.mjs" \
  --project-path "${KANBAN_PROJECT_PATH:?}" \
  --self-task-id "${KANBAN_TASK_ID:-}" \
  --base-ref "${BASE_REF:-main}"
```

- 在任务 worktree 里跑时，`KANBAN_PROJECT_PATH` 与 `KANBAN_TASK_ID` 由看板注入；缺失时显式传参，**必须**给出 `--self-task-id`，否则本任务会把自己算成 sibling。
- 可选：`--columns`（默认 `backlog,in_progress,review,validation`）、`--kanban-cli`、`--per-command-timeout-seconds`、`--max-uncommitted-paths`。
- 不要用裸 `kanban`。本机存在同名但不相干的二进制；脚本按 realpath 落在 kanban npm 包内来确认身份，确认不了就降级并记录，不会静默采到错误 CLI 的输出。
- 脚本除临时文件外不写任何东西，退出码 0 即代表快照可用（降级也是 0，降级写在字段里）。

## 2. 判读

**最重要一条：git diff 为空不等于没有重叠。** sibling 常常一行都还没提交，最强信号是 `promptExcerpt` + `column` + session 状态——「另一个任务已被指派去做 X」。只看 git 会漏掉绝大多数真实撞车。

按强度分两档：

- **软重叠**：sibling 的任务描述或已提交改动与本任务计划落在同一区域，但它当前没有活跃的未提交改动（`sessionActive=false` 或 `uncommittedPathCount=0`）。
- **硬碰撞**：`sessionActive=true` 且其 `uncommittedPaths` 与本任务计划要改的文件有交集——两个 agent 正在同时改同一个文件。

其余字段的读法：

- `headContainedInLocalBase=true` 表示该 task 的提交已经落回 local base，是**已完成的历史**而非在办工作；本仓库多数遗留 worktree 都是这种，不做这个区分会把陈年历史误报成活跃冲突。
- `taskInventorySource`：`KANBAN_CLI`（完整）→ `DURABLE_BOARD_STATE`（无 session 实时性）→ `GIT_WORKTREE_ONLY`（**只剩 worktree，没有任务描述**，此时不得声称已看清别的任务在做什么）。
- `degradations[]` 非空时必须在报告里逐条复述，绝不把降级说成「没有其它任务」。
- `orphanWorktreesWithoutActiveTask`：worktree 还在但任务已不在 active 列，通常是残留，只在其 `headContainedInLocalBase=false` 时才值得多看一眼。

## 3. 报告

逐字给出下列结论，并附软重叠 / 硬碰撞两个清单（各含 taskId、column、重叠文件或重叠主题）：

```text
SIBLING_TASK_SURVEY=VERIFIED|DEGRADED_<REASON>
TASK_INVENTORY_SOURCE=KANBAN_CLI|DURABLE_BOARD_STATE|GIT_WORKTREE_ONLY
SIBLING_TASK_COUNT=<n>
SOFT_OVERLAP_TASK_IDS=<逗号分隔或 NONE>
HARD_COLLISION_TASK_IDS=<逗号分隔或 NONE>
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
```

采集不成功时报告 `DEGRADED_<REASON>` 并说明缺了哪一层，不得据此宣布「无重叠」。
