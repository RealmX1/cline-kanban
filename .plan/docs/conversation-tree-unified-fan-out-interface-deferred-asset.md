# Conversation Tree（会话树）—— unified fan-out 界面延期资产

> 状态：**延期资产（deferred asset），实现推迟到「Task Force」落地之后启动**。
> Task Force = 一个主 agent + 它 fan out 的各个 subagent 在同一大任务下组成的系统（另行设计，
> 本蓝图只在 §6 列出对它的接口依赖清单）。本蓝图先锁定数据模型、持久化、tRPC 契约与 web-ui
> 结构决策；§7 大纲中标注了不依赖 Task Force 即可先行的 Stage 0 范围。
> 基底与姊妹蓝图：单 by-the-way 侧会话机制（`runtimeTaskConversationSessionMetadataSchema`，
> `src/core/api-contract.ts:450-459`）、每 turn git checkpoint（`src/workspace/turn-checkpoints.ts`）、
> Option C 血缘/dispatch 蓝图（`.plan/docs/option-c-kanban-owned-dispatch-await-deferred-asset.md`）。

## 需求（用户原语）

1. **Unified fan-out interface**：从一个 agent 会话 fan-out 出不同 branch；每个 branch 可以是
   **独立的 task**（新看板卡片），也可以是 **by-the-way 讨论/解释**（同 task 内侧会话）。
2. **树元素单元三种粒度可切换**：纯 **turn**（最细、cluttered）、纯 **agent session**（最粗、
   无法标明 fan-out 的 turn 锚点与顺序）、默认 **GroupedTurn**（把无 fan-out 点的连续 turns
   按内容统合成组，减少 clutter）。
3. **归组由 agent 自己的廉价 fork 维护**：组边界、标题/摘要、新 turn 到来后的再归组等此功能的
   维护工作，都可由 agent fork 承担；用户可手动调整且手动结果优先。

## 决定设计的代码事实（已核实）

1. **by-the-way 已是「半棵树」**：同一 `workspaceTaskId` 下 main + by_the_way 都是独立
   `RuntimeTaskSessionSummary`，父指针（`parentTaskConversationSessionId`）与锚点
   （`mainSessionOriginTurnNumber`）字段已在，但被三处硬限制钉死：「fork main 当前 turn」
   单闸——已存在任一 by-the-way 即禁再携带上下文 fork（web-ui
   `task-conversation-sessions-panel.tsx:95` 的 `byTheWaySessions.length === 0` 闸只禁用
   fork 选项 + `runtime-api.ts:279-299` 服务端仅对 `forked_from_main_current_turn` 拒绝；
   `started_from_scratch` 的 by-the-way 不受此闸、已可创建多条）、携带上下文只能 fork main
   当前 turn、强制 plan 只读（`runtime-api.ts:346-348`）。
2. **turn checkpoint ref 目前只活两轮**：每 turn `update-ref` 到
   `refs/kanban/checkpoints/{base64url(taskId)}/turn/{n}`，但轮换出 summary 的
   `previousTurnCheckpoint` 后 ref 即被删（`hooks-api.ts:180-187`、
   `cline-task-session-service.ts:930-941` 两处）。git ref 本身就是天然的全量 turn 索引
   （`for-each-ref` 可枚举），「任意历史 turn 锚点」只需改保留策略，不需要新持久化文件。
3. **turn 结构化程度按 harness 分裂**：Cline SDK 有结构化 `ClineTaskMessage[]`
   （`cline-session-state.ts:97-115`）且 SDK 自持久化全量历史；终端 agent（claude/codex/cursor）
   运行期只有 PTY 流，结构化 turn 只能事后从 CLI transcript JSONL 提取——提取骨架已存在
   （`src/agent-session-history/available-agent-session-index.ts`，含 mtime+size 签名缓存与
   读预算，现只提 3 条预览 turn）。
4. **summary 是安全的加性载体**：`taskConversationSessionMetadata` 是纯 metadata 字段，不触碰
   facet superRefine 护栏（`api-contract.ts:541-604`）；新字段经两个 `updateSummary` 漏斗写入后
   自动搭乘 `onSummary → queueTaskSessionSummaryBroadcast → task_sessions_updated` 广播链路。
5. **SDK 多 agent 原语存在但被显式关闭**：`@clinebot/core` 有 AgentTeams / `createSpawnAgentTool` /
   checkpoint-restore，Kanban 在 `cline-session-runtime.ts:221-222` 硬编码
   `enableSpawnAgent:false / enableAgentTeams:false`，边界层未桥接——开启方式归 Task Force 决定。
6. **web-ui 侧**：无路由（视图切换 = React state）；无任何图/树可视化库；`react-virtuoso` 已在
   依赖（`git-commit-list-panel.tsx` 先例）；「同一数据多视图模式」先例 = `DiffViewMode`
   枚举 + segmented control（`diff-viewer-panel.tsx:44`）；全屏先例 = `isDiffExpanded`
   宽度置换（`card-detail-view.tsx`，非 Dialog）；树的扁平前身 = `TaskConversationSessionsPanel`。

## 总纲

**树的形状不新建持久化真相源**——树 = 「per-session 分支描述符（sessions.json 内 summary
metadata）+ 看板卡片血缘字段（board.json 内，与 Option C 共用）」的**装配投影**；唯一新增的
持久化资产是 GroupedTurn 文件（它不是会话状态，生命周期独立于会话）。拓扑不变量：会话树是
严格的树（single parent、无 merge/fan-in），by-the-way 分支永不合回、task 分支单向派生——
这直接决定了 §5 的可视化选型（不需要通用 DAG 引擎）。

---

## §1 树数据模型：把 by-the-way 泛化成树

### 1.1 节点与边

树有**两类节点**：

- **会话节点**：同一树根任务下的 task-conversation-session（trunk main 会话、侧讨论分支、
  未来 Task Force subagent 会话）。真相 = summary 内的分支描述符。
