# Kimi Code 接入指南（终端 harness）

Kimi Code 是 Moonshot 的原生终端 agent：`agentId === "kimi"`，二进制 `kimi`（`~/.kimi-code/bin/kimi`，npm 包 `@moonshot-ai/kimi-code`）。本文记录接入时敲定的一批**非显然坑**——它们是靠读 `kimi --help`、二进制 strings、实机跑 TUI 才确认的，读 Kanban 代码本身推不出来。

## 1. 形态模板是 codex，不是 droid/kiro

kimi 是**全屏 TUI，且交互模式没有位置 prompt 槽**：`kimi -p/--prompt` 只是单发 print 模式，跑完即退，不产生持久交互会话，不能用于托管会话。因此任务 prompt 一律走 `PreparedAgentLaunch.deferredStartupPromptText`（原始任务文本），在 TUI 就绪后由 `session-manager.ts` 经共享确认链先写 bracketed paste、再单独写提交回车——与 codex 同一机制。实现：`agent-session-adapters.ts:1913-1967`（`kimiAdapter`，模块注释明确写了这个形态判断）；resumeFromTrash 时不注入（:1957，避免把 prompt 重打进续跑会话）。

**就绪信号**（`src/terminal/kimi-readiness.ts`）：

- 启动横幅 `Welcome to Kimi Code!` → `hasKimiStartupUiRendered`（:17-20）；
- 输入框字形 `│ >`（box 左边框 U+2502 后跟 `>`）→ `hasKimiInteractivePrompt`（:11-14）。正则匹配的是「边框 + `>` + 空白」，刻意避开正文里裸露的 `>`（diff / 引用）。
- 实测**不弹 workspace-trust** 确认，故无需 claude/codex 那样的 auto-confirm 分支。

**启动旗标**：`-y/--yolo` 与 `--plan` 沿用权限、Plan 两条独立轴；`-c/--continue` 用于恢复。未指定模型的新会话会按第 6 节解析最新稳定模型并传入 `--model`，显式模型参数与原生恢复保留原选择。另设 `KIMI_CLI_NO_AUTO_UPDATE=1`：会话中途自升级会打断托管会话。

## 2. session-manager 的三处 kimi 分支

1. `resolveTuiInteractivePromptPredicate`（`session-manager.ts:1053`，kimi 分支 :1059-1061）：kimi → `hasKimiInteractivePrompt`。
2. `isAtInteractivePromptForReaction`（:1344）：output-reactions 框架判断「是否回到可注入的空闲提示符」时用同一判定。
3. deferred-input 就绪门（:2927-2935）：`kimiReady = hasKimiInteractivePrompt(data) || hasKimiStartupUiRendered(data)`。

**注意第 3 处的兜底已演进**：该门**不是**纯 signal-only——kimi 与 claude 同列 `AGENT_IDS_WITH_STARTUP_READINESS_DEADLINE_FALLBACK`（:924），带 wall-clock deadline 兜底。原因写在 :2929-2934 的注释里：启动横幅 / Unicode 输入框 `│ >` 可能被 PTY chunk 边界（含 UTF-8 切分）拆开，signal-only 判定漏识别时 deferred prompt 会永远注不进去、任务假死；超时后回退为「任意 output 即触发注入」。codex 才是 signal-only（刻意不动其既有语义）。（本文写作时 AGENTS.md 旧表述「signal-only、无 deadline 兜底、同 codex」已过时，以代码为准。）

## 3. hooks：TOML `[[hooks]]`，且只从「已解析 home」读

