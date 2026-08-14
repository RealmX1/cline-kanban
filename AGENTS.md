This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

RVF entry: Post-Deploy Verification authoring

RVF-ENTRY-SKILL: cline-kanban-post-deploy-verification-authoring

RVF-PRE-REVIEW-BASE-SYNC-SKILL: sync-local-base-into-task-worktree-only

- 当一个 kanban 任务的实现收尾、宣告完成、或进入 review 前（即进入 RVF review/validate/fix 阶段时），**必须先调用 skill `cline-kanban-post-deploy-verification-authoring`**：分析哪些断言只有部署后的真实运行实例才验得到（超出部署前现场测试），并把它们注册成自动脚本型 / 引导人工型验证，使其在部署后出现在验证面板里。
- RVF fix 若改变了可观察行为，land 前以 **reconcile 模式**重入该 skill（对已注册定义按 verificationId 幂等重注册、只 diff 变化，不堆叠重复）。
- 上面的 `RVF-ENTRY-SKILL:` 行是 **repo-通用的机器可发现约定**：其它仓库将来可在自己的 AGENTS.md 声明同样的标记来 opt-in 这一 RVF 入口机制。（RVF 主插件侧「读取目标 repo 的 RVF-ENTRY-SKILL 并调用之」的通用钩子属另一仓库、需 rvf-local-deploy，暂未实现、仅在此记录。）
- `RVF-PRE-REVIEW-BASE-SYNC-SKILL:` 从 local base ref 的 `AGENTS.md` 读取；旧 task worktree 若尚未吸收该 local base，必须先运行所声明的严格单向同步 skill，再准备 RVF。该入口不得把 task 工作反向写入 local base。

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like Cline SDK reasoning settings, use the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- Kanban's native Cline agent is powered by the installed `@clinebot/core` and `@clinebot/llms` packages plus the local `src/cline-sdk/` boundary layer, so when Cline behavior is unclear, inspect those packages and `src/cline-sdk/` for the real implementation details.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- Long-lived local Kanban servers that RVF or automation may reuse should be launched inside tmux session `cline-kanban` or `cline-kanban-<port>` (for example `cline-kanban-3484`). RVF treats that tmux session name as the ownership signal for an existing listener; do not launch the reusable server in `rvf-*`, `vibe-kanban`, random shell, or unnamed tmux sessions.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. `test/runtime/cline-sdk/cline-task-session-service.test.ts` was the big prior culprit because a unit-style suite was still booting the real Cline SDK host.
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- Terminal agent output self-healing lives in `src/terminal/output-reactions/` — a cross-harness "detect a signal in decoded PTY output → take an action" extension point. First member `connection-drop-auto-continue` watches for transient connection errors (VPN drops: `connection closed mid-response`, `econnreset`, 5xx…) and, once the agent is back at its idle prompt, injects a short continuation that references a Kanban-owned markdown (`~/.cline/kanban/agent-continuation-instructions/`), retrying on infinite exponential backoff until the agent makes progress (recovery = "no new error before the next backoff tick"). To add a reaction: implement `OutputReaction` and register it in `output-reactions/index.ts`; it is driven from `session-manager.ts` `handleTaskOutput` via `engine.onOutput`, and all PTY side effects (inject / schedule timer / set retry state / prompt-ready check) are supplied by `buildOutputReactionActions`. The engine only mounts when `autoContinueOnConnectionDropEnabled` is on AND the agent is in `appliesTo` (currently claude/codex — Cursor/droid/kiro are first/second-priority TODOs in the reaction). Detection runs on `normalizeTerminalText(stripAnsiAndControl(...))` from `terminal-output-normalization.ts` (NOT bare `stripAnsi` — Claude's error line redraws with `\r`).
- Adding a `RuntimeTaskSessionSummary` field (like `connectionRetry`) means: add it to the zod schema in `src/core/api-contract.ts`, then it rides the existing `runtime-state-hub.ts` batched broadcast automatically → `use-runtime-state-stream.ts` `mergeTaskSessionSummaries` → `App.tsx` `sessions` → board cards / top-bar. No new subscription needed. A persisted global settings toggle follows the `readyForReviewNotificationsEnabled` chain end-to-end: `runtime-config.ts` (file shape / state / update input / `normalizeBoolean` / write / save / update / updateGlobal) + `api-contract.ts` config response & save schemas + `agent-registry.ts` `buildRuntimeConfigResponse` + `runtime-api.ts` (parse + thread into `terminalManager.startTaskSession` AND `refreshTaskTerminal`) + `runtime-settings-dialog.tsx` (state/initial/dirty/save). Forgetting the `runtime-api.ts` startTaskSession wiring is the easy miss — the toggle then has no runtime effect.
- The per-card stage actions (Move to validation / Move to done / commit / open PR / restore) are wired through TWO parallel `BoardCard` host chains that must be kept in sync: the main board renders `BoardCard` via `kanban-board.tsx` → `board-column.tsx`, while the Focus View left sidebar renders the SAME `BoardCard` via `card-detail-view.tsx` → `detail-panels/column-context-panel.tsx` (its internal `ColumnSection`). Each host independently per-column-gates which handlers it passes down (e.g. `onMoveToValidationTask={column.id === "review" ? ... : undefined}`), so a `BoardCard` button can render (its `columnId` condition is met) yet do nothing because that host didn't pass the handler for that column — the original "in_progress Move to done does nothing / review Move to validation does nothing" bug. When adding or changing a per-card action, update `board-card.tsx` (render condition) AND both hosts' gating. The Move-to-Done "skips Validation → confirm" decision is centralized in `use-board-interactions.ts` (`requestMoveToTrash` → `pendingMoveToDone` → `confirmMoveToDone`/`cancelMoveToDone`) with a single `SkipValidationConfirmDialog` rendered at `App.tsx`; both the by-id handler (`handleMoveReviewCardToTrash`, used by board + sidebar cards) and the selected-card handler (`handleMoveToTrash`, used by the agent TUI bottom button) funnel through it, so don't reintroduce a per-view dialog.
- Session state is a **dual-axis facet model**, and (since the Stage 4 inversion) facets are the **write-time primary source of truth** — legacy `state` is a pure derived projection `projectLegacyState(facets)`. The three stored facets live on `RuntimeTaskSessionSummary`: `turnOwner` (agent/user/null), `liveness` (none/starting/live/retrying/exited/failed/interrupted — `computing`/`quiet` are TIME-DERIVED display overlays via `deriveDisplayLiveness`, never stored), `userTurnKind` (review/question/plan_review/permission/error/interrupted/needs_input, only meaningful when `turnOwner==="user"`). The pure truth-source helpers are all in `src/core/session-activity.ts`. IRON RULES: (1) **NEVER hand-write `state:` into a summary patch** — every summary write goes through the two `updateSummary` funnels (`cline-sdk/cline-session-state.ts`, `terminal/session-manager.ts`) which call `mergeSummaryWithFacets(prev, patch)`; new writes emit **facet-only** patches (built via `deriveClineFacetPatch` for Cline SDK, `buildTerminalFacetPatch` for terminal agents, `buildFacetPatch` inside the reducer), and `state:`-bearing patches are only the legacy/seed compat path. (2) **Every facet write must be a complete `{turnOwner, liveness, userTurnKind}` trio** built from the single-source rule `deriveSessionFacetsFromLegacyState` — never write a bare single facet field (e.g. `userTurnKind:"question"`) onto a stale summary, or you hit the Zod `superRefine` co-presence/legal-combo guard at the broadcast/persist boundary. (3) **Consumers read facets via `resolveSessionFacets`, NEVER `summary.state`** for decisions (`isSessionInActiveTurn`/`isAwaitingUserReviewTurn`/`isNotifiableUserTurn` are the shared predicates) — `state` is lossy (live & exited both project to awaiting_review). The schema `state` is `.optional()` + a final `.transform` that fills it from facets so the OUTPUT type keeps `state` required (legacy/CLI consumers unaffected). Intentionally-retained `state`/`reviewReason` reads: constructor seeds (`createDefaultSummary`), the `session-manager.ts` stall diagnostic LOG line, the CLI labeled projection (`commands/task.ts`), the `card-detail-view.tsx` diff cache key, and the prompt-detector `reviewReason` whitelists (`agent-session-adapters.ts`, Codex enter gate). Each Stage that adds a stored summary field must run the grep-completeness gate (scan `...summary`/`...createDefaultSummary` spreads that overwrite state). harness `userTurnKind` collection (B-phase) lives in `cline-session-state.ts` `classifyClineUserAttentionTool` (native Cline SDK question/plan_review) + `core/harness-user-turn-kind-collection.ts` `classifyHookUserTurnKind` (Claude Code terminal agent), wired through `hooks-api.ts` → `transitionToReview(taskId, "hook", override)` → reducer `hook.to_review` `userTurnKindOverride`, with structured `[user-turn-kind]` logs via `diagnostics/user-turn-kind-logger.ts`. **Claude ≠ Cline**: Cline (`agentId==="cline"`) is the in-process SDK; Claude Code is a *terminal* agent (`agentId==="claude"`) routed via `runtime-api.ts` `useClinePath`. `classifyHookUserTurnKind` collects three Claude kinds — `plan_review` (toolName `ExitPlanMode`), `question` (toolName `AskUserQuestion`; Stage 5), and `permission` (`PermissionRequest`/`permission_prompt`, no specific tool; B3). **Ordering is load-bearing: the toolName branch (ExitPlanMode/AskUserQuestion) is matched BEFORE the generic permission branch** — `ExitPlanMode` reaches `to_review` via BOTH a dedicated `PreToolUse` matcher (`agent-session-adapters.ts` settings.json `ExitPlanMode|AskUserQuestion`→to_review) AND the existing `PermissionRequest` `*`→to_review (the plan-approval dialog also fires PermissionRequest, per Claude hooks docs); whichever wins the `to_review` gate first decides the kind, so matching the tool name first makes the label race-proof (a permission request *for ExitPlanMode* is semantically `plan_review`). The `kanban hooks` CLI extracts `tool_name` from hook stdin into `metadata.toolName` regardless of event (`hooks.ts`). Autonomous mode (`--dangerously-skip-permissions`) suppresses PermissionRequest, so `permission` is rarely collected there; `question` stays reliable (AskUserQuestion fires PreToolUse regardless of permission mode). The Claude *log-watcher* (`commands/hook-events/claude-hook-events.ts` `startClaudeSessionWatcher`) is **test-only / no production caller** — Claude collection flows entirely through the command-hook path, not the watcher.
- 「重负载 → 整个多项目服务器进程退出（所有标签页齐刷刷 'Waiting for reconnection'）」是一条非显然的两段式因果链，别只盯崩溃现场那一层：**放大器**在 `src/fs/locked-file-system.ts` —— proper-lockfile 的 advisory 锁一旦 compromise（多因事件循环停摆错过 mtime 刷新定时器），其默认 `onCompromised` 直接 `throw`（跑在定时器回调里 → `uncaughtException`），且 compromise 后 `withLocks` 的 `finally` 里 `release()` 会以 `ERELEASED` 拒绝（第二条 `unhandledRejection`），两条都命中 `src/core/cli-process-guards.ts` 的 `installCliFatalErrorHandlers` → `process.exit(1)`，一次可恢复的锁抖动就杀掉整个 server。已加固：默认 `onCompromised` 改为「记 `[fs-lock]` warn 且不抛」（`src/fs/lock-diagnostics-logger.ts`）、`release()` 包 try/catch、`DEFAULT_LOCK_STALE_MS` 30s。**触发器**（那 ~1min 卡顿）在 `src/workspace/get-workspace-changes.ts` 的无界 per-file git 子进程 fan-out：现已 (1) numstat 批量化（`git diff --numstat -z <range>` 一次，`Promise.all(files.map(...))` 里不再 per-file spawn），(2) 跨请求共享的模块级 `p-limit` 单例 `src/workspace/git-concurrency.ts`（把任意负载下的并发 git/fs 读钳成常数），(3) 三种 diff 变体（working_copy / from_ref / between_refs）都走 stateKey 缓存，使空闲工作树上的每秒轮询坍缩为一次 fingerprint 比对命中缓存。教训：任何在事件循环线程上无界 fan-out 子进程（`uv_spawn`）或做大块同步 CPU（如 `SerializeAddon.serialize` 20k 行）的路径，都可能停摆事件循环并经上面的锁放大器升级为全服退出——上限化并发、批量化子进程、缓存空闲重算。
- `git diff --numstat -z` 的 rename 表示随 diff 类型而变，是解析 `get-workspace-changes.ts` 时的隐坑：**工作树 diff**（`git diff HEAD`，即便带 `--find-renames`）把 rename 拆成独立的「旧路径删 + 新路径增」两条记录；而**commit↔commit diff** 才配对成 pair 格式 `adds\tdels\t\0oldpath\0newpath\0`（counts 后的 inline path 为空，紧跟两条 NUL 分隔路径）；普通记录是 `adds\tdels\tpath\0`，二进制记录计数为 `-`。解析一律按 **postimage（新）路径**做 key，正好对上 name-status 的新路径条目。铁律：批量 numstat 的 refspec / renames 标志**必须与对应 name-status 调用完全一致**（只把 `--name-status` 换成 `--numstat -z`），否则两处 rename 检测方式不同、path 集合对不上。
- Kimi Code（Moonshot 原生终端 agent，`agentId==="kimi"`，二进制 `kimi` = `~/.kimi-code/bin/kimi`，npm `@moonshot-ai/kimi-code`）接入的几处非显然坑，都是读 `kimi --help` / 二进制 strings / 实机跑 TUI 才敲定的：**(1) 模板是 `codexAdapter` 不是 droid/kiro。** kimi 是全屏 TUI 且**交互模式没有位置 prompt 槽**（`-p/--prompt` 只是单发 print、跑完即退，不产生持久会话），所以任务 prompt 一律经 `PreparedAgentLaunch.deferredStartupInput` = `toBracketedPasteSubmission(prompt)`，在 TUI 就绪后由 `session-manager.ts` 注入（与 codex 同机制）。就绪信号：启动横幅 `Welcome to Kimi Code!`（`hasKimiStartupUiRendered`）+ 输入框字形 `│ >`（`hasKimiInteractivePrompt`，见 `kimi-readiness.ts`）；实测**不弹 workspace-trust**，故无需 auto-confirm 分支。开关：`-y/--yolo`（autonomous）、`--plan`、`-c/--continue`（resumeFromTrash）、`-m/--model <alias>`（别名取自 config.toml，MVP 未接 model picker）。session-manager 三处加了 kimi 分支：`resolveTuiInteractivePromptPredicate`、`isAtInteractivePromptForReaction`、deferred-input readiness 门（signal-only，无 deadline 兜底，同 codex）。**(2) hooks 是 TOML `[[hooks]]`（Claude 风格事件名 UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/Stop/StopFailure），且 kimi 只从「已解析 home」的 `config.toml` 读 hook——`KIMI_CODE_HOME` env > `~/.kimi-code`；实测 project-local `<cwd>/.kimi-code/config.toml` 的 `[[hooks]]` 不触发。** 为了让 Kanban hook 生效又不污染用户全局 `~/.kimi-code/config.toml`（用户手动 `kimi` 仍用它；且那里常有 Orca 注入的 `[[hooks]]`），`kimi-hook-config.ts` 派生一个 Kanban 托管的 seeded home（`~/.cline/kanban/hooks/kimi/code-home`）：把承载登录态的 `oauth`/`credentials`/`device_id`/`tui.toml` **软链**到真实 home（令牌轮换自动跟进），并写 `config.toml` = 用户全局 config **剔除既有 `[[hooks]]`**（`stripTomlHookTables`，保留 provider/model/`default_model`）后追加 Kanban 的 `[[hooks]]`（`kanban hooks ingest --event <kanbanEvent> --source kimi`）。启动时 `env.KIMI_CODE_HOME=seededHome` + `createHookRuntimeEnv`；一份共享 seeded home 服务所有任务，per-task 身份靠 env 携带（会话按 cwd/workspace 天然隔离）。校验用 `KIMI_CODE_HOME=<home> kimi doctor`（`OK config.toml` 即有效）。改动文件：`core/agent-catalog.ts`（catalog + launch 列表）、`core/api-contract.ts`（`runtimeAgentIdSchema` 枚举——它是唯一编译强制点，`ADAPTERS` 总量记录会逼你补 kimi）、`config/runtime-config.ts`（`normalizeAgentId` allow-list）、`terminal/agent-session-adapters.ts`（`kimiAdapter`+detector）、`terminal/session-manager.ts`（3 处 kimi 分支）、新增 `terminal/kimi-readiness.ts` + `terminal/kimi-hook-config.ts`。
- The agent terminal is a persistent xterm (`web-ui/src/terminal/persistent-terminal-manager.ts`) whose IO WebSocket stays open across browser tab switches. Browsers pause xterm's `requestAnimationFrame`/`setTimeout`-driven renderer for hidden tabs, so naive live writes pile up and "time-lapse" replay on return (minutes-long on chatty TUIs). The manager self-listens to `visibilitychange`: while hidden it skips `enqueueTerminalWrite` but still `output_ack`s (so the server never backpressure-pauses the PTY / agent) and still calls `notifyOutputText` (keeps activity detection + `waitForLikelyPrompt` alive); on return it sends a `request_restore` control message and the server (`src/terminal/ws-server.ts`) re-runs the snapshot handshake to jump straight to the latest screen. The server-side `TerminalStateMirror` stays current in real time regardless of viewer visibility, which is why the snapshot is cheap. Adding terminal WS messages means touching all of: `src/core/api-contract.ts` (zod union), `src/terminal/ws-server.ts`, and the client manager.
- **卡片左上角的时长药丸是两颗、读两个不同的字段，绝不可再合并回一颗。** 历史上这里只有一颗、读 `lastSubstantiveOutputAt` 冒充「agent 上次回复」，于是「今天重开一个七天前的会话」会把它刷成 `now`——旧对话被重播进新 TUI，而实质分类器的行签名记忆是空的，整段旧内容被判成新产出。实测 168 个可对账的 claude 任务里 **26% 显示错误**（偏差中位数 26.8 小时、p95 12.4 天；虚假推进案例 100% 都「转录被重开过」），且这个 bug 被点修过三次仍复发。根因不是分类器不够准，而是**一个字段冒充了三个量**：

  | 量 | 字段 | 会话重开时应否刷新 | 真相源 |
  | --- | --- | --- | --- |
  | 此刻在不在吐东西 | `lastSubstantiveOutputAt` | **应**（刮 TUI 的新鲜度，秒级） | TUI 实质分类器 / SDK / ACP 事件 |
  | 本轮何时停止生成（药丸 Stopped） | `agentResponseGenerationStopped` | **应**（新活体新一轮） | `mergeSummaryWithFacets` 在 turnOwner 交回 user 的**边沿**上落，与 2h 回收共用锚点 |
  | 对话上次推进（药丸 Progress） | `lastConversationProgressObservation` | **不应**（跨 incarnation 的历史事实） | 持久转录 > hook 事件 / 结构化会话事件 > TUI 分类器兜底 |

  要点：`agentResponseGenerationStopped` 是**边沿触发**（`didEnterUserTurnEndingAgentResponseGeneration`），不是「当前处于 user 回合」这个电平——写成电平的话，历史盘上每条 `awaiting_review` summary 都会被下一次任意 metadata-only 写补出一个 `stoppedAt=此刻`。`lastConversationProgressObservation` 的合并只经 `src/core/last-conversation-progress-observation.ts` 的唯一 reducer（稳态取 max 单调前进；只有持久转录能纠正**低置信**的 TUI 猜测，绝不回拉 hook/结构化事件的推进；未来时刻拒收）；转录探针见 `src/agent-session-history/persisted-agent-transcript-last-conversation-progress-probe.ts`（当前只覆盖 claude——只有它的转录能按工作目录直接寻址，codex/cursor 需全盘扫描、成本不适合周期性探测，故落到 hook 或低置信兜底并在 UI 上以 `~` 标注）。**两颗药丸都不读 `lastSubstantiveOutputAt`**，无值就隐藏，绝不回退——回退就是本 bug 原样复发。

- `lastSubstantiveOutputAt` 本身（承重件，仍在服役）**不是**从 chat log 读的，两条 agent 路径各有一套写法、坑也各不相同，改动前必须两边一起看：**(1) 终端 agent 是「刮 TUI 渲染」**——`session-manager.ts` `flushPendingOutputAnalysis` 用 `agent-output-substance.ts` 的 chrome 掩码 + 每会话行签名 LRU 把 spinner/footer 重绘剔掉。致命点是**续跑启动会把整段旧 transcript 重播进新 TUI，而签名记忆是全新的空 Set**，于是每一行都「没见过」→ 整段重播被判为实质产出、时间戳刷成「刚刚」。唯一防线是 `suppressSubstantiveOutputUntilContinues`。武装判据必须读**启动侧**的 `PreparedAgentLaunch.resumesPriorAgentConversation`（adapter 里决定加 `--continue` / `--resume <id>` / `--fork-session` 的那段代码如实置位）`|| request.resumeFromTrash`——**绝不能**用「该任务此前是否产出过」这类状态反推：崩溃后从原始 prompt 全新重跑的 auto-restart 根本没有重播，武装它会把真实新产出冻死。解除只认「用户真·继续」三处，缺一会造成某些 agent 永久冻结：`writeInput`（人工手敲）、`runTaskChatInputDeliveryAttempt` 里 `writePasteSubmissionWithConfirm` **调用点**（task-chat / RVF 程序化投递；**不可**下沉进那个 writer——连接中断自动续跑共用它，自动恢复不算用户继续）、`transitionToRunning({userInitiatedResume})`（`hooks-api.ts` 只把 UserPromptSubmit/BeforeAgent 判为 true；**Gemini 经 paste 恢复、不过 writeInput，全靠这条**）。**(2) 原生 Cline SDK 与 ACP 走各自的 `updateSummary` / `updateAcpSummary` 漏斗，两者都是「默认不推进、显式才推进」**：漏斗对 `lastSubstantiveOutputAt` 不做任何隐式推断，要推进只能由写点显式经 `withAgentSubstantiveOutputTimestamp` 声明「这一次确实带来了新的 agent 产出」。Cline 侧对应 `cline-event-adapter.ts` 的两个发射口——`emitAgentSubstantiveOutputSummary`（assistant 文本 / reasoning、工具调用与结果、agent 错误收束、裸 chunk 流）与默认的 `emitSummary`（`ended` 回合边界、re-attach 补发的 `status` 心跳、turn-cancel、纯 hook 元数据）；ACP 侧唯一的推进点是 `acp-session-update-adapter.ts` 的 `emitRunningSummary`（agent 消息 / 思考 / 工具 / plan 这些流式 `SessionUpdate`），回合完成的 stopReason（`end_turn` / `refusal` / `cancelled`）与连接关闭一律不推进——正文早已由流式事件逐条打过戳。**这个默认方向是反转过来的，别改回去**：反转前漏斗默认镜像 `lastSubstantiveOutputAt = lastOutputAt`、靠写点 opt-out，结果 `cline-task-session-service.ts` 里 9 处经漏斗的写（SDK start/send 失败、用户提交首轮 prompt、stop / safe-shutdown / abort、取消回合、用户发消息 ×2、reload）无一 opt-out，**用户自己的操作**就会把「agent 上次响应」刷成「刚刚」，safe-shutdown 那处还把污染值一路写进落盘 summary。opt-out 漏了是静默写错（不报错、不掉测试，只是卡片时间悄悄不对），opt-in 漏了只是「暂时不前进」，是保守失败。另外 Cline summary **不跨进程重启持久化**（终端侧靠 `hydrateFromRecord` 持久化，Cline 侧没有），重建后是 `null`、随后第一个心跳镜像成「刚刚」——故 `cline-message-repository.ts` `createTaskEntryFromPersistedSession` 从落盘消息回捞最后一条 assistant 的 `ts`（`MessageWithMetadata.ts`）。**(3) 承重不变量**：该字段还喂 `session-activity.ts` `isAgentActivelyProducingOutput`（Validation 列自动打回，窗口 `VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS`=5s）与 `scanForStalls` 的 idle-stall 基线。故 `SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS`（实质分类器的节流窗口）按**减法**结构性绑定成 `VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS - 1s`：必须严格小于它，否则持续产出的会话会出现虚假 >5s 空档、卡片被误判为已停。节流只作用于实质分类器；同一 flush 里的 adapter 输出转移检测与 output-reaction 扫描延迟敏感，仍留在 50ms 攒批上。
- **oh-my-pi（`omp`）是仓库里第一个「非 PTY、非 Cline SDK」的 agent：它经 ACP（Agent Client Protocol，JSON-RPC over stdio）通话。** 三种会话传输形态现由 `src/core/agent-catalog.ts` 的 `sessionTransport` 字段单点声明（`pty_terminal` / `in_process_cline_sdk` / `acp_stdio_subprocess`）——以前「是不是 Cline」的分叉散在 `runtime-api.ts` 的 `useClinePath`、`card-detail-view.tsx` 的面板分流、`persistent-terminal-manager.ts` 的续跑守卫等多处硬编码 `agentId === "cline"`，新增非 PTY agent 时极易漏改其中一处；一律改用 `isRuntimeAgentSessionRenderedAsConversationPanel` / `isRuntimeAgentSessionDrivenByAcpProtocol`。ACP 层在 `src/acp-client-session/`，1:1 对位 `src/cline-sdk/` 的三层骨架：`acp-protocol-boundary.ts`（唯一允许 import `@agentclientprotocol/sdk` 的模块）、`acp-client-connection-runtime.ts`（每任务一个子进程 + 握手 + `taskId ↔ sessionId` 双向 Map）、`acp-session-update-adapter.ts`（SessionUpdate → facet/消息，单一入口）、`acp-session-state.ts`（唯一 summary 写漏斗）、`acp-task-session-registry.ts` + `acp-task-session-service.ts`（账本与门面）、`acp-pending-user-decision-broker.ts`（等人拍板通道）。Cline 侧那三条 facet 铁律逐字适用（绝不裸写单个 `userTurnKind`、entry 构造必过 `applySessionFacets`、只推存活度的事件必须显式带当前实质戳）；**唯一的差别是 pid**：ACP agent 是真子进程，`deriveAcpFacetPatch` 要如实传 pid（不像 Cline 写死 null），于是 `session-activity.ts` 既有的 `pid !== null ? live : exited` 判定自动正确，进程崩了卡片会如实显示 exited。推流复用了 hub 里泛化出来的 `trackConversationTaskSessionService`（Cline 与 ACP 共用同一段 summary 批量广播 + 等人回合边沿通知 + 聊天消息转发，按 `${workspaceId}::${sourceKind}` 复合键登记订阅，二者不会互相顶掉）。
- **接 omp 的 ACP 时最容易踩的三个坑**（都不是靠读文档能发现的）：**(1) `clientCapabilities.elicitation.form` 缺失 ⇒ omp 会静默自动批准 plan**（`acp-agent.ts` 的 `#requestAcpPlanApprovalChoice`：没有确认界面就直接放行，否则 plan 模式会卡死 agent）。这是**安全语义差异不是 UI 缺失**——表现为「plan 模式一切正常但从不征求你同意」，`buildKanbanAcpClientCapabilities()` 因此必须声明它（注意类型是 `form: {}` 而非 `form: true`）。**(2) 发出 `session/cancel` 之后必须把所有 pending 的 `session/request_permission` 用 `{outcome:"cancelled"}` 回掉**，否则 agent 侧永远挂着等回复；`AcpPendingUserDecisionBroker.cancelPendingDecisions` 就是干这个的，`cancelTaskTurn`/`abortTaskSession`/连接关闭三处都要调。**(3) omp 把 provider 层错误当成普通 `agent_message_chunk` 正文发出来、`stopReason` 仍是 `end_turn`**（实测：AWS SSO 过期、OpenRouter 余额不足都是这样），协议层区分不出「真回答」与「凭据失效」，所以别指望用 stopReason 判失败。另：omp 的 `current_mode_update` 发的字段是 `currentModeId`（规范示例里写的是 `modeId`，两者都要兜）；`tool_call_update` 的 `content`/`locations` 是**整体替换**不是追加；plan 每次都是全量列表。协议冒烟脚本在 `scripts/acp-protocol-smoke.ts`（`npx tsx scripts/acp-protocol-smoke.ts`，需要 `omp` 在 PATH 且已登录）。
- **「plan 起步」与「权限档位」是两条正交轴，不是一条。** per-task 的 `taskAgentPermissionMode`（`ask_for_every_tool_use` / `auto_approve_file_edits_only` / `bypass_all_permission_prompts`，默认 bypass，域逻辑在 `src/core/task-agent-permission-mode.ts`）取代了旧的全局 `agentAutonomousModeEnabled` 对会话启动的作用（那个开关如今只决定「新任务的默认档位」）；`startInPlanMode` 保留，语义收窄为「开局先只读规划」，**不得再被翻译成降权**。Claude Code 早就是这么做的（plan 起步时剔掉 `--dangerously-skip-permissions` 但补上 `--allow-dangerously-skip-permissions` 预授权后续升档，见 `applyClaudePermissionAndPlanModeArgs`——它必须统一决策，因为 claude 的两条轴都落在同一个 `--permission-mode` 旗标上，分两处推会产生互相打架的重复旗标）。实测 `cursor-agent --plan --force` 可并存，kimi 的 `--plan`/`--yolo` 亦然。**两个刻意的例外必须在 UI 明示、不得静默**：droid 的 `autonomyMode` 是单轴（spec/normal/auto-high），plan 起步会吃掉权限档（`doesPlanModeStartOverridePermissionModeForAgent`）；原生 Cline SDK 的 `requestToolApproval` 目前恒批准，只能表达 bypass 一档，选更严的档位会被如实报告为 degraded（后续项：把它接到与 ACP 同一条决策通道上，届时从 `AGENT_IDS_THAT_CAN_ONLY_BYPASS` 移除即可）。降级方向的铁律是**只收紧不放宽**——不能表达中间档的 harness 回落到「每次询问」，绝不回落成全放行。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **cline-kanban** (11964 symbols, 31422 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/cline-kanban/context` | Codebase overview, check index freshness |
| `gitnexus://repo/cline-kanban/clusters` | All functional areas |
| `gitnexus://repo/cline-kanban/processes` | All execution flows |
| `gitnexus://repo/cline-kanban/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
