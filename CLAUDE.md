# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库形态

一个 git 仓库里有 **三个互相独立的 npm 项目**，各有自己的 `package.json`、`tsconfig`、vitest 配置，必须分别安装与校验：

| 项目 | 位置 | 内容 |
| --- | --- | --- |
| 运行时（CLI + 本地服务器） | `/` → `src/` | Node 运行时、TRPC 服务器、三条 agent 通道、`kanban` CLI |
| Web UI | `web-ui/` | React 18 + Vite + Tailwind v4 的浏览器控制面 |
| 桌面壳 | `packages/desktop/` | Electron 包装 |

根 `vitest.config.ts` 显式排除 `packages/**` 与 `web-ui/**`。**在 `packages/` 下新增 workspace 时必须同步给 `.github/workflows/test.yml` 补 install/test 步骤**，否则它会悄悄掉出 CI 覆盖。

`package.json` 的 `engines` 要求 Node >= 22，但 CI 矩阵仍在 Node 20 与 22 上跑——改动涉及新 Node API 时以 20 为下限验证。

## 命令

### 开发

安装（前置要求、依赖安装、全局 `kanban` 链接）不在本文件，见 [`installation.md`](./installation.md)。

```bash
npm run dev:full         # 首选：运行时 watch + Vite dev server 同开，自动挑空闲端口（多 checkout 可并行）
npm run dev              # 仅运行时，固定 127.0.0.1:3484
npm run web:dev          # 仅 Vite，127.0.0.1:4173，/api/* 代理到 3484 —— 改 UI 时用这个地址才有 HMR

npm run build            # clean → web:build → esbuild 打包 → 拷 web-ui 进 dist → sentry sourcemap → chmod
npm run dogfood -- --project <repo> --port auto   # 构建后跑 dist/cli.js，验证打包态（而非源码态）行为
```

### 校验

```bash
npm run check            # biome check + typecheck + test，根项目全套
npm run lint             # biome lint，一次覆盖 src / test / web-ui/src / web-ui/tests 及各配置文件
npm run format           # biome check --write .
npm run typecheck        # 仅根 tsconfig
npm run web:typecheck    # web-ui 是独立 tsconfig，根 typecheck 覆盖不到——两个都要跑
```

### 测试

`npm test` **不是**裸 vitest。它是 `test:guarded`：先跑 `test:policy`（TypeScript AST 静态策略），再把 vitest 包进 **invoking-repository mutation canary** 启动——canary 在测试前后比对宿主仓的 worktree / HEAD / index / status 指纹，检测到漂移即 fail closed 并保存报告，绝不自动恢复。**不要直接 `npx vitest`**，那会同时绕过策略与 canary。

根项目有两个 vitest project：

| project | 匹配 | 执行形态 |
| --- | --- | --- |
| `precommit-safe` | `test/**/*.test.ts` | 最多 2 workers |
| `runtime-integration` | `test/**/*.integration.test.ts` | 串行、单 worker（真实 server / CLI / WebSocket / PTY） |

```bash
npm test                 # 两个 project 依次跑
npm run test:precommit   # 只跑 precommit-safe（pre-commit hook 用的就是它）
npm run test:integration # 只跑 runtime-integration
npm run test:policy      # 只跑 git 安全策略静态检查

# 单文件 / 单用例：`--` 之后的参数原样透传给 vitest
npm run test:guarded -- --project precommit-safe test/runtime/xxx.test.ts
npm run test:guarded -- --project precommit-safe -t "用例名片段"

# web-ui 是另一套 vitest（jsdom，测试与源码同目录：src/**/*.test.ts(x)）
npm run web:test
npm --prefix web-ui run e2e        # Playwright，用例在 web-ui/tests/*.spec.ts

# 桌面壳
npm --prefix packages/desktop run typecheck
npm --prefix packages/desktop test
```

真实 git 测试只能经 `test/git-repository-mutation-safety/isolated-git-test-workspace-fixture.ts` 操作仓库。静态策略禁止测试文件直接执行 literal `git`、禁止子进程以 `process.env` 整体继承父环境，且**没有注释豁免**——需要新的 git 测试能力时扩展该 fixture 并补 fixture 自测。细则见 `test/README.md`。

pre-commit（husky）顺序：`biome check --staged` → `npm run typecheck` → `npm run test:precommit`。

## 架构

完整系统图、所有权表与「改 X 先想什么」对照表在 `docs/architecture.md`。以下只列**读单个文件看不出来**的几件事。

### 三层职责

浏览器是控制面（渲染 + 发命令 + 消费流）；本地运行时是长驻的唯一真相源（project / worktree / session / git / 流式状态）；执行层才是 agent 本体。session / board 摘要状态**不靠浏览器轮询**——由 `src/server/runtime-state-hub.ts` 批量广播经 WebSocket 推到 `web-ui/src/runtime/use-runtime-state-stream.ts`，再汇入 `App.tsx`。给会话摘要加字段通常不需要新订阅，加进契约即可搭上这条既有链路。但**推流不覆盖全部数据**：workspace diff 仍是定时轮询（详情视图展开变更侧栏时按 `card-detail-view.tsx` 的 `DETAIL_DIFF_POLL_INTERVAL_MS` 走 `use-runtime-workspace-changes.ts` 的 `pollIntervalMs` 分支），改 diff 相关行为时别假设它已在推流链路上。

### 三种 session transport

`src/core/agent-catalog.ts` 的 `sessionTransport` 字段是唯一声明点：

