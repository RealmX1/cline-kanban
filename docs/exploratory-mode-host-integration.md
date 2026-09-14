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

核心包 fork 出的分身要逐字复用主会话的启动参数，因此 `launchArgvTemplate` 的三项一律**在启动那一刻快照**，
绝不在作业触发时重算：唯一可靠的真相是「启动那一刻真正传出去的 argv」。`--append-system-prompt` 的文案是
仓库代码的一部分，会随版本改（B.1 就改过一次），旧会话用新代码重算出来的值与它实际在跑的那份根本不是一
回事，而且这种错误**完全静默**——分身照常出结果，只是跑在了错误的前提上。

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

### prompt cache：原立论已被实测证伪（2026-09-09）

本节最初的立论是「三项逐字一致 ⇒ fork 命中主会话 prompt cache」。核心包 Pass A 在做 D5 前置验证时把它实测
证伪了两处，结论记在这里，免得后人照着假因果做决策：

- `--resume` 时 **`--append-system-prompt` 根本不参与请求**：差一字节、乃至完全不传，都照样 100% 命中。
- Claude Code 的 `--fork-session` 在真实 Kanban 会话上**恒不命中**父会话 cache，成因是上游 open bug
  [anthropics/claude-code#77306](https://github.com/anthropics/claude-code/issues/77306) —— fork 会铸造新
  session id，而 session id 被嵌在 system prompt 的 scratchpad 路径里，前缀在 system 层就已经字节不一致。
  Anthropic 已复现并确认是 2026-06 scratchpad 特性引入的 regression，至今未修、无 workaround。**命不命中
  的区分不是会话长度**，而是这段 scratchpad 由 statsig flag 门控、并非每个会话都注入：实测里受控的轻量
  TUI 会话（sonnet 102k）首次 fork 命中 84%、再 fork 命中 100%，而真实 Kanban 会话（opus 220k）恒为 0。

排除过程中一并排除掉的变量（都**不是**成因）：env 污染、`--settings`、`--append-system-prompt`、`--model`、
`--json-schema`。

**对宿主侧的两个后果**：

1. **快照规则不变**，但承重理由换了：model 必须逐字一致，分身才跑在同一个模型上；settings 路径决定分身的
   hook 行为；而 #77306 一旦修好，字节一致性的前提立刻恢复——届时不必回头补建快照。用户已就此拍板维持
   「fork 主会话 + 同 model」，契约零改动。
2. **成本量级要按未缓存价重估**：实测 220k 的 opus 会话 fork 一次 cache read = 0、约 **$2.2**；2026-09-12
   在 2.1.269 上以 446k 的 opus 会话复测，仍是 cache read = 0、cache creation 445,912，单次 **$4.46**——
   成本与上下文规模成正比，bug 未修。B.2 的触发胶水因此必须把节流旋钮当**默认开启**的东西设计，而不是
   可选项——`minimumTurnsBetweenMaintenanceRuns` 与「便宜模型」开关的默认值要按这个量级定。

**跨 harness 横向测量（2026-09-12）**：同一个「从既有会话 fork 出分身」的问题在 Codex / Kimi / Cursor /
DeepSeek 上各测了一遍，结论是**这不是 prompt cache 的机制上限，而是各家 fork 实现的缺陷**——Kimi 的 fork
首轮命中 99.3%，裸 DeepSeek API 的同前缀异后缀请求命中 98.8%，而 Claude Code 与 Codex 都是 0%。完整数据、
逐家细节、三家遥测陷阱与复现方法见 `docs/agent-session-fork-prompt-cache-measurements.md`。**其中最贵的一条
教训：在轻量会话上验证这件事会得出「已修复」的假结论**（轻量会话没有 scratchpad 段、本来就满命中），
任何关于 fork 缓存的验证都必须在生产量级、用真实交互式会话做。

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

## 4b. 触发胶水、成本闸与图的读路径（B.2）

宿主侧的全部胶水在 `src/exploration-thread-graph/`。核心包只回答「被调用时该判哪些 turn」，
**「什么时候调」完全是宿主的职责**——而这恰恰是花钱的那一半。

### 四道闸（`exploration-thread-graph-maintenance-trigger.ts`）

每判一次就 fork 一个分身。重型会话上一次约 $4.5（446k opus 实测，见 §3b；成本与上下文规模成正比），
所以闸门不是性能调参，是成本闸：

| 闸 | 判据 | 漏掉的后果 |
| --- | --- | --- |
| ① 模式 | `taskConversationMode === "exploratory"` | 所有任务都开始烧钱 |
| ② 防抖 | Stop 边沿后 45s 合并窗口 | 连着几个短 turn 各 fork 一次 |
| ③ 单飞 | 每 exploration 在途恒 1 | 并发 fork 两个分身——**store 的跨进程写锁挡不住它**，锁只覆盖落盘那一小段，不覆盖前面那次昂贵的 fork |
| ④ 节流 | 攒够 `DEFAULT_MINIMUM_TURNS_BETWEEN_MAINTENANCE_RUNS`（5）个未归位 turn | 每 turn 一次 ≈ $4.5/turn |

账本一律按 **workspace + exploration 联合计账**，绝不只用 explorationId：taskId 是 board-local 短 id，
跨 project 撞号是常态，撞号的代价不是多跑一次而是**少跑一次**（先到的把另一个 project 同号任务的触发
静默吞掉）——`persisted-agent-transcript-conversation-progress-observer` 为此吃过亏。

顺序上「廉价判定先行」是关键：读 collection 与 transcript 增量都不花钱，只有 fork 花钱，所以四道闸
全部在 fork 之前。

**首次维护不受节流约束**：图从空到有的那一次是用户唯一能看到「这东西确实在工作」的时刻，为省一次 fork
把它推迟到第 5 个 turn，换来的是一张长时间空着的面板。

### 两个 turn 源实例，不是一个

`treatFinalTurnAsCompleted` 是构造参数，而两条触发路径对它的要求相反：

- **Stop 边沿必须传 `true`**——刚结束的正是末 turn。传 false 等于每次都少判一个 turn，且漏斗会拒绝
  任何指向它的 turnRef。这是核心包交接文档点名的「最容易静默踩空的一处」。
- **手动触发必须保持默认 `false`**——用户点按钮时 agent 可能正在生成，末 turn 尚未闭合。

两个实例各自维护增量读偏移，代价是这两条路径都被用到时 transcript 读两遍。正确性优先于那点 IO。

### Stop 边沿从哪里接出来

`hooks-api.ts` 的 `event === "to_review"` 分支，**刻意放在 `by_the_way` 守卫之外**：by-the-way 会话的
turn 一样要归位，只是 `explorationId` 要解析回主任务卡片（`taskConversationSessionMetadata.workspaceTaskId
?? taskId`）。那道守卫是给「转审通知 + checkpoint」用的，与图无关。

出口是可选 dep `notifyExplorationThreadGraphAgentTurnStopped`，**绝不返回 Promise**：判图会 fork 一个
分身，压进 hook 响应关键路径会触发客户端硬超时（与 turn-checkpoint 挪出关键路径同一个教训）。

### 会话清单怎么组装（`exploration-thread-graph-session-refs.ts`）

判据不是 `agentId === "claude"` 这样的硬编码，而是**两个 sidecar 都在、且指向同一个 harness**：
N0a 身份给原生 session id 与 transcript 路径，启动快照给 fork 要逐字回传的 argv。两者都只在已接入的
harness 上盖章，所以「有没有它们」本身就是能力谓词。

**还必须校验两者的 `sourceAgentId` 彼此一致、且等于会话当前的 `agentId`**：同一张卡片换过 agent 时，
旧活体留下的 sidecar 可能还在 summary 里，照着它 fork 就是拿 A 会话的身份去跑 B 会话的参数。

主会话恒在 `sessions[0]`（fork 的就是它）；主会话不可用时整体放弃——没有它这次作业无从谈起。
by-the-way 会话缺 sidecar 只剔它自己。

### 落盘位置与那个锁文件

`storeRoot` = `<workspace 目录>/agent-conversation-exploration-thread-graph/`（独占一个目录，因为核心包
在下面自己铺 `topic-registry.json`、`explorations/<id>/exploration-thread-graph.json` 与一个**跨进程写锁**）。

**宿主的备份 / 体检 / 清理逻辑必须放过那个锁，且绝不删除活动锁**（核心包有 15s 陈旧回收，误删会让并发写
丢失）。要判断某个路径是不是锁，一律用核心包导出的 `resolveExplorationThreadGraphStoreWriteLockPath`，
别自己拼字符串。

### 读路径与契约镜像

「读图」恒等于「读 collection + 读每条会话的 turn 快照 + 合成」——只有 collection 摊不出任何一行
（`exploration-thread-graph-projection-loader.ts`）。单条会话的 transcript 读不出来不炸整张图，
那条会话的 turn 行缺席即可。

web-ui **不 import 核心包**：`/core` 静态导出依赖 node `fs` 的 store，打进浏览器 bundle 会炸。所以
`api-contract.ts` 自带一份 projection view 的 zod 镜像，lane 布局在服务端算好随行下发。两份形状的一致性
由 `exploration-thread-graph-contract-parity.ts` 做**编译期双向对账**——核心包换 SHA 后形状若漂移，
根 typecheck 立刻红，且错误就落在那个文件上。

### agent 侧读通道：`kanban exploratory get-exploration-thread-graph`

图是为 agent 建的，所以 agent 自己得读得到——纯委托 `getExplorationThreadGraph`，零 fork、零成本。
`explorationId` 默认取本会话 taskId（主会话场景两者本就相同），by-the-way 会话须用 `--exploration-id`
显式指向主卡片。这里刻意**不套** scope 解析那套「两来源不一致即硬报错」：两者不同正是 by-the-way
会话的正常形态，冲突校验会把唯一正确的用法判成错误（判定落在纯函数
`resolveExplorationIdForThreadGraphRead`）。

**只有读命令，没有写命令**，这是有意的非对称：手写结构正是 session map 时代退役掉的那条路。
会花钱的 `requestExplorationThreadGraphMaintenance` 也**不进 CLI**——只留给 UI 的显式点击，
否则 agent 可以在自己的回合里反复烧掉 fork 预算。探索礼仪指令
（`exploratory-mode-instructions.ts`）里同步写明了这条纪律与「查自己第几轮」这个实际用途。

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

## 9. 与核心包的契约指针（B.2 已接线；改动前对照 handoff A.13）

**当前钉住的 SHA**：`4fd33ae34c9e2cc6d1b24ee4a8a12b9aa6aa2bb8`（根 `package.json` 的
`github:RealmX1/agent-conversation-exploration-thread-graph#<sha>`）。升级 = 换这个 SHA，然后跑根
typecheck——`exploration-thread-graph-contract-parity.ts` 会在形状漂移时当场报错。
`.plan/` 下的 handoff 与完工交接**不进 npm 包**（`files` 只含 `dist` / `README.md` / `CONTEXT.md`），
要读得直接看那个仓库。

三条容易静默踩空的核心包语义（交接文档点名）：

- `placedTurnCount` 是落盘后 placement 的**总数**，不是本次新增数；要增量得自己前后相减。
- 一次作业最多判 `batchSize`（默认 40）个 turn，其余经 `remainingTurnCount` 回报，由调用方安排续跑。
- `incremental` 模式即使没有新 turn 也可能因修订窗口重判——**不是空跑就一定零成本**。

契约两侧的分工（与 handoff A.13 逐条对应）：

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
