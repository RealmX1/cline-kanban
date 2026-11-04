# 本地部署执行记录、恢复与独立复盘

状态：已批准实施的部署侧合同。用户在本任务分析方案后明确要求 `Implement the plan.`。本任务不执行真实部署，不更改 RVF，不实现跨工作流的 GitHub 投递器。

## 能力与边界

同一部署拥有一份持久执行身份、冻结命令和阶段原件。发布、重启、运行核验、登记是部署主结果；暂存目录清理、任务评论和复盘材料分别记录。附属步骤失败不把已经登记的部署改写为失败。

实现复用 `task command-execution` 的所属执行、监督进程、机器恢复、Stop 与结果交回，不新建部署专属调度器。运行时负责通用归属；独立部署执行器只理解本次冻结的部署步骤。恢复保留历史接受事实，另核对当前状态与下一动作资格。

部署授权仍以 `.codex/skills/cline-kanban-local-deploy/SKILL.md` 为准。初始化和准备所属命令不启动部署；不得在部署确认前调用 `task command-execution start`。用户的 Stop、不得部署等限制继续优先。

## 冻结材料

候选构建新增 `local-deployment-execution.js`。在持久目录保存 `manifest.json`，字段由 `local-deployment-execution-contract.ts` 校验：

- `executionId`：本次执行的 UUID；相同 commit 的另一次部署使用新的 UUID。
- `workspaceId`、`taskId`、`originatingTaskWorktreePath`：来源任务；它与用于构建的 `sourceCheckoutPath` 可以不同。
- `deploymentNodeBinaryPath`：实际服务所用 Node 的绝对路径；安装、构建、执行和 ABI 预检使用同一个 Node。
- `candidateSourceCommit`、`previousDeployedSourceCommit`：完整 SHA，首次缺少前驱使用 `null`。
- `candidateDistributionDirectoryPath`、`candidateDistributionSha256`：隔离候选及其完整文件清单摘要；SHA 不替代实际产物身份。
- `distributionDirectoryPath`：本次已授权发布的目标目录。
- `runtimeIdentity`：`runtimeHomeDirectoryPath`、`runtimeHost`、`runtimePort`；`runtimeBefore` 保存监听 PID 与 OS 启动身份。
- `authorization`：本次用户原话与可核查的来源参考。Agent 自己写出的描述不产生新授权。
- `stages`：按顺序声明 `candidate_preparation`、`state_preservation`、`build_publication`、`runtime_restart`、`runtime_validation`、`deployment_record`、`staging_cleanup`、`task_comment`。

每个阶段的 `command` 都是 JSON argv 数组，不通过 shell 解释。发布、重启、登记必须声明 `effectVerificationCommand`。恢复所需依赖、认证或环境证据可通过 `recoveryEvidenceFilePaths` 声明；只记录摘要，不复制凭据内容。

绑定候选目录必须保留，不能直接作为移动式 promote 或收尾清理的来源。把候选复制到独立暂存副本后再发布；原候选用于核对与冻结执行器，暂存副本才可删除。

候选构建仍按现有 skill 完成；`candidate_preparation` 中记录发布前最终类型、ABI 与候选检查，`state_preservation` 刷新备份与逐会话门禁。没有新行为的步骤可调用现有只读核验脚本，不为填满阶段写空命令。`runtime_validation` 必须实际检查通知档案、agent 检测、工作树与任务映射；不能只查首页。

## 标准调用

下列 `DEPLOYMENT_NODE`、`CANDIDATE_EXECUTOR`、`EXECUTION_DIRECTORY` 均指本次已核实的绝对路径，不是 `latest` 指针。

```sh
"$DEPLOYMENT_NODE" "$CANDIDATE_EXECUTOR" fingerprint-distribution \
  --distribution-directory "$CANDIDATE_DISTRIBUTION_DIRECTORY"

"$DEPLOYMENT_NODE" "$CANDIDATE_EXECUTOR" initialize \
  --execution-directory "$EXECUTION_DIRECTORY" --manifest-file "$EXECUTION_MANIFEST_FILE"

"$DEPLOYMENT_NODE" "$CANDIDATE_EXECUTOR" prepare-owned-command \
  --execution-directory "$EXECUTION_DIRECTORY"
```

准备动作把已绑定候选中的执行器复制到 `frozen-local-deployment-executor.mjs`，保存代码摘要。缺件可由同一候选摘要恢复，不用后来安装的版本替换旧执行器。随后使用准备回执的 `taskId`、`idempotencyKey`、`specificationFile`，经现有入口登记一次：

```sh
kanban task command-execution start --task-id "$DEPLOYMENT_TASK_ID" \
  --idempotency-key "$DEPLOYMENT_EXECUTION_IDEMPOTENCY_KEY" \
  --spec-file "$OWNED_COMMAND_SPECIFICATION_FILE" --project-path "$PROJECT_MAIN_CHECKOUT_PATH"
```

此步骤需要已有本次真实部署授权。所属执行自动 park、持有独立监督进程，重启后按归属接续，并把一次结果交回原会话。不要另起 launchd、定时脚本或手写后台恢复循环。

## 阶段恢复