- **子任务引用节点**：fan-out 成独立看板卡片的分支。真相 = 卡片上的血缘字段（Option C 的
  `parentTaskId` + 扩展后的 `taskAgentSessionInitialization`），**不**在父任务 sessions record
  里重复登记——单一真相，树装配时 join（这同时消解了「客户端需要 agent 原生 session UUID →
  conversation session 映射」的问题：跨卡片边由服务端装配 query 从 board.json join 出来，
  join 到父会话节点的键 = §1.3 的 `sourceParentConversationSessionTaskId`（Kanban 会话 id）
  ——不是 harness 原生 `sourceSessionId`，后者对 Cline / 嵌套 by-the-way 无法映射到会话节点）。

分支种类是**边的属性**（fork 描述符）：

```ts
export const runtimeConversationTreeBranchKindSchema = z.enum([
  "side_discussion_session_branch",      // 同 task 内侧会话讨论/解释（by-the-way 泛化）
  "independent_child_task_branch",       // fan-out 成独立看板卡片的子 task
  "task_force_subagent_session_branch",  // 预留：Task Force subagent（语义由其设计敲定）
]);
```

### 1.2 会话侧：分支描述符 schema（加性可选，legacy 双表示 + descriptor wins）

不改动/收窄现有 `runtimeTaskConversationSessionMetadataSchema` 任何字段（旧盘数据与旧谓词
继续工作）；在其内部新增可选嵌套对象，present 即优先于 legacy 字段：

```ts
export const runtimeConversationTreeSessionBranchDescriptorSchema = z.object({
  // 树根 = 拥有 trunk main 会话的看板任务 id
  conversationTreeRootWorkspaceTaskId: z.string(),
  // 父会话指针：null = trunk main 会话本身；嵌套 fork 即指向另一分支会话
  conversationTreeParentConversationSessionTaskId: z.string().nullable(),
  conversationTreeBranchKind: runtimeConversationTreeBranchKindSchema.nullable(), // trunk 为 null
  // ── fork 锚点（三元冗余，见风险 1）──────────────────────────────
  conversationTreeForkAnchorTurnNumber: z.number().int().positive().nullable(),
  conversationTreeForkAnchorTurnCheckpointCommit: z.string().nullable(),
  conversationTreeForkAnchorUserMessagePreview: z.string().nullable(),
  // ── 上下文种子策略（泛化 taskConversationSessionContextSource）──
  conversationTreeBranchContextSeedStrategy: z.enum([
    // Cline SDK 原生：祖先持久化消息裁剪到锚点 turn 末尾后灌入 initialMessages
    "seeded_with_full_ancestor_message_history_up_to_anchor_turn",
    // 终端 agent 降级：投影层提取 turn 1..N 摘要生成 prep 文件（有损，镜像卡片 prepFilePath 机制）
    "seeded_with_transcript_digest_prep_file_up_to_anchor_turn",
    "started_from_scratch_no_ancestor_context",
  ]),
  // ── 工作区访问模式（泛化 by-the-way 强制 plan 只读）─────────────
  conversationTreeBranchWorkspaceAccessMode: z.enum([
    "read_write_trunk_main_session_task_worktree", // 仅 trunk 主会话（自有 task worktree，可读写）
    "read_only_side_discussion",           // 共享父 worktree：plan 模式 + 只读 system prompt 注入
    "read_write_own_child_task_worktree",  // 仅 independent_child_task_branch 允许（硬不变量 1）
  ]),
  conversationTreeBranchCreatedAt: z.number(),
});
// 挂载点：runtimeTaskConversationSessionMetadataSchema 新增可选字段
//   conversationTreeSessionBranchDescriptor
```

**Legacy 单向映射**（读时派生，永不回写 legacy 字段；必须覆盖 legacy 的全部合法组合，
既有会话一个都不得在树装配中丢节点）：

- `role=main` → trunk：父指针 = null、branchKind = null、accessMode =
  `read_write_trunk_main_session_task_worktree`；
- `role=by_the_way` + `contextSource=forked_from_main_current_turn` →
  `side_discussion_session_branch` +
  `seeded_with_full_ancestor_message_history_up_to_anchor_turn` + 锚点 =
  `mainSessionOriginTurnNumber`；
- `role=by_the_way` + `contextSource=started_from_scratch` →
  `side_discussion_session_branch` + `started_from_scratch_no_ancestor_context` + 锚点 =
  `mainSessionOriginTurnNumber`（仅时间锚，对应 §5.3 的虚线边；legacy
  `parentTaskConversationSessionId` 此时为 null，父会话按 `workspaceTaskId` 取 trunk 主会话）。

**Legacy 写侧兼容（descriptor 与 legacy 双写）**：新分支会话写 descriptor 的同时照常写 legacy
`role/contextSource`（descriptor wins，见风险 6）。`task_force_subagent_session_branch` 的
legacy `taskConversationSessionRole` 恒写 `by_the_way`——**不**加性扩展 legacy 枚举；旧谓词把
subagent 会话保守归类为侧会话是可接受的降级，descriptor present 时新谓词按 branchKind 正确
分类。映射函数、树装配纯函数与谓词一律进新文件
`src/core/conversation-tree-lineage.ts`（镜像 `session-activity.ts` 的纯函数真相源模式）。

**硬不变量（服务端 start 校验，v1）**：

1. **同 worktree 并发写禁止 by construction**：`read_write` 访问模式只允许自有 worktree 的
   会话——trunk 主会话（`read_write_trunk_main_session_task_worktree`，自有 task worktree）与
   `independent_child_task_branch`（`read_write_own_child_task_worktree`，自有子任务 worktree）；
   一切共享父 worktree 的会话分支恒为 `read_only_side_discussion`（把现状「by-the-way 强制
   plan」升格为结构性规则）。
2. 父会话必须存在且属于同一树根；锚点 turn ≤ 父会话已投影最新 turn；嵌套深度上限 3、
   每任务分支数软上限 12（防 clutter 与 provider 花销）。
