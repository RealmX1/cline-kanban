# dd2db 阶段 0 ③ 探针结果：原生会话身份环境变量与 better-sqlite3 ABI

> 日期：2026-09-30。对应 R3.3 阶段表第 0 行 ③，按 Y-EVENT-15 判定是否降级。
> 方法：以静态分析为主，包括本机二进制的 strings、打包 JS、npm 包 dist，以及本机 oh-my-pi 源码；另用本机 Codex rollout 里的历史回显作旁证。实跑只有两项：Claude `/clear` 和各 Node 加载 better-sqlite3。
> 版本：Claude Code 2.1.285、codex-cli 0.158.0、Kimi Code 2.1.1（`~/.kimi-code/bin/kimi`）、omp 18.0.9（本机源码 `196cee84df`）、cursor-agent 2026.09.28-64d2043、`@clinebot/core` 0.0.38、better-sqlite3 12.11.1。
> 结论只适用于上述版本。

## 总表

| # | 项目 | 结论 | Y-EVENT-15 |
|---|---|---|---|
| 1a | Codex | **暴露 `CODEX_THREAD_ID`**，值等于本 rollout 的 thread id | 不降级 |
| 1b | Kimi Code | **不暴露**会话 id；bash 工具 env = `process.env` + 4 个固定值 | **降级**：Kimi 看板外会话按「无环境 CLI」处理，不能作门的被等方。Kimi 卡片不受影响 |
| 1c | omp | **不暴露**会话 id；工具 shell env = 过滤后的 `Bun.env` + 固定值 | **降级**：同 Kimi。omp PTY 卡片不受影响；ACP 卡片要补注入，见 3b |
| 2 | Claude `/clear` | **会更新**：实跑 `/clear` 前后子进程拿到两个不同的 id，各自对应一份 transcript | 不降级，原定的「已知限制」不用写进文档 |
| 3a | Cline SDK | **可以**按会话注入：`start()` 的 `capabilities.toolExecutors.bash` 接受带 `env` 的 bash executor。kanban 目前没接 | 不降级（1a 要实现） |
| 3b | ACP（omp） | 每个 task 一个 omp 进程，spawn env = `process.env + input.env + spawnCommand.env`；**调用方没传 `input.env`，所以目前 ACP 卡片的工具调用拿不到 `KANBAN_TASK_ID`** | 不降级（1a 要补上 `input.env`） |
| 4 | Cursor | 工具 shell 暴露 **`CURSOR_CONVERSATION_ID`**；恢复用 `--resume <chatId>`；**没有 fork** | 不降级；Cursor 卡片不能用 fork 型采纳 |
| 5 | better-sqlite3 | 只有 Node 24（ABI 137）打得开。tmux 常驻 3484 = OK；`dev:full`、`dogfood`、agent shell 里的 `kanban` = **按 PATH 取 node，本机 PATH 上是 v22 / v26，打不开**；desktop 本机无法实测 | 打不开的启动路径：该实例 board 只读 |

---

## 1. 各 harness 是否向工具子进程暴露原生会话 id

### 1a Codex：`CODEX_THREAD_ID`

- **二进制**：`strings /opt/homebrew/Caskroom/codex/0.158.0/bin/codex` 里，`CODEX_THREAD_ID` 紧挨着 `exec_command` 和终端权限提示文案出现，说明它在工具执行 env 里注入。`CODEX_SESSION_ID` 不存在，只有一个无关的 `CODEX_SESSION_IDS`。
- **本机 rollout 旁证**（脚本 `scratchpad/codex_thread_id_probe*.py`）：
  - 工具输出里 `CODEX_THREAD_ID=` 的回显共 41 处。11 处等于所在 rollout 文件名中的 id。
  - 其余 30 处全部出现在 fork 出来的 rollout 里，那里的 `session_meta.source` 就是这个回显值。也就是说，这些是 fork 时复制进来的父会话历史，不是子会话的实时值。
  - 覆盖了 `cli`（TUI）和 `vscode` 两种来源。
- **卡片内也同时拿得到 kanban 变量**：rollout `019dfc8b-…`（卡 1ae11）的同一次 `printenv` 里，同时有 `KANBAN_TASK_ID=1ae11` 和 `CODEX_THREAD_ID=019dfc8b-9964-7941-b526-32bc62e78653`。Codex 的 shell 环境策略不会剥掉 `KANBAN_*`。
- **语义**：resume 沿用原 id，fork 产生子 id，与 post-mortem 2026-09-24 的实测一致。`/new` 之后是否随之更新，没有实测。

### 1b Kimi Code 2.1.1：不暴露

