# 所属命令执行与一次结果交回

独立 supervisor 先启动、runtime 后恢复时，可经 `task command-execution adopt-existing-supervisor --adoption-file <持久JSON> --project-path <主仓库>` 接回。请求绑定原 task incarnation、conversation/native/runtime-session 身份、工作树实体、精确 executionId/launchNonce、完整规格与启动材料摘要。原生状态必须已证 running 或 exited；未知、材料变化及持久 Stop 均不放行。接回只登记与恢复观察，不调用 launch。

生产方在同一通用执行 artifact 目录写 `pending-existing-supervisor-adoption.json`，既有恢复循环每三十秒发现一次；取消覆盖尚未接回的材料。离线不直接写所属执行索引。没有可信原会话时，生产方仅保留原调用者结果，不生成任务会话归属。部署侧用法见 [标准重部署](local-redeployment-standard-entry-and-offline-recovery.md)。

`kanban task command-execution start|inspect|cancel` 是通用命令托管能力。业务工具冻结自己的工作材料、恢复/取消 argv 与结果路径，Kanban 负责所属执行、park、跨重启接管、取消及统一 transport 投递。RVF 的评审、修复、验证和提交资格由 RVF 决定。

启动示例：`kanban task command-execution start --task-id <ID> --project-path <主仓库路径> --idempotency-key <稳定工作键> --spec-file <持久 JSON>`。查询和取消都必须指定原 task ID 与精确 `--execution-id`。同 key、同材料与同 incarnation 复用；材料或原主会话不同报冲突。

启动 specification 包含 `command`、`resumeCommand`、可选 `cancelCommand`、`workingDirectory`、`resultFile`、`materialSha256`、`label` 与可选 `recoveryEvidencePaths`。命令为 argv 数组，不经 shell 拼装。工作目录必须是该任务的真实工作树；持久记录保存目录实体、task incarnation、原主会话与原生身份、材料摘要、监督进程 nonce、恢复动作及结果 ID。

可选 `postProcessExitCleanupCommand` 同样是冻结 argv，并参与材料身份。监督器确认原命令及所属子进程全部退出、原始 stdout/stderr 已同步后，持久保存绑定执行、nonce、材料与命令的退出确认，再复用同一原生监督实现运行清理。清理拥有独立原件和进程范围，不覆盖业务结果；通用恢复循环也可单独接续它，包括原执行已取消的情况。生产方负责删除资格、证据、引用、幂等及有界重试，通用监督器不解释部署阶段。未声明该字段的执行行为不变。

生产方可冻结 `readOnlyRecoveryEvidenceObservationCommand` 并选择 `recoveryEvidenceObservationMode: "semantic_observation_only"`。此模式只消费观察命令返回的 `evidenceSha256`，诊断文件全文散列不参与恢复资格；观察不可用时持久保存 unknown、原预算和下次轻量观察时间。按每份证据保存已用预算，进程重启或 A→B→A 均不重新领取 A 的机会。每次决策重读当前 `maximum_unchanged_retries`：上限下降会停掉尚未发生的恢复，上升只补剩余次数，已用次数不清零，同一证据仍最多三次。异步观察后仍检查撤销、任务/目录身份与托管归属。派发前重新核对观察器登记；已经读到旧记录的扫描发现登记变化后，不得再按诊断内容派发。

旧执行可用 `task command-execution register-recovery-evidence-observation --registration-file <持久JSON>` 追加观察器。JSON 包含 `taskId`、`executionId`、`expectedMaterialSha256`、`command` 和 `mode: "semantic_observation_only"`；材料摘要取原执行的 inspect 回执。登记保留原 specification、执行身份、撤销及预算，同一登记幂等，拒绝替换不同观察器或恢复已撤销执行。登记前已经消费的同一 `continuation_request_id`，首次语义观察只继承剩余次数，不重新发放。该入口不替换业务命令，也不授予新业务执行权限。

业务工具的结果文件发布 `disposition`：`agent_review_ready` 或 `agent_judgment_required` 才形成一次逻辑结果；`machine_evidence_pending` 只更新进度与 `recovery`，`cancelled` 撤销执行。退出码 0 只证明本地进程退出，不能推导业务完成。恢复结构保留 missing evidence、等价来源、证据路径、触发条件、已登记动作与重试上限；未变化证据不会无限派发。

