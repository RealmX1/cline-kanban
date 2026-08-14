# 跨 harness agent 会话「停止生成后固定宽限期」回收 + 待答用户决策 durable carry-forward：核验与实施计划

> 状态：**规划文档**（仅核验 + 设计，未做任何实现改动、未提交任何实现 commit）。
> 前序交接文档（**待核验参考材料，非已证实规格**）：
> `/Users/bominzhang/Documents/GitHub/cline-kanban/.plan/docs/cline-kanban-multi-harness-session-memory-and-two-hour-grace-period-analysis-handoff.md`

## Context（为什么做这件事）

多个 Claude Code / Codex 等 coding agent 会话长期驻留造成内存压力：现场快照里 6 个 Kanban 托管 Claude 根会话合计 root RSS 2.32 GiB + 后代 5.05 GiB，其中相当部分是**已经停止生成、只是没人去关**的会话。同时用户要保持跨项目快速切换与「我离开一会儿再回来接着聊」的连续性，因此**绝不能**用 viewer 断开 / 浏览器标签关闭 / Electron 项目切换作为回收信号。

目标：给**所有** Kanban 创建的 agent 会话一条统一的领域规则——**agent 最后一次停止生成响应起 2 小时**，到期按 transport 分派做**可核验**的回收；到期时若卡在「普通提问」或「工具授权请求」，把问题 durable 存下来，下次进入 task 主动呈现并把答案幂等送回恢复后的 agent。

---

## 一、交接声明逐条核验

对照基准：本地 `main` = `72d2a550`；部署 commit = `57776dad`（`~/.cline/kanban/last-deployed-source-commit.json`，deployedAt 2026-07-26T08:23:02Z，main 领先 10 个 commit）；运行实例 = tmux `cline-kanban-3484` 的 node 服务。

每条结论标注 **confirmed / corrected / unresolved**。

### 1.1 会话生命周期与部署版本

| # | 交接声明 | 结论 | 证据 |
|---|---|---|---|
| 1 | 部署 commit 为 `57776dad`，2026-07-26 | **confirmed** | `last-deployed-source-commit.json`；`packageVersion 0.1.68`，前驱 `593dd2b6` |
| 2 | `333ff232`（侧栏懒启动 + 僵尸对账）在 main 但不在部署版本 | **confirmed** | `git merge-base --is-ancestor` 双向验证；`hydrateFromRecord` 已含 `reconcileSummaryWithUnrecoverableRunningAgentProcessClaim`（`session-manager.ts:1481-1511`） |
| 3 | 关闭浏览器标签页不回收 agent | **confirmed** | `ws-server.ts:512-519`（io close 只 dispose viewer ioState）、`:620-627`（control close 只解绑 listener）；两处都只走 `cleanupViewerStateIfUnused` |
| 3b | — | **corrected（补充）** | 存在一条 **显式** `stop` 控制消息会调 `terminalManager.stopTaskSession`（`ws-server.ts:599-601`）。那是用户主动点停止，不是 tab close；核验时勿把它误读成 tab-close GC |
| 4 | `use-home-agent-session.ts` 仅在 agent 分段可见时懒启动、且绝不停止已启动会话 | **confirmed** | 该文件 `isHomeSidebarAgentSectionCurrentlyVisible` 门控注释明确「仅门控启动 effect，不门控 descriptor 轮换 / chat 重载 / 卸载清理」 |
| 5 | 仓库中**没有**任何既有的 grace / reclaim / idle-timeout 概念 | **confirmed** | 全库 grep `gracePeriod\|graceDeadline\|reclaim\|idleTimeout\|autoStop` 在 `src/` 下零命中；`web-ui` 的命中全是前端 xterm LRU |

### 1.2 时间戳与状态机

| # | 交接声明 | 结论 | 证据 |
|---|---|---|---|
| 6 | `lastOutputAt` 被 spinner/光标重绘推进，不可作计时源 | **confirmed** | `session-activity.ts:44-48` 注释即以此为设计前提；`SUBSTANTIVE_OUTPUT_ANALYSIS_THROTTLE_MS` 整段注释同证 |
| 7 | `lastSubstantiveOutputAt` ≠「本轮已停止生成」 | **confirmed** | 它只表示「最近一次识别到新正文/工具内容」；`api-contract.ts:527-532` |
| 8 | `updatedAt` 被任意元数据刷新 | **confirmed** | `updateSummary` 漏斗对 metadata-only patch 也刷 |
| 9 | `scanForStalls` 已有「停在交互提示符 + 实质静默 5 分钟」自愈 | **confirmed** | `IDLE_STALL_AUTO_REVIEW_THRESHOLD_MS = 5 * 60_000`（`session-manager.ts:116`）；`attemptIdleStallAutoReview` 双门控（`:2627-2664`） |
| 10 | 双轴 facet 模型 / `resolveSessionFacets` / `isAwaitingUserReviewTurn` 描述 | **confirmed** | `session-activity.ts` 全文；`api-contract.ts:561-637` superRefine 共生护栏 + 末位 transform |
| 11 | `awaitingDispatchedBackgroundWork` 是 park 唯一判据、仅内存态 | **confirmed** | `api-contract.ts:495-513`；`isParkedAwaitingDispatchedBackgroundWork`（`session-activity.ts:351-355`） |

### 1.3 持久化（硬阻塞点）

| # | 交接声明 | 结论 | 证据 |
|---|---|---|---|
| 12 | `sessions.json` 只在 graceful shutdown 写 | **confirmed** | 唯一 writer `savePersistedWorkspaceSessionsById` ← 唯一调用方 `persistSafelyStoppedRuntimeSessionsByWorkspaceId` ← 只被 `shutdown-coordinator.ts:47` 与 `confirmed-project-permanent-deletion.ts:293` 调用 |
| 13 | 因此 crash / `kill -9` / 断电会丢最近状态 | **confirmed** | 同上；且 Cline SDK summary 根本不落 `sessions.json`（只有 terminal manager 走 `hydrateFromRecord`） |
| 12b | — | **corrected（重要量化）** | `sessions.json` 现有 **677 条、1.59 MB**（cline-kanban workspace）。「把 summary 子集改成每次状态边沿持久化」= 每次边沿重写 1.6 MB 并抢 `lockedFileSystem` 锁——直接撞上 AGENTS.md 记录的「锁抖动 → 全服退出」放大器。**结论：必须新建独立小型 durable store，不得提高 `sessions.json` 写频率。** |
| 14 | — | **confirmed（新增可复用先例）** | `src/state/notification-log-store.ts` 已经是一个**事件即时落盘、每 workspace 串行队列、原子写、损坏容错、上限裁剪、路径遍历防护**的存储，且其落库**发生在 runtime-state-hub「0 客户端提前返回」之前**——即已验证的「与 viewer 无关」持久化路径。新 store 逐字照抄这套骨架。 |
| 15 | — | **confirmed（新增可复用先例）** | `task-message-injections.json` + `src/commands/task.ts:1325-1600` 已实现「幂等键 + prompt sha256 + status 生命周期 + 冲突检测」的消息投递账本（现场 171 条）。答案回投直接复用这套语义。 |

