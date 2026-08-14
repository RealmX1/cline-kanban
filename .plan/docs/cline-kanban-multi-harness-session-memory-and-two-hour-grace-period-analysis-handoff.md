# Cline Kanban 多 Harness 会话内存与两小时宽限期：分析交接

## 交接用途

供后续 agents 继续补充分析，最终再据此形成实现计划。当前文档不是计划，不授权实现或修改仓库。

前序现场检查先关闭了两个经用户明确授权的项目侧 Claude 会话，随后又按用户授权关闭其余四个；该轮操作结束时，六个项目侧 sidebar Claude 会话均已停止。本轮继续阅读源码、补齐跨 harness 生命周期与持久化分析，并只更新本交接文档；没有修改仓库源码。

## 用户目标与已确认偏好

用户希望后续解决多 Claude Code / Codex 等 coding-agent 会话长期驻留造成的内存压力，同时保持跨项目快速切换和用户等待场景下的连续性。

硬约束：

1. 会话停止/回收判断与 browser viewer、browser tab、Electron project switch 解耦。
2. 用户正在从“一项目一浏览器标签页”向 Electron 单窗口/单标签、项目快速切换迁移；项目切换绝不能停止仍在工作的 agent。
3. 从 agent 最后一次停止生成响应起，提供**总体两小时宽限期**。
4. 两小时计时包括 agent 已转为等待用户响应的阶段。
5. 若两小时到期时仍在等待 Ask User Question 或同义的普通用户问答：
   - 持久记录问题正文及必要结构化选项/上下文；
   - 下次用户回来时主动呈现；
   - agent 不需要重新提出同一问题；
   - `plan_review` / plan approval 不纳入这项“普通问题重现”机制。
6. 用户明确否决：
   - 广泛地按项目/任务裁剪一般 MCP 能力；
   - 以最后一个 viewer 断开、浏览器标签页关闭或 project switch 作为回收倒计时起点。
7. 唯一认可的默认加载裁剪方向：浏览器 MCP 可能不需要默认加载，应继续核实并考虑改为按需。
8. ACP 是否有助于生命周期与 pending-question 持久化是另一个任务；本交接只保留分析，不应把“迁移 ACP”写成当前内存治理计划的既定实施项。

## 本轮现场结论

### 项目侧 Claude 会话

最近一次 Kanban 服务启动后，实际连续创建了 6 个项目侧 Claude Code 会话，而非最初误报的 2 个：

- `cline-kanban`
- `review-validate-fix`
- `orca`
- `oh-my-pi`
- `ai-analysis`
- `my-ai-setup`

它们在服务启动后的约 38 秒内连续 spawn，与恢复的多个浏览器标签页吻合。

用户第一次授权后，通过 Kanban 的 `runtime.stopTaskSession` 精确停止：

- `__home_agent__:cline-kanban:claude`
- `__home_agent__:my-ai-setup:claude`

随后用户再次授权，精确停止：

- `__home_agent__:review-validate-fix:claude`
- `__home_agent__:orca:claude`
- `__home_agent__:oh-my-pi:claude`
- `__home_agent__:ai-analysis:claude`

主进程及已识别 MCP 子进程均经 PID 复核退出；该轮操作结束时，项目侧 sidebar Claude 会话为 0，task agent 没有因这次操作被关闭。

关闭前，后四个项目侧会话的实时终端快照全部为：

- Claude Code 2.1.220
- Opus 5 / 1M context / xhigh
- `Ctx: 0`
- 空提示符、无正在执行的对话

### 当前部署版本没有 tab-close GC

部署记录：`<HOME>/.cline/kanban/last-deployed-source-commit.json`

- deployed source commit：`57776dad561a7de425eeb6039d3257aafd2500dc`
- deployed at：2026-07-26

部署版本行为：

- `web-ui/src/hooks/use-home-agent-session.ts` 在 terminal descriptor 存在时启动 home session。
- React unmount cleanup 只清前端 refs，不调用 `stopTaskSession`。
- `src/terminal/ws-server.ts` 在 IO/control WebSocket close 时只释放 viewer/listener state，不停止 PTY。
- 因而关闭浏览器标签页不会回收项目侧 agent 或其 MCP。

较新的本地 commit `333ff232`（任务 `b736d`）加入：

- home sidebar 仅在 agent panel 真正可见时懒启动；
- 从磁盘 hydrate 时对不可认领的“live PID”僵尸记录归零。

该 commit 尚未进入上述部署版本，而且它明确“只门控首次启动，绝不停止已启动会话”，仍不是 tab-close GC。这一点符合用户“不按 viewer/project switch 回收”的偏好。

## Claude Code MCP 内存实测

采样时有 20 个 Kanban 托管 Claude 根会话。macOS `ps` RSS 统计：

### 每会话

| 指标 | min | median | p75 | max | mean |
|---|---:|---:|---:|---:|---:|
| Claude 根进程 RSS | 184 MiB | 270 MiB | 399 MiB | 604 MiB | 326 MiB |
| MCP 进程树 RSS | 0 MiB | 151 MiB | 405 MiB | 487 MiB | 231 MiB |
| MCP server tree 数 | 0 | 3 | 6 | 7 | 3.6 |

20 个 Claude 会话的 MCP tree 汇总 RSS 约 4.5 GiB；Claude 根进程汇总约 6.4 GiB。RSS 会重复计算共享页，不能当作独占物理内存，但独立 Node/Python heap 与 wrapper 的重复是真实成本。

### 当前全局 Claude MCP 配置

配置位于 `<HOME>/.claude.json`：

- GitNexus：直接 executable，`alwaysLoad: true`
- Context7：`npx -y @upstash/context7-mcp`
- Serena：`uvx --from git+https://github.com/oraios/serena ...`
- Playwright MCP：`npx -y @playwright/mcp@latest`
- Sequential Thinking：`npx -y @modelcontextprotocol/server-sequential-thinking`
- Chrome DevTools MCP：`npx -y chrome-devtools-mcp@latest`
- Claude Historian：`npx -y claude-historian-mcp`
- 当前 Claude.ai 远程连接：Linear（无本地 MCP server 进程）

