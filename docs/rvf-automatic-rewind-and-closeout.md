# RVF 默认自动恢复与收尾投递

Codex 主会话通过独立的 RVF 决策回合开审时，Kanban 先持久捕获非活跃分界；生产方成功绑定真实 run 后再显式激活默认自动收尾，不需要任务开关或用户点击。RVF 完成时，宿主创建开审前原生历史的分支，保留原 RVF 历史，切换当前主会话的原生身份，再自动投递 `$rvf-land` 与 `$base-branch-sync`。不部署、不移入 Done；原任务明确的不提交、不回 base、停止要求继续生效。

## 身份与完成证据

生产方在 acknowledge / prepare 之前调用 `kanban task capture-rvf-review-start-boundary --task-id <id> --decision-token <token> --project-path <main checkout>`。服务端核对 token 的会话、目录、TTL、当前原生 user message 和前一个完整回合。Git checkpoint 用独立 index 捕获现有内容，绑定 `RVF_REVIEW_START_BOUNDARY_BINDING`，不移动 HEAD，不改真实暂存区。

凭据遵循 `rvf-independent-user-turn-boundary/v1`，与独立开审 gate 的消费契约相同。完整候选指纹重建和开审准入仍归 RVF 开审 gate；Kanban 不复制候选归属算法。

捕获只保存 `captured_review_start_boundary`，同一 token 重试直接复用完整 receipt、checkpoint 与 `preReviewTurnIds`；即使 bootstrap 已增加原生回合，也不重捕获。未绑定、bootstrap 失败和仅捕获的记录均不检查完成事实、不 fork、不投递，跨进程重启仍保持非活跃。

RVF 把凭据复制到本轮 `inputs/automatic-closeout-review-start-receipt.json`，写 `$RVF_HOME/review-start-independent-user-turn-boundary-receipts/<token>.run-binding.json`，然后调用 `kanban task activate-rvf-automatic-closeout-after-run-binding --task-id <id> --decision-token <token> --project-path <main checkout>`。激活返回与捕获逐字段相同的 `{receipt}`；服务端核对 run id、真实目录、完整 receipt 与排序后 SHA256，再复核当前主会话、原生身份、transcript 与 worktree。只有非活跃捕获能转入等待完成；重复激活复用绑定，不覆盖阶段，已显式停止的 `paused` 记录不能重新激活。

成功 finalize 后，RVF 写 `$RVF_HOME/automatic-closeout-completion-notifications/<token>.json`。通知同时绑定 run、原会话、worktree、handoff SHA256。宿主复核激活时绑定的 run、finalization 和 handoff；不使用 latest run、不枚举旧 handoff。因此升级不会追溯执行历史审查。

## 持久编排

每个 workspace 保存 `rvf-automatic-rewind-and-closeout-records.json`，通过现有跨进程文件锁和原子写入更新：

1. `captured_review_start_boundary`：持久保存开审前分界，尚未激活；runtime 和独立 coordinator 均跳过。
2. `awaiting_rvf_completion`：真实 run 双向绑定已核验，等待本次 token 的完成事实。
3. `restoring_pre_review_conversation`：按 `thread/fork.lastTurnId` 创建原生前缀分支，落盘并复验身份与历史。
4. `restored_pre_review_conversation`：停止原终端、持久切换原生身份，并按明确 ID 续跑。
5. `submitting_closeout_prompt`：用固定幂等键交给现有持久队列，等待提交确认。
6. `closeout_prompt_submitted`：终端确认提交 Prompt；不代表 land 或 base 同步已完成，实际动作由 skill 执行并汇报。
7. `paused`：门禁原因留在记录和终端 warning 中；不会偷偷生成新 key 绕过失败。

原生 fork 发出前也记录尝试。若崩溃时连新分支身份都无法确认，暂停，避免盲目再建分支。已确认身份的恢复会复验并复用它。持久投递沿用既有账本：明确失败或跨重启未确认不能视为送达，也不自动重排。

同一条记录的恢复与入队通过独立跨进程操作锁互斥；取锁后重读记录，并用持久认领 ID 校验每次推进。锁失效或其他运行时接管后，旧持有者不能覆盖恢复身份和用户暂停状态。原生身份切换与入队前也复核认领。

恢复前后核对 HEAD、已暂存/未暂存补丁和未跟踪文件。人工插话、用户已排队指令、待答问题、输入框占用、park、当前主会话改变或明确停止均会让位或暂停。主会话通过 `task-main-conversation-session-binding` 的 canonical 绑定解析，交接和自动恢复共用卡片级串行入口；保留交接后主会话自己的启动权限和模型配置。外层 Kanban 会话绑定保持不变，仅切换其 Codex 原生身份。

开审后的 RVF 续跑消息按已确认提交的投递账本识别：接受宿主 Task 或当前主会话寻址，兼容生产方的 `review-validate-fix` source。其他任务、人工来源、失败或未确认投递的同文消息不能据此放行。用户明确停止时，宿主持久暂停记录并取消固定幂等键的排队投递；晚于停止入队的条目补撤，终端受理和实际写入前还会复核暂停。已确认提交的事实继续保留。

查询入口：

```bash
kanban task rvf-automatic-closeout-status --task-id <id> --project-path <main checkout>
```

## 交付与验证边界

此能力需要 Kanban 与 RVF 生产方共同更新；仅部署一个仓库不能形成闭环。RVF 侧源码位于本任务专属的持久 worktree，交接位置见 task 297ef 的实施记录。独立开审 gate（e9e12）和已完成 run marker 清理（f03b5）的现有职责不迁入宿主。

部署前验证覆盖精确前缀、原历史与文件/暂存保留、真实 Codex app-server、持久队列、重入与人工介入。部署后自动验收读取真实运行实例新产生的绑定记录和投递账本；没有新样本时报告尚未观察到，不以旧 run 充数。
