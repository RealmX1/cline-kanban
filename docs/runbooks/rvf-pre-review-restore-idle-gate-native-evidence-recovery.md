# RVF 完成后空闲门禁的原生补证

自动收尾进入 `restoring_pre_review_conversation` 后，原生回合可能已经完成，而 summary 的回合归属或本代输入接受仍是旧投影。
历史上 `1586d` 的样本只证明恢复停在 `requireIdle`，没有足够证据确定是哪一个子条件，不能从 `task_complete` 反推当时允许停止进程。

## 持久诊断

沿用 `kanban task rvf-automatic-closeout-status --task-id <id> --project-path <main checkout>`。
`waitingReasonCode=agent_turn_not_ready_for_closeout` 保持兼容；可选字段 `preReviewConversationRestoreIdleGateRecovery` 提供：

- `blockingConditions`：进程活性、回合归属、待答类别、本代未确认提交、后台停放及在途程序化投递，各自独立记录。
- `identity`、`evidenceFingerprint`、`evidenceSources`：绑定 workspace、主会话、incarnation、原生 thread 及独享端点。
- `attemptCount`、`lastAttemptAtMs`、`nextProbeAtMs`、`resumeCondition`：重启后沿用的补证预算与机器恢复条件。
- `failedNativeConversationTurnHistoryPageRead`：完整历史实际失败的 cursor、失败时间和最近单页能力探测结果，跨重启保留。
- `qualification`：原生完成回合、精确接受消息、摘要、记录时间及转录摘要。它只证明恢复资格，不更改原始失败账本或 summary 的 `pending/unconfirmed`。

`paused`、`completed`、明确 Stop 和备用路线所有权始终先于资格证明。已有人工接管或已完成任务不由本路径追溯 rewind。

## 自动恢复边界

仅当阻塞来自陈旧回合投影或本代接受漏报时，连接同 incarnation 的独享控制端点。必须证明：原 thread 已加载、当前 idle、最新回合明确 `completed`、无活动标记、`canAcceptDirectInput=true`。
`failed`、`interrupted`、空历史及无输入能力不能替代完成。

完整活动分支及原始 JSONL 共同核对消息 ID、回合、正文摘要、独立用户回合与时间。自动开审消息使用本 token 的原生投递凭据；手动开审使用已捕获的精确 receipt。
续跑必须同时包含本 run 的 `run_id=<id>` 和 `RVF_DECISION_TOKEN=<token>` 独立行，并有唯一原生投递账本凭据。人工插话、歧义、后继开审与身份变化均不能放行。
后续分支门禁会复验独立资格绑定的完整转录摘要，并逐条核对活动分支上所有本 run 续跑的回合 ID、消息 ID 和正文摘要；原账本为失败或接受未确认不阻断已精确补证的消息，也不改写该失败历史。

证据指纹覆盖会话语义、本代提交、转录文件状态及该任务的投递账本。查询期间与 fork、停止旧进程前重查主绑定、持久 Stop、真实待答、草稿、停放、在途投递及原生状态；出现新输入或新回合则旧证明失效。
不会刷新活动时间、回合序号或接受边沿。
fork 请求与停止进程都在最后一次异步门禁和持久保存之后执行同步检查：本代输入的单调变更序号、实际 tracker 占用与可信空框起点，以及原生转录的文件身份、字节长度和纳秒级修改版本必须保持一致。检查与副作用之间不再让出执行；新草稿或转录追加只阻止副作用，不清除输入，也不刷新 summary 活动。

每个稳定指纹最多完整补证三次，间隔 15 秒。耗尽后每 60 秒轻量探测最新回合与消息读取能力；已知失败 cursor 时只按原参数重读该页并校验完整结构，不重新遍历历史。该页从不可读转为可读，或身份、提交、转录、端点证据变化才重开完整补证预算；最新页可读不能覆盖后续页失败。
机器查询失败继续等待，不变成人工必答或永久暂停。重复等待沿用原有一次通知机制。
草稿、后台停放或在途投递引起的运行时等待不消耗本次补证预算；条件解除是独立重验边沿，即使转录、端点和原生健康指纹未变也能重新取证。预算等待保留原生失败原因，不另记一次查询失败。

fork 请求之前的资格失败可以明确记录为尚未发出；请求一旦发出而结果未知，继续保留原来的保护，不创建第二个 fork。
已确认的 fork 身份先持久化，重启复验后复用；收尾始终使用原持久幂等键。所有写入继续受 coordinator 操作锁及备用路线互斥约束。

## 自动化验证

普通回归覆盖子条件、接受漏报、预算跨重启、查询中断、人工消息、Stop、身份及回合竞态。
真实 Codex TUI 用例使用隔离 HOME、Git fixture 和本地 HTTP 模型桩，不调用付费模型：

```sh
KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY=/absolute/path/to/codex \
KANBAN_CODEX_RVF_IDLE_GATE_EVIDENCE_DIRECTORY=/absolute/persistent/evidence \
npm run test:guarded -- --project runtime-integration test/integration/codex-rvf-restore-idle-gate-recovery.integration.test.ts
```

证据目录保留原始与恢复后的转录及结果 JSON，避免将临时 fixture 路径当成交接证据。
用例确认一次恢复、身份切换和原生收尾，以及工作区、暂存和原失败账本保持不变。