Claude Code 版本为 2.1.220；全局设置显式设有 `ENABLE_TOOL_SEARCH=true`。

必须区分两层“加载”：

1. **进程/连接层**：未被当前项目 `disabledMcpServers` 禁用的 user-scope MCP 会在每个 Claude session 启动时连接；stdio server 因此成为该 session 的常驻子进程。除 `alwaysLoad` 外，启动连接默认在后台非阻塞进行。
2. **模型上下文层**：Tool Search 开启时，默认只把工具名用于搜索，完整 tool schema 延迟到真正需要时进入上下文。`alwaysLoad: true` 会绕过这一延迟，并使首次 prompt 最多等待 5 秒连接完成，但它不是“进程是否常驻”的开关。

当前只有 GitNexus 设置 `alwaysLoad: true`；其余 MCP 的 schema 均采用 Tool Search 延迟暴露，但本地 stdio 进程仍常驻。

当前 `cline-kanban` 项目明确禁用了 `chrome-devtools`、`claude.ai Google Drive` 和 `notion`，没有禁用 Playwright。全局 105 条 project 记录中，只有 8 条有显式 `disabledMcpServers`；GitNexus 与 Serena 从未被禁用，Playwright 和 Chrome DevTools 各仅在 4 条记录中被禁用。因此当前实际策略接近“所有全局 stdio MCP 默认每 session 启动，少数项目手工 opt-out”，而不是真正按需启动。

用户最新偏好修正：

- GitNexus 与 Serena 应保持常驻，不应作为建议 2 的裁剪对象；
- 浏览器类 MCP 可以改为进程级默认不启动/显式 opt-in；
- 仅保持浏览器 MCP 的 `alwaysLoad` 为 false 不足以节省其常驻内存，因为这只延迟 schema，不阻止 stdio 进程连接。

### 单 MCP tree RSS

| MCP | 现场进程结构 | RSS |
|---|---|---:|
| GitNexus | 直接 Node executable | 38–55 MiB |
| Context7 | `npm exec` + Node server | 77–80 MiB |
| Serena | `uvx` + Python server | 17–43 MiB |
| Playwright MCP | `npm exec` + Node server | 77–80 MiB |
| Sequential Thinking | `npm exec` + Node server | 74–76 MiB |
| Claude Historian | `npm exec` + Node server | 74–76 MiB |
| Chrome DevTools MCP | wrapper + server + watchdog | 约 125 MiB |

浏览器 MCP 真正启动 Chrome/browser renderer 后可能产生额外数百 MiB，且这些进程不一定全部显示在 MCP 子树 RSS 下。

## 建议 4：去除 `npx/npm exec` 常驻 wrapper

这项建议**不减少 MCP 能力，也不做项目级裁剪**。

现场显示一个典型 Node MCP：

- `npm exec` wrapper：约 42 MiB RSS；
- 真实 Node MCP server：约 34–39 MiB RSS。

`npm exec` 为维持 stdio 管道而与 server 同寿命驻留。若改为受控、稳定路径下的直接 package binary，可省掉 wrapper。

正确方向：

1. 建立稳定、过度指定命名的 MCP runtime 安装目录。
2. 使用 package-lock 锁定 MCP server 版本。
3. 安装后直接调用该目录 `node_modules/.bin/<server>`。
4. 升级采用构建新版本目录 → 验证 → 原子切换指针；不要就地破坏正在运行的会话。
5. 保留 rollback/version provenance。

### 建议 4 与自动更新的关系

直接启动受控 runtime 中的 `.bin` 会取消 `npx` 在每次启动时参与版本解析的机会；若没有额外更新器，版本会保持在 lockfile 指定值。这是有意换取可重复启动，而不是必须接受的永久不更新。

当前各项实际更新语义并不相同：

- Playwright 与 Chrome DevTools 显式写有 `@latest`，但 `npx` 仍使用 npm cache；`@latest` 表示解析目标，默认缓存新鲜度仍会影响何时重新查 registry。`--prefer-online` 才强制立即做 staleness check。
- Context7、Sequential Thinking、Claude Historian 没有显式版本；首次缺包时会解析并安装到 npm exec cache，后续也受 cache/staleness 规则影响，不能视为“每次启动必定升级到最新发布”。
- GitNexus 已直接写死到 `<HOME>/.npm/_npx/<hash>/...`，没有 npm 启动时更新能力，而且该缓存路径不稳定。
- Serena 的 `uvx` 在首次调用使用当时可用版本/解析出的 Git commit，后续默认复用缓存；官方 uv 文档明确说需 cache refresh、`@latest` 或 `--refresh` 才保证重新检查。

因此，建议 4 应配套一个**脱离 agent 启动热路径的受监督更新器**：

1. 定时查询新版本/上游 commit，而不是每开一个 session 都联网解析。
2. 在新的 versioned runtime 目录安装候选版本并生成 lockfile。
3. 运行 MCP `initialize`、`tools/list` 和最小只读 smoke test。
4. 验证通过后原子切换 `current` 指针；新 session 使用新版本，既有 session 继续旧进程。
5. 保留上一版并在健康检查失败时回滚。
6. 记录 package、版本、发布时间、安装时间、校验结果和失败退避。

可按日自动检查、在 Kanban 空闲时升级。这样既保留自动跟进上游的能力，又避免 `npx` wrapper 常驻、每 session 网络抖动、不同 session 恰好解析到不同版本，以及未经验证的最新版本同时击穿所有会话。

错误方向：

- 不要硬编码 `<HOME>/.npm/_npx/<hash>`；这是易失缓存路径。
- 不要为了省 wrapper 而退回未锁版本或每次启动在线安装。

粗略上限：若 10 个会话各自加载 5 个 `npm exec` MCP，仅 wrapper 汇总 RSS 就可能约 2 GiB。实际节省需用 unique footprint/PSS 再验证。

