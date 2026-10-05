# Kanban runtime 热重启：把 agent 会话从 runtime 进程里解耦出来（agent session PTY host）

## Context

**需求**：local deploy / 热重启 Kanban runtime 时，正在跑的 task / chat session 不被打断。也就是说，coding agent 会话能否延续，不应和 Kanban runtime 进程强绑定。

**现状结论：确实强绑定，这项工作的重要性没有下降。**
- 3484 实测：所有 claude / codex 进程都是 runtime（pid 86065）的**直接子进程**。node-pty 用 `POSIX_SPAWN_SETSID` 起它们，PTY master fd 由 runtime 持有（`src/terminal/pty-session.ts:150`）。
- runtime 一死（graceful、`kill -9`、崩溃都一样），master 关闭 → SIGHUP → agent 退出。graceful 路径还会主动 `markInterruptedAndStopAll`（`src/terminal/session-manager.ts:5321`）。`--skip-shutdown-cleanup` 早已是 no-op（`src/cli.ts:698`）。
- 启动时 `reconcileSummaryWithUnrecoverableRunningAgentProcessClaim`（`session-manager.ts:850-880`）把所有「live + pid」记录归零为 idle，理由是「按构造不可恢复」：没有任何路径能认领外部进程。
- 现有唯一的「延续」只在对话层：浏览器聚焦某卡时，`maybeAutoResumeStaleSession`（`web-ui/src/terminal/persistent-terminal-manager.ts:692`）用 `--resume <id>` / `--continue` 重新拉起 agent。进行中的那一轮丢失，MCP 舰队重启，scrollback 丢失；hook 在 runtime 宕机窗口内约 7 秒后放弃，事件丢失（`src/commands/hooks.ts:563-630`）。

**目标**：新增一个独立长驻的「agent session PTY host」进程持有 PTY master，runtime 退化为可断开、可重连的控制端；新 runtime 启动后在 `listen` 之前接管仍在跑的会话（同 pid、scrollback 连续、宕机窗口内的 hook 事件不丢）。

## 热重启类型与可行性（分析结论，实现时落盘为仓库文档）

| 类型 | 现状 | 可行性 | 本计划 |
|---|---|---|---|
| 仅 web-ui 换包 | 已可热换：资源每请求从盘读、`no-store`（`src/server/assets.ts:66-92`）；WS 重连时比对资源 hash 自动 reload | 高 | P0 做原子构建，消除 `rm -rf dist` 窗口 |
| runtime JS 重启，PTY 会话存活 | 不可能：PTY master 在 runtime 内 | 中高（需 PTY host + 接管） | **主体（P1–P4）** |
| PTY host 自身升级 | 不存在 | 中（generation 机制：旧 host 只服务存量会话，排空后退出） | P1 起就做 |
| 进程内热替换模块（不重启） | esbuild 单 bundle + 大量模块级状态 | 低，收益不抵成本 | 不做 |
| 零停机 socket 交接 / 蓝绿 | 无 | 中，但没必要：秒级空窗已有 WS 重连 + 资源刷新兜底 | 不做 |
| omp（ACP stdio 子进程） | 随 runtime 死；`session/load` 有但没人调 | 中（host 增加 pipe 型会话） | 后续阶段，不在本轮 |
| Cline SDK（进程内） | 随 runtime 死 | 低（要把 SDK 整体移出进程；`backendMode:"auto"` 的 hub 入口是坏的） | 不做：Cline 已停止维护（AGENTS.md，2026-10-03），保持现状 |

用量佐证：持久化会话中 claude 8279、codex 7833、kimi 154、cursor 126、omp 73、cline 13，PTY 通道几乎就是全部。

## Base 对齐记录（2026-10-05，实施前第 0 步的结果）

- **吸收**：local main `4432d5d5` → `746d5c69`，27 个提交，fast-forward 无冲突。bootstrap receipt 已写，锁已释放。计划中的行号以 `746d5c69` 为准，实施时仍以实际代码为准。
- **兄弟任务**：
  - 比对时有两处硬碰撞：4e79f（跨项目切换面板）的未提交改动落在 hooks.ts / hooks-api / api-contract / app-router / session-activity / session-manager / runtime-server / agent-session-adapters / codex 与 kimi hook 配置；df9d8（计时测试两档期限）在改 `package.json`。
  - 两者现已分别以 `c765fbe5` / `2084300a` 落回 main，worktree 干净。碰撞已消解，改动已在本基线里。
  - 软重叠：
    - de27e（进行中，无未提交改动）：在讨论缩短 5h 回收宽限期，以及「回收后终端显示保持不变 / 改读 transcript」。与护栏 3 共用回收期限：本计划只读 record 里的 `eligibleAt`、不复制常量，期限来源怎么改都自动跟随。它若要做「回收后保留终端显示」，host 的环形缓冲 / checkpoint 可作为数据源（不在本轮）。
    - 5f9ce（早先的 graceful redeploy 可行性分析，在 review，无代码改动）。
  - 采集降级：kanban CLI 退出码 1，任务清单退回 durable board state（无 session 实时性）；活跃会话是另行逐个 worktree 只读核对的。
- **新基线对计划的影响**（已并入下文各阶段）：
  1. 新 hook 事件 `main_agent_conversation_context_compaction_completed`（Claude / Codex / Kimi 的 PostCompact，`c765fbe5`）。它推进 Cache warm 起点（`recordMainAgentConversationModelRequestDispatch`，手动压缩时带压缩后 token 数），所以必须进 spool、不合并，且用捕获时刻 → P3。
  2. 新增的回合开始盖章：`stampAgentResponseGenerationTurnStarted`（`session-activity.ts`）把 `agentResponseGenerationTurnStarted.startedAt` 取为 `updatedAt`，驱动跨项目切换面板 Running 区排序。spool 的 `to_in_progress` 晚到会把开始时刻记成 drain 时刻 → 加入 P3 的捕获时刻名单。
  3. 版本错位已经成真：同一个提交给 Claude 共享 `settings.json` 加了 PostCompact、给 kimi seeded `config.toml` 加了事件，两者都是原地覆写的共享文件 → P3「版本错位」的内容寻址改造被坐实，核对名单补上 gemini `settings.json` 与 opencode `kanban.js` / `opencode.json`。
  4. 回滚方向的版本错位：新 build 拉起的会话会带旧 CLI 不认识的 `--event` 值（如上面的压缩事件），回滚到旧 build 后这类 hook 会被旧 CLI 拒收 → 记为已知局限（事件丢失，不影响会话存活），在 P6 回滚步骤里提示。
  5. 工作单元间关系账本（dd2db 1a–1c，只追加、不可撤销）：
     - 所有起真 runtime 的验证（集成 (B)、e2e、deploy skill 演练）必须 HOME 隔离，绝不往真实账本写。
     - 族 1 message 事件按幂等键去重，原生身份事件已去重 → CLI 等待重试与 spool 重放不会在账本里制造重复。P3 的幂等 key 仍然需要，管的是内存态效果。
     - 账本库多实例共用（WAL + `busy_timeout` + IMMEDIATE 事务），handover 时新旧 runtime 短暂重叠不冲突。
     - work-unit 身份 env 由 runtime 随 spawn 请求下发给 host，host 自身 env 不进 agent。runtime 启动时 scrub 继承身份 env 的逻辑不变；host 由 runtime 拉起，所以它启动时同样 scrub 一次。
  6. 计时断言新规（`test/README.md`「负载敏感的墙钟 / 资源断言」）：本计划的集成测试和延迟测试一律用两档期限 helper，闭合外层 timeout。「handover 绝不发信号」这类行为契约写成确定性断言 → 「验证」。
  7. Cline 已停止维护：类型表 Cline 行改为「不做」，删除范围外的 Cline SDK 发消息 bug；P4 第 6 步对 Cline 只保持现状。
  8. `deployment.ts` 新增了「CLI 已授权 PDV 完成」的 runtime 补写。P6 给 `kanban deployment record` 加字段时只动 record 子命令，不碰该路径。

