# RVF 收尾指令确认超时后的原生接受补证

此入口恢复已经发生、后来才取得可信证据的收尾接受事实。它不改变首次终端确认预算，也没有消除原生压缩导致的首次确认超时。原失败账本继续保留；成功补证不代表 land、base 同步或部署已经完成。

## 自动补证（任务 b1b63）

运行时自动扫描、外部状态查询及 completed 阶段报告现在复用同一个严格补证内核。仅确认预算耗尽导致的暂停进入自动候选；显式停止、失效绑定、结案或主会话交接均不绕过。内部操作读取状态时只返回快照，避免递归等待自己持有的 workspace 队列。

相同原生身份、接受状态和转录文件版本至多尝试三次，未知结果退避 15 秒；新证据或服务重建重新核验。每次核验按原工作单元、token、run 和 handoff 绑定单飞，原始失败账本保持不变，不重新粘贴正文、不创建新幂等键。机器可读结果记录在 `rvf-late-native-closeout-prompt-acceptance-automatic-recovery` 诊断通道。

`5de70` 样本还包含中断后开启新回合的事实，不能将整个间隔叙述为首次提交持续压缩。补证凭据记录实际被接受的消息和回合，不把后续同正文提交改写成首次回执成功。自动补证只恢复收尾资格，完成报告仍逐项验证实际 land/base 证据。

## 已确认的间歇状态来源

2026-10-23 至 2026-10-24 的三个失败样本和一个成功样本均使用 Codex TUI `0.164.0`，Kanban 部署同为 `c4a2d1950d247c6c27bc37d1d069453085c7f8d9`。成功不能归因于本修复已经安装。

| 样本 | fork 前明确保留的原生记录数 | 最后一次请求 input tokens | 收尾回合中的压缩 | 创建到终端回执 | 回执后到精确正文记录 |
| --- | ---: | ---: | --- | --- | --- |
| `38fd3` | 504 | 227,396 | 无 | 5.555 秒，confirmed | 不适用 |
| `c4c82` | 896 | 394,943 | 有 | 16.419 秒，failed | 105.155 秒 |
| `1c6e4` | 1,090 | 385,898 | 有 | 17.034 秒，failed | 118.335 秒 |
| `46d51` | 994 | 427,071 | 有 | 16.372 秒，failed | 109.883 秒 |

本表的正文时间取原生 `response_item`；后续 `item_completed.UserMessage` 通常晚 1–2 毫秒。补证使用有 message ID、turn ID 的后者，凭据明确命名为 `nativeUserMessageRecordedAt`，不把它冒充最早接受时间。

祖先用量只读取 `history_base` 明确引用的字节与逻辑 ordinal 边界，按 `session_meta` 验证归属，递归处理分页；不用开审后的最新用量解释开审前状态。这四个前缀均无 `compacted`，最后一次模型均为 `gpt-6.1-sol`、报告的 context window 均为 475,000。`c4c82` 前缀最后一次 effort 是 `xhigh`，其恢复会话为 `max`；其余三个前缀为 `max`。

已证实的链条是：三个失败样本在失败回执前已进入原生 user turn，压缩完成后才出现精确正文。正常对照没有该次压缩，正文在确认窗口内出现。失败样本继承的请求用量更高，与压缩触发的条件差异相符；这不是同样前置状态下随机一成一败的证明。

[官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)把 `model_auto_compact_token_limit` 定义为自动压缩阈值，未设置时使用模型默认值；`model_auto_compact_token_limit_scope` 可影响计算范围。历史转录没有保存这四次启动实际生效的阈值、scope，以及 fork 后包含最新指令的首次提交 token 估算。当前 config 或模型缓存不能补成历史事实。因此可以证明不同历史状态与不同压缩阶段，尚不能逐个证明触发阈值公式，或断言 38fd3 恰因某个确定阈值而免于压缩。

## 首次判定、事后恢复及剩余改进

`TerminalSessionManager.runSubmitConfirmAttempt` 的静态确认链没有 `ContextCompaction` 工作阶段分支。它核对仍属于原投递的代际与身份，读取 composer/启动状态，等待精确原生接受；正文不在 composer 且尚未到截止时间时继续排 tick，到截止时间仍无确认则以 `submit_confirmation_budget_exhausted` 结算。当前源代码的确认链绝对预算为 CR 后 15 秒；观察到的创建至回执 16–17 秒还包含排队、就绪和摄入时间，不能反推为配置预算。

`task_started`、输出恢复和压缩活动都没有精确正文，不能替代 UserMessage 确认。活动 reader 虽然把 `contextCompaction` 分类为 `context_compaction`，确认链并未消费该工作阶段来暂停截止时间。回执结算后旧 pending receipt 不再关联迟到的原生消息；终端账本终态不可覆盖，自动协调器又跳过 `paused`，因而形成无法自行追认的状态。本修复补上显式追认及真实受阻结果登记。

