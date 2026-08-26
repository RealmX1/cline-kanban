# Exploratory Mode（Session Map / Findings）—— M0 集成要点

> 设计蓝图：`.plan/docs/exploratory-mode-session-map-and-findings-store.md`（状态头有实施注记，
> §H 的 M0–M6 是技术依赖排序）。本页是 M0 落地后改动该子系统前必读的承重集成知识；
> 新增阶段（M1+）落地时同步更新本页与 `AGENTS.md` 的一行指针。

## 1. turn 编号权威与同源边界分类器

turn 编号权威是 `src/conversation-tree/conversation-turn-projection.ts`（纯函数：从消息流切段、
与 checkpoint 序数对齐、产出投影签名）。web-ui 的 `deriveTurnBoundariesFromChatMessages`
**直接相对路径复用**它的 `classifyConversationTurnBoundaryMessage`——改边界分类规则必须意识到
两侧同源，且它有「checkpoint 捕获时机同源单测」义务（checkpoint 在「进入 awaiting user review」
边沿按 `latestTurnCheckpoint.turn + 1` 捕获，见 `cline-task-session-service.ts` 的
`captureReviewCheckpoint`）。self-injection 轮次（RVF 程序化投递）在 Cline 消息面无可靠标记，
投影不硬猜，偏移由 `turnCheckpointAlignmentConfidence` 显式降级吸收（蓝图风险 1）。

## 2. 投影 query 的降级面（M0：PTY 与 ACP 同档）

投影 query（`conversationTree.getConversationSessionTurnProjection`，handler 在
`src/trpc/conversation-tree-api.ts`）对非 Cline 会话返回 `unavailable_live_terminal_pty`，
**M0 起 ACP 也落这一档**——枚举字面语义对 ACP 不精确（其消息在内存、非 PTY），UI 降级文案
按 transport 区分、不点名 PTY；ACP 投影源形态待蓝图补章。handler 的 Cline 判定必须先用
in-memory summary + 看板卡片 agentId 双廉价信号，**绝不为终端任务调 `loadTaskSessionMessages`**
（对非活会话会 boot Cline SDK host，AGENTS.md 记载的 CI 卡死诱因）。

## 3. map store 与写入通道分期

session map 持久化在 per-workspace `exploratory-session-maps.json`
（`src/state/exploratory-session-map-store.ts`，骨架镜像 agent-raised-pending-user-decision-store：
串行写队列 / 原子写 / schemaVersion / 路径遍历守卫 / 集合数裁剪）。M0 只有通用 mutate 原语；
agent 写回 apply 漏斗（zod 白名单 → 锚点可解析性 → 签名对账 → `user_manual_edit` 冲突拒绝，
任一失败整体丢弃）属 M1，落在该原语之上。节点数上限（200/会话）的「超限要求重整」由漏斗
执行，store 原语不静默裁节点。

## 4. Kanban 托管指令文件模块的 ensurePromise 进程级缓存

`src/state/exploratory-mode-instructions.ts`（镜像 network-interruption-continuation-instructions）
的 `ensurePromise` 是**进程级永久缓存**——「内容漂移重写」只发生在进程内首次调用；测试跨用例
必须 `vi.resetModules()` 重引模块（每个用例换新临时 home 时尤其要）。M0 该模块尚无调用点，
模式标记 + 会话启动注入接线属 M1。

## 5. 聊天内锚 marker 解析铁律

marker 格式 `<!-- kanban:map-anchor <mapNodeId> -->`（指令文件经 §A.2 机制下发）。解析器是
`web-ui/src/components/session-map/session-map-anchor-markers.ts`，规则：

- **独占一行整行锚定**且必须处于**独立块级位置**——前/后相邻行若存在须为空行或另一 marker 行，
  否则按普通文本处理（摘除表格/列表等跨行 block 内的 marker 会切断 Markdown AST）。
- **fence 代码块内不解析**：fence 跟踪按 CommonMark 记录 opener 字符与长度，closing = 同字符且
  长度 ≥ opener，不做简单翻转。
- **反注入**：载荷只有一个 id，chip 显示内容恒来自服务端 map store（按 id 查标题），id 不可
  解析 → 不渲染 chip；每消息 chip 上限 8（视觉噪声兜底）。
- 点击 chip → 展开 map 面板 + spotlight 节点（`session-map-anchor-registry.ts`，复用
  verification spotlight 机制）。

## 6. 面板数据链路（重拉信号必须低频）

map 面板（`session-map-panel.tsx` + `use-session-map-panel-data.ts`）不新增 WS 事件，重拉信号
取自 summary 广播——**refreshKey 只许含低频边沿**（turnOwner / liveness facet 翻转 +
latestTurnCheckpoint 落地），**绝不许拼 `summary.updatedAt`**：updateSummary 漏斗每次写都推进它，
Cline 流式期间 ~150ms 批次广播会让 hook 每个批次都重发两个 query，服务端 Cline 路径每次克隆
全量消息并跑 `git for-each-ref`，长会话/多标签页下形成无界重算与子进程轮询（事件循环停摆
事故的同构形态，见 `docs/post-mortems/event-loop-stall-lock-crash.md`）。面板态保留短路用
`JSON.stringify` 全内容比较（不用签名比对——签名只覆盖消息流，checkpoint/facet 边沿感知不到）。
