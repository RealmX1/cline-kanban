# Claude Code 原生 MCP 使用追踪研究

> 调研日期：2026-07-29  
> 本机 Claude Code：`2.1.220`  
> 范围：只采用 Anthropic / Claude Code 官方文档、官方 CLI 帮助，以及本机 Claude Code 原生 transcript 的只读结构化检查。

## 结论摘要

Claude Code **没有现成的“逐 MCP server / tool 历史使用率”交互式报表**：

- `claude mcp list` / `claude mcp get` / `/mcp` 面向配置、连接状态、认证和健康检查；`/mcp` 显示的数字是 server 暴露的 tool 数量，不是历史调用次数。[官方 MCP 文档](https://code.claude.com/docs/en/mcp#managing-your-servers)
- `/context` 显示当前 context window 被 system prompt、memory、skills、MCP tools 和消息等占用的情况；它回答的是“当前上下文成本”，不是“过去实际使用频率”。[官方配置诊断文档](https://code.claude.com/docs/en/debug-your-config#see-what-loaded-into-context)

但是，存在三层可以使用的数据：

1. **现在立即可回溯：本地 session transcript。**  
   `~/.claude/projects/<project>/<session-id>.jsonl` 原生保存 message、tool use 和 metadata，可自行聚合 MCP 调用；这不是内建 dashboard。[官方 Sessions 文档](https://code.claude.com/docs/en/sessions#export-and-locate-session-data)
2. **低复杂度前瞻追踪：Claude Code hooks。**  
   `PostToolUse`、`PostToolUseFailure` 可记录每次实际完成或失败的 MCP tool call；需要记录调用开始或权限尝试时再加 `PreToolUse`。[官方 Hooks 文档](https://code.claude.com/docs/en/hooks#match-mcp-tools)
3. **官方集中化方案：OpenTelemetry logs/events。**  
   `tool_result`、`tool_decision`、`mcp_server_connection` 能提供调用结果、权限决定、耗时和连接生命周期；逐个自定义 MCP 的真实名称需要开启 `OTEL_LOG_TOOL_DETAILS=1`。[官方 Monitoring 文档](https://code.claude.com/docs/en/monitoring-usage#audit-mcp-activity)

Claude Code 的原生 telemetry **没有逐 MCP 进程内存（RSS/PSS/private footprint）指标**。内存必须另行从操作系统采样并按 Claude session 的进程树归属；远端 HTTP MCP 的服务端内存也无法从 Claude Code 客户端侧测得。

## 目前立刻能看到什么

### 1. 配置与连接状态，而非使用率

本机 CLI `claude mcp --help` 提供 `list`、`get`、`add`、`remove`、`login`、`logout` 等配置管理操作。官方文档进一步说明：

- `claude mcp list`：列出已配置 server；
- `claude mcp get <name>`：查看某个 server 的配置细节；
- `/mcp`：查看连接状态，并显示每个已连接 server 暴露的 tool 数量。

这些入口没有逐 server/tool 的调用次数、成功率、平均持续时间或内存数据。[官方 MCP 文档](https://code.claude.com/docs/en/mcp#managing-your-servers)

### 2. 当前 context 中的 MCP tool 成本，而非调用频率

`/context` 可以显示当前 session 中 MCP tools 占用的 context。当前版本默认使用 MCP Tool Search：通常只有 tool 名称先加载，schema 延迟到实际需要时才进入 context；`alwaysLoad: true` 的 server/tool 例外。[官方 MCP Tool Search 文档](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)

因此 `/context` 适合发现“哪个 MCP tool/schema 正在消耗上下文”，不能回答：

- 过去一周调用了多少次；
- 成功率或失败率；
- 调用耗时；
- 常驻进程内存；
- 某个 MCP 带来了多少模型 token 成本。

### 3. 本地 transcript 可以立即回溯实际调用

官方说明 transcript 位于：

```text
~/.claude/projects/<project>/<session-id>.jsonl
```

每行是 message、tool use 或 metadata。默认 30 天清理，但可通过 `cleanupPeriodDays` 修改；`CLAUDE_CODE_SKIP_PROMPT_HISTORY`、`--no-session-persistence` 或 Agent SDK 的 `persistSession: false` 会让相应 session 没有可回溯记录。[官方 Sessions 文档](https://code.claude.com/docs/en/sessions#export-and-locate-session-data)

官方还明确提醒，这些 transcript 是明文，包含完整 tool call 和 tool result；OS 文件权限是唯一的本地静态保护。[官方 `.claude` 数据目录文档](https://code.claude.com/docs/en/claude-directory#plaintext-storage)

本机只读结构化扫描快照：

| 项目 | 数值 |
|---|---:|
| 保留的 `.jsonl` transcript 文件 | 2,853 |
| 实际包含 MCP tool call 的 transcript | 185 |
| 结构化识别出的 MCP tool call（未跨镜像去重） | 894 |
| 按 `tool_use_id` 去重后的 MCP tool call | 761 |
| 不同 MCP tool 名称 | 62 |

同一 session transcript 可能因为 worktree 迁移或镜像而出现在多个 project 目录中；因此正式聚合必须按 `tool_use_id` 去重。按 server 汇总的去重后保留历史调用：

| MCP server 段 | 调用次数 |
|---|---:|
| `gitnexus` | 356 |
| `playwright` | 132 |
| `tavily` | 67 |
| `serena` | 60 |
| 一个 UUID 形式的 server 名 | 45 |
| `claude-historian` | 37 |
| `ccd_session` | 25 |
| `claude-in-chrome` | 11 |
| `context7` | 9 |
| `visualize` | 9 |
| `chrome-devtools` | 7 |
| `sequential-thinking` | 2 |
| `computer-use` | 1 |

本机用户设置中的 `cleanupPeriodDays` 是 `36500`，因此上表接近“当前磁盘上保留的长期历史”，**不能直接当作最近 7/30/90 天的使用频率**。后续正式报表必须按 transcript 顶层 `timestamp` 切时间窗口，并按活跃 session 数或 agent 运行时长归一化。

另一个重要陷阱：不能用 `rg 'mcp__'` 之类全文计数。tool schema、system/context 内容和说明文字也会重复出现 MCP tool 名，全文搜索会把“被声明或提及”误判成“被调用”。必须只统计：

```text
entry.message.content[].type == "tool_use"
```

且其 `name` 以 `mcp__` 开头的结构化节点。

这类回溯能可靠获得：

- server/tool 的调用次数；
- 调用所在 session、project/cwd 和时间；
- tool input 与 tool result（但为了隐私，报表不应默认采集正文）；
- 通过 `tool_use_id` 关联调用与结果。

它不能可靠回补：

- Claude Code 运行时记录的精确 duration；
- permission wait 与执行时间的拆分；
- 当时 MCP 子进程的 RSS/PSS；
- 已被清理、未持久化或损坏 session 的调用；
- 已经没有 transcript 的历史拒绝事件。

## MCP server 和 tool 如何识别

MCP tool 在 Claude Code 中使用官方命名：

```text
mcp__<server>__<tool>
```

例如：

```text
mcp__memory__create_entities
mcp__filesystem__read_file
```

plugin-bundled MCP 会使用带 plugin scope 的 server 段：

```text
mcp__plugin_<plugin-name>_<server-name>__<tool>
```

例如 plugin `my-plugin` 内 server key `db` 的 `query` tool 会显示为：

```text
mcp__plugin_my-plugin_db__query
```

在 hooks matcher 中：

```text
mcp__.*                  # 所有 MCP tools
mcp__memory__.*          # memory server 的所有 tools
mcp__.*__write.*         # 所有 server 中以 write 开头的 tools
```

官方特别说明，匹配整个 server 时需要保留末尾 `.*`。[官方 Hooks：Match MCP tools](https://code.claude.com/docs/en/hooks#match-mcp-tools)

## 用原生 hooks 进行前瞻追踪

### 可用事件

MCP tools 会像普通 tool 一样进入这些事件：

- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `PermissionRequest`
- `PermissionDenied`

共同可用的关键字段包括：

- `session_id`
- `transcript_path`
- `cwd`
- `permission_mode`
- `hook_event_name`
- `tool_name`
- `tool_input`
- `tool_use_id`

`PostToolUse` 在成功执行后触发，额外包含：

- `tool_response`
- 可选 `duration_ms`

`PostToolUseFailure` 在工具已开始执行但失败时触发；MCP 返回 error result 也属于此类，额外包含：

- `error`
- 可选 `is_interrupt`
- 可选 `duration_ms`

这两个事件的 `duration_ms` 是 tool body 执行时间，不包含 permission prompt 和 `PreToolUse` hooks 的等待时间。[官方 PostToolUse 文档](https://code.claude.com/docs/en/hooks#posttooluse)、[官方 PostToolUseFailure 文档](https://code.claude.com/docs/en/hooks#posttoolusefailure)

### 推荐的最小化 hooks 记录

如果目标只是为后续保留/停用决策收集频率、成功率和执行耗时，建议：

1. 用 `PostToolUse` 记录成功；
2. 用 `PostToolUseFailure` 记录执行失败；
3. matcher 使用 `mcp__.*`；
4. logger **只保留白名单字段**，不落盘 `tool_input`、`tool_response`、完整 `error`；
5. 以 `tool_use_id` 去重；
6. 本地记录字段至少包括：

```text
observedAt
sessionId
workspaceIdentity
mcpServerName
mcpToolName
toolUseId
outcome
durationMs
isInterrupt
```

如果还要统计“模型尝试调用但未执行”的情况，再记录 `PreToolUse` / 权限事件。不过需注意，官方 `PermissionDenied` 当前只表示 auto mode classifier 的拒绝，不涵盖用户手动拒绝、`PreToolUse` hook block 或 deny rule；完整权限决策数据更适合使用 OTel 的 `tool_decision`。[官方 PermissionDenied 文档](https://code.claude.com/docs/en/hooks#permissiondenied)

## 用 OpenTelemetry 进行长期追踪

### 原生支持的数据

Claude Code 的官方 OTel 能导出 metrics、logs/events，以及可选的 beta traces。[官方 Monitoring 文档](https://code.claude.com/docs/en/monitoring-usage)

对 MCP 使用分析最有价值的是 logs/events：

#### `claude_code.tool_result`

每次工具实际执行完成后产生；被拒绝而未执行的调用不会产生该事件。字段包括：

- `tool_name`
- `tool_use_id`
- `success`
- `duration_ms`
- `error_type`
- `decision_type`
- `decision_source`
- `tool_input_size_bytes`
- `tool_result_size_bytes`
- `mcp_server_scope`

开启 `OTEL_LOG_TOOL_DETAILS=1` 后，`tool_parameters` 对 MCP 额外包含：

- `mcp_server_name`
- `mcp_tool_name`

并额外导出 `tool_input`。[官方 Tool result event](https://code.claude.com/docs/en/monitoring-usage#tool-result-event)

#### `claude_code.tool_decision`

记录允许/拒绝以及决定来源。它补足被拒绝调用不会产生 `tool_result` 的缺口。[官方 Tool decision event](https://code.claude.com/docs/en/monitoring-usage#tool-decision-event)

#### `claude_code.mcp_server_connection`

记录：

- `status`: `connected` / `failed` / `disconnected`
- `transport_type`
- `server_scope`
- `duration_ms`
- `error_code`
- plugin 归属

开启 `OTEL_LOG_TOOL_DETAILS=1` 后才包含自定义 `server_name` 与完整连接错误。[官方 MCP server connection event](https://code.claude.com/docs/en/monitoring-usage#mcp-server-connection-event)

### Metrics 能做什么，不能做什么

Claude Code 当前列出的原生 metrics 是 session 数、代码行、PR、commit、cost、token、代码编辑权限决定和 active time；**没有“逐 MCP 调用计数”或“MCP 内存”专用 metric**。逐 MCP 调用统计应从 `tool_result` events 聚合。[官方 Metrics 列表](https://code.claude.com/docs/en/monitoring-usage#metrics)

`claude_code.cost.usage` 和 `claude_code.token.usage` 的 API request attribution 可以带 `mcp_server.name` / `mcp_tool.name`，表示产生该 API request 的 turn 中运行过 MCP tool。但它不是该 MCP call 自身独占造成的模型 token；同一 turn 有多个 MCP、内建 tool 或后续模型推理时，不应把整个 request token/cost 直接当作某一个 MCP 的边际成本。[官方 Cost / Token counter](https://code.claude.com/docs/en/monitoring-usage#cost-counter)

beta tracing 的 `claude_code.tool` span 提供：

- wall-clock `duration_ms`（包含 permission wait 和执行）；
- `result_tokens`（tool result 的近似 token 大小）；
- `tool_use_id`；
- 子 span `blocked_on_user` 和 `execution` 的耗时拆分。

但单纯统计调用次数、成功率和执行耗时时，logs/events 已足够，不需要开启 beta tracing。[官方 Distributed tracing](https://code.claude.com/docs/en/monitoring-usage#distributed-tracing)

### 最小启用方式

典型前瞻配置：

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
export OTEL_LOG_TOOL_DETAILS=1
```

然后由本地 OTel Collector 接收并只保留需要的字段。当前本机抽查的全局 Claude settings、Kanban 管理的 Claude hook settings 和一个 live Claude PID 中，没有发现上述 OTel exporter 已启用，因此 **现有 session 没有可直接查询的历史 OTel 数据**；历史只能先从 transcript 回溯。

Claude Code 不会把自身的 `OTEL_*` 环境变量传递给 Bash、hooks、MCP servers 或 language servers。因此上述 OTel 是 Claude Code **客户端视角**的调用观测，不是 MCP server 自身 telemetry。[官方 Monitoring 配置说明](https://code.claude.com/docs/en/monitoring-usage#configuration-details)

## 隐私和敏感字段

OTel 导出是 opt-in，只发送到用户配置的 backend。默认不记录：

- user prompt 正文；
- assistant response 正文；
- tool arguments / parameters；
- tool input/output 正文；
- raw API body。

但标准属性可能包含 OAuth 用户的 `user.email`、account / organization identity 和 `session.id`。[官方 Monitoring：Security and privacy](https://code.claude.com/docs/en/monitoring-usage#security-and-privacy)

为了按自定义 MCP server/tool 精确分组而开启 `OTEL_LOG_TOOL_DETAILS=1` 后：

- `tool_parameters` 会包含 MCP server/tool 名称；
- `tool_input` 可能包含文件路径、URL、搜索词及其他参数；
- 单个值超过 512 字符会截断，整体约限制在 4K 字符；
- Bash 的 `full_command` 等部分字段不会截断。

因此 collector 必须做字段白名单/脱敏。仅为使用频率统计时，不应开启：

- `OTEL_LOG_TOOL_CONTENT`：可能包含文件原文和 tool output；
- `OTEL_LOG_RAW_API_BODIES`：可能包含完整 conversation history。

对当前个人本地统计场景，**hooks 白名单落盘比开启 `OTEL_LOG_TOOL_DETAILS` 更容易做到数据最小化**；若需要跨进程集中分析、连接事件、完整权限决策和标准 dashboard，再选择 OTel。

## 原生缺失：逐 MCP 内存

官方 metrics、events 和 traces 都没有 MCP server 进程 RSS/PSS/private footprint。要把“使用频率”与“内存收益”放在同一决策表中，还需要一个独立 OS sampler：

1. 以 Claude Code session PID 为根；
2. 识别其 stdio MCP 后代进程树；
3. 把 `npm` / `npx` wrapper 和实际 server 进程合并成一个 MCP instance；
4. 周期性采样总 RSS；macOS 若要避免共享页重复计算，应尽量补充 private footprint/PSS 类指标；
5. 记录 idle/active 状态以及最近一次 tool call；
6. 使用 Claude session ID、Kanban task ID 和 server name 进行关联。

限制：

- 远端 HTTP/SSE MCP 的服务端内存不在本机，客户端只能测连接侧开销；
- 共享 MCP daemon 的内存不能简单除以连接数；
- 只看某个瞬时 RSS 会受缓存、GC 和 lazy load 影响，应至少比较 idle baseline、调用峰值和调用后一段时间的稳态；
- wrapper 与 server 分开计数会夸大“实例数量”，但不应漏掉 wrapper 的真实常驻成本。

## 建议的数据路径

在“不立即变更其他 MCP 配置，之后按频率和内存收益逐项决定”的前提下：

1. **先做只读历史基线**  
   从 transcript 结构化聚合 7/30/90 天的 server/tool 调用次数、活跃 session 数和最近一次使用时间。
2. **新增最小 hooks 追踪**  
   只记录成功/失败、duration 和身份字段，不记录 input/output 正文。
3. **并行加 OS 内存采样**  
   对本地 stdio MCP 记录 idle median、p75/p95、调用峰值和 wrapper/server 分层。
4. **需要完整权限审计或集中 dashboard 时再启用 OTel**  
   OTel Collector 采用字段白名单；不为本任务开启 tool content 或 raw API body。
5. **决策时按 server 看组合指标**  
   例如：30 天调用数、活跃 session 覆盖率、最近使用时间、成功率、p50/p95 duration、idle RSS、峰值 RSS、每次使用对应的常驻内存成本。

这一路径不会预先关闭或改变任何 MCP，只会建立足够可靠的数据基础。