kimi 的 hook 声明在 config.toml 的 `[[hooks]]` 数组表，事件名是 Claude 风格：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` / `Stop` / `StopFailure`（无 Notification / SubagentStop / matcher）。关键约束（实测确认）：

- kimi 只从**已解析的 user-global home** 的 config.toml 读 hook：`KIMI_CODE_HOME` env > `~/.kimi-code`；
- project-local `<cwd>/.kimi-code/config.toml` 的 `[[hooks]]` **不会触发**；
- kimi 没有 codex 那种 `-c key=value` CLI 配置覆盖，hook 只能落在 config.toml。

## 4. seeded home 机制（`src/terminal/kimi-hook-config.ts`）

矛盾：要让 Kanban hook 生效，又不能改动用户全局 `~/.kimi-code/config.toml`（用户手动跑 `kimi` 仍用它，且那里常有 Orca 等工具注入的 `[[hooks]]`）。解法是 Kanban 派生一个自托管的 **seeded home**（`getKanbanManagedKimiCodeHome`，:58-60 → `~/.cline/kanban/hooks/kimi/code-home`），由 `seedKanbanManagedKimiCodeHome`（:152-177）幂等派生/刷新：

- **登录态软链**：`oauth` / `credentials` / `device_id` / `tui.toml` 软链到用户真实 home（`KIMI_SEEDED_HOME_LINKED_ENTRIES`，:31）——令牌轮换、重新登录自动跟进。软链不是「存在即保留」：`ensureAuthPassthroughSymlink`（:130-148）用 `realpath` 双端比对，指向不符或断链（用户切换了 KIMI_CODE_HOME、旧 home 失效）就删链重建，避免「config.toml 来自新 home、oauth 仍链旧 home」的混合配置 + 鉴权失败。
- **config.toml 重写**：用户全局 config 经 `stripTomlHookTables`（:84-102）剔除全部既有 `[[hooks]]`（保留 provider/model/`default_model` 等；按「从 `[[hooks]]` 头行起到下一个表头 `[` 前」整段删除，依赖 TOML「顶层键必先于任何表头」的约定），再追加 Kanban 的 `[[hooks]]`（`buildKanbanManagedKimiHooksToml`，:73-78）。事件映射表 `KIMI_HOOK_EVENT_MAP`（:41-49）镜像 claudeAdapter：`UserPromptSubmit→to_in_progress`、`PreToolUse→activity`、`PostToolUse/PostToolUseFailure→to_in_progress`、`PermissionRequest/Stop/StopFailure→to_review`，命令统一为 `kanban hooks ingest --event <kanbanEvent> --source kimi`，timeout 10s（与用户全局既有 hook 一致）。
- **权限收紧**：seeded config.toml 复制自全局 config，可能含 `providers.*.api_key` 明文——强制 `0600`（:35, :174；`writeTextFileAtomic` 默认权限在常规 umask 下是 0644，且内容不变时跳过写入，故无条件 chmod 兼作旧种子自愈），seeded home 目录 `0700`（:37, :162）。
- **防自引用**：若解析出的全局 home 恰好就是 seeded home（异常继承的 env），回落到默认 `~/.kimi-code`（:155-158），防止从自己身上 seed。

启动接线（`kimiAdapter`，`agent-session-adapters.ts:1942-1954`）：有 hook 上下文时 `env.KIMI_CODE_HOME = seededHome`，并叠加 `createHookRuntimeEnv({taskId, workspaceId})`。**一份共享 seeded home 服务所有任务**——per-task 身份靠 env 随进程携带，会话本身按 cwd/workspace 天然隔离。

校验一个 seeded/全局 home 是否有效：`KIMI_CODE_HOME=<home> kimi doctor`——输出 `OK config.toml` 即有效。

## 5. 接入时改动的文件清单

新增/修改一个终端 agent（kimi 当时）需要同步的点：

- `src/core/agent-catalog.ts`：catalog 条目 + launch 列表；
- `src/core/api-contract.ts`：`runtimeAgentIdSchema` 枚举——这是唯一的编译强制点（`ADAPTERS` 的总量记录会逼你补齐新 id）；
- `src/config/runtime-config.ts`：`normalizeAgentId` allow-list；
- `src/terminal/agent-session-adapters.ts`：`kimiAdapter` + 输出转移检测器（`kimiPromptDetector` / `shouldInspectKimiOutputForTransition`，:1885-1911——与 claude 同为 Stop hook 驱动 to_review，门控口径刻意一致：仅 `reviewReason === "attention"` 时才解码输出探测 prompt-ready，`"hook"` → running 由 UserPromptSubmit hook 驱动、不走输出探测）；
- `src/terminal/session-manager.ts`：上文第 2 节的三处分支；
- 新增 `src/terminal/kimi-readiness.ts`（就绪信号）与 `src/terminal/kimi-hook-config.ts`（seeded home）。

## 6. 新会话自动跟随最新稳定标准模型

`src/terminal/kimi-latest-managed-stable-model-selection.ts` 使用独立 cwd 启动短生命周期的 `kimi web --host 127.0.0.1 --port 0 --no-open`，按原始 chunk 读取带 ANSI 的多行 banner。token 只从当前 `KIMI_CODE_HOME/server.token` 读入内存，不把服务输出或认证信息带进错误诊断。

同一 home 的刷新在 `.kanban-kimi-model-catalog-refresh.lock` 下跨进程串行，直到子服务完全退出才释放，避免多个服务相互覆盖 `server.token`；不同 home 使用不同锁。45 秒默认预算从等待锁前开始，等锁超时不会启动服务；锁重试的完成通知最多再等待一次封顶 250ms 的重试与文件系统调度，已有服务另有 1 秒 SIGKILL 回收兜底。

先调用 `POST /api/v1/providers:refresh_oauth`，确认 HTTP、成功信封、空 `failed` 和 `managed:kimi-code` 的刷新记录，再读取 `GET /api/v1/models`。在官方 provider 的稳定标准/Pro 模型中按数字版本、Pro 档、上下文窗口依次排序；Highspeed、Preview 与第三方同名模型不参与默认选择。目录刷新失败、格式非法或无合格模型时明确失败，不继承旧默认值。每次默认新开局只解析一次，固定到本次启动参数；目录刷新先于 seeded home 复制，确保新 alias 已在启动配置中。

模型响应的 `defaultModelId` 是本次真实选择，UI 的空值仍表示自动跟随；具体版本归入固定版本组选项，即使它恰好等于当前默认，也可独立选择。显式 `--model`/`-m`、任务覆盖、`--session`/`--continue` 及绑定身份恢复不触发自动选模。此路径不调用全局 `set_default`。

参数识别也覆盖 `--resume`/`-r` 隐藏恢复别名及 `-yc`、`-ym` 等合并短选项，并按选项值边界区分真正旗标与字面量。宿主注入的选项须放在真正的 `--` 终止符之前；绑定身份恢复仍保留原有的歧义保护。

协议来源：[Kimi Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)。真实模型验证读取原生会话 `agents/main/wire.jsonl` 中的 `type=llm.request`、`model` 与 `modelAlias`；stdout 的 `session.resume_hint` 只用于定位，不是模型身份凭据。