结果正文和稳定 ID 先持久化，再登记统一 managed delivery 与原生发送意图。执行记录区分 `known_not_submitted`、`submission_unknown` 与 `native_accepted`。写入可能发生前先保存未知标记；重启优先读取持久回执与原生历史，只有证明未提交才允许同 ID 重试。逻辑结果和实际投递尝试分别计数。旧托管者或旧 attempt 的迟到回执不能结算当前尝试；普通人工队列的重启确认规则保持原有语义。

park sidecar 的 `owningCommandExecutionIds` 记录归属，不修改 facet 伪装空闲。执行记录核验后，其他所属执行的等待不再阻挡当前结果；每次只移除本执行的等待。普通或归属未知的后台等待、模态审批和主会话交接仍然阻止投递。发送复用 `sendTaskChatMessageAcrossSessionTransports`、`validateBeforeTerminalWrite` 和原生受理证据；所属结果关闭自动暂存草稿，等待可写状态或通过原生通道保留 composer。PTY 的接受记录、真实接受回执和 ACP 的接受回调同样保留其他执行的等待。

冻结可交回结果不预先清理计算等待；排队和写前登记均保留所属等待，统一 transport 取得真实接受回执后才解除自身等待并完成交回。没有执行 ID 的普通输入保留其他所属 owner；只剩无归属等待时沿用既有恢复语义。其他工作仍在等待时，主会话保持 In Progress／Running；全部接续结束后，既有主回合完成事件经 facet 链进入 Review。旧完成事件不能覆盖更新的输入或回合。

结果恢复的证据指纹包含原生投递证据、其他等待的归属与实际输入忙碌状态；排除自身 park 的时间戳、标签及 owner 数组顺序。重启和自身等待重建不补发预算，其他等待或可写证据变化后沿用原结果身份恢复。ACP 回执超时仍是提交未知；连接缺失或忙碌只有在 prompt 注册前提供明确事实，并绑定原生会话、稳定结果 ID 和精确尝试 ID，才允许有界重投。旧尝试的未派发证据不能授权新尝试重投。机器等待执行 `resume_same_run` 时读取 `maximum_unchanged_retries`，没有截止时间也会退避后复核，普通进度时间戳不重置恢复预算。

Codex 就绪等待超时后，原生账本须仍为 `registered`、发送次数为 0，且冻结正文、任务、工作树和原生会话全部匹配，才可沿原结果 ID 和客户端消息 ID 补送。每份可写证据最多补试一次，预算持久保存。重启可从原生账本补核超时，当前 Codex 提示符就绪变化可触发重验。Queue 标明写入前撤下的原因，凭匹配的 transport 回执或原生接受证据补核送达，同时保留原超时回执。

浏览器手动移入 Review 遇到非 JSON 网关响应或连接中断时，不自动重发移列动作。共享 tRPC 层保留 HTTP 状态，既有 nonce 拒绝仍可重新取得 nonce 并重试一次。Review 请求与状态回查各有 8 秒上限；回查绑定原 workspace/task/incarnation，最多三次，退避 400／1200 毫秒。读取到 Review 就采用权威快照，仍无法确认则明确显示“结果未知”并恢复操作入口。主看板、Focus View 与跨项目入口共用这条路径。

用户 Stop、取消回合、终端 Ctrl+C/生成中的 Escape 及删卡的停止链路先持久撤销，再取消所属 controller、CLI 和验证后代。独立监督进程持续核对撤销，并保存已观察的后代启动身份；核验身份后才发信号，不杀共享服务。持久撤销跨 runtime/机器重启保持有效。本地退出、取消请求与原生取消接受分别展示；原生缺证保持 unknown，并进行有界复核。

监督进程与运行材料位于 workspace 的持久 `task-command-executions/<executionId>/`。runtime 重启按进程启动身份接管存活执行；机器重启在确认旧进程退出后按保存 argv 恢复同一工作。原主会话复用现有持久恢复入口，不重投初始 prompt；原生身份变化时只暂停结果投递，继续保存机器进度。

业务工具可登记 `resumeCommandPreservesBusinessSingleFlight: true`，声明恢复命令会在同一业务 run 的持久锁下接续。RVF 适配层按实际 controller/workflow/role 单飞锁登记这一能力；Kanban 在监督进程缺证时最多追加一次已登记的恢复命令，不重跑初始命令，也不把未知进程写成已退出。缺证、等价来源、恢复条件及计数保存在 `unprovenSupervisorRecoveryObservation`。未声明时继续等待进程、原生结果或开机身份证据；用户 Stop 始终优先，取消覆盖 `previousLaunchNonces` 和当前启动的全部已登记进程。