3. **多分支放开** = 删除 `runtime-api.ts:290-299` 的「已有 by-the-way 则禁 fork」拒绝分支与
   web-ui `length === 0` 闸。旧闸存在的根因是「fork 当前 turn」的锚随主会话推进漂移；锚定
   fork（不可变锚 = checkpoint commit + 消息裁剪切片）使多分支天然安全，根因被消解。

### 1.3 卡片侧：子任务分支血缘（与 Option C 合流）

`runtimeTaskAgentSessionInitializationSchema` 加性扩展：

```ts
sourceSessionForkAnchorTurnNumber: z.number().int().positive().optional(),
sourceSessionForkAnchorTurnCheckpointCommit: z.string().optional(),
// 父会话节点定位：Kanban conversation session id（= 父会话 summary 的 taskId）。
// 既有 sourceSessionId 是 harness 原生 session UUID（api-contract.ts:114，且 sourceAgentId
// 枚举仅覆盖终端 agent）——对 Cline 会话与嵌套 by-the-way 无法反查 Kanban 会话节点；
// 跨卡片边靠本字段 join 到正确的父会话节点，从非 main 会话 fan-out 时不可省略。
sourceParentConversationSessionTaskId: z.string().optional(),
```

配合 Option C 已设计的卡片字段 `parentTaskId`（定位父 task；父会话节点由上面的
`sourceParentConversationSessionTaskId` 定位）。**关键机制决策**：子任务卡片的 `baseRef` 直接
设为锚点 checkpoint commit——`captureTaskTurnCheckpoint` 产出的是含未提交改动的真实 commit
（`turn-checkpoints.ts:32-70`），子 worktree 从它长出即精确重现父任务锚点 turn 的工作区状态。
「从 turn N fan-out 一个子任务」= 现有 `addTaskToColumn` + 四个加性字段，零新机制。子任务与
父任务间照常落一条 `runtimeBoardDependencySchema` 边（扁平 DAG 不动，树只是其上的血缘投影）。

### 1.4 任意历史 turn 锚点的两个前置

- **checkpoint 全量保留策略变更**：把「新 checkpoint 落定后删轮换 stale ref」（代码事实 2 的
  两处）改为「任务存续期保留全部 turn ref；任务删除 / trash 清空时
  `deleteAllTaskTurnCheckpointRefs` 按前缀批删」。summary 仍只带 latest/previous（不增肥广播）；
  全量列表由新增 `listTaskTurnCheckpointRefs(cwd, taskId)`（`git for-each-ref`）按需枚举。
  加每任务 ref 上限（默认 200，超限从最老滚动删除并在投影层标记「锚点不可用」）。
- **消息裁剪到锚点 turn**：Cline 路径在现有 fork 流（`runtime-api.ts:329-333`
  `loadPersistedTaskSessionMessages` → `initialMessages`）中插入按 §2 投影 turn 边界索引的切片
  （保留至第 N+1 个用户提交前的全部消息）。**不**复用 SDK `trimMessagesToCheckpoint`——它按
  SDK 自己的 checkpoint runCount 裁剪，与 Kanban turn 编号无对应；留作交叉验证参考。
  终端 agent 路径 v1 只支持「最新 turn fork」（现状 `fork_existing_session`）+「prep 文件摘要
  种子」两档，能力矩阵显式声明。

---

## §2 Harness-neutral turn 投影层

### 2.1 定位与来源

投影层是**只读派生层**（无持久化真相，仅缓存），为三种视图粒度供给统一 turn 序列，并为 §1
消息裁剪、§3 归组提供 turn 边界索引。新目录 `src/conversation-tree/`：

- **Cline SDK 源**：从 `ClineTaskMessage[]` 派生。turn 边界 = 用户提交序（`role==="user"` 且
  经 `conversationTurnBoundaryClassification` 判定非注入类消息——self-injection followup /
  hook 注入不算边界；判定函数必须与 checkpoint 捕获时机语义对齐、同源单测）。
  置信度 `exact_structured`。
- **终端 agent 源**：泛化 `available-agent-session-index.ts` 的三格式 JSONL 解析骨架为
  **全量 turn 提取器**：同款签名缓存（mtimeMs+size），按会话单文件、按需触发、增量续读
  （lastParsedByteOffset + lastEmittedTurnNumber；size 缩小视为文件替换全量重解析）。
  **offset 推进不变量**：`lastParsedByteOffset` 只允许推进到最后一个**完整换行结尾**记录的
  边界，尾部不完整行（live-tail 半行，风险 3）不推进 offset、留待下次重读——若 offset 越过
  半行推到文件末尾，该记录补全后会从其后开始解析，永久漏 turn 并破坏与 checkpoint 的序数
  对齐。置信度 `transcript_reconstructed`；运行中会话末尾 turn 标 `turnIsInProgress`。
- **不可用态**：`harnessSource: "unavailable_live_terminal_pty"`，UI 按 session 粒度降级。

**turn 编号权威**：服务端投影是 turn 编号的唯一权威（与 checkpoint 序数对齐）。web-ui 的
客户端消息切段（`deriveTurnBoundariesFromChatMessages`，见 §5.5）只用于「树节点 → 聊天消息
锚点」的滚动定位映射，不得自行编号 turn。

### 2.2 tRPC query 形状

