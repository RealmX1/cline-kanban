# Orca「head-only mode」交叉引用

> 调研于 2026-07-29。原始计划：`~/.claude/plans/head-only-mode-curried-feigenbaum.md`（2026-07-15，Orca 项目）。
> Kanban 的 `.plan/docs/` 下此前无对应文档，本仓也**未实现**该模式。

## 设计是什么

把一个 agent 会话拆成同屏两半：

```
┌─ terminal tab, viewMode:'head-only' ────────────────┐
│  ┌───────────────────────────────────────────────┐  │
│  │ GUI BODY (portal overlay, 只盖上部)            │  │  ← 结构化渲染 transcript
│  │  transcript / tool-call 卡 / diff / 自动滚动    │  │
│  └───────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │ HEAD (真 xterm，裁剪到底部头部区域)             │  │  ← 后台 PTY 保持大固定尺寸
│  │  [浮层: /slash 补全 · 审批 y/N · 状态行]        │  │     overflow:hidden + 负 translateY
│  │  › 输入行（原生，接收全部键盘）                  │  │     裁掉上方对话正文
│  └───────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
        后台同一 PTY 继续跑真 TUI（不 kill、不缩尺寸）
```

要点：**原生输入面 100% 保真**（slash / skill 补全、审批 prompt 这些交互只有真 TUI 才对），同时对话主体的可读性由 GUI 负责。

对移动端而言这正是终局形态：`AskUserQuestion` 的**问题正文**由 GUI 渲染（可读、可滚、可选中），**选择框**仍由原生 TUI 渲染（保真，且只占一小块屏幕）。

## 关键实现点（Orca 侧）

| 关注点 | 做法 | Orca 文件 |
|---|---|---|
| PTY 尺寸解耦 | `FitOverride['mode']` 加 `'head-only'`，把 xterm/PTY 钉在大固定尺寸（默认 120×40），容器 resize **不转发**给 PTY | `src/renderer/src/lib/pane-manager/mobile-fit-overrides.ts` |
| 视觉裁剪 | 读活 xterm 的 `buffer.active`（`cursorY` / `viewportY` / `type==='alternate'`）算出「头部区域起始行」→ 负 `translateY` 偏移 + 头部带高度 | `src/renderer/src/components/terminal-pane/head-only-clip.ts`（净新增） |
| 动态扩展 | `/`、`@`、skill 浮层或审批 prompt 出现在输入行上方时头部带需向上扩展 | 同上 |
| 布局合成 | overlay 只盖上部：`absolute inset-x-0 top-0 bottom-[HEAD_H]`，xterm 不 unmount、PTY 不 kill | `TerminalPane.tsx` |
| 输入 | 底部真 xterm 保持可聚焦，`onData` 原样收全部按键，**不新增输入通道** | `pty-connection.ts` |

**Orca 自己标注的唯一真风险点**是视觉裁剪那一步：codex / claude 的 Ink 布局各异，「头部起始行」的判定阈值必须做成 per-agent 校准常量，且浮层/审批出现时头部带要动态伸缩——审批 prompt 若被裁掉，表现是「agent 无故卡死」。

## Kanban 落地缺什么前提

**缺一条 PTY agent 的结构化 body pipeline。** 这是唯一的硬阻塞，也是本仓短期不做 head-only 的原因。

- Orca 的 GUI body 数据源是 **agent 自己写的 session JSONL**（`src/main/native-chat/transcript-reader.ts` + per-agent decoders），能拿到 `tool_use` / `tool_result` / thinking 的真实结构。
- Kanban 的 `ClineAgentChatPanel`（`web-ui/src/components/detail-panels/cline-agent-chat-panel.tsx`）只服务 Cline SDK 与 ACP 两种传输形态；**PTY agent 完全没有 body pipeline**。
- 本仓有一个未被使用的起点：`src/commands/hook-events/claude-hook-events.ts` 的 `startClaudeSessionWatcher`——AGENTS.md 记载它是 **test-only、无生产调用者**（Claude 的 userTurnKind 收集走的是命令 hook 路径，不是这个 watcher）。它是「读 Claude session JSONL」这件事在本仓最近的已有代码。

其余前提本仓都已具备：xterm 跨 mount 存活的 `PersistentTerminal`、服务端 `TerminalStateMirror`、按传输形态分流的 `isRuntimeAgentSessionRenderedAsConversationPanel`。

## 本轮**没有**吸收 PTY 尺寸解耦（并附驳回理由）