## 建议 5：把合适的 MCP 变成长驻 Streamable HTTP 服务

这项建议同样**不要求减少 MCP 可用性**。目标是把：

`N 个 agent × N 份本地 stdio server heap/cache`

变为：

`1 个受监督 HTTP daemon + N 个轻量客户端连接`

可能适合：

- 无 workspace 可变状态的文档/检索服务；
- 只读 historian/search 类服务（前提是并发和访问范围安全）；
- stateless 服务。

不能直接共享：

- GitNexus、Serena：workspace/repository 状态必须按 client/task 严格隔离；
- Playwright、Chrome DevTools：browser context、page、cookie、操作状态必须隔离；
- 任何把 cwd、环境变量或认证状态当全局变量的 server。

若要共享 stateful MCP，必须先有明确的 tenant key（workspaceId/taskId/sessionId）、资源配额、session cleanup 和权限边界；否则会产生跨任务工具操作与数据泄漏。

收益：

- 只保留一份 runtime heap、索引与缓存；
- 去掉每会话 launcher wrapper；
- warm cache；
- 更集中地做健康检查、日志、升级。

代价：

- 单点故障影响所有会话；
- 服务版本与 agent 兼容性需集中协调；
- localhost HTTP 仍需认证/来源限制；
- server 本身必须真的支持安全多客户端并发。

参考：Codex 官方 MCP 文档确认本地客户端支持 STDIO 和 Streamable HTTP；STDIO 是由 command 启动的本地进程，HTTP 是连接已有地址。

## Codex 现场对照

当前没有 Kanban 托管的 live Codex CLI task session，无法做完全同配置的 Claude/Codex CLI A/B。

Codex Desktop 现场：

- 一个共享 app-server 根进程约 223 MiB；
- 多个 thread/task 仍各自出现本地 plugin MCP：
  - Data Analytics plugin MCP：29–39 MiB/实例；
  - `node_repl`：11–15 MiB/实例；
  - 常见两者合计约 40–54 MiB/thread；
- OpenAI Developer Docs 为远程 HTTP MCP，不产生本地 server process。

因此“Desktop 共享一个 app-server”不等于“所有 thread 共享一份 stdio MCP”。至少 plugin MCP 与 node_repl 在现场是按 thread/task 多实例。

独立 Codex CLI 应按“一个 CLI host 加它自己的本地 STDIO MCP children”评估；远程 HTTP MCP 不复制本地 server heap。官方文档没有承诺跨独立 CLI host 复用 stdio server。

## 两小时宽限期：本轮源码探索与建议语义

不要把 `last viewer disconnected`、tab close、project switch、sidebar collapse 当时间源。

建议后续分析围绕一个独立、可持久化的领域时间戳，例如：

- `agentResponseGenerationStoppedAt`
- 或语义等价但更精确的过度指定名称。

它不能简单等同：

- `lastOutputAt`：TUI cursor/spinner 重绘会刷新；
- `lastSubstantiveOutputAt`：能表示最后实质内容，但不等于已完成/暂停 agent turn；
- `updatedAt`：会被各种元数据刷新。

当前可复用的状态基础：

- `turnOwner`: `agent | user | null`
- `liveness`
- `userTurnKind`: `review | question | plan_review | permission | error | interrupted | needs_input`
- `lastSubstantiveOutputAt`
- `awaitingDispatchedBackgroundWork`

### 不能直接复用现有时间戳

源码进一步确认：

- `lastOutputAt` 会被 TUI spinner、cursor 和 footer 重绘推进；
- `lastSubstantiveOutputAt` 是“最近一次识别到新正文/工具内容”，不是“这一轮已经停止生成”的完成事件；
- `updatedAt` 会被 summary 的任意元数据更新推进；
- terminal 的 `scanForStalls` 已用“停在交互提示符 + 实质输出静默 5 分钟”把漏掉的 agent 回合自愈为 user review，但它是保守 fallback，不是精确的两小时计时起点；
- 首次启动、恢复旧 transcript、纯启动横幅都可能产生输出；一个从未真正开始过用户 turn、仍为 `Ctx: 0` 的空 sidebar session 不应因此获得一个假的 `agentResponseGenerationStoppedAt`。

因此应建立独立的离散领域事件，而不是从某个“最后输出时间”持续反推：

```text
agent_response_generation_stopped
  -> agentResponseGenerationStoppedAt
  -> agentSessionMemoryReclamationEligibleAt = stoppedAt + 2h
```

建议同时带上：

- `runtimeSessionIncarnationId`：区分同一 task 的旧进程与重启后的新进程；
- `agentResponseGenerationTurnSequence`：每次用户提交/新 agent turn 单调递增；
- 触发来源与置信度：`harness_turn_complete | structured_user_question | prompt_ready_fallback`。

timer 触发时必须重新比较 incarnation、turn sequence、当前 facets 与 PID；旧 timer 不能杀掉已经恢复的新一轮。用户提交新输入或 agent 再次开始生成时，应先使旧 deadline 失效，再投递输入。

### 跨 harness 的可用停止信号

| 路径 | 强信号 | 现有限制 |
|---|---|---|
| Claude terminal | `Stop` hook；`AskUserQuestion` 的 `PreToolUse` 表示已停下来等普通回答 | hook runtime 目前只收到归一化摘要，不保留完整问题 |
| Codex terminal | `agent-turn-complete`、rollout `task_complete` / final answer | watcher/rollout 来源需要去重；权限请求是等待用户，不是普通问题 |
| Kimi / Droid / Kiro / terminal Cline / Gemini | `Stop`、`TaskComplete`、`AfterAgent` 等各自 hook | 不同 harness 的问题工具与 payload 能力不一致；prompt-ready 仍需兜底 |
| native Cline SDK | structured agent event、`ask_followup_question` / `plan_mode_respond` tool lifecycle | 当前 summary 只保留分类；完整 input 在 tool message 路径 |
| ACP (`omp`) | `connection.prompt(...)` resolve 的 turn completion；permission/elicitation broker | broker 与 message registry 都是进程内存态，且当前 elicitation 主要是 plan approval |

