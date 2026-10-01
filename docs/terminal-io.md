# 终端 IO：输出反应框架、持久终端 visibility 协议、PTY/argv 特殊字符安全、PTY 环境隔离

本文是终端子系统四块「读代码要拼很久才能拼出来」的机制说明：

1. **output-reactions**：跨 harness 的「解码后 PTY 输出 → 检测信号 → 执行动作」扩展点（首个成员是连接中断自动续跑）。
2. **持久终端 visibility 协议**：浏览器标签页隐藏/重现时，xterm 渲染与服务端快照如何协同，避免「延时摄影」回放。
3. **PTY/argv 特殊字符安全**：agent 启动参数（如 `opus[1m]`）在 darwin/linux 与 Windows 两条链路上各自为什么安全。
4. **PTY 环境不继承宿主终端身份**：为什么 `TMUX` 等变量必须在进 PTY 前剥掉。

---

## 1. 输出反应框架（`src/terminal/output-reactions/`）

### 定位与形状

跨 harness 扩展点：每个 reaction 监听**解码后**的终端输出，匹配某种信号（连接错误、配额提示、特定提示符……），守卫（退避/去重/空闲门控）通过后执行动作（注入续跑指令、调度兜底定时器、更新「连接重试」UI 状态）。接口与引擎在 `output-reaction.ts`：

- `OutputReaction`（`output-reaction.ts:70-89`）：`id` / `appliesTo(agentId)` / `createState()` / `onOutput`（每个新 chunk）/ `onAttempt`（兜底定时器或 prompt-ready 触发）/ `triggerNow`（手动立即续跑）/ `dismiss`（手动移出重试列表）/ `standDown`（会话翻入 user 回合时让位）。
- 引擎是**模块级单例、无 per-session 状态**；每个会话的状态由 `createSessionState()` 产出、由 session-manager 持有（`output-reaction.ts:11-15` 设计注释）。
- 所有 PTY 副作用（注入、定时器、提示符就绪判断、重试状态、日志）经 `OutputReactionActions`（`output-reaction.ts:34-66`）由 session-manager 注入——reaction 只决定「何时/是否」动作，实现入口是 `session-manager.ts:1363` 的 `buildOutputReactionActions(taskId)`。

### 驱动链与挂载条件

- 驱动链：`session-manager.ts:2824` 的 `handleTaskOutput` → 攒批 → `flushPendingOutputAnalysis`（:1177）→ `outputReactionEngine.onOutput`（:1325）。注意 reaction 检测跑在攒批后的 flush 里，不是逐 chunk 裸跑。
- 引擎只在两个条件同时满足时才挂载：全局开关 `autoContinueOnConnectionDropEnabled` 开启（`src/config/runtime-config.ts`），且 agent 命中某个 reaction 的 `appliesTo`——挂载判定在 `session-manager.ts:1123`（`engine.isActiveFor(request.agentId)`，不活跃则不为该会话建 reaction 状态、不解码输出）。
- 检测文本管线是 `normalizeTerminalText(stripAnsiAndControl(...))`，两个函数都在 `src/terminal/terminal-output-normalization.ts`（:41、:122）。**不能用裸 `stripAnsi`**：Claude 的错误行会用 `\r` 重绘，不做滚动归一化会漏检。实际分层：chunk 进 reaction 前已 `stripAnsiAndControl`（见 `OutputReactionContext.chunkText` 注释，`output-reaction.ts:23-28`），reaction 内部再套 `normalizeTerminalText`（`connection-drop-auto-continue.ts:184`）。

### 首个成员：connection-drop-auto-continue

监听瞬时连接错误（VPN 掉线：`connection closed mid-response`、`econnreset`、5xx……），等 agent 回到空闲提示符后注入一条简短续跑指令——指令引用 Kanban 自管的 markdown 文件（`~/.cline/kanban/agent-continuation-instructions/`，路径常量与文件生成在 `network-interruption-continuation-instructions.ts:16,54`），以**无限指数退避**重试，直到 agent 恢复推进（恢复判据 =「到下一个退避 tick 之前没有新错误」）。

两个不靠读注释就发现不了的门控（都在 `output-reaction.ts` 的 actions 契约里）：

