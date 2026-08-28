# Exploratory Mode —— Session Map 与 Findings Store 设计蓝图

> 状态：**设计蓝图（blueprint）；实施时点另定**。本文档只锁定数据模型、持久化、写入通道、
> web-ui 挂载与降级决策，不含实现代码。§H 的 M0–M6 是**技术依赖排序，不是开工时点授权**——
> 与姊妹蓝图「Stage 0 标注 ≠ 开工时点授权」同一约定。
> 姊妹蓝图：conversation-tree unified fan-out（`.plan/docs/conversation-tree-unified-fan-out-interface-deferred-asset.md`）。
> 本文档**引用**其 harness-neutral turn 投影层（其 §2）、GroupedTurn 资产（其 §3）、会话分支
> 描述符（其 §1.2）、apply 漏斗范式（其 §4.3）、Stage 0 维护作业后端（其 §4.1）、零新依赖
> 可视化决策（其 §5.2）与风险 1 的锚点三元冗余缓解，**不重复定义**；session map 语义层、
> findings store、重整提案通道是本文档新增资产。
> 相关蓝图：Option C 血缘/dispatch（`.plan/docs/option-c-kanban-owned-dispatch-await-deferred-asset.md`）。
> 宿主面（用户已定）：cline-kanban web-ui 的会话面板。范围结论：做在**本仓库内**、作为
> conversation-tree 蓝图的姊妹/上层资产——standalone 需重建会话传输、消息流、广播、会话血缘
> 全部基座，且该功能的价值恰恰在于与任务会话深度耦合。
> 代码事实核对基准：local main `8a0ac8e6`（2026-08-21 单向吸收后复核；吸收区间 23 个提交
> 与本文档机制面零语义冲突，仅 `App.tsx` 两处行号随 +23 行漂移并已修正）。
> 实施注记（2026-08-22，**M0 已落地**）：M0（§H）已按本文档与姊妹蓝图 Stage 0 步骤 1/4 的
> Cline 子集实现（契约 / 投影层 / map store / 两个只读 tRPC query / 指令文件模块 / web-ui
> 锚 chip + `data-turn-anchor` + 面板骨架）。两处实施层决定记录于此：**(1)** M0 投影 query 对
> 非 Cline 会话（PTY **与 ACP**）一律返回 `unavailable_live_terminal_pty`——枚举字面语义对
> ACP 不精确（其消息在内存、非 PTY），UI 降级文案按 transport 区分不点名 PTY；ACP 投影源
> 形态待本文档补章后落地。**(2)** web-ui 的 `deriveTurnBoundariesFromChatMessages` 直接相对
> 路径复用服务端 `classifyConversationTurnBoundaryMessage`（不镜像重写），保证客户端位置
> 映射与服务端编号同源。
> 实施注记（2026-08-26，**M1 已落地**）：M1（§H：模式标记 + map 写入通道 + apply 漏斗 +
> 防抖再维护 observer，含姊妹蓝图步骤 3 checkpoint 全量保留）已实现。实施层决定记录于此：
> **(1)** observer 的 stale 判据从「裸签名漂移」精化为「投影最新 turn > map 最新锚点 turn」
> （存在未入图用户轮次）——裸投影签名是消息级的，agent 自身的维护动作（ingest 工具调用、
> 收尾消息）同样推进它，会导致「刚维护完立即又 stale」的恒亮假信号与 nudge 自激循环；签名
> 仍专任 apply 时刻的乐观并发对账键（§B.2 闸 3），不参与漂移判定。reason 枚举沿用
> `turn_projection_signature_drift`。**(2)** M1 的再维护执行者是**活会话 agent 自己**（observer
> 经统一发送出口 `sendTaskChatMessageAcrossSessionTransports` 投递一条提醒消息；闸：仅
> turnOwner==="user" 的静默窗 45s、每会话并发恒 1、冷却 10min）；专属 headless 再维护作业
> （`agent_maintenance_job` 来源）待姊妹蓝图 §4.1 Stage 0 后端落地后接。**(3)** mapNodeId
> 派生定为 `turn-<anchorTurnNumber>-<nodeKind>`（集合已按会话隔离，id 不带会话前缀——
> §B.1 注释的 (sessionId + ...) 三元中会话分量是冗余的）；该约定同时是聊天 marker 的 id
> 格式，agent 可确定性预知。**(4)** ingest 载荷语义为**整份替换提案**（读-改-写协议的目标态，
> 非增量 diff）；dedup 账本落在 collection 的加性可选字段 `recentAppliedClientProposalIds`
> （FIFO 50 条），重试同 id 幂等 ack。**(5)** `referencedFindingId` 在 M1 只做形状校验
> （finding_reference 时必填、其余 kind 必空）；findings store 可解析性校验属 M2，指令文件
> 已明示 agent 当前不要使用 finding_reference。**(6)** B.1 canonical schema 物理位置上移到
> `runtimeStateStreamMessageSchema` 之前（`exploratory_session_map_updated` 是 union 成员，
> 模块求值序 TDZ 所限）；语义归属不变，api-contract 尾部契约区留有指针注释。**(7)** 投影
> 加载链（双廉价信号判定 + 消息加载 + refs 枚举 + 派生）抽为
> `src/conversation-tree/load-conversation-session-turn-projection.ts`，投影 query 与 ingest
> 漏斗共用同一实现（三源对齐纪律）。**(8)** checkpoint 全量保留（姊妹蓝图 §1.4 步骤 3）：
> 两处轮换删除点已翻转；`deleteAllTaskTurnCheckpointRefs` 挂 CLI `task delete` 与 saveState
> 整板保存差集两条「任务资产永久抹除」路径；每任务 ref 上限 200 做成 `captureTaskTurnCheckpoint`
> 可注入参数（生产默认 200，测试注小值）。**(9)** CLI 身份：task/workspace 解析为「显式 flag
> > env（`KANBAN_HOOK_TASK_ID` / `KANBAN_HOOK_WORKSPACE_ID`）> 报错」，flag 与 env 不一致
> 硬报错（风险 6 的单任务作用域纪律）；workspace scope 经 `x-kanban-workspace-id` 请求头
> 传递（workspaceProcedure 与 hooks.ingest 的 input 带 scope 不同）。

## 需求（用户原语转写）

1. **任务分两种模式**：operational（把活干完即散场）与 exploratory（探索/研究——会话过程
   本身产出的结构、结论就是资产）。模式是任务的声明性标记，不是运行时推断。
2. **聊天内导航锚 + 独立 session map**：agent 在探索会话中给「重要的点」埋锚；session map
   是该会话的结构化语义视图（里程碑 / 决策点 / 悬而未决的问题 / 岔路），**由 agent 维护**
   （用户已定的关键决策），用户可修正、可重整。
3. **findings 集中抽象**：把探索中产生的结论/发现从会话流里提炼成集中管理的 finding 条目；
   能**从 finding 起新会话**继续深挖。
