# 自注入「粘贴进输入框但回车被吞、不发送」修复（写后确认 + 补发裸回车闭环）

## 症状

Kanban 把程序化 prompt 自注入回 Claude/Codex 终端输入框时，偶发「文本被粘贴进了输入框，但末尾回车（CR）
被 TUI 重绘吞掉 → prompt 永远卡在框里不发送」。本轮由 RVF Stop hook 报
`kanban-followup-dispatched-unconfirmed`（`reason=kanban_followup_dispatched_unconfirmed`）暴露——
「派发了（字节写进 PTY）但未确认（没证据真提交）」。这是个反复回归的老问题。

## 根因：两处程序化 paste 注入都是「写一次就不管」的开环

代码里有**两处**程序化 paste 注入，写完 `paste+CR` 后没有任何「是否真提交」的确认，更没有补救：

| 注入点 | 位置（`src/terminal/session-manager.ts`） | 失败时旧现状 |
|---|---|---|
| **A. RVF follow-up 自注入** | `runTaskChatInputDeliveryAttempt` | CR 被吞 → 文本永远卡住，无补救（本轮报告的这条） |
| **B. 连接中断自动续跑** | `submitConnectionDropContinuation` | CR 被吞 → 退避重试**重新整段 paste** → 输入框文本**叠成两份** |

注入编码 `toBracketedPasteSubmission()` = `␛[200~${text}␛[201~\r`（文本 + 框 + 单个尾随 CR 一次写入）。
先前修复（`rvf-self-injection-late-and-out-of-order-fix.md` 的 A1/A2，写**前**门控）把写入门控到提示符就绪
以**降低**吞 CR 概率——但就绪判定是启发式，无法**消除**该竞态；一旦发生，没有任何东西能把它救回来。

## 修复：统一经 `writePasteSubmissionWithConfirm` 的写后确认 + 补发裸 `\r`

两处注入都改走同一入口 `writePasteSubmissionWithConfirm(taskId, entry, active, text)`：写一次 bracketed
paste（Codex 置位 `awaitingCodexPromptAfterEnter`），然后起一个**写后确认闭环**——隔
`SUBMIT_CONFIRM_DELAY_MS`（2.5s）检查输出是否在 paste 回显后重新流动，未恢复且用户未在打字时补发**裸 `\r`**，
最多 `SUBMIT_CONFIRM_MAX_RESENDS`（3）次。

### 确认信号：输出是否恢复流动（universal 判据）

「这条 prompt 到底提交没提交」的判据 = 写入后输出是否恢复流动，复用既有原语
`evaluateAgentOutputQuiet(lastOutputAt, now())`（阈值 `AGENT_OUTPUT_QUIET_THRESHOLD_MS`=2s）：

- **真提交** → agent 开始干活 → 持续产出（Claude/Codex 思考时 spinner 状态行每秒重绘，`lastOutputAt`
  恒新鲜）→ **非静默** → 判定已落地，停（打 `submit-confirmed`）。
- **CR 被吞** → 终端回落到静止 idle 框（paste 回显后再无字节）→ **静默** → 补发裸 `\r`。

这条判据对**两条路径都成立**，是统一根因修复的关键：
- **路径 A（RVF）**：agent 自然完成（Stop→to_review）后 `turnOwner="user"`；真提交触发 Claude 的
  `UserPromptSubmit` hook → `hook.to_in_progress` → reducer 把 `turnOwner` 翻回 `"agent"`，输出同时恢复。
  「turnOwner→agent」与「输出恢复」是同一件事的两种表达——hook 背书。
- **路径 B（连接中断）**：注入时 `turnOwner` **已经是** `"agent"`（连接错误不触发 Stop，Kanban 未翻面），
  故 turnOwner 区分不了 landed/swallowed；**只能靠输出恢复判据**。所以闭环统一用 output-quiet，
  不把 turnOwner 写进补发门控。

### 补发：裸 `\r`，绝不重 paste

未提交时**只补发裸回车 `"\r"`**，绝不重发整段 paste（重 paste 会复制文本——正是 B 旧的「文本翻倍」病）。
裸 `\r` 的安全性：在空 / 已提交的输入框上是 **no-op**（Claude/Codex 忽略空提交），故万一判据误判
「未提交」而其实已提交，补发也无害。

