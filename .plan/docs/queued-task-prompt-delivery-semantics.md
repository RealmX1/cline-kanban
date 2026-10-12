# 排队 Prompt 投递（Queued Task Prompt Delivery）语义说明

> 这份文档是**语义**的单一出处：状态机、触发、门控、失败路由、重启跨越。实现散在十来个文件里，
> 各文件头注只讲自己那一段，并反向引用这里。改动任何一条之前先读完本文——这套东西里好几条规则
> 单看一个函数是看不出必要性的，要推演跨时间的事件序列才看得出来。

## 1. 它是什么

用户在 agent 干活时，把「下一步要它做什么」排进该任务的队列；**agent 这一轮结束后**由运行时自动发出。
面板上看得见排了哪些、为什么还没发，随时可取消 / 重排 / 合并。

它建在 RVF 自注入已经在用的那条链路之上：`src/trpc/task-chat-message-send-across-session-transports.ts`
（三 transport 统一发送出口）+ PTY 侧 `submitTaskChatInputWhenReady` 的就绪门控 / 让位 / 写后确认状态机。
**队列坐在出口之上，不改它一个字节**——RVF 的 196.5s 收敛承诺（跨仓契约
`~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md`）正建立在
「一条 RVF 投递永不排在别人后面」之上。

## 2. 文件地图

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 契约 | `src/core/api-contract.ts`（「排队 Prompt 投递」一节，位于推流 union 之前） | 条目 / 意图 / 投影 / 推流消息 / procedure I/O |
| 纯判据 | `src/core/queued-task-prompt-delivery-dispatch-eligibility.ts` | 8 道门控、停止边沿身份、轮次键、认领陈旧复核 |
| 纯判据 | `src/core/queued-task-prompt-delivery-outcome-routing.ts` | 回执 → 去向路由表 |
| 纯判据 | `src/core/queued-task-prompt-delivery-merge.ts` / `…-projection.ts` | 合并正文 / 推流投影 |
| 持久化 | `src/state/queued-task-prompt-delivery-store.ts` | durable 真相源、锁内读改写、四原子、盖章、收敛撂下的在途 |
| 活性 | `src/state/runtime-process-instance-heartbeat-registry.ts` | 本机 runtime 进程实例心跳 |
| 编排 | `src/server/queued-task-prompt-delivery-dispatcher.ts` | 出队引擎（三触发源、一轮一次、结算） |
| 编排 | `src/server/stale-queued-task-prompt-delivery-startup-sweep.ts` | 启动清扫 |
| 程序化 | `src/core/queued-programmatic-injection-ledger-receipt-mirroring.ts`（纯规则）、`src/state/mirror-queued-programmatic-injection-outcomes-into-injection-ledger.ts`（镜像 IO + 兜底对账）、`src/state/enqueue-agent-idle-gated-programmatic-injection-into-prompt-delivery-queue.ts`（程序化入队）、`src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue.ts`（runtime 入口 + 排队期间取消） | 见 § 11 |
| 接线 | `runtime-state-hub.ts`（观察器挂载点）/ `runtime-server.ts`（创建与启停）/ `runtime-api.ts` + `app-router.ts`（两条 procedure）/ `workspace-api.ts` + `commands/task.ts`（任务离开看板即丢弃） | |
| 前端 | `web-ui/src/stores/queued-task-prompt-delivery-projection-store.ts`（per-task store）、`hooks/use-queued-task-prompt-delivery-*`、`components/detail-panels/queued-task-prompt-delivery-queue-panel.tsx`、`runtime/queued-task-prompt-delivery-status-wording.ts` | |

## 3. 落点与生命周期

- `~/.cline/kanban/workspaces/<workspaceId>/queued-task-prompt-deliveries.json`，每 workspace 一份。
  不进 board.json（最热路径、正文易膨胀）、不进 sessions.json（崩溃即丢）、**不进注入账本**（跨仓契约的
  「唯一非终态必然有界收敛」对可以合法等几小时的排队意图不成立）。例外是 § 11 的程序化条目：它带调用方给的
  截止时刻，于是能在账本里**另有**一条有界收敛的回执。