4. **agent 驱动的重整评估**：map / findings 膨胀后由 agent 提议重整（重命名 / 合并 / 删除 /
   重排），人或策略批准，**绝不自治重写**。
5. **远期 KB**：findings 是未来跨任务知识库的数据后备；本文档只做接口预留，不设计 KB 本体。

## 决定设计的代码事实（已核实）

1. **聊天消息 ID 不稳定，锚点永远不得使用消息 id**：`createMessage`
   （`src/cline-sdk/cline-session-state.ts:211-224`）在创建/hydrate 时以
   `${taskId}-${now()}-${random}` 现铸 id（`:218`）——重启后同一条消息的 id 不同。一切锚点
   只能用服务端权威 turn 号 + checkpoint commit（三元冗余见姊妹蓝图风险 1）。
2. **turn checkpoint git ref 现状**：`refs/kanban/checkpoints/{base64url(taskId)}/turn/{n}`
   （`src/workspace/turn-checkpoints.ts:33-35`），**任务存续期全量保留**（姊妹蓝图 §1.4 已落地）：
   捕获侧（Cline `src/cline-sdk/cline-task-session-service.ts`、终端 `src/trpc/hooks-api.ts`）只捕获
   不轮换删除；每任务上限 `MAX_TASK_TURN_CHECKPOINT_REFS=200` 超限从最老滚动修剪；任务删除 /
   trash 清空时 `deleteAllTaskTurnCheckpointRefs` 按前缀批删（CLI `task delete` 与浏览器整板保存
   差集两条路径）。本文档锚点的长期可解析性即建立在该保留策略之上（见 §H M1 依赖）。
3. **会话血缘半成品已在**：`runtimeTaskConversationSessionMetadataSchema`
   （`src/core/api-contract.ts:517-526`）已有父指针 `parentTaskConversationSessionId` 与锚点
   `mainSessionOriginTurnNumber`；姊妹蓝图 §1.2 把它泛化为树分支描述符（加性嵌套对象，
   descriptor wins）。
4. **summary 是安全的加性载体**：`runtimeTaskConnectionRetrySchema`
   （`api-contract.ts:532-538`）与 `taskConversationSessionMetadata`（`:765`）证明纯 metadata
   sidecar 字段不触碰 facet superRefine 护栏（facet 定义 `:465-496`）；新字段经两个
   `updateSummary` 漏斗写入后自动搭乘 `task_sessions_updated` 广播，无需新订阅。
5. **per-workspace JSON store 骨架**（findings / map / 提案三个新 store 的直接模板）
   `src/state/agent-raised-pending-user-decision-store.ts`：串行写队列（`:233-243`）、原子写
   （`:227-231`，`lockedFileSystem.writeJsonFileAtomic`）、`schemaVersion`（`:35`）、稳定
   dedup 键（`decisionId`，`:96` 注释）、cap-and-trim（`:245-250`，每 workspace 上限 200）、
   路径遍历守卫（`:191-202`）。
6. **agent → Kanban 写回通道已存在**：`kanban hooks ingest` CLI
   （`src/commands/hooks.ts:553-569`，`trpcClient.hooks.ingest.mutate`）→ `hooksApi.ingest`
   （`src/trpc/hooks-api.ts`）；durable-write-before-ack 先例：同步 durable 写成功后才准许
   返回（`hooks-api.ts:178-186` 的注释与顺序），载荷白名单化。这是「agent 写 map 更新」的
   现成范式。
7. **防抖维护作业触发的挂载点已存在**：`src/server/runtime-state-hub.ts:241-246`
   `queueTaskSessionSummaryBroadcast` 内挂 observer join point（先例
   `agentSessionResponseGenerationStopObserver.observeTaskSessionSummary`，`:119` 创建、
   `:246` 调用）——三 transport 共用的 summary 边沿观察器模式。
8. **Kanban-owned 指令文件机制已有先例**：`~/.cline/kanban/agent-continuation-instructions/`
   （`src/terminal/output-reactions/network-interruption-continuation-instructions.ts:7,16`）——
   Kanban 把一份自己托管的 markdown 稳定落盘、再把 agent 指向它。exploratory 模式的 marker
   格式约定与写回协议用同一机制下发。
9. **会话 spawn/fork 机制已在**：`runtimeTaskAgentSessionInitializationSchema`
   （`api-contract.ts:129-155`，`sourceSessionReuseMode: resume_existing_session |
   fork_existing_session`；cursor 禁 fork 由 superRefine 强制，`:143-154`）；by-the-way 侧会话
   创建入口 `createByTheWayTaskConversationSession`
   （`web-ui/src/hooks/use-task-sessions.ts:304`）。
10. **三种 session transport 单点声明**：`runtimeAgentSessionTransportSchema`
    （`api-contract.ts:265-272`：pty_terminal / in_process_cline_sdk / acp_stdio_subprocess）；
    catalog 字段 `src/core/agent-catalog.ts:23`；「是否渲染为会话面板」谓词
    `isRuntimeAgentSessionRenderedAsConversationPanel`（`agent-catalog.ts:174`）。新增能力一律
    按 transport 声明降级面，不再硬编码 agentId。
11. **web-ui 锚点 / spotlight 机制已在**：
    `web-ui/src/components/post-deploy-verification/verification-anchor-registry.ts`——
    `data-verification-anchor` attr（`:6`）+ `spotlightAnchor` 滚入视野并临时高亮（`:55`）。
    「map 节点 → 聊天消息」的反向跳转直接复用这套机制。
12. **聊天渲染与窗口化现状**：`cline-chat-message-item.tsx` 目前**没有任何 per-message DOM
    锚点**；`use-windowed-agent-chat-message-list.ts` 只渲染末 50 条窗口（`:11-12`），旧消息靠
    滚顶 backfill（`:35,53,64`），**没有 jump-to-index / reveal-to-index**——跳转能力需新增
    （§C.3）。
13. **web-ui 视图先例**（本设计全部复用、不新增路由）：会话面板 vs 终端面板分流
    `card-detail-view.tsx:877`（`showClineAgentChatPanel`）；宽度置换全屏先例 `isDiffExpanded`
    （`card-detail-view.tsx:724`）；home 视图置换先例 `isGitHistoryOpen`（`web-ui/src/App.tsx:111`）；
    overlay controller 先例 `PostDeployVerificationController`（`App.tsx:22,1679`）；深链
    `?task=` 参数 `use-detail-task-navigation.ts:39`（`parseDetailTaskIdFromSearch`）。
14. **PTY agent 无结构化消息**：运行期只有 PTY scrollback；turn 结构只能事后从 CLI transcript
    JSONL 重建，解析骨架已在 `src/agent-session-history/available-agent-session-index.ts`
    （mtime+size 签名缓存 `:216`，现只提 3 条预览 turn，`:240-324`）。姊妹蓝图 §2 把它泛化为
    全量 turn 提取器，置信度 `transcript_reconstructed`。