归一化层应只产一个统一领域事件；各 harness adapter 负责把强信号映射进去。TUI 的“交互提示符已出现 + substantive quiet”仅作遗漏 hook 时的低置信度 fallback。

### background work 与各类 user turn

建议语义：

- `turnOwner==="agent"` 且工具/后台进程仍在运行时，不因为 stdout 安静而启动或触发回收；
- `awaitingDispatchedBackgroundWork` 表示主 agent 正等待已派发工作回灌，不是等用户，不能用普通 review 规则误杀；应由编排器给出明确的 background completion/abandon 信号，或使用单独、更保守的失联策略；
- 一旦结构化事件表明 agent 已结束生成并转为 `turnOwner==="user"`，两小时继续按墙钟时间流逝，包含用户不在场的等待时间；
- `question` 到期时需 durable carry-forward；
- `plan_review` 按用户要求不做普通问题 carry-forward；
- `permission`、`review`、`needs_input` 可以纳入内存回收，但恢复 UI 与后续动作语义应各自明确，不能冒充普通问题；
- `error` / `interrupted` 已没有活跃生成，不应仅为保留进程而额外等待；是否也享受两小时热恢复窗口仍是产品策略点。

### 当前持久化是硬阻塞点

`src/state/workspace-state.ts` 的 `sessions.json` 目前只在 graceful shutdown 时通过 `persistSafelyStoppedRuntimeSessionsByWorkspaceId` 写入。运行中 summary 广播并不等于 durable write；daemon crash、`kill -9` 或机器断电会丢失最近的 deadline 和 pending question。

因此不能只给 `RuntimeTaskSessionSummary` 加字段并假设“可恢复”。至少需要二选一：

1. 新建一个按事件即时写入、原子替换且有 schema/version 的 durable lifecycle/question store；或
2. 把相关 summary 子集改为每次语义状态边沿都经 `lockedFileSystem` 持久化，而不是等关服。

无论采用哪条，启动时都要扫描：

- 未到期：按 `eligibleAt - now` 重建 timer；
- 已到期且对应 incarnation/turn 仍未恢复：立即执行一次幂等回收；
- 已回答/已 supersede 的问题：不得再次展示或再次投递。

这里应持久化绝对 `eligibleAt`，而不是“剩余 1h23m”这类进程内 duration，这样 Kanban/OS 重启期间经过的墙钟时间自然计入两小时。

### 到期停止必须是可核验的 transport-aware reclaim

现有同名 stop 方法的保证并不一致：

- PTY `terminatePtyProcess` 在非 Windows 会向 `-pid` 进程组发 `SIGTERM` / `SIGKILL`，能覆盖 Claude 与 MCP descendants；
- `TerminalSessionManager.stopTaskSession` 只发 stop 后立即返回，不等待实际退出；
- `forceStopTaskSession` 才执行 SIGTERM → 最多等待 2 秒 → SIGKILL → 再等待 500ms；
- ACP `disposeTaskConnection` 当前只关闭连接并向直接 child 发一次 `SIGTERM`，没有进程组 kill、超时升级或退出确认；
- native Cline SDK 依赖 `sessionHost.stop(sessionId)`，并在 `finally` 释放 task MCP tool bundle。

两小时到期不应直接调用当前普通 `runtime.stopTaskSession` 就宣称内存已回收。需要一个按 `sessionTransport` 分派的统一 reclaim 操作，并返回可审计结果，例如：

- 是否确认 root process 退出；
- 是否确认 process group/children 退出；
- 是否使用强制升级；
- 释放了哪些 MCP/runtime 资源；
- 失败时下一次重试时间。

现有 GitNexus symbol context 能找到 `stopTaskSession` 的静态调用边，但该方法还通过 interface/dynamic dispatch 使用，调用者集合只是下界；上述结论以实际源码路由与三种 transport 实现交叉核对为准。

仍需在形成计划前拍板或实测：

1. `error` / `interrupted` 是否享受同样两小时热恢复期，还是可更早回收。
2. background dispatcher 丢失时的独立最大保留期与所有权证明。
3. Windows 下完整 descendant tree 的终止与核验实现。
4. 各 terminal harness 缺 hook 或 hook 丢投时，prompt-ready fallback 的误判率。

## 普通用户问题的 durable carry-forward

用户要求：两小时到期时，若会话仍等待普通 Ask User Question，不让 agent 下次重新问。

需要持久化的最小语义至少包括：

- question id / stable dedupe key；
- taskId / workspaceId / agent session reference；
- 问题正文；
- choices/options 及顺序；
- 是否允许自由文本；
- 提问时间、grace deadline、timeout 时间；
- 来源 harness/tool；
- 状态：pending / answered / dismissed / superseded；
- 用户答案（回答后）；
- 恢复时交付给 agent 的幂等状态。

UI 要求：

- 下次用户进入项目/task 时显式展示 pending question；
- 不依赖恢复旧 TUI scrollback；
- 不把普通 question 混成 plan approval；
- 回答后应把答案可靠送到恢复的 agent 上下文，且不重复交付。

当前 TUI 路径已有部分采集：

- Claude `AskUserQuestion` 可映射到 `userTurnKind="question"`；
- fallback 为 `needs_input`；
- 但 summary 目前只表达类别，不持久化完整问题 payload。

### 本轮确认的 payload 路径

1. **Claude terminal**
   - `kanban hooks ingest` 已从 stdin 解析完整 JSON；
   - `extractToolInput` 已能读 `tool_input` / `toolInput` 等结构；
   - 但 `normalizeHookMetadata` 只留下 `toolName`、`toolInputSummary` 等摘要；
   - `runtimeHookIngestRequestSchema` 也只接受 metadata，`ingestHookEvent` 没有把本地 `args.payload` 发给 runtime。

   结论：普通问题的结构化输入已经到达 CLI ingress，却在进入 daemon 前被主动降维丢弃。最短可靠路径是定义经过白名单校验的 ordinary-question payload 契约，只传所需字段；不要传整个任意 hook JSON，也不要从 ANSI snapshot 抓取。