### 1.4 hook payload

| # | 交接声明 | 结论 | 证据 |
|---|---|---|---|
| 16 | CLI 已从 stdin 解析完整 JSON，`extractToolInput` 能读结构 | **confirmed** | `hooks.ts:144-174` |
| 17 | `normalizeHookMetadata` 只留摘要 | **confirmed** | `runtimeTaskHookActivitySchema`（`api-contract.ts:451-459`）7 个字段全是 `string｜null`；`toolInput` 只被 `describeToolOperation` 压成一行 `activityText` |
| 18 | `runtimeHookIngestRequestSchema` 不接受 payload；`ingestHookEvent` 不发 `args.payload` | **confirmed** | `api-contract.ts:2253-2258`；`hooks.ts:491-496` |
| 19 | Claude 人轴采集（ExitPlanMode / AskUserQuestion / PermissionRequest），toolName 优先 | **confirmed** | `harness-user-turn-kind-collection.ts:23-45`；Kanban 侧 hook 配置实测存在 `PreToolUse matcher "ExitPlanMode|AskUserQuestion"`（`~/.cline/kanban/hooks/claude/settings.json`） |

### 1.5 各 transport 的 stop 语义

| # | 交接声明 | 结论 | 证据 |
|---|---|---|---|
| 20 | PTY `terminatePtyProcess` 非 Windows 向 `-pid` 发进程组信号 | **confirmed** | `pty-session.ts:53-72`（`process.kill(-pid, SIGTERM/SIGKILL)`），Windows 分支**没有**任何 descendant 处理 |
| 21 | `TerminalSessionManager.stopTaskSession` 发完即返、不等退出 | **confirmed** | `session-manager.ts:2420-2441` |
| 22 | `forceStopTaskSession` = SIGTERM → ≤2s → SIGKILL → 500ms | **confirmed** | `session-manager.ts:2446-2492`；补充：仍不退则 `logTuiFreezeError` 并置 `entry.active = null`，把僵尸留给 OS |
| 23 | ACP `disposeTaskConnection` 只关连接 + 对直接 child 发一次 SIGTERM，无进程组、无升级、无退出确认 | **confirmed** | `acp-client-connection-runtime.ts:280-290` |
| 24 | Cline SDK 依赖 `sessionHost.stop(sessionId)`，`finally` 释放 task MCP bundle | **confirmed** | `cline-session-runtime.ts:341-359` |
| 25 | ACP broker / registry 全内存、无磁盘水合 | **confirmed** | `acp-pending-user-decision-broker.ts:45`（`pendingByDecisionId` Map）；`acp-task-session-registry.ts:1-3` 注释明写「没有从磁盘水合历史那一层」 |
| 25b | `decisionMessageIdByDecisionId` 在 broker 里 | **corrected** | 它在 `acp-task-session-service.ts:137`，不在 broker。结论不变（仍是内存 Map） |
| 26 | `runtime.stopTaskSession` 路由 ACP→Cline→terminal | **confirmed** | `runtime-api.ts:592-633`；注意它还会把同 `workspaceTaskId` 的 by-the-way 会话一并停掉 |
| 27 | Codex 强信号 = `agent-turn-complete` notify + rollout `task_complete` | **confirmed** | `hooks.ts:292`（source 推断）；`codex-hook-events.ts:172/410/646/726`（rollout 解析 + `fingerprint` 去重） |

### 1.6 MCP 内存（本轮实测显著修正交接数据）

| # | 交接声明 | 结论 | 证据 |
|---|---|---|---|
| 28 | user-scope MCP 在每个 session 启动时连接、成为常驻子进程 | **confirmed** | 现场 7/8 个会话在 **t+2s ～ t+37s** 内 spawn 了 5–6 个 MCP 子树 |
| 28b | — | **corrected（新增故障模式）** | 连接是**分波、约 3 个并发、每个 30s 超时**。本会话首个 incarnation（04:33）**6 个 stdio MCP 全部 30s 超时失败、0 子进程**，agent 侧只在 system-reminder 看到 "still connecting"，**静默降级**。日志：`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-*/*.jsonl`。重启后的 incarnation 连上（gitnexus 用了 12.8s）。**即：当前「每 session 全量 eager 连接」策略在机器高负载下会整批静默失败**，这是现状策略自身的可观测缺陷 |
| 29 | 单 MCP tree RSS 表（GitNexus 38–55 MiB、`npm exec` wrapper ~42 MiB、serena 17–43 MiB…） | **corrected** | 交接表是**某一采样时刻的下界**，不是稳定值。8.5 小时后复测同一批 server：gitnexus **95–131 MiB**、serena python **90–95 MiB**、`npm exec` wrapper **85–121 MiB**、context7 **59–75 MiB**。**MCP server footprint 随负载/寿命增长**，任何按交接表做的容量估算都会低估 |
| 30 | 每会话 MCP 子树 median 151 MiB / mean 231 MiB | **corrected** | 当前快照 6 个会话的后代 RSS 分别 640 / 700 / 720 / 872 / 1031 / 1205 MiB；root 292–517 MiB。合计 root 2.32 GiB + desc 5.05 GiB |
| 31 | 浏览器 MCP 真正启动后可能多几百 MiB | **confirmed 且量化** | 一个会话下 Playwright MCP 拉起了完整 Chrome：root 177 MiB + 6 个 helper（renderer 73/112/138、GPU 98、utility 86/61），**合计约 741 MiB**，全部挂在该 Claude 根下。这是「浏览器 MCP 默认加载」唯一被现场量化的成本，支持改 opt-in |
| 32 | `~/.claude.json` 配置与禁用统计 | **confirmed** | 7 个全局 stdio MCP，仅 `gitnexus` `alwaysLoad:true`；105 个 project 记录中 8 个有 `disabledMcpServers`；playwright/chrome-devtools 各被禁 4 次，gitnexus/serena 从未被禁 |
| 32b | Chrome DevTools MCP 现场约 125 MiB | **unresolved** | 本轮**没有任何会话** spawn 过 chrome-devtools（当前 project 已禁用），无法复测 |
| 33 | summed RSS 不可当独占物理内存 | **confirmed 且现场更极端** | 某会话有一个 `ugrep` 子进程 RSS **6.7 GiB**。若按「子树 RSS 求和」口径，它会被算进「会话内存」。**验收必须用 `phys_footprint` + 进程存活性，禁用 summed RSS** |