15. **SDK 多 agent 原语存在但被显式关闭**：`enableSpawnAgent:false / enableAgentTeams:false`
    （`src/cline-sdk/cline-session-runtime.ts:221-222`）——维护/重整作业的「廉价 fork」目标
    后端归 Task Force 决定；Stage 0 用姊妹蓝图 §4.1 的 ephemeral headless completion 过渡后端。
16. **无任何图/树可视化库**：手写 SVG overlay 先例
    `web-ui/src/components/dependencies/dependency-overlay.tsx`；姊妹蓝图 §5.2 已定零新依赖
    DOM 文档流 + 行级 gutter SVG 路线，map 面板沿用。
17. **全量替换广播先例**：`notification_log_updated`（`runtime-state-hub.ts:440`）——小体量
    集合的整体推送范式，远期 KB 跨 workspace 聚合（见末节）与 findings 广播都按此计。

## 核心设计张力与解法定调

**张力**：用户已选定「map 由 agent 维护」（需求 2），这与仓库既有哲学正面相撞——姊妹蓝图
里一切 agent 产出都按「派生投影 + apply 漏斗校验 + 签名对账不一致即整体丢弃」治理
（GroupedTurn 是维护作业的**输出**而非 agent 持有的资产，其 §4.3 任一校验失败整体丢弃、
UI 降级裸 turn、永不阻塞会话主流程）。若 map 也做成纯派生投影，「agent 维护」就名存实亡；
若放任 agent 直写 map，则开出本仓第一个「agent 可写 Kanban-owned store」的漂移面（现状
没有任何 agent 能写 Kanban 的持久化资产，见 §I 风险 6）。

**解法定为如下五条，是结构不是附加说明**——§A–§F 的每一份 schema、每一条流程都按它成型：

1. **锚点基座确定性、语义层 agent 所有**：turn 序列与编号只认服务端投影层（姊妹蓝图 §2）；
   map 节点只能挂在这些客观锚点上（turn 号 + checkpoint commit），agent 只写标题 / 摘要 /
   类型 / finding 引用，**不能发明锚点**。
2. **写入一律过 apply 漏斗**（镜像姊妹蓝图 §4.3）：zod 白名单校验 → 锚点可解析性校验
   （每个节点引用必须解析到实际 turn / 保留中的 checkpoint ref）→
   `sourceTurnProjectionSignature` 乐观并发对账 → 与 `user_manual_edit` 节点冲突拒绝。
   任一失败**整体丢弃**，UI 降级裸锚点列表，永不阻塞会话主流程。
3. **provenance 强制三元**：map 节点与 findings 条目都必须携带
   `conversationSessionTaskId + turnNumber + checkpointCommit` 三元冗余（外加用户消息预览供
   人核对，姊妹蓝图风险 1 的同款缓解）。
4. **漂移检测**：map artifact 携带其所依据的投影签名；签名漂移 → 标 stale + 触发再维护作业，
   UI 明示「map 落后于会话」，**绝不静默展示过期结构**。
5. **重整 = agent 提 diff、人/策略批准**：复用 agent-raised-pending-user-decision 的「等人
   拍板」通道模式（模式复用，不共用文件，见 §F.2）；自动档只放行无信息损失的机械操作
   （重命名 / 重排 / 置顶），合并 / 删除类必须人工批准。

## 总纲

- **新增三份 per-workspace JSON store**（与 board.json / sessions.json 同级，全部走代码事实 5
  的骨架）：`exploratory-session-maps.json`（§B）、`exploratory-findings.json`（§D）、
  `exploratory-map-reorganization-proposals.json`（§F）。不进 sessions.json——终端会话仅
  shutdown 落盘，而这三份资产必须独立于会话生命周期存活（姊妹蓝图 §3.1 的同款理由）。
- **锚点基座 = 姊妹蓝图 §2 投影层 + §1.4 全量 checkpoint 保留**。本文档不另建 turn 编号体系，
  不另存拓扑边：会话拓扑真相永在分支描述符（姊妹蓝图 §1.2），map 只存「锚点上的语义节点」。
- **一个加性模式标记**（§A）：board 卡片字段 + summary sidecar 投影，facet superRefine 零触碰。
- **agent 的两个写入入口**（§B.2 / §D.2）都收敛到同一条「CLI → tRPC ingest → apply 漏斗 →
  串行写队列 → WS 广播」管线，白名单载荷，durable-write-before-ack。

---

## §A Exploratory vs Operational 模式标记

### A.1 声明性标记（加性 sidecar，快照语义）

```ts
export const runtimeTaskConversationModeSchema = z.enum(["operational", "exploratory"]);

// 挂载点 1：runtimeBoardCardSchema 加性可选字段
//   taskConversationMode: runtimeTaskConversationModeSchema.optional()
//   来源：用户建卡/编辑卡片时声明（UI toggle）；缺省 = operational，legacy 卡片零迁移。
//   漂移：无——卡片字段是权威；「建卡时固化」快照先例见 ompAgentSessionTransport
//   （api-contract.ts:290-297），改模式只影响下一次启动。
//
// 挂载点 2：RuntimeTaskSessionSummary 加性可选 sidecar 投影
//   taskConversationMode: runtimeTaskConversationModeSchema.optional()
//   来源：会话启动路径从卡片快照写入（两个 updateSummary 漏斗，免费搭乘 task_sessions_updated
//   广播，代码事实 4）。漂移：活会话不热切换——会话存续期卡片改模式不回写投影，
//   UI 对「卡片新模式 ≠ 会话投影」只显示不强刷（v1 明确决策：避免模式热切换引发
//   map 生命周期歧义；热切换留作后续项）。
```

### A.2 模式的三处效应

1. **对 UI**：exploratory 任务的 Focus View 默认展开 session map 面板（§G）；findings 入口
   浮现。operational 任务一切如常（map 面板可手动开启——map store 按会话存在与否渲染，
   不硬绑模式；模式只改默认值）。
2. **对 agent**：exploratory 会话启动时注入 Kanban 托管指令文件
   `~/.cline/kanban/agent-exploratory-mode-instructions/`（代码事实 8 的同款稳定落盘机制，
   新模块 `src/state/exploratory-mode-instructions.ts` 镜像
   `network-interruption-continuation-instructions.ts`），内容 = marker 格式约定（§C.1）、
   写回 CLI 协议（§B.2）、维护节律（何时值得埋锚/更新 map/建议 finding）。
3. **对回收策略**：map / findings / 提案账本在 per-workspace store，**独立于会话回收存活**
   （2h 宽限回收只杀会话进程，不动这三份资产）。v1 不改变探索会话本身的回收时限（防资源
   泄漏）；锚点的长期可解析性靠 checkpoint 全量保留（代码事实 2）而不是靠会话续命。