2. **native Cline SDK**
   - `tool-started` / `content_start` 事件直接提供 `toolCall.input`；
   - `startToolCallMessage` 会把 input 渲染进 tool message，并在 toolCallId map 中保留原输入；
   - Cline message repository 能从 SDK persisted artifacts 水合历史。

   结论：此路径不缺结构化输入，但仍需确认 SDK 落盘格式是否无损保存 question/options，并把它投影成统一 durable question record，而不是把某条展示用 markdown 消息当领域真相。

3. **ACP**
   - `meta.userDecision` 可让同一 daemon 生命周期内的前端刷新/重连恢复按钮；
   - `AcpPendingUserDecisionBroker.pendingByDecisionId`、`decisionMessageIdByDecisionId` 和 `AcpTaskSessionRegistry` 全是内存 Map；
   - registry 源码明确没有磁盘历史水合；停止/取消会把 pending request 回成 `cancelled`。

   结论：当前 ACP UI 消息的“可恢复”仅指进程内重连，不是 Kanban 重启、agent 被回收后的 durable carry-forward。

### 建议的单一领域记录

ordinary question 应脱离 terminal scrollback、ACP live resolver 与特定 agent session 存活性，形成一条由 workspace/task 持有的 durable record。除前述字段外，建议补充：

- `questionSemanticKind: "ordinary_user_question"`，从类型上排除 plan/permission；
- `originRuntimeSessionIncarnationId` 与 `originTurnSequence`；
- 原始 payload 的 schema version；
- `answerDeliveryState: not_answered | answer_recorded | delivery_in_progress | delivered | delivery_failed`；
- `answerDeliveryIdempotencyKey`；
- `supersededByQuestionId`。

回答流程需要保证顺序：

1. 原子地把答案写成 `answer_recorded` 并使 grace timer 失效；
2. 再恢复/新建 agent session；
3. 用稳定 idempotency key 投递“原问题 + 用户答案 + 必要上下文”；
4. agent 接收确认后标为 `delivered`。

这样即使无法无损恢复原进程，agent 也不必重新发问；UI 展示的是 durable question，答案则作为一条明确的 continuation 进入新会话。若恰好能恢复原 pending tool call，可由 harness adapter 优化，但不能成为正确性的前提。

仍需用真实 Claude `AskUserQuestion` hook payload 覆盖测试锁定字段名、单选/多选/自由文本形态，并避免把问题正文或选项写入普通诊断日志。

## ACP 是否有帮助：仅分析，不纳入当前计划

可能的帮助：

- ACP 用结构化 `session/update`、`session/request_permission`、elicitation 代替 TUI 文本刮取；
- `taskId ↔ sessionId` 映射让 UI viewer 与 agent subprocess 生命周期更容易解耦；
- pending decision 可获得稳定 id、正文和选项；
- Electron 单窗口快速切换天然适合连接到后台 session service，而不是把会话绑在 tab/xterm 上；
- turn completion、pending decision、cancel 可以成为明确状态转移。

当前仓库已有：

- `src/acp-client-session/acp-client-connection-runtime.ts`
- `src/acp-client-session/acp-pending-user-decision-broker.ts`
- `src/acp-client-session/acp-task-session-service.ts`
- `src/acp-client-session/acp-session-update-adapter.ts`

现有限制：

- broker 的 durable UI decision kind 目前只有 `tool_permission` 与 `elicitation_form`；
- form elicitation 当前主要服务 omp plan approval，并映射为 `plan_review`；
- 这不是用户要求的普通 Ask User Question carry-forward；
- broker、decision-message 索引与 ACP message registry 当前都是内存 map；前端重连可恢复不等于 daemon 重启可恢复；
- 停止/cancel 时会向 agent 回复 cancelled，不等于跨进程持久化问题并在下次继续；
- ACP transport 本身不解决 MCP 内存复制：每个 ACP agent subprocess 仍可能启动自己的 MCP；
- 能否在杀进程后无损恢复到同一 ACP session，取决于具体 agent 的 resume/session persistence 能力，不能由协议名称推断。

因此 ACP 很可能降低状态识别与 UI 解耦难度，但不能自动提供：

- 两小时生命周期策略；
- durable ordinary-question replay；
- MCP singleton/shared daemon；
- agent process hibernation/resume。

应另开研究任务验证具体 harness（尤其目标 Claude/Codex/omp）的 ACP capability 和 resume 语义；当前计划只应预留抽象边界，不应承诺迁移。

## 非目标与防误解

- 不要实现“最后一个 viewer 断开后 10–30 分钟停止”。
- 不要把 Electron project switch 当 session close。
- 不要把“没有用户看”当“agent 没在工作”。
- 不要广泛移除 GitNexus、Context7、Serena、Historian 等 MCP。
- 不要把 plan approval 当普通 Ask User Question carry-forward。
- 不要假设 ACP 等于内存优化或自动恢复。
- 不要直接使用 summed RSS 宣称同等数量的独占物理内存；实施前应补充 footprint/PSS/phys_footprint 测量。

## 2026-07-29 用户补充：其他 MCP 保持现状并先建立使用基线

用户明确要求：除已经单独讨论的 browser MCP 默认加载问题外，其他 MCP 目前保持现状；后续根据实际使用频率与内存收益逐项决定，不预先停用或迁移。

Claude Code 2.1.220 本机侧已有以下可利用数据：