## 方案总览

```
browser ─ws/http─▶ runtime（可重启）─UDS 帧─▶ agent-session-pty-host（ppid=1, setsid）
                       ▲                         ├─ node-pty master ─▶ claude / codex / shell …
kanban hooks ingest ───┘ ECONNREFUSED 时 ─UDS──▶┘  （host 是 agent 的父进程，负责 reap）
```

**选型**：每个 runtime 身份（runtime home + 固定端口）配**单个 host 进程**，带 generation 机制。被否决的备选：
- 每会话一个 Node keeper：每个 40–50 MB，30 个会话就是 1–1.5 GB，用户本就有内存压力。
- dtach / abduco：原生依赖；没有退出码、字节偏移和流控。
- tmux（含专用 socket + control mode 的改良版，用户已否决）：
  - 74 项字节级逻辑中约 15 项需重设计；
  - 查询应答职责转交 tmux；
  - 背压失效，pause 只会丢数据；
  - 像素尺寸丢失；
  - agent 必然经 XTVERSION / DA 识别出 tmux。
  - 详见下方「OpenRig 对照」。
- fd 传递：Node 不能传任意 fd，node-pty 的退出检测只认 fork 它的那个进程。

**停止语义（用户已定：任何退出都保活 + 护栏）**
- runtime 无论怎么退出都不终止 hosted 会话，下次启动时接管。SIGINT / SIGTERM / SIGHUP、kill -9、崩溃、handover 都算。
  - 单一开关点：`resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger`。
  - env 覆写：`KANBAN_RUNTIME_SHUTDOWN_SIGNAL_DISPOSITION_FOR_HOSTED_AGENT_SESSIONS=terminate` 可回到「信号即终止」。
- 信号触发的停止复用 handover 的 detach 流程（含 scrollback checkpoint），只是退出码不同：保持 130/143，supervisor 照旧停机。
- **host 自身忽略 SIGINT / SIGTERM / SIGHUP**。理由：host 的 argv 路径里含 `cline-kanban`，`pkill -f kanban` 会误伤到它，那就和「误操作零爆炸半径」相悖。终止会话只认两条路：
  - 协议消息（显式 stop 命令）；
  - 下面的孤儿回收。
  - 系统关机时的 SIGKILL 照常让 PTY 挂断。
- 护栏 1：停止时打印「N 个 agent 会话仍由 host 持有；全部终止请执行 …」。
- 护栏 2：`kanban runtime stop --terminate-hosted-agent-sessions` 显式全停。runtime 在线时经 tRPC；离线时 CLI 直连 host socket，发冻结的 `terminate_all_hosted_sessions_and_exit`。
- 护栏 3，孤儿回收：**复用现有会话回收 GC 的期限，不引入新常量。**
  - 现有机制：`src/server/agent-session-inactivity-reclamation-scheduler.ts`。agent 停止生成响应后 5h 宽限期（`session-activity.ts:674`）；park 轨道默认 24h；期限以绝对 epoch 落盘；agent 回合中绝不回收。
  - runtime 把每个会话当前的 `eligibleAt` 同步进 adoption record。没有 controller 连着时，host 按同一期限 SIGTERM 进程组，5s 后升级 SIGKILL，并留下带 `reclaimed_by_host_while_runtime_absent` 的 exit 记录。
  - runtime 回来后据此补记账：`updateAgentSessionReclamationProgress`、`markAgentRaisedPendingUserDecisionsReclaimed`。
  - 已知局限：runtime 缺席期间才停止生成的会话，record 里还没有期限，要等 runtime 回来 drain hook 后才起算。由于 P3 改用捕获时刻，起算点是真实停止时刻，届时已过期的会在下一次 sweep 立即回收。

**启用**：opt-in，`KANBAN_AGENT_SESSION_PTY_HOST_MODE=enabled`（默认 disabled）。以下情形强制关闭：`--port auto`、remote-host 模式（内部 token 每次启动随机；P5 持久化 token 后解除）、win32、Electron（`packages/desktop/src/runtime-child-env.ts`）。测试永不 daemonize host。

## 宕机窗口信息来源总表（runtime 不在时，哪些信息会漏、怎么补）