移动端适配（2026-07-29）一度吸收了 Orca 的「PTY 尺寸与可视尺寸解耦」思路，在
`web-ui/src/terminal/persistent-terminal-manager.ts` 里落成过一个
`resolveRowsWithMobileSoftKeyboardLock()`：移动视口下只同步列数，行数钉在首次适配出的值，
理由是「软键盘开合反复改变可视高度，同步给 PTY 会让全屏 TUI 整屏重排」。

**该机制已在同轮 RVF 中移除**，行数恢复为与列数一样如实跟随 fit 结果。三条驳回理由：

1. **依据不成立。** 被引为证据的「codex resize 触发 `ESC[2J ESC[3J` 全量重印 + 20k 行 mirror
   重放」是 **`--no-alt-screen` 强制 inline 专属**的历史顽疾。codex 现在跑原生 alt-screen——
   `test/runtime/terminal/agent-session-adapters.test.ts` 里有一条显式防回灌断言
   （"launches Codex on its native alt-screen by NOT injecting --no-alt-screen by default"）
   守着这一点。alt-screen 下 resize 只原地重绘一屏；服务端 resize 路径
   （`session-manager.ts` `resize()` → `session.resize` + `mirror.resize`）也不向客户端回放 mirror。
2. **被防的事件基本不发生。** app 根布局是 `h-[100svh]`（small viewport height，静态单位，
   软键盘开合不改变它），且两大移动浏览器默认 `interactive-widget=resizes-visual` 只改
   visual viewport。驱动这里的 `ResizeObserver` 观测的是布局高度，软键盘开合本就不会让它抖动。
3. **代价是两个不可恢复的失效面。** (a) 首次 fit 可能发生在终端容器仍是 `display:none` 的
   移动 tab 里（`card-detail-view.tsx` 移动分支用 `style={{ display }}` 切 tab），锁进极小行数
   后再也抬不回来；(b) 可视高度真的变小时行数不跟随，TUI 会把输入行/选择区绘到已被裁掉、
   且**不属于 scrollback** 的底部行里，用户无法靠滚动找回——这恰好毁掉本轮「手机上读完 agent 的
   `AskUserQuestion` 后就地按方向键回答」的核心目标。

与 Orca 的差别由此变成结构性的：Orca 钉住**两个**维度并配合视觉裁剪，因为它**只要「头」**、
本就不打算让用户看到或操作被裁掉的部分；Kanban 移动端要的是**完整可交互的终端**，任何一个
维度被钉住都会把可交互区推出可视范围。这条思路对本仓不适用，不是实现细节没调好。

## 与本仓 transcript 阅读视图的关系

移动端适配交付的 transcript 阅读视图（`web-ui/src/terminal/terminal-scrollback-transcript-extraction.ts` + `web-ui/src/components/detail-panels/terminal-scrollback-transcript-reader-panel.tsx`）是 head-only body 的**抓屏版前身**，两者是同一方向的两个台阶：

| | 台阶 1（已交付） | 台阶 2（head-only body） |
|---|---|---|
| 数据源 | xterm normal buffer 抓屏 | agent session JSONL |
| 结构化程度 | 逻辑行文本（`isWrapped` 续行已拼回） | tool_use / tool_result / thinking 真实结构 |
| 实时性 | 快照 + 手动刷新 | 实时流 |
| agent 覆盖 | 全部 PTY agent，零 per-agent 代码 | 每个 agent 要写一个 decoder |
| 与 TUI 关系 | 叠加切换（同一面板内，xterm 不卸载） | 同屏并存 |

台阶 1 的「叠加」已经比朴素的二选一走近了一步：阅读视图以 `absolute inset-0` 盖在 xterm 之上，**xterm 始终挂载、PTY 继续跑**（xterm 的 `renderingSuspended` 只由整个浏览器标签页的 `visibilitychange` 驱动，不看元素是否可见），且虚拟按键条在两种模式下都在——所以「读完 agent 的提问就地按方向键回答」这条路径已经通了。与 head-only 的真正差距只剩「对话主体与原生输入面**同时可见**」这一条。

台阶 1 的提取层刻意做成**纯函数 + 与渲染解耦**：面板消费的是 `TerminalScrollbackTranscriptLogicalLine[]`，将来换成结构化消息源只需替换提取器，面板不动。

台阶 1 也**刻意没有**引入 Orca 标注的那个真风险（per-agent 校准「头部起始行」）——它读的是完整 normal buffer，不需要判断任何边界。