| transport | 代表 agent | 实现目录 |
| --- | --- | --- |
| `pty_terminal` | Claude Code / Codex / Gemini / OpenCode / Droid / Cursor / Kimi | `src/terminal/` — PTY 进程、xterm 服务端镜像、hook 事件 |
| `in_process_cline_sdk` | Cline | `src/cline-sdk/` — `@clinebot/*` SDK 会话宿主 |
| `acp_stdio_subprocess` | oh-my-pi (`omp`) | `src/acp-client-session/` — ACP，JSON-RPC over stdio 子进程 |

分支判定一律用能力谓词（`isRuntimeAgentSessionRenderedAsConversationPanel`、`isRuntimeAgentSessionDrivenByAcpProtocol`），不要新写 `agentId === "cline"`——历史上这种硬编码散落在 `runtime-api.ts`、`card-detail-view.tsx`、`persistent-terminal-manager.ts` 等多处，新增非 PTY agent 时必漏改其一。

### 契约与跨包边界

`src/core/api-contract.ts`（zod）是前后端请求/响应 schema 的**主来源**，但不是唯一契约点：procedure 层的契约（有哪些 procedure、input/output 各绑定哪个 schema，以及个别就地派生或组合出来的输入 schema，如 `optionalTaskWorkspaceInfoRequestSchema`、`gitSyncActionInputSchema`）落在 `src/trpc/app-router.ts`——新增或改动 procedure 时两处都要看。web-ui 通过 tsconfig path 别名**直接 import 运行时源码**：

- 纯类型引用（如 `@runtime-contract`、`@runtime-trpc`）只需加到 `web-ui/tsconfig.json`
- 有值引用（如 `@runtime-agent-catalog`、`@runtime-session-activity`）必须**三处同步**：`web-ui/tsconfig.json` + `web-ui/vite.config.ts` + `web-ui/vitest.config.ts`，漏一处就是「类型过了但运行/测试时解析失败」

请求链路：`web-ui/src/runtime/` 查询助手 → TRPC → `src/trpc/app-router.ts` → `src/trpc/runtime-api.ts`（协调者，负责路由与校验，不该沉淀深层会话逻辑）→ terminal / cline-sdk / acp / workspace。

### 被 lint 强制的边界

`biome.json` 加 `grit/*.grit` 把最易腐蚀的接缝做成了 lint 报错，不靠自觉——但**每条规则各有 includes 作用域，作用域外仍只是约定**：

- `@clinebot/*` 应只由 `src/cline-sdk/sdk-provider-boundary.ts` 与 `sdk-runtime-boundary.ts` 直接 import；但这条 override 显式排除了 `src/cline-sdk/**`、且只拦 `@clinebot/core`（不含 `@clinebot/shared`），所以 lint 实际只挡住 `src/cline-sdk/` 之外的代码——目录内已有 `cline-telemetry-service.ts` 这样的直引反例，那一层要靠自觉
- `createWorkspaceTrpcClient` 保留给 `web-ui/src/runtime/*-query.ts`；组件与 hook 用 `getRuntimeTrpcClient`
- `src/`（除 `cli.ts`）禁 `console.*` 与 `process.exit`
- 禁解构 `process.env`；禁写死 home-agent session 前缀字面量

格式：tab 缩进、`indentWidth: 3`、`lineWidth: 120`。

### 目录速查

后端 `src/`：

- `core/` — 契约与纯域逻辑：`api-contract.ts`、`agent-catalog.ts`、`session-activity.ts`、`task-agent-permission-mode.ts`、`task-board-mutations.ts`
- `trpc/` — `app-router.ts`（procedure 契约：input/output 绑定与少量就地派生的输入 schema）、`runtime-api.ts`（协调者）、`hooks-api.ts`（agent hook 摄入）
- `server/` — `runtime-server.ts`、`runtime-state-hub.ts`（状态扇出）、会话回收与关停协调
- `terminal/` / `cline-sdk/` / `acp-client-session/` — 三条 agent 通道
- `workspace/` — worktree 生命周期、git diff/history/sync、turn checkpoint
- `config/runtime-config.ts` — Kanban 偏好（**不放** Cline provider 密钥或 OAuth 令牌，那些归 SDK）
- `commands/` — CLI 子命令：`task` / `hooks` / `deployment` / `verification`

前端 `web-ui/src/`：

- `App.tsx` — 组合根（约 1.6k 行，别让它长成第二个运行时编排器）
- `hooks/` — 领域逻辑真正所在地。「这个行为到底怎么实现的」先查 hook，别从组件翻起
- `components/` — 只做渲染与组合；`runtime/` — TRPC 查询助手与流式状态；`terminal/` — 常驻 xterm 管理器
- UI 依赖 Tailwind v4 + Radix + lucide-react；本地 hook 优先用 `@/utils/react-use`

## 参考文档

- `installation.md` — 前置要求、三个 npm 项目的依赖安装、全局 `kanban` 链接与卸载
- `docs/architecture.md` — 系统图、运行时模式、所有权表、常见改动指引
- `docs/cli-environment.md` — CLI/hook 环境变量（超时、runtime host/port、hook 上下文）
- `DEVELOPMENT.md` — dev/dogfood 工作流、tmux 长驻启动约定、各 agent hook 事件到状态迁移的映射
- `test/README.md` — 测试执行形态与 git 安全契约
- `docs/adr/` — 架构决策记录
- `.plan/docs/` — 活跃计划与大型重构的历史上下文（非上手必读）