```ts
// query: getConversationSessionTurnProjection
// 请求 { conversationSessionTaskId, sinceTurnNumber?, maxTurnEntries?(≤500) }
// 响应 entry：
//   { turnNumber, turnStartedAt, turnUserMessageExcerpt(≤400 chars),
//     turnAssistantResponseExcerpt(≤400 chars), turnMessageCount,
//     turnCheckpointCommit, turnCheckpointAlignmentConfidence:
//       "exact_ordinal_match" | "best_effort_ordinal_match" | "unaligned",
//     turnIsInProgress, turnHasConversationTreeForkAnchor }
// 响应根：{ harnessSource, turnProjectionEntries, turnProjectionSignature,
//           turnProjectionIsIncomplete }

// query: getWorkspaceTaskConversationTreeProjection —— 树装配
// 输入 { conversationTreeRootWorkspaceTaskId }；输出：会话节点（分支描述符 + summary facet
// 三元组）∪ 子任务引用节点（cardId / parentTaskId /
// sourceParentConversationSessionTaskId / 锚点字段 / 当前列 + Option C 结果信封若已回灌），
// 边 = 会话节点间的描述符父指针 ∪ 跨卡片边（按 sourceParentConversationSessionTaskId
// join 到父会话节点；缺失时降级挂 trunk 主会话）。装配 = fold(两个 manager 的
// listSummaries) ⋈ board.json 血缘字段，无新真相源。
```

### 2.3 缓存与增量

- 签名：Cline = `{messageCount}:{lastMessageId}:{lastMessageContentLength}`——末项必须是
  末条消息 content 长度而非 createdAt：流式期间 assistant chunk 以同 id 原位追加
  （`cline-session-state.ts` `appendAssistantChunk`），messageCount / lastMessageId /
  createdAt 三者全程不变，只有 content 长度能感知追加、使缓存失效（与 §5.5 客户端 memo 键
  同构）；终端 =
  `{mtimeMs}:{size}:{lastParsedByteOffset}`。签名即 `turnProjectionSignature` 原文，兼作 LRU
  缓存键校验（沿用 `parsedSessionCache` 模式）。
- turn 投影不新增 WS 事件：`task_sessions_updated` 里 summary 的 `updatedAt` /
  `latestTurnCheckpoint` 变化即客户端重拉信号（`sinceTurnNumber` 增量控制成本）。
  GroupedTurn 更新是例外（见 §3.3——归组作业完成不必然 bump summary，需专用 WS 消息）。

---

## §3 GroupedTurn 持久资产

### 3.1 存储与 schema

新文件 **`conversation-tree-grouped-turns.json`**，与 board.json / sessions.json 同级
（per-workspace 目录），经同款「schema 校验 + lockfile + 原子写 mutate 漏斗」读写（新增
`mutateConversationTreeGroupedTurnState`，镜像 `mutateWorkspaceState`）。**不**进
sessions.json：该文件对终端会话仅 shutdown 落盘，而组资产必须独立于会话生命周期存活。

```ts
export const workspaceConversationTreeGroupedTurnEntrySchema = z.object({
  groupedTurnEntryId: z.string(),
  // 成员 turn 闭区间；集合级不变量：有序、连续、互不重叠、内部不得含 fork 锚点 turn
  //（锚点只允许出现在区间末位——「组只统合无 fan-out 点的连续段」的形式化）
  memberTurnRange: z.object({
    firstTurnNumber: z.number().int().positive(),
    lastTurnNumber: z.number().int().positive(),
  }),
  groupedTurnTitle: z.string().max(80),
  groupedTurnSummary: z.string().max(400).nullable(),
  groupedTurnGenerationSource: z.enum(["agent_fork_maintenance_job", "user_manual_edit"]),
  groupedTurnGenerationJobId: z.string().nullable(),
  groupedTurnInvalidationReason: z.enum([
    "fork_anchor_inserted_inside_member_turn_range",
    "turn_projection_signature_drift",
  ]).nullable(),   // 非 null = stale，等待重归组作业
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const workspaceConversationTreeGroupedTurnStateSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  groupedTurnCollectionsByConversationSessionTaskId: z.record(z.string(), z.object({
    sourceTurnProjectionSignature: z.string(),  // 归组所依据的投影签名，apply 乐观并发对账
    groupedTurnEntries: z.array(workspaceConversationTreeGroupedTurnEntrySchema),
    // 开放边界（frontier）：该值 = 首个未归组 turn 号，≥ 该值的 turn 尚未归组，
    // UI 以裸 turn 呈现；未归组 turn 数 = 最新已投影 turn 号 − 该值 + 1
    ungroupedFrontierStartsAtTurnNumber: z.number().int().positive(),
  })),
});
```

### 3.2 失效与再归组（v1 append-only）

- **新 turn 到来**：已闭合组永不改写；新 turn 累积在 frontier。未归组 turn 数
  （= 最新已投影 turn 号 − `ungroupedFrontierStartsAtTurnNumber` + 1）≥ 阈值（默认 4）或
  会话进入 user turn 且防抖窗静默后触发归组作业（§4），frontier 指针前移。
- **fork 锚点插入既有组内部**（锚定 turn K 严格位于组 [i..j] 内部）：start-branch 服务端事务内
  同步标 stale，UI 立即降级裸 turn；重归组作业把组确定性切成 [i..K] / [K+1..j] 再补题。
- **用户手动编辑优先级恒最高**：`user_manual_edit` 组维护作业永不触碰（唯一例外是上述
  fork-切分，切分保留原标题加 `(拆分)` 后缀、来源仍标 user_manual_edit）；手动拆/并/改题走
  专用 mutation 直写，apply 端对 pending 作业输出做区间冲突拒绝。

### 3.3 广播

归组状态变更（作业 apply 成功 / 手动编辑 / stale 标记）经 runtime-state-hub 新增 WS 消息
**`conversation_turn_grouping_updated`**（携带受影响 conversationSessionTaskId 的完整分组集合，
量级 = 组数，恒小）推送；web-ui reducer 新 case 落入
`conversationTurnGroupingBySessionId`。不搭车 summary 广播——归组变更不必然 bump summary，
且组数据不属于会话状态。

---

## §4 Agent-fork 维护作业（归组 / 标题 / 摘要）

### 4.1 作业形态：接口先行，执行后端可替换

定义稳定接口 `ConversationTreeGroupedTurnMaintenanceJobRunner`，两个执行后端：

