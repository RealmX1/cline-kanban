# RVF 默认自动恢复与收尾投递

Codex 主会话通过独立的 RVF 决策回合开审时，Kanban 先持久捕获非活跃分界；具备完整开审前会话前缀时，生产方成功绑定真实 run 后再显式激活默认自动收尾，不需要任务开关或用户点击。已激活的 RVF 完成时，宿主创建开审前原生历史的分支，保留原 RVF 历史，切换当前主会话的原生身份，再自动投递 `$rvf-land` 与 `$base-branch-sync`。不部署、不移入 Done；原任务明确的不提交、不回 base、停止要求继续生效。

## 身份与完成证据

生产方在 acknowledge / prepare 之前调用 `kanban task capture-rvf-review-start-boundary --task-id <id> --decision-token <token> --project-path <main checkout>`。服务端核对 token 的 task、会话、目录、TTL、当前原生 UserMessage 与独立 user turn；自动决策消息在存在前一回合时还要求其已完整结束，真实手动开审不受此前回合完成条件限制。Git checkpoint 用独立 index 捕获现有内容，绑定 `RVF_REVIEW_START_BOUNDARY_BINDING`，不移动 HEAD，不改真实暂存区。

凭据遵循 `rvf-independent-user-turn-boundary/v1`。除 token、原生 message/turn、原始正文 SHA256 外，checkpoint 正文的绑定 JSON 包含 task/key、候选指纹、候选文件身份签名、HEAD、比较基线及本地 base tip；不以 schema 名相同代替字段核验。文件身份签名与 RVF 的 Python 算法逐字对照，设备号、inode、纳秒 mtime/ctime 均以 bigint 十进制编码，避免跨语言整数精度丢失。内容写回原样后也不能复用旧分界。完整候选归属与指纹重建、checkpoint 内容/权限/链接校验和最终开审准入仍归 RVF gate。

自动单行标记的 token 必须 explicit=false 且无显式请求 provenance。真实手动消息沿用 UPS 的显式调用识别，支持前置文字与主 skill 命名空间，必须同时有 `developer_manual_trigger_via_user_prompt_submit` 来源；Agent reason、普通成果交接、姊妹 skill 调用、同 turn 的第二条消息均不构成手动开审证据。原生 JSONL 必须有对应的 user 发起 `task_started`、唯一 `item_completed.UserMessage`、精确正文与接收时间。自动消息须落在 token 时窗内；手动消息可先于 UPS 铸币最多 120 秒。

捕获按 token 加锁，并将原生 session/message 排他绑定到唯一 token。checkpoint ref 不可覆盖；重试复用首次完整 receipt。存量自动收尾记录缺候选身份签名时仍可读，但不能因读取成功就获得新 gate 的开审资格。

捕获只保存 `captured_review_start_boundary`，同一 token 重试直接复用完整 receipt、checkpoint 与 `preReviewTurnIds`；即使 bootstrap 已增加原生回合，也不重捕获。未绑定、bootstrap 失败和仅捕获的记录均不检查完成事实、不 fork、不投递，跨进程重启仍保持非活跃。

RVF 把凭据复制到本轮 `inputs/automatic-closeout-review-start-receipt.json`，写 `$RVF_HOME/review-start-independent-user-turn-boundary-receipts/<token>.run-binding.json`，然后调用 `kanban task activate-rvf-automatic-closeout-after-run-binding --task-id <id> --decision-token <token> --project-path <main checkout>`。入口成功返回均包含与捕获逐字段相同的 `receipt`，是否跳过自动收尾按下述状态区分。对具备完整前缀的记录，服务端核对 run id、真实目录、完整 receipt 与排序后 SHA256；首次激活再复核当前主会话、原生身份、transcript 与 worktree。只有非活跃捕获能转入等待完成；重复激活复用绑定，不覆盖阶段，已显式停止的 `paused` 记录不能重新激活。

若手动开审消息就是第一条用户消息，或前一回合已中断而没有可自动恢复的完整前缀，仍可提供独立开审 receipt；记录保留真实前缀 IDs，并另记自动恢复不可用的原因。激活入口在 run 绑定核验与当前主会话复核之前返回 `automaticCloseoutActivationStatus=skipped_no_completed_pre_review_conversation_prefix`；此响应只表示复用已捕获的 receipt 并跳过可选自动收尾，不表示 run 绑定已核验。记录保持 `captured_review_start_boundary`，不写入 run 绑定、不 fork 或投递；已有的 `paused` 记录仍拒绝激活。独立开审证明与可选自动恢复的能力分开，捕获或跳过状态不替代原生独立消息、本次 nonce 的活动分支观测或 rewind 完成证据。

## 本次 nonce 的实时分支观测

```
kanban task message-status --project-path <main checkout> --task-id <id> \
  --idempotency-key rvf-decision-point-<token> \
  --review-start-boundary-observation-nonce <本次随机 nonce>
```

该查询经 runtime 的 `observeRvfReviewStartBoundary` 读取当前主会话，以捕获记录定位 receipt。手动命令没有程序化投递账本，返回独立证据而不伪造终端送达状态。常规不带 nonce 的查询保持原来的投递账本语义。