- **源码**：embedded JS 里的 `packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts`：
  ```
  const noninteractiveEnv = { NO_COLOR: "1", TERM: "dumb", GIT_TERMINAL_PROMPT: ..., SHELL: env.shellPath };
  return processService.spawn(env.shellPath, ["-c", shellCommand], { env: noninteractiveEnv });
  ```
  `hostProcessService.ts` 的 `buildEnv(overrides)` 返回 `{...process.env, ...overrides}`。
  所以 kanban 通过 PTY 注入的 `KANBAN_*` **能到达**工具 shell，但 Kimi 自己不加任何会话 id。
- 全二进制的 `*SESSION*` 常量里，没有任何一个以 env 名义注入子进程。`GLOBAL_SESSION_ID`、`INTERACTION_TAG_SESSION_ID`、`PARENT_SESSION_ID_KEY="parent_session_id"` 都只在内部使用。
- 会话 id 仍能从 hook stdin 拿到，kanban 现有的 Kimi hook 就是这么做的。但由 agent 自己发起的 CLI 调用拿不到。
- **降级（Y-EVENT-15 第 1 条）**：Kimi 看板外会话发起的调用解析为 `kanban_cli_invocation_without_task_or_session_environment`，也不能作门的被等方。Kimi 卡片以 `KANBAN_TASK_ID` 为准，不受影响。

### 1c omp 18.0.9：不暴露

- **源码**（`~/Documents/GitHub/oh-my-pi`，`omp` 软链到这里）：
  - `packages/utils/src/procmgr.ts` 的 `buildSpawnEnv` 返回 `{...filterChildShellEnv(Bun.env), SHELL, GIT_EDITOR, GPG_TTY, OMPCODE:"1", CLAUDECODE:"1", CI}`。
  - `filterProcessEnv` 只剔除不安全的名字和值，`KANBAN_*` 能通过。
- **找到的会话类变量都不是给 bash 工具的**：
  - `PI_SESSION_FILE`、`PI_TOOL_BRIDGE_SESSION`：只注入 eval 内核（`eval/executor-base.ts` 的 `MANAGED_KERNEL_ENV_KEYS`）。
  - `PI_SESSION`：在内核的拒绝名单里。
  - `MNEMOPI_SESSION_ID`：属于另一个包。
- **可能的补救（未验证）**：kanban 的 omp 托管扩展运行在 omp 进程里，理论上可以把会话 id 写进 `process.env`。但 `getShellConfig` 是否缓存了启动时的 env，没有查证。
- **降级**：同 Kimi。omp PTY 卡片不受影响；ACP 卡片要先补上 3b。

## 2. Claude `/clear` 后 `CLAUDE_CODE_SESSION_ID` 是否更新：会更新

- **静态分析**（Claude Code 2.1.285，bun 打包的二进制）：
  - bash 工具的 env 构造 `uEr` 每次 spawn 都调用 `ANe({sessionId:z(), ...})`，写入 `CLAUDE_CODE_SESSION_ID:e.sessionId`。其中 `z()` 取当前会话 id。
  - `/clear` 的 `conversation_reset` 分支里有 `if(a.CLAUDE_CODE_SESSION_ID)process.env.CLAUDE_CODE_SESSION_ID=z()`。
  - MCP stdio 子进程同样取 `CLAUDE_CODE_SESSION_ID:z()`。
- **实跑**：
  - **环境**：tmux 会话 `dd2dbClearProbe`，运行 `env -i HOME USER PATH SHELL TERM LANG`，没有任何 `KANBAN_*` / `CLAUDE_CODE_*`；用 `claude --setting-sources local` 跳过用户级 hooks；cwd 在 scratchpad。
  - **步骤**：先用 bash 模式 `!` 回显一次 → `/clear` → 再回显一次。
    ```
    pre_clear  b794771a-1804-4443-be0a-f09e36178a30
    post_clear f06c4e72-9adb-4fcb-9bf8-2baa981c840f
    ```
    `~/.claude/projects/-private-tmp-…-claude-clear-probe-cwd/` 下正好有这两个 id 的 `.jsonl`。
  - **成本**：2.1.285 的 `!` 输出之后会自动触发一个极短的模型回合，共 2 次，走 Max 订阅，花费可以忽略。
  - **清理**：tmux 会话按启动时记下的 pane PID 1893 核对后 kill。探针 transcript 留在原处，不删。
- **结论与含义**：
  - Y-EVENT-15 第 3 条的降级不需要。
  - 反过来的后果：看板外会话 `/clear` 之后是一个**新的原生 id，也就是新节点**，不会与 clear 前的会话合并。clear 前后要不要建关联（例如一条记录型来源关系），是设计问题，不属于降级，另行决定。

