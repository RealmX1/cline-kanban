# 自动复用源码验证证据

准备固定候选并完成既有 Node／依赖环境准备后执行本节工具。它自动发现、校验、选择证据并补跑计划中的缺项；正常路径不要求 Agent 阅读原始日志。它只准备源码质量证据，不构建、不发布、不重启，也不证明真实实例健康。

## 单一调用

使用实际部署 Node、固定完整 SHA、干净的候选 checkout 和本次部署的持久目录：

```sh
"$KANBAN_DEPLOY_NODE_BINARY" "$LOCAL_DEPLOY_SKILL_DIRECTORY/scripts/prepare-source-validation-with-evidence-reuse.mjs" \
  --source-checkout-path "$CANDIDATE_SOURCE_CHECKOUT" \
  --candidate-source-commit "$CANDIDATE_SOURCE_COMMIT" \
  --runtime-home-directory "$KANBAN_RUNTIME_HOME_DIRECTORY" \
  --output-directory "$DEPLOYMENT_EXECUTION_DIRECTORY/source-validation" \
  --validation-plan "$FROZEN_SOURCE_VALIDATION_PLAN"
```

计划沿用 `schemaVersion: 1`、`commands`、`name`、`argv`、可选 `coverage` 的现有形式。每项只填写本次确实需要的检查；`argv` 来自本次已批准计划，不从历史日志拿命令来执行。可为单项指定 `timeoutMs`（默认 15 分钟，最大一小时）。例如：

```json
{
  "schemaVersion": 1,
  "commands": [
    { "name": "运行时类型检查", "argv": ["/已选定的Node目录/npm", "run", "typecheck"] },
    { "name": "Web类型检查", "argv": ["/已选定的Node目录/npm", "run", "web:typecheck"] }
  ]
}
```

没有计划时不会擅自运行全量测试，也不会宣称验证完成。加 `--inspect-only` 可以只检查证据和缺口，不执行任何验证命令；其结果 `inspection_complete` 的 `ok` 为 false，不能用作部署阶段放行。

## 自动发现与判据

- 从同仓库 git-common-dir 的 `base-branch-sync/durable-operations`（含 linked worktree）读取标准验证记录；先按仓库和完整被测树筛选，再验证记录、实际命令指纹和 stdout/stderr 摘要。工具直接按生产方算法，以当前 Node preflight、当前 Python 和当前有效环境重算 `environmentFingerprintSha256`，不要求生产记录事后增加 `validationEnvironment`；不能重算匹配时只报告缺项并补验。
- 从 runtime home 的任务持久交接目录读取 `final-complete-tree-verification-evidence.json` 及落地回执。支持最终完整树证据包中已冻结 runner 的静态 npm 调用，不按阶段名称猜测覆盖，不执行 Python 包装脚本。原件清理时按 `validation-audit-copy-manifest.json` 自动读取同摘要副本。除当前内容摘要外，工具可重算旧采集器的 Python 清单算法；两种之一匹配才绑定当前候选，环境仍须由 `validationEnvironment` 独立证明。
- 直接读取 RVF `task-snapshot-reviews` 的原始验证：遵循 `RVF_USER_LOCAL_DATA_ROOT`，缺省使用 `~/.rvf/user-local-data`。核对 run 的仓库、原被测树、冻结执行计划、逐命令原生执行及退出记录和日志摘要，失败命令不因 `completed_commands` 小于计划数而丢弃。**base-branch-sync 采用了既有 RVF 结果、没有重跑，不是拒绝理由。** 不启动 RVF，不把当前树倒填为历史被测树。
- RVF 原件若只指向没有冻结摘要的仓库外包装脚本，不按其名字展开成新的检查；该记录保留，不能证明的缺项由本次计划补跑。旧格式或缺件也保留明确原因，不能把摘要“已通过”当证据。通过记录直接以原生 `runtime_environment` 的环境摘要、Python 和平台身份核对当前环境，不要求额外注入环境字段。
- 比较完整源码树及实际文件内容／权限；包含 WIP 或与固定提交不同的候选不消费旧结果。不能只看补丁相同、任务已进 main、merge commit 相同或时间接近。
- 按实际 argv 匹配覆盖，保留参数和显式环境条件；不因同名或同 coverage 就跳过不同命令。有明确完成时间的跨 operation／RVF 后续成功替代旧失败；无法确定先后时保守保留失败，未解除的同树同项失败阻止放行。
- 历史 RVF 若原生退出码为 127，且完整 stderr 明确是 shell 找不到 tsc／tsx／vitest／biome，保留原失败并分类为验证环境不可用；它不提供源码通过或质量失败结论，当前计划仍须复用有效证据或在准备好的环境实际补验。普通非零退出与其它 127 仍保留质量失败。