### 1.7 Bun / JSC footprint 对照（已复测）

| # | 交接声明 | 结论 | 本轮实测（同一 ccflare bun 进程，已运行 1d5h42m） |
|---|---|---|---|
| 34 | footprint ≫ RSS，大量 swapped，主体为 IOAccelerator slab | **confirmed** | `phys_footprint 3058 MB`（peak 3172 MB）、`ps RSS 409 MiB`、`vmmap` Writable written 3.2 GiB / resident 287 MiB / **swapped 2.9 GiB**；`footprint -p` 分类：**IOAccelerator 2955 MB dirty / 40 regions**、WebKit malloc 61 MB、JS VM Gigacage 15 MB dirty + 143 MB reclaimable、SQLite page cache 20 MB reclaimable |
| 35 | 该样本不使用 Ink/TUI，故 IOAccelerator ≠「终端 GPU compositor 泄漏」的充分证据 | **confirmed** | 同上（该进程是纯 HTTP server） |
| 36 | 结论：成功指标应是「减少长期存活进程数」，process exit 才确定性释放 | **confirmed 且被 #29 强化** | MCP server 自身 footprint 也随寿命单调增长 → 进程退出是唯一确定性释放手段 |
| 37 | 「17 个会话停 12 个，summed RSS 9.93→5.23 GiB」 | **unresolved** | 无法复现该时刻采样（本轮最多观察到 8 个）。方法论结论保留，**数字不可复用**（且口径本身受 #33 污染） |

---

## 二、本轮用户拍板（覆盖交接与原始任务书）

1. **宽限期统一为 2 小时**，且**统一适用**于：task 会话、sidebar 项目会话（`__home_agent__:*`）、以及 `error` / `interrupted` / `failed` 等人回合。→ 单一常数、零 per-kind 分档。
   （实施期间曾一度定为 1 小时，最终用户拍板回到 2 小时。）
2. **sidebar 项目会话纳入**同一条规则。
3. **park**：不走 1 小时；给**独立 24 小时默认兜底**，且必须提供**显式绕过**（长任务）与**续期**能力；到期不是静默杀，走可审计的 `park_abandoned`。
4. **permission（工具授权请求）**：与普通问题一样做 **durable 重现**，但**独立 kind**、不混型。
5. **plan_review**：**不做** carry-forward（与原始约束一致）。

### 2.1 用户提出的四个前置问题（答案）

**Q1/Q2：既有的「离开 focus view 后再进入需要长时间导入」与本次规划是同一件事吗？各自是什么？**

不是同一件事，两者**正交**：

| 维度 | 既有：前端 xterm parked LRU | 本次规划：服务端会话回收 |
|---|---|---|
| 代码位置 | `web-ui/src/terminal/persistent-terminal-manager.ts:1114-1132` | 服务端新增模块（§五、§六） |
| 回收对象 | 浏览器内的 xterm 实例 + scrollback | agent OS 进程 / SDK 会话 / ACP 连接 + 其 MCP 后代 |
| 触发条件 | **计数式**：parked 终端超过 `MAX_PARKED_TERMINALS = 2` 时丢最久未用的（**无时钟、无 timeout**） | **时钟式**：停止生成后 1 小时 |
| 触发者 | viewer 行为（切 task / 切项目） | **完全与 viewer 无关** |
| 再进入表现 | 重新拉快照 → 「导入慢」的实际来源 | 会话已不存在，需重新启动 |

**即：既有机制从不碰 PTY / agent 进程 / MCP，本次规划从不因 viewer 行为触发。** 两者不会互相干扰。但回收后重进时，**UI 必须明说「会话已被回收」**，而不是让用户看到一个空终端以为只是导入慢——这是 S4 的强制交付项。

**Q3/Q4：各自 timeout 多久、从什么时刻起算？**

- 既有 parked LRU：**没有 timeout**，纯计数淘汰。
- 本次规划：**2 小时**，从「进入非生成态」这一**离散状态转移**起算（四类锚点见 §3.2），**不是**从 `lastOutputAt` / `lastSubstantiveOutputAt` / `updatedAt` 任何一个既有时间戳反推。
- 其余既有时间常数（2s / 5s / 45s / 5min / 5min）全部保留、职责不变，见 §3.4 对照表。

**Q5：park 的触发机制是什么？会误触发吗？超过 24h 的合法长任务怎么办？** → 见 §八。

---

## 三、领域模型

### 3.1 四个正交概念（必须分开命名，禁止互相推断）

| 概念 | 含义 | 真相源 |
|---|---|---|
| `AgentTurnLifecycle` | 这一轮归谁、agent 是否在生成 | 既有三 facet（`turnOwner` / `liveness` / `userTurnKind`） |
| `AgentSessionRuntimePresence` | 这个会话此刻是否还占着 OS 进程 / SDK 会话 / ACP 连接 | `sessionTransport` + `pid` + 各 service 账本 |
| `AgentSessionRetentionDeadline` | 「不生成」状态已持续多久、何时可回收 | **新增**，durable |
| `ViewerAttachment` | 谁在看 | `ws-server` viewer state —— **本模型中它对前三者零影响，且必须有断言守住这条** |

### 3.2 新领域事件与派生量

```text
agentResponseGenerationStopped            # 离散事件，非「最后输出时间」反推
  ├─ agentResponseGenerationStoppedAt     # epoch ms
  ├─ stopSignalConfidence: harness_turn_complete | structured_user_turn | session_ready_never_prompted | prompt_ready_fallback
  ├─ runtimeSessionIncarnationId          # 每次真实 spawn/连接生成的 uuid
  └─ agentResponseGenerationTurnSequence  # 每次用户提交/新 agent 回合单调 +1

agentSessionRuntimeReclamationEligibleAt
  = agentResponseGenerationStoppedAt
  + AGENT_SESSION_RUNTIME_RECLAMATION_GRACE_PERIOD_AFTER_RESPONSE_GENERATION_STOPPED_MS   # = 2 * 60 * 60_000
```