- **Stage 0 后端（不依赖 Task Force）——ephemeral headless completion**（**interim 降级
  方案**，仅为 Task Force 前的可替换过渡实现，不是需求 3 的目标机制）：新原语
  `src/conversation-tree/ephemeral-headless-cline-completion.ts`，以
  `clineProviderService.resolveLaunchConfig` 凭据发起**单次、无工具、无持久化**的 SDK 补全。
  刻意**不**注册为 task session：不产生 summary、不进广播、不进看板——绕开「隐藏服务会话
  要不要广播」的整条泥潭。
- **Task Force 后端（落地后替换，目标机制）**：需求 3「归组由 agent 自己的廉价 fork 维护」
  的正解形态——同一输入输出契约改经其廉价 subagent fork 原语执行，
  换取统一血缘 / 预算 / 可观测性（§6 依赖 5）。

### 4.2 触发时机

1. **turn 边沿**：两条 checkpoint 捕获路径（`hooks-api.ts:171-191` 终端、
   `cline-task-session-service.ts:930-941` Cline）完成 `applyTurnCheckpoint` 后投递触发信号；
2. **防抖**：每会话 30-60s 静默窗合并触发，会话活跃期间不抢跑；
3. **未归组 turn 数阈值**（§3.2）与 **UI 手动「立即归组」** mutation。
   每会话并发恒为 1（新触发合并进 pending）。

### 4.3 输入输出契约与失败容忍

- **输入**：任务标题、frontier turn 有界摘录（每 turn 用户消息 ≤400 chars + 助手响应摘录
  ≤400 chars，取自 §2 投影）、相邻已闭合组标题（风格连续性）、stale 组切分区间（若有）。
- **输出**：严格 JSON → zod 解析为 `{ proposedGroupedTurnEntries: [...] }`。
- **apply 漏斗（唯一写点）**依序校验，任一失败整体丢弃：JSON 可解析 → 区间连续/不重叠/
  不越 frontier/不含内部锚点 → 不与 `user_manual_edit` 区间冲突 →
  `sourceTurnProjectionSignature` 与 apply 时刻一致（不一致 = 作业期间来了新 turn，丢弃并按
  新边沿重触发）。
- **失败容忍**：解析失败/超时/预算拒绝 → 指数退避重试 ≤3 → 放弃后 frontier 保持裸 turn
  （纯 UI 降级，永不阻塞会话主流程）；ephemeral 后端无状态，崩溃无残留。

---

## §5 Web-UI：挂载、可视化、三粒度、fan-out 交互、性能

### 5.1 双层挂载（不新增路由）

- **Tier 1 常驻侧栏**：新组件 `ConversationTreePanel` 原位替换 `card-detail-view.tsx` 的
  `TaskConversationSessionsPanel` 挂载点（该位置已是「会话拓扑」语义位；fan-out 入口必须离
  聊天面板近；props 面全量继承，接线改动最小）。侧栏形态 = 紧凑纵向树（主干在左的 git graph
  式竖线、分支右缩进一档、单行/双行紧凑节点）。
- **Tier 2 全屏画布** `ConversationTreeExpandedOverlay`：复用 `isDiffExpanded` 的**宽度置换
  先例**（非 Radix Dialog——保持 CardDetailView 生命周期内、不打断 chat/terminal 挂载与 WS
  订阅、与 diff expand 心智一致）。新增 state `isConversationTreeExpanded`，与 `isDiffExpanded`
  **互斥**（后触发者胜）。全屏画布右侧可折叠 dock 预览列为后期增强。

**选中协议**（树 ↔ 聊天/终端面板联动）：

| 树上动作 | 效果 |
|---|---|
| 单击 session 节点 | `setSelectedTaskConversationSessionId`（现有机制，面板自动切换） |
| 单击 turn / GroupedTurn 节点（Cline 会话） | 切会话 + `ClineAgentChatPanelHandle` 新增 `scrollToMessageAnchor(messageId)` 定位并短暂高亮 |
| 单击 turn 节点（PTY 终端会话） | 只切会话（xterm 无消息锚点），tooltip 说明 |
| 单击子任务分支节点（跨卡片） | 走 App 层 `onCardSelect` 跳目标卡片；目标树面板 header 显示「← 从 {来源卡片} 分出」回链 |

### 5.2 可视化技术选型：手写 DOM 文档流主干 + 行级 gutter SVG 连线（零新依赖）

**不引入 @xyflow/react（React Flow）/ d3 / dagre / elkjs。** 理由：

- 拓扑是「线性主干 + 浅层不合流分支」的严格树（总纲不变量），用不到通用 DAG 引擎 90% 能力；
- 节点是富内容变高卡片：文档流原生支持变高，React Flow 绝对定位需两趟测量布局，流式期间
  摘要变化引发全图重排；
- 虚拟化：`react-virtuoso` 已在依赖且与文档流兼容；React Flow 画布需自研视口裁剪；
- 主题/bundle：Tailwind tokens 直接用、零新依赖 vs +50-70 kB gz 与内置 CSS 覆盖；
- pan/zoom：纵向滚动即导航（主干本来就是时间轴），全屏画布补 CSS `transform: scale`
  三档 zoom 即可；`html-to-image` 已在依赖可直接导出 DOM 树。

**布局引擎**（纯函数可单测）：`assignConversationTreeBranchLanes` —— 输入按时间排序的节点
序列 + 亲子边，输出 `{ rowIndex, laneIndex }`。主干恒 lane 0；分支按锚点 turn 出现处取首个
空闲 lane（git graph 式区间占用表，无 merge 归还复杂度）；折叠即释放 lane；侧栏窄容器 lane
上限 3，溢出折叠为「+N」stub。

**连线渲染**：每个虚拟化行自带固定宽度 gutter 单元格，行内画贯穿竖线段 + 本行分叉圆角折线
（小段内联 SVG）。连线随行虚拟化，**不做全图大 SVG**。

