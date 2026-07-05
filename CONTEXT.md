# Cross-Repository Active-Task Overview — Domain Language

本 context 收录「跨-repository 活跃任务概览」功能引入的领域术语。该功能把整个 Kanban 看板（所有 project/repository）当成一个作用域来鸟瞰，与现有「一次看一个 project」的主看板相对。

## Language

**Board Scope（看板作用域）**：
整个 Kanban 看板这一层级——跨所有 project/repository 的汇总视角。本概览功能作用在 Board Scope。
_Avoid_: global scope, workspace scope（workspace 已专指单个 project）

**Project Scope（项目作用域）**：
单个 project、即单个 git repository 的层级（一个 `workspaceId`）。现有主看板一次只呈现一个 Project Scope。
_Avoid_: repo view, workspace（歧义）

**Stage（阶段）**：
任务在看板流程中的列位置——`in_progress` / `review` / `validation` / `done`（`done` 是内部 `trash` 列的展示名）。
_Avoid_: column, status

**Stage-First Overview（stage 优先概览）**：
本功能引入的 Board Scope 视图。把现有 repo-first 范式（Repository → Stage → Task）的前两级对调，层级为 **Stage → Repository → Task**。In-Progress 阶段一路展开到 Task 明细；其余阶段折叠时显示跨-repo 总计数、展开时显示每-repo 分计数。各 stage 的成员按 board 的**列归属**判定（不套用主看板的 live-session overlay）。
_Avoid_: dashboard, aggregate view, activity panel

**Active In-Progress Task（活跃进行中任务）**：
In-Progress 阶段中 `turnOwner=agent` 且距最近一次 PTY 输出（`lastOutputAt`）在 5 分钟内的 task。概览中高亮。
_Avoid_: running task, live task

**Stale In-Progress Task（停滞进行中任务）**：
In-Progress 阶段中非 Active 的 task——含 agent 已交棒等审（awaiting_review）、卡住、空闲。与 Active 同处 In-Progress 阶段，不挪进 Review。
_Avoid_: idle task, stuck task
