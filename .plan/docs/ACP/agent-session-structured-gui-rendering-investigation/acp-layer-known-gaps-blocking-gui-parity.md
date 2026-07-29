# ACP 层已知缺口：阻塞「GUI 体验与终端路径对等」的清单

> 核实于 2026-07-29，逐条读源码确认（每条附 `文件:行号`）。
> 这些缺口不影响 omp 当前的日常可用性，但**在把 ACP 当作「移动端主路径」之前必须逐条处理**——
> 移动端没有「切回终端凑合一下」的退路。

## 1. 【已确认的渲染 bug】ACP 工具消息永不转圈、reasoning 永不自动展开

**这是清单里唯一一条现存 bug，其余都是「未做」。**

前端 `web-ui/src/components/detail-panels/cline-chat-message-item.tsx` 判定运行态读的是 Cline hook 体系的字段：

- `:19` `const isRunning = message.meta?.hookEventName === "tool_call_start";`
- `:133` `const isStreaming = message.meta?.hookEventName === "reasoning_delta";`

而这两个值**只由 Cline SDK 路径写入**（`src/cline-sdk/cline-session-state.ts:357` 与 `:282/:290`）。ACP 路径写的是另一个字段 `meta.toolCallStatus`（`src/acp-client-session/acp-session-update-adapter.ts:122, :138`）。

后果：ACP 会话里 `isRunning` / `isStreaming` **恒为 false** —— 工具调用不显示 spinner，reasoning 块流式期间不自动展开。用户看到的是「工具卡片凭空出现又凭空完成」，没有任何进行中的反馈。

附带问题：`ToolMessageBlock` 走 `parseToolMessageContent()` 解析 Cline 的内容格式，而 ACP 写进 content 的是 `acp-session-update-rendering.ts` 自己拼的 markdown（title / locations / diff），两者格式不匹配。

修法方向：把运行态判定改成读一个**与传输形态无关**的规范化字段，两条路径都写它；而不是让前端认识两套字段。

## 2. 会话历史纯内存，服务器重启全丢

`src/acp-client-session/acp-task-session-registry.ts:1-3` 文件头明写：

> 与 Cline 侧的 message-repository 对位，但没有「从磁盘水合历史」那一层——ACP 的 session/load 续跑不在本期范围，会话历史由 agent 自己持有。

对比 Cline：`InMemoryClineMessageRepository` 有 `hydrateTaskMessages()`，能从 Cline SDK 落盘的 session artifact 恢复。ACP 没有。

后果：Kanban 服务器重启后，ACP 任务的卡片回到空会话。SDK 提供的 `session_load` / `session_fork` / `session_resume` / `session_list` **全部未调用**。

同源问题：pending decision 的 `decisionId` 是进程内自增序号（`acp-pending-user-decision-broker.ts:126`），重启后所有待答决策静默消失（agent 进程也一并被杀）。

## 3. 聊天列表无虚拟化、无分页

`web-ui/src/components/detail-panels/cline-agent-chat-panel.tsx:465` 是全量 `messages.map(...)`。后端 `listMessages` 一次返回全部，tRPC 请求 schema 无 cursor/limit。

移动端尤其吃紧：长会话 = 全量 DOM + 全量 Prism 高亮。（仓库已有 `react-virtuoso` 依赖，本轮的 transcript 阅读视图正是用它处理同类问题。）

## 4. 四处 `?? "omp"` 硬编码

`src/acp-client-session/acp-task-session-service.ts:104, :352, :366, :455`。

这是目前唯一「ACP == omp」的残留假设。接第二个 ACP agent 时，summary 丢失 agentId 的边界情况会被错标成 omp。

## 5. `src/acp-client-session/` 零单元测试

该目录 9 个文件**没有任何 `.test.ts`**。唯一验证手段是 `scripts/acp-protocol-smoke.ts`，而它需要真实 `omp` 二进制 + 已登录凭据。前端 `cline-agent-chat-panel.test.tsx` 也不覆盖 ACP / decision 路径。

facet 三条铁律（不裸写单个 `userTurnKind`、entry 构造必过 `applySessionFacets`、只推存活度的事件必须显式带当前实质戳）在 ACP 侧**全靠人工遵守，无测试守**。

## 6. 决策按钮触控目标 28px < 44px

`web-ui/src/components/detail-panels/task-agent-user-decision-block.tsx:74` 用 `size="sm"`，即 `h-7`（28px，见 `ui/button.tsx:27`）。仓库自定的移动端下限是 44px（`components/shared/mobile-minimum-touch-target.ts:7`，iOS HIG / WCAG 2.5.8）。

相邻按钮 gap 仅 `gap-1.5`（6px，`:70`）。Approve / Reject 挨在一起且都不足触控下限 —— **误触代价是批准了不该批准的工具调用**。

好的一面：`:70` 用了 `flex-wrap`，窄屏是换行而非挤压。

## 7. 其它「未做」项（不阻塞，但影响体验对等）

- **无中途 session mode 切换**：`setSessionMode()` 存在（`acp-client-connection-runtime.ts:179`）但唯一调用点是启动时切 plan mode（`:191-206`）；`current_mode_update` 只被渲染成一条 status 文本，UI 上无法切 plan↔act。`card-detail-view.tsx:996` 传的是 `showComposerModeToggle={false}`。
- **6 种 SessionUpdate 被静默丢弃**（`acp-session-update-adapter.ts:64-71`）：`available_commands_update`（→ 无法把 agent 的 slash 命令喂给 composer 补全）、`usage_update`（→ 无 token/成本展示）、`session_info_update`、`config_option_update`、`plan_update`/`plan_removed`。
- **elicitation 只支持「form + 单选 enum」一种形态**（`acp-pending-user-decision-broker.ts:75-76` 自陈）；自由文本表单、URL 型一律 decline。
- **`mcpServers: []` 硬编码**（`acp-client-connection-runtime.ts:236, :252`），本仓已有的 Cline MCP 设置服务没接到 ACP。
- **认证路径脆**：`openAgentSession()` 只试 `authMethods[0]`（`:245-249`）。
- **无 stall 兜底**：`acp-session-update-adapter.ts:216-218` 自陈没有终端侧 `scanForStalls` 那样的兜底，回合归属改错就回不来。
- **provider 错误无法识别**：AGENTS.md 记录 omp 把凭据失效当普通 `agent_message_chunk` 发、`stopReason` 仍是 `end_turn`，协议层区分不出；代码里无补偿。
