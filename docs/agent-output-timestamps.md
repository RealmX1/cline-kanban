# Agent 产出时间戳与卡片时长药丸（三字段模型与写路径，外加 Cache warm 起点）

> 本文是卡片左上角时长药丸与 `lastSubstantiveOutputAt` 写路径的详情文档，承接根 `AGENTS.md`
> 铁律区的「双药丸不可合并」与「lastSubstantiveOutputAt opt-in」两条。字段语义的权威注释另见
> `src/core/api-contract.ts` 的 `runtimeLastConversationProgressObservationSchema` 一带（约 :675 起）。

## 第一部分：双药丸三字段模型

### 历史教训（为什么绝不可合并回一颗药丸）

卡片左上角历史上只有一颗药丸，读 `lastSubstantiveOutputAt` 冒充「agent 上次回复」。于是
「今天重开一个七天前的会话」会把它刷成 `now`——旧对话被重播进新 TUI，而实质分类器的行签名
记忆是空的，整段旧内容被判成新产出。

实测取证：**168 个可对账的 claude 任务里 26% 显示错误**（偏差中位数 26.8 小时、p95 12.4 天；
虚假推进案例 **100%** 都是「转录被重开过」）。这个 bug 被点修过三次仍复发。根因不是分类器
不够准，而是**一个字段冒充了三个量**：

| 量 | 字段 | 会话重开时应否刷新 | 真相源 |
| --- | --- | --- | --- |
| 此刻在不在吐东西 | `lastSubstantiveOutputAt` | **应**（刮 TUI 的新鲜度，秒级） | TUI 实质分类器 / SDK / ACP 事件 |
| 本轮何时停止生成（药丸 Stopped） | `agentResponseGenerationStopped` | **应**（新活体新一轮） | `mergeSummaryWithFacets` 在 turnOwner 交回 user 的**边沿**上落，与 2h 回收共用锚点 |
| 对话上次推进（药丸 Progress） | `lastConversationProgressObservation` | **不应**（跨 incarnation 的历史事实） | 持久转录 > hook 事件 / 结构化会话事件 > TUI 分类器兜底 |
| 主对话最后一次向模型发请求（跨项目面板 Cache warm 倒计时起点，不是卡片药丸） | `lastMainAgentConversationModelRequestDispatchObservation` | **不应**（恢复会话不发请求） | 「harness 紧接着就发请求」的 hook 的 ingest 时刻：未被拦截的 UserPromptSubmit、主对话的 PostToolUse(Failure)；Gemini 为 BeforeAgent / AfterTool |

第四行是 2026-10-03 加的：prompt cache 的 TTL 由每次请求刷新，起点必须是请求发出时刻。曾用
`agentResponseGenerationStopped` 当起点，结果会话恢复（换 incarnation 也算停止边沿）把它刷成恢复时刻，
倒计时显示「18 分钟前」而真实最后请求在 11~21 小时前。写入判据与单调 reducer 见
`src/core/main-agent-conversation-model-request-dispatch-hook-event-classification.ts` 与
`src/core/last-main-agent-conversation-model-request-dispatch-observation.ts`；子代理事件（hook stdin 带
`agent_id`）与用户回合里后台子代理的工具事件都不记。估算与资格见
docs/context-cross-project-recently-active-task-switcher.md 的「缓存倒计时区」。

### `agentResponseGenerationStopped`：边沿触发，不是电平

它是**边沿触发**字段（判定函数 `didEnterUserTurnEndingAgentResponseGeneration`，
`src/core/session-activity.ts:418`；落值逻辑在同文件 `mergeSummaryWithFacets` 内，约 :372-385），
不是「当前处于 user 回合」这个电平。若写成电平，历史盘上每条 `awaiting_review` summary 都会被
下一次任意 metadata-only 写补出一个 `stoppedAt = 此刻`。

### `lastConversationProgressObservation`：唯一 reducer 与单调规则

合并只经 `src/core/last-conversation-progress-observation.ts` 的唯一 reducer
`mergeLastConversationProgressObservation`（:90），规则（模块头部注释是设计命门，改动前先读完）：

1. **稳态一律单调前进（取 max）**，绝不因「来了个更高置信的证据」把值拉回去——持久转录天然滞后
   （agent 正在生成时 JSONL 里还没有这一轮），允许高置信覆盖低置信会让卡片在两个来源间来回跳。
