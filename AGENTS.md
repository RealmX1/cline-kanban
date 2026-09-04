# AGENTS.md

本文件是仓库的 agent 上下文 canonical kernel——所有 harness 的单一真相源（Claude Code 经根 `CLAUDE.md` 的 `@AGENTS.md` 导入获得本文；不要把内容复制到第二份文件，双副本必漂移）。**仓库文档以中文为主要语言**（技术标识符、路径、命令保持英文原文）。

## 何时添加 / 不添加

添加（主动建议，别等被问）：用户不得不介入/纠正/手把手带过；多次往返才跑通；需读很多文件才理解的发现；改动牵涉意想不到的文件；行为与预期不符；用户明确要求。
不添加：读几个文件就能搞清楚的、显而易见的模式、标准实践。

归层规则：本文件只放**每会话都需要的承重规则 + 指针**，每条 1-3 行。post-mortem / 集成日志 / runbook 全文进 `docs/`（见文末指针表）；多步流程进 skill；必须恒成立的规则做成 hook/lint 而不是散文。维护方法论见 `docs/agent-context-management.md`。

---

RVF entry: Post-Deploy Verification authoring

RVF-ENTRY-SKILL: cline-kanban-post-deploy-verification-authoring

RVF-PRE-REVIEW-BASE-SYNC-SKILL: sync-local-base-into-task-worktree-only

- kanban 任务收尾 / 宣告完成 / 进入 review 前，**必须先调用 skill `cline-kanban-post-deploy-verification-authoring`**：把只有部署后真实实例才验得到的断言注册成验证；fix 改变了可观察行为则以 **reconcile 模式**幂等重注册，不堆叠重复。
- 上面两行是 **repo-通用机器可发现约定**。`RVF-PRE-REVIEW-BASE-SYNC-SKILL:` 从 local base 的 AGENTS.md 读取：旧 task worktree 先做严格单向同步再准备 RVF，不得反向写回 base。

---

## 仓库形态与命令

一个 git 仓里**三个互相独立的 npm 项目**（各有 package.json / tsconfig / vitest 配置）：运行时（根 `src/`）、Web UI（`web-ui/`）、Electron 壳（`packages/desktop/`）。根 vitest 排除 `packages/**` 与 `web-ui/**`——**在 `packages/` 下新增 workspace 时必须给 `.github/workflows/test.yml` 补 install/test 步骤**，否则悄悄掉出 CI。Node `engines >= 22`，但 CI 矩阵跑 20+22：涉及新 Node API 时以 20 为下限验证。

```bash
npm run dev:full         # 首选：运行时 watch + Vite 同开，自动挑空闲端口
npm run web:dev          # 仅 Vite（4173，/api 代理到 3484）——改 UI 用这个地址才有 HMR
npm run check            # biome + typecheck + test（根项目全套）
npm run web:typecheck    # web-ui 是独立 tsconfig，根 typecheck 覆盖不到——两个都要跑
npm run build && npm run dogfood -- --project <repo> --port auto   # 验证打包态（非源码态）行为
```

- `npm test` 是 `test:guarded`（`test:policy` AST 静态策略 + invoking-repository mutation canary），**不要直接 `npx vitest`**——那会绕过策略与 canary。两个 project：`precommit-safe`（`test/**/*.test.ts`）与 `runtime-integration`（`*.integration.test.ts`，串行单 worker）。单文件：`npm run test:guarded -- --project precommit-safe <file>`。web-ui 是另一套 vitest（jsdom、测试与源码同目录）：`npm run web:test`；e2e 用 Playwright：`npm --prefix web-ui run e2e`。桌面壳：`npm --prefix packages/desktop run typecheck|test`。
- 真实 git 测试只能经 `test/git-repository-mutation-safety/isolated-git-test-workspace-fixture.ts` 操作仓库（细则见 `test/README.md`）。
- pre-commit（husky）顺序：`biome check --staged` → `npm run typecheck` → `npm run test:precommit`。

## 架构 orientation（读单个文件看不出来的部分）

