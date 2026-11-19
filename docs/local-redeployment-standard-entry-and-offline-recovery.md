# 构建前标准重部署与离线恢复

标准入口消费一次真实部署授权，从候选构建前开始托管。复用已有 producer、八阶段合同、通用 supervisor、恢复循环及一次结果交回。修改或批准实现方案不产生生产部署授权。

## 请求与启动

已安装的独立 `local-deployment-execution.js` 接受以下数据合同。身份、路径、实际服务 Node 与授权来源均取本次现场；每次新部署分配新 UUID，恢复复用原目录。

```json
{
  "schemaVersion": 1,
  "executionId": "本次新UUID",
  "workspaceId": "注册工作区身份",
  "taskId": "来源卡片身份",
  "originatingTaskWorktreePath": "/所属任务工作树",
  "sourceCheckoutPath": "/已有本地源码checkout",
  "candidateSourceCommit": "完整40位本地commit",
  "deploymentNodeBinaryPath": "/实际服务Node/bin/node",
  "distributionDirectoryPath": "/已授权目标/dist",
  "runtimeIdentity": {
    "runtimeHomeDirectoryPath": "/实际HOME/.cline/kanban",
    "runtimeHost": "127.0.0.1",
    "runtimePort": 3484
  },
  "serviceLaunch": {
    "command": ["/绑定的canonical服务runner绝对路径"],
    "tmuxSessionName": "已核对的服务session名称"
  },
  "authorization": {
    "sourceReference": "本次真实用户消息来源",
    "userRequestQuote": "本次真实部署授权原话"
  }
}
```

```sh
"$DEPLOYMENT_NODE" "$INSTALLED_DEPLOYMENT_EXECUTOR" prepare-redeployment \
  --execution-directory "$EXECUTION_DIRECTORY" --request-file "$REQUEST_FILE"
"$DEPLOYMENT_NODE" "$INSTALLED_DEPLOYMENT_EXECUTOR" start-redeployment \
  --execution-directory "$EXECUTION_DIRECTORY"
```

准备只冻结请求、工具摘要和统一命令规格。启动后在私有 checkout 固定 commit、独立安装根与 Web 依赖、复用源码验证证据、显式指定私有生产输出。每个实际命令保存意图、stdout、stderr 和退出事实。请求是数据文件，八阶段脚本与观察器由程序生成。

标准源码验证计划同时包含运行时与 Web 类型检查、各自测试以及源码 lint。复用按冻结命令及候选绑定的证据；缺项补跑，已确认的质量失败禁止继续发布。

## 质量失败后的部署分支修复

已授权 local deploy 默认覆盖范围内的兼容修复与必要本地提交。质量失败仍交回原 Agent：读取真实报告，在 `deployment-repair/<taskId>-<来源执行短ID>` 分支修复、审阅并提交，然后准备新的固定候选。新请求复制原冻结请求，仅更改 `executionId` 与 `candidateSourceCommit`；服务目标、启动入口、运行目录和原部署授权继续保留。

```sh
"$DEPLOYMENT_NODE" "$INSTALLED_DEPLOYMENT_EXECUTOR" prepare-redeployment \
  --execution-directory "$REPAIRED_EXECUTION_DIRECTORY" --request-file "$REPAIRED_REQUEST_FILE" \
  --repair-of-execution-directory "$FAILED_EXECUTION_DIRECTORY" \
  --deployment-branch "$DEPLOYMENT_REPAIR_BRANCH"
"$DEPLOYMENT_NODE" "$INSTALLED_DEPLOYMENT_EXECUTOR" start-redeployment \
  --execution-directory "$REPAIRED_EXECUTION_DIRECTORY"
```

入口核验真实质量失败报告、任务 incarnation、原工作树实体、当前所属会话和 Stop；会话正常重启不抹去历史授权，当前代际仍重新核验。分支必须属于本任务、指向所报完整 SHA，且提交是失败候选的后代并实际改变源码树。准备不会发布或启动部署。

