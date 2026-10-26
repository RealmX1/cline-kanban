# RVF 默认自动恢复与收尾投递

普通扩围的后继候选隔离、原生发送持久化和跨重启补证见 [RVF 候选版本与原生投递恢复](rvf-candidate-version-and-native-prompt-recovery.md)。

## 普通审查与可选自动收尾

普通 RVF 以真实决策 token 和独立候选快照冻结输入。Harness 发行版本、原生回退 receipt、当前控制端点或完整历史前缀缺失时，review/fix/handoff 仍可继续，随后人工 land/base 同步。下文的独立原生分界与实时 nonce 只服务自动恢复，不是普通审查准入条件。

原生 reader 识别受支持的 TUI 事件格式，不按 `cli_version` 白名单放行。转录记录版本可能来自旧会话，不能当作当前进程版本或能力证明。自动注册的 pending/disabled 状态不会触发恢复；即使激活响应丢失，消费者也核对 run 内的 `automatic-closeout-registration.json`，防止迟到激活与人工收尾同时执行。

自动收尾因 summary、工作目录或原生身份尚未恢复而等待时，保存 `waitingReasonCode`、`waitingReason`、`waitingSince`；条件恢复后继续。相同原因持续 30 秒只通知一次，重启不重复通知。用户明确停止、身份确实改变及 fork 结果未知继续保留暂停保护，历史暂停记录不批量复活。

RVF 已完成而空闲投影或本代输入接受滞留时，`preReviewConversationRestoreIdleGateRecovery` 独立记录各阻塞项及恢复资格，经同代原生完成与精确消息归属补证后自动接续。三次补证预算、跨重启健康探测及 fork/停止前竞态门禁见[空闲门禁原生补证 runbook](runbooks/rvf-pre-review-restore-idle-gate-native-evidence-recovery.md)。

自动指令送达后，收尾 Agent 逐阶段通过 `kanban task report-rvf-automatic-closeout-execution-result --project-path <main checkout> --result-file <JSON>` 上报 `land` 和 `base_branch_sync`。报告绑定 task/token/run/handoff；成功必须提供实际提交，base 同步还需本地 base ref。服务端核对恢复会话、真实投递账本、land evidence 摘要及 Git 祖先关系。只有两阶段都完成才写 `completed`，`closeout_prompt_submitted` 仍只表示指令已提交。受阻或失败保存具体原因，不能用自然语言自述替代成功证据。

Codex 主会话通过独立的 RVF 决策回合开审时，Kanban 先持久捕获非活跃分界；具备完整开审前会话前缀时，生产方成功绑定真实 run 后再显式激活默认自动收尾，不需要任务开关或用户点击。已激活的 RVF 完成时，宿主创建开审前原生历史的分支，保留原 RVF 历史，切换当前主会话的原生身份，再自动投递 `$rvf-land` 与 `$base-branch-sync`。不部署、不移入 Done；原任务明确的不提交、不回 base、停止要求继续生效。

## 身份与完成证据

生产方在 acknowledge / prepare 之前调用 `kanban task capture-rvf-review-start-boundary --task-id <id> --decision-token <token> --project-path <main checkout>`。服务端核对 token 的 task、会话、目录、TTL、当前原生 UserMessage 与独立 user turn；自动决策消息在存在前一回合时还要求其已完整结束，真实手动开审不受此前回合完成条件限制。Git checkpoint 用独立 index 捕获现有内容，绑定 `RVF_REVIEW_START_BOUNDARY_BINDING`，不移动 HEAD，不改真实暂存区。

凭据遵循 `rvf-independent-user-turn-boundary/v1`。除 token、原生 message/turn、原始正文 SHA256 外，checkpoint 正文的绑定 JSON 包含 task/key、候选指纹、候选文件身份签名、HEAD、比较基线及本地 base tip；不以 schema 名相同代替字段核验。文件身份签名与 RVF 的 Python 算法逐字对照，设备号、inode、纳秒 mtime/ctime 均以 bigint 十进制编码，避免跨语言整数精度丢失。内容写回原样后也不能复用旧分界。完整候选归属与指纹重建、checkpoint 内容/权限/链接校验和最终开审准入仍归 RVF gate。

