# oh-my-pi（omp）与 ACP 接入层指南

oh-my-pi（`omp`）是仓库里第一个「非 PTY、非 Cline SDK」的 agent：它经 **ACP（Agent Client Protocol，JSON-RPC over stdio）** 与 Kanban 通话。本文记录 ACP 层的骨架对位、接入 omp 时实测踩出的坑（读协议文档发现不了），以及协议冒烟脚本的用法。

> 补充形态事实：omp 另有一条 PTY TUI 通道（`agent-session-adapters.ts:1969-1974`，模板是 cursorAdapter——omp 根命令吃**位置 prompt** 并自动提交，不需要 deferredStartupInput）。两条通道共用 omp 的同一份磁盘会话存储（omp 的 SessionManager 按 cwd 建库），可随时互相切换；走哪条由 `src/core/agent-session-transport-selection.ts` 决定。本文只覆盖 ACP 通道。

## 1. 三种会话传输形态与能力谓词

三种 session transport 由 `src/core/agent-catalog.ts` 的 `sessionTransport` 字段**单点声明**（:23；`pty_terminal` / `in_process_cline_sdk` / `acp_stdio_subprocess`）。历史教训：omp 之前，「是不是 Cline」的分叉散在 `runtime-api.ts` 的 `useClinePath`、`card-detail-view.tsx` 的面板分流、`persistent-terminal-manager.ts` 的续跑守卫等多处硬编码 `agentId === "cline"`，新增非 PTY agent 极易漏改其中一处。**一律改用能力谓词**：`isRuntimeAgentSessionRenderedAsConversationPanel` / `isRuntimeAgentSessionDrivenByAcpProtocol`，不要再新增按 agentId 的分叉。

## 2. ACP 层骨架（`src/acp-client-session/`）

与 `src/cline-sdk/` 的三层骨架 1:1 对位：

| 文件 | 职责 | cline-sdk 对位 |
| --- | --- | --- |
| `acp-protocol-boundary.ts` | **唯一允许 import `@agentclientprotocol/sdk` 的模块**；类型 re-export、`buildKanbanAcpClientCapabilities`、NDJSON stream 接线、`connectKanbanAcpClient` | `sdk-runtime-boundary.ts` |
| `acp-client-connection-runtime.ts` | 每任务一个子进程 + 握手 + `taskId ↔ sessionId` 双向 Map | SDK host 连接层 |
| `acp-session-update-adapter.ts` | SessionUpdate → facet/消息的**单一入口** | `cline-event-adapter.ts` |
| `acp-session-state.ts` | **唯一 summary 写漏斗**（`updateAcpSummary`） | `cline-session-state.ts` |
| `acp-task-session-registry.ts` + `acp-task-session-service.ts` | 账本与门面 | task-session registry/service |
| `acp-pending-user-decision-broker.ts` | 「等人拍板」通道（permission / elicitation 的挂起-决议） | （Cline 侧无对应物） |
| `acp-agent-launch-catalog.ts` / `acp-session-update-rendering.ts` | agent 启动目录 / 更新渲染 | — |

边界约束同 cline-sdk：协议 SDK 的版本升级、方法重命名、废弃 API 迁移都应只波及 `acp-protocol-boundary.ts`（`acp-protocol-boundary.ts:1-3`）。

**facet 铁律逐字适用**（详见 `docs/session-facet-model.md`）：绝不裸写单个 `userTurnKind`、entry 构造必过 `applySessionFacets`、只推存活度的事件必须显式带当前实质戳。**唯一差别是 pid**：ACP agent 是真子进程，`deriveAcpFacetPatch` 如实传 pid（`acp-session-state.ts:39-49`；不像 Cline 写死 null），于是 `session-activity.ts` 既有的 `pid !== null ? live : exited` 判定自动正确——进程崩了，卡片如实显示 exited。

**推流复用**：Cline 与 ACP 共用 hub 里泛化出的 `trackConversationTaskSessionService`（同一段 summary 批量广播 + 等人回合边沿通知 + 聊天消息转发），按 `${workspaceId}::${sourceKind}` 复合键登记订阅，二者不会互相顶掉。

## 3. 接 omp 实测踩出的坑

### (1) `clientCapabilities.elicitation.form` 缺失 ⇒ omp 静默自动批准 plan

omp 的 plan 审批走客户端的 form 型 elicitation；omp 侧逻辑（`acp-agent.ts` 的 `#requestAcpPlanApprovalChoice`）是「client 没声明该能力 → 没有确认界面可用 → **直接放行**」，否则 plan 模式会卡死 agent。这是**安全语义差异，不是 UI 缺失**——外在表现是「plan 模式一切正常，但从不征求你同意」。`buildKanbanAcpClientCapabilities()`（`acp-protocol-boundary.ts:77-86`）因此必须声明它。注意类型是 `elicitation: { form: {} }`（空对象字面量），**不是 `form: true`**。

### (2) `session/cancel` 之后必须回卷所有 pending 的 `session/request_permission`

ACP 规范硬性要求：发出 cancel 后，要把所有 pending 的授权请求以 `{outcome:"cancelled"}` 回掉，否则 agent 侧永远挂着等回复。`AcpPendingUserDecisionBroker.cancelPendingDecisions`（`acp-pending-user-decision-broker.ts:105-113`）就是干这个的；调用点覆盖三条退出路径——`cancelTaskTurn`（`acp-task-session-service.ts:370-378`）、`abortTaskSession`（:388-394）、连接关闭（:409、:431 等，且刻意放在最前面，先于发 `session/cancel`）。

### (3) omp 把 provider 层错误当普通正文发，`stopReason` 仍是 `end_turn`

实测：AWS SSO 过期、OpenRouter 余额不足这类失败，omp 都作为普通 `agent_message_chunk` 正文流出发送，回合照常以 `end_turn` 收束。**协议层区分不出「真回答」与「凭据失效」——别指望用 stopReason 判失败。**

### 其它协议怪癖（都要兜）

- `current_mode_update` 发的字段是 `currentModeId`；规范示例里写的是 `modeId`——两种都兜（`acp-session-update-adapter.ts:208-216`）。
- `tool_call_update` 的 `content` / `locations` 是**整体替换**语义，不是追加——客户端整条重写而不是拼接（:123）。
- `plan` 更新每次都是**全量列表**，客户端整体替换，故只维护一条消息反复重写（:177）。

## 4. 协议冒烟脚本

`scripts/acp-protocol-smoke.ts`：不经 Kanban UI 与看板状态机，直接对真实 ACP agent 做协议级冒烟，用来最快定位「Kanban 的 ACP 客户端 ↔ agent」之间的协议不匹配。

```bash
npx tsx scripts/acp-protocol-smoke.ts
```

- 前置：`omp` 在 PATH 上且已完成 provider 登录（ACP 直接复用 `~/.omp` 的凭据）。
- 冒烟别的 ACP agent：用 env 覆盖——`KANBAN_ACP_SMOKE_BINARY` / `KANBAN_ACP_SMOKE_ARGS`（逗号分隔）。
- 默认参数 `acp,--approval-mode,yolo`；脚本在临时目录造两个 `.ts` 文件，要求 agent 用工具列文件并回 `DONE`，过程中自动 allow 权限请求、打印 elicitation 与观察到的 update 种类。