---

## §B Session Map artifact

### B.1 存储与 schema

新文件 **`exploratory-session-maps.json`**（per-workspace），新模块
`src/state/exploratory-session-map-store.ts`（串行写队列 / 原子写 / schemaVersion /
cap-and-trim / 路径遍历守卫，全量镜像代码事实 5）。字段注释以「来源｜漂移」标注（解法定调
1/3/4 的逐字段落实）：

```ts
export const exploratorySessionMapNodeKindSchema = z.enum([
  "milestone",          // 阶段性结论/到达点
  "decision_point",     // 做了取舍的位置
  "open_question",      // 悬而未决的问题
  "digression",         // 有意识的岔路/支线
  "finding_reference",  // 该锚点产出了一条 finding（referencedFindingId 必填）
]);

export const exploratorySessionMapNodeGenerationSourceSchema = z.enum([
  "agent_live_session_maintenance",  // 探索会话 agent 运行中实时维护
  "agent_maintenance_job",           // 防抖再维护作业产出
  "user_manual_edit",                // 用户手动修正（优先级恒最高，作业永不覆盖）
]);

export const exploratorySessionMapNodeSchema = z.object({
  mapNodeId: z.string(),  // 稳定 id：apply 漏斗按 (sessionId + anchorTurnNumber + nodeKind)
                          // 规范化派生；agent 可提议但漏斗是最终赋名者（防 id 漂移）。
                          // 来源：funnel｜漂移：同锚点同 kind 的重复提交幂等归并。
  // ── provenance 强制三元 + 人核对冗余（解法定调 3）────────────────
  anchorConversationSessionTaskId: z.string(),
  //   来源：funnel 按写入目标填充，agent 载荷不可改｜漂移：会话删除 → 整集合随 workspace 清理。
  anchorTurnNumber: z.number().int().positive(),
  //   来源：agent 提案｜漂移：> 服务端投影最新 turn 即整份拒绝（锚点可解析性校验）。
  anchorTurnCheckpointCommit: z.string().nullable(),
  //   来源：agent 提案｜漂移：不在该任务保留的 checkpoint ref 集合内（listTaskTurnCheckpointRefs，
  //   姊妹蓝图 §1.4）→ 降级为 null 并在集合级标 mapStaleReason；null = 仅时间锚。
  anchorTurnUserMessagePreview: z.string().max(200).nullable(),
  //   来源：funnel 从投影层回填（不信 agent 自报）｜漂移：仅展示用，不参与校验。
  // ── agent 所有的语义层（解法定调 1：只有这部分归 agent 写）───────
  nodeKind: exploratorySessionMapNodeKindSchema,
  nodeTitle: z.string().max(80),
  nodeSummaryMarkdown: z.string().max(400).nullable(),
  referencedFindingId: z.string().nullable(),
  //   来源：agent 提案，funnel 校验其在 findings store 可解析｜漂移：finding 被 archive 不级联删
  //   节点（map 是历史叙事）；仅 nodeKind=finding_reference 时非空。**只持引用，禁复制正文**
  //   （内容真相唯一，在 findings store——见 §B.4 双真相规则）。
  // ── 治理 ──────────────────────────────────────────────────────
  nodeGenerationSource: exploratorySessionMapNodeGenerationSourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const workspaceExploratorySessionMapStateSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  mapCollectionsByConversationSessionTaskId: z.record(z.string(), z.object({
    // apply 乐观并发对账签名（姊妹蓝图 §3.1 sourceTurnProjectionSignature 同款语义）
    sourceTurnProjectionSignature: z.string(),
    mapNodes: z.array(exploratorySessionMapNodeSchema),  // 上限 200/会话，超限要求重整（§F）
    // 非 null = stale：UI 明示「map 落后于会话」，不静默展示过期结构（解法定调 4）
    mapStaleReason: z.enum([
      "turn_projection_signature_drift",
      "anchor_turn_checkpoint_commit_unresolvable",
    ]).nullable(),
    lastMaintenanceJobCompletedAt: z.number().nullable(),
    updatedAt: z.number(),
  })),
});
```

**map 不存边**：节点显示序由 `anchorTurnNumber` 派生；分支/岔路的拓扑真相在分支描述符
（姊妹蓝图 §1.2）。`digression` 节点只是「这里岔出去过」的语义标注，其指向的侧会话由树装配
层 join 出来，不在 map 里重复登记（单一真相，同姊妹蓝图 §1.1 的子任务引用节点原则）。

### B.2 写入通道与 apply 漏斗

两类生产者，**同一条管线、同一个漏斗**：

1. **探索会话 agent 实时维护**：指令文件（§A.2）告知 agent 读-改-写协议——先经
   `kanban exploratory get-session-map --task <id>` 拿到当前节点集合 +
   `sourceTurnProjectionSignature`，再提交 `kanban exploratory ingest-map-update --task <id>
   --payload <json>`。CLI 复用 `kanban hooks ingest` 的传输骨架（代码事实 6：timeout、重试、
   trpcClient）。载荷白名单：`{ clientProposalId, sourceTurnProjectionSignature, nodes: [...] }`
   ——`clientProposalId` 作 dedup 键（重试不落地两条），载荷里**没有**自由字段。
2. **防抖再维护作业**：签名漂移 / 新 turn 累积 / 用户点「立即再维护」触发（§B.3）；Stage 0
   后端 = 姊妹蓝图 §4.1 的 ephemeral headless completion（Task Force 落地后换廉价 fork，
   同其 §6 依赖 5），输入 = 投影层 turn 有界摘录 + 现有 map + stale 原因，输出 = 整份修订
   提案，过同一漏斗。

tRPC 侧新路由 `src/trpc/exploratory-api.ts` 的 `ingestSessionMapUpdate` mutation 内，
**apply 漏斗（唯一写点）依序校验，任一失败整体丢弃**（镜像姊妹蓝图 §4.3）：

1. zod 白名单解析（含尺寸上限：节点数 ≤200、字段长度上限）；
2. 锚点可解析性：`anchorTurnNumber` ≤ 服务端投影最新 turn；`anchorTurnCheckpointCommit`
   非 null 时必须在保留 ref 集合内（不可解析 → 降级 null + 标 stale，不拒绝）；
3. `sourceTurnProjectionSignature` 与 apply 时刻一致（不一致 = 作业期间来了新 turn，丢弃并
   按新边沿重触发）；
4. 与 `user_manual_edit` 节点冲突拒绝（用户修正优先级恒最高；冲突集合 = 同 mapNodeId）；
5. durable 写（串行队列 + 原子写）成功后才回 ack（durable-write-before-ack，代码事实 6）。