自动单行标记的 token 必须 explicit=false 且无显式请求 provenance。真实手动消息沿用 UPS 的显式调用识别，支持前置文字与主 skill 命名空间，必须同时有 `developer_manual_trigger_via_user_prompt_submit` 来源；Agent reason、普通成果交接、姊妹 skill 调用、同 turn 的第二条消息均不构成手动开审证据。原生 JSONL 必须有对应的 user 发起 `task_started`、唯一 `item_completed.UserMessage`、精确正文与接收时间。自动消息须落在 token 时窗内；手动消息可先于 UPS 铸币最多 120 秒。

捕获按 token 加锁，并将原生 session/message 排他绑定到唯一 token。checkpoint ref 不可覆盖；重试复用首次完整 receipt。存量自动收尾记录缺候选身份签名时仍可读，但不能因读取成功就获得新 gate 的开审资格。

捕获只保存 `captured_review_start_boundary`，同一 token 重试直接复用完整 receipt、checkpoint 与 `preReviewTurnIds`；即使 bootstrap 已增加原生回合，也不重捕获。未绑定、bootstrap 失败和仅捕获的记录均不检查完成事实、不 fork、不投递，跨进程重启仍保持非活跃。

RVF 把凭据复制到本轮 `inputs/automatic-closeout-review-start-receipt.json`，写 `$RVF_HOME/review-start-independent-user-turn-boundary-receipts/<token>.run-binding.json`，然后调用 `kanban task activate-rvf-automatic-closeout-after-run-binding --task-id <id> --decision-token <token> --project-path <main checkout>`。入口成功返回均包含与捕获逐字段相同的 `receipt`，是否跳过自动收尾按下述状态区分。对具备完整前缀的记录，服务端核对 run id、真实目录、完整 receipt 与排序后 SHA256；首次激活再复核当前主会话、原生身份、transcript 与 worktree。只有非活跃捕获能转入等待完成；重复激活复用绑定，不覆盖阶段，已显式停止的 `paused` 记录不能重新激活。

若手动开审消息就是第一条用户消息，或前一回合已中断而没有可自动恢复的完整前缀，仍可提供独立开审 receipt；记录保留真实前缀 IDs，并另记自动恢复不可用的原因。激活入口在 run 绑定核验与当前主会话复核之前返回 `automaticCloseoutActivationStatus=skipped_no_completed_pre_review_conversation_prefix`；此响应只表示复用已捕获的 receipt 并跳过可选自动收尾，不表示 run 绑定已核验。记录保持 `captured_review_start_boundary`，不写入 run 绑定、不 fork 或投递；已有的 `paused` 记录仍拒绝激活。独立开审证明与可选自动恢复的能力分开，捕获或跳过状态不替代原生独立消息、本次 nonce 的活动分支观测或 rewind 完成证据。

## 自动决策点的独立原生回合投递

自动决策点首次投递与重新请求均使用 `task message --deliver-when-agent-idle --max-wait-for-agent-idle-ms <TTL> --require-native-independent-user-turn-for-session <native session id>`。调用方只指定原生 session；宿主在首次入队时保存 `requiredNativeIndependentUserTurnSessionId` 与当前 `requiredNativeIndependentUserTurnSessionIncarnationId`，并在注入账本保存对应 snake_case 字段。同 key 必须保持正文与 session 要求；重发只返回首次投递事实，不重新排队、不延长 TTL、不把原始 incarnation 换成本代。

summary 空闲仅是初筛。dispatcher 认领前连接该 TUI 当前绑定的控制端点，确认 thread 已加载，再要求最后原生 turn 为 `completed`。未完成时每 500ms 重查，始终受首次 TTL 约束，不占 PTY、不增加投递次数。claim 在文件锁内核对已经核验的精确队首，避免普通队首取消后误认领严格后继消息。查询后重读取消与到期状态；缺控制面或会话换代时明确失败，不降级普通投递。已过期、取消或跨 runtime 重启的程序化条目沿原有终态纪律处理，不复活。

认领前的控制连接超时、连接暂断和原生请求超时属于机器等待。队列的可选 `nativeIndependentUserTurnPreflightQueryRecovery` 保存查询失败次数、具体原因、等待起点和下次查询时间，按 1、2、4、8、15 秒上限退避，受原始 `expiresAt` 约束。查询失败不增加实际投递次数，不写终态失败账本；恢复后重新核验当前身份及精确队首，仍只用原幂等键投递一次。到期仍未恢复时保留查询失败原因，不能误写成 Agent 一直未空闲。