## 3. Cline SDK 与 ACP 的按会话 env

### 3a Cline SDK（`@clinebot/core` 0.0.38，进程内运行）

- 默认 bash executor（`dist/index.js` 中的 `d2`，公开名为 `createDefaultExecutors().bash`）：
  - spawn 时 `env:{...process.env,...f.env}`；
  - 类型定义在 `extensions/tools/executors/bash.d.ts`，`BashExecutorOptions.env?: Record<string,string>`（「Environment variables to add/override」）。
- 会话启动时可以按会话覆盖 executor：`runtime/capabilities/runtime-capabilities.d.ts` 定义了 `RuntimeCapabilities { toolExecutors?: Partial<ToolExecutors>; requestToolApproval?… }`。kanban 的 `src/cline-sdk/cline-session-runtime.ts:243` 已经按会话传 `capabilities: { requestToolApproval }`，所以只需加上 `toolExecutors: { bash: createDefaultExecutors({ bash: { env: taskContextEnv } }).bash }`。
- **现状**：kanban 没有传 executor，Cline 卡片的工具调用继承的是 **runtime 进程自身的 env**。只要 runtime 是从某张卡的 shell 里启动的（例如在 task worktree 里跑 `dev:full`），工具调用就会被记到那张卡名下。所以「runtime 启动时擦除继承来的 `KANBAN_*` / `CLAUDE_CODE_*`」必须与注入一起做。
- **另外两处**：
  - MCP server 子进程也继承 runtime env，要么同样注入，要么保持擦除后的干净 env。
  - `runtime/tools/subprocess-sandbox.d.ts` 有独立的 `env?`。kanban 是否走 sandbox 路径没有查。
- **判定**：可行，不降级，但属于 1a 的工作量。

### 3b ACP（omp）

- `src/acp-client-session/acp-client-connection-runtime.ts:147`：`spawn(binary, args, { env: { ...process.env, ...input.env, ...spawnCommand.env } })`。
  - 每个 task 一条连接（`connectionsByTaskId`），**每个 task 一个 omp 进程**，所以按会话注入可以直接写在进程 env 里。
- `acp-task-session-service.ts:315` 调用 `startTaskConnection({...})` 时**没有传 `env`**。`spawnCommand.env` 只有 `OMP_SKIP_SETUP`、`PI_NO_TITLE`。
  - 结果：ACP 卡片的 omp 工具 shell 拿到的是 runtime 进程的 env，没有本卡的 `KANBAN_TASK_ID`。
  - 对照 PTY 路径 `src/terminal/session-manager.ts:3020` 的 `taskContextEnv`，那里有 `KANBAN_TASK_ID`、`KANBAN_ATTEMPT_ID`、`CLINE_KANBAN_*`、`KANBAN_TASK_CONVERSATION_SESSION_ID`、`KANBAN_PROJECT_PATH`。
- omp 工具 shell 会继承 omp 进程的 `Bun.env`（见 1c），所以把同一组变量传进 `input.env` 就够了。**判定**：不降级；1a 要补上这一处。

## 4. Cursor（cursor-agent 2026.09.28-64d2043）

- **会话 id 进工具 env**：`index.js` 的 `ShellCoreExecutor.execute` 里有：
  ```
  const b={CURSOR_AGENT:"1"}; t.conversationId&&(b.CURSOR_CONVERSATION_ID=(0,dd.sh)(t.conversationId)), t.requestId&&(b.CURSOR_REQUEST_ID=t.requestId)
  ```
  shell 状态快照会显式排除 `CURSOR_CONVERSATION_ID` / `CURSOR_REQUEST_ID`，不做持久化。所以每次调用都按当前会话重新注入。
- **本地存储与恢复**：
  - 会话存在 `~/.cursor/chats/<workspaceHash>/<chatUUID>/`。
  - CLI 提供 `--resume [chatId]`、`--continue`、`ls`、`resume`、`create-chat`，**没有 fork**。kanban adapter 对 Cursor fork 直接抛错（`agent-session-adapters.ts:1048`）。
  - `CURSOR_AGENT_CHAT_ID` 只用于 shell integration 脚本，不是工具 env。
- **未实测**：`CURSOR_CONVERSATION_ID` 的值是否与 `--resume` 用的 chatId 相同，因为验证要花一次模型调用。静态上推断两者相同；`dd.sh` 是对值做的一层处理，没有展开核实。
- **判定**：
  - Cursor 看板外会话可以用 `CURSOR_CONVERSATION_ID` 标识，待一次实跑确认。
  - 按 Y-EVENT-18，Cursor 只有 resume 型采纳，没有 fork 型来源；「Cursor 没有 fork 就直接拒绝」的限制保留。

