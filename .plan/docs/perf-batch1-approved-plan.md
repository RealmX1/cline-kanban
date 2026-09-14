# 卡顿治理有效性核查 + 低开销性能改进批次

## Context

任务：核查 2026-07-28「卡顿治理 + 桌面化改造」计划（`~/.claude/plans/i-m-recently-considering-one-peppy-tome.md`）中 A-P0 前端性能治理在当前 HEAD（c1995d7b）上是否依旧有效，并构建所有低 overhead、低实现复杂度的性能改进，逐项 cross-validate（测试/探针/实测）。

已用 10 路并行探查完成核查（每路对照 plan 逐条验证 file:line 证据）。**总结论：A-P0 七项全部在位、无回退、测试覆盖良好；A-P1/A-P2 确认未开始。** 但探查发现了 3 个当年留下的缺口、2 个新确认的每 tick 放大器、以及一批低开销改进点。

## 核查结论（有效性部分）

**健在且有效**：A-P0-1 输入下沉（`task-editor-dialog.tsx:283` promptDraft + 事件上抛 + 1.5s 停顿兜底，7 条 interaction 测试守住）、A-P0-2 聊天 memo + Prism 缓存（`cline-chat-message-item.tsx:188`、`cline-markdown-content.tsx:49`、`cline-markdown-code-block.tsx:97`）、A-P0-3 三连修（`dependency-overlay.tsx:645` attributeFilter、`:608/:662` 早退、`kanban-board.tsx:382` 条件挂载）、A-P0-4 Focus View 真卸载 + 滚动恢复（`App.tsx:1278`、`board-column-scroll-offset-store.ts`）、A-P0-6 共享粗时钟（`use-shared-coarse-clock.ts`，70/70 测试绿）、A-P0-7 去 motion（依赖与 import 全仓零匹配）。150ms 广播底噪仍在（`src/server/runtime-state-hub.ts:54`），A-P1-1/A-P1-2/A-P2/A-P1-3 均未做。

**核查发现的缺口/新事实**（本批要修的）：

1. **每 tick 双重 App 渲染**：实际 ~13 次/秒而非 plan 估算的 6.7。Render#1 = stream reducer 每批新建 `workspaceState`（`use-runtime-state-stream.ts:349-360`）；Render#2 = `use-workspace-sync.ts:177-186` effect 再 `setSessions`，且两处 merge（`use-runtime-state-stream.ts:31-57`、`use-workspace-sync.ts:39-51`）都无条件 `{...current}` 产新引用。
2. **服务端每 tick 全量 projects 广播**：`runtime-state-hub.ts:238` 每次 flush 无条件 `broadcastRuntimeProjectsUpdated` → 每个已注册 project 读一次 board 文件 + 全服广播 → 前端又一轮 dispatch。与 sessions 流正交，批处理管不到。
3. **DependencyOverlay 的 childList 洞**：A-P0-6 的 Tooltip hover 门控导致按钮 DOM 每次 hover 卸载重挂（Fragment→组件类型变化），触发 observer `childList` 回调（`dependency-overlay.tsx:631-633` 不看 mutation 记录）→ 全板 `getBoundingClientRect` 强制布局。「鼠标扫过看板就卡」在有依赖边的看板上经此通道残留。
4. **A-P0-5 图片比较子项从未落地**：`task-edit-drafts.ts:56/:100` 仍裸 `JSON.stringify(images)` 比较（带图草稿每 burst 两次 MB 级 stringify）；plan 完成表 silently 漏掉了这一项。
5. **Rule A 自动流转 effect 每 tick 全扫**：`use-board-interactions.ts:469-474` 对全部 N 条 summary 跑 `getTaskColumnId`（全板 O(卡)），未利用「未变 summary 引用稳定」短路。
6. 小项：1s computing tick（`task-card-body.tsx:257`）不看标签页可见性；行级 Edit/Copy 两按钮（`:757/:1025`）与头部药丸 Tooltip（`:657/:672/:686/:705/:995`）未走 hover 门控；卡片 tooltip `toLocaleString` 每渲染无条件执行（`:672/:687/:706`）；Spotlight 弹层开着时每 tick O(全量文本) 重算签名（`use-task-spotlight-search-controller.ts:165-179`）；聊天 `mergeMessages` 缺引用快路径（`use-cline-chat-session.ts:44-56`）；窗口化 hook `.slice()` 每渲染换引用触发多余 scroll effect（`use-windowed-agent-chat-message-list.ts:68`）。

## 实施项（Batch 1 — 全部低开销，逐一 cross-validate）

按「改一处、测一处」推进，每项独立可回滚：

