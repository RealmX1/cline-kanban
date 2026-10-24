# Kimi Code 接入指南（终端 harness）

Kimi Code 是 Moonshot 的原生终端 agent：`agentId === "kimi"`，二进制 `kimi`（`~/.kimi-code/bin/kimi`，npm 包 `@moonshot-ai/kimi-code`）。本文记录接入时敲定的一批**非显然坑**——它们是靠读 `kimi --help`、二进制 strings、实机跑 TUI 才确认的，读 Kanban 代码本身推不出来。

## 1. 形态模板是 codex，不是 droid/kiro

kimi 是**交互式 TUI，且交互模式没有位置 prompt 槽**（2.3.1 默认 `regular`，并非 alt-screen；清历史边界见第 6 节）：`kimi -p/--prompt` 只是单发 print 模式，跑完即退，不产生持久交互会话，不能用于托管会话。因此任务 prompt 一律走 `PreparedAgentLaunch.deferredStartupPromptText`（原始任务文本），在 TUI 就绪后由 `session-manager.ts` 经共享确认链先写 bracketed paste、再单独写提交回车——与 codex 同一机制。实现：`kimiAdapter`；resumeFromTrash 时不注入，避免把 prompt 重打进续跑会话。

**就绪信号**（`src/terminal/kimi-readiness.ts`）：

- 启动横幅 `Welcome to Kimi Code!`，或窄终端带省略号的原文前缀（如 `Welcome to Kim…`）→ `hasKimiStartupUiRendered`；
- 输入框字形 `│ >`（box 左边框 U+2502 后跟 `>`）→ `hasKimiInteractivePrompt`（:11-14）。正则匹配的是「边框 + `>` + 空白」，刻意避开正文里裸露的 `>`（diff / 引用）。
- 早期接入时未观察到 workspace-trust；2.3.1 在隔离 HOME 的新目录会显示 `Trust this folder?`。原生验证探针只批准自身创建的空目录，不修改产品的 trust 策略。

**启动旗标**：`-y/--yolo` 与 `--plan` 沿用权限、Plan 两条独立轴；`-c/--continue` 用于恢复。未指定模型的新会话会按第 8 节解析最新稳定模型并传入 `--model`，显式模型参数与原生恢复保留原选择。另设 `KIMI_CLI_NO_AUTO_UPDATE=1`：会话中途自升级会打断托管会话。

## 2. session-manager 的三处 kimi 分支

1. `resolveTuiInteractivePromptPredicate`（`session-manager.ts:1053`，kimi 分支 :1059-1061）：kimi → `hasKimiInteractivePrompt`。
2. `isAtInteractivePromptForReaction`（:1344）：output-reactions 框架判断「是否回到可注入的空闲提示符」时用同一判定。
3. deferred-input 就绪门（:2927-2935）：`kimiReady = hasKimiInteractivePrompt(data) || hasKimiStartupUiRendered(data)`。

**5 秒兜底只负责重新核验**：Kimi 与 Claude 同列 `AGENT_IDS_WITH_STARTUP_READINESS_DEADLINE_FALLBACK`，避免启动信号被 PTY 分块拆开后永远等不到下一段输出。Kimi 的最终门禁在 `trySubmitDeferredStartupPrompt`：必须有启动横幅、当前镜像中的输入框，并且累积输出及当前屏幕均无待确认的信任模态。启动横幅支持原生窄屏省略形式，首发与信任解除共用同一识别器；旧横幅不能解除后来出现的信任模态。超时和横幅都不能单独触发粘贴。输入框、横幅和信任提示被分块时，以完整终端镜像及有界累积输出核验；热接管使用相同判据。其他 agent 的既有就绪语义保持原样。

窄屏省略号的 UTF-8 字节可能跨 PTY 分块，也可能横跨接管追赶与实时输出。Kimi 使用同一增量解码器接续这些字节；追赶后的屏幕只用于当前状态核验，不插入原始信任历史，避免截断尚未完成的横幅。

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

## 6. 输入接受确认与历史重打印（2.3.1 / wire 1.5）

卡片的「提交待确认 / 尚未确认接受」表示提交候选尚缺可靠接受证据；15 秒后变为「尚未确认接受」不代表失败，也不会因此重投。Codex 在 compaction 期间延迟取得证据、随后清除标签，符合该语义。本次 Kimi 适配不改变 Codex 判据。