## 5. 各 runtime 启动路径能否打开 better-sqlite3

本机 better-sqlite3 12.11.1 编译产物是 `~/Documents/GitHub/cline-kanban/node_modules/better-sqlite3/build/Release/better_sqlite3.node`。各 task worktree 的 `node_modules` 都软链到这里。

**实测**：在各个 Node 下执行 `require("better-sqlite3")` 并 `new Database(":memory:")`：

| Node | ABI | 结果 |
|---|---|---|
| `~/.nvm/versions/node/v24.12.0/bin/node` | 137 | **OK**，sqlite 3.53.2 |
| `~/.local/bin/node`（agent shell 的 PATH 首位） | 127 | FAIL（NODE_MODULE_VERSION 不符） |
| `~/.hermes/node/bin/node` | 127 | FAIL |
| `/opt/homebrew/bin/node`（`zsh -lc` 的 PATH 首位） | 147 | FAIL |

**各启动路径**：

| 启动路径 | 实际使用的 node | 能否打开 |
|---|---|---|
| **tmux 常驻 3484** | `run-cline-kanban-3484-service.sh` 写死 `NODE=~/.nvm/…/v24.12.0/bin/node`。只读 `ps` 确认监听进程 PID 9104 用的正是这个 node，已运行 4 天 18 小时。另外，这个进程的 env 里**没有** `KANBAN_TASK_ID` / `CLAUDE_CODE_*` | **能** |
| **`npm run dev:full`** | `scripts/dev-full.mjs:88` 启动 `node_modules/.bin/tsx`，shebang 是 `#!/usr/bin/env node`，**按 PATH 取 node**。本机 agent shell 取到 v22，登录 shell 取到 v26 | **打不开**，除非显式在 Node 24 下运行 |
| **`npm run dogfood`** | `scripts/dogfood.mjs:10` 的 `nodeBinary = process.execPath`，也就是运行 npm 脚本的那个 node，同样按 PATH 取 | **打不开**，除非显式在 Node 24 下运行 |
| **agent shell 里的 `kanban` CLI** | `kanban` 软链到 `dist/cli.js`，shebang 是 `#!/usr/bin/env node`，取到 v22。hook 进程例外：`kanban hooks ingest` 由 runtime 以绝对路径调用 v24 | **打不开**。这是 Y-EVENT-1「只由 runtime 写」的直接依据 |
| **desktop（Electron 41.5.0）** | 打包后的 shim `packages/desktop/build/bin/kanban` 用 `ELECTRON_RUN_AS_NODE=1` 加内置 Electron 运行 CLI，失败才回落到系统 `node`。`postinstall: electron-builder install-app-deps` 按 Electron ABI 重编原生依赖；`electron-builder.yml` 的 `asarUnpack` 包含 `node_modules/better-sqlite3/**` | **本机无法实测**：`packages/desktop/node_modules` 里没有 better-sqlite3；`electron/dist` 缺 `Electron Framework`，dyld 报错；本机也没有装 Kanban.app。设计上与通知库同源 |

**与现有通知库的对照**：
- `src/notifications/notification-lifecycle-archive.ts` 首次请求时才起 worker（`notification-lifecycle-database-worker.mjs`）。worker 出错或退出时，只 reject 挂起中的请求，并清空 worker 以便下次重建。
- 也就是说，**通知库在 ABI 不符时只是逐请求失败，没有实例级降级**。关系库按 Y-EVENT-1 要「board 只读 + 横幅」，所以不能照搬通知库的失败处理。
- 构建方面，`scripts/build.mjs:9` 把 `better-sqlite3` 设为 external，`:63` 单独把通知 worker 的 `.mjs` 拷到 `dist/`。

**判定（Y-EVENT-15 第 4 条）**：
- 在 v22 / v26 下启动的 `dev:full`、`dogfood` 实例，关系库打不开，board 只读。
- 建议 `dev:full` 和 `dogfood` 在启动时检测 ABI 并明确提示「请用 Node 24」，否则开发者会把「board 只读」误判为 bug。这是建议，不在本探针范围内。

---

## 范围外的一条旁注

本 worktree 已经有 `src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker.mjs`，但 `scripts/build.mjs` 只拷贝了通知 worker 的 `.mjs`。账本 worker 需要加同样的拷贝步骤，否则打包后（dogfood、全局 `kanban`、desktop）runtime 找不到这个 worker 文件，关系库打不开，board 会进入只读。