2. **唯一允许往回拉的例外**：只有 `persisted_agent_transcript` 这一档证据能触发纠偏，且授权只有
   两个来源——(a) 调用方声明这是 incarnation 边界的一次性 rebaseline
   （`allowRebaselineToEarlierObservation`）；(b) 已存值本身是低置信 TUI 猜测、**且此刻不在
   agent 回合中**（`isAgentResponseGenerationTurnInProgress !== true`）。(b) 的「不在回合中」门
   非要不可：回合里转录必然滞后于 TUI 分类器，缺了它纠偏退化成「分类器推到 now → 转录拉回 →
   再推 → 循环」，药丸每个探测周期抖一次。纠偏能力只被推迟，不被取消。
   转录**绝不**回拉 hook / 结构化会话事件的推进（那两档不会被重播刷错，回拉纯属倒退）。
3. **拒收未来时刻**：容忍窗口 1 分钟（`LAST_CONVERSATION_PROGRESS_FUTURE_OBSERVATION_TOLERANCE_MS`，
   :55），窗口内夹到 `nowMs`，超出整条丢弃。坏时间戳一旦被采信，前端
   `formatCompactElapsedSince` 的 `Math.max(0, …)` 会把它静默渲染成 `now`——同一个 bug 的另一副面孔。
4. **违反不变量一律归一化 + 告警，绝不 throw**：这是纯展示字段，让一条坏观测掀翻整批 summary
   广播的代价远大于少显示一颗药丸。

证据置信度偏序（:42，`EVIDENCE_KIND_CONFIDENCE_RANK`）：`persisted_agent_transcript`(3) >
`agent_lifecycle_hook_event`(2) = `structured_agent_session_event`(2) >
`terminal_output_heuristic_classification`(1)。**只用于两处**：同刻并列时升级标签、判定谁有
rebaseline 授权；刻意不用它决定时间值谁覆盖谁。低置信来源在 UI 以 `~` 前缀降级展示
（判据 `isLowConfidenceLastConversationProgressEvidence`，:58，rank ≤ 1）。

### 转录探针的覆盖现状（按可寻址成本划的线，有意的）

`src/agent-session-history/persisted-agent-transcript-last-conversation-progress-probe.ts`：

- **claude**：覆盖。转录目录名由工作目录直接编码而成，一次目录列举 + 有界尾读即可定位，
  成本与任务数成正比，可放进周期性探测。这也正好覆盖那 168 个实测样本的全部。
- **codex / cursor**：**不覆盖**。codex 按日期分桶（cwd 藏在 `session_meta` 里）、cursor 的项目
  目录是数字 id，「找到属于这个工作目录的转录」必须全盘扫描 + 逐个解析——那是
  `available-agent-session-index.ts` 干的事（3s 截止 + 64MB 预算 + LRU），这个成本可以为一次
  用户点击付，不能为每个任务的周期性探测付。它们落到 hook 事件（codex 有）或低置信 TUI 兜底
  （卡片上以 `~` 标注）。扩展点是 `resolveTranscriptFilesForWorkspace`。
- **gemini / opencode / droid / kimi**：本就没有通用落盘转录，不在讨论范围。

### 药丸渲染规则

两颗药丸都**不读** `lastSubstantiveOutputAt`；无值就隐藏，**绝不回退**——回退就是本 bug
原样复发。渲染在 `web-ui/src/components/task-card-body.tsx`（Stopped 约 :683-700，
Progress 约 :702-719；低置信 `~` 判定约 :279-280）。

## 第二部分：`lastSubstantiveOutputAt` 的写路径

字段本身仍是承重件、在服役，但它**不是**从 chat log 读的。两条 agent 路径各有一套写法、坑也
各不相同，改动前必须两边一起看。

### (1) 终端 agent：「刮 TUI 渲染」与续跑重播问题

`session-manager.ts` 的 `flushPendingOutputAnalysis` 用 `agent-output-substance.ts` 的
chrome 掩码 + 每会话行签名 LRU 把 spinner / footer 重绘剔掉。

**致命点**：续跑启动会把整段旧 transcript 重播进新 TUI，而签名记忆是全新的空 Set——每一行都
「没见过」，整段重播被判为实质产出、时间戳刷成「刚刚」。唯一防线是
`suppressSubstantiveOutputUntilContinues`。

**武装判据**（`session-manager.ts:3134-3141`）必须读**启动侧**的
`PreparedAgentLaunch.resumesPriorAgentConversation`（adapter 里决定加 `--continue` /
`--resume <id>` / `--fork-session` 的代码如实置位）`|| request.resumeFromTrash`
`|| request.resumePriorAgentConversationWithoutResendingPrompt`（PTY↔ACP transport 切换后的
续跑入口，`runtime-api.ts` 的通道切换 procedure 置位）。
**绝不能**用「该任务此前是否产出过」这类状态反推：崩溃后从原始 prompt 全新重跑的
auto-restart 根本没有重播，武装它会把真实新产出冻死。

