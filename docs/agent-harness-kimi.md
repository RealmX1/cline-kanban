# Kimi Code 接入指南（终端 harness）

Kimi Code 是 Moonshot 的原生终端 agent：`agentId === "kimi"`，二进制 `kimi`（`~/.kimi-code/bin/kimi`，npm 包 `@moonshot-ai/kimi-code`）。本文记录接入时敲定的一批**非显然坑**——它们是靠读 `kimi --help`、二进制 strings、实机跑 TUI 才确认的，读 Kanban 代码本身推不出来。

## 1. 形态模板是 codex，不是 droid/kiro

kimi 是**全屏 TUI，且交互模式没有位置 prompt 槽**：`kimi -p/--prompt` 只是单发 print 模式，跑完即退，不产生持久交互会话，不能用于托管会话。因此任务 prompt 一律走 `PreparedAgentLaunch.deferredStartupInput`（= `toBracketedPasteSubmission(prompt)`），在 TUI 就绪后由 `session-manager.ts` 以 bracketed paste 注入——与 codex 同一机制。实现：`agent-session-adapters.ts:1913-1967`（`kimiAdapter`，模块注释明确写了这个形态判断）；resumeFromTrash 时不注入（:1957，避免把 prompt 重打进续跑会话）。

**就绪信号**（`src/terminal/kimi-readiness.ts`）：

- 启动横幅 `Welcome to Kimi Code!` → `hasKimiStartupUiRendered`（:17-20）；
- 输入框字形 `│ >`（box 左边框 U+2502 后跟 `>`）→ `hasKimiInteractivePrompt`（:11-14）。正则匹配的是「边框 + `>` + 空白」，刻意避开正文里裸露的 `>`（diff / 引用）。
- 实测**不弹 workspace-trust** 确认，故无需 claude/codex 那样的 auto-confirm 分支。

**启动旗标**（adapter :1927-1940）：`-y/--yolo`（bypass 权限档）、`--plan`（plan 起步——与 `--yolo` 是独立旗标，互不吃掉对方）、`-c/--continue`（resumeFromTrash）、`-m/--model`（仅在有显式 override 时经 `setModelCliOption` 注入，:1920-1921；无 override 则不传，交回 config.toml 的 `default_model`——与 claude/codex adapter 一致）。另设 `KIMI_CLI_NO_AUTO_UPDATE=1`（:1923-1924）：tui.toml `[upgrade] auto_install` 默认开，会话中途自升级会打断托管会话。

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