**决策门（Task Force 后复核）**：若 Task Force 引入真正的 DAG 语义（subagent 结果回灌合流、
跨任务依赖边可视化），「树 + 泳道」前提失效，届时再评估 React Flow。

### 5.3 三种粒度的节点/边设计

统一枚举 `ConversationTreeGranularity = "turn" | "grouped_turn" | "session"`，默认
`"grouped_turn"`。header segmented control（`DiffViewMode` 先例，手写 tablist），选择持久化
`LocalStorageKey.ConversationTreeGranularityMode`。

- **session 模式**：节点 = 会话卡片（角色图标 / 状态 label 复用 `getSessionStatusLabel` /
  `latestUserMessagePreview` line-clamp-2 / turn 总数 / 未读点复用 read-receipts）。锚点信息
  **放到边上**补偿粗粒度缺陷：边起点 badge「T7」+ tooltip 显示锚点用户消息预览；同锚多分支按
  `startedAt` 排序叠序号。边样式：实线 = 继承上下文 fork；虚线 = started_from_scratch
  （仅时间锚）；跨卡片子任务边加 `GitFork` 中点徽标。
- **turn 模式**：节点 = 单 turn（turn 序号胶囊 + user 消息首行 line-clamp-1 + agent 响应统计行
  复用 `getToolSummary` 派生摘要）。有 fan-out 的 turn 右缘常驻 port 圆点；无分支 turn 悬停
  出现「+」port。
- **grouped_turn 模式（默认）**：节点 = 组（标题 + turn 范围 badge「T3–T9 · 7 turns」+ 摘要
  line-clamp-2 + 运行中指示）。点击 chevron 在组卡片**内部**平铺组内 turn 行（不触发主干外
  重布局）。**UI 侧防御不变量**：携带 fan-out 锚点的 turn 必须是组边界；若后端数据违反，
  UI defensive split 强制在锚点处拆组渲染——「fan-out 位置与顺序可标明」永不被分组吞掉。
  组节点 context menu：「在此拆分组 / 并入上一组 / 重命名组」→ 后端 mutation，乐观更新 +
  失败回滚。
- **模式切换保持焦点**：三粒度实体有确定映射（turn → group → session），切换时把当前选中/
  视口锚定节点映射到目标粒度并滚动定位。
- **折叠**：分支子树可折叠为 stub（「▸ by-the-way · 3 节点 · 未读」）；默认运行中或含未读的
  分支展开、其余折叠；折叠状态按 task 持久化 localStorage。
- **PTY 终端会话降级**：turn / grouped_turn 模式下渲染为「session 节点 + turn 计数条」
  （带刻度不可展开），tooltip 说明；granularity control 不整体禁用——树是混合体，逐会话降级
  （投影层给出 `transcript_reconstructed` 数据时可升级为完整 turn 展示）。

### 5.4 Unified fan-out 交互

- **节点级入口**：悬停 turn/组节点右缘「+」port → Radix Popover 三选单
  `ConversationTreeFanOutPortMenu`：
  1. **By-the-way 讨论**（`MessageCircleQuestion`）：popover 内联表单（问题 textarea +
     context seed 选择），提交走既有 `createByTheWayTaskConversationSession`
     （`use-task-sessions.ts`）扩展了锚点参数的版本，成功自动选中新会话；
  2. **独立 Task 分支**（`GitFork`）：打开现有 `TaskEditorDialog`，预填
     `taskAgentSessionInitialization`（fork_existing_session + §1.3 锚点字段 +
     `sourceParentConversationSessionTaskId` = 被点节点所属会话）；创建的卡片在
     树上生成跨卡片边；
  3. **Subagent（Task Force 预留）**（`Bot`）：disabled + tooltip「Task Force 落地后可用」——
     菜单从第一天就是三槽位。
- **锚点语义**：菜单携带被点节点的锚 turn。落地初期后端仅支持最新 turn 携带上下文 fork 时，
  非最新 turn 节点的 by-the-way 选项按能力矩阵降级（started_from_scratch 仅记录锚点）并在
  菜单内注明；§1.4 的任意历史锚点能力落地后自动升级。
- **创建 UI 收编**：现 `create_session` tab 收编为树面板 header「New branch」按钮（= 从最新
  turn / from scratch 分支的通用入口），表单组件与 port 菜单内联表单同一个
  （`ConversationTreeCreateByTheWayBranchForm`），消灭双份创建 UI。`App.tsx` 的
  `newTaskAgentSessionInitialization` 流保持「独立 task」创建唯一真源，树只预填并打开
  `TaskEditorDialog`。
- **键盘与可达性**：容器 `role="tree"`、节点 `role="treeitem"` + `aria-expanded`；↑↓ 移动、
  ←→ 折叠/展开、Enter 选中联动聊天、`Shift+N` 焦点节点开 fan-out 菜单（`react-hotkeys-hook`
  已在依赖，作用域限面板焦点）。

### 5.5 实时更新与性能

- **session 层零新协议**：`useConversationTreeModel` 以 `sessions` record 为输入 `useMemo`
  派生邻接结构（按树根过滤 → 按父指针建边 → 按 `startedAt` 排序）；`task_sessions_updated`
  增量合并天然驱动。
- **turn 层**：服务端投影 query 为编号权威（§2.1）；客户端
  `deriveTurnBoundariesFromChatMessages`（user 消息切段）仅做「turn → 消息锚点」滚动定位
  映射。粗粒度 memo 键 =（消息数组长度, 末条消息 id, 末条 content 长度）——reducer 每次
  upsert 都换数组引用，不能依赖引用相等。
- **grouping 层**：消费 §3.3 的 `conversation_turn_grouping_updated` WS 消息；「分组缺失」
  降级 = frontier/无分组 turn 裸渲染（grouped 模式退化为 turn 模式外观），使树 UI 可先于
  归组作业交付。
