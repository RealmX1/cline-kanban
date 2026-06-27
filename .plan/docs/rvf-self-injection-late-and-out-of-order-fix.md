# RVF 自注入 follow-up「迟到 ~60s + 乱序」修复（terminal drain）

## 症状

RVF（Review-Validate-Fix）在 Claude Code task 的 Stop 之后，把 `$review-validate-fix` follow-up 经
**Tier3 terminal drain**（`runtime-api` → `TerminalSessionManager.submitTaskChatInputWhenReady`）自注入回
task 的终端输入框。实测两次真实 run 都**正好晚 ~60s** 落地（== `TASK_CHAT_INPUT_DELIVERY_DEADLINE_MS`），
且会被用户 live 手打**插队（乱序）**——即就绪判定整个 60s 窗口从未命中、全靠 deadline 兜底强写，且兜底
写不避让正在打字的用户。

## 根因（两个独立缺陷）

文件 `src/terminal/session-manager.ts`：

1. **迟到**：`resolveInteractivePromptReadiness` 的 claude 路径（`hasClaudeInteractivePrompt` 框线正则）
   在该环境整窗不命中 → 拖满 60s deadline。
2. **乱序**：deadline 兜底强写不读 `lastUserInputAt`，会插进用户正在打字的输入中间。

### 与 handoff 的关键分歧（实证修正）

收到的 handoff 把迟到归因到「Claude 框线正则匹配不上 / `takeLastLines` 截掉框线」，建议「放宽正则」。
本次调查用仓库内 `@xterm/headless` + `@xterm/addon-serialize@0.14.0` 复刻镜像兜底链路
（`serialize()` → `takeLastLines(rows)` → `stripAnsiAndControl` → `hasClaudeInteractivePrompt`），对 4 类
真实渲染（干净框 / SGR dim 78 宽框+footer / 滚动 60 行后底部 idle 框 / 框宽=cols 换行边界）做探针，
**全部命中**。结论：`stripAnsiAndControl` 保留所有 `code>=32` 字符 → box-drawing 码点原样存活；
序列化完整 round-trip 框线 → 正则对**正常 idle 框**稳命中。**正则不是病根**，「放宽正则」是红鲱鱼。
生产侧整窗不命中的精确成因（真实 viewport 未呈现可匹配框 / mirror `rows` 异常截断）需 live 复现才能坐实，
但下面的 A2 稳健兜底让坐实与否都不再影响修复。

## 修复

### A2 —— 稳健 idle 就绪兜底（治本，不依赖精确复现）

在 `resolveInteractivePromptReadiness` 末尾、镜像兜底之后加一条幂等 idle 兜底：当
`resolveSessionFacets(summary).turnOwner !== "agent"`（agent 已让出回合）**且**
`isAgentOutputQuiet(lastOutputAt, now())`（终端字节静默 ≥ `AGENT_OUTPUT_QUIET_THRESHOLD_MS`=2s）→ 判就绪。
二者均为 `src/core/session-activity.ts` 既有原语。效果：idle 的 Claude 在 SETTLE(1s)+0~1 次 recheck 内
即判就绪 → **~1–3s 落地**，与是否命中框线正则无关。`turnOwner` 门控保证不在 agent 回合中途的短暂静默里
误投；字节静默门控规避「粘贴但 CR 被吞」竞态。

就绪判定返回值从 `boolean` 改为判别式 `"prompt" | "quiet" | "immediate" | null`，使投递日志
`[tui-freeze] task-chat-input-delivered ... via=prompt-ready|output-quiet|immediate|deadline-fallback`
能区分命中通道——等于免费内建复现打点。

### A1 —— 写入前统一让路用户输入（防插队）

在 `runTaskChatInputDeliveryAttempt` 真正 `session.write` 之前（ready 与 deadline 两支都覆盖）加守卫：
复用 `canInjectIntoTerminalNow`（与 output-reaction 的 `canInjectNow` 动作同源：`deferredStartupInput` 短路
+ `lastUserInputAt` 近 `OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS`=8s 抑制）判断，若用户在手敲 → 不写、改排一次
`RECHECK_MS` 重试。**防饿死硬上限** `now() >= deadlineAt + TASK_CHAT_INPUT_DELIVERY_MAX_DEADLINE_INPUT_YIELD_MS`
（15s）时无条件保底强写，守住「投递绝不丢」。仍不写自身 `lastUserInputAt`（程序化投递只读人类的）。

## 为什么我们自研的 my-kanban 不需要这套机制（架构对比，重要）

本仓库 cline-kanban 把 **harness 的 TUI 直接作为开发者与 agent 的原生交互界面**，因此 Kanban 必须直接
与 TUI 交互——自注入只能「写进同一个终端输入框」，于是被迫处理 TUI 重绘时序（就绪门控）和「与用户共用
同一输入框」（让路防插队）这两个本质难题。本次 A1/A2 都是为这个约束付出的复杂度。

我们正在并行自研的 **my-kanban** 走的是更接近 **vibe-kanban** 的路线：开发者与 agent 的交互**不经过裸 TUI**，
而是经一个**自定义中间界面 + JSON 输入/输出流**。在那套架构里，本问题可以用**更朴素的方式**根除：
**等 JSON 流 + stop hook 结束后再发出自注入**，无论自定义界面里是否还存在用户未完成的 prompt——因为
自注入与用户输入不再共用同一个 raw 终端缓冲，不存在「写进用户正在打字的那一行」的乱序，也不存在
「TUI 重绘态下 CR 被吞」的就绪竞态。故 my-kanban 无需 A1 让路、也无需 A2 就绪兜底；只需在编排层等
「本轮 JSON 流 + stop hook 完成」这一确定信号即可。

> 一句话：cline-kanban 受「直接驱动 TUI」约束，必须就绪门控 + 让路；my-kanban 用自定义 JSON 中间界面，
> 把自注入与用户输入解耦，等流/hook 收尾再发即可，天然免疫本问题。

## 关键文件 / 测试

- `src/terminal/session-manager.ts`：`resolveInteractivePromptReadiness`（A2 + 判别式）、
  `runTaskChatInputDeliveryAttempt`（A1 让路 + via 细化）、`canInjectIntoTerminalNow`（抽取共享）、
  `scheduleTaskChatInputDeliveryRecheck`、常量 `TASK_CHAT_INPUT_DELIVERY_MAX_DEADLINE_INPUT_YIELD_MS`。
- `src/terminal/claude-readiness.ts`：**未改**（正则已被实证证明对正常框有效）。
- `test/runtime/terminal/session-manager-task-chat-input-delivery.test.ts`：新增 A2-quiet / A1-让路 /
  A1-防饿死 三例；既有 fake-bare-summary 用例补 `state:"running"`（agent 回合 facet，门控 A2）与
  `deferredStartupInput/lastUserInputAt` 字段。

验证：`npx vitest run test/runtime/terminal/`（全绿，217 例）。
