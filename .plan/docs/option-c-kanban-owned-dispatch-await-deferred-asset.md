# Option C —— Kanban 一等公民「dispatch 后台 → followup → 等待」延期资产

> 状态：**当前 client 不实现**。这是一份可继承蓝图，供用户自研的、原生支持 multi-agent-per-campaign 的 Kanban 继承。
> 当前这个「一任务一会话」client 落地的是 **Option A**（最小 park 标记，只『反应』不接管编排）——见
> `src/core/session-activity.ts` 的 `isParkedAwaitingDispatchedBackgroundWork`、`hook-event-task-transition-gate.ts`
> 的单闸抑制、`session-manager.ts` 的 `parkTaskSessionAwaitingDispatchedBackgroundWork` / `unparkTaskSession`。
> Option C 把 A 的「会话 sidecar + 单闸抑制」保留为基底，再 graft 两处代码事实强制的耐久结构。

## 背景：要解决的真实缺口

主 agent 以**非 native** 方式 dispatch 一个后台任务（例：把 reviewer 计划作为独立 Kanban 短任务 `b2wa4c9uf` 发出），
然后结束自己这一轮去等它完成。Claude 此刻只发一个**裸 `Stop`**（它不知道刚才那是子 agent，不会发 `SubagentStop`），
裸 `Stop` 经 `to_review` 会被当成「收尾等用户审查」误发 ready-for-review 通知。

Option A 只补「学会『我现在 parked』并正确地不误报」；dispatch 与 resume 由外部编排（现为 RVF）拥有。
Option C 是把整套 dispatch / watcher / 自动 resume / fan-out 编排做成 Kanban **一等公民**——这才需要原生多 agent 模型。

## 综合裁决：基底 = 最小 sidecar + 单闸抑制，graft 两处代码事实强制的结构

三条代码事实决定取舍：

1. **终端会话 summary 仅在 shutdown 落盘** → 纯 session-sidecar 在 await 中途崩溃即丢。
2. **`broadcastRuntimeWorkspaceStateUpdated` 与 `broadcastTaskReadyForReview` 都在 `clients.size===0` 早返回**
   （`runtime-state-hub.ts:308,337`）→ 看板广播驱动的 watcher 在 headless / RVF 流程是死路。
3. **Stop hook 是 spawn 时烤死的静态命令**（`agent-session-adapters.ts:710`）→ 无法在真 Stop 上挂 metadata。

由此：

- **GRAFT A（耐久真相在看板卡片）**：park 关系写在 board.json 的卡片字段（每次 `mutateWorkspaceState` 原子落盘，
  `workspace-state.ts:797-805`），**不**放在 session summary。
- **GRAFT B（watcher + 实时抑制读在 `TerminalSessionManager`，由 `onSummary` 驱动）**：client-independent、headless 也触发；
  崩溃后从看板卡片 reconcile 重建。

保留 Option A 的制胜洞见：**parked 父 == 普通 running 三元组 `{agent,live,null}`**，零 facet / 枚举 / superRefine 改动，
通知在单一转换闸结构性消除。

## 各维度要点

- **parkStateModel**：同 A 的 facet 表示（无新枚举 / 无 superRefine）。park 表达为看板卡片**加性可选字段**
  `awaitingChildTaskId / awaitingChildSince / awaitingChildExpectedColumn / parentTaskId`（镜像 `api-contract.ts:155-157`
  的 `parentSessionId / prepFilePath`）+ 一个非耐久内存 sidecar `parkAwaitChild` 仅作热路径抑制读、重启从卡片重建。
  抑制点同 A（`hook-event-task-transition-gate.ts` 的 to_review 分支）。
- **childTerminalAndPayload**：子终态 = 耐久看板信号 **或** 低延迟会话信号，先到先触发、幂等 join。
  会话级：`isAwaitingUserReviewTurn(child)` 且 `userTurnKind==="review"`，或 `liveness∈{failed,interrupted}`。
  **白名单**排除 `userTurnKind∈{question,plan_review,permission,needs_input}`（子在问它自己的用户，早唤醒会误报）。
  看板级兜底：子卡进终态列 / 被 trash ⇒ failure。回灌**结果信封**（id / outcome / column / path），非全文；
  幂等键 `(parentTaskId, childTaskId, awaitingChildSince)`。
- **watcherAndPersistence**：`TerminalSessionManager` 持 `backgroundDispatchWatchers: Map<parentTaskId, unsub>`，
  由 `onSummary` 驱动（client-independent）。重启 reconcile（`workspace-registry.ts:223` `hydrateFromRecord` 后调
  `rebuildBackgroundDispatchWatchers(board)`）：重盖 sidecar、重设 `suppressAutoRestartOnExit`、重挂 watcher、
  **并立即对子当前 summary + 列评估一次**（已终态当场 resolve，因 hydrate 不发 summary）。补 lazy-instantiation 盲区：
  服务启动 sweep 强制为任何 board 含 `awaitingChildTaskId` 的持久化 workspace 实例化一次 manager。
  resume = 单一幂等 sink `resolvePark()`：**先**经 `submitTaskChatInputWhenReady` 注入并查其返回（dead parent 返回
  null → 走 teardown / error），**仅在投递被接受后**才清看板字段 + 内存 sidecar + 退订（先清后注会让晚到的裸 Stop
  漏过闸再次误报）。
- **parentIdleSafety**：同 A 的四点守卫（stall 扫描、`isAgentTurnActive`、review 列 bounce、`shouldAutoRestart`），
  共享谓词 `isParkedAwaitingChild`。