- 键是**会话 id**：by-the-way 子会话有自己独立的队列。
- 正文**入队即冻结**：prompt library 条目可变，出队时才解析 = 用户排的是 A、agent 收到 B。来源条目只做溯源，
  sha 不符时 UI 标「library prompt has changed since」。
- 任务离开看板（浏览器整份 PUT 的差集 / CLI delete）即丢弃其队列——队列是待执行的机器动作，不是资产。
  移进 trash 列不算离开。
- 保质期 24h（绝对时刻 `expiresAt`）：过期转 `expired`，UI 明写「没发」，绝不静默发射。
- 上限：per-task 20 条**非终态**、per-workspace 200 条**非终态**；裁剪只丢终态条目，任一上限满时入队 / 重排都
  **显式拒绝**（响应带 `enqueueRefusedBecauseQueueCapacityIsExhausted`）。每次 mutation 先把过期条目收敛成
  `expired` 再判断，于是过期条目不占容量、可以 Dismiss。
- 条目记 `workspaceTaskId`（所属看板任务；by-the-way 子会话是它的主任务），主任务离开看板时子会话的队列一并丢弃。

## 4. 状态机

```
queued ──认领(锁内)──▶ claimed_for_dispatch ──写盘──▶ handed_to_transport ──send──▶ 回执
   ▲                         │                               │
   └──── 陈旧 / 被挡：释放 ──┘        可重试失败：回队首 ◀──────┤
                                     终态失败 → settled_failed ┤
                                     送达     → settled_delivered
                                     取消拦下 → cancelled
```

`claimed_for_dispatch → handed_to_transport` 的写盘**发生在 send 之前**，所以崩溃后可区分：
认领 = 一个字节都没写出去（安全释放）；交付 = 语义暧昧（绝不自动重投，落 `settled_failed` 交给人）。

## 5. 什么时候出队

三条触发源，缺一不可：

1. **停止边沿**（主路径）。停止边沿的身份是 `agentResponseGenerationStopped` 这个**冻结事件对象**的变化，
   **不是** `${incarnation}:${turnSequence}`——turnSequence 在回合**开始**时递增，停止那一刻不变。
   观察器挂在 `runtime-state-hub` 的 summary 汇聚点上，位于「0 客户端提前返回」**之前**：关掉浏览器标签页，
   队列照样排空。
2. **队列被改动之后立刻尝试一次**：覆盖「agent 已经闲着时排了一条」。
3. **60s 兜底 sweep**：阻塞条件自行解除却没有新边沿（PTY 单飞槽里那条 RVF 投递失败了没开新一轮），
   别的进程改了队列文件，以及**持续盖章屏障**（见 §8）。

**一轮至多交出一次**（进程内记账，按轮次键）：同一轮内不再出队，直到 agent 开始新的一轮。
没有它：① 可重试失败（人正在框里打字）会被 sweep 反复重投、一次次让位到超时、三次判死；
② 同步确认的 transport 确认之后 summary 翻成 generating 之前的空档里，第二条会被塞进同一轮。

每次出队 = 队首 + 被 `deliverTogetherWithNextQueuedEntry` 链住的**连续**一串，正文以空行拼接、
**不插任何分隔标记**（agent 读到的每个字节都会被当成用户说的话）。默认没人开合并 ⇒ 一轮一条。

## 6. 门控（按序，返回最靠前的一条）