工具报告的是**历史源码检查覆盖**。Node 版本／ABI、有效环境、锁文件及已有依赖元数据参与复用或接续判断；不能据此声称本次依赖安装、原生模块或真实环境已经通过。生产构建、候选产物绑定、重启前 ABI 硬闸、会话连续性及重启后 API/数据核验继续执行。

## 接续与成本

`source-validation-evidence-reuse-report.json` 记录候选、命令级复用／补跑／待证结论、原件摘要、持久副本和读取统计；有效进程环境只保存摘要，不复制变量原值或凭据。stdout 仅输出计数与报告路径，通常无需加载完整报告。命中原件按摘要去重保存到本次目录，不依赖原 task 或 PDV 资产一直存在。

工具自动冻结本次代码，报告给出 `sourceValidationPreparationCommand`、`readOnlyRecoveryEvidenceObservationCommand` 和 `recoveryEvidenceFilePaths`。在本次冻结 manifest 的 `candidate_preparation` 中分别作为 `command`、同名只读观察命令和同名证据路径使用；无需 Agent 拼接命令或逐项核对密码学摘要。其他候选检查继续执行，已证明的类型检查不再强制重跑。

只读观察以 `--observe-recovery-evidence` 调用冻结工具，返回 `{ "evidenceSha256": "..." }`；不锁目录、不写报告、不补跑检查。它检查实际旧子进程、候选、依赖和验证原件的语义变化，接入现有部署执行器的观察指纹，不替换后续发布／重启／登记的效果核验。采样预算沿用现有执行器，不另建后台循环。执行和恢复均使用冻结副本，不依赖 task worktree 一直存在。

接续记录绑定候选、有效环境摘要、锁文件、安装元数据、实际 executable／包装脚本内容和冻结计划。每项由携带唯一启动标识的独立监督进程记录原生进程组、实际子进程 PID 与退出状态；实际检查继承监督进程组。控制器中断后先核对监督记录、启动标识和进程组，旧监督或组内检查仍存活时不重复执行；即使子 PID 尚未落盘，确认进程组为空后也无需系统重启即可在同一输入预算内有界接续。没有进程组证明的旧格式保留原有系统启动边界恢复。成功项再次调用不执行；同项互斥不因环境或候选变化而解除。同一输入下最多两次启动，真实质量失败及其持久副本保留且阻止放行。输入变化后重新判断，历史尝试不删除；时间戳和 nonce 不参与恢复指纹。Stop 和超时覆盖整个原生进程组，且不启动后续检查。

`quality_validation_failed` 交回 Agent 修复或处置，部署执行器不把它当作缺证，也不自动重跑本项。原件暂缺、命令未启动或旧子进程尚未退出则保留 `machine_evidence_pending`，由既有机器恢复接续；两者都不产生新部署权限。

发现只遍历已知目录层级，不扫描转录、源码快照或全部日志；先筛选元数据，仅对命中记录及其必需原件求摘要，同一文件每次调用最多计算一次。目录／摘要预算不足时保留缺口，不截断正文后冒充通过。