生产进程的 stderr 在本次调查时连接 `/dev/ttys002`，未取得三个事发时点的持久逐 tick 日志或屏幕快照。因此，确认链可复现的截止分支、原生事件顺序已经明确；单一失败原因码不能独立证明每个样本恰走了哪个内部出口，更不能证明 CPU、人类输入或网络是耗时根因。

源头改进有必要，但应另以可信阶段观测为前提：在相同本代端点、native session、相关 turn 上观测真实压缩开始/结束；仅在该阶段暂停普通正文确认计时，另设有限的压缩等待预算，停止与身份变化立即撤销。仍须等精确正文，不能重 paste 或以 `task_started` 提前确认。若控制面只在压缩完成后才暴露 item，则该信号不足以预防首次超时；应先补开始事件能力和诊断，不能据此无条件扩大等待。本次没有实现此阶段感知策略，也没有改 Codex 的压缩阈值。

仍待观测：当时有效阈值/scope、首次提交 token 估算、压缩开始事件在实时控制面的可见时间、三个生产样本的逐 tick 分支，以及压缩耗时中服务端、网络与宿主调度各占多少。状态来源已缩小到可核验的原生阶段与确认窗口错位，精确触发公式仍为 unknown。

## 恢复命令

由消费者所属任务或协调者选择实际执行时机；先正常恢复同一 native session，使其拥有可信的本代控制端点。本命令不会启动、重启、resume、fork 或 rewind 原生会话。

```sh
kanban task reconcile-rvf-automatic-closeout-late-native-prompt-acceptance \
  --project-path <main checkout> --task-id <task> --decision-token <token> \
  --run-id <绑定 run ID> --handoff-sha256 <绑定 SHA256> --dry-run
```

`eligible` 表示本次只读核验通过，原记录仍暂停。去掉 `--dry-run` 后成功返回 `recovered`，保存不可覆盖的 `lateNativePromptAcceptanceRecoveryReceipt`，将当前状态推进为 `closeout_prompt_submitted`。重复调用重新核验当前活动分支，返回 `already_recovered`，不重复写凭据。普通 confirmed/completed 记录没有补证凭据时明确不适用此入口，原正常路径继续保持。

`unknown` 与 `blocked` 均以 12 退出，并返回 `reasonCode` 和原因。缺控制面、缺精确正文、格式不完整或分页不可确认时保持 unknown；显式停止、身份/绑定变化、非指定暂停原因或原生消息已不在活动分支时阻断。不要换幂等键重投。

服务端核验原 run 完成与 handoff、原失败 ledger、精确正文哈希及 token/run/handoff 行、原生 session/message/turn、发生在原投递之后的事件时间，并通过本代宿主的完整分页核对消息仍在活动分支。观测前后重验身份，使用跨进程单飞锁，写锁内复查记录和停止标记。原始转录快照保存字节数与摘要，后续可追加，但不能改写补证时已读前缀。

## 阶段结果与历史

正确绑定的 `paused` 记录可继续通过原 `report-rvf-automatic-closeout-execution-result` 报告 `blocked` 或 `failed`，无需投递成功证明；会话/工作区、run/handoff 仍需核对。此动作不解除暂停。完全相同的报告不增加历史，不同实际结果追加到 `executionResultReportHistory`，已有 completed 结果不可覆盖。

完成报告仍须已确认投递，或由服务端重新验证有效的补证。land 继续核对真实 commit、当前 run 的 evidence 及摘要、工作区/common-dir 绑定和 HEAD 祖先；base 同步继续核对 land 已完成、本地 base ref 和祖先关系。仅两阶段都真实完成才写整体 `completed`。

## 自动控制验证和交接证据

`session-manager-task-chat-input-delivery.test.ts` 以同一正文重放正常及时观察、三个压缩后正文时间、同一接受时间但观察调度延后、启动等待等安排；证明观察跨过确认截止后会先产生终态，后来接受不会改写回执。测试固定的是受控输入和调度，不是用样本秒数假定生产配置预算。

收尾 service 回归覆盖补证、只读 dry-run、停止/身份切换、分页缺失、活动分支回退、跨 service 单飞、服务重建、阶段历史和 completed 证据门禁；38fd3 正向对照保持正常确认和完成记录不被补证逻辑重排。CLI 集成经过真实 HTTP/tRPC 与 Unix WebSocket，在隔离 HOME 中验证 exit 12、随后补证及服务重建，无真实消费任务或付费模型参与。

本轮实际直接分析的成功样本为 38fd3。9c9c1、df81c、30555 仅作为协调报告背景，本卡没有独立重跑它们，也不把引用等同于已完成回归。

持久交接目录：`~/.cline/kanban/cross-task-handoff-artifacts/task-7e075-rvf-late-native-closeout-acceptance-recovery/`。其中 `analyze-native-closeout-compaction-preconditions.py` 可重建四样本 ancestry 用量观察，`native-compaction-preconditions-observation.json` 保存来源边界与摘要；最终交接附实际检查、提交及逐样本命令。消费者正式恢复由 646eb 协调，本任务不修改它们的账本，不替它们 commit/base-sync，不部署。