runtime 热重启后，仅持久证明尚未认领、投递次数为零且同一原生 session/incarnation 仍有活体控制端点的查询等待可以恢复托管。心跳或会话证据暂不可读时等待机器补证；身份已变化则结算原绑定的失败。已进入 transport 的未知结果、已取消、已失败和已过期条目保持原终态纪律。

手动主 skill 调用复用未开审自动 token 的处理属于 RVF 生产方：取消旧决策投递、保留旧自动来源和失败，再以可恢复的替代事务创建真实 manual UPS 来源的新 token。新 token 仍须取得独立开审凭据。自然语言请求不会据此成为手动来源，已绑定的 run 也不会再开第二轮。

通过 Codex 原生 `turn/start` 投递独立 UserMessage 时须显式传 `turnTrigger=user`；否则 Codex 0.164.0 会写入未知回合归属，不能据此取得独立开审证据。该协议分类不改变 token 或注入账本的程序化来源。转录读取器允许历史记录的 `turn_trigger=null`，但只把明确的 `user` 归属当作目标消息的用户回合证据，未知归属仍不放行。

粘贴、首个 CR 和补发 CR 前都复核同一 incarnation 与完成的前置 turn。若本条正文已经成为唯一后继原生 UserMessage，则停止补发并确认原始投递；该结果仍不能代替开审捕获的原生证据与 checkpoint/nonce 门禁。缺控制能力和会话替换分别在 message-status 暴露 `native_independent_user_turn_capability_unavailable`、`native_independent_user_turn_session_replaced`；等待原生回合完成直到截止仍使用 `agent_never_became_idle_before_queued_delivery_deadline`，查询失败直到截止则保留能力查询失败原因。原始要求字段说明所等待的原生约束。

捕获成功仅返回 `{status:"captured",receipt}`。已知失败返回 `{status:"pending"|"invalidated",reason,reason_code,recovery_action}`，CLI 以 12 退出；未知基础设施异常由顶层报告正文并以 1 退出。原因码区分未取证能力、尚未观测分界、同 turn 多消息、未完成前置回合、token 到期和绑定失效。恢复动作分别为等待原生完成、完成后请求新分界、修复宿主能力、重试捕获或检查诊断。带 nonce 的 message-status 失败也给出结构化原因与恢复动作。终态/失效 token 不能经捕获重新激活；已保存 receipt 的幂等返回仅复用历史事实，实时资格仍须单独核验。

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

runtime 在 Codex 的最终 adapter argv 确定后准备独享宿主。PTY 中的 `codex-native-session-control-host` 监督进程先启动该会话自己的前台 `app-server --listen unix://...`，就绪后以 `--remote` 启动原生 TUI。新建会话继续由 TUI 消费完整 argv；恢复与 fork 先走下面的原生握手。Plan Mode 的 deferred prompt 仍由原有终端链提交。server 与 TUI 继承同一份本会话 hook 环境，不启动共享默认 daemon，也不把其它任务附着到先启动者的环境。

Codex 0.163.0 拒绝 remote resume/fork 的权限旗标及权限配置覆盖，不能把原始权限参数直接转发给远程 TUI。受管启动把 approval、sandbox、reviewer 与附加可写目录交给 `thread/resume` / `thread/fork`，核对返回的身份、工作目录和有效权限后，才以不含权限覆盖的 `resume <confirmed-id>` 接入 TUI；fork 正文只随这次 TUI 启动提交。已加载 thread 的 resume 若忽略覆盖，使用 `thread/settings/update` 后无覆盖读回，仍不一致则失败并清理，不能降为全放行。此适配不迁移新建会话的原生权限模型。

显式 ID 保持跨目录寻址；`--last` 通过原生 `config/read` 与 `thread/list` 按 provider、来源及 cwd 选择，先查状态 DB，无命中才让原生扫描修复索引。无目标不创建空会话，非幂等 fork 不盲目重试。启动握手不调用 `turn/start`，其连接在 TUI 存续期间保留订阅，进程数仍为原有的监督进程、app-server 与 TUI 三个。成功核对的权限与身份写入本代私有 `remote-conversation-bootstrap-receipt.json` 及轮转诊断通道 `codex-remote-conversation-bootstrap-confirmed`，不记录正文；退出时清理本代 receipt，轮转日志保留诊断证据。

