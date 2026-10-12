# Board Scope（All projects）与单项目范围 — Domain Language

本 context 收录「整个看板 vs 单个项目」这一对范围及其首页的领域术语。整个 Kanban 看板（所有 project/repository）可以当成一个作用域来看，与「一次看一个 project」的主看板相对。

## Language

**Board Scope（看板作用域）**：
整个 Kanban 看板这一层级，即跨所有 project/repository 的汇总视角。
用户在顶栏项目切换器的首行「All projects」选中它，与选具体项目互斥（见 `web-ui/src/hooks/use-selected-board-or-single-project-scope.ts`）。此外还有三个入口：顶栏 Layers 按钮、⌘E，以及重载 / 新开标签页时恢复。
选中后：
- 看板页显示 **Board Scope Home Page Section Columns Board**（见下）；
- Focus View 左栏显示跨项目「最近活跃任务」切换面板（`docs/context-cross-project-recently-active-task-switcher.md`）。

范围每个标签页各存一份（sessionStorage，重载与 Chrome 丢弃后恢复都保留）。localStorage 只记「最后一次选的」，用作新开标签页的默认值。
_Avoid_: global scope, workspace scope（workspace 已专指单个 project）

**Project Scope（项目作用域）**：
单个 project，即单个 git repository 的层级（一个 `workspaceId`）。主看板一次只呈现一个 Project Scope。
_Avoid_: repo view, workspace（歧义）

**Board Scope Home Page Section Columns Board（All projects 首页分区列看板）**：
Board Scope 下没有聚焦任务时的首页（`web-ui/src/components/board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board.tsx`）。
它把 Focus View 左栏切换面板的分区横排成列：Pinned（没有置顶时隐藏）| Cache warm · your turn | Recent | Running。列序按注意力优先排，标了 `EXPERIMENT_NODE`。
- 各列独立滚动；
- 行与 hover 原地展开的完整卡片和左栏同款，渲染代码也是同一份；
- 页头写「All projects」和「N projects · X live · Y awaiting you」，右侧是「Create task (c)」。

它与单项目对称：单项目的首页是阶段列看板，Focus View 左栏是阶段竖列表；All projects 的首页是分区列看板，Focus View 左栏是同一组分区的竖列表。移动端放不下多列，直接渲染竖排面板。
_Avoid_: Board Overview、Stage-First Overview（已退役的旧首页，见下）

**Task Creation Target Project（建卡目标项目）**：
新卡要落到哪个 Project Scope。
- 单项目范围里它恒为当前项目，建卡框不显示这个字段。
- Board Scope 里建卡框多一个「Project」选择器（`web-ui/src/components/task-creation-target-project-field.tsx`）。默认取上下文项目：跨项目打开在途时是目标项目，否则是当前项目。不跨次记忆「上次所用」，免得建错仓库（`EXPERIMENT_NODE`）。同一次对话框里「Create more」保留所选。
- 目标是其他项目时，卡不进本页 board：同一个纯函数算卡，取那个项目的 runtime 预分配 id，经同一个 persist 端点落盘，不切项目。分支列表、默认 base ref、记住的终端模型都跟着目标项目走。
- 入口：热键 `c`、跨项目切换面板顶部与 All projects 首页页头的「Create task (c)」。
- 编辑其他项目的卡时，同一字段显示为只读标签（卡不能换项目）。
_Avoid_: destination repo, target workspace（workspace 已专指单个 project 的运行时作用域，这里说的是用户选的项目）

**Stage（阶段）**：
任务在看板流程中的列位置：`in_progress` / `review` / `validation` / `done`（`done` 是内部 `trash` 列的展示名）。
_Avoid_: column, status

## 已退役：Stage-First Overview（2026-07-05 → 2026-10-12）

Board Scope 首页曾是 Cross-Repository Stage-First Overview（页头 "Board Overview"），层级为 Stage → Repository → Task。
- In-Progress 按列归属取成员，再按「`turnOwner=agent` 且 5 分钟内有 PTY 输出」二分为 Active / Stale；
- Review / Validation / Done 只给计数。

它与 Focus View 左栏的切换面板是同一范围的两套模型（一套按列，一套按会话 facet），而且缺置顶、缓存倒计时、未读交接、Recent、backlog、卡片动作、git 元数据与 hover 展开。因此由上面的分区列看板取代，决策记录见 `docs/adr/0001-stage-first-overview-uses-raw-column-membership.md`（已 Superseded）。

服务端 `RuntimeProjectSummary.rawColumnTaskCounts` 原本只供它的 stage 计数使用，现在已没有前端消费者。为兼容旧 bundle，契约暂不删，后续可删。`inProgressTaskDetails` 仍被顶栏切换器的 live 计数（`deriveLiveAgentTaskCount`）消费。