| # | 阻塞原因 | 说明 |
| --- | --- | --- |
| -1 | `queued_under_another_live_kanban_runtime_instance` | 条目由另一个此刻活着的实例托管：只有托管者发它（同机多实例共享 workspaces 根） |
| 0 | `awaiting_human_reconfirmation_after_runtime_restart` | 跨过了 runtime 重启且人还没在重启后看见过。**唯一不会自行解除**的一条，故排最前 |
| 1 | `agent_still_generating` | |
| 2 | `session_parked_awaiting_dispatched_background_work` | 必须单列：`submitTaskChatInputWhenReady` 一进门就 unpark |
| 3 | `agent_awaiting_modal_user_decision` | 集合在 `session-activity.ts` 的 `MODAL_USER_DECISION_TURN_KINDS`。**绝不含 `review`**——review 是目标态 |
| 4 | `session_not_live` | 保持 queued 不判失败 |
| 5 | `session_restoring_conversation` | 两态恢复守卫的**声明态**，**不看** 30 分钟兜底过期。`--continue` 恢复重放自己打出的 Stop hook 落在第二个状态上——只比第一个值 = 用户点开一张卡片就引爆队列。兜底过期是为「别永久吞掉 harness 唤醒通知」设的，对排队投递放行 = 用户没继续过对话、旧 prompt 半小时后自动发出。「人一继续就放行」要成立，解除侧也必须只看声明态：解除只走 `disarmRestorationContinuationGuard` 一个漏斗（真人 UserPromptSubmit / BeforeAgent、一键放行、Codex / Cursor 提交边沿），harness `<task-notification>` 不解除。该漏斗一度读带兜底的谓词，首个真人提交晚于启动 30 分钟的会话声明态永久残留、条目挡到过期（2026-10-11 a768a，task f011d 修复） |
| 6 | `another_programmatic_delivery_in_flight` | PTY 单飞槽被 RVF 占着。TOCTOU 残余由失败路由兜住 |
| 7 | `awaiting_first_agent_turn_end_after_restart_reconfirmation` | 跨过重启、人已确认，但确认之后 agent 还没停下过一次（停止事件的 `stoppedAt` 不晚于确认时刻）。用户要的是「确认后在**下一次** stop hook 注入」；排最后，让更具体的原因先显示 |

投递带 `source: "kanban_prompt_queue"`，于是 PTY 侧 `deferWhileUserTurn` 生效，是门控 3 之外的第二道保险。

## 7. 失败路由（`queued-task-prompt-delivery-outcome-routing.ts`）

- **可重试**（确定没进 agent → 回队首、等下一轮、预算 3 次）：`no_active_terminal_session`、
  `terminal_prompt_readiness_timeout`、`human_terminal_contention_timeout`、
  `terminal_input_box_contended_but_unstashable`、`agent_awaiting_user_decision_timeout`、
  `superseded_by_later_delivery`、`session_ended_before_delivery`，以及出口在受理之前就 `ok:false`。
- **终态失败**（可能已经送到 → `settled_failed`，重排由人决定）：`submit_confirmation_budget_exhausted`、
  `runtime_restarted_before_confirmation`、PTY 回执超过等待预算、未知原因。
- **取消**：`cancelled_before_delivery` → `cancelled`（不是失败）。
- 契约新增失败原因时，单测会因「落进兜底分支」而红——必须显式分档。

## 8. 重启跨越（restart-crossing）

用户要的行为：kanban 重启 / redeploy / 系统重启之后，聚焦任务时队列还在，Queue 页签柔和地闪 5 秒提醒
「重启前排的，确认一下还要不要」，然后在下一次 stop hook 注入。

- **启动清扫**先收敛撂下的在途（按**超期**判，与注入账本启动清扫同口径；启动时还年轻的由一次延迟复扫补判），
  再给「托管实例此刻不在心跳里」的非终态条目盖章并清掉上一次的人工确认、托管权转给做清扫的实例。
- **盖章是持续屏障，不是启动时的一次性动作**：崩溃（或整机快速重启）后旧心跳还在 2 分钟宽限期内时新实例就
  起来了，启动清扫会以为托管者还活着而跳过。所以 dispatcher 每次出队前（队首托管者不是本实例时）与每次 60s
  sweep 都重读心跳、给托管者已死的条目盖章并接管；托管者仍活着的条目由门控 -1 挡住。
