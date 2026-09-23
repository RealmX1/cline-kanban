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
| 接线 | `runtime-state-hub.ts`（观察器挂载点）/ `runtime-server.ts`（创建与启停）/ `runtime-api.ts` + `app-router.ts`（两条 procedure）/ `workspace-api.ts` + `commands/task.ts`（任务离开看板即丢弃） | |
| 前端 | `web-ui/src/stores/queued-task-prompt-delivery-projection-store.ts`（per-task store）、`hooks/use-queued-task-prompt-delivery-*`、`components/detail-panels/queued-task-prompt-delivery-queue-panel.tsx`、`runtime/queued-task-prompt-delivery-status-wording.ts` | |

## 3. 落点与生命周期

- `~/.cline/kanban/workspaces/<workspaceId>/queued-task-prompt-deliveries.json`，每 workspace 一份。
  不进 board.json（最热路径、正文易膨胀）、不进 sessions.json（崩溃即丢）、**不进注入账本**（跨仓契约的
  「唯一非终态必然有界收敛」对可以合法等几小时的排队意图不成立）。
- 键是**会话 id**：by-the-way 子会话有自己独立的队列。
- 正文**入队即冻结**：prompt library 条目可变，出队时才解析 = 用户排的是 A、agent 收到 B。来源条目只做溯源，
  sha 不符时 UI 标「library prompt has changed since」。
- 任务离开看板（浏览器整份 PUT 的差集 / CLI delete）即丢弃其队列——队列是待执行的机器动作，不是资产。
  移进 trash 列不算离开。
- 保质期 24h（绝对时刻 `expiresAt`）：过期转 `expired`，UI 明写「没发」，绝不静默发射。
- 上限：per-task 20 条**非终态**、per-workspace 200；裁剪只丢终态条目，队列满时入队**显式拒绝**。

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
3. **60s 兜底 sweep**：阻塞条件自行解除却没有新边沿（恢复守卫 30 分钟兜底过期、PTY 单飞槽里那条 RVF 投递
   失败了没开新一轮），以及别的进程改了队列文件。

**一轮至多交出一次**（进程内记账，按轮次键）：同一轮内不再出队，直到 agent 开始新的一轮。
没有它：① 可重试失败（人正在框里打字）会被 sweep 反复重投、一次次让位到超时、三次判死；
② 同步确认的 transport 确认之后 summary 翻成 generating 之前的空档里，第二条会被塞进同一轮。

每次出队 = 队首 + 被 `deliverTogetherWithNextQueuedEntry` 链住的**连续**一串，正文以空行拼接、
**不插任何分隔标记**（agent 读到的每个字节都会被当成用户说的话）。默认没人开合并 ⇒ 一轮一条。

## 6. 门控（按序，返回最靠前的一条）

| # | 阻塞原因 | 说明 |
| --- | --- | --- |
| 0 | `awaiting_human_reconfirmation_after_runtime_restart` | 跨过了 runtime 重启且人还没在重启后看见过。**唯一不会自行解除**的一条，故排最前 |
| 1 | `agent_still_generating` | |
| 2 | `session_parked_awaiting_dispatched_background_work` | 必须单列：`submitTaskChatInputWhenReady` 一进门就 unpark |
| 3 | `agent_awaiting_modal_user_decision` | 集合在 `session-activity.ts` 的 `MODAL_USER_DECISION_TURN_KINDS`。**绝不含 `review`**——review 是目标态 |
| 4 | `session_not_live` | 保持 queued 不判失败 |
| 5 | `session_restoring_conversation` | 完整的两态恢复守卫谓词（含 30 分钟兜底过期）。`--continue` 恢复重放自己打出的 Stop hook 落在第二个状态上——只比第一个值 = 用户点开一张卡片就引爆队列 |
| 6 | `another_programmatic_delivery_in_flight` | PTY 单飞槽被 RVF 占着。TOCTOU 残余由失败路由兜住 |

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
- 判据**不是**「条目比本进程老」：一台机器同时跑常驻实例 / dev:full / dogfood / 集成测试，共享 workspaces 根。
- **托管权会转移**，不是出身：不转移的话，任何启动时刻晚于上次盖章的并存实例都会再误标一次。
- 不按 workspace 发租约：那有 fail-unsafe 的洞（A 常驻持租约 → B 跳过 → B 续租 → A 真重启看到 B 的租约 →
  **漏掉一次真实重启**）。
- 心跳 `stop()` 必须先拦住未开始的续期、再等在途续期落地、最后才删文件——否则已退出的进程会在磁盘上「活」
  一个宽限期，真实重启被漏盖。
- 读不到心跳一律按「谁都不活」处理：多盖章 = 多让人确认一次（安全）；漏盖 = 重启后不提醒直接发（事故）。
- **「人看见了」= 闪了这一下**：详情视图挂载 ∧ 页面真的可见 ∧ 有待确认条目 ⇒ 播 5 秒高亮**同时**发确认。
  高亮没挂上就不确认（留给面板的 Keep 按钮）。`prefers-reduced-motion` 下动画关掉、静态 ring 保留。

## 9. 前端

- 服务端给阻塞原因枚举，前端只做措辞映射（`queued-task-prompt-delivery-status-wording.ts`）。
- 推流是 workspace 级整份替换的**投影**（正文截断 200 字）；全文按需经读 procedure 拉。
- per-task 外部 store：看板卡「N queued」药丸与详情视图各自按 taskId 订阅，不穿 props 过两条 BoardCard 宿主链。
- 不做乐观更新：mutation 响应自带服务端锁内算好的整份投影。

## 10. 明确不做（v1）

- images 与 mode 透传。
- 把 PTY 单飞槽改成 FIFO（会动代际语义、确认链提升时机与全部 teardown 点）。
- 让 RVF 用这条队列（`kanban task queue-message`）——**必须先改跨仓契约**。
- 点看板卡片的「N queued」药丸直接落到 Queue tab（药丸目前只是展示）。