**关键设计决定（对交接的一处修正）**：交接警告「从未真正开始过用户 turn、`Ctx: 0` 的空 sidebar 会话不应获得假的 `stoppedAt`」。但用户要求这类空闲 sidebar 会话**正是**要被回收的对象。解法不是伪造时间戳，而是把锚点定义为**「进入非生成态」这一状态转移**，其合法来源有四类（按置信度降序）：

1. `harness_turn_complete` — Claude `Stop` / Codex `agent-turn-complete` + rollout `task_complete` / Gemini `AfterAgent` / droid·kiro `TaskComplete` / ACP `session/prompt` resolve / Cline SDK 回合结束事件；
2. `structured_user_turn` — facet 转移到 `turnOwner==="user"`（含 question / permission / plan_review / review / needs_input / error / interrupted）；
3. `session_ready_never_prompted` — 会话已就绪但从未收到过任何用户提交（`turnSequence === 0`）→ 锚点 = **就绪时刻**。**这一条精确覆盖空闲 sidebar 会话，且不伪造任何「输出」语义**；
4. `prompt_ready_fallback` — 既有 `scanForStalls` 的 idle_stall 自愈（5 分钟停在交互提示符）翻入 user 回合后顺带产生，最低置信度。

**永不产生锚点**（即时钟不跑）的情形：`turnOwner==="agent"` 且未 park；`isParkedAwaitingDispatchedBackgroundWork` 为真（走 park 独立轨道）。

### 3.3 状态机

```text
                 ┌──────────────── agent 回合（生成中）────────────────┐
                 │  turnOwner=agent ∧ ¬parked                          │
                 │  → 无 deadline；任何既有 deadline 立即作废           │
                 └───────┬─────────────────────────────────────────────┘
                         │ 进入非生成态（四类锚点之一）
                         ▼
      ┌── GracePeriodRunning ───────────────────────────────────────┐
      │ eligibleAt = stoppedAt + 2h（绝对时刻，durable）             │
      │ 触发条件：viewer 状态完全无关                                 │
      └───┬───────────────────────┬──────────────────────┬──────────┘
          │ 用户提交/agent 复生    │ park 置位            │ 到期
          ▼                       ▼                      ▼
     deadline 作废          切到 park 轨道         Reclaiming（transport-aware）
     turnSequence+1         （24h 或显式期限）           │
     新 incarnation                                      ▼
                                            ┌── Reclaimed ──────────────┐
                                            │ 会话进程/连接已确认退出     │
                                            │ 卡片显式标注「已回收」      │
                                            │ 待答决策已 durable 留存     │
                                            └───────────────────────────┘
                                                         │ 用户回到 task / 回答问题
                                                         ▼
                                            Resumed（新 incarnation，
                                            答案经幂等键投递一次）
```

### 3.4 与既有时间常数的关系（全部保留，互不替代）

| 常数 | 值 | 读什么 | 作用 |
|---|---|---|---|
| `MAX_PARKED_TERMINALS`（前端） | 2（**计数式，无时钟**） | — | 只回收浏览器 xterm，不碰进程 |
| `AGENT_OUTPUT_QUIET_THRESHOLD_MS` | 2s | `lastOutputAt` | 自动续跑注入门控 |
| `VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS` | 5s | `lastSubstantiveOutputAt` | Validation 列自动打回 |
| `DEFAULT_STALL_THRESHOLD_MS` | 45s | `lastOutputAt ?? startedAt` | 仅打 `[tui-freeze]` 日志 |
| `RECENTLY_ACTIVE_IN_PROGRESS_WINDOW_MS` | 5min | `lastOutputAt` | Active/Stale 二分 |
| `IDLE_STALL_AUTO_REVIEW_THRESHOLD_MS` | 5min | `lastSubstantiveOutputAt ?? startedAt` | 自愈翻入 user 回合 |
| **新增** `…GRACE_PERIOD…_MS` | **2h** | **离散停止事件** | **回收 agent 进程 + MCP 后代** |
| **新增** `…PARK_ABANDONED_DEFAULT_MAX_RETENTION_MS` | **24h** | park 置位时刻 / 最近一次 renew | park 兜底 |

---

## 四、Schema 与 durable store

### 4.1 `RuntimeTaskSessionSummary` 加性可选字段（`src/core/api-contract.ts`）

```ts
runtimeSessionIncarnationId: z.string().nullable().optional(),
agentResponseGenerationTurnSequence: z.number().int().nonnegative().optional(),
agentResponseGenerationStopped: z.object({
  stoppedAt: z.number(),
  signalConfidence: z.enum([
    "harness_turn_complete","structured_user_turn",
    "session_ready_never_prompted","prompt_ready_fallback",
  ]),
  turnSequence: z.number().int().nonnegative(),
}).nullable().optional(),
agentSessionRuntimeReclamationEligibleAt: z.number().nullable().optional(),
agentSessionRuntimeReclamationOutcome: runtimeAgentSessionReclamationOutcomeSchema.nullable().optional(),
```

**铁律遵守**：这些全是 metadata-only sidecar（与 `connectionRetry` / `awaitingDispatchedBackgroundWork` 同侧），**不参与 facet、不进 superRefine**；写入必须经两个 `updateSummary` 漏斗，**绝不手写 `state:`**，也绝不裸写单个 facet 字段。

`awaitingDispatchedBackgroundWork` 扩两个可选字段：`maxRetentionUntilMs: number | null`（`null` = 显式无期限）、`lastRenewedAtMs`。

### 4.2 两个新 durable store（骨架逐字照抄 `notification-log-store.ts`）

**A. `src/state/agent-session-reclamation-deadline-store.ts` → 每 workspace `agent-session-reclamation-deadlines.json`**

```ts
{ taskId, agentId, sessionTransport, runtimeSessionIncarnationId,
  agentResponseGenerationTurnSequence, stoppedAt, signalConfidence,
  eligibleAt,                       // 绝对时刻，禁止存「剩余时长」
  parkMaxRetentionUntilMs: number | null,
  reclamationState: "grace_running" | "reclaiming" | "reclaimed" | "reclaim_failed" | "superseded",
  reclamationAttemptCount, nextReclaimRetryAt, lastReclaimError,
  schemaVersion: 1 }
```

