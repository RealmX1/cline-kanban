# 卡顿治理核查 + Batch 1 性能改进 — Handoff（2026-08-28 收尾，2026-09-07 整理）

> 接手对象：检查本批工作并继续剩余性能工作的 agent。
> 本文件是单一入口：背景、已交付、验证证据、剩余工作（含行号与坑）、验证方法。

## 0. 上下文指针

- 原始计划（2026-07-28，task 01eda 的「卡顿治理+桌面化」）：`/Users/bominzhang/.claude/plans/i-m-recently-considering-one-peppy-tome.md`。其中 A-P0 七项已于 2026-07-28 落地（commit `e2185377`）；A-P1/A-P2/桌面化从未开始。
- 本批（task 3fe15）批准计划原文：会话临时路径，可能已消亡——**其全部实质内容已浓缩进本文件第 2、4 节**，不依赖原文。
- 已部署代码：commit **`6accac9e`**（task worktree `~/.cline/worktrees/3fe15/cline-kanban`，35 文件 +2262/−117），**尚未回灌 local base `main`**。
- RVF run：`rvf-20260828T162256Z-agentic-initiation-start-6e9b08dc`（`~/.rvf/user-local-data/run-logs/runs/…`），双评审 2/2 成立，4 条 issue 全部 fixed 并合入上述 commit。

## 1. 有效性核查结论（2026-08-15 完成，10 路探查）

**A-P0 七项全部健在、无回退、有测试守住。** 逐项证据（行号以核查时 HEAD 为准，可能有漂移）：

| 项 | 关键证据 |
|---|---|
| A-P0-1 输入下沉 | `task-editor-dialog.tsx:283` promptDraft + 事件上抛 + 1.5s 停顿兜底；7 条 interaction 测试 |
| A-P0-2 聊天 memo+Prism | `cline-chat-message-item.tsx:188`、`cline-markdown-content.tsx:49`、`cline-markdown-code-block.tsx:97` |
| A-P0-3 overlay 三连修 | `dependency-overlay.tsx:645` attributeFilter、`:608/:662` 早退、`kanban-board.tsx:382` 条件挂载 |
| A-P0-4 Focus View 卸载 | `App.tsx:1278` + `stores/board-column-scroll-offset-store.ts` |
| A-P0-5 草稿去抖 | `use-task-editor.ts:150` 400ms `useDebouncedEffect`（**图片比较快/慢路径子项当年被 silently 砍掉，本批 B4 已补**） |
| A-P0-6 共享粗时钟 | `use-shared-coarse-clock.ts`（95 行单例范式，70 测试绿） |
| A-P0-7 去 motion | 全仓零匹配；shimmer 纯 CSS（但 `globals.css` 注释曾误称「合成器零成本」，本批已修正） |

**核查发现的放大器/缺口（本批已全部修复，见第 2 节）：** 每 tick 双重 App 渲染（13/s 而非 6.7/s）；服务端每次 session flush 附带全量 projects 广播（每 150ms × N projects 读 board 盘 + 全服重发）；DependencyOverlay 的 childList 洞（hover Tooltip 换壳 → 全板强制布局残留）；Rule A 自动流转 effect 每 tick O(N×卡) 全扫。

## 2. 本批已交付（commit 6accac9e 全部内容）