- `~/.claude/usage-data/session-meta/*.json` 是 `/insights` 生成的预聚合快照，包含 `tool_counts` 与 `uses_mcp`，但当前快照停在 2026-07-08，不是持续更新的监控。
- `~/.claude/projects/**/*.jsonl` 是当前仍持续写入的原生 transcript；结构化统计 `message.content[].type === "tool_use"` 且名称以 `mcp__` 开头的节点，可以回溯 server/tool 调用。
- 同一 session transcript 可能镜像到多个 worktree/project 目录，正式统计必须按 `tool_use_id` 去重。当前保留历史中，原始扫描得到 894 条，去重后为 761 次 MCP tool call。
- `~/.claude/mcp-health-cache.json` 只有少数 server 的连接健康缓存；`stats-cache.json` 没有逐 MCP 使用统计。
- 当前未启用 Claude Code OTel exporter，也没有覆盖所有 MCP 的 usage hooks。

前瞻采集优先考虑 `PostToolUse` + `PostToolUseFailure` hooks，matcher 为 `mcp__.*`，只白名单落盘 server/tool、session/workspace、`tool_use_id`、outcome、`duration_ms`，不保存 tool input/output 正文。需要完整权限决策、连接生命周期或集中观测时再评估 OTel；`OTEL_LOG_TOOL_DETAILS=1` 虽能暴露真实 server/tool 名称，也会扩大路径、URL、搜索词等敏感参数的采集面。

Claude Code 原生没有逐 MCP RSS/PSS/private-footprint 指标。内存仍需由 Kanban 按 Claude session PID 的本地 MCP 后代进程树采样，并把 `npx`/`npm exec` wrapper 与实际 server 合并为同一个 MCP instance 后统计。完整研究笔记：

`.plan/docs/claude-code-native-mcp-usage-tracking-research.md`

## 2026-07-29 补充：Bun/JSC 高水位会放大 Activity Monitor 的会话内存观感

后续验证不能把 Activity Monitor 的单一 `Memory` 数字或 `ps RSS` 直接解释为“仍被业务对象引用的 live heap”。本轮额外使用一个与 Cline Kanban 无关、但同样长期运行于 Bun 1.3.14 的 Better-CCFlare HTTP proxy 作为对照样本：

- 进程运行约 29 小时；
- Activity Monitor / `footprint` 约 2.8 GiB；
- `ps RSS` 只有约 250 MiB；
- `vmmap` 当前 resident 约 472 MiB；
- 约 2.7 GiB 已 swapped；
- 主要表现为 26 个连续的 128 MiB `IOAccelerator` 私有 slab；
- `/api/debug/heap` 显示 JSC live heap 约 57.6 MiB、extra memory 约 46.9 MiB、对象约 191k；
- mimalloc 侧同时显示约 3.4 GiB committed high-water 与大量 abandoned pages。

该 HTTP server 不使用 Claude Code 的 Ink/TUI 渲染链，因此这个现场样本至少证明：在当前 macOS/Bun 组合上，`IOAccelerator` 分类本身不能被直接当成“terminal GPU compositor 泄漏”的充分证据。更保守、也更符合现场的数据解释是：JSC/Bun 在处理大量临时字符串、Buffer、stream 与 SQLite bind 时扩张 native allocator slab；JS 对象被 GC 后，历史 dirty pages 仍可能保留、压缩或换出，Activity Monitor footprint 因而长期接近历史高水位。

这个对照样本的主要分配驱动也与累计流量同阶：过去 24 小时落盘的 3,850 条 `request_payloads` JSON 合计约 2.734 GiB，平均约 727 KiB。当前健康状态下 async writer queue、pending bytes、drop count 均为 0，SQLite page cache 只有数 MiB；短时间空闲采样中 footprint 持平或略降，而不是继续单调增长。这里仍不能仅凭量级吻合断言是某一个 Bun/SQLite binding 泄漏，但足以把“live application container 无界增长”与“allocator high-water retention”列为必须用 heap telemetry 区分的两个不同故障模型。

对 Cline Kanban 的直接含义：

1. 会话治理的主要成功指标仍应是**减少长期存活的 agent/MCP process 数量**；process exit 能确定性释放 live heap、native allocator high-water、MCP children 与 terminal runtime 资源。
2. 单会话诊断至少同时记录：
   - Claude/Codex/其他 harness 根进程的 `phys_footprint`；
   - resident / swapped / compressed；
   - 可用时的 runtime live heap；
   - MCP 与工具 descendant tree；
   - process/session age 与最近一次 agent turn 边沿。
3. 不应把 summed RSS 当独占物理内存，也不应因 root process footprint 高就直接推出上下文或 JS object 泄漏。
4. 回收验收应采用“停止前后进程组/descendant 存活性 + 系统 memory pressure/footprint 变化”，而不是只观察某个 UI 卡片消失。

### 本轮真实批量回收验证

在另一次同机采样中，当前共有 17 个 Kanban task Claude 根会话，其中 12 个运行时间超过 6 小时。通过每个 workspace 的 `runtime.stopTaskSession` 精确停止这 12 个 task session 后：

- 12 个 Claude root 全部退出；
- 12 个原 process group 的残留进程为 0；
- 剩余 5 个 Claude task session 均不足 6 小时；
- 当前 Claude process tree 的 summed RSS 从约 9.93 GiB 降到约 5.23 GiB，瞬时下降约 47%。

该结果证明当前 macOS PTY/Claude 路径的普通 stop 在这批实例上确实连同 descendants 完成了回收，但不能替代前文提出的 transport-aware reclaim：`stopTaskSession` 返回时的 summary 仍可能暂时报告旧 PID/liveness，且 ACP、native Cline SDK、Windows terminal path 的退出确认与强制升级语义并不相同。未来两小时 deadline 的验收必须逐 transport 检查，而不能把这次 Claude/macOS 成功外推为所有 harness 的保证。

### 已部署终端 viewer 内存边界

部署 commit `57776dad561a7de425eeb6039d3257aafd2500dc` 已同时包含：

- client xterm scrollback 20,000 行；
- server `TerminalStateMirror` scrollback 20,000 行；
- browser client 最多保留最近 2 个 parked terminal，其余 LRU dispose。

