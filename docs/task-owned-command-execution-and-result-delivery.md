# 所属命令执行与一次结果交回

`kanban task command-execution start|inspect|cancel` 是通用命令托管能力。业务工具冻结自己的工作材料、恢复/取消 argv 与结果路径，Kanban 负责所属执行、park、跨重启接管、取消及统一 transport 投递。RVF 的评审、修复、验证和提交资格由 RVF 决定。

启动示例：`kanban task command-execution start --task-id <ID> --project-path <主仓库路径> --idempotency-key <稳定工作键> --spec-file <持久 JSON>`。查询和取消都必须指定原 task ID 与精确 `--execution-id`。同 key、同材料与同 incarnation 复用；材料或原主会话不同报冲突。

启动 specification 包含 `command`、`resumeCommand`、可选 `cancelCommand`、`workingDirectory`、`resultFile`、`materialSha256`、`label` 与可选 `recoveryEvidencePaths`。命令为 argv 数组，不经 shell 拼装。工作目录必须是该任务的真实工作树；持久记录保存目录实体、task incarnation、原主会话与原生身份、材料摘要、监督进程 nonce、恢复动作及结果 ID。

业务工具的结果文件发布 `disposition`：`agent_review_ready` 或 `agent_judgment_required` 才形成一次逻辑结果；`machine_evidence_pending` 只更新进度与 `recovery`，`cancelled` 撤销执行。退出码 0 只证明本地进程退出，不能推导业务完成。恢复结构保留 missing evidence、等价来源、证据路径、触发条件、已登记动作与重试上限；未变化证据不会无限派发。

结果正文和稳定 ID 先持久化，再登记统一 managed delivery 与原生发送意图。执行记录区分 `known_not_submitted`、`submission_unknown` 与 `native_accepted`。写入可能发生前先保存未知标记；重启优先读取持久回执与原生历史，只有证明未提交才允许同 ID 重试。逻辑结果和实际投递尝试分别计数。旧托管者或旧 attempt 的迟到回执不能结算当前尝试；普通人工队列的重启确认规则保持原有语义。

park sidecar 的 `owningCommandExecutionIds` 记录归属，不修改 facet 伪装空闲。结果只能移除本执行的等待；其他等待、模态审批和主会话交接仍然阻止投递。发送复用 `sendTaskChatMessageAcrossSessionTransports`、`validateBeforeTerminalWrite` 和原生受理证据；所属结果关闭自动暂存草稿，等待可写状态或通过原生通道保留 composer。

冻结可交回结果后先移除本执行的计算等待，避免同会话多个执行互相卡住；投递等待或失败时保留本执行的等待，原生确认后才完成交回。ACP 回执超时仍是提交未知；连接缺失或忙碌只有在 prompt 注册前提供明确事实，并绑定原生会话、稳定结果 ID 和精确尝试 ID，才允许有界重投。旧尝试的未派发证据不能授权新尝试重投。机器等待执行 `resume_same_run` 时读取 `maximum_unchanged_retries`，没有截止时间也会退避后复核，普通进度时间戳不重置恢复预算。

用户 Stop、取消回合、终端 Ctrl+C/生成中的 Escape 及删卡的停止链路先持久撤销，再取消所属 controller、CLI 和验证后代。独立监督进程持续核对撤销，并保存已观察的后代启动身份；核验身份后才发信号，不杀共享服务。持久撤销跨 runtime/机器重启保持有效。本地退出、取消请求与原生取消接受分别展示；原生缺证保持 unknown，并进行有界复核。

监督进程与运行材料位于 workspace 的持久 `task-command-executions/<executionId>/`。runtime 重启按进程启动身份接管存活执行；机器重启在确认旧进程退出后按保存 argv 恢复同一工作。原主会话复用现有持久恢复入口，不重投初始 prompt；原生身份变化时只暂停结果投递，继续保存机器进度。

业务工具可登记 `resumeCommandPreservesBusinessSingleFlight: true`，声明恢复命令会在同一业务 run 的持久锁下接续。RVF 适配层按实际 controller/workflow/role 单飞锁登记这一能力；Kanban 在监督进程缺证时最多追加一次已登记的恢复命令，不重跑初始命令，也不把未知进程写成已退出。缺证、等价来源、恢复条件及计数保存在 `unprovenSupervisorRecoveryObservation`。未声明时继续等待进程、原生结果或开机身份证据；用户 Stop 始终优先，取消覆盖 `previousLaunchNonces` 和当前启动的全部已登记进程。