- **三层职责**：浏览器是控制面；本地运行时是长驻唯一真相源；执行层才是 agent 本体。session/board 摘要状态**不靠浏览器轮询**——`src/server/runtime-state-hub.ts` 批量广播 → `use-runtime-state-stream.ts` → `App.tsx`，加 summary 字段只改契约即可搭车。但 **workspace diff 仍是定时轮询**，别假设它在推流链路上。
- **三种 session transport** 由 `src/core/agent-catalog.ts` 的 `sessionTransport` 声明各 agent 的默认通道（agent 名单以该文件为准）：`pty_terminal` → `src/terminal/`；`in_process_cline_sdk`（Cline）→ `src/cline-sdk/`；`acp_stdio_subprocess`（oh-my-pi）→ `src/acp-client-session/`。omp 的 catalog 默认通道仍是 PTY TUI，ACP 只是它运行时可切换的第二通道（未带 transport 的 omp summary 按 `pty_terminal` 解析），切换集合与启动通道解析见 `src/core/agent-session-transport-selection.ts`。分支判定一律用能力谓词（`isRuntimeAgentSessionRenderedAsConversationPanel` / `isRuntimeAgentSessionDrivenByAcpProtocol`），**不要新写 `agentId === "cline"` 硬编码**——历史上这种硬编码散落多处，新增非 PTY agent 时必漏改其一。
- **契约双点**：zod schema 主来源在 `src/core/api-contract.ts`；procedure 层契约（有哪些 procedure、input/output 绑定、就地派生的输入 schema）在 `src/trpc/app-router.ts`——新增/改 procedure 两处都要看。web-ui 直接 import 运行时源码：纯类型引用加 `web-ui/tsconfig.json` 即可；**有值引用必须三处同步**（tsconfig + vite.config + vitest.config），漏一处就是「类型过了但运行/测试解析失败」。
- **前端**：`web-ui/src/App.tsx` 是组合根（别让它长成第二个运行时编排器）；「这个行为怎么实现的」先查 `web-ui/src/hooks/`，别从组件翻起。
- **lint 强制的边界**（biome + `grit/*.grit`，各条 includes 作用域外仍只是约定）：`@clinebot/*` 直引限制（override 排除 `src/cline-sdk/**` 且只拦 `@clinebot/core`——目录内靠自觉，已有直引反例）；`createWorkspaceTrpcClient` 仅限 `web-ui/src/runtime/*-query.ts`；`src/`（除 `cli.ts`）禁 `console.*` 与 `process.exit`；禁解构 `process.env`。格式：tab 缩进、indentWidth 3、lineWidth 120。

## 铁律（每条都踩出过事故；细节见指针，此处只放承重规则）

- **facet 模型**：`turnOwner` / `liveness` / `userTurnKind` 三 facet 是写时主真相，legacy `state` 是纯派生投影。① 绝不手写 `state:` 进 summary patch（一切写入走三个 `updateSummary` 漏斗）；② 每次 facet 写入必须是完整三元组（残缺的会在广播/持久化边界的 Zod superRefine 炸开）；③ 消费者经 `resolveSessionFacets` 读 facet，决策**绝不**读 `summary.state`。全文：`docs/session-facet-model.md`。
- **模态待答判据**集中在 `session-activity.ts` 的 `MODAL_USER_DECISION_TURN_KINDS`：有意只收 question / plan_review / permission / needs_input，**绝不含 `review`**——review 是程序化投递的目标态，算进去 = 每次投递让位、永不落地。
- **卡片两颗时长药丸读两个不同字段，绝不可再合并**：`agentResponseGenerationStopped`（本轮何时停止生成，边沿触发）与 `lastConversationProgressObservation`（对话上次推进，跨 incarnation 的历史事实，单调 reducer）。会话重开时前者刷新、后者不刷；两者都不读 `lastSubstantiveOutputAt`，无值就隐藏，绝不回退。26% 误显示取证与全文：`docs/agent-output-timestamps.md`。
- **`lastSubstantiveOutputAt` 是「默认不推进、显式才推进」**：终端侧唯一防线是 `suppressSubstantiveOutputUntilContinues`（武装判据只读启动侧 `resumesPriorAgentConversation || resumeFromTrash || resumePriorAgentConversationWithoutResendingPrompt`，绝不用「此前是否产出过」反推；解除只认三处「用户真·继续」）；Cline/ACP 漏斗要推进必须显式 `withAgentSubstantiveOutputTimestamp`。全文同上。
- **plan 起步与权限档位是两条正交轴**：`startInPlanMode` 不得翻译成降权；harness 表达不了中间档时**只收紧不放宽**（回落「每次询问」，绝不回落全放行）。rationale：`docs/adr/0002-plan-mode-permission-mode-orthogonal.md`。
- **BoardCard 有两条平行宿主链**（主看板 `board-column.tsx` + Focus View `column-context-panel.tsx`）：新增/改 per-card action 必须两边 gating 同步，否则按钮渲染了却什么都不做（已发 bug）。细节：`docs/architecture.md` 的 BoardCard 小节。
- **终端 agent 检测/启动别走交互 shell**（`zsh -i`、shell fallback 命令发现等）：重 shell init（conda/nvm）下每任务一次会冻结运行时。显式 shell 终端例外。
- **headless 远端**（SSH+tunnel）没有 zenity/kdialog：folder picker 用手动路径兜底，别引桌面包。
- Node 22 CI 挂起：先查活体子进程 / SDK-host 启动路径，别先假设测试慢。调查史：`.plan/docs/node22-ci-hanging-tests-investigation.md`。
- **Exploratory Mode（session map / findings）已落地 M0+M1**：turn 编号权威在 `src/conversation-tree/conversation-turn-projection.ts`（web-ui 复用其同源边界分类器，两侧不得各自改写）；map 唯一写点是 apply 漏斗 `src/state/exploratory-session-map-apply-funnel.ts`（四道闸任一失败整体丢弃，agent 经 `kanban exploratory` CLI 走 `ingestSessionMapUpdate`，绝不另开写路径）；投影查询与写回校验共用同一条加载链 `src/conversation-tree/load-conversation-session-turn-projection.ts`。改锚点 / map / 投影行为前先读蓝图 `.plan/docs/exploratory-mode-session-map-and-findings-store.md` 与 `docs/exploratory-mode-session-map.md`。