失败容忍：解析失败/超时 → 指数退避重试 ≤3 → 放弃后 UI 保持裸锚点列表（纯展示降级，永不
阻塞会话主流程）。广播：集合变更经 runtime-state-hub 新增 WS 消息
**`exploratory_session_map_updated`**（携带该会话完整节点集合，量级 = 节点数，恒小）——
不搭车 summary 广播（map 变更不必然 bump summary，同姊妹蓝图 §3.3 的同款理由）。

### B.3 漂移检测与再维护触发

- 集合级 `sourceTurnProjectionSignature` 与投影层签名在**每次投影重算/广播边沿**比对；漂移
  即标 `mapStaleReason`，UI 出「map 落后于会话」badge +「立即再维护」按钮，旧节点仍展示但
  明确标注（解法定调 4：标 stale，不静默、不擅自重写）。
- 触发挂载点 = 代码事实 7 的 summary 广播 join point observer（新
  `exploratory-session-map-maintenance-observer.ts`，镜像
  `agent-session-response-generation-stop-observer.ts`），30–60s 静默窗防抖，每会话并发恒 1
  （姊妹蓝图 §4.2 同款节律）。

### B.4 与 GroupedTurn 资产的关系（谁引用谁）

- **互不持有真相**：map 节点**不引用**组 id（组会随重整分裂/合并，引用即腐化）；组**不引用**
  map 节点。UI 叠加时按 turn 区间对齐：组 = `[firstTurn..lastTurn]`，节点 = 单锚 turn，渲染
  时节节点落入所属组内（姊妹蓝图 §5.3 grouped_turn 粒度的组内平铺区是天然挂点）。
- **职责切分防双真相**：GroupedTurn 标题/摘要 = **显示压缩标签**（减少 clutter）；map 节点
  标题/摘要 = **语义叙事**（为什么这个点重要）。同屏冲突时人读标签以 map 节点为准，组标题
  退为范围标签（「T3–T9 · 7 turns」）。
- **finding 正文唯一真相在 findings store**：map 节点只持 `referencedFindingId`（§B.1 schema
  注释已强制）；GroupedTurn 摘要永不提炼为 finding。

---

## §C 聊天内导航锚

### C.1 marker 格式约定（指令文件机制下发）

agent 在助手消息正文里埋**行内 HTML 注释形式**的锚标记：

```
<!-- kanban:map-anchor <mapNodeId> -->
```

- 选 HTML 注释的理由：未被识别时在 markdown 渲染里天然不可见——**安全降级**（转录被复制、
  被旧版本 UI 渲染都不会出现垃圾文本）。
- **反注入铁律**：marker 载荷只有一个 id，**不携带任何自由文本**；chip 的显示内容恒来自
  服务端 map store（按 id 查节点标题），永不渲染 marker 内嵌内容。id 在当前会话 map 集合
  不可解析 → 不渲染 chip（按纯文本/不可见处理），绝不让 agent 输出直接变成 UI 元素。
- 格式约定经 §A.2 的指令文件下发（代码事实 8 先例）；同一指令文件同时给出写回协议
  （§B.2），使「埋锚」与「map 里有这个节点」恒成对出现——marker 是 map 节点的**指针**，
  不是独立数据源。

### C.2 渲染：锚 chip

- `cline-chat-message-item.tsx`（代码事实 12）接入纯函数
  `extractSessionMapAnchorMarkers(content): { cleanContent, markers[] }`（新 util，可单测）：
  摘除 marker 注释后渲染正文，在原位渲染 `SessionMapAnchorChip`（lucide `MapPin`，
  节点标题 + kind 图标）。
- ACP 会话同样渲染为 conversation 面板（代码事实 10 谓词覆盖），其消息项组件接入同一
  util——marker 解析规则跨 transport 唯一。
- 点击 chip → 滚动定位到 map 面板对应节点并短暂高亮（spotlight 机制，代码事实 11）。

### C.3 反向跳转：map 节点 → 聊天消息

- **per-message DOM 锚（新增）**：聊天消息项挂 `data-turn-anchor="T{n}"`。turn 号来自客户端
  `deriveTurnBoundariesFromChatMessages` 的**位置性**切段映射（姊妹蓝图 §5.5——编号权威在
  服务端投影，客户端只做「turn → 消息」滚动定位映射，每次进任务重算；代码事实 1 决定了
  这里绝不能用消息 id 做锚）。
- **reveal-to-index（新增能力）**：现窗口化列表只有末 50 条 + 滚顶 backfill、无 jump-to-index
  （代码事实 12）。新增命令式 `revealMessageAtIndex(index)`：把窗口 oldest 边界一次推到目标
  index 以下，再滚动定位 + spotlight（复用代码事实 11 的机制；map 面板节点挂
  `data-session-map-node-anchor="<mapNodeId>"`，chip/节点双向可 spotlight）。
- 落点：`ClineAgentChatPanelHandle` 增 `scrollToTurnAnchor(turnNumber)`（姊妹蓝图 §5.1 选中
  协议里 `scrollToMessageAnchor` 的同款挂法，内部先经位置映射再 reveal）。

### C.4 PTY 终端会话降级

PTY 会话无结构化消息（代码事实 14）：**无聊天内 chip、无 map→消息跳转**；map 面板对 PTY
会话仍渲染（锚点来自 transcript 重建投影，置信度标注），点击节点只切会话 + tooltip 说明。
完整降级面见「能力/降级矩阵」节。

---

## §D Findings store

### D.1 存储与 schema

新文件 **`exploratory-findings.json`**（per-workspace——v1 不跨 workspace，与 Option C 风险 6
的强制报错对齐），新模块 `src/state/exploratory-findings-store.ts`（骨架同代码事实 5，每
workspace 上限 500 条，cap-and-trim 丢最旧 archived）。

```ts
export const exploratoryFindingProvenanceLinkSchema = z.object({
  // 解法定调 3：每条 finding 至少一个 provenance 链接；turn_anchor 必须三元齐全
  // （checkpointCommit 允许 null = 仅时间锚，语义同 §B.1）。
  linkKind: z.enum(["turn_anchor", "session_level", "user_authored_freeform"]),
  conversationSessionTaskId: z.string(),       // 来源：写入方声明、funnel/mutation 校验存在性
  turnNumber: z.number().int().positive().nullable(),  // 来源：写入方｜漂移：同 §B.1 锚点规则
  turnCheckpointCommit: z.string().nullable(),          // 来源：写入方｜漂移：不可解析降级 null
});

export const workspaceExploratoryFindingEntrySchema = z.object({
  findingId: z.string(),  // 稳定 dedup 键：用户保存=UI 生成 uuid；agent 建议=agent 提供的
                          // clientProposalId 规范化——同一建议重发不落成两条。
  findingTitle: z.string().max(120),
  findingBodyMarkdown: z.string().max(4000),
  findingStatus: z.enum([
    "suggested_pending_confirmation",  // agent 建议、待人确认（v1 抽取的唯一自动档）
    "active",
    "superseded",                      // 被更新的 finding 取代（supersededByFindingId 互链，审计保留）
    "archived",                        // 软删：不进默认列表，可恢复——删除类操作永不物理抹除
  ]),
  supersededByFindingId: z.string().nullable(),
  findingGenerationSource: z.enum(["user_saved", "agent_suggested"]),
  //   来源：写入通道决定（UI 按钮 vs ingest 通道）｜后续可加 agent_auto_extracted 档位（扩展位，
  //   见「远期 KB 预留」），v1 刻意不做无人工在环的自动抽取。
  provenanceLinks: z.array(exploratoryFindingProvenanceLinkSchema).min(1),
  //   user_authored_freeform 链接用于「纯人工笔记」这种无锚 finding——provenance 强制但允许
  //   显式声明「无锚」而不是伪造锚。
  originConversationSessionTaskId: z.string().nullable(),
  // ── KB 预留扩展位（v1 恒缺省，见末节）──
  findingTags: z.array(z.string().max(40)).max(8).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
```