这与“tab close 不停止 agent session”并不矛盾：browser xterm/viewer 已有容量边界，但 server-side PTY、agent root、MCP children 和每会话 terminal mirror 仍继续存在。后续计划不应再把“无限 parked browser xterm”当成本轮主要根因，也不应因此把 viewer lifecycle 重新耦合到 agent reclaim deadline。

## 2026-07-29 补充：MCP 调用成功性与有效性分组分析

本轮先用 GitNexus CLI 探索了现有 hook 工作流，再派遣三个并行分析 agent，分别分析：

- GitNexus、Serena、Context7、Claude Historian；
- Playwright、Tavily、Claude in Chrome、Chrome DevTools；
- `ccd_session`、Visualize、Sequential Thinking、Computer Use、旧 UUID server。

分析只读扫描 Claude Code transcript，没有改变 MCP 或 Claude 配置。

### 当前 Kanban hook 数据流

GitNexus 索引检查为最新，indexed/current commit 均为 `72d2a55`。Claude 启动时已经由 `src/terminal/agent-session-adapters.ts` 注入 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`Stop` 等 hooks：

```text
Claude hook stdin
  → src/commands/hooks.ts normalizeHookMetadata
  → kanban hooks ingest
  → src/trpc/hooks-api.ts
  → TerminalSessionManager.applyHookActivity / state transition
  → RuntimeTaskSessionSummary.latestHookActivity
```

`RuntimeTaskHookActivity` 当前只保留最后一次活动的 `activityText`、`toolName`、`toolInputSummary`、`finalMessage`、`hookEventName`、`notificationType`、`source`，会丢弃 `tool_use_id`、`duration_ms`、outcome 与 interrupt，也没有逐调用 durable ledger。

因此未来若实施 MCP 追踪，不需要再启动第二套 Claude hook；可以复用现有 ingest，只对白名单字段做持久化，并在 ingest 后过滤 `toolName.startsWith("mcp__")`。本轮只确认可行性，不实施。

### 成功与有效性的四层定义

1. **可配对性**：调用是否有对应 `tool_result`。
2. **协议成功性**：`is_error` 是否不是 `true`。
3. **业务成功性**：结果是否满足该 server/tool 的领域契约。
4. **任务有效性**：结果是否被后续工作采用并产生可观察贡献。

证据等级：

- **A**：独立可验证结果，例如 write 后 read-back、artifact 成功呈现、浏览器交互后再次取证；
- **B**：后续行为强关联，例如符号/路径被后续使用、失败后目标等价重试成功；
- **C**：有限语义抽样或推理辅助，无法证明因果贡献；
- **D**：明确失败、超时、不可用结果，或现有数据无法判断。

不能把“存在 tool result”直接等同于有效，也不能把正常的多步研究/浏览器调用链误判为重复浪费。

### 去重口径修正

必须同时保留：

1. 原始 JSONL event 数；
2. `(session_id, tool_use_id)` session-local 事件数；
3. 全局 `tool_use_id` 执行估计。

resume/fork 可能把同一个历史调用复制进新的 session，因此 pair 去重仍可能高估。Linear 是最明显的样本：pair 口径 122，但全局执行估计只有 45，77 条属于跨 session 镜像。

GitNexus 的 389 条原始记录则在 pair/global 两种去重下均为 356；33 条重复是同一 session 的 transcript 镜像。不同 MCP 的镜像形态不能预先假定相同。

### 代码智能与历史检索

| MCP | 执行估计 | 执行成功 | 近似 p50 | 关键有效性信号 |
|---|---:|---:|---:|---|
| GitNexus | 356 | 260 / 356（73.0%） | 1.885s | 成功后路径复用 160；随后修改 163；随后验证 86 |
| Serena | 60 | 38 / 60（63.3%） | 1.916s | `replace_content` 成功 22 次，22 次随后验证 |
| Context7 | 9 | 9 / 9 | 3.824s | 样本很小；8 次强词汇复用代理 |
| Claude Historian | 37 | 37 / 37 | 3.689s | 26 次强词汇复用代理 |

GitNexus 的 96 次错误中，至少 49 次是“存在多个 indexed repo，但调用没有指定 `repo`”，属于调用编排问题，不等于 server 本身不可靠。

Serena 的 `replace_content` 为 35 次调用、22 成功、13 失败；失败中 9 次为替换失败、4 次为目标未找到。4 次完全相同输入快速重试中有 3 次恢复成功。

Context7 与 Historian 的 100% 仅描述当前小样本，不能外推长期可靠性。

完整报告：

`/private/tmp/cline-kanban-mcp-analysis-code-intelligence.md`

### 浏览器与网页

| MCP | 全局执行估计 | 干净返回 | 明确/高置信问题 | 关键有效性信号 |
|---|---:|---:|---:|---|
| Playwright | 134 | 122（91.0%） | 12 | 33 条 workflow 中 21 条形成完整验证链 |
| Tavily | 67 | 60（89.6%） | 3 正文错误、4 missing | 至少 15 次可证明被后续回答采用 |
| Claude in Chrome | 11 | 1（9.1%） | 1 结构失败、9 次无连接 browser/tab | 0 条完整验证链 |
| Chrome DevTools | 7 | 3（42.9%） | 4 | 只有一个 session，样本不足 |

Playwright 的完整验证链要求“导航/初始化 → 取证 → 若有交互则交互后再次取证 → assistant 结论”。这比按单次工具调用评估更符合 browser MCP 的实际工作方式。

Tavily 的 60 次干净返回中：

- 至少 15 次有可证明采用；
- 32 次随后继续搜索，既可能是主动多查询，也可能是改搜，不能判无效；
- 12 次没有可观察采用，仍属不可判断。

Claude in Chrome 的结构字段会把多数调用记为非错误，但 9 次正文实际表示没有连接浏览器或活动标签。观察到的 3 次跨 MCP fallback 全部来自它：2 次转 Playwright、1 次转 Chrome DevTools。