## 约定

TypeScript：
- No any unless absolutely necessary；外部 API 类型查 node_modules 而非猜；优先用 SDK 提供的类型/schema/helper，别本地重定义。
- NEVER inline imports（无 `await import("./foo.js")`、无类型位 `import("pkg").Type`、无动态 import 类型）。
- NEVER 为过时的依赖删改/降级代码来消类型错误——升级依赖。

Git / GitHub：
- NEVER commit unless user asks。
- 读 issue 必读全部 comments：`gh issue view <number> --json title,body,comments,labels,state`；关 issue 在 commit message 里写 `fixes #<number>` / `closes #<number>`。

架构意见：
- 避免只转发 props / 搬移 JSX 的薄壳封装；优先抽领域逻辑（state、effects、async 编排）。
- 凡标识符的含义由外部系统在运行时解析且随上游漂移（`latest` 别名、浮动 ref），**不得把当前解析结果固化进标签/常量/文案**——要么呈现别名本身，要么钉死具体版本。
- 加自定义工具代码前，先评估维护良好的第三方包能否替代。

web-ui：
- 栈：Tailwind CSS v4 + Radix UI + lucide-react。**不要 Blueprint**，不要 `dark:` 前缀（主题恒暗）。本地 hook 优先 `react-use`（`@/utils/react-use`）。
- 样式以 Tailwind utility + `cn()` 为主，inline style 只给真动态值。设计 tokens 以 `web-ui/src/styles/globals.css` 的 `@theme` 为准（勿在文档里抄十六进制快照）。
- UI primitives 在 `web-ui/src/components/ui/`（button/dialog/tooltip/kbd/spinner/cn 等），用前先查目录现状；toast 用 `sonner` 或 `showAppToast`。

## 参考文档

| 文档 | 内容 |
| --- | --- |
| `installation.md` | 安装单一出处（前置要求 / 三项目依赖 / 全局 link / 卸载） |
| `docs/architecture.md` | 系统图、运行时模式、所有权表、BoardCard 双宿主小节 |
| `DEVELOPMENT.md` | dev/dogfood 工作流、tmux 长驻约定、hook 事件→状态迁移映射 |
| `test/README.md` | 测试执行形态与 git 安全契约 |
| `docs/cli-environment.md` | CLI/hook 环境变量 |
| `docs/agent-context-management.md` | 上下文管理方法论（本文件的维护规则由此而来） |
| `docs/session-facet-model.md` / `docs/agent-output-timestamps.md` | facet 模型与双时间戳机制全文 |
| `docs/exploratory-mode-session-map.md` | Exploratory Mode M0+M1 集成要点（投影层 / apply 漏斗 / CLI 写回 / 维护 observer / 锚 marker 铁律） |
| `docs/terminal-io.md` | output-reactions、终端 visibility 协议、PTY/argv 特殊字符安全 |
| `docs/agent-harness-kimi.md` / `docs/agent-harness-omp-acp.md` | Kimi 与 oh-my-pi(ACP) 接入坑 |
| `docs/runbooks/` | 跨层改动 runbook（summary 字段/设置开关、agent CLI 能力探测） |
| `docs/adr/` / `docs/post-mortems/` | 决策记录与事故复盘 |
| `.plan/docs/` | 活跃计划与大型重构历史（非上手必读） |
