# Exploratory Mode（Session Map / Findings）—— M0–M2 集成要点

> 设计蓝图：`.plan/docs/exploratory-mode-session-map-and-findings-store.md`（状态头有 M0/M1/M2 实施注记，
> §H 的 M0–M6 是技术依赖排序）。本页是改动该子系统前必读的承重集成知识；新增阶段（M3+）
> 落地时同步更新本页与 `AGENTS.md` 的一行指针。

## 1. turn 编号权威与同源边界分类器

turn 编号权威是 `src/conversation-tree/conversation-turn-projection.ts`（纯函数：从消息流切段、
与 checkpoint 序数对齐、产出投影签名）。web-ui 的 `deriveTurnBoundariesFromChatMessages`
**直接相对路径复用**它的 `classifyConversationTurnBoundaryMessage`——改边界分类规则必须意识到
两侧同源，且它有「checkpoint 捕获时机同源单测」义务（checkpoint 在「进入 awaiting user review」
边沿按 `latestTurnCheckpoint.turn + 1` 捕获，见 `cline-task-session-service.ts` 的
`captureReviewCheckpoint`）。self-injection 轮次（RVF 程序化投递）在 Cline 消息面无可靠标记，
投影不硬猜，偏移由 `turnCheckpointAlignmentConfidence` 显式降级吸收（蓝图风险 1）。

**投影加载链只有一条**：`src/conversation-tree/load-conversation-session-turn-projection.ts`
（双廉价信号判定 Cline → 加载消息 → 枚举 checkpoint refs → 派生）。投影 query
（`conversation-tree-api.ts`）与 ingest 写回漏斗（`exploratory-api.ts`）共用它——要改加载/
判定逻辑只改这一处，绝不在任一调用方各写一份。

## 2. 投影 query 的降级面（PTY 与 ACP 同档）

投影 query（`conversationTree.getConversationSessionTurnProjection`）对非 Cline 会话返回
`unavailable_live_terminal_pty`，**ACP 也落这一档**——枚举字面语义对 ACP 不精确（其消息在
内存、非 PTY），UI 降级文案按 transport 区分、不点名 PTY；ACP 投影源形态待蓝图补章。
加载链的 Cline 判定先用 in-memory summary + 看板卡片 agentId 双廉价信号，**绝不为终端任务调
`loadTaskSessionMessages`**（对非活会话会 boot Cline SDK host，AGENTS.md 记载的 CI 卡死诱因）。

## 3. map 写入通道：CLI + apply 漏斗（M1 已落地）

agent 写回 session map 的**唯一**通道：`kanban exploratory get-session-map`（读现状集合 +
投影签名 + 最新轮次）→ 本地改成目标态 → `kanban exploratory ingest-map-update --payload ...`
（整份替换提案，非增量）。CLI 身份解析「显式 flag > env（`KANBAN_HOOK_TASK_ID` /
`KANBAN_HOOK_WORKSPACE_ID`）> 报错」，flag 与 env 不一致硬报错；workspace scope 经
`x-kanban-workspace-id` 请求头（workspaceProcedure 与 hooks.ingest 的 input 带 scope 不同，
镜像时别抄错）。

所有写入过 apply 漏斗 `src/state/exploratory-session-map-apply-funnel.ts`（tRPC mutation
`exploratory.ingestSessionMapUpdate` 内、store 串行写队列的原子区内执行）：

1. dedup（`clientProposalId` 幂等键，账本在 collection 的 `recentAppliedClientProposalIds`）；
2. 锚点可解析性（投影源可用 + `anchorTurnNumber` ≤ 投影最新 turn 即整份拒绝；checkpoint
   commit 不在保留集合 → 降级 null + 标集合级 stale，不拒绝）；
3. `sourceTurnProjectionSignature` 对账（不一致 = 作业期间来了新 turn，整份丢弃）；
4. `user_manual_edit` 冲突拒绝（用户修正优先级恒最高，提案必须原样带回）。

**durable-write-before-ack**：落盘成功才回 ack 并广播 `exploratory_session_map_updated`
（专属 WS 消息，不搭车 summary 广播）。节点 id 恒由漏斗派生 `turn-<N>-<kind>`（聊天 marker
的 id 必须与之相同，agent 可确定性预知）；`anchorTurnUserMessagePreview` 由漏斗从投影层回填，
不信 agent 自报。

## 4. 会话模式标记与指令注入（M1 已落地）

