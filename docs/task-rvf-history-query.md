# Task 的旧 RVF 只读历史

`kanban task rvf-history` 与 workspace 范围的 `runtime.getTaskRvfHistory` 保留旧历史查询。默认身份来自 `KANBAN_TASK_ID` / `KANBAN_PROJECT_PATH`，不从 cwd 推断；显式传参用主仓库路径。每页默认十轮，最多五十轮，分页不限制完成摘要。

查询直接读取 Kanban 持久收尾记录，以及旧 run 的固定归属工件和 `summary.json`。不执行 `rvf inspect`，不发现或调用旧生产方，不创建 Agent、定时器、原生分支或收尾消息，不执行验证、提交、同步或历史修复。

| 字段 | 语义 |
| --- | --- |
| `hasVerifiedCompletedRvf` | 可信历史完成为 true；完整发现且明确没有已完成轮次为 false；发现或证据不足为 null。 |
| `mostRecentVerifiedCompletedRun` | 所有发现记录中的最近历史完成，不受显示分页限制。 |
| `currentCandidateReviewCoverage.status` | 始终 unknown。旧记录不能核验当前候选，当前评审由独立评审流程负责。 |
| `historicalCloseoutRecord` / `historicalRunSummary` | 原始持久事实的只读投影，保留接受、失败、投递尝试及未完成状态；不能作为新执行资格。 |
| `automaticCloseoutStatus` / `landExecutionResult` / `baseBranchSyncExecutionResult` | 历史状态及各阶段原有结果，不恢复旧执行。 |
| `discoveryStatus` / `issues` | partial 表示发现或工件缺损，不等于历史失败；单条缺损不遮蔽其余有效记录。 |
| `querySource` | runtime 或 durable_filesystem_fallback；离线回落读取相同工件。 |

服务端当时已接受的 Land＋base 完成及正式补充完成证明继续独立展示，不因当前工具已删除而降格。完成的 summary、handoff 文件或 finalize 单独存在，不足以新证明完整评审达标；原文在 historicalRunSummary 中保留，完成判断保持 unknown，不写成 failed。

旧 run 的 Task、会话、仓库路径、创建时间与工件归属仍须匹配。inplace 路径共用时不能仅凭路径认领其他任务。存储迁移优先核对冻结工件与 handoff 摘要；冲突、失效 cursor 或缺损保持真实错误/unknown，不覆盖原记录。

旧存储根按事件时代的环境约定读取：`CODEX_RVF_LOG_ROOT`、其次 `CODEX_RVF_STATE_DIR`，否则 `RVF_USER_LOCAL_DATA_ROOT/run-logs`（默认 `~/.rvf/user-local-data/run-logs`）。精确 Kanban 绑定路径独立保留。查询总预算二十秒；缺失工件恢复后可重新查询，不要求重新启动 RVF。

已识别的旧 RVF 自动消息仅供历史读取，不参加队列调度、截止定时器、重排、重试或重启对账。普通任务消息、后台等待、Stop、独立回合确认、人工 rewind、checkpoint 与原生 fork 继续使用通用基础设施。
