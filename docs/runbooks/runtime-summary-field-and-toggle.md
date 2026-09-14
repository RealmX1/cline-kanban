# 加 RuntimeTaskSessionSummary 字段 / 加 persisted 全局设置开关

两条「跨 server→web 全栈」的常见改动链路。共同点是：**单点改动不会生效，必须走完一整条链**；链上每一环单独看都「编译能过」，漏一环就是静默无效。本文按链逐环节列出，附每环的验证符号。

## 链路 A：给 `RuntimeTaskSessionSummary` 加一个普通字段

结论先行：**只需改 zod schema，不需要新增任何订阅**——summary 的广播与前端合并是既有的通用管道，schema 加了字段就自动端到端流通。

以 `connectionRetry`（`src/core/api-contract.ts:741`，schema 为 `runtimeTaskConnectionRetrySchema.nullable().optional()`）为范例，链路是：

1. `src/core/api-contract.ts`：在 summary 的 zod schema 加字段。加性字段用 `.nullable().optional()` 形态（旧盘数据没有该键也能 parse）。
2. `src/server/runtime-state-hub.ts`：批量广播**自动**携带新字段，无改动。
3. `web-ui/src/runtime/use-runtime-state-stream.ts` 的 `mergeTaskSessionSummaries`（:37）：按 `updatedAt` 合并 summary map，**自动**带上新字段，无改动。注意 150ms 一批的 `task_sessions_updated` **不进 reducer**——它由 `use-workspace-sync.ts` 注册的 applier 旁路直送，一次 `setSessions` 并入（App 每批只渲染一次）；reducer 内仅剩 snapshot 类汇入点（:264 / :381）。
4. `App.tsx` 的 `sessions` → 看板卡片 / top-bar：消费方在这里读新字段。

**例外**：`turnOwner` / `liveness` / `userTurnKind` 三个 facet 字段不适用这条「自由加」链路——它们有共现/合法组合的 `superRefine` 守卫与写入漏斗约束，动它们先读 `src/core/session-activity.ts` 与 facet 模型文档，别按本 runbook 走。

## 链路 B：加一个 persisted 全局设置开关

以 `readyForReviewNotificationsEnabled` 为范例（`autoContinueOnConnectionDropEnabled` 同构）。共 5 处、缺一静默失效：

1. `src/config/runtime-config.ts`——**一个文件里 8 个环节**，全部要碰：文件形状（persisted file shape，:33）、运行时 state（:60）、update input（:79）、`normalizeBoolean` 读盘容错（:351）、写盘条件（只在非默认时落盘，:510-513）、save、update、updateGlobal（:819-820 / :954-955 等各 update 入口）。漏掉任何一个 update 入口，该入口的保存就会静默丢字段。
2. `src/core/api-contract.ts`：config response schema 与 save schema 各加一次。
3. `src/terminal/agent-registry.ts` 的 `buildRuntimeConfigResponse`（:101；由 `src/trpc/runtime-api.ts:443` 调用）：把字段放进发给前端的 config 响应。
4. `src/trpc/runtime-api.ts`：parse 之外，还要把字段**传进会话启动调用**。这是**最易漏的一环**——以 `autoContinueOnConnectionDropEnabled` 实测，传参点有三处：`startTaskSession`（:932）、`refreshTaskTerminal`（:1101）、resumeFromTrash 自动续跑路径（:496）。漏了它：开关能存、能回显，但**运行时不生效**——设置对话框一切正常、agent 行为毫无变化，且不报任何错。
5. `web-ui/src/components/runtime-settings-dialog.tsx`：对话框的 state / initial / dirty / save 四段各加一次（漏 dirty 判定会导致「改了开关但保存按钮不亮」类问题）。

### 自检清单

改完后按序自验：

- [ ] 改开关 → 重启 server → 对话框回显正确（验证 1+2+3 链路）。
- [ ] 改开关 → 新建任务会话，确认 agent 行为变化（验证 4 的 `startTaskSession` 传参）。
- [ ] 对已有会话触发「重启终端」（`refreshTaskTerminal` 路径），确认行为同样变化（验证 4 的第二处——最容易漏的就是它）。
- [ ] 开关值为非默认时才写进配置文件；改回默认后键消失（验证 1 的写盘条件）。