- **facet 主门控 `isAgentTurnActive`**（`output-reaction.ts:54-63`）：仅在活跃 agent 回合（`turnOwner==="agent"`）才允许起 episode。根治的场景：agent 正在向用户提问（AskUserQuestion / ExitPlanMode / 权限确认）时输出文本与真实掉线**完全同形**（静默 + 停在提示符），瞬时错误正则会命中 agent 自产的问题/选项文本；`classifyConnectionError` 无法在文本层区分，唯一兜底 `isAgentOutputQuiet` 对提问态恰好失效，所以用 facet 这个带外信号门控。配套的 `standDown`（`session-manager.ts:2350` 经 `engine.onUserTurnStart` 转发）兜「PTY 输出先于 hook 落地、episode 已起」的竞态，消除 retrying 徽标闪现。
- **首档退避 4s 特意大于输出静默阈值 2s**（`AGENT_OUTPUT_QUIET_THRESHOLD_MS`，`src/core/session-activity.ts`；注释见 `connection-drop-auto-continue.ts:21-27`）——改其中一个数时必须连同另一个一起看。

当前 `appliesTo` 只覆盖 claude/codex（`connection-drop-auto-continue.ts:173-175`）；Cursor/droid/kiro 是代码注释里登记的第一/第二序列 TODO，接入成本基本就是「appliesTo 放行 + 一组该 agent 的连接错误正则」。

### 如何新增 reaction

1. 实现 `OutputReaction` 接口（`output-reaction.ts:70-89`），per-session 状态以 `unknown` 透明存储、方法内部自行 cast。
2. 在 `output-reactions/index.ts` 的 `buildDefaultOutputReactions()`（:9-14）里追加注册。
3. 若需要新的 PTY 副作用，扩展 `OutputReactionActions` 并在 `session-manager.ts` 的 `buildOutputReactionActions` 里接线——不要绕开它直接碰 PTY。

---

## 2. 持久终端的 visibility 协议

agent 终端是持久 xterm（`web-ui/src/terminal/persistent-terminal-manager.ts`），其 IO WebSocket 跨浏览器标签页切换保持不断。要解决的问题：**浏览器会暂停隐藏标签页的 `requestAnimationFrame`/`setTimeout`**，xterm 的渲染器随之停摆——若隐藏期间照常写入，活输出只会在渲染队列里堆积，回到前台时「延时摄影」式回放（话多的 TUI 上可达数分钟）。

### 协议内容（管理器自监听 `visibilitychange`，`:501`）

- **隐藏时**（`renderingSuspended` 分支，`:998-1007`）：跳过 `enqueueTerminalWrite`（渲染器已停，写了只是积压），但仍然：
  - 立即回 `output_ack`（`:1002`）——服务端靠 ack 做背压，不 ack 会暂停 PTY/agent 本身；
  - 照常 `notifyOutputText(decoded)`（`:1004`）——保持活动检测与 `waitForLikelyPrompt` 存活（每个 chunk 无论可见性都先经流式 TextDecoder 解码，`:997`）；
  - 置 `needsSnapshotResync = true`。
- **回前台时**（`setDocumentVisible`，`:511-524`）：若 `needsSnapshotResync`，**先武装 `awaitingRestoreSnapshot` 门控再发** `request_restore` 控制消息（`:521-522`、`:532`）；服务端（`src/terminal/ws-server.ts:792`）重跑快照握手，直接跳到最新屏幕，不做逐帧追赶。
- **竞态门控**：快照在途期间到达的实时 chunk 属于「将被快照整段覆盖」的过期窗口——ack + 丢弃，但**不再置 `needsSnapshotResync`**（`:1009-1017`；快照本就在途，置位会自触发下一轮 `request_restore` 死循环）。另有兜底超时 `AWAITING_RESTORE_SNAPSHOT_TIMEOUT_MS`（常量 `:46`，兜底计时器 `:535-544`）：快照迟迟不到就解除门控恢复实时渲染——宁可从过期状态续写，也不能白屏卡死。
- 服务端 `TerminalStateMirror`（`src/terminal/terminal-state-mirror.ts:24`）**与观看者可见性无关地实时保持最新**，这正是快照便宜的的原因（`ws-server.ts:726-727` 注释：初次连接与 `request_restore` 共用同一条快照路径）。

### 新增终端 WS 消息要动的三处

1. `src/core/api-contract.ts`——控制消息 zod union（`output_ack` 在 :2880、`request_restore` 在 :2894，新消息加进同一 union）；
2. `src/terminal/ws-server.ts`——服务端分发；
3. `web-ui/src/terminal/persistent-terminal-manager.ts`——客户端收发。