| 信息来源 | 窗口内现状 | 处置 | 阶段 |
|---|---|---|---|
| agent hook 事件（Stop / UserPromptSubmit / PreToolUse / Notification …） | 约 7s 后放弃，只记丢投日志 | host spool；用捕获时刻；幂等 key；与直投保序；activity 合并而不丢；directive fail-open | P3 |
| PTY 输出字节 | runtime 不在就没人读，进程挂断 | host 环形缓冲 + 追赶只喂 mirror | P2 |
| 输出触发的边沿（readiness / trust 提示 / output reaction / 输入框 / omp 标题） | 追赶字节不过检测器，会漏 | 接管后读屏补判一次 | P2 |
| agent 发出的终端查询（DA / CPR / OSC10/11） | 无人应答；迟到应答刻意不发 | handover 等启动期会话就绪；崩溃路径记为已知限制（稳态 agent 很少发） | P4 |
| agent 进程退出 | 退出码丢失 | host 保留 exit 记录直到 ack；先 drain hook 再释放 exit | P2 |
| agent / 脚本调用的 `kanban task …` 等 CLI 写动词 | ECONNREFUSED 直接报错给 agent | 有重启证据时 CLI 等待重试（上限 60s），只对「确定没发出」的请求重试 | P3 |
| 程序化 PTY 输入投递（多段序列） | 被腰斩后留下半截输入 | handover 排空在途投递；崩溃路径由 outbox 把 `sending` 标为不确定、不重发 | P4 / P5 |
| 浏览器 WS / 终端按键 | 断连，窗口内的按键不发送（用户可见） | 1012 close code 加热重启提示；退避重连；restore 补屏 | P4 |
| runtime 内存里的定时器（readiness 期限、deferred prompt、auto-restart 等） | 全丢 | 字段处置表编译期强制归类；回收 / park 期限本来就是绝对 epoch 落盘 | P2 / P5 |
| `sessions.json`（只在 graceful shutdown 落盘） | 崩溃即丢 | adoption record 优先于 `sessions.json` | P2 |
| agent 转录文件（Claude JSONL 等） | 不受影响（agent 照常写盘） | 无需处理：转录探测器在 hydrate 时本就会重探（`persisted-agent-transcript-conversation-progress-observer.ts`） | — |
| workspace diff / git 状态 | 不受影响 | 无需处理：定时轮询，无状态 | — |
| exploration 维护作业（runtime 子进程） | 被中止，下次 Stop 重新 fork | handover 打印在途数；deploy skill 默认等它完成 | P4 / P6 |
| Cline SDK / omp ACP 会话 | 随 runtime 死 | 范围外，保留对话层续跑 | — |

## 实施进度（2026-10-05）

**已完成：P0、P1、P2 主体。** base 仍为 `746d5c69`，未提交。

验证结果：
- 全量 `npm run test:guarded`（precommit-safe + runtime-integration）：305 文件 / 3454 例通过，canary 干净。
- 新增测试：
  - 单元：帧编解码、环形缓冲、注册表、启用判定与 socket 路径、launcher、终止信号策略、原子构建换入。
  - session-manager 接管：6 例。
  - 真 host 集成：3 例，含「崩溃 → 新 runtime 接管，追赶与实时字节分流」。
- 隔离实例 e2e：HOME 覆写、端口 3497，home shell 终端，不碰 3484。
  - `kill -9` runtime A 后，shell 与 host 存活。
  - runtime B 在 listen 之前接管：summarySource=adoption_record，pid 不变，startedAt 不变。
  - 重启前后的 marker 都在屏上，输入可达。
  - graceful 停止后 shell 被终止，host 在 60s 空闲后自退并删除 socket。

**与上文计划的偏差**（均已落在代码里）：
- `HostedTerminalPtyProcessSpawner` 推迟到 P1 才定义：spawn 请求的形状到那时才确定。
- 宿主侧依赖闭包的放行名单：`host-process/`、`wire-protocol/`，以及 `src/terminal/pty-process-group-termination-signal-policy.ts`。
- host 入口拆成两部分：
  - `agent-session-pty-host-process-entry.ts`：只负责注入 `process.exit`，biome 的 no-process-exit 豁免只给它；
  - `agent-session-pty-host-process-main.ts`：主逻辑。
- 接管点：没有把候选塞进 `hydrateFromRecord` 的重建逻辑，而是改成两步：
  - hydrate 时对待接管的 taskId 不记「无法认领」告警，并留存盘上原文；
  - 由 `adoptHostedTerminalPtySessionsAfterRuntimeRestart` 接管或拒绝。
- 未被接管的 hosted 会话（workspace 加载失败或已移除）**只告警、不自动终止**。理由：杀活 agent 不可撤销。这些会话留给下次重启接管，或由显式全停 / 孤儿回收（P4）处理。
- host 拒绝不安全的 socket 目录：必须是真目录、属当前用户、组和其他人都不可写，防 `/tmp` 回退目录被抢建。
- `launchedByKanbanBuildIdentity` 推迟到 P6：只有 deploy skill 消费它。

**P2 余项（未做）：**
- 接管后读屏补判中的输出反应、输入框占用、omp 标题状态（代码注释已标）。
- 接管会话的自动重启随 P5 的 `restartRequest` 持久化恢复，代码里已标 `EXPERIMENT_NODE`。
- runtime 级集成测试 (B) 与 P4 的 handover / SIGTERM 变体一起写。

**e2e 抓到并已修的缺陷：**
- 全新 HOME 下 runtime home 尚不存在时，`spawn` 的 cwd 不存在只异步报 ENOENT，launcher 没有监听 error，表现为 10s 超时后退回进程内 PTY。
- 修法：先 `mkdir`，并监听 error 立即失败。已补回归测试。

**事故记录：**
- 原子构建首版把 worktree 里软链的 `web-ui/dist` 原样复制进 scratch 产物，陈旧清理顺着软链删空了主 checkout 的 `web-ui/dist`。
- 已从内容一致的 `dist/web-ui` 恢复，`diff` 一致。3484 在服务的 `dist/web-ui` 未受影响。
- 已改为：复制时解引用软链，判断目录用 `lstat`，遍历遇软链即失败。

## 分阶段实现

**实施前第 0 步**（2026-10-05 已完成，结果见上方「Base 对齐记录」）
- 先调 `reconcile-drafted-plan-with-local-base-and-sibling-task-work`：对照 local base 新落地的工作和同仓兄弟任务刷新本计划，并单向吸收 base。
  - 理由：`session-manager.ts`、`runtime-server.ts`、`hooks.ts` 是高频改动文件。
  - 实施跨度长：每个阶段开工前再看一眼 local base 是否前进；前进了就再次单向吸收，并只对增量做同样的核对。
- 用 Node 24 跑测试（better-sqlite3 ABI 137）。

**P0：前置重构，单独就有价值，现有测试零改动全过**
- 原子构建：`scripts/build.mjs` 先写到 `dist/.staging-<uuid>/` 再逐文件 rename；`build` 脚本不再先 `rm -rf dist`，改为最后清理陈旧文件；`dist/web-ui` 同样换入。
  - 理由：agent 存活后，hook 会在构建窗口内执行 `node dist/cli.js` 而失败。另外 task worktree 的 dist 软链在线产物。
- 抽出接口 `src/terminal/terminal-pty-process-handle.ts`（`TerminalPtyProcessHandle` / `HostedTerminalPtyProcessSpawner`），`ActiveProcessState.session` 改用该接口。
- `ActiveProcessState`、`buildTerminalEnvironment` 迁出 session-manager，抵消新增行数。
- 纯重构：`handleTaskOutput` / 退出处理的主体抽成 `processTaskAgentPtyOutputChunk`、`finalizeTaskAgentPtyProcessExit`，shell 侧同理。
- `agent-session-adapters.ts` 导出 `resolveAgentOutputTransitionDetectionForAgentId`，启动与接管共用。
- `terminatePtyProcess` 移到 `src/terminal/pty-process-group-termination-signal-policy.ts`，加 `escalateToSigkillAfterMs`。

