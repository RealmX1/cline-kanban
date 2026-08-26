# 会话状态 facet 模型（双轴模型与三条铁律）

> 本文是「会话状态如何表示、写入、读取」的详情文档，承接根 `AGENTS.md` 铁律区的facet 条目。
> 纯真相源助手全部集中在 `src/core/session-activity.ts`；本文引用的行号以符号定位为准（行号会漂移）。

## 模型总览

会话状态是一个**双轴 facet 模型**。自 Stage 4 反转（inversion）起，facet 是**写时主真相源**；
legacy `state` 字段只是纯派生投影 `projectLegacyState(facets)`（`src/core/session-activity.ts:191`）。

三个存储在 `RuntimeTaskSessionSummary` 上的 facet：

| facet | 取值 | 说明 |
| --- | --- | --- |
| `turnOwner` | `agent` / `user` / `null` | 球在谁手上 |
| `liveness` | `none` / `starting` / `live` / `retrying` / `exited` / `failed` / `interrupted` | 存活度。`computing` / `quiet` 是**时间派生的展示叠加层**，经 `deriveDisplayLiveness`（`session-activity.ts:689`）现算，**绝不入库** |
| `userTurnKind` | `review` / `question` / `plan_review` / `permission` / `error` / `interrupted` / `needs_input` | 仅在 `turnOwner === "user"` 时有意义（人轴细分） |

`state` 是有损投影：例如 `live` 与 `exited` 都投影成 `awaiting_review`，从 `state` 反推不出存活度——
这正是「消费决策不许读 `state`」的根因（铁律 3）。

## 三条铁律

### 铁律 1：绝不手写 `state:` 进 summary patch

每一笔 summary 写入都必须经过**三个** `updateSummary` 漏斗之一，它们内部统一调
`mergeSummaryWithFacets(prev, patch)`（`session-activity.ts:246`）：

- Cline SDK 通道：`src/cline-sdk/cline-session-state.ts:186`（`updateSummary`）
- 终端 agent 通道：`src/terminal/session-manager.ts:731`（`updateSummary`）
- ACP 通道：`src/acp-client-session/acp-session-state.ts:121`（`updateAcpSummary`）

（早期文档写「两个漏斗」是陈旧说法——ACP 通道后加，是第三个漏斗。）

新写入一律发 **facet-only patch**，由各自的构造器产出完整三元组：

- Cline SDK：`deriveClineFacetPatch`（`cline-session-state.ts:23`）
- 终端 agent：`buildTerminalFacetPatch`（`session-manager.ts:741`）
- 终端 reducer 内部：`buildFacetPatch`（`src/terminal/session-state-machine.ts:53`）

带 `state:` 的 patch 只存在于 legacy/seed 兼容路径（旧盘数据、构造种子），新代码不得新增。

### 铁律 2：每次 facet 写入必须是完整的 `{turnOwner, liveness, userTurnKind}` 三元组

三元组必须由单一真相规则 `deriveSessionFacetsFromLegacyState`（`session-activity.ts:153`）派生。
**绝不**把单个 facet 字段（例如 `userTurnKind: "question"`）裸写到一份过期 summary 上——
广播/持久化边界有 Zod `superRefine` 共现与合法组合护栏（`src/core/api-contract.ts:789`），
残缺三元组会在那里炸开。

### 铁律 3：消费者经 `resolveSessionFacets` 读 facet，决策绝不读 `summary.state`

- 读取入口：`resolveSessionFacets(summary)`（`session-activity.ts:460`）
- 共享谓词：`isSessionInActiveTurn`（:510）、`isAwaitingUserReviewTurn`（:522）、
  `isNotifiableUserTurn`（:535）

## schema 兼容设计

`RuntimeTaskSessionSummary` 的 `state` 在 schema 里是 `.optional()`，末尾挂一个 `.transform`
从 facet 回填，因此**输出类型**上 `state` 仍是 required——legacy / CLI 消费方无感。

## 刻意保留的 `state` / `reviewReason` 读取点（白名单，勿扩散）

- 构造种子：`createDefaultSummary`
- `session-manager.ts` 的 stall 诊断**日志**行（纯观测，不做决策）
- CLI 的带标签投影：`commands/task.ts`
- `card-detail-view.tsx` 的 diff 缓存 key
- prompt 探测器的 `reviewReason` 白名单：`agent-session-adapters.ts`、Codex 回车门

除以上外新增 `summary.state` 读取即违规。

## 模态待答判定：`MODAL_USER_DECISION_TURN_KINDS`（唯一被认可判据）

