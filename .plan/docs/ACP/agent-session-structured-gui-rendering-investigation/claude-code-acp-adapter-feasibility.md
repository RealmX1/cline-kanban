# 把 Claude Code 接成第二个 ACP agent：可行性与落地路径

> 调研于 2026-07-29，基于本仓当时的 `src/acp-client-session/` 与 `@agentclientprotocol/sdk` 1.3.0。
> **本文所有结论来自读源码，协议兼容性本身未实测**（未跑 smoke 脚本）——见文末「未验证项」。

## 动机

移动端的三个症状（读不到 TUI 历史 / 没有 double-ESC 与方向键 / AskUserQuestion 只能在小屏上读 TUI 画的问题框）在 ACP 路径下**大部分自动消失**：会话是结构化 DOM（历史天然可滚、可选中、按屏宽重排），权限与选择走协议原生的 `session/request_permission` + elicitation，由 `task-agent-user-decision-block.tsx` 渲染成原生按钮——不需要方向键，也不需要 double-ESC。

## 现有 ACP 骨架分层

`src/acp-client-session/` 共 9 个文件，1:1 对位 `src/cline-sdk/`：

| 文件 | 职责 |
|---|---|
| `acp-protocol-boundary.ts` | **唯一允许 import `@agentclientprotocol/sdk` 的模块**；`buildKanbanAcpClientCapabilities()`、`connectKanbanAcpClient()` |
| `acp-client-connection-runtime.ts` | 每任务一个子进程 + 握手 + `taskId ↔ sessionId` 双向 Map + stderr 环形缓冲 |
| `acp-session-update-adapter.ts` | SessionUpdate → facet 补丁 + 消息 mutation，**单一入口** |
| `acp-session-state.ts` | 纯状态原语 + **唯一 summary 写漏斗** |
| `acp-session-update-rendering.ts` | ACP 结构化载荷 → markdown（复用既有 markdown 渲染器，零新增前端分支） |
| `acp-task-session-registry.ts` | 纯内存账本 taskId→entry + 监听器扇出 |
| `acp-task-session-service.ts` | 任务级门面，`runtime-api` 唯一 ACP 入口 |
| `acp-pending-user-decision-broker.ts` | 「等人拍板」双向通道 |
| `acp-agent-launch-catalog.ts` | agent 专属启动知识（binary / args / env / plan mode 的 session mode id） |

## 新增一个 ACP agent 要改哪些文件

**编译期强制（漏改会 TS 报错）**

1. `src/core/api-contract.ts:102` `runtimeAgentIdSchema` — zod enum 加 id（`RuntimeAgentId` 的真源）
2. `src/terminal/agent-session-adapters.ts:1912` `const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter>` 是**完全 Record**，必须补一项。ACP agent 照抄 `ompTerminalPathUnsupportedAdapter`（`:1903-1910`，`prepare()` 显式抛错，防止误路由到 PTY 路径）

**运行期必须改（不改会静默失效）**

3. `src/core/agent-catalog.ts` — `RUNTIME_AGENT_CATALOG` 加条目（`sessionTransport: "acp_stdio_subprocess"`）+ 加进 `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`
4. `src/acp-client-session/acp-agent-launch-catalog.ts` — 加 `AcpAgentLaunchDefinition` 并塞进 `ACP_AGENT_LAUNCH_DEFINITIONS`（不加则 `requireAcpAgentLaunchDefinition` 抛错）

**建议同时改（否则体验降级但不报错）**

5. `src/core/task-agent-permission-mode.ts:16` `AGENT_IDS_SUPPORTING_AUTO_APPROVE_FILE_EDITS_ONLY`（不加则中间档降级为 ask-every）
6. `web-ui/src/components/agent-visual.ts:24`（`Partial<Record<...>>`，不加只是 fallback Bot 图标）
7. `web-ui/src/components/runtime-settings-dialog.tsx:109` `SETTINGS_AGENT_ORDER`
8. `src/acp-client-session/acp-task-session-service.ts` 的 **4 处硬编码 `?? "omp"`**（`:104, :352, :366, :455`）——这是目前唯一「ACP = omp」的残留假设，接第二个 ACP agent 时必须清掉