- 每 task 至多一条 live 记录；新 incarnation / 新 turnSequence 到来即把旧记录置 `superseded`。
- 写入时机：进入非生成态、离开非生成态、park 置/清、回收开始/结束/失败。频率是**人类尺度事件**（分钟级），不是每次 PTY 输出。
- 上限裁剪 + 损坏容错 + `getWorkspaceDirectoryPath` 路径遍历守卫，全部照抄。

**B. `src/state/agent-raised-pending-user-decision-store.ts` → 每 workspace `agent-raised-pending-user-decisions.json`**

```ts
{ decisionId,                      // 稳定去重键
  taskId, workspaceId, agentId, sessionTransport,
  decisionKind: "ordinary_user_question" | "tool_permission_request",   // ← plan_review 在类型上就不存在
  questionMarkdown,                // 问题正文
  options: [{ optionId, label, description? }],
  allowsFreeformAnswer: boolean,
  askedAt, graceDeadlineAt, reclaimedAt: number | null,
  originRuntimeSessionIncarnationId, originTurnSequence,
  sourceHarnessSignal,             // "claude:AskUserQuestion" / "cline:ask_followup_question" / "acp:session/request_permission" …
  status: "pending" | "answered" | "dismissed" | "superseded",
  supersededByDecisionId: string | null,
  answer: { selectedOptionIds: string[], freeformText: string | null, answeredAt } | null,
  answerDeliveryState: "not_answered"|"answer_recorded"|"delivery_in_progress"|"delivered"|"delivery_failed",
  answerDeliveryIdempotencyKey,    // 复用 task-message-injections 的语义
  payloadSchemaVersion: 1 }
```

**为什么不复用 `sessions.json`**：见 §1.3 #12b（677 条 / 1.59 MB / 锁抖动放大器）。
**为什么不上 SQLite**：仓库现有全部状态都是 per-workspace JSON + `lockedFileSystem`，引入第二种存储引擎会分裂备份 / 迁移 / 锁模型；数据量（每 workspace 几十条）远未到需要索引的规模。

### 4.3 hook payload 契约（最短可靠路径）

新增 `runtimeHookIngestRequestSchema.ordinaryUserQuestionPayload`（可选），**白名单字段**，由 `kanban hooks ingest` 在 `source==="claude" && toolName ∈ {AskUserQuestion}` 时从已解析的 stdin JSON 提取：

```ts
{ questionMarkdown: string,
  options: Array<{ optionId: string, label: string, description?: string }>,
  allowsFreeformAnswer: boolean,
  multiSelect: boolean,
  toolUseId: string }
```

- **不传整个 hook JSON**，**不从 ANSI 快照抓取**。
- 字段名以真实 `AskUserQuestion` hook payload fixture 锁定（见 §十一 T-payload）。
- 与之对称：permission 走 `toolPermissionRequestPayload`（工具名 + 参数摘要，**不含参数正文**）。

### 4.4 兼容性迁移

- 三个 store 全部 `schemaVersion: 1` 起步；读侧 `safeParse` 失败一律按空处理（fail-open，宁可少回收）。
- summary 新字段全 `.optional()`，旧 `sessions.json` 记录水合后为 `undefined` → 首个停止事件才补齐，**无需一次性迁移脚本**。
- 首次上线时既有会话没有 `runtimeSessionIncarnationId`：`hydrateFromRecord` 为其生成一个新 incarnation id，并**不**给它 deadline（等下一次停止事件），避免上线瞬间批量回收。

---

## 五、各 transport 的停止信号映射（归一化为单一领域事件）

| transport / agent | 强信号 | 落地点 | 兜底 |
|---|---|---|---|
| terminal · claude | `Stop` hook → `to_review` | `hooks-api.ts` ingest 后置钩 | `scanForStalls` idle_stall |
| terminal · codex | notify `agent-turn-complete` + rollout `task_complete`（已按 `fingerprint` 去重） | 同上 | 同上 |
| terminal · gemini | `AfterAgent` → `to_review` | 同上 | 同上 |
| terminal · droid / kiro / opencode / cursor / kimi | 各自 `Stop` / `TaskComplete` / `AfterAgent` | 同上 | 同上 |
| native Cline SDK | 回合结束事件 | `cline-event-adapter.ts` → `cline-session-state.ts` `updateSummary` 漏斗 | 无需（结构化） |
| ACP · omp | `connection.prompt()` resolve（`applyAcpPromptTurnCompletion`） | `acp-task-session-service.ts` | 无需（结构化） |

**归一化观察器位置（架构关键）**：放在 `src/server/runtime-state-hub.ts` 内，与既有 `isNotifiableUserTurn` 边沿检测**并列**。理由：

- 它已经**同时订阅**三种 transport 的 summary 流（`trackTerminalManager` + `trackConversationTaskSessionService("cline"|"acp")`），是全仓唯一的跨 transport 汇聚点；
- 它的持久化**已经证明发生在「0 客户端提前返回」之前**（`notification-log-store` 注释与代码结构），天然满足「与 viewer 解耦」；
- 缺口：`trackTerminalManager` 目前只做广播、不做边沿检测（终端的 to_review 通知走 `hooks-api`）。本计划把终端流也接入同一个边沿检测器，**三种 transport 走同一段代码**。

新模块：`src/server/agent-session-response-generation-stop-observer.ts`（纯边沿检测 + 落库，无 IO 之外副作用）。

---

## 六、transport-aware reclaim

新模块 `src/server/transport-aware-agent-session-reclamation.ts`，按 `getRuntimeAgentSessionTransport(agentId)`（`src/core/agent-catalog.ts:150`）分派，**统一返回可审计结果**：

```ts
interface RuntimeAgentSessionReclamationOutcome {
  taskId; runtimeSessionIncarnationId; sessionTransport;
  attemptedAt; completedAt;
  rootProcessExitConfirmed: boolean;
  descendantProcessesExitConfirmed: boolean;
  survivingDescendantPids: number[];
  usedForcefulEscalation: boolean;
  releasedResources: string[];        // "pty" | "terminal_state_mirror" | "cline_mcp_tool_bundle" | "acp_connection" | ...
  failureReason: string | null;
  nextRetryAt: number | null;
}
```

### 6.1 `pty_terminal`

复用 `forceStopTaskSession`（已有 SIGTERM→2s→SIGKILL→500ms 升级），**外加**：