**解除只认「用户真·继续」三处**（统一走 `clearResumeSubstantiveGuard`，:992），缺一会造成
某些 agent 永久冻结：

1. `writeInput`（:3571）——人工手敲；
2. `runTaskChatInputDeliveryAttempt` 里 `writePasteSubmissionWithConfirm` 的**调用点**
   （:1731）——task-chat / RVF 程序化投递。**不可**下沉进那个 writer：连接中断自动续跑
   （`submitConnectionDropContinuation`）共用它，自动恢复不算用户继续；
3. `transitionToRunning({ userInitiatedResume })`（:4197）——`hooks-api.ts` 只把
   UserPromptSubmit / BeforeAgent 判为 true；**Gemini 经 paste 恢复、不过 writeInput，
   全靠这条**。

### (2) 原生 Cline SDK 与 ACP：「默认不推进、显式才推进」的漏斗

两条通道各走自己的 `updateSummary` / `updateAcpSummary` 漏斗，两者都是**默认不推进、显式才
推进**：漏斗对 `lastSubstantiveOutputAt` 不做任何隐式推断，要推进只能由写点显式经
`withAgentSubstantiveOutputTimestamp`（Cline 侧定义于 `cline-session-state.ts:200`，ACP 侧
于 `acp-session-state.ts:133`）声明「这一次确实带来了新的 agent 产出」。

- **Cline 侧**两个发射口（`cline-event-adapter.ts`）：`emitAgentSubstantiveOutputSummary`
  （assistant 文本 / reasoning、工具调用与结果、agent 错误收束、裸 chunk 流）与默认的
  `emitSummary`（`ended` 回合边界、re-attach 补发的 `status` 心跳、turn-cancel、纯 hook 元数据）。
- **ACP 侧**唯一推进点是 `acp-session-update-adapter.ts` 的 `emitRunningSummary`（:232——
  agent 消息 / 思考 / 工具 / plan 这些流式 `SessionUpdate`）。回合完成的 stopReason
  （`end_turn` / `refusal` / `cancelled`）与连接关闭一律不推进——正文早已由流式事件逐条打过戳。

**这个默认方向是反转过来的，别改回去。** 反转前漏斗默认镜像
`lastSubstantiveOutputAt = lastOutputAt`、靠写点 opt-out，结果
`cline-task-session-service.ts` 里 9 处经漏斗的写（SDK start/send 失败、用户提交首轮 prompt、
stop / safe-shutdown / abort、取消回合、用户发消息 ×2、reload）**无一 opt-out**——用户自己
的操作就会把「agent 上次响应」刷成「刚刚」，safe-shutdown 那处还把污染值一路写进落盘
summary。两种漏法的失败形态不对称：opt-out 漏了是**静默写错**（不报错、不掉测试，只是卡片
时间悄悄不对）；opt-in 漏了只是「暂时不前进」，是保守失败。

另一个不对称：Cline summary **不跨进程重启持久化**（终端侧靠 `hydrateFromRecord` 持久化，
Cline 侧没有），重建后是 `null`、随后第一个心跳会镜像成「刚刚」。故
`cline-message-repository.ts` 的 `createTaskEntryFromPersistedSession`（:167）从落盘消息回捞
最后一条 assistant 的 `ts`（`MessageWithMetadata.ts`）。

### (3) 承重不变量与节流窗口的减法绑定

该字段还喂两处判定，改坏它会牵连卡片流转：

- `session-activity.ts` 的 `isAgentActivelyProducingOutput`（:89）——Validation 列自动打回，
  窗口 `VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS = 5s`（:33）；
- `scanForStalls` 的 idle-stall 基线。

因此 `SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS`（实质分类器的节流窗口，
`session-manager.ts:266`）按**减法**结构性绑定成
`VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS - 1s`：必须严格小于它，否则持续产出的会话会出现
虚假 >5s 空档、卡片被误判为已停。节流只作用于实质分类器；同一 flush 里的 adapter 输出转移
检测与 output-reaction 扫描延迟敏感，仍留在 50ms 攒批上。

## 相关文档

- `docs/session-facet-model.md` —— facet 三铁律与 `mergeSummaryWithFacets` 漏斗；
  `agentResponseGenerationStopped` 的边沿判定就落在该漏斗内。