### 补发门控（与 `connection-drop` 反应自身的注入守卫同源）

确认 tick 触发后，**仅当以下全部成立**才补发裸 `\r`：

1. `evaluateAgentOutputQuiet(lastOutputAt, now())` —— 输出仍静默（= CR 被吞、框卡 idle），**且**
2. `canInjectIntoTerminalNow(active)` —— 用户近 `OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS`（8s）没敲键
   （**保护用户 stashed/在打的 prompt：用户碰键盘就让位，绝不替他提交**），**且**
3. 代际仍是当前（`submitConfirmGeneration`，被更晚的 paste 提交取代则放弃），**且**
4. 补发预算未耗尽（`SUBMIT_CONFIRM_MAX_RESENDS`）。

否则该 tick **不补发**：输出非静默（agent 在干活 / 已弹出 question·permission 对话框）→ 判定已落地/已推进，
停（**也避免把 `\r` 发进对话框误答**）；用户在打字 → 让位、再排一个 confirm tick 等待（不消耗预算）。
补发后再排下一拍，最多 N 次；耗尽仍未确认 → 打醒目 `[error] [tui-freeze] submit-unconfirmed ... after N
resends` 收尾（RVF 的 unconfirmed 仍如实反映，且有打点可查）。

### 与「写前门控」的关系

本闭环是写**后**确认补发，与既有 A1/A2 的写**前**门控（`rvf-self-injection-late-and-out-of-order-fix.md`）
正交叠加：A1/A2 降低吞 CR 概率，本闭环在仍被吞时把它救回来。

## 残留边角（已知、least-bad）

用户把一段 **>8s 没动**的陈旧文本留在框里 + RVF paste 追加其后 + CR 又恰被吞 → 补发 `\r` 会把
（陈旧文本 + prompt）一起提交。此情形下 prompt 本就真没发出去、必须补，窗口极窄。要零误触可加镜像快照
确认框内仍是未发送文本——脆，默认不加。

## 与连接中断退避的协作（不重叠）

两条重试是**不同关注点**，可共存：
- 写后确认（2.5s，本闭环）：「CR 落没落 / paste 提交没」→ 补发裸 `\r`。
- 连接中断退避（4s/15s/…，`connection-drop-auto-continue.ts`）：「agent 恢复没 / 又掉线没」→ 重发整段续跑。

连接中断首次注入在 4s、本闭环确认在该注入后 2.5s（即 6.5s）；若裸 `\r` 把续跑提交成功，输出恢复，
到 19s（4+15）连接中断退避判「recovered」→ 不重 paste。故旧的「文本翻倍」被根除。

## 关键文件 / 测试

- `src/terminal/session-manager.ts`：
  - 新方法 `writePasteSubmissionWithConfirm`（两处注入统一入口 + 起确认链）、`scheduleSubmitConfirmTick`、
    `runSubmitConfirmAttempt`（confirmed / 补发裸 `\r` / 让位 / unconfirmed 收尾）。
  - 新常量 `SUBMIT_CONFIRM_DELAY_MS=2_500`、`SUBMIT_CONFIRM_MAX_RESENDS=3`。
  - `ActiveProcessState` 新字段 `submitConfirmTimer`/`submitConfirmGeneration` + helper `clearSubmitConfirmTimer`，
    在每个既有 `clearTaskChatInputDeliveryTimer` 清理/替换点同步清除（teardown / 进程退出 / 会话替换 / 新投递）。
  - 两处 raw `session.write(toBracketedPasteSubmission(...))` 接线到统一入口（site A 保留其 `via=` 投递日志）。
- `test/runtime/terminal/session-manager-task-chat-input-delivery.test.ts`：新增 4 例——吞 CR→补发、真提交→不补发、
  用户让位→不补发（停手越窗后才补）、持续静默→补发至上限后 `submit-unconfirmed`；deadline 兜底两例改为
  「只数 paste 投递」（裸 `\r` 不计入）。
- `test/runtime/terminal/session-manager-connection-drop.test.ts`：新增「吞 CR→补发裸 `\r` 而非重 paste」回归例；
  recover 例改为「只数续跑 paste 注入」。

验证：`npx vitest run test/runtime/terminal/`（全绿，224 例）；`npx tsc --noEmit` 与 biome 干净。