Kimi 的 `UserPromptSubmit` 是前置 hook，不能证明输入已进入主会话上下文。hook 提供的 `session_id` 是身份来源；`kimi-native-conversation-activity-reader.ts` 用它在托管 `KIMI_CODE_HOME/session_index.jsonl` 中精确匹配 `sessionId` 与 `workDir`，再核实 `state.json` 的版本、id、cwd，读取 `agents/main/wire.jsonl`。派生路径不写回 summary，避免后续不带 `transcript_path` 的 hook 把 observer 游标反复重置。

当前只接受协议头 `metadata.protocol_version === "1.5"`、`context.append_message`、`agentId === "main"`、`message.role === "user"`、`message.origin.kind === "user"` 的真实消息，并按原生 `message.id` 去重。`turn.prompt`、排队事件、压缩摘要、注入、系统触发、hook 结果和子代理均不构成接受证据。内容排除 `meta.source === "user prompt submit hook"` 的附加块；纯附件仅识别 `image_url/imageUrl.url`、`audio_url/audioUrl.url`、`video_url/videoUrl.url`，URL 必须为非空字符串，确认时不伪造正文（[2.3.1 的 ContentPart 定义](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/packages/agent-core-v2/src/human/llm/message.ts#L32-L47)）。程序化投递仍需正文、写前游标和当前会话身份共同匹配。

通常首次读取只建立基线。同代仍有 pending/unconfirmed 候选时，允许有界回查 `attemptedAtMs` 之后的真实消息，覆盖「首次消息触发 SessionStart，记录先于 observer 基线」以及压缩后迟到核验。半行按 LF 等待完整记录，U+2028/U+2029 不拆帧。原生已结束回合或缺少回合关联时只确认接受事实，不重新开启回合。未知协议、错误身份、记录不在读取预算内时保留未确认。每次 wire 增量/回查上限 256 KiB，session index 尾部和 state 各上限 1 MiB。

历史重复的原因独立于输入核验：Kimi regular TUI 在尺寸变化或历史区域更新时，会发出 `CSI 2J`、`CSI H`、`CSI 3J` 再重印完整历史。抑制 `CSI 3J` 会保留旧 scrollback，使新打印堆叠。Kimi 启动、实时输出和热重启追赶统一放行该指令；接管时即使旧记录写着 `suppressScrollbackErasure=true` 也覆盖为 false。浏览器保持既有终端选项和 reset 后恢复快照的流程。已有重复由下一次原生完整重绘清理，无需重发 prompt。

依据：[数据布局](https://moonshotai.github.io/kimi-code/en/configuration/data-locations)、[TUI 配置](https://moonshotai.github.io/kimi-code/en/configuration/config-files)、[2.3.1 的主屏重绘实现](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/packages/pi-tui/src/tui-main-screen.ts)、[持久化协议](https://github.com/MoonshotAI/kimi-code/blob/684bae9ea6a437f3bae98bba1dcb797a917d500b/packages/agent-core-v2/src/human/persist/v2/wire.ts)。这些协议版本来自已验收基线，未来不兼容格式须重新适配。

## 7. 原生自动化探针

`scripts/verify-kimi-native-input-acceptance-and-terminal-redraw.ts` 使用真实 Kimi、隔离 HOME、空 skills 和仅监听 loopback 的模拟 OpenAI 服务，执行两次人工输入、一条程序化投递及其关联回执、长输出、三次 resize、携带旧抑制设置的 PTY 接管；保存原始字节、原生 hook、接受摘要和终端快照。它不读取真实凭据、不调用付费模型、不创建真实 Kanban 卡片或关系事件。该探针不进入默认测试集；需要本机 Kimi 二进制时按需执行。

执行 `node scripts/run-kimi-native-input-acceptance-and-terminal-redraw-verification.mjs <持久证据目录> <kimi绝对路径>`。启动器按运行时同样的 ESM/CJS shim 打包探针，设置隔离 HOME 并清空继承环境，只传入必要 PATH、SHELL、TERM 和探针参数。探针拒绝继承真实 `KANBAN_HOOK_TASK_ID` / `KANBAN_HOOK_WORKSPACE_ID`；退出时停止 PTY 和模拟服务，保留证据文件。

浏览器回归：`KANBAN_KIMI_NATIVE_E2E_OUTPUT_DIRECTORY=<证据目录> npm --prefix web-ui run e2e -- tests/kimi-terminal-history-redraw-and-acceptance.spec.ts`。设置目录时还会把真实运行快照恢复到浏览器 xterm，检查重复恢复不叠历史，以及真实 accepted 摘要清除确认标签；不设置目录时运行固定重绘协议回归。

初始提示词回归：在上述原生启动器命令末尾追加 `initial-prompt`，运行 `verify-kimi-native-initial-prompt-delivery.ts`。它在 30×24 和 104×24 终端分别验证两种真实 Kimi 场景：Kanban 工作树自动首发；任意目录等待信任超过 5 秒、运行时热接管后通过 `writeInput` 确认，再自动首发。四种组合均检查完整中文多行正文、唯一原生用户消息、唯一模型请求与 Plan 起步，保留原生输出、摘要及结果 JSON。

`initial-prompt` 可以对同一证据根目录重复运行：每轮创建持久的 `initial-prompt-execution-*` 子目录，隔离新的 HOME、工作目录与信任记录，并保留全部历史证据。根目录 `result.json` 指向当前轮次的 `executionDirectory`，启动时先改为 `running`，结束后写入本轮结果和退出码；失败不会沿用上一轮的 `passed`。

## 首发与工作区信任

Kanban 创建的任务工作树默认注入原生进程级 `KIMI_CODE_TRUST_WORKSPACE=1`，不写用户永久信任记录；显式环境值优先。任意目录仍保留 Kimi 的原生信任对话框。该模态可能渲染底下的输入框，因此看见 `│ >` 不等于已经可以投递正文。

待发正文存在且原生信任模态仍打开时，方向键（CSI / SS3）与回车仅转交模态，不当作替代正文、不创建提交接受候选。模态关闭并出现就绪输入框后自动续发。普通文本和 Esc 继续让出首发控制权。等待原因会输出 `startup-prompt-waiting` 日志，原生接受仍独立核验，不因等待或回车而假定成功。

## 8. 新会话自动跟随最新稳定标准模型

`src/terminal/kimi-latest-managed-stable-model-selection.ts` 使用独立 cwd 启动短生命周期的 `kimi web --host 127.0.0.1 --port 0 --no-open`，按原始 chunk 读取带 ANSI 的多行 banner。token 只从当前 `KIMI_CODE_HOME/server.token` 读入内存，不把服务输出或认证信息带进错误诊断。

同一 home 的刷新在 `.kanban-kimi-model-catalog-refresh.lock` 下跨进程串行，直到子服务完全退出才释放，避免多个服务相互覆盖 `server.token`；不同 home 使用不同锁。45 秒默认预算从等待锁前开始，等锁超时不会启动服务；锁重试的完成通知最多再等待一次封顶 250ms 的重试与文件系统调度，已有服务另有 1 秒 SIGKILL 回收兜底。

先调用 `POST /api/v1/providers:refresh_oauth`，确认 HTTP、成功信封、空 `failed` 和 `managed:kimi-code` 的刷新记录，再读取 `GET /api/v1/models`。在官方 provider 的稳定标准/Pro 模型中按数字版本、Pro 档、上下文窗口依次排序；Highspeed、Preview 与第三方同名模型不参与默认选择。目录刷新失败、格式非法或无合格模型时明确失败，不继承旧默认值。每次默认新开局只解析一次，固定到本次启动参数；目录刷新先于 seeded home 复制，确保新 alias 已在启动配置中。

模型响应的 `defaultModelId` 是本次真实选择，UI 的空值仍表示自动跟随；具体版本归入固定版本组选项，即使它恰好等于当前默认，也可独立选择。显式 `--model`/`-m`、任务覆盖、`--session`/`--continue` 及绑定身份恢复不触发自动选模。此路径不调用全局 `set_default`。

参数识别也覆盖 `--resume`/`-r` 隐藏恢复别名及 `-yc`、`-ym` 等合并短选项，并按选项值边界区分真正旗标与字面量。宿主注入的选项须放在真正的 `--` 终止符之前；绑定身份恢复仍保留原有的歧义保护。

协议来源：[Kimi Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)。真实模型验证读取原生会话 `agents/main/wire.jsonl` 中的 `type=llm.request`、`model` 与 `modelAlias`；stdout 的 `session.resume_hint` 只用于定位，不是模型身份凭据。