源码验证已经通过、报告为 `passed` 或 `inspection_complete` 时，只有失败原目录里记录了后续阶段的 `LocalRedeploymentQualityFailure`，并且业务结果仍是 `quality_validation_failed`，才接受同一接续。它只解锁该阶段的共享预算，阶段检查会在新候选上重跑。`LocalRedeploymentIdentityMismatch` 保持人工判断，阶段状态是 `human_decision_required`，不进入修复接续，也不按机器缺证重试。

`deployment-repair-continuation.json` 关联新旧执行、根执行、分支、失败报告摘要和候选；根目录的 `deployment-repair-continuations/` 保存持久预算。同一原授权最多三次修复候选，重复准备不增加次数，新目录和新分支不重置预算。原失败和验证原件继续保留；新树重新消费既有验证工具，仅复用实际匹配的证据。不覆盖失败、不跳过检查，不把既有生产缺陷误写成验证通过。

旧 runtime 只因 strict schema 不认识 `postProcessExitCleanupCommand` 而明确拒绝在线登记时，入口保存拒绝回执及待补清理命令，仅省略该可选字段，以同一幂等键和完整 owner 重试一次。其它拒绝、网络超时或结果未知不降级，也不另起离线执行；原冻结规格保留。

## 归属与恢复

在线且有可信来源会话时经 `task command-execution` 登记。离线只调用通用独立 supervisor primitive，不伪造所属执行索引。通用恢复循环发现待接回请求，校验真实 task/session/worktree、材料摘要和原生进程后登记；存活执行与已完成结果均不重发命令。没有会话绑定的外部调用只提供持久结果。

重复启动同目录只接续原执行；已完成或取消不重跑。原生退出或真实 boot 变化后，外部调用者也可用相同入口在持久语义预算内恢复。机器等待使用原 `machine_evidence_pending` 合同与等价证据；相同证据预算跨重启保存，时间戳和 nonce 不算新证据。明确取消使用 `cancel-redeployment`；原 session 的持久 Stop 在启动、接回和后续动作前仍有效。

在线受理须原子核对准备时冻结的任务、主会话、native/runtime-session 代际与工作树实体。已登记执行的监督者确证退出且实例离线时，同一入口接续原登记身份。离线监督者在 worker 等待机器证据后继续观察，只在持久语义预算允许且原归属与 Stop 门禁仍通过时恢复派发；实例恢复后接回同一监督者。

在线登记超时后保留原 runtime 进程代际和 boot 意图。暂时不监听不等于原执行者已退出；身份不可读时等待补证。只有确证原进程退出或 boot 改变，并重新检查持久所属索引仍无受理，才允许转入独立执行。

v2 manifest 在候选完成后固定产物摘要。`runtimeStartingState` 区分 `verified_online` 与 `verified_offline`；离线 `runtimeBefore=null` 并引用原生无监听、连接拒绝与 boot 原件。HTTP 超时保留 unknown，不填虚拟 PID。此前的构建也已由同一所属执行托管。

`deployment record --execution-directory` 按冻结 manifest 的 `workspaceId` 定位已注册项目，私有 `sourceCheckoutPath` 仅用于候选与提交核验，不需另补 `--project-path`。显式项目参数仍须匹配冻结归属；未注册或不匹配时拒绝登记，不自动注册候选。普通登记和 `recover-deployment-record` 复用同一入口及原回执，不重复建组、发布或重启。不带执行目录的旧入口仍按显式项目或源码路径解析。

## 状态保全与效果核验

保全配置、SQLite online backup、一致性工作区快照、任务映射、Git binary/full-index 补丁以及真实 staged/unstaged/untracked 内容。Git 只读查询不取 optional locks。逐项目缓存成功核验，快照指纹变化只使相关结果失效；API 超时或不可达时，使用 `loadPersistedWorkspaceStateById` 读取一致性持久快照。前后变化保存在 `state-preservation-comparison.json`，并行改动不自动归因于部署丢失。