每次真实启动分配新 incarnation 和独享 socket，summary 只记录该代端点。启动描述与私有日志位于 runtime home 的 `codex-native-session-control-host-launches/<incarnation>`（目录700、描述600），短 Unix socket 目录与进程同寿。prepare/spawn 失败、TUI 退出、server 失败及停止信号均清理本代资源；清理前复核目录设备号/inode，不能删替换后的目录。临时 socket 目录不是交接产物，重启后的新代不会复用它。

既有 agent session PTY host 启用时，监督进程也由它持有。runtime 热重连/崩溃接管保留进程、summary incarnation 和控制端点，不通过重启 Codex 来补能力；真实停止后重开才换代。监督进程并行停止子进程，并在等待退出前撤销本代 socket 与启动目录；runtime 接管从匹配端点的持久启动描述重建带 dev/ino 校验的 cleanup，确保监督进程来不及执行 finally、被强杀时仍可清理本代资源。未启用 PTY host 时沿用原有 runtime 与会话同寿的边界。

显式 `--remote`、`--no-daemon`、`-p/--profile`、不支持 Unix 控制面的原生版本及 Windows 保持原生启动选择；没有本代控制端点时自动回退资格保持未验证，普通 RVF 仍可使用候选快照继续。Codex 0.163.0 的 app-server 拒绝 `--profile`，`-c profile=…` 也会触发已退休的旧版配置错误；把 profile 文件转成普通 `-c` 则会改变它与项目配置的优先级。因此 profile 启动保留完整原生 argv 与原配置目录，不登记控制端点、不声称具备实时分支证明；真实隔离 TUI 测试验证了 profile 中 provider、model 与指令的消费。存量安装会话不会因升级被自动打断，它们须在合适的真实重启后获得新能力；只看到默认 daemon 中有同名 thread 不足以给旧 TUI 授权。

验证入口包括 `codex-remote-conversation-real-cli.integration.test.ts`（真实 Codex + 回环模型的恢复对话、工具执行、只读 fork 拒写及 Hook 身份）、`codex-native-session-control-host-lifecycle.integration.test.ts`（进程/环境隔离与失败清理）、`codex-native-control-host-packaged-runtime-adoption.integration.test.ts`（真实打包 API/PTY host 接管）、原生 rewind 夹具的受控自动与原样命名空间手动模式。实际 e9e12 活动分支 consumer 在隔离传输中先生成自己的 nonce，再驱动当前原生宿主实时查询，分别验证当前分界可接受与回退后拒绝；没有把旧观测改写 nonce 来凑兼容。

## 完成通知

成功 finalize 后，RVF 写 `$RVF_HOME/automatic-closeout-completion-notifications/<token>.json`。通知同时绑定 run、原会话、worktree、handoff SHA256。宿主复核激活时绑定的 run、finalization 和 handoff；不使用 latest run、不枚举旧 handoff。因此升级不会追溯执行历史审查。

## 持久编排

确认预算耗尽后才取得精确原生接受证据时，可使用[迟到接受补证 runbook](runbooks/rvf-late-native-closeout-prompt-acceptance-recovery.md)中的显式命令。它保留原失败账本，追加恢复凭据；普通 confirmed/completed 不走此入口。正确绑定的 paused 记录亦可如实登记 blocked/failed，完成结果继续经过真实提交、evidence 与祖先门禁。本入口不改变首次确认预算或压缩阶段的等待策略。

每个 workspace 保存 `rvf-automatic-rewind-and-closeout-records.json`，通过现有跨进程文件锁和原子写入更新：

1. `captured_review_start_boundary`：持久保存开审前分界，尚未激活；runtime 和独立 coordinator 均跳过。
2. `awaiting_rvf_completion`：真实 run 双向绑定已核验，等待本次 token 的完成事实。
3. `restoring_pre_review_conversation`：按 `thread/fork.lastTurnId` 创建原生前缀分支，落盘并复验身份与历史。
4. `restored_pre_review_conversation`：停止原终端、持久切换原生身份，并按明确 ID 续跑。
5. `submitting_closeout_prompt`：用固定幂等键交给现有持久队列，等待提交确认。
6. `closeout_prompt_submitted`：终端确认提交 Prompt；不代表 land 或 base 同步已完成，实际动作由 skill 执行并汇报。
7. `paused`：门禁原因留在记录和终端 warning 中；不会偷偷生成新 key 绕过失败。
8. `completed`：服务端已分别确认 land 和本地 base 同步的真实执行结果；投递状态本身不能进入此阶段。