- **B1+B2** sessions 流引用 bailout + 消灭每 tick 第二次渲染：`use-runtime-state-stream.ts` 的 `mergeTaskSessionSummaries` 惰性拷贝（**`:52` 的 `updatedAt <=` 绝不得收紧为 `<`**——同毫秒写撞车会丢真实更新）；`task_sessions_updated` 不再进 reducer，改经 `onTaskSessionSummaries` applier 旁路直送 `use-workspace-sync.ts` 一次 `setSessions`。预期 App 渲染 13/s → ~6.7/s（**未经实测，见第 4.3 节**）。
- **B3+RVF-003** `dependency-overlay.tsx`：MutationObserver childList 过滤——含 `[data-task-id]`/`[data-column-id]` 的增删必刷新；其余 childList 也刷新，**除非完全落在 `data-card-hover-actions` 标记内**（`task-card-body.tsx` 四处宿主已挂标记）。新增 `dependency-overlay.test.tsx`。
- **B4** `task-edit-drafts.ts` 新增 `areTaskImagesEqual`（引用相等→length→逐图 id/mimeType/name/data.length 早退→`data ===`），替换 4 处 `JSON.stringify(images)`。注意 `name` 必须参与比较。
- **B5** `use-board-interactions.ts` Rule A 引用短路，带两个语义补丁：`deferredRetryTaskIds`（blocked/started 移列下 tick 重试）与 `previousAutoFlowBoardRef`（board 外变时放开全量重估）。
- **B6+RVF-001/002** `runtime-state-hub.ts`：projects 广播发送层内容去重（全局单份指纹）；新客户端注册时指纹复位（握手自愈）；注释如实描述「`lastOutputAt` 活跃期不命中」。**注意：去重只在发送层，每 150ms 的 payload 构建（各 project 一次 board 读盘）仍在发生。**
- **B7** 新建 `use-shared-fine-clock.ts`（1s，带 `enabled` 门控）；卡片 7 处 Tooltip 接 hover 门控；3 处 `toLocaleString` 改 useMemo。
- **B8** `use-cline-chat-session.ts` upsertMessage 引用快路径；`use-windowed-agent-chat-message-list.ts` slice 包 useMemo。
- **B10/B11** motion 防回魂断言（`dependency-boundary.test.ts`）、scroll store 测试+卫生、3 处撒谎注释修正、sensors 模块常量、NUL 转义。
- **B9 已撤销**：Spotlight 空 query 门控被上游「空 query 浏览全部任务」（`isBrowsingAllTasksWithoutQueryEnabled`）语义取代，bootstrap 冲突解决取 base 版本。**这三个文件（AGENTS.md、`use-task-spotlight-search-controller.ts` 及测试）在 6accac9e 中应为零改动。**

**RVF 评审修复（同 commit 内）**：RVF-001 指纹复位；RVF-002 注释修正（保留实现）；RVF-003 childList 收窄（见上）；RVF-004 runbook 行号修正（`docs/runbooks/runtime-summary-field-and-toggle.md`）。

## 3. 验证证据（如何复查本批）

- 提交前全绿：根 `npm run typecheck`、`npm run test:precommit`（139 文件/1829 例）、web-ui `tsc --noEmit`、web-ui `npx vitest run`（161 文件/1567 例）、`npm run build`（主 chunk 3.93 MB，基线 3.89 MB，+1% 为新增代码）。
- RVF validation cache：run 目录 `artifacts/validation-records.json`，handoff-validation-001…005 均 passed。**注意 005 曾有 failed 记录——那是 cwd 指到仓根跑错套件的假失败，以 `--working-directory web-ui` 重跑后 passed**；复查时别被旧记录误导。
- 每项改动均带「摘掉改动会变红」的反证测试（B3 agent 实测过反证；B5/B9 类似）。
- AGENTS.md 铁律未被触碰：facet 三件套无改动、双时间戳字段无改动、`MODAL_USER_DECISION_TURN_KINDS` 无改动。BoardCard 双宿主（`board-column.tsx` + `column-context-panel.tsx`）的 per-card action gating 本批未涉及。

## 4. 剩余工作（按性价比排序）

### 4.1 A-P1-1 看板树 memo 化（收益最大，全有或全无）

目标：150ms tick 从「重渲全部卡」变「只重渲变化的卡」。探查确认的**最新**现状（比原计划更新的漂移）：

- `React.memo` 全 web-ui 仅 5 处且全在聊天叶子组件；`board-card.tsx:12`/`board-column.tsx:20`/`kanban-board.tsx:29` 均无 memo。
- 计划要稳定化的 12 个 handler 现行行号：`use-board-interactions.ts` 的 :649/:735/:761/:814/:889/:910/:952/:984/:1010 + `use-task-start-actions.ts` 的 :74/:98/:110，全部仍闭包 `board`/`sessions`。**计划漏判一处漂移：`use-git-actions.ts` 的 `handleCommitTask`/`handleOpenPrTask`（:370/:377）经 `runTaskGitAction` 也闭包了 `board`——清单要 +2。**
- 6 处 inline lambda 现行位置：`board-column.tsx:268-277`、`kanban-board.tsx:441-445`、`column-context-panel.tsx:109-137`（`buildCardBusinessProps`）+`:434`、`App.tsx:1423-1425`。
- **新绕路：`column-context-panel.tsx:465-485` 的 `StageHeaderRails` 是 A-P0-4 之后长出的第三条卡 props 消费链**（吃 `taskSessions` + 8 个 handler），不在原计划范围，做 memo 化时必须一并处理。
- 收益前提仍成立：`use-task-sessions.ts:146-161` `upsertSession` 与客户端 merge 都保住 per-key 引用；hub 只发脏 summary（`runtime-state-hub.ts:220-260`）。
- 现成模板：`use-task-editor.ts:423-424` 与 `use-linked-backlog-task-actions.ts:57-61` 的 boardRef 范式；`use-board-interactions.ts:1080` `handleCancelAutomaticTaskAction`（deps 仅 `[setBoard]`）。
- **坑（原计划坑 #5 仍有效）**：memo 全有或全无，动手前先建「BoardCard 因哪个 prop 重渲」的可观测手段；`board-column.tsx` 与 `column-context-panel.tsx` 双宿主门控必须同步改（AGENTS.md 记载的已发 bug）。
- B1/B2 已为其铺路（sessions 对象身份在空转 tick 不再 churn）。