- 执行意图先于命令落盘。原始 stdout、stderr 和进程退出事实放在独立尝试目录；原子写使用文件与目录同步。
- 同一 runtime home 与端口的发布串行；同一执行目录另有单飞锁。已完成阶段不再次执行。
- 普通命令在同一补证摘要下最多执行两次；证据文件真实变化后取得新预算。不可重复动作结果未知时先核验效果，不重发动作。
- 子进程原生记录确证未创建进程时，单列 `command_not_started`，可按有界预算恢复；启动意图本身不证明命令已执行。
- 恢复只接受规范尝试目录中、命令与 cwd 相同的未启动原件；新版原件另绑定执行、阶段和尝试编号。每次重试和意图持久化后再次检查 Stop 与锁归属。
- 效果核验必须返回 `ok: true`，并同时匹配 `executionId`、`candidateSourceCommit`、`candidateDistributionSha256`。HTTP 200 或退出码 0 单独不足以放行。
- `verify-publication` 核对候选完整清单与发布文件，允许目标原有的非构建文件继续存在；不跟随产物内部软链接。
- `verify-runtime-restart` 复用候选的现有只读 readiness 脚本，核对目标 runtime home、端口、新进程身份与发布内容。该检查不等于自然输入输出连续性通过。
- `verify-deployment-record` 只读核对原建组事实与标记；`recover-deployment-record` 通过已有 `deployment record --execution-directory` 补证登记，不重启。
- 登记的 `executionId` 同时作为该次 PDV 的 `deploymentId`。前驱在 state 锁内再次核对；重试优先返回 `deployment-record-receipt.json`。较早执行不回退后来部署的标记。
- 如果建组已接受而原 CLI 统计回执丢失，只恢复原组能证明的事实，原统计明确为未知，不把当前可变清单当历史快照。
- 明确取消经通用所属执行撤销；本地 restriction 另区分 `permission_revoked` 与 `human_decision_required`。它们没有自动重验时间，不被机器恢复当作临时网络故障。

机器待证通过 `owned-command-business-result.json` 的 `machine_evidence_pending`、`resume_same_run`、重试时刻与证据路径交给既有通用恢复。进程退出或 runtime 重启不清空尝试预算。只暂停依赖缺口的阶段，仍可执行独立清理；没有新证据不重复唤醒 Agent。

所属规格的可选 `readOnlyRecoveryEvidenceObservationCommand` 是无 shell 的只读 argv，仍由通用恢复循环单飞采样，不另设调度器。观察命令在 15 秒内返回 `{ "evidenceSha256": "<64 位小写 SHA-256>" }`；失败、超时或坏输出归为同一稳定未知态。部署侧只摘要当前进程身份、绑定效果状态与未决命令原件，不把采样时间或 nonce 当作新证据。无变化预算耗尽后仍每 30 秒只读补证，只有真实语义变化才重新派发冻结执行器；Stop 中止在途采样并禁止后续观察。

需要由生产方完整解释恢复输入时，显式选择 `recoveryEvidenceObservationMode: "semantic_observation_only"`，排除诊断文件重写对指纹的影响。未知观察保留原有预算；已消费证据的预算跨重启、跨不同证据往返保存。当前重试上限每次决策重读，不沿用首次见到该证据时的快照。旧所属执行的追加登记契约见 [通用命令托管](task-owned-command-execution-and-result-delivery.md)。

## 自动复盘与反馈材料

每次结束或进入机器待证状态，自动生成绑定分析版本的 `retrospective-analysis-requests/<fingerprint>.json`。部署成功、失败、回滚和放弃都保留复盘路径。单次不可重复阶段异常、重复工作或跨次同阶段失败即可提示深入分析；无需先攒到数量阈值。

取消命令先独立持久化 restriction，再保存包含撤销原话来源的复盘请求。即使执行器仍持有阶段锁、随后被通用 Stop 终止，请求原件也已独立留下，不依赖 `run` 正常走到末尾。

主 Agent 收到所属执行结果后，自动读取该请求，轻量分析成功经验、重复工作、成本和风险，再用 `freeze-independent-findings --execution-directory … --findings-file …` 固化原件。即使没有问题，也写一份空 findings 的复盘结论。先完成此动作，再查询既有 Issues；看目录后新增的核验另记来源，不能伪称先验独立发现。

发现分别记录性质、问题对象、主要修复仓库、证据状态、采用状态，以及相对于来源 Task 的范围关系。独立支持不等于采纳；同一原件的转述、重试或多路径引用不增加独立支持次数。

共用反馈系统的既定策略是自动追加新证据、必要时新建 Issue。本阶段只保存其可消费的独立发现与待投递原件，不依赖 RVF CLI，不实现另一套 GitHub 客户端。共享消费者暂不可用时保留机器可恢复状态，不阻断部署、不让用户承担机器补证工作。

## 只读分析与旧材料

```sh
kanban deployment analyze --execution-directory "$EXECUTION_DIRECTORY"
```

也可用独立执行器的 `analyze`，不需要在线 runtime。传入多个目录可比较重复阶段失败；同一执行身份只计一次。部分目录缺失不妨碍分析其他目录，覆盖范围明确显示为 partial。

旧材料适配仅识别明确的原始部署回执、执行状态与恢复记录；只跟随本次材料显式绑定且位于目录内的指针，不搜索 `latest`。登记成功与附属失败分别呈现。原始命令次数、真实停机时长、模型 usage 缺失时保持 `null`；不能由总会话时间推算。旧记录不触发部署或写入新的成功事实。

## 验收

部署前测试覆盖评论失败、结果未知、错误身份拒绝、补证变化恢复、Stop、登记幂等、历史标记保留及真实子进程退出后接续。构建和浏览器可视化在隔离输出中验证；真实实例上的 CLI 可用性与所属执行交回由部署后验证继续观察。部署登记不等于自然会话连续性已通过。