**P1：host 进程 + 线协议 + 路由新 spawn（暂不接管，启动时终止遗留会话，行为与今天等价）**
- 新目录 `src/agent-session-pty-host/`：
  - `wire-protocol/`：帧编解码 `u32 len | u8 kind | payload`，JSON 控制帧与二进制数据帧（带 `u64 startByteOffset`），握手冻结。
  - `host-process/`：
    - 入口：`--daemonize` 二次 spawn，使 ppid=1，避开 dev-full 的 tree-kill；忽略 SIGHUP / SIGINT / SIGTERM。
    - 带陈旧 socket 恢复的 bind。
    - 会话注册表。
    - 每会话 2 MiB、带绝对偏移的环形缓冲（`EXPERIMENT_NODE`）。
    - 单 controller 槽。
    - 生命周期策略：无会话且无 controller 60s 后退出；`retire_when_drained`；无 controller 时按 record 中的 `eligibleAt` 执行孤儿回收。
    - 追加式日志。
  - `runtime-client/`：启用判定、身份与 socket 路径（`~/.cline/kanban/agent-session-pty-host/p3484-<buildId12>.sock`，注意 `sun_path` 103 字节上限）、detached 启动器、generation 发现、controller 连接、remote handle、facade。
- host 只允许 import `node:*`、`node-pty` 和 wire-protocol；用 esbuild metafile 守卫，保证 build hash 稳定。
- `scripts/build.mjs` 新增第三个入口，产出 `dist/agent-session-pty-host.js`。build identity = sha256(bundle ‖ node-pty 版本 ‖ `process.version` ‖ arch)。
- session-manager 的 task spawn（约 3591 行）与 shell spawn（约 3927 行）改为：spawner 存在时 `await spawner.spawnHostedTerminalPtyProcess(req)`，否则保持同步的 `PtySession.spawn`，确保 mock 了 pty-session 的约 15 个测试时序不变。

**P2：启动接管（先 task agent，后 shell）**
- runtime 在会话 spawn 时、以及 facet 三元组 / pid / 守卫变化时，把「adoption record」（summary + 需跨重启的 ActiveProcessState 字段）推给 host。
  - 理由：kill -9 后 `sessions.json` 不可信，host 与会话同寿。
- 字段处置表用 `satisfies Record<keyof ActiveProcessState, Disposition>` 编译期强制：新增字段不归类就编译不过。
  - **随 record 携带**：deferredStartupPrompt / readiness deadline、`suppressSubstantiveOutputUntilContinues`、restoration 通知拦截、`lastUserInputAt` 等。
  - **取自 host**：handle、cols/rows、真实 spawnedAt。
  - **按 agentId 重新派生**：检测器、output reaction 引擎。
  - **重置**：其余定时器与计数器。
- summary 选择顺序：record 快照 → incarnation 匹配的 `sessions.json` → 经 `buildTerminalFacetPatch` 合成完整三元组。
  - 一律过 `runtimeTaskSessionSummarySchema` 的 superRefine。
  - pid 与 host 不符时拒绝接管并终止（fail closed）。
  - 后续写入全走 `updateSummary` 漏斗。
- `hydrateFromRecord` 接收 adoption 候选，新增 `installAdoptedHostedPtySessionEntry`。在 `reconcileSummary…`（830-849）的注释里补充 host 确认这一例外：host 是父进程，未 reap 前 pid 不会被复用。
- **在 `server.listen` 之前**完成接管（`runtime-server.ts:1098`），否则早连上的浏览器会触发 `maybeAutoResume`，起出第二个 agent。
  - 枚举 host 会话 → 按 workspace 主动 `ensureTerminalManagerForWorkspace` → 接管。
  - host 已死（ECONNREFUSED）→ 走旧的归零。
  - host 活着但不应答 → 启动失败，交给 supervisor 重试，绝不归零。
- scrollback：有 handover checkpoint 时，`applyOutput(snapshot)` 后从 checkpoint 偏移续流；崩溃路径从环形缓冲起点重放，再对 TUI 发 resize nudge 强制全屏重绘。
  - **追赶字节只喂 mirror，不走 `handleTaskOutput`**：避免迟到的 OSC/DA 应答被打进 agent，也避免误推 `lastSubstantiveOutputAt`，守住「默认不推进」铁律。
- **接管后读屏补判（post-adoption screen re-evaluation）**：追赶字节不走字节流检测器，窗口内出现的边沿会漏掉，所以 mirror 追平后，对每个会话跑一次「基于当前屏幕」的补判。
  - 覆盖：readiness（record 里仍挂着 `deferredStartupPrompt` 时据此投递）、workspace trust 提示、output reactions 的自动应答、输入框占用、omp 终端标题状态。
  - 只依赖字节流的边沿检测器（实质输出）**刻意不补**：铁律「默认不推进」。
  - 字节流 / 读屏两类检测器的归属，实施时按 74 项盘点逐一标注。
- adoption record 带 `agentSessionAdoptionRecordSchemaVersion`。新 runtime 必须能读旧 runtime 写的 record；遇到无法识别的版本，退回「合成三元组」那一级，**绝不因此杀会话**。
- spawn 时把 `launchedByKanbanBuildIdentity` 写进 summary sidecar，用来识别「仍跑在旧启动配置上」的会话（见下方「版本错位」）。
- 窗口内已退出的会话：先按 running 装入 → 排空 spool 的 hook → 再释放锁存的 exit → 走正常 exit 漏斗。

**P3：宕机窗口的 hook 不丢、不错时、不重放两次**

这不是 trivial 的「排个队重放」。现状下（`hooks.ts:526-533`：3.5s 超时 × 2 次 + 250ms）宕机约 7s 后就放弃，只在 `~/.cline/kanban/agent-hook-delivery-failures/` 记一行丢投日志（F3，没有重放）。把它改成「存活会话的 hook 可延迟送达」，有四个正确性问题要逐一处理：