### 4.2 A-P1-2 语义搜索 Worker 化（中复杂度）

- 静态链原样：`task-board-semantic-vendor.ts` → `task-board-semantic-search.ts:8` → `use-task-board-search.ts` → `use-task-spotlight-search-controller.ts` → `App.tsx:383` 无条件调用。
- **实测修正原计划高估**：主 chunk 3,894,378 B raw / 879 KB gz；tfjs+orama 经 sourcemap mappings 逐源归属 ≈ **850 KB raw（22%）**，不是计划按 sourcesContent 估的 58%（tfjs dist 已预压缩）。启动 parse/eval 与主线程 embedding 计算的收益不变。
- **建议直接用 `@tensorflow/tfjs-backend-cpu`**（3.21.0 已在依赖树），跳过原计划一天的 WebGL-in-Worker spike（OffscreenCanvas 行为待验），也避免与 xterm webgl 争 GPU。worker 入口用 `new Worker(new URL("./…-worker.ts", import.meta.url), {type:"module"})`（不违反禁 inline import）；`vite.config.ts` 加 `worker:{format:"es"}`。
- 测试 mock 已存在（`use-task-board-search.test.tsx:19`、`use-task-spotlight-search-controller.test.tsx:14`），接口不变即零改动。验收：sourcemap 分包统计（主 chunk → ~3.0 MB）。
- `dist` 是指向主 checkout 的符号链接，量 chunk 时注意其时间戳。

### 4.3 部署后验证执行（已注册 3 条，需先 deploy 本批）

task 3fe15 已注册（`kanban verification list --task-id 3fe15 --project-path ~/Documents/GitHub/cline-kanban`）：

1. `8f967724-3b8f-4de7-ac1c-2d9550865c05`（automated）：WS 观察 agent 活跃期 `projects_updated` ≪ `task_sessions_updated`（B6 生效）。已在旧实例 dry-run（如期判失败 12:6，无 crash/残留）。
2. `817a4516-…`（guided）：React Profiler 录 30s，App render ≈6.7/s（验 B1+B2）。
3. `21e8663d-…`（guided）：Chrome Performance 录 hover 扫看板，Forced reflow = 0（验 B3）。

流程：deploy → `kanban deployment record` → 在验证面板逐条执行/核对。清理：`kanban verification cleanup --verification-id <id>`。

### 4.4 小尾巴

- `use-task-spotlight-search-controller.ts:95` 仍有一个字面 `\x01`（SOH）分隔符，git 仍把该文件判 binary（B9 撤销时 NUL 已随 base 修好，这个是存量）。
- B6 彻底版：payload 构建侧做失效式缓存，省掉每 150ms × N projects 的 board 读盘（registry 侧改造，比本批大）。
- `6accac9e` 回灌 local base：reviewed candidate evidence **不可用**（handoff 缺机器可校验标记，writer fail-closed），base sync 只能走 legacy 完整校验路径（`/base-branch-sync`）。
- A-P1-3 manualChunks（只改善缓存分层，xterm 不 minify 约束 `vite.config.ts:48-62` 不得动）、A-P2（session summary store——照抄 `workspace-metadata-store.ts:379-437` 的 `useSyncExternalStore` 模板；App.tsx 已 1670 行）、桌面化 Workstream B（见 01eda 计划，GAP C 真 bug 未修）。
- 原计划 Profiler 场景 A1/A2/B/C/D/E（`i-m-recently-considering-one-peppy-tome.md` 第 200-216 行）至今从未录制；`.plan/perf/` 目录不存在。

## 5. 接手第一步建议

1. `cd ~/.cline/worktrees/3fe15/cline-kanban && git log --oneline -3 && git status`（应见 6accac9e 且 clean；若 worktree 已删，从主 checkout `~/Documents/GitHub/cline-kanban` 的 git 历史找该 commit——它尚未进 main）。
2. 复跑验证：`npm run typecheck && npm run test:precommit`（根）+ `cd web-ui && npx tsc --noEmit && npx vitest run`。
3. 决定先做 4.1 还是 4.3（4.3 很快，能顺手闭环本批）。