- **流式期间**：running 会话最新 turn 节点摘要更新 1s 节流；树装配按 memo 键短路。
- **渲染**：grouped_turn 默认模式本身是第一道性能阀（渲染量 O(组数)）；turn 模式主干走
  react-virtuoso；懒展开（折叠分支/未展开组只装配 stub 计数；跨卡片子任务分支只装配一层
  卡片节点，不递归拉取目标卡内部结构）。全屏画布与侧栏共用同一 canvas 组件与模型，仅密度
  props 不同。

### 5.6 组件文件结构草案（过度指定命名、小文件单一职责）

```
web-ui/src/components/conversation-tree/
  conversation-tree-panel.tsx                         # Tier1 侧栏（header: 粒度切换/展开/New branch）
  conversation-tree-expanded-overlay.tsx              # Tier2 全屏画布（宽度置换 + zoom 档 + dock 预览列）
  conversation-tree-canvas.tsx                        # 共享滚动画布：virtuoso 主干 + 行级 gutter
  conversation-tree-branch-rail-gutter-cell.tsx       # 单行 lane/连线单元（竖线段 + 分叉折线 SVG）
  conversation-tree-session-node.tsx                  # session 粒度节点卡片
  conversation-tree-turn-node.tsx                     # turn 粒度节点卡片
  conversation-tree-grouped-turn-node.tsx             # 组节点卡片（含 inline 展开）
  conversation-tree-fan-out-port-menu.tsx             # 「+」port 分支类型三选 Popover
  conversation-tree-create-by-the-way-branch-form.tsx # 收编后的唯一 by-the-way 创建表单
  conversation-tree-node-context-menu.tsx             # 右键菜单（fork/组管理/复制锚点/折叠）
  conversation-tree-granularity-mode-control.tsx      # segmented control（DiffViewMode 先例）
  conversation-tree-types.ts                          # ConversationTreeGranularity、节点判别联合
  conversation-tree-model.ts (+ .test.ts)             # 纯函数：buildConversationTreeModel /
                                                      #   deriveTurnBoundariesFromChatMessages /
                                                      #   assignConversationTreeBranchLanes
web-ui/src/hooks/
  use-conversation-tree-model.ts (+ .test.tsx)        # 装配 hook（memo 键控、grouping 注入、降级）
```

接线改动：`card-detail-view.tsx`（挂载点替换、`isConversationTreeExpanded` 互斥、handle 调用）、
`cline-agent-chat-panel.tsx`（`ClineAgentChatPanelHandle` 增 `scrollToMessageAnchor`）、
`use-runtime-state-stream.ts`（grouping 消息 case）、`storage/local-storage-store`（两个新 key）。

---

## §6 对 Task Force 的接口依赖清单

**关键切分**：「从 turn N 创建子任务卡片」不需要 Task Force（§1.3 = 现有卡片机制 + 4 个加性
字段）；需要 Task Force 的是**父会话对子任务的 await / 结果回灌 / subagent 语义**。

### 需要 Task Force 提供

| # | 依赖 | 具体要求 | 对应 Option C 锚点 |
|---|------|---------|------|
| 1 | 耐久卡片血缘 `parentTaskId` | 子任务引用节点的双向导航与树装配 join 键 | Option C 步骤 1 / 10 |
| 2 | `dispatchChildTask` mutation + park/await/resume | 「fan-out 子任务且父会话等待」的分支形态；无它则子任务分支恒为 fire-and-forget + dependencies 边 | Option C 步骤 5-8 |
| 3 | 结果信封回灌（id/outcome/column/path） | 树上子任务节点终态渲染与父会话内联结果 turn | Option C childTerminalAndPayload |
| 4 | subagent 会话在 sessions record 的表示 | Task Force spawn subagent 时必须 stamp `conversationTreeSessionBranchDescriptor`（kind=`task_force_subagent_session_branch`、父=派发会话、锚=派发 turn）——枚举值本蓝图已预留，stamp 义务归 Task Force | 新增契约 |
| 5 | 廉价 fork 执行原语 | §4 维护作业后端升级（现 SDK `enableSpawnAgent:false / enableAgentTeams:false`，开启方式/预算/并发闸归 Task Force） | 新增契约 |
| 6 | 跨 workspace 语义 | 树 v1 同 workspace-only，与 Option C 风险 6 的强制报错对齐 | Option C 风险 6 |

### 不依赖 Task Force 即可先行（Stage 0 范围）

§1 全部会话侧泛化（多分支、任意锚点、嵌套、访问模式）、checkpoint 全量保留、§2 投影层、
§3 GroupedTurn 资产 + 手动编辑、§4 Stage 0 后端维护作业、§1.3 fire-and-forget 子任务卡片
（锚点 baseRef + dependencies 边 + 扩展字段——字段先落，`parentTaskId` 语义待 Option C）、
§5 树 UI 全部（subagent 槽位保持 disabled）。

---

## §7 分步实施大纲（有序；除末步外全部属 Stage 0，可先于 Task Force）

> **Stage 0 标注 ≠ 开工时点授权**：「可先于 Task Force」只是技术依赖关系陈述——这些步骤不
> 依赖 §6 的 Task Force 接口，落地顺序上无须等它。实际开工时点仍按文档头部状态声明执行：
> 整个蓝图（含全部 Stage 0 步骤）**推迟到 Task Force 落地之后启动**。

1. `api-contract.ts`：分支种类枚举 + 分支描述符 schema（嵌入 metadata 可选字段）+
   `taskAgentSessionInitialization` 两个锚点字段与 `sourceParentConversationSessionTaskId`
   父会话节点定位字段 + GroupedTurn 两 schema + 投影请求/响应
   schema + `conversation_turn_grouping_updated` WS 消息 schema。全部加性可选，facet
   superRefine 零触碰。
2. 新 `src/core/conversation-tree-lineage.ts`：legacy→descriptor 单向映射、树装配纯函数、
   分支 start 校验不变量（§1.2 三条）、turn 边界分类判定。