- 确认之后还要等 agent **再停下一次**（门控 7）：确认那一刻 agent 往往停在重启前留下的停止事件上。
- 判据**不是**「条目比本进程老」：一台机器同时跑常驻实例 / dev:full / dogfood / 集成测试，共享 workspaces 根。
- **托管权会转移**，不是出身：不转移的话，任何启动时刻晚于上次盖章的并存实例都会再误标一次。
- 不按 workspace 发租约：那有 fail-unsafe 的洞（A 常驻持租约 → B 跳过 → B 续租 → A 真重启看到 B 的租约 →
  **漏掉一次真实重启**）。
- 心跳 `stop()` 必须先拦住未开始的续期、再等在途续期落地、最后才删文件——否则已退出的进程会在磁盘上「活」
  一个宽限期，真实重启被漏盖。
- 读不到心跳一律按「谁都不活」处理：多盖章 = 多让人确认一次（安全）；漏盖 = 重启后不提醒直接发（事故）。
- **「人看见了」= 闪了这一下**：详情视图挂载 ∧ 页面可见 ∧ Queue 页签**真的**呈现在视口里（有面积、没被藏、
  没被模态层盖住；窄屏横向溢出时先就近滚回来）∧ 有待确认条目 ⇒ 播 5 秒高亮**同时**发确认，并给屏幕阅读器一句
  aria-live 播报。没能呈现就不确认，每 2 秒与回到前台时再试。只在服务端确认成功后才算提醒过，失败 10 秒后重试。
  `prefers-reduced-motion` 下动画关掉、静态 ring 保留。

## 9. 前端

- 服务端给阻塞原因枚举，前端只做措辞映射（`queued-task-prompt-delivery-status-wording.ts`）。
- 推流是 workspace 级整份替换的**投影**（正文截断 200 字）；全文按需经读 procedure 拉。
- per-task 外部 store：看板卡「N queued」药丸与详情视图各自按 taskId 订阅，不穿 props 过两条 BoardCard 宿主链。
  store 记着当前 workspace，别的 workspace 的写入一律丢弃（taskId 是 board-local 短 id，会撞号）。
- 不做乐观更新：mutation 响应自带服务端锁内算好的整份投影；但服务端先推流后回响应，期间已有更新写入时丢弃
  这份响应（写入代数），不拿它回滚更新的推送。
- 合并开关在任一侧已在发送时禁用（服务端同样只改 `queued` 条目）：那一串在认领时就冻结了。

## 10. 明确不做（v1）

- images 与 mode 透传。
- 把 PTY 单飞槽改成 FIFO（会动代际语义、确认链提升时机与全部 teardown 点）。
- ~~让 RVF 用这条队列——必须先改跨仓契约~~ 已做，契约先行（2026-10-01），见 § 11。
- 点看板卡片的「N queued」药丸直接落到 Queue tab（药丸目前只是展示）。

## 11. 程序化排队投递（`kanban task message --deliver-when-agent-idle`）

> 跨仓契约：`~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md`
> § agent 空闲门控的排队投递。RVF 决策点边界标记要「agent 空闲时才粘贴」，否则标记在回合中途并入、决策点过时。

**一句话**：同一条 `kanban task message` 带 `--deliver-when-agent-idle --max-wait-for-agent-idle-ms <ms>`，消息先进本队列、
等 agent 空闲（§ 6 的门控）再交给终端投递；交出之后的一切与立即投递相同。回执是注入账本里那条同 key 的四态记录。

与人排的条目共用：durable 文件、§ 6 全部门控（park 恒算忙——RVF 需求 2 无需 flag）、三条触发源、一轮一条、
先来先发、托管门。刻意不同的几处：

| | 人排的 | 程序化 |
| --- | --- | --- |
| 回执 | 只在面板上 | 注入账本同 key 记录（跨仓契约），每条落定路径都镜像过去 |
| 交出后的可重试失败 | 回队首等下一轮（≤3 次） | **一次定终身**：终端回执即终态，不再回头等 agent（与 33612 终端门的分工约定第 3 条） |
| 保质期 | 24h | 调用方给的截止（≤24h），到点由精确定时器写盘收敛 ⇒ `agent_never_became_idle_before_queued_delivery_deadline` |
| 托管实例死了 | 盖章、等人确认（§ 8） | 直接落 `settled_failed` ⇒ `runtime_restarted_before_confirmation`；不跨重启 |
| 合并 | 可开关 | 永远独占一次投递（自身开关不许点亮，前一条的开关在它前面断开） |