### D.2 抽取路径（先人工，后自动建议）

1. **人工保存（v1 主路径）**：聊天消息/选区上的「存为 finding」按钮 → 表单（标题/正文预填
   选中文本）→ tRPC mutation 直写（用户动作，zod 校验即够，无需作业漏斗）；provenance 自动
   带上当前 turn 锚三元。
2. **agent 建议（v1 次路径）**：agent 经 `kanban exploratory ingest-finding-candidate` 提交
   （与 §B.2 同管线），落库即 `suggested_pending_confirmation`；UI 在 findings 视图与 map
   面板出「待确认」角标，用户确认 → `active`，拒绝 → 物理删除该建议（尚未成为资产）。
3. **自动建议（后续项，非 v1）**：再维护作业顺手产出候选——通道与状态机已兼容（枚举与
   `suggested_pending_confirmation` 不变），只需作业输出契约扩字段，届时单独立项。

### D.3 查重 / 索引（v1 从简）

规范化标题（小写去空白标点）相等 + 前缀包含即疑似重复，保存/确认时 UI 提示「已存在相似
finding」并给合并入口（合并 = §F 的人工批准操作）；全文检索 = 标题 + 正文 substring，不引
入索引库。广播：`exploratory_findings_updated` 全量替换推送（代码事实 17 先例，集合恒小）。

---

## §E 从 finding 起新会话

finding 卡片上「起新会话」给两档（心智模型沿用姊妹蓝图 §5.4 的 fan-out 三选单）：

1. **By-the-way 追问（默认，轻量）**：同任务侧会话，走
   `createByTheWayTaskConversationSession`（代码事实 9）的锚定扩展版；finding 正文 +
   provenance 链接列表作为 context seed：
   - **Cline**：seed 灌入 `initialMessages`（一条系统旁白消息，含 finding 正文与锚三元）——
     镜像姊妹蓝图 §1.4 的「fork 流中插入切片」挂点；
   - **终端 agent**：prep 文件降级（finding 正文落临时文件、prompt 指引 agent 先读它）——
     镜像姊妹蓝图 §1.2 的 `seeded_with_transcript_digest_prep_file_up_to_anchor_turn`；
   - **ACP（omp）**：纯内存无 resume（`api-contract.ts:294` 注释），seed = finding 正文作
     首轮 prompt 前缀，`started_from_scratch` 语义。
2. **独立子任务卡片（重量）**：打开现有 `TaskEditorDialog`，预填
   `taskAgentSessionInitialization`（fork 语义，代码事实 9；cursor 禁 fork 由既有
   superRefine 自然拦截）+ 加性可选字段 `sourceExploratoryFindingId`（**唯一新增契约**，
   挂在 `runtimeTaskAgentSessionInitializationSchema` 上，语义 = 本任务由哪条 finding 派生，
   供血缘展示与远期 KB 回溯）。

新会话的血缘 stamp：优先写姊妹蓝图 §1.2 的分支描述符（`side_discussion_session_branch` 或
`independent_child_task_branch`）；姊妹蓝图未落地时以 legacy `role/contextSource` 字段表达
（语义降格、不阻塞，见 §H M4 依赖）。finding 侧回写一条 provenance 链接到新会话
（`session_level` kind），形成双向导航。

---

## §F 重整 / 规范化评估

### F.1 触发时机与评估指标（从简）

- 触发：§B.3 的同一 observer join point（代码事实 7）+ 防抖；另加节点数/条目数逼近上限、
  stale 持续超窗两个条件。评估输出 = 重整提案，不是动作。
- 指标刻意从简：陈旧（节点锚 turn 距最新投影超 N 轮且未被引用）、孤儿锚（checkpoint commit
  已不可解析的节点）、重复候选（§D.3 的标题相似规则）。不做嵌入相似度、不做自动评分。

### F.2 提案信封 schema 与批准队列

新文件 **`exploratory-map-reorganization-proposals.json`**（per-workspace；**模式复用**「agent
发起、等人拍板」账本，但**不共用** agent-raised-pending-user-decisions.json——该 store 头部
注释刻意把 decisionKind 收敛为两种，类型层面拒绝扩容，见代码事实 5 文件头）：

```ts
export const exploratoryReorganizationOperationSchema = z.discriminatedUnion("operationKind", [
  // ── 自动档白名单（无信息损失的机械操作，可 auto_approved）──────────
  z.object({ operationKind: z.literal("rename_map_node_title"), mapNodeId: z.string(),
             newNodeTitle: z.string().max(80) }),
  z.object({ operationKind: z.literal("reorder_findings"),
             orderedFindingIds: z.array(z.string()) }),
  z.object({ operationKind: z.literal("pin_finding"), findingId: z.string(), pinned: z.boolean() }),
  // ── 人工批准档（有损/影响可核对性，永不自动应用）────────────────────
  z.object({ operationKind: z.literal("merge_findings"),
             sourceFindingIds: z.array(z.string()).min(2),
             mergedTitle: z.string().max(120), mergedBodyMarkdown: z.string().max(4000) }),
  z.object({ operationKind: z.literal("archive_finding"), findingId: z.string() }),
  z.object({ operationKind: z.literal("delete_map_node"), mapNodeId: z.string() }),
  z.object({ operationKind: z.literal("reanchor_map_node"), mapNodeId: z.string(),
             newAnchorTurnNumber: z.number().int().positive(),
             newAnchorTurnCheckpointCommit: z.string().nullable() }),
]);

export const exploratorySessionMapReorganizationProposalSchema = z.object({
  proposalId: z.string(),  // 稳定 dedup 键（agent 提供 clientProposalId 规范化）
  conversationSessionTaskId: z.string(),
  proposalGenerationSource: z.enum(["agent_live_session_maintenance", "agent_maintenance_job"]),
  // 提案所依据的 map 版本签名：deriveExploratorySessionMapSignature(collection) =
  // `${nodeCount}:{maxUpdatedAt}:${sourceTurnProjectionSignature}`（纯函数可单测）；
  // apply 时不一致即 discarded_stale（解法定调 2/4 的对账环节）。
  sourceMapSignature: z.string(),
  rationaleMarkdown: z.string().max(1000),  // 给人看的理由；不渲染成可执行内容
  operations: z.array(exploratoryReorganizationOperationSchema).min(1).max(50),
  autoApprovable: z.boolean(),  // 派生值：全部 op ∈ 白名单；存储时由 funnel 重算，不信自报
  status: z.enum(["pending", "auto_approved", "approved", "rejected", "applied",
                  "discarded_stale"]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
```

