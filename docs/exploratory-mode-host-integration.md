# Exploratory Mode（findings + exploration thread graph 宿主胶水）—— 集成要点

> 设计蓝图：`.plan/docs/exploratory-mode-session-map-and-findings-store.md`（findings §D 仍有效；其 session map
> 部分已**退役**——会话结构改由独立包 [`agent-conversation-exploration-thread-graph`](https://github.com/RealmX1/agent-conversation-exploration-thread-graph)
> 建模，本仓库只做宿主胶水；两个 pass 的分工与契约见该包的 `.plan/docs/exploration-thread-graph-core-handoff.md` A.13）。
> 本页是改动该子系统前必读的承重集成知识。当前状态 = **Pass B.1**（不依赖核心包的部分已落地）；
> B.2（依赖包 tag v0.1.0：触发胶水 / WS / trpc / 面板）落地时同步更新本页与 `AGENTS.md` 的一行指针。

## 1. turn 编号权威与同源边界分类器

turn 编号权威是 `src/conversation-tree/conversation-turn-projection.ts`（纯函数：从消息流切段、
与 checkpoint 序数对齐、产出投影签名）。web-ui 的 `deriveTurnBoundariesFromChatMessages`
**直接相对路径复用**它的 `classifyConversationTurnBoundaryMessage`——改边界分类规则必须意识到
两侧同源，且它有「checkpoint 捕获时机同源单测」义务（checkpoint 在「进入 awaiting user review」
边沿按 `latestTurnCheckpoint.turn + 1` 捕获，见 `cline-task-session-service.ts` 的
`captureReviewCheckpoint`）。self-injection 轮次（RVF 程序化投递）在 Cline 消息面无可靠标记，
投影不硬猜，偏移由 `turnCheckpointAlignmentConfidence` 显式降级吸收。

**投影加载链只有一条**：`src/conversation-tree/load-conversation-session-turn-projection.ts`
（双廉价信号判定 Cline → 加载消息 → 枚举 checkpoint refs → 派生）。投影 query
（`conversation-tree-api.ts`）与 findings 建议通道的 provenance 校验（`exploratory-api.ts`）共用它——
要改加载/判定逻辑只改这一处，绝不在任一调用方各写一份。

投影 query（`conversationTree.getConversationSessionTurnProjection`）对非 Cline 会话返回
`unavailable_live_terminal_pty`，**ACP 也落这一档**。加载链的 Cline 判定先用 in-memory summary +
看板卡片 agentId 双廉价信号，**绝不为终端任务调 `loadTaskSessionMessages`**（对非活会话会 boot
Cline SDK host，AGENTS.md 记载的 CI 卡死诱因）。

注意：本投影层是 Kanban 自己的（Cline SDK 结构化消息源）。PTY 会话（Claude Code / Codex）的
turn 序列来源是核心包的 `/harness-claude-code` transcript 投影，两者是不同的数据源；B.2 的
thread graph 面板以核心包的 projection view 为准，本投影层继续只服务 findings 出处锚与会话树。

## 2. 会话模式标记与指令注入

`taskConversationMode`（operational 缺省 / exploratory）声明在卡片上（建卡/编辑时声明，
legacy 卡片零迁移），启动请求从卡片快照带进来，三条 transport（terminal / cline-sdk / acp）
在建会话时盖章进 `summary.taskConversationMode`——**活会话不热切换**，卡片改模式只影响
下一次启动。它同时是 B.2 thread graph 维护作业的开关（`=== "exploratory"` 才触发）。

exploratory 会话启动时经 append-system-prompt（`renderExploratoryModeAppendSystemPrompt`）把 agent
指向 Kanban 托管指令文件
`~/.cline/kanban/agent-exploratory-mode-instructions/exploratory-mode-conversation-etiquette-and-findings.md`
（`src/state/exploratory-mode-instructions.ts`，镜像 network-interruption-continuation-instructions；
改正文即幂等重写旧文件）。正文只有两件事：**探索礼仪**（切换话题明说、回到先前线索点名、收口明说、
关键结论一句话收束——分身读的是同一份对话，表达越明确图越准）与 **findings 建议工作流**。
**不再要求 agent 埋 marker、不再有写结构的 CLI**：会话结构由 work-branch 作业自动维护。

**ensurePromise 是进程级永久缓存**——「内容漂移重写」只发生在进程内首次调用；测试跨用例
必须 `vi.resetModules()` 重引模块（每个用例换新临时 home 时尤其要）。

## 3. 终端 agent 原生会话身份 sidecar（N0a）

`kanban hooks` 从每个 hook 事件的 stdin 抽 `session_id` / `transcript_path`
（`src/commands/hook-events/agent-native-conversation-session-identity-extraction.ts`；Claude Code 与
Codex 的 hooks 载荷都带，Kiro / Droid 抽不到 session id 就不产出——**宁缺毋滥，绝不从路径反推 id**），
随 `hooks.ingest` 请求的 `agentNativeConversationSessionIdentity` 字段上送；服务端在一切早退
（恢复守卫拦截 / 转移闸）之前经 `TerminalSessionManager.applyAgentNativeConversationSessionIdentity`
写 summary 加性 sidecar `agentNativeConversationSessionIdentity {sourceAgentId, nativeSessionId,
transcriptPath, observedAt}`——只在三个身份字段变化时真正写（`--fork-session` / 续接换 id 时整体替换），
不碰 facet 三元组、不参与 superRefine。它是 B.2 组装核心包 `sessions[]`
（`nativeSessionId` / `transcriptPath`）的唯一身份来源。

## 3b. 启动参数快照（fork 重放用）

核心包 fork 出的分身能否命中主会话的 prompt cache，取决于它的 model 与 system prompt 前缀是否与主会话
**逐字**一致。因此 `launchArgvTemplate` 的三项一律**在启动那一刻快照**，绝不在作业触发时重算：
`--append-system-prompt` 的文案是仓库代码的一部分，会随版本改（B.1 就改过一次），旧会话用新代码重算出来的
prompt 与它实际在跑的那份不同 —— fork 前缀对不上，cache 全 miss，且**完全静默**（分身照常出结果，只是每次
按未缓存价格烧全量输入 token）。

`src/terminal/agent-session-fork-replay-launch-arguments-capture.ts` 是纯函数，从 `PreparedAgentLaunch.args`
里摘 `--model` / `--append-system-prompt` / `--settings`（同时认 `-m` 与等号式写法，取最后一次出现）；
`session-manager` 在 spawn 后那一批 summary 写入里与 `runtimeSessionIncarnationId` 同批盖章，因此天然
「每个活体一份、换 agent 或换模型后整体替换」。**未接入的 agent 必须显式写 `null` 而不是省略字段**，否则同
一任务从 claude 换成别的 agent 后，旧快照会留在 summary 里被误当成当前会话的启动参数。

两条不可动摇的细节：

- **model 存 argv 字面值**（通常是浮动别名 `default`），绝不存解析后的具体模型 id。别名的含义由 Claude Code
  运行时解析且随上游换代漂移，固化解析结果会让 fork 在换代后用错模型（另见 `AGENTS.md` 的浮动 ref 规则，与
  `agent-session-adapters.ts` 里 `--model default` 那段注释记录的 1M→200k 事故）。
- **prompt 文本逐字保留**，包括内部连续空白、制表符与换行 —— cache 前缀比对是字节级的。

v1 只覆盖 claude（exploration 的第一 harness，也是唯一已核实 fork 语义的 harness）。

## 4. 维护作业分身的 hook 短路

核心包的 work-branch 作业以 `claude -p --resume <主会话 id> --fork-session --settings <与主会话相同的
settings.json>` 起分身（cache 命中的前提之一），因此分身的每个 hook 事件都会打到 `kanban hooks`。
契约（handoff A.13-3）：作业进程 env 恒含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`。
`src/commands/hook-events/exploration-work-branch-job-hook-short-circuit.ts` 据此在**读 stdin 之后、
解析 `KANBAN_HOOK_*` 身份 env 之前**判定（作业进程未必带任务身份 env）：PreToolUse → 退出码 0 +
stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",…}}`；其余
事件静默短路、不联系运行时。四个入口（`hooks ingest` / `notify` / `codex-hook` / `gemini-hook`）
都接了。若不短路，分身事件会被当成主任务事件：Stop 抓 checkpoint、PostToolUse 翻 facet、
activity 推「对话上次推进」。

## 5. findings store 与写入通道

findings 是 **workspace 级**资产（v1 不跨 workspace）：per-workspace 文件
`exploratory-findings.json`，store 模块 `src/state/exploratory-findings-store.ts`（串行写队列 /
原子写 / 损坏容错 / 路径遍历守卫）。上限 500 条，cap-and-trim 三级裁剪序 = archived →
superseded → 非 pending 最旧 updatedAt，**pending 永不静默裁**。该取舍的容量语义：容量被 pending
占满时 cap 无可裁候选，让超限更糟的写入被显式拒绝（store 抛 `ExploratoryFindingsCapOverflowError`
→ ingest 回 `findings_cap_overflow`、人工动作经 handler 目标存活检查回 `PRECONDITION_FAILED`），
绝不「返回成功但 finding 消失」；让总量回落的写入（reject）即使结果仍超限也放行。

**唯一写点 = `src/trpc/exploratory-api.ts` 的六个 procedure**（全部落 store 的 mutate 原语，
成功变更 durable 落盘后广播 `exploratory_findings_updated` 全量替换推送——workspace 级、
不搭车 summary 广播）：

- 人工主路径（zod 校验即够，蓝图 §D.2.1）：`saveFinding`（UI 生成 findingId=uuid，落库即
  active+user_saved；同 id 幂等回现状不广播）、`confirmFinding` / `rejectFinding`（仅
  pending；**reject = 物理删除**——建议尚未成为资产）、`archiveFinding`（active↔archived；
  对 pending/superseded 抛 BAD_REQUEST，superseded 互链审计不经 archive 改写）。
- agent 建议通道：`kanban exploratory ingest-finding-candidate`（CLI 身份解析「显式 flag > env
  （`KANBAN_HOOK_TASK_ID` / `KANBAN_HOOK_WORKSPACE_ID`）> 报错」，flag 与 env 不一致硬报错；
  workspace scope 经 `x-kanban-workspace-id` 请求头；投递层 `deliverExploratoryMutation<T>`）
  → `ingestFindingCandidate` mutation，落库即 `suggested_pending_confirmation`+agent_suggested；
  findingId 服务端派生 `agent-<clientProposalId>`（同建议重发幂等 ack）。provenance 的
  turn_anchor link 校验三态：投影可用 → turnNumber 超最新 turn 整份拒绝、checkpoint 不在保留
  集合降级 null；PTY 源 → 接受且 checkpoint 降级 null；投影加载抛错 → 拒绝
  `provenance_conversation_session_unresolvable`；容量被 pending 占满 → 拒绝 `findings_cap_overflow`。
- B.2 联动：核心包作业的 `finding_candidate` 事件标注 → 服务端走 `ingestFindingCandidate` 同款落 pending。

## 6. findings UI 链路

- **单一真相 = `web-ui/src/hooks/use-exploratory-findings.ts`**（App.tsx 实例化一次）：
  初始 `getFindings` query + `exploratory_findings_updated` 推送全量替换归并；mutation
  不做乐观更新，状态经推送收敛。
- **「存为 finding」**挂在 `cline-agent-chat-panel.tsx` 消息项上（Cline 与 ACP 共用同一组件；PTY 无
  结构化消息项不加）：选区在按钮 mousedown 捕获，无选区预填消息正文。provenance 组装是纯函数
  `web-ui/src/components/findings/findings-model.ts`：消息经位置性映射可锚 → turn_anchor 三元
  （checkpoint commit 取投影 entries）；不可锚 → `user_authored_freeform`，**绝不伪造锚**。
  投影数据来自 `web-ui/src/hooks/use-conversation-session-turn-projection.ts`（refreshKey 只许含
  turnOwner / liveness facet 翻转 + latestTurnCheckpoint 落地 + 流重连代数，**绝不许拼
  `summary.updatedAt`**——Cline 流式期间 ~150ms 批次广播会形成无界重算与 `git for-each-ref` 子进程
  轮询，见 `docs/post-mortems/event-loop-stall-lock-crash.md`；短路用 `JSON.stringify` 全内容比较）。
- **findings 浏览器 = `App.tsx` 的 `isFindingsOpen` home 置换**（与 overview/git history 三向互斥；
  入口在 top-bar）。
- **任务级切片 = `web-ui/src/components/findings/session-findings-section.tsx`**（「本会话 findings」
  可折叠 section，挂在 Focus View 侧栏 TaskConversationSessionsPanel 同位下方，`card-detail-view.tsx`
  决定挂载点；B.2 的 thread graph 面板落地后迁入其底部）：过滤 provenanceLinks 含当前会话的条目
  （排除 archived），待确认带角标 + 行内确认/拒绝。

## 7. 休眠的聊天内锚三件套（`web-ui/src/components/conversation-anchor/`）

旧 session map 的 marker（`<!-- kanban:map-anchor <id> -->`）→ chip → spotlight 链路已随 map 退役：
agent 不再埋 marker，`card-detail-view` 不再向聊天面板传 resolver（⇒ chip 永不渲染）。三件套
（`conversation-anchor-markers.ts` 解析 / `conversation-anchor-chip.tsx` / `conversation-anchor-registry.ts`
spotlight，kind 枚举改为本地 `ConversationAnchorKind`）**保留不删**：① 旧转录残留 marker 时
cleanContent 摘除仍是正文净化的正确行为（findings 预填也用它）；② 将来「聊天消息 ↔ thread graph
turn 行」双向定位可复用（`data-conversation-anchor` 属性契约 + `data-turn-anchor`）。解析铁律
（整行锚定、独立块级位置、fence 内不解析、每消息上限 8）原样保留在文件头注释。

## 8. 退役清单（Pass B.1，线上零数据无迁移）

已删除（历史可经 `git log --all -- <path>` 取回）：`src/state/exploratory-session-map-store.ts`、
`src/state/exploratory-session-map-apply-funnel.ts`、`src/server/exploratory-session-map-maintenance-observer.ts`
（含 runtime-server 的 nudge 注入）、api-contract 的 map schema 与 `exploratory_session_map_updated` 广播、
`exploratory-api.ts` 的 `getSessionMap` / `ingestSessionMapUpdate`、CLI `get-session-map` /
`ingest-map-update`、web-ui `session-map-panel.tsx` / `use-session-map-panel-data.ts` / `session-map-query.ts`
及各自测试。**不要为 thread graph 重建任何一份**：结构建模、apply 漏斗、作业与 CLI 全在核心包。

## 9. 与核心包的契约指针（B.2 接线时逐条对照 handoff A.13）

- cline-kanban 提供：`explorationId = workspaceTaskId`；`sessions[]`（主会话在前；每条含 N0a 的
  `nativeSessionId` / `transcriptPath`、`workingDirectory`、`launchArgvTemplate{model, appendSystemPrompt,
  settingsPath, extraArgs}`（**读 §3b 的启动快照 `agentSessionForkReplayLaunchArguments`，绝不在触发时重算**）、by-the-way 的
  `forkedFromParentSessionTurnNumber`（= `mainSessionOriginTurnNumber`））；`storeRoot`
  = `~/.cline/kanban/workspaces/<ws>/agent-conversation-exploration-thread-graph/`；触发时机 = 终端 Stop
  边沿 + 防抖 + 每 exploration 并发 1。
- 核心包保证：作业 fork 进程 env 含 `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1`（本仓库常量
  `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV` 与之字面一致，有单测钉住）；作业只写 `storeRoot`；
  所有写入经其漏斗；`usage` 回报 cache 读量。
- 升级 = 换 `package.json` 里 `github:RealmX1/agent-conversation-exploration-thread-graph#<sha>` 的 SHA。