**账本镜像挂在哪**：store 唯一的持锁读-改-写（`updateWorkspaceQueuedTaskPromptDeliveriesUnderLock`）在每次写盘、
锁释放之后比较写前 / 写后两份快照（纯规则在 `queued-programmatic-injection-ledger-receipt-mirroring.ts`）：
落定 ⇒ 写终态；刚交出 ⇒ 写 `agent_idle_gate_passed_at`；非终态条目随任务被丢弃 ⇒ `session_ended_before_delivery`。
七条落定路径（出队结算 / Queue tab 取消 / `message-cancel` / 过期 / 托管实例死 / 撂下的在途 / 删任务）因此一处全覆盖。
镜像失败由出队引擎兜底 sweep 的对账补写（只认队列里的终态条目作证据）；证据也没了的（终态条目已被 Dismiss / 裁掉），
由账本侧的持续清扫在「截止 + 终端投递最坏预算」之后落 `runtime_restarted_before_confirmation`（见下「有界收敛」）。出队引擎拿到的真实终端回执随结算存进条目，镜像原样使用；其余路径按落定状态推
（取消 → `cancelled_before_delivery`，过期 → 新原因，无回执的失败 → `runtime_restarted_before_confirmation`）。

**账本记录由 runtime 建**（`enqueueAgentIdleGatedProgrammaticTaskChatMessage`，一次调用里先建记录再入队）：CLI 若在两步
之间死掉，留下的 pending 没有队列条目、截止时刻也就没人收敛。同 key 重发一律只返回当前记录、**绝不重新入队**——
哪怕队列里已经找不到它的条目：「两段之间崩溃、一个字节没送」与「已送达但镜像丢了、终态条目又被裁掉」在这里分不清，
补排会让后者送两遍。两种都交给账本持续清扫在上界之后诚实落定，由调用方换新 key 重排。截止时刻只在首次建记录时定下。

**交出时用调用方的 key 与 source**：于是交出之后的 `message-cancel`（PTY 代际失效）与账本回写（发送出口的
`onDeliveryOutcome`）与立即投递逐字相同。还在等空闲时 `message-cancel` 打到 PTY 是无效的（单飞槽里没有它），
所以 runtime 的 `cancelTaskChatDelivery` 先在队列里撤下它。

**读回执只看 `terminal_delivery_status`**：账本记录上的 `status` 是遗留字段的镜像（`task-message-injection-ledger.ts`
的 `LEGACY_STATUS_MIRROR`），只为旧读者不炸。其中 `delivered_queued_behind_active_agent_turn` 镜像成 `status: "queued"`，
它是**终态**、意思是「已送达，写入时排在 agent 正在跑的回合之后」，**不是**「还在本队列里排队」。

**有界收敛**：账本启动清扫的「超期」对门控记录从 `max(状态时间戳, agent_idle_wait_deadline_at)` 起算——
否则并存的第二个 runtime 一启动，就把常驻实例上还在合法排队的记录写成不可纠正的假失败。上界因此是
「截止 + 终端投递最坏预算」。
账本清扫不止在启动时跑：`startStalePendingTaskMessageInjectionSweepsForRuntimeLifetime` 在 runtime 活着期间持续续排（按本轮最早
超期时刻排下一趟、最迟 60s 周期兜底，判据在契约上界外再留 5s 余量），所以「没人收敛的 pending」（两段之间崩溃、镜像证据丢失、
并存实例死掉）都在上界之后有界时间内落定，而不是等下一次重启。

**不保证**：门控放行到真正粘贴之间（TUI 就绪等待，通常毫秒到 1–3s）agent 被唤醒时，回执如实报
`delivered_queued_behind_active_agent_turn`；终端就绪判定属于 task 33612，这里不改。RVF 侧的复工撤回仍须保留。