- **流程**：作业/agent 提案 → ingest 通道落 `pending`（durable-write-before-ack）→
  `autoApprovable` 且全局策略允许 → `auto_approved` 并即应用；否则 UI 批准队列（findings
  视图 + map 面板角标）等人拍板 → `approved` → 应用（过 §B.2 同款锚点校验 + 签名对账）→
  `applied`。`merge_findings` 应用时走 `superseded` 互链（§D.1 状态机），审计轨迹保留——
  **自动档永不触碰合并/删除**（解法定调 5）。
- 广播：复用 `exploratory_session_map_updated` / `exploratory_findings_updated`（应用结果即
  这两份集合的变更），提案队列自身随 `exploratory_findings_updated` 载荷附带 pending 计数。

---

## §G Web-UI 挂载

### G.1 map 面板：Focus View 挂载与双蓝图挂载点裁决

- **v1（姊妹蓝图未落地）**：新组件 `web-ui/src/components/session-map/session-map-panel.tsx`
  挂 Focus View 侧栏（现 `TaskConversationSessionsPanel` 同位下方的独立可折叠 section）——
  不抢占其挂载点，两蓝图可任意顺序落地。
- **姊妹蓝图落地后的裁决（显式声明，防临时方案长死）**：侧栏「会话拓扑」语义位归
  `ConversationTreePanel`（Tier1，其 §5.1）；session map 面板以 **tab 共存**于同一侧栏槽位
  （segmented control，`DiffViewMode` 先例），默认 tab = 树（拓扑是更基础的视图）；远期方向
  是 map 节点作为**语义叠加层**并入树的 grouped_turn 粒度渲染（§B.4 已按 turn 区间对齐预留
  了对齐方式），本文档不锁死该合并时点。
- **全屏**：`isSessionMapExpanded` 宽度置换（`isDiffExpanded` 先例，代码事实 13），与
  `isDiffExpanded` / `isConversationTreeExpanded` **三向互斥**（后触发者胜）。
- 可视化沿用姊妹蓝图 §5.2 的零新依赖 DOM + 行级 SVG 决策（map 主干本来就是 turn 时间轴，
  连通用图引擎的理由比树更弱）。

### G.2 findings 视图

- **workspace 级 findings 浏览器** = home 视图置换：`isFindingsOpen`（`isGitHistoryOpen`
  先例，`App.tsx:111`），非 overlay——findings 是主浏览面，不是 `PostDeployVerificationController`
  式的引导覆盖层。
- **任务级切片**：map 面板底部「本会话 findings」section（含待确认角标），不进侧栏 tab
  竞争。

### G.3 深链

`?task=<id>&view=map|findings`：扩展 `parseDetailTaskIdFromSearch`
（`use-detail-task-navigation.ts:39`）的同款解析，view 参数驱动 map 面板展开/findings
置换开启；无路由架构下这是唯一入口形态（代码事实 13）。

---

## 能力 / 降级矩阵（按 session transport）

| 能力 | in_process_cline_sdk | acp_stdio_subprocess | pty_terminal |
|---|---|---|---|
| map 节点锚点可解析性 | ✅ `exact_structured` | ✅ 会话存活期内（SessionUpdate 结构化驱动）；**纯内存不落盘**——进程重启后该会话 map 集合整体标 stale 降级展示 | ⚠️ `transcript_reconstructed`，置信度标注（姊妹蓝图 §2 降级是 load-bearing） |
| 聊天内锚 chip | ✅ | ✅（同一 conversation 面板渲染链接入 §C.2 util） | ❌ 无结构化消息（代码事实 14） |
| map → 消息跳转 | ✅（§C.3 位置映射 + reveal-to-index） | ✅ 限会话存活期（重启后无消息可跳，tooltip 说明） | ❌ xterm 无消息锚，降级为仅切会话 |
| findings 抽取（人工保存的锚自动携带） | ✅ | ✅（live） | ⚠️ 锚三元经 transcript 重建 best-effort；`user_authored_freeform` 兜底恒可用 |
| 从 finding 起新会话（带种子） | ✅ initialMessages 注入 | ⚠️ 无 resume：started_from_scratch + 首轮 prompt 前缀 | ⚠️ prep 文件降级；claude/codex 可 fork，cursor 禁 fork（api-contract.ts:143-154） |

矩阵是 load-bearing 文档化：每种降级都在对应 §C–§E 的流程里出现为显式分支，不是事后补丁。

---

## §H 分步实施大纲（M0–M6，有序、标注依赖）

> **M0–M6 = 技术依赖排序，不是开工时点授权**（镜像姊妹蓝图 §7 头部告诫）：本文档整体是
> 设计蓝图，实施时点另定；标注「依赖姊妹蓝图步骤 N」只表示技术前置，不表示姊妹蓝图必须先
> 整体完工——其 Stage 0 步骤可按子集先行。

- **M0 聊天内导航锚 + 只读 map 骨架**：marker 格式约定 + 指令文件落盘模块（§A.2）+
  `extractSessionMapAnchorMarkers` util + chip 渲染 + 消息项 `data-turn-anchor` + map store
  schema/读路径 + map 面板以**裸锚点列表**渲染（agent 尚不能写，集合为空时纯展示投影层
  turn 骨架）。依赖：**姊妹蓝图 Stage 0 步骤 1（契约）与步骤 4（turn 投影层）**——turn 编号
  权威来源；其 Cline 子集（`exact_structured` 源）可先独立落地。
- **M1 模式标记 + map 写入通道 + apply 漏斗**：`taskConversationMode` 卡片字段 + summary
  sidecar 投影；`kanban exploratory get-session-map / ingest-map-update` CLI +
  `exploratory-api.ts` mutation；漏斗四道闸 + stale 标记 + 防抖再维护 observer。
  依赖：M0；**姊妹蓝图步骤 3（checkpoint 全量保留）**——锚点长期可解析的前置。
- **M2 findings store + 人工保存 + agent 建议通道**：store +「存为 finding」按钮 +
  `ingest-finding-candidate` + 待确认流 + `exploratory_findings_updated` + findings 浏览器
  （home 置换）。依赖：M1（复用 ingest 管线与漏斗基建）。
- **M3 双向跳转完整化 + stale UI**：reveal-to-index、spotlight 复用、「map 落后于会话」
  badge +「立即再维护」mutation。依赖：M1。