1. **spool 本身**
   - `src/commands/hooks.ts`：有 host env（`KANBAN_AGENT_SESSION_PTY_HOST_SOCKET_PATH` / `…_HOSTED_SESSION_KEY`）时：
     - ECONNREFUSED（请求确定没发出）→ 立即 spool；
     - 超时 / ECONNRESET（发没发出不确定）→ 重试耗尽后同样 spool，靠下面第 3 条去重。
     - spool 写入经 host ack 后 exit 0，远在 codex `timeout=8` 之内。
   - **`activity` 也进 spool，不再丢弃。** 理由：它驱动「对话上次推进」（`hooks-api.ts:448`，`recordAgentLifecycleHookConversationProgress`）和 Cache warm 倒计时起点（`recordMainAgentConversationModelRequestDispatch`），丢了会让这两颗药丸在重启后失真。
     - 防刷爆：host 侧把同一会话**相邻的** activity 合并为最后一条（夹在生命周期事件之间的保留顺序位置），队列长度以生命周期事件数为界。
   - 除 activity 外的事件一律逐条保留、不合并。其中包括压缩完成事件 `main_agent_conversation_context_compaction_completed`：它推进 Cache warm 起点，手动压缩时还带压缩后 token 数。
   - spool 的事件集合按 `VALID_EVENTS`（`hooks.ts`）整体纳入，不在 spool 侧另立白名单。理由：以后新增事件自动受保护，不会漏接。
   - 两个 env 加入 `session-manager.ts:984` 的剥离列表，防嵌套实例串用。
2. **时间语义：捕获时刻，不是接收时刻**
   - 现状：stop 时刻取自 patch 的 `updatedAt`（`session-activity.ts:331`），`receivedAt` / `askedAt` 用 `Date.now()`（`hooks-api.ts:90,286`）。spool 晚送达几秒到几小时（「任何退出都保活」下 runtime 可能停很久），所有时刻会被记成 drain 时刻。连带后果：回收期限 `eligibleAt = stoppedAt + 5h` 被推迟，卡片两颗时长药丸显示错误。
   - 改法：hooks CLI 进程启动即取 `hookEventCapturedAtEpochMs`，随直投与 spool 一起送达。`hooks.ingest` 契约新增该可选字段（`api-contract.ts` 与 `app-router.ts` 双点同步）。
   - 漏斗加显式参数 `domainEventObservedAtEpochMs`，**不复用 `updatedAt`**（它仍是写入墙钟）。用到它的写入包括：
     - `agentResponseGenerationStopped.stoppedAt`；
     - `recordAgentLifecycleHookConversationProgress`（单调 reducer，晚到的旧值不会回拉）；
     - `recordMainAgentConversationModelRequestDispatch`，含压缩完成事件那条路径；
     - `agentResponseGenerationTurnStarted.startedAt`：`stampAgentResponseGenerationTurnStarted` 现在取 `updatedAt`，它驱动跨项目切换面板 Running 区排序；
     - `agentRaised*` 的 `askedAt` / `receivedAt`。
   - 落点：`mergeSummaryWithFacets` 里同时盖「停止」「开始」两个边沿章，所以只在那里接一个可选的 `domainEventObservedAtEpochMs`。未传时退回 `updatedAt`，行为与现状一致。
   - 这样回收期限自然按真实停止时刻起算。「孤儿回收」的已知局限随之缩小为：runtime 回来之前不起算，回来后立即按真实时刻补齐。
3. **幂等：不重放两次**
   - 每次 hooks CLI 调用生成一个 `hookEventDeliveryIdempotencyKey`（uuid），重试和 spool 复用同一个 key。
   - 崩溃路径下，旧 runtime 可能已应用了某个事件（并已推进 record）但没来得及回响应，CLI 于是 spool 了它。为此，adoption record 携带每会话最近 32 个已应用 key（`recentlyAppliedHookDeliveryIdempotencyKeys`），新 runtime ingest 时命中即 ack 不应用。
   - 理由：重复的 `agentRaisedUserQuestion` 会派生第二个 decisionId，把前一条顶成 superseded（`hooks-api.ts:490` 注释里的实测现象）。
4. **顺序：spool 与直投不乱序**
   - 同一会话的 hook 由 agent 自己串行化：同步 hook 要等上一条 CLI 退出，下一条才触发，而 spool 写入在 CLI 退出前已经 ack。
   - 剩下的竞态：某事件在 runtime drain 之后、`listen` 之前进了 spool，随后下一事件直投先到。修法：
     - host 在有 controller 时立即把新 spool 推给它；
     - runtime 对「host 报告 spool 非空」的会话，直投 ingest 前先 drain 该会话的 spool（一次 UDS 往返，只在非空时发生）。
   - codex wrapper 的 session-log watcher 用后台 `kanban hooks notify` 发事件（`hooks.ts:786`），本就不与同步 hook 串行，按到达顺序处理即可。
- **directive 回不去**：spool 的事件无法回传 directive（例如 restoration guard 期间对 UserPromptSubmit 的 block），只能 fail-open，写入文档。exploration 作业分身的 PreToolUse deny 由 CLI 按 env 短路，不依赖 runtime，不受影响。
- **迟到通知**：drain 出的 `to_review` 照常走就绪通知链路。replay 时长超过 60s 的（`EXPERIMENT_NODE`）照常入档、照常视觉提示，但不朗读 TTS，避免 runtime 停了很久之后一回来连播 N 条过时语音。通知候选决策日志新增 `hook_transport_spooled_to_agent_session_pty_host` / `hook_spool_drained_into_runtime`。
- **CLI 写动词在窗口内等待而不是报错**：agent / 脚本调用的 `kanban task create|message|park --renew|update`、`kanban exploratory ingest-finding-candidate` 等，现在窗口内直接 ECONNREFUSED 报错给 agent。
  - 改 `createRuntimeTrpcClient`（`task.ts:261`）和其他 CLI 客户端：ECONNREFUSED（请求确定没发出，重试安全），且有「runtime 正在重启」证据时（host 报告 controller 缺席不到 90s，或 runtime home 下有 `runtime-handover-restart-in-progress-marker.json`），向 stderr 提示后等待重试，上限 60s。
  - 发出后才失败的（reset / 超时）不重试，除非该 procedure 自带幂等 key（`task message` 已有）。
  - hooks 不走这条路（受 8s 超时约束），走 spool。

**版本错位：存活会话是旧 runtime 配置出来的**（热重启之前每次部署都会换掉所有会话，所以不存在这类问题）
- **hook 调用面成为跨版本契约**：存活会话里冻结着旧 runtime 生成的 hook 命令行，而每次 hook 调用跑的是盘上的新 dist。冻结的命令行来自：
  - Claude 启动时快照的 hooks 配置（`agent-session-adapters.ts:1324-1396`）；
  - codex / kimi / cursor / droid 的 hook 配置；
  - 长驻的 `kanban hooks codex-wrapper` 进程，它在内存里跑旧 bundle，用旧 argv 拉起 `hooks notify`。
  - 因此 `kanban hooks …` 的子命令 / flag，以及 spawn 时注入的 env 名，**只增不改不删**。
  - 新增 fixture 测试：录下当前各 harness 实际生成的 hook argv 与 stdin 样本，断言新代码仍能解析。