- **B1 sessions merge 双处引用 bailout**：`use-runtime-state-stream.ts:31-57` 与 `use-workspace-sync.ts:39-51` 加 `changed` 标志，无 key 被替换时返回入参原引用；reducer 分支合并结果 === 旧 sessions 时 `return state`。**不改 `:52` 的 `<=`**（同毫秒写撞车会丢真实更新）。验证：扩展 `task-session-summary-merge.test.ts` + `use-runtime-state-stream.test.tsx`（「stale 批次返回同引用」断言）。
- **B2 消灭每 tick 第二次 App 渲染**：`task_sessions_updated` 的 summaries 不再让 reducer 新建 `workspaceState`（经 ref/版本号通道直送 `useWorkspaceSync` 一次 `setSessions`）；App 对 `streamedWorkspaceState` 的其余消费（`:171` null 检查）不受影响。效果：13 → ~6.7 次/秒。验证：`use-workspace-sync.test.tsx` 现存；React Profiler 60s 录制对比（探针见下）。
- **B3 DependencyOverlay childList 过滤 + 补测试**：`:631-633` 回调遍历 MutationRecord，仅当增删节点含 `[data-task-id]`/`[data-column-id]` 元素才 `scheduleRefresh()`；顺带用 jsdom 探针证实「Tooltip 翻转导致按钮重挂」的推断。补三连修回归测试（attributeFilter 断言 / 无依赖不 observe / 条件挂载断言）。验证：新增 `dependency-overlay.test.tsx`（spy `getBoundingClientRect`，模式见 `kanban-board.test.tsx:114`）。
- **B4 图片比较零分配快路径**：新建共享 comparator（引用相等 → length → 逐图 `id`/`mimeType`/`data.length` 早退 → 全过才 `data ===`），替换 `task-edit-drafts.ts:56/:100` 与 `task-edit-draft-recovery-notice.tsx:59/:88` 三处 `JSON.stringify(images)`。注意真实字段是 `data` 不是 plan 写的 `dataUrl`。验证：`use-task-editor.test.tsx:700-824` 草稿 harness 加带图用例 + 「comparator ≡ stringify 结果」property 式等价断言。
- **B5 Rule A effect 引用短路**：`use-board-interactions.ts:471` 前加 `if (previous === summary) continue;`。语义安全（持续产出 ⇒ 引用必新，时间依赖分支不会被误跳）。验证：`use-board-interactions.test.tsx` 加「未变引用不触发移列」用例。
- **B6 服务端 projects 广播去重**：`runtime-state-hub.ts:238` 改为对 projects payload 做 hash/字符串去重，未变则不发（<20 行，比 facet 边沿检测简单且无语义风险）。验证：hub 测试加「无变化不重发」用例；前端行为不变由现有测试兜底。
- **B7 卡片小项打包**：(a) 1s computing tick 收敛为可见性门控的共享细时钟（照抄 95 行粗时钟范式，复制其测试套件改间隔断言）；(b) 行级 Edit/Copy + 头部药丸 Tooltip 接入 hover 门控（2+5 处一行改）；(c) `toLocaleString` 结果按时间戳 `useMemo`。验证：`board-card.test.tsx`（56 例）+ `task-card-body.elapsed-pills.test.tsx`（9 例）回归 + 新时钟测试。
- **B8 聊天链路两处**：(a) `upsertMessage` 加引用相等快路径（一行，流式 chunk 不再逐条 `areMessagesEqual`+stringify）；(b) `use-windowed-agent-chat-message-list.ts:68` 的 slice 包 `useMemo`。验证：`use-cline-chat-session.test.tsx`、`use-windowed-agent-chat-message-list.test.tsx` 现存。
- **B9 Spotlight 签名重算门控**：`use-task-spotlight-search-controller.ts:165-179`，query 为空时跳过 `buildTaskBoardSearchDocuments` 签名重算直接复用缓存。验证：`use-task-spotlight-search-controller.test.tsx` 加「board 换引用但 query 空 → 不重算」断言。
- **B10 防回归守卫**：(a) 依赖边界测试断言 web-ui 无 motion 依赖/import；(b) `board-column-scroll-offset-store` 挂载→滚动→卸载→重挂载恢复测试（顺带让 `clearAllBoardColumnScrollOffsets` 不再是死代码）；(c) 顺手修正两处撒谎注释（`task-editor-dialog.tsx:604`、interaction 测试名「close saves a draft」实为清草稿）与 `globals.css:1167` 「合成器零成本」的错误注释。
- **B11 卫生项（零风险顺手做）**：`use-stage-header-pin-layout.ts` 与 `use-task-spotlight-search-controller.ts` 里的字面 NUL 字节改 `"\0"` 转义；`kanban-board.tsx:393` `sensors` 数组提升为模块常量；scroll store 写入加无变化跳过 + `workspaceId` 参数改名 `workspaceKey`。

## 全局验证（cross-validation）

1. 每项改完跑对应现存测试文件；全部完成后 `npm run typecheck`（根 + web-ui）+ `npm run test:precommit` + web-ui vitest 全量。
2. **实测探针**：React DevTools Profiler（或渲染计数探针）录 60s agent 流式会话，对比改动前后 App 根 render 次数（预期 13/s → ≤6.7/s）与 BoardCard 重渲范围；Chrome Performance 录「鼠标扫过有依赖线的看板」验证 B3 后 Forced reflow = 0。基线与改后各存一份到 `.plan/perf/`。
3. B2/B6 涉及广播链路，用 `web-ui` e2e（`tests/` Playwright）冒烟 + 手动开两个项目页确认 sessions/projects 更新无延迟回归。
4. `npm run build` 确认产物无变化级回归（B 批不动 bundle 构成，主 chunk 应维持 ~3.89 MB）。

## Non-goals（本批明确不做）

- **A-P1-1 看板树 memo 化**：全有或全无（12+2 handler 稳定化 + 6 处 lambda 契约改造），blast radius 大，不符合「低复杂度」门槛；B1/B2 是它的便宜前置。
- **A-P1-2 语义搜索 Worker 化**：中等复杂度（worker 协议 + 异步客户端改造），收益约主 chunk −22%（~850 KB raw，非 plan 高估的 58%）。
- **A-P2 session store / App 拆分**、**A-P1-3 manualChunks**、React Compiler、shimmer transform 化、服务端轮询模型重构。
- 桌面化 Workstream B 全部。

（备选：若批准时选择含 Batch 2，则追加 A-P1-2 Worker 化〔直接用已在依赖树的 CPU backend，跳过 WebGL-in-Worker spike〕+ `React.memo(TaskEditorDialog)`〔hoist `App.tsx:1524-1530` 与 `:1573` 两处不稳定 prop〕。）