- **failureHandling**：子失败 / 中断 → error followup 唤醒；子挂死 → **v1 必带 park 超时**
  （`awaitingChildSince` + 默认期限，到点注 `[child-task-timeout]` followup、清 park、放行真通知）；
  父在 parked 时退出 → `onExit` 清 sidecar + 看板、watcher teardown，子留运行（orphaned-but-valid，UI 标注，不自动取消）；
  子被删 / trash → resolve outcome=trashed。
- **dispatchEntryPointAndOrdering**：离散 tRPC mutation `dispatchChildTask`（非 Stop piggyback）+ 薄 CLI。
  `parkSessionAwaitingChild` 同步顺序：校验 → 写耐久看板字段 → 写内存 sidecar → 设 `suppressAutoRestartOnExit` →
  结束已开 reaction episode → 挂 watcher → `emitSummary`。agent 须 await mutation OK 再结束一轮。
- **uiAndLineage**：parked 徽标替代 spinner；父→子 / 子→父 血缘 chip 可点击导航；`parentTaskId` 持久在卡片
  （park 清后 / 重启后血缘仍在）；两 host move 处理器 parked 禁用。
- **rvfIntegration**：导出纯谓词 + `isTaskParked` tRPC query + `kanban task is-parked` CLI；RVF 先查后回落。

## 实施大纲（有序，供自研 Kanban 继承）

1. `api-contract.ts`：加 4 个看板卡片加性可选字段 + 内存 sidecar `parkAwaitChild` + `dispatchChildTask` / `isTaskParked`
   schema。无 facet / superRefine 改。
2. `session-activity.ts`：加 `isParkedAwaitingChild(summary)` / `isTaskAwaitingDispatchedChild(card)`。不改 derive / project / merge。
3. `hook-event-task-transition-gate.ts`：to_review 加 `&& summary.parkAwaitChild == null`。
4. `task-board-mutations.ts`：穿 4 字段过 `addTaskToColumn` / `updateTaskCommand`；加 `setTaskAwaitingChild` /
   `clearTaskAwaitingChild`；复用 `getTaskColumnId`。
5. `session-manager.ts`：`backgroundDispatchWatchers` + `parkSessionAwaitingChild()` + 幂等 `resolvePark()`（先注入查 null
   再清）+ `clearBackgroundDispatch()` + `rebuildBackgroundDispatchWatchers(board)`（含立即 reconcile）+ `parkLookup` 注入；
   四处空闲守卫；`onExit` 清；`shouldAutoRestart` 查 `parkLookup`。
6. `workspace-registry.ts:223`：`hydrateFromRecord` 后调 `rebuildBackgroundDispatchWatchers`；加启动 sweep 强制实例化含
   `awaitingChildTaskId` 的 workspace（破 lazy-instantiation 盲区）。
7. 新 `src/trpc/dispatch-api.ts` + `app-router.ts` + `runtime-server.ts`：`createDispatchApi` 实现 `dispatch()` 与
   `isTaskParked()`；注册 mutation + query。
8. `task.ts` / `hooks.ts`：`task dispatch --task-id --child-task-id [--expected-column]` 与 `task is-parked`。
9. park 超时 sweep（启动 + 周期）：`awaitingChildSince` 过期 → `[child-task-timeout]` followup + 清 park + 放行通知。
10. UI（`task-card-body.tsx` + 两 host）：parked 徽标、抑制 computing、血缘 chip、parked 禁用 move；**强制**
    review 列 bounce 守卫。
11. RVF：导出谓词 + `isTaskParked` query + `is-parked` CLI。

## 残留风险（继承时注意）

1. 双源 park 态（耐久看板卡片 + 非耐久内存 sidecar）须一致：dispatch 写两处、`resolvePark` / `clearBackgroundDispatch` /
   `onExit` 清两处、rebuild 从卡片重建 sidecar。漏清 → 再次误报（sidecar 残留）或卡死（卡片残留）。所有清并入单一幂等
   `resolvePark` sink 缓解。
2. 子终态白名单（仅 `userTurnKind=review`）是真软肋：子经非 review reviewReason 结束、或某 harness 把「问自己用户」映射成
   review，会漏唤醒 / 早唤醒；需跨映射单测，或按 agent 调参。
3. 启动 sweep 须是权威 reconcile 入口（非 best-effort），否则未被 touch 的 workspace 里 parked 父不 reconcile。
4. `submitTaskChatInputWhenReady` 一次性、60s 期限、无重排；父 PTY 在 park 中途死亡 → 子结构化结果送不达活 agent
   （走 error / teardown，信封实质丢失，父须重开子）。
5. 两 host move 守卫 + 单一 review 列 bounce 守卫是 load-bearing、易半应用。
6. v1 无跨 workspace dispatch（watcher 假设同 manager / onSummary），dispatch 时报错强制；跨 manager watcher 留待。

## 对抗审查评分

- minimal-sidecar：correctness 6 / scope-reuse **8**（最稳健基底，Option A / C 共用）
- clean-facet-firstclass：6 / 6（liveness 枚举化过重）
- pragmatic-board-reuse：4 / 6（看板广播驱动 watcher 在 headless 死路）

## 与已落地 Option A 的关系

Option A = Option C 的「GRAFT 之前」基底：A 的会话 sidecar `awaitingDispatchedBackgroundWork` + 单闸抑制 +
四点空闲守卫 + resume 自动清标，全部是 C 的子集。继承 C 时，把 A 的会话 sidecar 升级为「耐久看板卡片字段（真相）+
非耐久内存 sidecar（热路径抑制读）」双源，并补 watcher / dispatch mutation / 超时 sweep / 血缘 UI 即可。
A 已实现的 `isParkedAwaitingDispatchedBackgroundWork` 谓词、`endActiveOutputReactionEpisode` 复用、`shouldAutoRestart` /
`isAgentTurnActive` / `scanForStalls` 守卫位置，都是 C 的 `isParkedAwaitingChild` 守卫的现成锚点。