- **Claude 共享 settings 文件不能原地改**：`~/.cline/kanban/hooks/claude/settings.json` 在内容变化时被 `ensureTextFile` 覆写。改成按内容寻址的 `settings-<sha12>.json`，永不原地修改；只有没有存活会话引用时才 GC 旧文件。
  - 理由：部署改了 hook 配置后，存活 Claude 会话加载过的文件会被改掉，Claude 可能提示「hooks 被外部修改」（实施时实测确认）。
    - 这已成真：`c765fbe5` 给该文件加了 PostCompact。若当时已有热重启，部署那一刻所有存活 Claude 会话的 settings 都会被原地改写。
  - 其他 harness 的共享配置文件逐个核对同类问题：
    - kimi seeded `config.toml`：`kimi-hook-config.ts` 用 `writeTextFileAtomic` 原地替换，所有 kimi 会话共享一份，`c765fbe5` 同样改过它；
    - gemini `settings.json`、opencode `kanban.js` / `opencode.json`：同一 `ensureTextFile` 路径；
    - droid；
    - codex 走 `-c` argv 覆写，不受影响，只需核对它的信任哈希不依赖盘上文件。
- **回滚方向的错位**：新 build 拉起的会话可能带旧 CLI 不认识的 `--event` 值（例如压缩完成事件）。回滚到旧 build 后，这类 hook 会被旧 CLI 的 `parseHookEvent` 拒收：事件丢失，会话不受影响。记为已知局限；P6 的回滚步骤里提示「回滚后，新 build 起的会话部分 hook 失效，需要的话重开这些会话」。
- **语义错位**：存活会话仍用旧的 append-system-prompt / MCP 配置 / 启动参数，部署只对新会话生效。deploy skill 用 `launchedByKanbanBuildIdentity` 列出这些会话，提示「需要新行为请手动重开」。
- **新 CLI 对旧 runtime**：handover 由新 build 的 CLI 发给仍在跑的旧 runtime，所以 handover procedure 的输入从首版起冻结。SIGUSR2 作为与版本无关的兜底。

**P4：计划内 handover 重启**
- 新增 `src/server/runtime-handover-restart-preserving-hosted-agent-sessions.ts`，步骤：
  1. 拒绝新 spawn，并排空在途的易断操作（各有上限）：
     - 程序化 PTY 输入投递：paste + 延迟回车、提问选择器先关后答等多段序列。新增在途登记，等它们走完，避免留下半截输入。
     - 处于启动期的会话：spawn 不足 5s 且未就绪的（`EXPERIMENT_NODE`），因为 agent 启动期会发 DA / CPR / OSC10/11 查询，窗口内无人应答；crossterm 系的 CPR 2s 即超时。
     - 打印在途的 exploration 维护作业数：它们是 runtime 子进程，会被中止；single-flight 状态只在内存（`exploration-thread-graph-maintenance-trigger.ts:141`），节流读盘，所以下次 Stop 边沿会重新 fork，浪费一次最多约 $4.5。
  2. 浏览器 WS 以 close code **1012（Service Restart）** 关闭，web-ui 据此显示「Kanban 正在热重启」并重置退避（现在显示的是 "Terminal stream closed. Reconnecting..."，退避上限 5s，见 `persistent-terminal-manager.ts:43-44,1060`）。然后 `server.close()`，等在途 HTTP 请求完成（有上限），新到的 hook 走 spool。
  3. 停掉 dispatcher / scheduler。
  4. 每会话：停流 → 存 mirror checkpoint → 推最终 record。
  5. 调 `detachHostedPtySessionsForRuntimeHandover`（与 `markInterruptedAndStopAll` 并列，绝不发信号）。
  6. ACP 照旧安全停止；Cline 已停止维护，保持现有停止逻辑，不新增适配。
  7. 持久化。
  8. exit 75。
  - 30s 超时则以 exit 1 退出，退化为崩溃路径，依然安全。
- 触发入口：CLI `kanban runtime handover-restart [--wait-for-successor-seconds N]`（`src/commands/runtime-handover-restart.ts`）、tRPC procedure（`api-contract.ts` + `app-router.ts` 双点同步）、SIGUSR2。
- `graceful-shutdown.ts` 的 `onShutdown` 改为接收 `RuntimeShutdownTrigger`。信号触发同样走 detach，退出码保持 130/143；停止时打印保留会话数与终止命令。
- 新 CLI `kanban runtime stop --terminate-hosted-agent-sessions`（`src/commands/runtime-stop-and-terminate-hosted-agent-sessions.ts`）：runtime 在线走 tRPC，离线时直连 host socket。
- 孤儿回收：adoption record 携带 `agentSessionRuntimeReclamationEligibleAt`。runtime 回来后按 exit 记录里的 reason 补记回收账本。
- 仓库外的运维改动（只有这一处）需用户确认后再动：supervisor（`~/Documents/GitHub/tmux-plugins/run-cline-kanban-3484-service.sh`）加 `export KANBAN_AGENT_SESSION_PTY_HOST_MODE=enabled`，退出码 75 时立即重拉。不改也能用：现契约下非 130/143 的退出本就 sleep 5 后重拉。deploy skill 在仓库内，见 P6。

**P5：收尾**
- 持久化 `restartRequest`，让接管后的会话恢复 auto-restart。
- planned handover 后，队列 prompt 不再一律打上「跨重启待确认」：调整 `stale-queued-task-prompt-delivery-startup-sweep.ts`，借鉴 OpenRig outbox 语义，`pending` 照常投递，`sending` 标为不确定、绝不重发。
- hook token 持久化、跨重启稳定（借鉴 OpenRig `activity-endpoint.ts`），据此解除「remote-host 模式强制关闭 host 模式」的限制。token 以 0600 存于 runtime home。
- 资源采样器 / spawn 归因探针识别 host 作为父进程（`task-attributed-process-tree-resource-sampler.ts:109`）。
- `kanban diagnostics agent-session-pty-hosts`。
- 调试入口 `kanban terminal attach <taskId> [--read-only]`：从本机终端直连 host socket，看某个 agent 的实时输出，可选择接管输入。
  - 这是 OpenRig / tmux 式「直接 attach」的等价物。
  - host 为它分配 inspector 槽位，不占 controller 槽；接管输入须显式确认。
- 用 `test/integration/terminal-echo-latency.integration.test.ts` 测 host 模式下多一跳的按键回显延迟。
- 文档：`docs/agent-session-pty-host.md`（含上面的类型可行性表、下面的「宕机窗口信息来源总表」、版本错位契约），`docs/cli-environment.md`，AGENTS.md 加一行指针。另外把「`kanban hooks` 调用面与 spawn env 名只增不改」作为铁律写进 AGENTS.md。

