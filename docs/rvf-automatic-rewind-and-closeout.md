# RVF 默认自动恢复与收尾投递

Codex 主会话通过独立的 RVF 决策回合开审后，Kanban 默认登记自动收尾；不需要任务开关或手动启动。RVF 完成时，宿主创建开审前原生历史的分支，保留原 RVF 历史，切换当前主会话的原生身份，再自动投递 `$rvf-land` 与 `$base-branch-sync`。不部署、不移入 Done；原任务明确的不提交、不回 base、停止要求继续生效。

## 身份与完成证据

生产方在 acknowledge / prepare 之前调用 `kanban task capture-rvf-review-start-boundary --task-id <id> --decision-token <token> --project-path <main checkout>`。服务端核对 token 的会话、目录、TTL、当前原生 user message 和前一个完整回合。Git checkpoint 用独立 index 捕获现有内容，绑定 `RVF_REVIEW_START_BOUNDARY_BINDING`，不移动 HEAD，不改真实暂存区。

凭据遵循 `rvf-independent-user-turn-boundary/v1`，与独立开审 gate 的消费契约相同。完整候选指纹重建和开审准入仍归 RVF 开审 gate；Kanban 不复制候选归属算法。

RVF 把凭据复制到本轮 `inputs/automatic-closeout-review-start-receipt.json`，写 `<token>.run-binding.json`，成功 finalize 后写 `$RVF_HOME/automatic-closeout-completion-notifications/<token>.json`。通知同时绑定 run、原会话、worktree、handoff SHA256。宿主复核 run binding、finalization 和 handoff；不使用 latest run、不枚举旧 handoff。因此升级不会追溯执行历史审查。

## 持久编排

每个 workspace 保存 `rvf-automatic-rewind-and-closeout-records.json`，通过现有跨进程文件锁和原子写入更新：

1. `awaiting_rvf_completion`：等待本次 token 的完成事实。
2. `restoring_pre_review_conversation`：按 `thread/fork.lastTurnId` 创建原生前缀分支，落盘并复验身份与历史。
3. `restored_pre_review_conversation`：停止原终端、持久切换原生身份，并按明确 ID 续跑。
4. `submitting_closeout_prompt`：用固定幂等键交给现有持久队列，等待提交确认。
5. `closeout_prompt_submitted`：终端确认提交 Prompt；不代表 land 或 base 同步已完成，实际动作由 skill 执行并汇报。
6. `paused`：门禁原因留在记录和终端 warning 中；不会偷偷生成新 key 绕过失败。

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