`taskConversationMode`（operational 缺省 / exploratory）声明在卡片上（建卡/编辑时声明，
legacy 卡片零迁移），启动请求从卡片快照带进来，三条 transport（terminal / cline-sdk / acp）
在建会话时盖章进 `summary.taskConversationMode`——**活会话不热切换**，卡片改模式只影响
下一次启动。exploratory 会话启动时经 append-system-prompt 把 agent 指向 Kanban 托管指令文件
`~/.cline/kanban/agent-exploratory-mode-instructions/exploratory-mode-session-map.md`
（`src/state/exploratory-mode-instructions.ts`，镜像 network-interruption-continuation-instructions；
内容含 marker 格式 + 写回协议 + 维护节律，改正文即幂等重写旧文件）。

**ensurePromise 是进程级永久缓存**——「内容漂移重写」只发生在进程内首次调用；测试跨用例
必须 `vi.resetModules()` 重引模块（每个用例换新临时 home 时尤其要）。

## 5. 防抖再维护 observer（M1 已落地）

`src/server/exploratory-session-map-maintenance-observer.ts` 挂在 runtime-state-hub 的 summary
广播 join point（与 agent-session-response-generation-stop-observer 同位，先于「0 客户端
提前返回」）。观察门：exploratory 模式 + Cline（M1 唯一可解析投影源）+ liveness==="live"。
热路径有签名门控：每次 observation 先取 O(1) 消息投影签名（条数/末条 id/末条 content 长度，
`ClineTaskSessionService.getTaskSessionMessagesProjectionSignature`，不克隆），签名未变则沿用
上次算出的 latestTurnNumber，签名变了才全量 load + derive 投影。

- **stale 判据是「投影最新 turn > map 最新锚点 turn」（存在未入图用户轮次），不是裸签名
  漂移**——裸签名对 agent 自身维护动作同样漂移，会恒亮假信号（蓝图 M1 实施注记 (1)）。
  置位 `mapStaleReason` 经 store 串行写队列幂等落账并广播；observe 侧判「领先」用的集合
  快照有进程内缓存（30s），落账时在串行写队列内对真实读到的集合按锚点覆盖复核一次，
  缓存窗口内刚被新 apply 追平的集合不假置位。
- **再维护执行者 M1 = 活会话 agent 自己**：observer 经统一发送出口投递提醒消息
  （nudge sender 由 runtime-server 经 `setExploratorySessionMapMaintenanceNudgeSender` 注入
  hub——发送 deps 只在该层齐备）。闸：仅 turnOwner==="user" 才挂 45s 静默窗（绝不插进
  agent 回合正文）、每会话并发恒 1、冷却 10min。专属 headless 再维护作业
  （`agent_maintenance_job` 来源）待姊妹蓝图 §4.1 后端。

## 6. 聊天内锚 marker 解析铁律

marker 格式 `<!-- kanban:map-anchor <mapNodeId> -->`（指令文件下发）。解析器是
`web-ui/src/components/session-map/session-map-anchor-markers.ts`，规则：

- **独占一行整行锚定**且必须处于**独立块级位置**——前/后相邻行若存在须为空行或另一 marker 行，
  否则按普通文本处理（摘除表格/列表等跨行 block 内的 marker 会切断 Markdown AST）。
- **fence 代码块内不解析**：fence 跟踪按 CommonMark 记录 opener 字符与长度，closing = 同字符且
  长度 ≥ opener，不做简单翻转。
- **反注入**：载荷只有一个 id，chip 显示内容恒来自服务端 map store（按 id 查标题），id 不可
  解析 → 不渲染 chip；每消息 chip 上限 8（视觉噪声兜底）。
- 点击 chip → 展开 map 面板 + spotlight 节点（`session-map-anchor-registry.ts`，复用
  verification spotlight 机制）。

## 7. 面板数据链路（M1：专属 WS 事件 + 低频重拉信号并存）

M1 起面板有两条更新源：

- **`exploratory_session_map_updated` WS 事件**（集合变更的主通道：agent ingest 成功 /
  stale 置位时推送完整集合，量级 = 节点数，恒小）。客户端重连后不补发，靠
  `getSessionMap` 查询对齐。
- **投影骨架（无集合时的回退展示）仍靠 summary 广播驱动重拉**——低频铁律不变：
  refreshKey 只许含 turnOwner / liveness facet 翻转 + latestTurnCheckpoint 落地，
  **绝不许拼 `summary.updatedAt`**（updateSummary 漏斗每次写都推进它，Cline 流式期间
  ~150ms 批次广播会形成无界重算与 `git for-each-ref` 子进程轮询，事件循环停摆事故的同构
  形态，见 `docs/post-mortems/event-loop-stall-lock-crash.md`）。面板态保留短路用
  `JSON.stringify` 全内容比较（不用签名比对——签名只覆盖消息流，checkpoint/facet 边沿
  感知不到）。

## 8. findings store 与写入通道（M2 已落地）