**P6：local deploy skill 适配热重启**（仓库内交付，`.claude/skills/cline-kanban-local-deploy/` 与 `.codex/skills/` 副本，两份现已逐字一致，改完仍须一致）

现状：重启杠杆是 `kill -9 <监听 PID>`。`references/kanban-runtime-upgrades.md` 明说 agent 会随 PTY 挂断而死，并把 "Terminal stream closed" 当作重启的正常代价。热重启落地后这些表述全部过时；更危险的是 SIGTERM 的语义变了。
- **第 1 步盘点**：新增 `kanban diagnostics agent-session-pty-hosts --json`，按三类分列：
  - 将保留：hosted；
  - 将中断：runtime 自持的 PTY、Cline SDK、omp ACP；
  - 将浪费：在途的 exploration 维护作业。
  - 有「将中断」或「将浪费」时先告知用户。在途维护作业默认等其完成再部署。
- **第 4 步重启杠杆决策表**（替换「Preferred restart: supervised kill-by-PID」一节）：

  | 运行中 runtime 的状态 | 杠杆 | 会话结果 |
  |---|---|---|
  | host 模式已启用（diagnostics 显示 controller 已连） | `kanban runtime handover-restart --wait-for-successor-seconds 60` | 全保留，scrollback 连续 |
  | handover procedure 调用失败（例如版本错位） | `kill -USR2 <PID>`；仍失败再 `kill -9 <PID>` | 保留（崩溃路径接管，scrollback 从环形缓冲重放） |
  | **引导部署**：旧 runtime 还不带本功能，或未启用 host 模式 | `kill -9 <PID>`（旧路径） | **全部中断**，需挑空窗、列出受影响任务，并取得用户确认 |

  - 明确警告：**普通 `kill <PID>`（SIGTERM）不再是「停服务」的同义词**。会话会被保留，exit 143 后 supervisor 不重拉，结果是 runtime 停着、agent 继续跑。真要全停用 `kanban runtime stop --terminate-hosted-agent-sessions`。
- **第 5 步验证**（新增，接在现有 listArchive 健康检查之后）：
  - 盘点时记下的每个 hosted 会话：pid 不变，已被新 runtime 接管，summary 没被归零；
  - spool 深度为 0；
  - runtime 日志里没有 adoption 失败；
  - 抽一个任务经 `/api/terminal/control` restore，内容连续。
- **host generation**：host bundle 的 build identity 变了时，新会话进新 generation，旧 host 继续服务存量会话、排空后退出。skill 汇报各 generation 的会话数，并说明「host 侧修复对存量会话不生效，除非重开这些会话」。
- **残余风险汇报**（「Output Expectations」新增两项）：
  - 仍跑在旧启动配置上的会话（`launchedByKanbanBuildIdentity` ≠ 当前），新的 system prompt / hook 配置对它们不生效；
  - 被中止的维护作业。
- **回滚变安全了**：新 runtime 接管失败而陷入崩溃循环时会话不受影响（host 持有）。skill 检测到「N 秒内监听没起来」就回到备份分支重建，再走 handover。补进第 7 步。
  - 同时提示回滚方向的版本错位（见 P3「版本错位」）：回滚后，新 build 起的会话里那些旧 CLI 不认识的 hook 事件会失效。
- 部署演练与验证一律用 HOME 隔离实例：关系账本只追加、不可撤销，绝不能往真实账本里写演练数据。
- 同步改写 reference 里已过时的段落：
  - "What `kill -9 <pid>` does"：hosted agent 不再随之死亡；
  - "Terminal Stream Reality"：hosted 会话的浏览器终端会自动重连到原进程；
  - "Shutdown Guardrail"：SIGTERM 保留会话。
- `kanban deployment record` 增加可选的 `--runtime-restart-method handover|signal|legacy_kill` 与保留 / 中断会话数，写进部署记录，方便事后核对每次部署的打断面。

## OpenRig（`~/Documents/GitHub/openrig`）对照与可借鉴点

OpenRig 的形态：agent 跑在用户默认 tmux server 里，一个 seat 对应一个 tmux session。daemon 只是控制端，每次操作都 exec 一个 `tmux` CLI。
- 读：靠 `capture-pane` 轮询。
- 写：`load-buffer` 后 `paste-buffer -p -r`，再单独 `send-keys Enter`。
- 状态：多证据阶梯（hook、屏幕抓取、`window_activity`）。
- 重启：daemon 重启时 tmux 不受影响，boot 时只把「tmux 里已不存在」的会话标成 detached。没有代码热重载、没有 supervisor；daemon 宕机期间的 hook 尽力而为、直接丢弃。

已吸收的借鉴：
- hook token 持久化 → P5。
- outbox 语义 → P5。
- 「直接 attach」调试入口 → P5 的 `kanban terminal attach`。
- Claude 启动时预分配 `--session-id <uuid>`：丢了 SessionStart hook 也不影响 `--resume`。与热重启正交，列入下方「范围外」另开任务。
- **反面教训**：
  - 每次按键 exec 一次 tmux CLI、靠轮询读，不适合 Kanban 这种强交互终端。
  - web 视图会把 window 固定成 90x27。
  - 默认 tmux socket 会混进用户自己的 tmux 命名空间和 `~/.tmux.conf`。

**字节级逻辑盘点：共 74 项，分 7 类**
- 盘点源于以下代码：`src/terminal/` 下的 terminal-protocol-filter / terminal-state-mirror / terminal-input-box-* / *-readiness / *-workspace-trust / output-reactions / ws-server / session-manager，以及 `web-ui/src/terminal/`。
- 实现时据代码重新核对，连同下表写入 `docs/agent-session-pty-host.md` 的「为何不用 tmux」附录。

| 类别 | 项数 | 自建 host 下 | tmux control mode 下 |
|---|---|---|---|
| A 输出侧协议拦截 / 查询应答 | 8 | 原样不变 | tmux 同步自答 DA / CPR / DSR / DECRQM / XTWINOPS / OSC10/11，mirror 与浏览器自动应答必须关掉，否则 agent 收到重复应答 |
| B 输入侧程序化投递 | 15 | 原样不变 | `send-keys -H` 字节精确；人类 attach 进 copy-mode 会吞掉按键；人类直接打字成为新盲区 |
| C 读屏 | 12 | 原样不变 | mirror 改由 `%output` 喂；pane 尺寸必须与 mirror 一致 |
| D 输出分析 | 10 | 原样不变 | 等价；只有 `%pause` 会造成空洞 |
| E 流控 / 尺寸 / 恢复 | 10 | 原样不变（host 内 pause 即停读 PTY） | 背压失效：tmux 持续读，pause 只会丢数据。需改为始终 drain、每 viewer 分别缓冲；像素尺寸丢失 |
| F 终端身份 / 环境 | 8 | 原样不变 | 会被注入 TMUX / TERM_PROGRAM=tmux / TERM，可用 `-e` 和 `env -u` 掩盖；但 XTVERSION、DA 应答必然暴露「我是 tmux」 |
| G 浏览器 xterm | 11 | 原样不变 | 字节透传，但 agent 可能因识别到 tmux 而换输入模式，Shift+Enter 等需实测 |