- 回收前快照 `pgid` 与后代 pid 集合（`ps -Ao pid,ppid` 一次，按 pid 树展开——注意 §1.6 #33 的 `ugrep` 教训：**只用于存活性判定，不做 RSS 求和**）；
- 回收后用 `process.kill(pid, 0)` 逐个复核；仍存活则再对 `-pgid` 发一次 SIGKILL 并复核；
- **Windows**：`terminatePtyProcess` 的 win32 分支没有 descendant 处理。复用仓库已有依赖 `tree-kill`（`src/server/process-termination.ts` 已在用），在 win32 走 `treeKill(pid, "SIGTERM")` → 超时 → `treeKill(pid, "SIGKILL")`，并以 `tasklist` 复核。
- 释放 `TerminalStateMirror`（20k 行 scrollback，每会话一份）。

### 6.2 `acp_stdio_subprocess`

当前 `disposeTaskConnection`（`acp-client-connection-runtime.ts:280-290`）明显不足，需补：

1. `cancelPendingDecisions(taskId)`（已有，ACP 规范硬性要求——否则 agent 侧永远挂着等回复）；
2. `session/cancel` → 等待 agent 收束（短超时）；
3. `connection.close()`；
4. `child.kill("SIGTERM")` → **改为进程组**：spawn 时加 `detached: true` 以获得独立 pgid，回收时 `process.kill(-pid, ...)`（与 PTY 同构）；
5. 超时升级 SIGKILL + 退出确认（监听 `child.on("exit")` 与 `kill(pid,0)` 双保险）。

> 注：`detached: true` 会改变 Ctrl-C 传播语义，需同步检查 `disposeAllTaskConnections` 与 graceful shutdown 路径。这是 ACP 侧唯一有回归风险的改动，**单独切片、单独测试**。

### 6.3 `in_process_cline_sdk`

无 OS 进程（`pid` 恒 null）。回收 = `sessionRuntime.stopTaskSession(taskId)` → `sessionHost.stop(sessionId)` + `finally` `releaseTaskMcpToolBundle`（已有）+ 清 message repository 的内存条目。审计结果中 `rootProcessExitConfirmed` 语义改为「SDK 会话已 stop 且 tool bundle 已释放」，并在字段上明确标注 `sessionTransport` 以免误读。

### 6.4 调度器与重启恢复

`src/server/agent-session-inactivity-reclamation-scheduler.ts`：

- 启动时扫描所有 workspace 的 deadline store：`eligibleAt > now` → 纳入 tick 判定；`eligibleAt <= now` 且 incarnation/turnSequence 仍未被 supersede → **立即执行一次幂等回收**；`superseded` / `reclaimed` → 跳过。
- 因为存的是**绝对 `eligibleAt`**，Kanban / OS 停机期间流逝的墙钟时间自然计入。
- 单一 `setInterval`（60s tick）而非每 task 一个 timer——避免大量 timer 与 `unref` 管理；tick 时按 store 快照批量判定。
- **旧 timer 防护**：触发时必须重新比对 `(runtimeSessionIncarnationId, agentResponseGenerationTurnSequence)` 与当前 summary、以及当前 facet（是否已回到 agent 回合）与 pid；任一不匹配 → 记 `superseded`，**绝不回收**。

---

## 七、待答用户决策 carry-forward

### 7.1 记录时机

**在 agent 提问的那一刻**就落 durable 记录（不是等到期才落），这样 crash / `kill -9` 也不丢：

- **Claude terminal**：`hooks-api.ts` ingest 到 `toolName==="AskUserQuestion"` 且带新 payload → 落 `ordinary_user_question`；`PermissionRequest` → 落 `tool_permission_request`。
- **Cline SDK**：`cline-event-adapter.ts` 的 `tool-started` 已直接拿到 `toolCall.input`（`ask_followup_question` / 权限工具）→ 投影成同一记录。**注意**：以结构化 input 为真相，**不得**把某条展示用 markdown 消息当领域真相。
- **ACP**：`AcpPendingUserDecisionBroker.awaitUserResolution` 呈现决策时同步落库（`tool_permission` → `tool_permission_request`；`elicitation_form` 当前只服务 omp plan approval → **按用户决定不落 carry-forward 记录**）。
- **`plan_review` 在 `decisionKind` 枚举里不存在**——类型层面就杜绝冒充。

### 7.2 到期回收时

回收前：把该 task 所有 `status==="pending"` 记录标 `reclaimedAt`；ACP 侧先 `cancelPendingDecisions`（否则 agent 挂死）。

### 7.3 用户回来时

- Focus View 顶部 + 卡片徽标显式呈现 pending 决策（**不依赖恢复旧 TUI scrollback**），问题正文 + 结构化选项 + 是否允许自由文本，措辞按 `decisionKind` 分型（「agent 有一个问题」vs「agent 请求工具授权」）。
- 新增 tRPC：`runtime.listAgentRaisedPendingUserDecisions` / `runtime.answerAgentRaisedPendingUserDecision`。

### 7.4 回答后的投递顺序（严格）

1. **原子**写 `answer` + `answerDeliveryState="answer_recorded"`，同时把该 task 的 deadline 记录置 `superseded`（**先作废计时，再动进程**）；
2. 恢复 / 新建 agent 会话（terminal：走既有 resume 分支，`resumesPriorAgentConversation=true`；ACP：新连接；Cline SDK：`rebindPersistedTaskSession`）；
3. 用稳定 `answerDeliveryIdempotencyKey` 投递「原问题 + 用户答案 + 必要上下文」——terminal 走 `submitTaskChatInputWhenReady`（**注意它要求 `entry.active` 存在，所以必须在第 2 步之后**），Cline / ACP 走各自 sendInput；
4. 投递成功 → `delivered`；失败 → `delivery_failed` + 退避重试，**绝不重复投递**（幂等键守门，语义与 `task-message-injections.json` 一致）。

即使无法无损恢复原进程，agent 也不必重新发问——UI 展示的是 durable 记录，答案作为一条明确的 continuation 进入新会话。

---

## 八、park 兜底（用户点名的两个问题）