findings 是 **workspace 级**资产（v1 不跨 workspace）：per-workspace 文件
`exploratory-findings.json`，store 模块 `src/state/exploratory-findings-store.ts`（骨架镜像
map store：串行写队列 / 原子写 / 损坏容错 / 路径遍历守卫）。上限 500 条，cap-and-trim
三级裁剪序 = archived → superseded → 非 pending 最旧 updatedAt，**pending 永不静默裁**
（蓝图 M2 实施注记 (1)）。该取舍的容量语义：容量被 pending 占满时 cap 无可裁候选，
让超限更糟的写入被显式拒绝（store 抛 `ExploratoryFindingsCapOverflowError` → ingest 回
`findings_cap_overflow`、人工动作经 handler 目标存活检查回 `PRECONDITION_FAILED`），
绝不「返回成功但 finding 消失」；让总量回落的写入（reject）即使结果仍超限也放行。

**唯一写点 = `src/trpc/exploratory-api.ts` 的六个 procedure**（全部落 store 的 mutate 原语，
成功变更 durable 落盘后广播 `exploratory_findings_updated` 全量替换推送——workspace 级、
不搭车 summary 广播，同 map 的专属 WS 决策）：

- 人工主路径（zod 校验即够，蓝图 §D.2.1）：`saveFinding`（UI 生成 findingId=uuid，落库即
  active+user_saved；同 id 幂等回现状不广播）、`confirmFinding` / `rejectFinding`（仅
  pending；**reject = 物理删除**——建议尚未成为资产）、`archiveFinding`（active↔archived；
  对 pending/superseded 抛 BAD_REQUEST，superseded 互链审计不经 archive 改写）。
- agent 建议通道：`kanban exploratory ingest-finding-candidate`（CLI 骨架同 map 通道，
  投递层泛型化为 `deliverExploratoryMutation<T>`）→ `ingestFindingCandidate` mutation，
  落库即 `suggested_pending_confirmation`+agent_suggested；findingId 服务端派生
  `agent-<clientProposalId>`（同建议重发幂等 ack）。provenance 的 turn_anchor link 校验
  三态：投影可用 → turnNumber 超最新 turn 整份拒绝、checkpoint 不在保留集合降级 null；
  PTY 源 → 接受且 checkpoint 降级 null；投影加载抛错 → 拒绝
  `provenance_conversation_session_unresolvable`；容量被 pending 占满 → 拒绝
  `findings_cap_overflow`（容量语义见本节开头）。
- **map 漏斗闸 2.5（M2 新增）**：`referencedFindingId` 可解析性——任意状态含 archived 的
  finding 均可解析（archived 不级联删节点，map 是历史叙事），不可解析整份拒绝
  `referenced_finding_unresolvable`；闸序在锚点可解析性之后、签名对账之前。指令文件的
  finding_reference 已解禁：agent 先 `kanban exploratory get-findings` 列出现有 finding
  再引用（pending 可引用，但被拒后引用悬空、UI 容错展示）。

## 9. findings UI 链路（M2 已落地）

- **单一真相 = `web-ui/src/hooks/use-exploratory-findings.ts`**（App.tsx 实例化一次）：
  初始 `getFindings` query + `exploratory_findings_updated` 推送全量替换归并；mutation
  不做乐观更新，状态经推送收敛。
- **「存为 finding」**挂在 `cline-agent-chat-panel.tsx` 消息项上（Cline 与 ACP 共用同一
  组件，一个挂载点覆盖两种 transport；PTY 无结构化消息项不加）：选区在按钮 mousedown
  捕获（click 时选区已坍缩），无选区预填消息正文。provenance 组装是纯函数
  `web-ui/src/components/findings/findings-model.ts`：消息经位置性映射可锚 → turn_anchor
  三元（checkpoint commit 取投影 entries）；不可锚 → `user_authored_freeform`，
  **绝不伪造锚**。保存时按规范化标题（小写去空白标点）对 active+pending 做相似警告，
  不阻断（合并入口属 M5 §F）。
- **findings 浏览器 = `App.tsx` 的 `isFindingsOpen` home 置换**（`isGitHistoryOpen` 先例，
  非 overlay，与 overview/git history 三向互斥；入口在 top-bar）；列表 substring 搜索
  （标题+正文），archived 默认不进列表（开关可显）；待确认卡片行内确认/拒绝，active/
  archived 行内归档/恢复。
- **任务级切片**在 map 面板底部「本会话 findings」可折叠 section：过滤 provenanceLinks
  含当前会话的条目（排除 archived），待确认带角标 + 行内确认/拒绝。§G.3 深链
  （`?view=findings`）未做，属 M3。