3. `turn-checkpoints.ts` + 两处删除点（`hooks-api.ts` / `cline-task-session-service.ts`）：
   保留策略翻转、`listTaskTurnCheckpointRefs`、`deleteAllTaskTurnCheckpointRefs`（挂任务
   删除 / trash 清空路径）、每任务 ref 上限。
4. 新 `src/conversation-tree/conversation-turn-projection.ts`：Cline 消息流 turn 派生 +
   终端 transcript 全量提取器（抽取 `available-agent-session-index.ts` 解析骨架为共享模块）+
   签名缓存 / 增量偏移。
5. `workspace-state.ts`：`conversation-tree-grouped-turns.json` 读写 + mutate 漏斗 +
   schemaVersion 迁移位。
6. 新 `src/trpc/conversation-tree-api.ts` + `app-router.ts` 注册：两个投影 query、
   `startConversationTreeBranchSession`（泛化并最终取代 by-the-way start 专用校验分支）、
   GroupedTurn 手动编辑 mutations、`requestGroupedTurnMaintenanceRegroup`；
   runtime-state-hub 接 `conversation_turn_grouping_updated` 广播。
7. `runtime-api.ts`：锚定 fork 路径（Cline 消息切片 / 终端 prep 摘要）、删「已有 by-the-way
   则禁 fork 当前 turn」闸、访问模式驱动 plan/act；web-ui 同步删 `length === 0` 闸。
8. §4 维护作业：ephemeral headless completion 原语 + runner 接口 + 触发布线 + apply 漏斗。
9. web-ui 模型层：`conversation-tree-types.ts` + `conversation-tree-model.ts` 纯函数
   （turn 边界定位映射、lane 分配）+ 测试。
10. web-ui session 模式树原位替换现列表（树 rail + 实/虚线边 + 锚点 badge + 未读/状态）+
    port 菜单接通 by-the-way 通路 + 收编 create_session tab。**最小可交付**。
11. web-ui turn 模式 + `scrollToMessageAnchor` 联动 + virtuoso 虚拟化；grouped_turn 模式 +
    手动调组 + 缺分组降级（消费 6/8 的产物）。
12. web-ui 全屏 overlay、任意历史 turn 携带上下文 fork 的 UI 升级、独立 task 分支预填 +
    跨卡片边与导航、html-to-image 导出。
13. **（Task Force 落地后）**：子任务分支接 `dispatchChildTask` await 语义 + 结果信封节点、
    subagent stamp 契约验收 + 槽位启用、维护作业后端切换、§5.2 决策门复核。

## §8 残留风险清单

1. **三源 turn 编号对齐**是最大软肋：kanban checkpoint 序数（含 self-injection followup 是否
   计数）vs Cline 消息派生序 vs transcript 重建序，任一偏移即锚点 off-by-one。缓解：锚点三元
   冗余（turnNumber 管消息裁剪、checkpointCommit 管工作区、userMessagePreview 供人核对）+
   `turnCheckpointAlignmentConfidence` 显式降级 + turn 边界分类函数与 checkpoint 捕获时机
   同源单测；web-ui 一律以服务端投影为编号权威。
2. **checkpoint ref 全量保留的对象增长**：大仓长任务下 .git 松散对象累积。缓解：每任务 ref
   上限 + 任务删除批量清 ref + 文档化 `git gc` 建议；滚动删除的老 turn 在投影层标记锚点
   不可用而非静默失败。
3. **终端 transcript 解析是按 CLI 版本漂移的 best-effort**：live-tail 半行、格式变更、cursor
   路径推断失败都会出现；置信度标注与 `unavailable_live_terminal_pty` 降级是 load-bearing，
   **裁剪类操作（消息切片 fork）仅限 `exact_structured` 源**。
4. **GroupedTurn 双写窗口**：作业运行期间新 turn / 手动编辑并发到达，靠 apply 漏斗签名对账 +
   区间冲突拒绝兜底；代价是作业输出偶发整体丢弃、frontier 暂留裸 turn（可接受的展示降级）。
5. **多分支资源压力**：每个侧讨论分支是独立计费的会话；分支数软上限 +（Task Force 前）无
   预算护栏需在 UI 明示花销来源。
6. **legacy 双表示漂移**：descriptor 与 legacy role/contextSource 并存期可能矛盾；缓解 =
   「descriptor wins」读侧规则 + 写侧只经 start 校验漏斗同时生成两者 + metadata 对象级
   superRefine 一致性校验（嵌套对象校验，与 summary facet 护栏互不干扰）。
7. **同 worktree 只读不变量是软执行**（plan 模式 + system prompt 注入，现状同款）：失控分支
   仍可能写共享 worktree；结构性隔离要等子任务 worktree / Task Force 沙箱，v1 文档化为已知边界。
8. **web-ui 状态互斥与未读粒度**：`isConversationTreeExpanded` 与 `isDiffExpanded` 需显式
   互斥；read receipts 现为 session 粒度，turn 级未读需新 LocalStorageKey 与迁移策略。
9. **`taskChatMessagesByTaskId` 无上限内存**（既有事实）：树的 turn 派生依赖它；若未来消息
   分页，turn 定位映射需以服务端投影计数兜底缺失窗口。

## 与既有资产的关系

- **by-the-way 机制**：本蓝图是它的严格泛化——现有 schema 字段全部保留，descriptor 只增不改；
  实施步骤 7 移除的两道闸的根因（漂移锚点）被锚定 fork 消解。
- **Option C**：子任务分支的 await/回灌形态直接复用 Option C 的 park/dispatch/resolvePark
  设计；本蓝图的 `parentTaskId` 需求与 Option C 步骤 1 是同一个字段。两份蓝图应由 Task Force
  设计统一验收。
- **ideation-chat.md**：multi-agent races 的「sub-cards under a parent」、task decomposition
  的「cards fan out」、tasks-as-context——本蓝图的子任务分支 + 锚点 baseRef 机制是这些构想的
  数据层实现路径。