每次观测新建客户端连接到当前 summary 的 `codexNativeSessionControlEndpoint`，其 workspace、会话与 incarnation 必须吻合；先通过 `thread/loaded/list` 确认精确 thread 已由宿主持有，再分页读取 `thread/turns/list`。返回原生分支上的全部 UserMessage ID、当前用户 turn，以及本次 nonce/task/key/session；观测前后复核主会话、incarnation 与端点身份。连接不启动、重启或停止宿主，不 resume/装载历史 thread，不发起模型请求。缺少绑定端点或已加载控制面时返回 `review_start_boundary_pending_reason`，不返回正向观测；重启后没有可复用的 nonce 缓存。

Codex 0.163.0 的真实隔离 TUI 实验证明：UI rewind 后原始 rollout 仍可保留被撤回 UserMessage，而宿主控制面的 turns 已移除该消息。单独启动的 `app-server --stdio` 只适合作历史/前缀操作，不能用于实时资格证明；`app-server proxy` 是原始 WebSocket 字节代理，也不能当 JSONL RPC 使用。此证据限定于已验证的 Codex TUI 版本，不外推其它 harness 或 GUI。

## 按会话隔离的原生控制宿主

runtime 在 Codex 的最终 adapter argv 确定后准备独享宿主。PTY 中的 `codex-native-session-control-host` 监督进程先启动该会话自己的前台 `app-server --listen unix://...`，就绪后以 `--remote` 启动原生 TUI。配置覆盖传给两端；模型、权限、工作目录、原生 resume/fork 参数和正文由 TUI 原样消费，Plan Mode 的 deferred prompt 仍由原有终端链提交。server 与 TUI 继承同一份本会话 hook 环境，不启动共享默认 daemon，也不把其它任务附着到先启动者的环境。

每次真实启动分配新 incarnation 和独享 socket，summary 只记录该代端点。启动描述与私有日志位于 runtime home 的 `codex-native-session-control-host-launches/<incarnation>`（目录700、描述600），短 Unix socket 目录与进程同寿。prepare/spawn 失败、TUI 退出、server 失败及停止信号均清理本代资源；清理前复核目录设备号/inode，不能删替换后的目录。临时 socket 目录不是交接产物，重启后的新代不会复用它。

既有 agent session PTY host 启用时，监督进程也由它持有。runtime 热重连/崩溃接管保留进程、summary incarnation 和控制端点，不通过重启 Codex 来补能力；真实停止后重开才换代。监督进程并行停止子进程，并在等待退出前撤销本代 socket 与启动目录；runtime 接管从匹配端点的持久启动描述重建带 dev/ino 校验的 cleanup，确保监督进程来不及执行 finally、被强杀时仍可清理本代资源。未启用 PTY host 时沿用原有 runtime 与会话同寿的边界。

显式 `--remote`、`--no-daemon`、`-p/--profile`、不支持 Unix 控制面的原生版本及 Windows 保持原生启动选择；没有本代控制端点时独立开审门禁诚实等待。Codex 0.163.0 的 app-server 拒绝 `--profile`，`-c profile=…` 也会触发已退休的旧版配置错误；把 profile 文件转成普通 `-c` 则会改变它与项目配置的优先级。因此 profile 启动保留完整原生 argv 与原配置目录，不登记控制端点、不声称具备实时分支证明；真实隔离 TUI 测试验证了 profile 中 provider、model 与指令的消费。存量安装会话不会因升级被自动打断，它们须在合适的真实重启后获得新能力；只看到默认 daemon 中有同名 thread 不足以给旧 TUI 授权。

验证入口包括 `codex-native-session-control-host-lifecycle.integration.test.ts`（进程/环境隔离与失败清理）、`codex-native-control-host-packaged-runtime-adoption.integration.test.ts`（真实打包 API/PTY host 接管）、原生 rewind 夹具的受控自动与原样命名空间手动模式。实际 e9e12 活动分支 consumer 在隔离传输中先生成自己的 nonce，再驱动当前原生宿主实时查询，分别验证当前分界可接受与回退后拒绝；没有把旧观测改写 nonce 来凑兼容。

## 完成通知

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

此能力需要 Kanban 与 RVF 生产方共同更新；仅部署一个仓库不能形成闭环。RVF 侧接口依据其独立消息契约与实际 verifier；两侧需分别部署。独立开审 gate（e9e12）和已完成 run marker 清理（f03b5）的现有职责不迁入宿主。

部署前验证覆盖精确前缀、原历史与文件/暂存保留、真实 Codex app-server、持久队列、重入与人工介入。部署后自动验收读取真实运行实例新产生的绑定记录和投递账本；没有新样本时报告尚未观察到，不以旧 run 充数。

本卡的自动化入口：`test/runtime/rvf-automatic-closeout/` 验证来源、候选身份、checkpoint 与两阶段生命周期；`KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY=<consumer checkout>` 可让捕获套件直接调用实际 RVF Python verifier。`KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY=<codex binary>` 启用 `codex-native-review-start-boundary-and-rewind.integration.test.ts`，其本地模拟模型、隔离 HOME、真实 TUI 与 Git fixture 不接触生产 token；`KANBAN_CODEX_RVF_NATIVE_BOUNDARY_EVIDENCE_DIRECTORY` 可指定持久日志目录。