**用户已定：host 后端用自建 Node PTY host。**
- 理由：它是透明字节管道，74 项原样保留，agent 看到的终端身份不变，无需对 claude/codex 做行为回归。
- tmux 路线独有的「直接 attach 看 agent」调试能力，由 P5 的 `kanban terminal attach <task>` 补上。

## 范围外 / 顺带发现（建议另开任务，未经代码运行验证）
- hydrate 把所有记录的 `sessionTransport` 覆写成 `pty_terminal`（`session-manager.ts:922`），omp ACP 卡片重启后可能被渲染成终端。原先还记了一条 Cline SDK 重启后发消息的 bug，因 Cline 已停止维护而删除，不修。
- omp ACP 会话的接管（host 的 pipe 型会话）放到后续阶段。
- Claude 启动时预分配 `--session-id <uuid>`（借鉴 OpenRig），减少对 SessionStart hook 回传身份的依赖。

## 验证
- **单元**（precommit-safe，`test/runtime/agent-session-pty-host/`）：
  - 帧编解码：逐字节切分、类型交错、超长拒绝。
  - 环形缓冲：回绕与丢失计数。
  - 路径长度与启用判定。
  - fake spawnPty 下的 host 注册表：断开时清 pause、exit 保留到 ack、retire、孤儿计时。
  - hooks 的 ECONNREFUSED 短路；超时 / reset 耗尽后同样 spool。
  - host spool：相邻 activity 合并、生命周期事件保序、长度有界。
  - 字段处置表、summary 选择层级与 pid 不符拒绝；record schema 版本不识别时退回合成三元组而不杀会话。
  - host bundle 的 import 图守卫。
  - hook argv 跨版本 fixture：录下的各 harness hook 命令行与 stdin 样本仍能被解析。
  - CLI 客户端：仅在 ECONNREFUSED 且有重启证据时等待重试；请求发出后才失败的不重试（无幂等 key 时）。
  - Claude settings 按内容寻址：内容变了写新文件、旧文件不被改动。
- **session-manager**（`test/runtime/terminal/session-manager-hosted-pty-session-adoption.test.ts`）：
  - 追赶字节不推 `lastSubstantiveOutputAt`、不触发 OSC 应答。
  - 窗口内退出在 hook drain 之后才生效。
  - handover detach 绝不调 stop。
  - 接管后读屏补判：窗口内出现的 trust 提示 / 就绪状态被补判到，挂着的 deferred prompt 被投递。
- **hooks ingest**（`test/runtime/trpc/`）：
  - 带 `hookEventCapturedAtEpochMs` 的 Stop 事件晚 2h drain：`stoppedAt` 与回收 `eligibleAt` 都按捕获时刻算；单调 reducer 不被旧值回拉。
  - 同一幂等 key 重复 drain 只应用一次，不派生第二个 decisionId。
  - 「spool 非空」的会话，直投前先 drain 该会话的 spool。
  - 迟到超过 60s 的 to_review 入档但不朗读。
  - spool 晚 2h drain 的 `to_in_progress`：`agentResponseGenerationTurnStarted.startedAt` 取捕获时刻。
  - spool 晚到的压缩完成事件：Cache warm 起点取捕获时刻，手动压缩时 token 数原样保留。
- **计时断言纪律**（`test/README.md`「负载敏感的墙钟 / 资源断言」）：
  - 集成 (A)(B)(C) 与延迟测试中，等待子进程退出 / 等 PTY 输出 / 等接管完成一律用两档期限 helper（`waitForConditionWithinLoadSensitiveTwoTierDeadline`、`waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline`），并闭合外层 timeout。
  - host 的「空闲 200ms 自退」「孤儿回收 5s 升级 SIGKILL」这类单元级计时用假时钟。
  - 「detach 绝不发信号」「追赶字节不进检测器」写成确定性断言，不写成计时。
- **集成**（runtime-integration）：
  - (A) 真 host + `sh` 会话。controller A 粗暴断开 → B 接管：同 pid、tick 不缺不重、spool 有序、exit ack 后清除、空闲按 env 设的 200ms 自退。经 tsx 起、不 daemonize，按 test:policy 传字面量 env。
  - (B) runtime 级（HOME 隔离，关系账本落在临时 HOME）：经 isolated-git fixture 加项目 → shell 会话 → 分别 SIGKILL / SIGTERM runtime → 同端口重启 → pid 不变、snapshot 含 marker、输入可达。
    - handover 变体：断言 exit 75 且 scrollback 完整。
    - SIGTERM 变体：断言退出码 143 且会话存活。
  - (C) host 级：给 host 发 SIGTERM，会话不受影响；无 controller 且 record 的 `eligibleAt` 已过时执行回收，exit 记录带 `reclaimed_by_host_while_runtime_absent`；agent 回合中的会话（无 `eligibleAt`）绝不回收；显式 `terminate_all…` 生效。
- **全量**：`npm run check`、`npm run web:typecheck`、`npm run web:test`；在 Node 24 下跑（better-sqlite3 ABI）。
- **端到端**：按记忆里的隔离实例配方（HOME 覆写 + 写死端口，剥 `CLAUDE_CODE_*` / `KANBAN_*`）起 runtime，跑真 claude 与 codex 各一个 task。
  - 中途执行 `kanban runtime handover-restart`，以及 `kill -9`。
  - 断言 agent pid 不变、轮次继续、Stop hook 落地使卡片进 review、浏览器 restore 内容连续。
  - 窗口内专门制造一次 Stop：断言卡片的停止时刻是窗口内的真实时刻，而不是 drain 时刻。
  - 窗口内在 agent 里跑一次 `kanban task message`：断言等待后成功，而不是报错。
  - **按改写后的 deploy skill 走一遍**：把 isolated 实例当作部署目标，依次走盘点 → 构建 → handover → 验证，确认决策表、诊断输出和验证步骤可照做。
  - 不碰 3484。
- **收尾**：调 `cline-kanban-post-deploy-verification-authoring`，注册部署后才能验的断言。例如首次部署后 3484 上新起的 agent ppid 是 host、host 起的 agent 的 keychain OAuth / ccflare 正常、第二次 handover 前后 pid 不变。
  - 注意：**启用后的首次部署仍会杀掉当时的存量会话**（它们由旧 runtime 持有），需挑空窗。
