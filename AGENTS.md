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

一个 git 仓里**三个互相独立的 npm 项目**（各有 package.json / tsconfig / vitest 配置）：运行时（根 `src/`）、Web UI（`web-ui/`）、Electron 壳（`packages/desktop/`）。根 vitest 排除 `packages/**` 与 `web-ui/**`——**在 `packages/` 下新增 workspace 时必须给 `.github/workflows/test.yml` 补 install/test 步骤**，否则悄悄掉出 CI。Node 支持下限就是 `engines >= 22`（CI 跑 ubuntu + macOS 的 Node 22）：涉及新 Node API 时以 22 为下限验证。

```bash
npm run dev:full         # 首选：运行时 watch + Vite 同开，自动挑空闲端口
npm run web:dev          # 仅 Vite（4173，/api 代理到 3484）——改 UI 用这个地址才有 HMR
npm run check            # biome + typecheck + test（根项目全套）
npm run web:typecheck    # web-ui 是独立 tsconfig，根 typecheck 覆盖不到——两个都要跑
npm run build && npm run dogfood -- --project <repo> --port auto   # 验证打包态（非源码态）行为
```

- `npm test` 是 `test:guarded`（`test:policy` AST 静态策略 + invoking-repository mutation canary），**不要直接 `npx vitest`**——那会绕过策略与 canary。两个 project：`precommit-safe`（`test/**/*.test.ts`）与 `runtime-integration`（`*.integration.test.ts`，串行单 worker）。单文件：`npm run test:guarded -- --project precommit-safe <file>`。web-ui 是另一套 vitest（jsdom、测试与源码同目录）：`npm run web:test`；e2e 用 Playwright：`npm --prefix web-ui run e2e`。桌面壳：`npm --prefix packages/desktop run typecheck|test`。
- **验证构建前先检查 `dist` 与 `web-ui/dist` 的 realpath**：任务 worktree 可能把它们软链到主仓库共享产物。必须先隔离两处输出，并显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`；不能把更新共享产物当成普通验证构建。
- 真实 git 测试只能经 `test/git-repository-mutation-safety/isolated-git-test-workspace-fixture.ts` 操作仓库（细则见 `test/README.md`）。
- 计时 / 资源阈值断言（等子进程退出、性能绊线、RSS 上限）按 `test/README.md`「负载敏感的墙钟 / 资源断言」分类：测试侧等待用两档（软档只告警、硬档才失败），并闭合用例与 hook 超时；**不要**用宿主 CPU 争用信号放过失败（实测不可靠）。
- pre-commit（husky）顺序：`biome check --staged` → `npm run typecheck` → `npm run test:precommit`。

## 架构 orientation（读单个文件看不出来的部分）

- **三层职责**：浏览器是控制面；本地运行时是长驻唯一真相源；执行层才是 agent 本体。session/board 摘要状态**不靠浏览器轮询**——`src/server/runtime-state-hub.ts` 批量广播 → `use-runtime-state-stream.ts` → `App.tsx`，加 summary 字段只改契约即可搭车。但 **workspace diff 仍是定时轮询**，别假设它在推流链路上。
- **三种 session transport** 由 `src/core/agent-catalog.ts` 的 `sessionTransport` 声明各 agent 的默认通道（agent 名单以该文件为准）：`pty_terminal` → `src/terminal/`；`in_process_cline_sdk`（Cline）→ `src/cline-sdk/`；`acp_stdio_subprocess`（oh-my-pi）→ `src/acp-client-session/`。omp 的 catalog 默认通道仍是 PTY TUI，ACP 只是它运行时可切换的第二通道（未带 transport 的 omp summary 按 `pty_terminal` 解析），切换集合与启动通道解析见 `src/core/agent-session-transport-selection.ts`。分支判定一律用能力谓词（`isRuntimeAgentSessionRenderedAsConversationPanel` / `isRuntimeAgentSessionDrivenByAcpProtocol`），**不要新写 `agentId === "cline"` 硬编码**——历史上这种硬编码散落多处，新增非 PTY agent 时必漏改其一。
- **Cline agent 已停止维护**（2026-10-03 用户声明：用户不使用 Cline）：范围是 `agentId: "cline"` 的 `in_process_cline_sdk` 通道、`src/cline-sdk/`，以及只服务 Cline 的设置与账号（`use-runtime-settings-cline-*` 等）。现有功能和未来新功能**都不需要**再适配 Cline，Cline 专属缺陷也不修；将来会考虑连同其适配代码一并移除。在移除之前，编译与现有测试仍须通过，只做让它们继续通过的最小改动。名字带 cline、但 ACP（omp）也在用的会话面板与能力谓词（`ClineAgentChatPanel`、`cline-chat-*` 组件、`isRuntimeAgentSessionRenderedAsConversationPanel`）**不在此列**，照常维护。
- **契约双点**：zod schema 主来源在 `src/core/api-contract.ts`；procedure 层契约（有哪些 procedure、input/output 绑定、就地派生的输入 schema）在 `src/trpc/app-router.ts`——新增/改 procedure 两处都要看。web-ui 直接 import 运行时源码：纯类型引用加 `web-ui/tsconfig.json` 即可；**有值引用必须三处同步**（tsconfig + vite.config + vitest.config），漏一处就是「类型过了但运行/测试解析失败」。
- **前端**：`web-ui/src/App.tsx` 是组合根（别让它长成第二个运行时编排器）；「这个行为怎么实现的」先查 `web-ui/src/hooks/`，别从组件翻起。
- **lint 强制的边界**（biome + `grit/*.grit`，各条 includes 作用域外仍只是约定）：`@clinebot/*` 直引限制（override 排除 `src/cline-sdk/**` 且只拦 `@clinebot/core`——目录内靠自觉，已有直引反例）；`createWorkspaceTrpcClient` 仅限 `web-ui/src/runtime/*-query.ts`；`src/`（除 `cli.ts`）禁 `console.*` 与 `process.exit`；禁解构 `process.env`；`src/commands/**` 禁直写 board/sessions（`mutateWorkspaceState` 等）、禁 import 关系账本模块、禁写 PDV `verifiedAt`——CLI 写动词一律走 runtime procedure，否则关系账本记不到行动者（dd2db 1a）。格式：tab 缩进、indentWidth 3、lineWidth 120。

## 铁律（每条都踩出过事故；细节见指针，此处只放承重规则）

- **facet 模型**：`turnOwner` / `liveness` / `userTurnKind` 三 facet 是写时主真相，legacy `state` 是纯派生投影。① 绝不手写 `state:` 进 summary patch（一切写入走三个 `updateSummary` 漏斗）；② 每次 facet 写入必须是完整三元组（残缺的会在广播/持久化边界的 Zod superRefine 炸开）；③ 消费者经 `resolveSessionFacets` 读 facet，决策**绝不**读 `summary.state`。全文：`docs/session-facet-model.md`。
- **模态待答判据**集中在 `session-activity.ts` 的 `MODAL_USER_DECISION_TURN_KINDS`：有意只收 question / plan_review / permission / needs_input，**绝不含 `review`**——review 是程序化投递的目标态，算进去 = 每次投递让位、永不落地。
- **卡片历史时间与进程待命时间分开**：药丸只读 `lastAgentConversationUserHandoffObservation` / `lastEffectiveAgentConversationActivityObservation`；恢复进程不刷新历史交棒。`currentAgentProcessUserTurnIdleRetentionStarted` 只驱动本代回收，旧四字段仅兼容读，缺可信历史就隐藏。全文：`docs/agent-output-timestamps.md`。
- **有效活动必须有会话归属与语义证据**：前置提交 hook、Enter、PTY 重绘不证明接受；原生用户记录或可关联协议处理事件确认后才推进接受边沿。各独立会话各记活动，卡片与默认排序只取当前主绑定；缓存继续用专用请求参考，Cursor 新内容仅作显式估计。全文同上。
- **RVF 收尾确认超时后的迟到接受须显式补证**：保留原失败账本，以精确正文与本代活动分支核验恢复资格；`task_started` 或压缩活动不能代替接受证据。恢复入口、首次超时的保留边界及案例见 `docs/runbooks/rvf-late-native-closeout-prompt-acceptance-recovery.md`。
- **Post-Deploy Verification 的结案判据只在服务端**（`src/deployment/post-deploy-verification-done-entry-gate.ts`）：所有进 Done 的入口都走 `taskCardAction.moveTaskCardIntoDone…` 的门禁（整板 saveState 另有兜底改回原列），受门禁的卡未勾项必须逐项带原因；带原因结案**不是**「PDV 通过」（不写 `verifiedAt`，账本另记事件）。判据键必须带 workspaceId。全文：`docs/post-deploy-verification.md`。
- **plan 起步与权限档位是两条正交轴**：`startInPlanMode` 不得翻译成降权；harness 表达不了中间档时**只收紧不放宽**（回落「每次询问」，绝不回落全放行）。rationale：`docs/adr/0002-plan-mode-permission-mode-orthogonal.md`。
- **BoardCard 有两条平行宿主链**（主看板 `board-column.tsx` + Focus View `column-context-panel.tsx`）：新增/改 per-card action 必须两边 gating 同步，否则按钮渲染了却什么都不做（已发 bug）。卡片上的关系**徽标与横幅**（dd2db 阶段 2 起）同此规则。细节：`docs/architecture.md` 的 BoardCard 小节。
- **Done 卡复用完整工作台但禁止执行**：历史 query 不启动 agent 或创建工作树；Findings 与 Prompts 的会话归属不能依赖实时聊天投影或仅按卡片 ID 判断。执行入口及历史来源见 `docs/done-task-read-only-workbench.md`。
- **工作单元间关系账本只追加、不可撤销**（dd2db，`src/inter-work-unit-relation-ledger/`，库在 `~/.cline/kanban/inter-work-unit-relation-ledger/`）：验证关系相关的 UI / CLI 只用 HOME 隔离的实例（`dev:full` 默认已隔离账本），绝不对真实 HOME 的 runtime 造数据——写进去的事件删不掉，只能追加补偿。记录型关系是读时从事件推出的投影，改投影规则要升 `RECORDED_INTER_WORK_UNIT_RELATION_PROJECTION_TABLE_VERSION`。
- **查卡恢复必须按执行归属判断**：其他实例启动不等于本轮查询经历重启；只收口归属已退出的轮次，心跳不可读时保留未知态。持久图片与文本协议适配见 `docs/architecture/task-lookup-query-execution-ownership-and-persistent-prompt-images.md`。
- **手机 Focus View 的三处展开必须独立**：上方导航与工具、Task Card 详情、下方按键栏只共享单一闲置收起通知，手动展开互不联动；滚轮按钮经 xterm 滚轮入口驱动当前会话，阅读模式滚当前文档。所有权、Chrome 合成事件兼容与验证见 `docs/mobile-focus-view-collapsible-controls-and-mouse-wheel-scrolling.md`。
- **后台启动终端的估算尺寸须匹配响应式布局**：手机终端使用整页宽度，不能扣掉桌面并排 diff 的宽度；否则 Codex 可能以 1–3 列启动，首条提示词一直等到打开详情后才投递。证据与验收见 `docs/post-mortems/codex-mobile-background-startup-terminal-width-2026-10-19.md`。
- **Focus View 的 stage 卡头也有两份渲染**：行内卡头 + `StageHeaderRails` 钉住的孪生卡头（不透明 overlay，钉住时盖住行内卡头）。卡头上的状态与交互必须两边都接（孪生卡头曾写死「已展开」、折不动，两次被报）；跳到某 stage 不能用 `scrollIntoView({block:"start"})`（落点正在 rail 之下），rail 条目几何与滚动落点的单一真源是 `stage-header-rail-geometry.ts`。
- **隐式续跑的 cwd-latest 必须保持任务目录范围**：Codex `resume/fork --last` 的隔离配置放在子命令后；显式 ID 的跨目录复用保留。不能用「切换执行 cwd」代替「重新选会话」。原生回归、OMP 例外与后备方案见 `docs/runbooks/agent-conversation-resume-working-directory-isolation.md`。
- **Claude `/background`，或在空输入框按 ←（agent view 手势，改不了键但可在 `/config` 关掉「← opens agents」，kanban 里多为误触），会把对话搬进 Claude 自己的守护进程**，之后按 id 续跑会被拒绝并秒退。续跑前预检 `claude-code-background-session-ownership-preflight-before-resume.ts` 负责处理：后台会话 idle 且输入框为空时才自动收回，否则拒绝，并盯梢等待或交给终端面板一键接管。注意 Claude 报的 `idle` 不排除外部编辑器 / 未提交草稿；`claude agents --json` 还会列出退役后台任务的残留（无 `pid`），不算占用。守护进程的 env 继承自第一个拉起它的进程（已实测），所以 `/bg` 出去的会话，hook 可能报到别的任务上（未修）。全文：`docs/post-mortems/claude-code-background-session-resume-refusal-2026-10-07.md`。
- **终端 agent 检测/启动别走交互 shell**（`zsh -i`、shell fallback 命令发现等）：重 shell init（conda/nvm）下每任务一次会冻结运行时。显式 shell 终端例外。
- **headless 远端**（SSH+tunnel）没有 zenity/kdialog：folder picker 用手动路径兜底，别引桌面包。
- Node 22 CI 挂起：先查活体子进程 / SDK-host 启动路径，别先假设测试慢。调查史：`.plan/docs/node22-ci-hanging-tests-investigation.md`。
- **Exploratory Mode：findings 已落地（M2）；session map 已退役，会话结构改由独立包 `agent-conversation-exploration-thread-graph`（`~/Documents/GitHub/` 同名仓库，经 `github:` 依赖引入）建模，本仓库只做宿主胶水**：turn 编号权威在 `src/conversation-tree/conversation-turn-projection.ts`（web-ui 复用其同源边界分类器，两侧不得各自改写；PTY 会话的 turn 序列来源是核心包的 transcript 投影，两者不混）；findings 唯一写点是 `src/trpc/exploratory-api.ts` 的六个 procedure（UI 保存/确认/拒绝/归档 + agent 的 `ingest-finding-candidate`，全落 `src/state/exploratory-findings-store.ts` 的 mutate 原语；pending 建议确认前不是资产，reject = 物理删除）；终端 agent 原生会话身份只认 hook stdin 的 `session_id` 或 kanban 在 spawn 前分配并落盘的 id（Cursor：`--resume <新 UUID>` 开局；能力见 catalog `nativeConversationSessionIdentityCaptureMethod`）（summary sidecar `agentNativeConversationSessionIdentity`，绝不从路径反推；唯一例外是 Cursor 存量的「桶内唯一对话」回填，见 `docs/agent-harness-cursor.md` §6）；fork 作业要逐字复用的启动参数（model 字面值 / append-system-prompt 全文 / settings 路径）在**启动那一刻**快照进 summary sidecar `agentSessionForkReplayLaunchArguments`，**绝不在触发时重算**——重算拿到的是当前代码算出来的值，不是这个会话实际在跑的值（「逐字一致才命中 prompt cache」那条原立论已被实测证伪，fork 当前恒不命中，成因与成本见 `docs/exploratory-mode-host-integration.md` §3b）；维护作业的触发闸在 `src/exploration-thread-graph/`（模式 / 防抖 / 单飞 / 节流四道，**每一道都是成本闸**——fork 恒不命中 cache，重型会话一次 ≈ $4.5（446k opus 实测；跨 harness 对照与复现方法见 `docs/agent-session-fork-prompt-cache-measurements.md`，**轻量会话上测会得出「已修复」的假结论**）；账本按 **workspace+exploration 联合计账**，只用 taskId 会因跨 project 撞号而**少跑**；Stop 边沿的 turn 源必须 `treatFinalTurnAsCompleted: true`，否则每次少判一个 turn）；作业分身 env `AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1` 时 `kanban hooks` 整体短路 + PreToolUse deny；**不要为 thread graph 在本仓库重建 store / 漏斗 / 作业**。改 findings / 投影 / 胶水前先读 `docs/exploratory-mode-host-integration.md`。

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
| `docs/rvf-automatic-rewind-and-closeout.md` | Codex RVF 开审分界、默认自动恢复与收尾投递、跨仓完成凭据及重启边界 |
| `src/codex-native-session-control-host/` | 每代 Codex TUI 的独享控制宿主；端点随 summary/adoption record 接管，退出资源由 PTY 内监督进程持有 |
| `docs/task-collaboration-sessions.md` | Sessions 角色、跨 agent 协作会话、独立启动快照与恢复边界 |
| `docs/task-initial-prompt-structured-markup.md` | 任务起草的来源与阶段标签、实际默认设置选择、共享指导注入及历史兼容边界 |
| `DEVELOPMENT.md` | dev/dogfood 工作流、tmux 长驻约定、hook 事件→状态迁移映射 |
| `test/README.md` | 测试执行形态与 git 安全契约 |
| `docs/cli-environment.md` | CLI/hook 环境变量 |
| `docs/codex-conversation-storage-isolation.md` | Codex 独立存储、旧目录绑定、整族停写门禁、历史迁移与回退及 App Recents 待验边界 |
| `docs/agent-context-management.md` | 上下文管理方法论（本文件的维护规则由此而来） |
| `docs/session-facet-model.md` / `docs/agent-output-timestamps.md` | facet 模型与双时间戳机制全文 |
| `docs/exploratory-mode-host-integration.md` | Exploratory Mode 集成要点（投影层 / 指令注入 / N0a 身份 sidecar / 作业 hook 短路 / findings 链路 / 与核心包的契约指针） |
| `docs/post-deploy-verification.md` / `docs/post-deploy-verification-natural-usage-observation-pipeline-design.md` | PDV 现行机制（三区归属、门禁、原因码、待观察记录）与「自然使用中多模态判定」pipeline 设计稿 |
| `docs/agent-session-fork-prompt-cache-measurements.md` | 五家 harness 的 fork prompt cache 实测（谁能命中、遥测陷阱、复现成本） |
| `docs/post-mortems/codex-memory-consolidation-hook-overwrites-resume-identity-2026-10-20.md` | Codex 后台记忆整理 hook 的整事件隔离、原生转录续接预检与坏身份现场恢复 |
| `docs/terminal-io.md` | output-reactions、终端 visibility 协议、PTY/argv 特殊字符安全 |
| `docs/prompt-library-agent-input-focus-handoff.md` | Prompt / Command 显式填入的同步聚焦、手机页签交接与来源条目点击稳定性 |
| `docs/agent-harness-kimi.md` / `docs/agent-harness-omp-acp.md` / `docs/agent-harness-cursor.md` | Kimi、oh-my-pi(ACP) 与 Cursor 接入坑（Cursor：chat store 布局、trust、启动前分配 id、续跑预检） |
| `docs/post-mortems/native-session-identity-rewind-resume-2026-09-24.md` | Rewind 原生 ID 追踪、Codex 配置层丢 hook、Kimi/OMP 恢复与跨重启验证 |
| `docs/post-mortems/codex-request-user-input-recovery-and-history-2026-10-17.md` | Codex 原生问答 envelope、分页恢复链、真实答案与 aborted 区分、恢复答题与历史去重 |
| `docs/runbooks/` | 跨层改动 runbook（summary 字段/设置开关、agent CLI 能力探测） |
| `docs/adr/` / `docs/post-mortems/` | 决策记录与事故复盘 |
| `.plan/docs/` | 活跃计划与大型重构历史（非上手必读） |