29 个失败 ID 中，18 个观察到重试/fallback，14 个下一调用恢复成功。失败 ID 没有镜像，因此恢复统计不受 global 去重修正影响。

完整报告：

`/private/tmp/cline-kanban-mcp-analysis-browser-web.md`

### 其他与低频 MCP

| MCP | 全局执行估计 | 技术成功 | 有效性判断 |
|---|---:|---:|---|
| `ccd_session` | 25 | 24 / 25 | chapter/task 操作多为 B，缺少独立消费验证 |
| Visualize | 9 | 8 / 9 | 4 次成功 artifact 为 A；一次失败后相同输入重试成功 |
| Sequential Thinking | 2 | 2 / 2 | 只能给 C，无法证明因果贡献 |
| Computer Use | 1 | 0 / 1 | 约 300 秒后失败，D |
| Linear（旧 UUID server） | 45 | 45 / 45 表面成功 | write 后独立读取链可给 A，其余保守 B/C |

旧 UUID server 已通过工具领域名和本机非敏感会话元数据可靠识别为 Linear。45 次执行估计中有 31 次写、10 次查询、4 次文档搜索。

Linear 结果中用通用 `error` 关键词曾产生 6 个假阳性，实际来自文档或实体正文。这说明业务成功必须用 server/tool 专属结果解析器，不能用通用错误正则。

完整报告：

`/private/tmp/cline-kanban-mcp-analysis-other-and-methodology.md`

### 当前证据可以与不能支持的结论

可以：

- 统计执行频率、配对结果、显式失败、missing；
- 估计历史事件级耗时；
- 发现重复、恢复和明确 fallback；
- 对浏览器、写入和渲染 workflow 建立强行为链；
- 找出 GitNexus 多 repo 未指定参数等调用编排问题。

不能：

- 证明 MCP 返回事实一定正确；
- 证明没有某 MCP 时 agent 会更差；
- 把最终任务成功完全归因于某一次 MCP；
- 从 transcript 得到官方纯执行 duration 或当时 RSS/PSS；
- 用通用文本关键词可靠判断业务失败；
- 把检索后继续搜索自动视为无效。

### 持续分析应输出的组合指标

保持 MCP 配置现状，每个 MCP 按 7/30/90 天输出：

- 全局执行估计、session-local 事件数、原始重复数；
- 活跃 session、main/subagent 分布、最近使用；
- 协议成功率与 tool-specific 业务成功率；
- p50/p90/p99 duration；
- retry/fallback episode、首次失败率、最终恢复率；
- A/B/C/D 有效性样本；
- 浏览器验证链、edit 后验证、write 后 read-back、检索 provenance；
- 与 OS 内存采样关联后的“每个有效 episode 的常驻/峰值内存成本”。

隐私边界继续采用白名单元数据与不可逆 hash，不保存 prompt、路径、URL 或 tool input/output 正文。需要语义有效性时，由本地离线分析读取原 transcript，只输出分类与证据等级。

## 建议后续 agents 补充的证据

1. 用 macOS `footprint`/`vmmap` 或 Activity Monitor phys_footprint 校正 RSS 重复计算。
2. 确认 Claude MCP config 合并优先级：global、project、disabled lists、plugin。
3. 验证哪些 MCP 在 session start 即启动，哪些支持 lazy tool-first launch。
4. 验证 Playwright/Chrome DevTools 的 browser subprocess 归属与额外内存。
5. 为直接 executable runtime 设计可回滚、可锁版本的安装/更新形态。
6. 调研候选 MCP 的 Streamable HTTP 与安全多租户能力。
7. 在“新增独立 durable lifecycle/question store”和“提高 sessions 子集写入频率”之间做故障模型与锁竞争评估。
8. 用真实 Claude `AskUserQuestion` hook payload 建 fixture，验证问题正文、choices、多选与自由文本字段。
9. 为 terminal / native Cline SDK / ACP 各做一次 deadline 到期后的 root + descendant 退出验证；ACP 尤其要验证 process group 与 SIGKILL escalation。
10. 明确 `error` / `interrupted` 的热恢复时限，以及 background dispatcher 丢失时的独立 abandoned 策略。
11. 单独研究 ACP capability/resume；研究结果可影响接口边界，但不自动变成当前实施项。

## Suggested skills

- `gitnexus-exploring`：追踪 session manager、runtime hub、home agent 与 MCP 启动路径。
- `gitnexus-impact-analysis`：在形成计划前评估新增 durable lifecycle/question 字段的消费者范围。
- `mattpocock-skills:research`：对 MCP Streamable HTTP、Claude/Codex/ACP capability 做高信任来源研究。
- `idea-development-planning`：等多 agents 补证完成后，将交接内容收敛为可实施计划。
- `mattpocock-skills:domain-modeling`：建模 session lifecycle、grace deadline、pending user question、viewer attachment 四个正交概念。
- `cline-kanban-post-deploy-verification-authoring`：只有在未来实现完成并进入 review/RVF 前使用，补部署后真实多会话验证。

## 关键参考

- `web-ui/src/hooks/use-home-agent-session.ts`
- `src/terminal/ws-server.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/pty-session.ts`
- `src/commands/hooks.ts`
- `src/trpc/hooks-api.ts`
- `src/core/session-activity.ts`
- `src/core/api-contract.ts`
- `src/state/workspace-state.ts`
- `src/server/active-runtime-session-shutdown.ts`
- `src/server/safely-stopped-runtime-session-persistence.ts`
- `src/cline-sdk/cline-event-adapter.ts`
- `src/cline-sdk/cline-message-repository.ts`
- `src/acp-client-session/`
- commit `333ff232`：侧栏懒启动 + 僵尸状态对账
- deployed commit `57776dad561a7de425eeb6039d3257aafd2500dc`
- Codex 官方 MCP 文档：https://learn.chatgpt.com/docs/extend/mcp.md