- **触发机制**：park **无任何启发式**，唯一入口是外部编排显式调 `kanban task park` → tRPC → `parkTaskSessionAwaitingDispatchedBackgroundWork`（`session-manager.ts:1339`）。目的：主 agent 派发后台任务后结束本轮时 Claude 只发裸 `Stop`，没有 park 会被误判「等人审查」并误发通知，同时 `scanForStalls` / 自动续跑 / 重启守卫也会误判。→ **不存在普通聊天被误 park**。
- **解除路径**（三条）：`submitTaskChatInputWhenReady`（RVF followup）、`UserPromptSubmit` hook（人工手敲）、显式 `kanban task unpark`。另有 `hydrateFromRecord` 在进程重启时清除陈旧 park sidecar（park 是纯内存态）。
- **>24h 的合法长任务**：`kanban task park` 增 `--max-retention <duration>` 与 `--no-expiry`，写进 sidecar 的 `maxRetentionUntilMs`（`null` = 无期限）；另加 `kanban task park --renew` 心跳续期。**24h 只是未声明时的默认**。
- **到期行为**：不是静默杀。走 `park_abandoned` 回收，写审计结果，卡片明示「后台工作失联，会话已回收（worktree / 提交 / 消息历史均保留）」。

---

## 九、Failure model

| 故障 | 行为 |
|---|---|
| hook 丢投 / harness 改工具名 | 无强信号 → 落到 `prompt_ready_fallback`（5min idle_stall）；`logUserTurnKindCapture` 的 unclassified 结构化日志继续暴露漂移 |
| agent 卡在 agent 回合但实际已死（漏 hook 且不在提示符） | **不回收**（保守）。仅在卡片打诊断徽标。见 §十四 未决 #1 |
| deadline store 损坏 | 照 `notification-log-store` 语义：解析失败按空处理，不阻断启动；本轮不回收（fail-open，宁可留进程） |
| 回收失败（SIGKILL 后仍存活） | `reclaim_failed` + 指数退避重试（4s→…→30min 封顶），审计里带 `survivingDescendantPids` |
| 回收中 Kanban 崩溃 | 重启扫描看到 `reclaiming` 状态 → 重新执行幂等回收 |
| 并发：到期同时用户提交 | 投递路径先作废 deadline 再动进程；调度器触发时二次比对 incarnation/turnSequence，双向互斥 |
| ACP pending decision 未回 | 回收前必调 `cancelPendingDecisions`；已有单测覆盖点扩展 |
| 会话被回收但 worktree 有未提交改动 | **不受影响**——回收只杀进程，不动文件；UI 明示 |
| MCP 整批连接超时（§1.6 #28b） | 与本机制正交；但回收后重启会话是重新连接 MCP 的一次机会，不额外处理 |

---

## 十、安全与隐私

- 问题正文与选项**只**写入 `agent-raised-pending-user-decisions.json`（与 board/sessions 同目录、同权限），**绝不**进普通诊断日志、`[user-turn-kind]` 日志或 `latestHookActivity`。
- `tool_permission_request` 只存工具名 + 参数**摘要**，不存参数正文（避免落盘命令行 / 路径 / 密钥）。
- 新 store 路径解析复用 `notification-log-store.ts` 的「必须是 workspaces 根的直接子目录」守卫。
- 不新增任何网络出站；不引入 OTel。
- MCP 使用基线采集（若做）：`PostToolUse` / `PostToolUseFailure` matcher `mcp__.*`，**只**落 server/tool 名、session/workspace、`tool_use_id`、outcome、`duration_ms`，不落 input/output 正文。

---

## 十一、自动化测试矩阵

**单元（vitest，`test/runtime/`）**

- `agent-session-response-generation-stop-observer.test.ts`：四类锚点各自产生一次事件；agent 回合不产生；park 不产生；重复边沿不重复落库。
- `agent-session-reclamation-deadline-store.test.ts`：绝对 `eligibleAt`；supersede；损坏容错；上限裁剪；路径遍历拒绝；并发 append 串行化。
- `agent-session-inactivity-reclamation-scheduler.test.ts`：重启恢复三分支（未到期重排 / 已到期立即执行 / 已 supersede 跳过）；旧 timer 不杀新 incarnation（incarnation 变、turnSequence 变、facet 回 agent、pid 变四种独立用例）。
- `transport-aware-agent-session-reclamation.test.ts`：三 transport 各自的审计结果形状；PTY 强杀升级；ACP pending decision 取消；Cline tool bundle 释放；Windows 分支走 `tree-kill`（注入替身）。
- `agent-raised-pending-user-decision-store.test.ts`：幂等键；`plan_review` 在类型上不可构造；投递状态机顺序；重复回答不重复投递。
- **T-payload** `claude-ask-user-question-hook-payload.test.ts`：用**真实** `AskUserQuestion` hook payload fixture 锁定字段名，覆盖单选 / 多选 / 自由文本三形态；断言正文与选项**不出现**在任何日志断言里。
- 既有回归：`session-facets.test.ts` 全表等价必须仍绿（新字段是 sidecar，不得触碰 superRefine）。

**集成**

- 三 transport 各一条「假时钟推进 2h → 回收 → 审计确认 root + descendant 退出」。
- **viewer 解耦断言**：反复 attach/detach control + io WebSocket、切 workspace、模拟 tab close，deadline 与回收行为**零变化**。
- park：默认 24h 到期；`--max-retention` / `--no-expiry` 不到期；`--renew` 续期。

**不做**：不通过代理向真实 Anthropic endpoint 发请求（用户明令）。所有 harness 交互用 fixture / 假 PTY / 假 ACP stdio。

---

## 十二、Post-Deploy Verification（AGENTS.md 强制入口）

实现收尾、进入 RVF 前**必须**调用 skill `cline-kanban-post-deploy-verification-authoring`，注册至少：

1. **自动脚本型**：部署后按 `~/.cline/kanban/workspaces/*/agent-session-reclamation-deadlines.json` 抽样，核对 `eligibleAt - retentionAnchorAt === 7200000`。
2. **自动脚本型**：制造一个真实 idle 会话，快进（或用测试用配置缩短窗口）后核对 root pid 与全部 descendant pid 均已消失（`kill(pid,0)` 报 ESRCH），并记录回收前后 `phys_footprint`（**不用 summed RSS**）。
3. **引导人工型**：关浏览器标签 / 切项目 / 折叠 sidebar 各一次，确认 deadline 与会话均不受影响。
4. **引导人工型**：真实触发一次 `AskUserQuestion`，等到期回收，重进 task 确认问题正文 + 选项被完整呈现、回答后被送回恢复的 agent 且**只送一次**。

---