安装检测**无需改**：`src/terminal/agent-registry.ts:51` 的 `detectInstalledCommands()` 直接遍历 `RUNTIME_AGENT_CATALOG` 的 binary 做 PATH 探测。

## Claude Code 具体的两处阻碍

1. **`id: "claude"` 已被 PTY 传输占用**（`agent-catalog.ts:27`）。要么新增一个 id（如 `claude-acp`），要么改现有 claude 的 `sessionTransport`——**后者会破坏整套 Claude hook 体系**（`agent-session-adapters.ts` 注入的 settings.json、`classifyHookUserTurnKind` 的 userTurnKind 收集、`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` 等）。**结论：必须新 id 并存。**

2. **`binary` 是单字符串且会做 PATH 探测**（`acp-client-connection-runtime.ts:103` `isBinaryAvailableOnPath(spawnCommand.binary)`）。`@zed-industries/claude-code-acp` 是 npm 包，启动形如 `npx @zed-industries/claude-code-acp`。`AcpAgentSpawnCommand` 已经是 `{ binary, args, env }` 三元组，表达得了；但 binary 写 `npx` 时 PATH 检查会通过却不代表 package 可用——需要额外的可用性判定。（`agent-registry.ts:52` 的候选列表里已经含 `"npx"`，可复用。）

## 现成的验证手段（零代码）

`scripts/acp-protocol-smoke.ts` 支持用 env 换 agent：

```bash
KANBAN_ACP_SMOKE_BINARY=npx \
KANBAN_ACP_SMOKE_ARGS='@zed-industries/claude-code-acp' \
npx tsx scripts/acp-protocol-smoke.ts
```

它复用 Kanban 真实的 `buildKanbanAcpClientCapabilities()` 与 `connectKanbanAcpClient()`（`:66-69`），所以同时验证了本仓的 capability 声明是否够用。三条断言（`:88-92`）：收到 `agent_message_chunk`、收到 `tool_call`、`stopReason === "end_turn"`。失败时打印 stderr 尾 4000 字符。

**这一步应该在写任何生产代码之前先跑。** 需要重点观察的问题：

- `AskUserQuestion` 在 adapter 里映射成什么？`session/request_permission`、elicitation，还是干脆只是普通 `agent_message_chunk`（那样 GUI 就拿不到结构化选项，路径的核心价值消失一半）
- plan mode 是否经 `session/set_mode` 暴露？`planModeSessionModeId` 该填什么
- rewind / checkpoint 是否经协议暴露（SDK 有 `session_fork` / `session_resume`，但 Kanban 一个都没调用）
- 本仓只声明了 `elicitation.form` 一项 capability，claude-code-acp 是否需要 `fs` / `terminal`（本仓 v1 明确不代理这两者，见 `acp-protocol-boundary.ts:83-85`）

## 仓库里既有的痕迹

代码里零痕迹（`grep -rn "claude-code-acp"` 在 src/web-ui/scripts 下 0 命中，`package.json` 无 `@zed-industries/*` 依赖）。只有两处规划文档提到：

- `.plan/docs/planning-column-research.md:39` — 标题 `### Claude Code (zed-industries/claude-agent-acp)`；`:60` 另有 `### Codex (zed-industries/codex-acp)`
- `.plan/docs/ACP/ACP-reference-project.md:259` — `args?: string[]; // e.g., ["@zed/claude-code-acp@latest"]`

## 未验证项

- **协议兼容性完全未实测**：上面的 smoke 命令本轮没有跑过。包名 `@zed-industries/claude-code-acp` 取自规划文档而非 npm registry 实查，落地前须先确认包名与当前版本。
- Codex 亦有 `zed-industries/codex-acp`，同样未验证。
- 接入后 Claude 的 PTY 路径与 ACP 路径并存时，卡片/通知/RVF 等消费方是否都按 `sessionTransport` 正确分流——未逐条核查。