自动收尾默认在 land 后继续 base 同步。任务仅部分完成本身不是暂缓理由，自洽且通过当前范围验证的阶段成果通常仍应整合。Agent 判断存在未闭合依赖或实际整合风险时，可以报告 `stage=base_branch_sync`、`outcome=blocked`、`blockedReasonKind=agent_assessed_not_ready_for_base_sync`，同时提供具体 `reason` 与 `baseBranchSyncReassessmentCondition`。已确认的 land 继续保留，整体不标成 completed；该分类不属于机器前置条件恢复，不反复自动催办。后续重新评估并实际完成同步时，可追加成功报告，旧暂缓历史不被抹除。

原生 fork 发出前也记录尝试。若崩溃时连新分支身份都无法确认，暂停，避免盲目再建分支。已确认身份的恢复会复验并复用它。持久投递沿用既有账本：明确失败或跨重启未确认不能视为送达，也不自动重排。

同一条记录的恢复与入队通过独立跨进程操作锁互斥；取锁后重读记录，并用持久认领 ID 校验每次推进。锁失效或其他运行时接管后，旧持有者不能覆盖恢复身份和用户暂停状态。原生身份切换与入队前也复核认领。

恢复前后核对 HEAD、已暂存/未暂存补丁和未跟踪文件。人工插话、用户已排队指令、待答问题、输入框占用、park、当前主会话改变或明确停止均会让位或暂停。主会话通过 `task-main-conversation-session-binding` 的 canonical 绑定解析，交接和自动恢复共用卡片级串行入口；保留交接后主会话自己的启动权限和模型配置。外层 Kanban 会话绑定保持不变，仅切换其 Codex 原生身份。

Codex 尚未建模输入框读屏语法，其读屏结果恒为 null。自动恢复与既有程序化投递一样使用输入侧字节账本保护未提交草稿，不能把结构性缺少读屏当成永远等待的条件；恢复前和切换身份前都重查输入。具有真实草稿的会话继续等待，不会清框或覆盖输入。

开审后的 RVF 续跑消息按已确认提交的投递账本识别：接受宿主 Task 或当前主会话寻址，兼容生产方的 `review-validate-fix` source。其他任务、人工来源、失败或未确认投递的同文消息不能据此放行。用户明确停止时，宿主持久暂停记录并取消固定幂等键的排队投递；晚于停止入队的条目补撤，终端受理和实际写入前还会复核暂停。已确认提交的事实继续保留。

查询入口：

```bash
kanban task rvf-automatic-closeout-status --task-id <id> --project-path <main checkout>
```

## 交付与验证边界

历史恢复先核验既有实际完成与备用消费。旧未分类 blocked 和缺少接受证据只进入后台补证，不通过 `inspect_existing_state` 唤醒 Agent；可信完成事实统一阻止恢复、认领和迟到投递。状态、历史展示、持久重试与消息取消规则见[既有收尾目标对账](runbooks/rvf-existing-closeout-goal-completion-reconciliation.md)。

此能力需要 Kanban 与 RVF 生产方共同更新；仅部署一个仓库不能形成闭环。RVF 侧接口依据其独立消息契约与实际 verifier；两侧需分别部署。独立开审 gate（e9e12）和已完成 run marker 清理（f03b5）的现有职责不迁入宿主。

部署前验证覆盖精确前缀、原历史与文件/暂存保留、真实 Codex app-server、持久队列、重入与人工介入。部署后自动验收读取真实运行实例新产生的绑定记录和投递账本；没有新样本时报告尚未观察到，不以旧 run 充数。

本卡的自动化入口：`test/runtime/rvf-automatic-closeout/` 验证来源、候选身份、checkpoint 与两阶段生命周期；`KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY=<consumer checkout>` 可让捕获套件直接调用实际 RVF Python verifier。`KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY=<codex binary>` 启用 `codex-native-review-start-boundary-and-rewind.integration.test.ts`，其本地模拟模型、隔离 HOME、真实 TUI 与 Git fixture 不接触生产 token；`KANBAN_CODEX_RVF_NATIVE_BOUNDARY_EVIDENCE_DIRECTORY` 可指定持久日志目录。