## 十三、分阶段交付

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| S0 | schema 加性字段 + 两个 durable store + 单测 | store 单测 |
| S1 | 停止事件观察器（三 transport 接同一边沿检测）+ incarnation / turnSequence | 事件落库正确、viewer 无关 |
| S2 | 调度器（含重启恢复、旧 timer 防护）。dry-run 执行器已实现并保留，但**用户拍板直接上线真实回收**，故生产接线用 transport-aware 执行器 | 逐条审计记录 |
| S3 | transport-aware reclaim：PTY（含 Windows tree-kill）→ Cline SDK → ACP（`detached` 改动单独切片） | 逐 transport 退出确认 |
| S4 | 真实回收已默认生效；审计结果写回 summary sidecar（UI 徽标数据源）。设置项（时长可调 / 全局开关）按 §十四 #2 仍未决、未实现 | 端到端 |
| S5 | pending 决策 durable 记录 + hook payload 契约 + Focus View 呈现 + 幂等回投 | 端到端 |
| S6 | park 兜底（24h 默认 + `--max-retention` / `--no-expiry` / `--renew`） | park 三分支 |
| S7 | RVF 前 Post-Deploy Verification 编写 | 面板 |

dry-run 执行器（`createDryRunAgentSessionReclamationExecutor`）保留在代码里未删：日后若要加全局开关，「关」的那一档就直接接它，无需重写。

---

## 十四、明确的未决产品决策（不在本计划内擅自拍板）

1. **卡在 agent 回合的僵尸会话**（漏 hook 且从不停在交互提示符）目前**永不回收**。是否需要一条更保守的二级看门狗（例如 agent 回合 + 实质输出静默 6h + 进程 CPU 近零 → 打标而非回收）？
2. **回收时长是否暴露为设置项**，以及是否允许 per-task 覆盖（例如「这个任务我要留着」）。当前实现为编译期常量 2 小时，未接设置链路。
3. 回收后**是否自动重启**会话（当前设计：不自动，等用户回来才起）。
4. 浏览器 MCP 改 opt-in 的具体形态（全局 `disabledMcpServers` 加 playwright / chrome-devtools + 需要时项目级开启，vs. 依赖 Claude Code 未来的 lazy 能力）——现场已量化成本 741 MiB，但这属于**用户环境配置**而非 Kanban 代码改动，需确认是否要 Kanban 代管。
5. 其余 MCP **保持现状**（用户明令）；`npx` / `npm exec` wrapper 去除、Streamable HTTP 共享 daemon 等**不进本计划**。
6. ACP 迁移**不进本计划**，仅保留抽象边界。

---

## 十五、非目标（防误解）

- 不实现「最后一个 viewer 断开后 N 分钟停止」。
- 不把 Electron project switch / sidebar 折叠 / tab close 当 session close。
- 不把「没人看」当「agent 没在干活」。
- 不广泛移除或禁用 MCP。
- 不把 plan approval 当普通问题 carry-forward（类型层面杜绝）。
- 不用 summed RSS 宣称同等独占物理内存。
- 不提高 `sessions.json` 的写入频率。

---

## 十六、关键文件

**改动**：`src/core/api-contract.ts`、`src/core/session-activity.ts`（新谓词）、`src/server/runtime-state-hub.ts`（接入终端流的边沿检测）、`src/terminal/session-manager.ts`（incarnation / turnSequence、park 期限）、`src/acp-client-session/acp-client-connection-runtime.ts`（进程组 + 升级 + 退出确认）、`src/cline-sdk/cline-session-runtime.ts`（审计结果）、`src/trpc/hooks-api.ts` + `src/commands/hooks.ts`（问题 payload 契约）、`src/trpc/runtime-api.ts`（新 tRPC）、`web-ui/src/components/card-detail-view.tsx` 及 `detail-panels/`（pending 决策呈现）、`web-ui/src/components/task-card-body.tsx`（已回收徽标）。

**新增**：`src/state/agent-session-reclamation-deadline-store.ts`、`src/state/agent-raised-pending-user-decision-store.ts`、`src/server/agent-session-response-generation-stop-observer.ts`、`src/server/agent-session-inactivity-reclamation-scheduler.ts`、`src/server/transport-aware-agent-session-reclamation.ts`。

**复用（不要重写）**：`notification-log-store.ts` 的存储骨架、`src/commands/task.ts:1325-1600` 的幂等投递账本、`process-termination.ts` + `tree-kill` 依赖、`forceStopTaskSession` 的升级逻辑、`submitTaskChatInputWhenReady` 的就绪投递、`getRuntimeAgentSessionTransport` 的三态分派。

---

## 十七、2026-08-13：跨重启恢复误续跑补充实现

针对真实轨迹「Claude 在 `AskUserQuestion` 等待用户 → Kanban 重启 → 重开任务出现
`No completion record was found` 并意外继续生成」，本轮在 S5 基础上补齐以下契约：

- parked 会话的 `AskUserQuestion` / 权限 / 计划评审先分类并同步持久化，再过 parked gate；裸 `Stop`
  仍保持抑制。这样重启前的待答问题不会因 park 而漏账。
- PTY `resumeFromTrash` 新增恢复续跑守卫：启动只恢复历史，不代表开始新 agent 回合；输出反应自动续跑
  也必须在守卫期间让位。Claude 由真正的 `UserPromptSubmit`，Codex 由 Enter 或明确的程序化用户消息解除。
- 恢复期 Claude 自动注入的结构化 `<task-notification>` 由同步 hook 精确拦截并 durable 暂存；下一条
  真人/结构化用户提交到来时才作为 `additionalContext` 附带，通知本身不再充当新用户请求。
- Focus/Detail 视图顶部直接呈现 durable 待答问题，保留多问归属、单选/多选/自由文本。折叠是本地 UI
  状态；直接在终端继续会自动折叠但不删除问题；显式取消写 `dismissed`，不向 agent 投递任何内容。
- 结构化回答重述全部问题、全部选项及逐问答案；Kanban 完整重启、内存 `restartRequest` 丢失时，
  从 board + runtime config 重建 terminal resume 请求再投递。
- 旧版本漏记的问题只做按需保守补录：Claude 仅查该 task worktree 当前/已知 session 转录；Codex 仅在
  card 已知精确 session id 时查找。只有尾部问题没有配对结果且之后没有真人输入才补录；`plan_review`
  继续排除。

本轮部署前验证：Biome 全仓、后端 typecheck、后端 1566 tests、web-ui 1145 tests、web-ui production
build 均通过。部署后真实 Claude/重启行为已为 task `c5b8d` 登记两条 guided verification：
`50a8b555-7e6b-45af-8ea9-96d57b9bd6d6` 与 `a6b67bc8-62fc-49af-ad98-c3b548793e4a`。
