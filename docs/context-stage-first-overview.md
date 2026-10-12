# Cross-Repository Active-Task Overview — Domain Language

本 context 收录「跨-repository 活跃任务概览」功能引入的领域术语。该功能把整个 Kanban 看板（所有 project/repository）当成一个作用域来鸟瞰，与现有「一次看一个 project」的主看板相对。

## Language

**Board Scope（看板作用域）**：
整个 Kanban 看板这一层级——跨所有 project/repository 的汇总视角。本概览功能作用在 Board Scope。
用户在顶栏项目切换器的首行「All projects」选中它（与选具体项目互斥，见 `web-ui/src/hooks/use-selected-board-or-single-project-scope.ts`）：看板页显示本概览，Focus View 左栏显示跨项目「最近活跃任务」切换面板（docs/context-cross-project-recently-active-task-switcher.md）。范围持久化在 localStorage，不再是一个只在内存里的「Board overview」开关。
_Avoid_: global scope, workspace scope（workspace 已专指单个 project）

**Project Scope（项目作用域）**：
单个 project、即单个 git repository 的层级（一个 `workspaceId`）。现有主看板一次只呈现一个 Project Scope。
_Avoid_: repo view, workspace（歧义）

**Task Creation Target Project（建卡目标项目）**：
新卡要落到哪个 Project Scope。单项目范围里它恒为当前项目、建卡框不显示这个字段（与改动前一致）；Board Scope 里建卡框多一个「Project」选择器（`web-ui/src/components/task-creation-target-project-field.tsx`），默认取上下文项目（跨项目打开在途时是目标项目，否则当前项目；不跨次记忆「上次所用」，免得建错仓库，`EXPERIMENT_NODE`），同一次对话框里「Create more」保留所选。目标是其他项目时卡不进本页 board：同一个纯函数算卡、取那个项目的 runtime 预分配 id、经同一个 persist 端点落盘，不切项目；分支列表、默认 base ref、记住的终端模型都跟着目标项目走。入口：热键 `c`、跨项目切换面板顶部「Create task (c)」、Board Overview 页头「New task」。编辑其他项目的卡时同一字段显示为只读标签（卡不能换项目）。
_Avoid_: destination repo, target workspace（workspace 已专指单个 project 的运行时作用域，这里说的是用户选的项目）

**Stage（阶段）**：
任务在看板流程中的列位置——`in_progress` / `review` / `validation` / `done`（`done` 是内部 `trash` 列的展示名）。
_Avoid_: column, status

**Stage-First Overview（stage 优先概览）**：
本功能引入的 Board Scope 视图。把现有 repo-first 范式（Repository → Stage → Task）的前两级对调，层级为 **Stage → Repository → Task**。In-Progress 阶段一路展开到 Task 明细；其余阶段折叠时显示跨-repo 总计数、展开时显示每-repo 分计数。各 stage 的成员按 board 的**列归属**判定（不套用主看板的 live-session overlay）。
_Avoid_: dashboard, aggregate view, activity panel

**Active In-Progress Task（活跃进行中任务）**：
In-Progress 阶段中 `turnOwner=agent` 且距最近一次 PTY 输出（`lastOutputAt`）在 5 分钟内的 task。概览中高亮。repo 组内按本轮 agent 回合开始时刻升序（`agentResponseGenerationTurnStarted`，与跨项目切换面板 Running 区同一比较器）；不按 `lastOutputAt` 排，否则 spinner 重绘会让组内顺序抖动。
_Avoid_: running task, live task

**Stale In-Progress Task（停滞进行中任务）**：
In-Progress 阶段中非 Active 的 task——含 agent 已交棒等审（awaiting_review）、卡住、空闲。与 Active 同处 In-Progress 阶段，不挪进 Review。
_Avoid_: idle task, stuck task