「agent 停在模态待答、正等用户拍板」的判据集中在 `session-activity.ts`：
`MODAL_USER_DECISION_TURN_KINDS`（:550）+ `isAgentAwaitingModalUserDecision(facets)`（:553）。
集合**有意只收** `question` / `plan_review` / `permission` / `needs_input`，**绝不含 `review`**——
`review` 是 agent 自然完工、输入框空闲的状态，恰恰是程序化投递（RVF followup、排队 prompt）
的**目标态**；把 review 算进「等用户」会让每次投递都让位、永不落地（2026-08-08 事故的第二条
根因：当时的实现用 `turnOwner !== "agent"`，把 review 一并吞了进去，代价是一次 49 分钟静默挂起）。
定义放在 `session-activity.ts` 而非某个调用方，是为了让 PTY 投递让位门控
（`session-manager.ts` `runTaskChatInputDeliveryAttempt`，:1642）与排队 prompt 出队门控共用
同一份集合——两处各持一份副本，迟早有一份漂移出「review 又被算进去」的同一个 bug。

## 新增存储字段的 grep 完备性门

每个新增存储型 summary 字段的 Stage，都必须跑一遍 grep 完备性检查：扫描所有
`...summary` / `...createDefaultSummary` 展开（spread），确认没有哪处展开用旧对象整体覆盖了
新字段（或 `state`）。这类覆盖是静默丢字段的经典来源。

## `userTurnKind` 收集链（Stage 4 Phase B 采集增强）

两条采集路径，分别对应两类 harness：

1. **原生 Cline SDK**：`classifyClineUserAttentionTool`（`cline-session-state.ts:40`）——
   `ask_followup_question` → `question`，`plan_mode_respond` → `plan_review`，其余 → `null`。
2. **Claude Code（终端 agent）**：`classifyHookUserTurnKind`
   （`src/core/harness-user-turn-kind-collection.ts:23`），gated `source === "claude"`。

接线：`hooks-api.ts` → `transitionToReview(taskId, "hook", override)`（`src/trpc/hooks-api.ts:402`）
→ reducer 的 `hook.to_review` `userTurnKindOverride`。采集过程有结构化 `[user-turn-kind]` 日志
（`src/diagnostics/user-turn-kind-logger.ts`）；signal 脆弱（Claude 改工具名即静默退化），
由调用点的 expected-but-absent 日志兜底观测。

**Claude ≠ Cline**：`agentId === "cline"` 是进程内 SDK；`agentId === "claude"` 是**终端** agent，
经 `runtime-api.ts` 的 `useClinePath` 分流。改动收集逻辑时先确认自己站在哪条通道上。

### Claude 侧三类人轴与「顺序承重」的分支匹配

`classifyHookUserTurnKind` 当前采集三类 Claude 人轴：

- `plan_review`：`toolName === "ExitPlanMode"`（Claude 原生「计划待批」工具）
- `question`：`toolName === "AskUserQuestion"`（Stage 5）
- `permission`：`hookEventName === "PermissionRequest"` 或 `notificationType === "permission_prompt"`，
  无特定工具（B3）

**分支顺序是承重的：toolName 分支（ExitPlanMode / AskUserQuestion）必须先于通用 permission 分支。**
原因：`ExitPlanMode` 经**两条** hook 机制抵达 `to_review`——

- 专用 `PreToolUse` matcher（`agent-session-adapters.ts` 写入 settings.json 的
  `ExitPlanMode|AskUserQuestion` → to_review）；
- 既有的 `PermissionRequest` `*` → to_review（计划批准对话框同样会 fire PermissionRequest，
  见 Claude hooks 文档，且会携带 `toolName=ExitPlanMode`）。

两者竞争 `to_review` 闸，先到者落定人轴。若 permission 先判，「批准这个计划」会被误标成
`permission` 而非 `plan_review`。把 toolName 分支放前面，归类对两条路径与到达顺序都鲁棒——
「针对 ExitPlanMode 的权限请求」语义上本就是 `plan_review`。

其余事实：

- `kanban hooks` CLI 对**所有**事件都从 hook stdin 抽 `tool_name` 进 `metadata.toolName`
  （`src/commands/hooks.ts`）。
- 自治模式（`--dangerously-skip-permissions`）抑制 PermissionRequest，故 `permission` 在自治模式下
  很少被采到；`question` 依然可靠（AskUserQuestion 无论权限模式都 fire PreToolUse）。
- Claude 的 **log-watcher**（`commands/hook-events/claude-hook-events.ts` 的
  `startClaudeSessionWatcher`）**只服务测试、无生产调用方**——Claude 采集完全走 command-hook
  路径，不走 watcher。

## ACP 通道的适用

ACP 通道（`src/acp-client-session/`，omp 等 agent）逐字适用上述三条铁律：不裸写单个
`userTurnKind`、entry 构造必过 `applySessionFacets`、只推存活度的事件必须显式带当前实质戳。
唯一差别是 pid：ACP agent 是真子进程，`deriveAcpFacetPatch` 如实传 pid（Cline 写死 `null`），
于是 `session-activity.ts` 既有的 `pid !== null ? live : exited` 判定自动正确。
ACP 层骨架与接入坑详见 `docs/agent-harness-omp-acp.md`。

## 相关文档

- `docs/agent-output-timestamps.md` —— 卡片时长药丸与 `lastSubstantiveOutputAt` 的写路径；
  `agentResponseGenerationStopped` 的边沿触发也落在 `mergeSummaryWithFacets` 内。