只改两端会得到「发送成功但永远无人处理」的消息，协议层没有任何报错。

---

## 3. agent 启动参数经 PTY/argv 的特殊字符安全

背景问题：形如 `opus[1m]` 的模型 id 里的方括号，经 Kanban 的 PTY 启动链路会不会被吞、被 glob 展开或被 shell 改写？结论：**安全，但这是两条平台链路各自成立，而不是「全平台都不经 shell」**——概括成单一不变量会写出错误的架构文档。

### darwin / linux：不经 shell

`src/terminal/pty-session.ts` 的 `PtySession.spawn`（判定与拼装在 :134-136）在非 Windows 分支直接 `pty.spawn(binary, argvArray, options)`（:150）exec，没有 shell 参与，特殊字符天然安全。

### Windows：仅部分启动经 shell，经 shell 的那部分靠转义保证安全

走不走 shell 由 `shouldUseWindowsCmdLaunch`（`src/core/windows-cmd-launch.ts:135-171`）判定：

- **返回 false（仍直接 argv exec）**：binary 本身是 `cmd`/`cmd.exe`/`ComSpec`；或后缀为 `.exe`/`.com`——无论显式写出还是经 PATHEXT 解析所得（`resolveWindowsBinaryExtension`，:57-97）。
- **返回 true（经 cmd）**：`.cmd`/`.bat` shim，以及「后缀完全无法解析」的兜底（:170）。claude 在 Windows 上是 npm 的 `.cmd` shim，故落在经 shell 的一支。

为 true 时（`pty-session.ts:134-136`）：spawn 二进制换成 `resolveWindowsComSpec()`（即 `cmd.exe`，:116-119），参数由 `buildWindowsCmdArgsCommandLine`（:121-126）拼成 `/d /s /c "<command>"`。其中每个参数经 `escapeWindowsArgument`（:107-114）做 cross-spawn 式转义：先整体加引号，再对 cmd 元字符逐个加 `^`。`[` `]` 在元字符表 `WINDOWS_CMD_META_CHARS_REGEXP`（:4，`/([()\][%!^"`<>&|;, *?])/g`）内且被正确处理——`opus[1m]` 转义后为 `^"opus^[1m^]^"`；引号本身也被 `^` 转义，故 cmd 全程不进入引号态；`/S` 剥掉最外层引号后，`CommandLineToArgvW` 解析出的仍是逐字的 `opus[1m]`。

### 契约侧不额外设限

`runtimeTaskTerminalAgentModelOverrideSettingsSchema`（`src/core/api-contract.ts:156-160`）对模型 override 只要求 `modelId` 为非空 trimmed 字符串（superRefine 只额外校验 cursor 的 id 合法性），不限制字符集——安全责任完整落在上述启动链路上，契约层不兜底也不重复检查。

---

## 4. PTY 环境不继承宿主终端身份

Kanban 的 PTY 是一个全新的终端（前端 xterm.js），不是宿主 tmux / screen / zellij 的 pane，也不是宿主 iTerm 的会话。`buildTerminalEnvironment`（`src/terminal/session-manager.ts`）因此在继承 `process.env` 时剥掉 `INHERITED_HOST_TERMINAL_IDENTITY_ENV_KEYS_STRIPPED_FROM_KANBAN_PTY` 列出的身份变量（`TMUX*`、`STY`、`ZELLIJ*`、`TERM_PROGRAM_VERSION`、iTerm 的会话/能力变量等），agent 终端与 shell 终端两条路径都生效。调用方经 `sources` 显式传入的同名键不受影响；`TERMINFO_DIRS` 这类 terminfo 查找路径刻意保留。

触发事故（2026-09-29，Codex 0.158.0）：Kanban 运行时跑在 tmux 里，Codex 子进程继承了 `TMUX`/`TMUX_PANE`。Codex 0.158 起会据此执行 `tmux display-message -p '#{mouse}'`（上游 `codex-rs/tui/src/tui/tmux.rs`），宿主 tmux 为 `mouse off` → `MouseCapture::DisabledByTmux` → 不开鼠标上报、改开 `?1007h` alternate scroll（`alternate_screen.rs::configure_input`）。xterm.js 在 alt buffer 且无鼠标上报时把滚轮翻译成 ↑/↓，于是滚轮不再滚 Codex 自己的全屏 transcript，而是翻输入框的历史 prompt。

新增「宿主终端身份」类变量时同样加进该常量；已在运行的会话进程保留旧环境，需重启会话才生效。