运行目录备份排除执行目录本身和包含它的目录，避免将备份输出复制进源遍历。每项按内容指纹复用并核验副本；源内容变化时保留首份历史原件，另存当前版本。阶段恢复预算同时绑定当前阶段的语义机器证据，会话自然结束或 API 恢复可自动解锁，不靠修改冻结的源码验证报告。

活动目录备份按普通文件逐项核验、SQLite 在线快照保全，不承诺整个目录的全局同一时点快照。已核验文件随后更新不使整目录副本作废；复制期间普通文件不一致仍拒绝。回执保留源目录前后指纹与并发变化事实，发生变化的目录不作为当前源状态的可复用检查点。

备份 worker 报告读取、复制与 SQLite 页面进展。进展中断时，已绑定的父进程结束该 worker，保存原生退出原件。接续验证目标、阶段、命令与尝试身份，才允许按已完成检查点的内容领取恢复预算。接续可读取前一执行的检查点，当前的源和副本仍逐项重验。会话门禁解除后重新核对备份，由原发布与停止门禁再次核验现场。

`workspaces/<workspaceId>/task-command-executions/` 的持久执行原件按产物目录原地保留，并在备份回执中列明，避免监督进度和原子写临时文件使备份自阻塞；同级 `task-command-executions.json` 索引及其他工作区状态仍备份。

发布、重启和登记结果未知时先核验原生效果。v2 可显式声明 `idempotentEffectRecoveryCommand`，只补齐同一清单、同一启动或同一登记；v1 不获得该恢复资格。副作用动作之后立即重查效果，不沿用先前失败探测的冷却状态。发布同时验证 CLI 链接，重启验证进程启动时实际载入的入口摘要。

构建期间运行实例代际变化时，重新核对当前代际实际载入的产物；仍为旧产物的实例重新通过连续性门禁后交接，已经载入候选的实例只核验效果。重启效果核验成功前补齐绑定的接受快照，后续会话正常回收不覆盖此前已核实的历史接受原件。

锁协议改变时仍消费既有迁移 producer 的真实退休写入者清单与预检；放在本执行目录的 `filesystem-lock-protocol-retiring-writer-inventory.json` 绑定候选与 runtime home。缺件保存机器等待条件，不捏造 admission-closed，不强杀旧写入者。

离线启动由仍存活的执行者调用绑定 canonical runner，继续使用服务原有单实例锁。原 tmux pane 和日志保留，新建窗口；已有活启动 pane 时只等待，避免重复派发。runtime 不依赖自己已经停止的恢复循环启动自己。主机重启后由已有服务或再次调用恢复入口接续，不承诺没有任何执行宿主时凭空自启。

## 历史接受与 Agent 交回

原件保存到 runtime home 的 `hosted-session-runtime-adoption-acceptance-receipts/`，绑定接受事件、runtime 实例、实际入口摘要、session incarnation、native ID、host key 和进程创建时刻。部署再关联本次重启意图、候选及产物。后续正常回收不抹掉历史接受；当前状态、下一动作资格与自然 I/O 另行呈现。缺少自然活动时仍为 unknown。

普通阶段和机器等待不生成 Agent 结果。正常成功通过既有逻辑结果去重交回一次轻量终审；真实质量失败交回 Agent 修复。完整费用与真实停机时长没有原生遥测时保持未知。

## 兼容与验证

旧 v1 manifest 与冻结工具不迁移、不重放。实现不执行生产部署、源码同步或自动回滚。隔离回归覆盖五条代表轨迹、真实 supervisor 自动接回、标准打包入口的离线全程、重复启动、Stop、部分发布、错误绑定与后续正常回收；测试依赖 HOME/CODEX_HOME 隔离和 Git fixture。真实服务的 CLI、接管回执与最终原生交回仍由 PDV 观察。
