# Task 的 RVF 历史与当前覆盖查询

Agent 在需要确认本 Task 是否做过 RVF、寻找精确 handoff 或判断当前候选是否仍被覆盖时，使用：

```sh
kanban task rvf-history
kanban task rvf-history --task-id <id> --project-path <main-checkout> --limit 10
kanban task rvf-history --task-id <id> --project-path <main-checkout> --cursor <nextCursor>
```

默认身份来自 `KANBAN_TASK_ID` / `KANBAN_PROJECT_PATH`，不从 cwd 推测。默认每页十轮、最多五十轮；分页只限制显示，不限制完成摘要。API 为 workspace 作用域下的 `runtime.getTaskRvfHistory`，输入 `{taskId, limit?, cursor?}`。

## 结果含义

| 字段 | 判据 |
| --- | --- |
| `hasVerifiedCompletedRvf` | `true`：存在完整达标证据；`false`：完整发现且没有完整完成轮次；`null`：发现或鉴证不足。 |
| `mostRecentVerifiedCompletedRun` | 全部可发现历史中的最近完整完成轮次，不受当前页影响。 |
| `currentCandidateReviewCoverage.status` | `covered`：生产方核验当前候选通过；`not_covered`：明确内容或范围不匹配，或完整查询后没有完成轮次；`unknown`：证据、能力或稳定性不足。 |
| `recentRuns` | 精确 run/token/session、handoff 路径及摘要、历史完成结果、覆盖状态，以及独立的自动收尾、land、base 同步结果。 |
| `discoveryStatus` / `issues` | `partial` 不表示没有 RVF；每项包含稳定原因码与机器可检测的恢复条件。 |
| `querySource` | `runtime` 或 `durable_filesystem_fallback`。回落只读同源持久状态，不启动会话。 |

完整完成须通过 canonical reviewer、issue 处置、fix 终态和通过的验证记录核验。advisory、取消和失败单列；reviewer 进程 `completed`、handoff 文件存在或 finalize 本身均不足以证明完整达标。历史完成与当前覆盖独立：后续编辑不会抹去历史，历史完成也不代表当前新增改动已审。

服务端已核验并接受的 land＋base 同步完成记录，也是历史完成的等价依据（`kanban_server_accepted_closeout_record`）。它必须保留精确 run/handoff 摘要、真实提交与本地 base ref；当前生产方缺失或旧验证缓存被清理不会撤销该接受事实。当前覆盖仍需本次独立鉴证，不能由旧接受记录直接推定。

服务端通过正式 `rvf land supplemental-completion verify` 接受的历史 Land 补充证明，单列为 `kanban_server_verified_supplemental_land_completion`。它不要求 base 已整合，`completedAt` 记录本次补充验收时间；Land 结果保存具体证明摘要、核验绑定及“不证明提交前评审、不授予后续执行”的边界。补充证明不能作为当前 candidate evidence 或 base 同步执行凭据，当前覆盖保持独立鉴证，Stop 与执行资格不变。

查询不会触发恢复、finalize、验证执行、提交或同步；不会使用全局 latest。执行后续操作时仍使用查询返回的精确 run/handoff，并核对该操作自己的门禁。

每轮可选的 `existingCloseoutGoalCompletionReconciliation` 独立展示实际收尾完成或备用路线消费事实。原 `landExecutionResult` / `baseBranchSyncExecutionResult` 的拒绝和失败继续保留；这项观察不会把 `hasVerifiedCompletedRvf` 或当前覆盖改成通过。证据适配、恢复预算和投递抑制见[既有收尾目标对账](runbooks/rvf-existing-closeout-goal-completion-reconciliation.md)。

## 生产方与恢复

需要 RVF 同时提供 `rvf inspect storage-paths --json` 和 `rvf inspect run-review-evidence --project-path <main-checkout> --run-dir <run> [--run-dir <run>…] [--current-worktree <path>] --json`。响应 schema 分别为 `rvf-storage-paths/v1` 与 `rvf-run-review-evidence/v1`。生产方使用自己的存储根 resolver，Kanban 不固化个人路径、插件版本或 Python 路径。

默认鉴证程序为 RVF 部署安装到用户 home 的 `~/.rvf/bin/rvf`，与 `RVF_HOME` 独立；`RVF_HOME` 仅传给生产方解析数据根，不用于定位程序。可用 `KANBAN_RVF_INSPECTION_EXECUTABLE_PATH` 显式覆盖可执行文件路径；调用通过 `execFile` 直接传递 argv，不经过 shell。配套契约由 RVF Task fc040 与 Kanban Task fff95 共同维护。

查询总预算二十秒。并发工件变化会在生产方重读一次；当前候选在批量查询中变化则覆盖保持 unknown。缺失或不兼容不转成人工必答：恢复相关工件/能力后重新查询会重新核验，服务重启后从持久来源重建。完整发现失败时不会生成否定的完成结论。已确认的自动收尾历史仍独立保留，不以当前工具是否存在改写原记录。

inplace worktree 被多个 Task 共用时，仅有仓库路径不能证明归属；必须有 Task receipt 或 Kanban 绑定记录。普通 branch worktree 按注册工作区、Task 创建时间和审阅工件归属筛选；dispatcher 与 reviewer 子运行不重复计入。