- **M4 从 finding 起新会话**：两档入口 + 三形态 seed + `sourceExploratoryFindingId` 契约 +
  分支 stamp。依赖：M2；**姊妹蓝图步骤 1/2（分支描述符）**——未落地时以 legacy by-the-way
  字段表达（语义降格，不阻塞）。
- **M5 重整评估**：提案 store + 评估作业（姊妹蓝图 §4.1 Stage 0 后端）+ 批准队列 UI +
  自动档白名单。依赖：M1 + M2；**Task Force 落地后**维护/评估作业后端切换为廉价 fork
  （同姊妹蓝图 §6 依赖 5，本文档不新开契约）。
- **M6 远期 KB 接口预留**：findings schema 扩展位封板 + 跨 workspace 聚合广播范式文档化
  （见末节）。依赖：M2。

---

## §I 残留风险清单

1. **agent 维护漂移**（最大固有风险，用户已在决策时标记）：agent 可能写出低质量但「合法」
   的 map（标题空泛、埋锚过密/过疏、长期不更新）。结构性护栏 = 解法定调五条（锚点不可发明、
   漏斗校验、签名对账、stale 明示、重整需批准）；残余风险 = 「合法但平庸」的内容只能由
   用户修正（`user_manual_edit` 优先级恒最高）与 §F 评估发现，v1 接受。
2. **turn 编号三源对齐**（**继承姊妹蓝图风险 1**，不再另起缓解）：kanban checkpoint 序数 vs
   Cline 消息派生序 vs transcript 重建序任一偏移即锚点 off-by-one。本文档全部锚点策略建立
   在其缓解之上（三元冗余、`turnCheckpointAlignmentConfidence` 显式降级、服务端投影为唯一
   编号权威）；若姊妹蓝图该风险失控，本设计同步失控。
3. **findings 熵增 / 重整丢信息**：无评估约束的合并会丢内容。缓解：`merge_findings` 恒人工
   批准 + `superseded` 互链保留审计 + archive 软删不物理抹除 + 自动档白名单只放行无损操作
   （重命名/重排/置顶）。残余：人工批准本身可能误杀——批准 UI 必须并排展示合并前后全文。
4. **PTY 降级面**：chip/跳转不可用、锚点置信度低（见矩阵）。缓解 = 矩阵显式文档化 + UI 逐
   会话降级不整体禁用；风险 = 用户对 PTY 会话的 map 期待错配，落地时需在指令文件与 tooltip
   里把降级讲明白。
5. **双蓝图落地顺序 / 挂载点冲突**：M0 依赖姊妹蓝图投影层子集；侧栏 Tier1 位两蓝图争用。
   裁决已写入 §G.1（v1 独立 section、落地后 tab 共存、树优先、远期叠加合并）；风险 = 若
   姊妹蓝图大幅改稿（投影 query 形状、组区间语义），本文档 §B/§C 需同步修订。
6. **agent 首开写 Kanban-owned store 的授权面**：现状没有任何 agent 能写 Kanban 持久化
   资产，本设计开首例，必须显式收窄——白名单载荷（无自由字段）、单任务作用域（载荷
   taskId 必须与 hook/env 身份一致）、漏斗全量校验、尺寸上限、dedup 键幂等、
   durable-write-before-ack、指令文件明示「这不是自由格式存储」。**本管线不得被引用为
   「agent 可写任意 Kanban store」的先例**；任何新写点单独立项评审。
7. **消息 ID 不稳定对锚点策略的硬约束**（代码事实 1）：一切锚点用 turn 号/checkpoint；
   客户端 turn→消息映射是位置性的、每次进任务重算；`scrollToTurnAnchor` 必须先经映射再
   reveal。任何「用消息 id 做锚」的捷径都是 bug（重启后锚点全灭）。
8. **map 与 GroupedTurn 的双标签面**：两处都有标题/摘要，可能同屏矛盾。缓解 = §B.4 职责
   切分（压缩标签 vs 语义叙事）+ 同屏显示规则（map 节点为人读标签、组标题退为范围标签）；
   残余 = 用户仍可能困惑，需落地时 UI 文案配合。
9. **marker 注入面**：agent 输出即 UI 指令载体。缓解 = §C.1 反注入铁律（载荷仅 id、显示
   内容恒来自服务端 store、不可解析不渲染）；残余 = 恶意/故障 agent 可埋大量有效 id 的
   marker 造成视觉噪声——chip 渲染加每消息上限（如 8 个）兜底。

---

## 远期 KB 预留（只列接口预留，不做 KB 设计）

- **findings schema 扩展位已留**：`findingTags`（§D.1，v1 恒缺省）、
  `findingGenerationSource` 的 `agent_auto_extracted` 档位、`status` 机与 superseded 链
  天然支持 KB 阶段的多版本演化。
- **findingId 升格路径**：v1 是 workspace 内 dedup 键；KB 阶段升格为全局稳定键（前缀
  workspaceId 即兼容，无需迁移正文）。
- **跨 workspace 聚合**：走 `notification_log_updated` 式全量替换广播（代码事实 17）——
  workspace 级只读聚合视图 + 全量替换推送，不引入增量同步协议。
- **明确不做**：KB 本体设计、检索/嵌入、跨 workspace 写语义、findings 的跨任务自动关联。
  用户自己的排序里 KB 也是最后。

## 与既有资产的关系

- **conversation-tree 蓝图（姊妹）**：本文档引用其 §2 投影层（锚点基座）、§3 GroupedTurn
  （显示压缩层，§B.4 划清职责）、§1.2 分支描述符（拓扑真相与 §E stamp）、§4.3 apply 漏斗
  （§B.2 镜像）、§4.1 Stage 0 作业后端（§B.2/§F 复用）、§5.2 零新依赖可视化（§G.1 沿用）、
  风险 1 三元冗余（解法定调 3）。不改动该蓝图文件；冲突点只有侧栏挂载位，裁决见 §G.1。
- **Option C 蓝图**：findings v1 workspace-only 与其风险 6 对齐；`sourceExploratoryFindingId`
  （§E）与其 `parentTaskId` 血缘字段并存不冲突（一个答「从哪条 finding 来」、一个答
  「从哪个父任务来」）。
- **agent-raised-pending-user-decision store**：三份新 store 的骨架模板（代码事实 5）+
  「等人拍板」通道模式（§F.2 模式复用、不共用文件）。
- **verification-anchor-registry**：spotlight/锚点机制直接复用（§C.2/§C.3）。
- **agent-continuation-instructions**：Kanban 托管指令文件先例（§A.2/§C.1 镜像）。
- **by-the-way 机制**：§E 默认档直接复用其创建入口与锚点字段。
- **ideation-chat.md**：findings → KB 的演进线是其 tasks-as-context 构想的数据层实现路径。
