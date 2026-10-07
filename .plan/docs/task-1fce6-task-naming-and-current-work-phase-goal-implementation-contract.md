# Task 命名与当前阶段目标实现合同

状态：IMPLEMENTED_PENDING_REVIEW，用户批准范围已实现并完成部署前自动验证；尚未提交、未合回 main、未部署。

- Task 名称表达整个任务的稳定目标；创建前向 Sidebar 与任务 Agent 提供共享命名规则。
- CLI 创建保留 prompt 推导兜底，不新增模型请求。命名推荐 `[类型,可选领域]具体结果`，中文为主，最多三个 tag，正文建议 60 字、总长最多 80 字。
- 新增 `task rename-current-task --title --reason`，只按环境行动者解析当前 Task；runtime 原子修改名称并追加包含旧名、新名、原因、时间的 Comment；同名不写入。
- 自改名前核对持久初始需求、批准计划及范围变化。Compaction 后无法验证全任务范围则保持名称，只更新阶段目标。
- 新增会话字段 `agentCurrentWorkPhaseGoal` 与 set/clear 命令。阶段目标最多 160 字，显式声明优先；Claude 精确关联任务清单及 ACP structured plan 只有唯一 in_progress 时可提供原生回退。
- 卡片显示主会话阶段目标，辅助会话详情显示自己的目标。保持现有活动区两行。普通 Stop 与 compaction 保留；真实用户输入使旧值成为上次阶段目标；新原生会话不继承。
- Backlog 编辑器显示已有名称和 AI 建议；只提交修改过的名称。空名称由提交的描述推导，成功后异步建议通过服务端锁内旧名称及描述检查回填。
- 名称纳入既有草稿，旧草稿缺字段保留当前名称。compact 编辑按钮进入右上动作组，消除与 Start 的重叠；standard 保持原样。
- 不新增提案审批、阶段历史数据库、后台模型请求或 TUI 抓取；不维护 Cline 专属通道；不提交、不推送、不部署。

## 切片与验证

1. 当前任务改名、共享指导：runtime 身份准入、原子写入、同名幂等、CLI 无目标覆盖。
2. Backlog 名称：字段 patch、草稿恢复、保存失败保留、并发名称及延迟建议保护，compact 点击命中编辑器。
3. 阶段目标：会话所有权、显式优先、唯一原生条目、主/辅助隔离、真实输入失效、重启与 resume。
4. 运行 guarded targeted tests、根/UI typecheck、相关 lint/build、HOME 隔离 API/浏览器验证；收尾注册 Post-Deploy Verification。

## 开工协调记录

首次工作区 HEAD 为 `2645ad6c`，已严格单向吸收 local main `7113c5ba`；无 task 独有提交或 WIP。远端 matching fetch 得到 LOCAL_BASE_CONTAINS_REMOTE，未回写、未 push，bootstrap receipt 已验证，锁已释放。

同仓快照：291 tasks，KANBAN_CLI，无降级。40421、00677 仅有计划，无独有提交或 WIP；ba3cb 已不在 active board，但其遗留计划确认 Backlog 名称问题。92a53 为紧凑按钮遮挡 Backlog finding。

e2dfc 会话 live、等待 review 且有共享文件 WIP：CLI、append prompt、API contract/router、ACP/session manager。此碰撞已在批准计划中指定持久 queued prompt 协调；按用户 Implement 指令执行该协调，不重复询问。仅在本任务工作区增加独立入口，绝不吸收或改动 sibling worktree。消息当前 accepted_pending_submit_confirmation，不能宣称已送达。

LOCAL_BASE_DELTA_INSPECTED=VERIFIED
LOCAL_BASE_ABSORPTION=COMPLETED
SIBLING_TASK_SURVEY=VERIFIED
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
PLAN_REVISION=APPLIED
POST_ABSORPTION_PLAN_FRESHNESS=VERIFIED
ONE_WAY=VERIFIED
BASE_UNCHANGED_BY_TASK=VERIFIED
NO_HANDBACK=VERIFIED
NO_PUSH=VERIFIED
BOOTSTRAP_SEQUENCE=VERIFIED_SYNC_BEFORE_TARGET_REPOSITORY_VALIDATION
BOOTSTRAP_RECEIPT=VERIFIED

## 收尾证据

根 guarded 回归 16 文件 / 528 项、UI 回归 4 文件 / 84 项、草稿与字段 patch 的单独检查 2 文件 / 24 项均通过；真实 HOME 隔离 CLI/Chromium 检查通过（含两个 compact Pencil 宿主和 runtime 重启）。根/UI typecheck、39 个变更代码文件 biome、Node 24 build、diff check 均通过。收尾 local main 仍为 7113c5ba。

已按 cline-kanban-post-deploy-verification-authoring 注册 2 条真实 Agent 部署后引导验证，未运行或标通过。持久交接、测试日志、机器可读浏览器证据、部署后验证定义及补丁在：

`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-1fce6-task-naming-and-current-work-phase-goal/implementation-and-related-task-handoff.md`

40421/00677 已写 Comment 保留未覆盖范围；92a53 已写接管说明并作为重复跟踪移入 Done（column=trash），修复的最终 review/landing/deploy 归本任务；e2dfc 的协调消息仍为 accepted_pending_submit_confirmation。未改动 sibling worktree。
