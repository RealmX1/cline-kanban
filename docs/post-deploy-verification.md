# Post-Deploy Verification（部署后验证）

部署后，在真实运行实例上核对「只有部署后才验得到」的断言（真实 UI 交互、跨重启持久化、server ↔ web 实时链路、CLI ↔ live server、dist 构建差异等）。断言由 agent 在任务收尾时用 skill `cline-kanban-post-deploy-verification-authoring` 注册。部署由 skill `cline-kanban-local-deploy` 的 `kanban deployment record` 记录。

与端到端测试的区别：PDV 是**一次性验收**，在自然使用中逐步完成，严谨性不如 E2E，也不是每次都重跑的回归测试。

目前只有 cline-kanban 本身会记录部署，所以下文的机制实际只作用于 cline-kanban。机制本身按 workspace 设计，判据键始终是 `(workspaceId, taskId)`。

## 数据与文件（都在 `~/.cline/kanban/`）

| 文件 | 内容 |
|---|---|
| `last-deployed-source-commit.json` | 部署标记（全局单文件；多个项目都记录部署时会互相覆盖基线，现状如此） |
| `post-deploy-verification-state.json` | 部署组：活跃组 + 最多 20 个已折叠的历史组 |
| `authored-verification-definitions.json` | agent 注册的验证定义（部署前注册，建组和对账时合并进组） |
| `verifications/<verificationId>/` | 自动脚本与 fixture 资产 |
| `post-deploy-verification-deferred-natural-usage-observation-records.json` | 待在自然使用中观察的记录（见下） |

契约在 `src/core/api-contract.ts` 的 Deployment / Post-Deploy Verification 一节。移入 Done 结案的请求侧契约在 `src/core/post-deploy-verification-done-entry-closure-contract.ts`，由 api-contract 统一转出。

**持久化约束**：任务条目的新字段一律是可选字段，已有枚举不加新值。回滚到旧 binary 时，旧版解析新文件只会丢掉新字段，不会把整个文件判成损坏而隔离。结案原因的权威记录在只追加的关系账本里，待观察记录在独立文件里，都不怕状态文件被旧版改写。

## 按部署归属分三区

`src/deployment/task-deployment-attribution-from-commit-integration-provenance.ts`

每个任务的提交来历（`task-commit-integration-provenance.json`，含 sha 和 stable patch-id，worktree 删除后仍保留）与部署区间 `previousDeployedSourceCommit..deployedSourceCommit` 做一对一匹配：先 exact SHA，再 patch-id。匹配器与 dd2db 共享落地判据是同一个。

| 区 | 判据 | 面板 |
|---|---|---|
| `task_commits_included_in_this_deployment_delta` | 提交命中本次部署区间 | 置顶展开 |
| `task_commits_deployed_only_in_earlier_deployments_awaiting_verification` | 命中更早的保留部署区间，或提交是已部署 commit 的祖先（早于保留记录） | 折叠，可批量带原因结案 |
| `task_commits_not_yet_deployed_or_task_unattributable` | 提交还没进已部署 commit，或没有来历可依（原因见 `taskDeploymentUnattributableReason`） | 折叠，可批量带原因结案 |

提交来历功能上线前的老任务没有来历记录，会落在第三区，原因为 `no_task_commit_integration_provenance_entry`。

**纳入规则**（`kanban deployment record`，`src/commands/deployment-record-with-task-deployment-attribution.ts`）：

- Validation 列的卡；
- 上一活跃组里仍在等核对、且仍在看板上（不在 Done / backlog）的任务。这些任务连同勾选进度、脚本结果一起延续进新组，旧组里的副本标 `carriedForwardIntoDeploymentId`；
- 其他列里提交命中本次区间的任务：review / in_progress 纳入核对，Done 只作「本次部署还包含」的只读展示。

**runtime 对账**（每次面板轮询，`reconcileGroup`）：

- 补算归属：尚未计算的，以及第三区里每 10 分钟重算一次的；
- 合并晚于建组注册的 authored 定义（每轮只读一次定义文件）；
- 同一 verificationId 重注册（reconcile 模式）时刷新已有项的定义；旧勾选与脚本结果只在仍能证明新定义时保留：kind 变了、自动项的 `script` 变了、引导项的 `steps` / `expectedObservation` 变了，都清回未核对（record 延续进新组时同一规则）；
- 有 authored 项后去掉未勾的通用兜底项「在已部署 build 上手工验证」。该兜底项也可以手动删除，但不能删掉最后一项。

## 结案：通过 vs 带原因结案

`src/deployment/post-deploy-verification-closure-application.ts` 是结案的唯一写法。

- **全部勾选**：结局 `all_checklist_items_checked`，写 `verifiedAt`，账本事件 `post_deploy_verification_passed_observed`（「PDV 通过」）。
- **有未勾项**：每个未勾项都必须带原因，结局 `closed_into_done_with_unchecked_items_reasoned`，**不写 `verifiedAt`**，账本事件为 `post_deploy_verification_closed_into_done_with_unchecked_items_reasoned_observed`。它不是「通过」，门条件 4 不认它。

原因码（`runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema`）：

| 原因码 | 含义 |
|---|---|
| `manual_reproduction_cost_exceeds_verification_value` | 手工复现过于繁琐，成本与收益不相称 |
| `trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation` | 触发时机随机或罕见，转为在自然使用中观察 |
| `assertion_already_covered_by_other_verification_evidence` | 已由其他途径覆盖 |
| `assertion_obsolete_because_verified_behavior_changed_or_removed` | 断言已过时 |
| `custom_reason_described_in_reason_text` | 自定义，必须填写原因文本 |

选「转为在自然使用中观察」时：

- 该项生成一条持久的待观察记录（`awaiting_natural_usage_observation`），带断言、guidance / anchor、失败特征、脚本快照和资产目录；
- 记录在状态锁外写入，结案里先记下了它的 id。写入失败只告警，之后每次面板轮询（`getPostDeployVerificationState`）都会按保留的部署组里的结案快照补写缺失的记录（按 id 幂等）。所以记录不做物理删除，终态用状态字段表达；
- 结案时**不清理**它的资产、不注销它的定义；
- 这些记录是将来 pipeline 的输入，设计见 `docs/post-deploy-verification-natural-usage-observation-pipeline-design.md`。

只读查看：`kanban deployment deferred-observations [--project-path <p>]`，或 tRPC `deployment.listDeferredNaturalUsageObservationRecords`。

## 门禁：所有进 Done 的入口统一拦截

`src/deployment/post-deploy-verification-done-entry-gate.ts`

**受门禁**：任务在该 workspace 的活跃部署组里，且仍在等核对，即未结案、未移除、不是只读展示、没被延续走。

**主路径**：`taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree`。看板按钮、拖拽、Focus View、详情底栏、PDV 面板、跨项目切换面板、`kanban task done`、`kanban deployment verification-*` 都走这条路，执行顺序如下：

1. **授权**：全勾，或请求的 `postDeployVerificationDoneEntryClosure` 覆盖全部未勾项，就放行并写下在途授权。否则抛 `PRECONDITION_FAILED`，message 以 `POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS:` 开头，客户端据此打开原因对话框。任务此刻带着 CLI 在途完成记录（`kanban deployment verification-*` 移列前写下）时，授权的完成路径记为 `kanban_cli_post_deploy_verification_completion_verb`、`--force` 标记取自该记录，由服务端推导，不靠客户端自报。
2. **移列**。失败则撤销授权。
3. **结案**：写结案记录、记账本、写待观察记录、清理资产。结案写盘失败不回滚移列，runtime 对账在 30 秒宽限后按在途授权补完。

**结案按当时的 checklist 重新核验**：授权写下后 checklist 仍可能被勾选、取消、增项或被脚本重跑改写。所以结案（含对账补完）在状态锁内重新判定：全勾就是通过；否则授权里的原因覆盖全部当前未勾项，就带原因结案；两样都不成立时不冒充通过，也不替用户编原因，按「未经结案进 Done」标 `moved_out_manually` 并告警。CLI 在途完成记录同样处理，否则卡已在 Done、记录永远清不掉。

**兜底**：整板保存（浏览器 `saveState`，包括没刷新的旧 bundle）不经过主路径。`src/state/workspace-board-save-state-post-deploy-verification-done-entry-guard-port.ts` 会把受门禁、这次新进 Done、又没有已核验在途授权的卡改回原列，并告警。已核验在途授权指未过期的门禁在途授权，或未过期的 CLI 在途完成记录。普通待确认 token 不算：清单未全勾、原因还没给时也会发它。这里只能改回原列，不能整板拒绝，否则之后的每次整板保存都会失败。

**例外**：

- 删除任务不算进入 Done，不拦（仍记 `task_deleted`）；
- 会话中断后自动流转进 Done 的路径会跳过受门禁的卡。

CLI 带原因的写法（`kanban task done` 与 `kanban deployment verification-complete / verification-confirm` 通用）：

```bash
kanban task done --task-id <id> --closure-reason-for-all-unchecked-items manual_reproduction_cost_exceeds_verification_value
kanban task done --task-id <id> --closure-reason-for-all-unchecked-items custom_reason_described_in_reason_text --closure-reason-text "…"
kanban task done --task-id <id> --closure-reasons-file reasons.json   # [{checklistItemId, uncheckedChecklistItemClosureReasonCode, uncheckedChecklistItemClosureReasonText?}]
```

`--force` 从来只跳过 token 握手，不跳过勾选。历史字段 `forcedCompletionWithoutAllVerificationsPassed` 名不副实，读取以 `confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag` 为准，缺失时回退历史字段。旧 schema 把历史字段定为必填，所以 CLI 在途完成记录和补记请求在过渡期两个字段同值双写。只写新字段的记录一旦留在状态文件里，回滚到旧 binary 时整个文件会解析失败、被隔离。

## 面板在 All projects 视图下

顶栏按钮的待核对数与浮动面板共用 App 里唯一一份读模型（`usePostDeployVerification`），它绑定哪个 workspace 由范围决定（`web-ui/src/components/post-deploy-verification/post-deploy-verification-workspace-and-panel-task-card-board-source-for-board-or-single-project-scope.ts`）：

- **单项目范围**：绑定当前项目。没有部署记录的项目不显示按钮，与过去一致。
- **All projects**：面板不跟随当前项目，按钮与面板常驻。当前项目自己有部署组时仍绑定它，因为看板「移入 Done」的门禁预检只认当前项目的读模型；否则绑定最近部署过、已注册且可用的项目。候选列表来自无 scope 的只读 query `deployment.listWorkspacesHavingPostDeployVerificationDeploymentGroups`（纯读全局状态文件，不对账）。标题栏显示所绑定项目的名字。

折叠状态与单项目视图共用同一个持久偏好（`kanban.post-deploy-verification-collapsed`），默认展开。

面板条目的卡体与 controller 判列要读**所绑定项目**的 board，有两种来源：

| 来源 | 何时 | 卡体与「完成核对」 |
|---|---|---|
| `current_project_board_hydrated_in_browser` | 单项目范围；或 All projects 下所绑定项目 = 当前项目 = 浏览器里已水合 board 的项目 | 与主看板同一份 board、同一组卡片动作；移列走 `useBoardInteractions`，带 overlay |
| `runtime_board_snapshot_of_workspace_not_hydrated_in_browser` | 其余 All projects 情形，包括跨项目打开任务的过渡窗口（`currentProjectId` 已变、board 还是上一个项目的） | 向 runtime 读 `workspace.getState` 快照（30 秒轮询 + 该项目列计数变化去抖重读）；卡体只做展示，Done 按钮走条目自己的完成核对（历史组不可交互时改为在所属项目打开）；点卡，以及卡体按列画出的其余动作按钮（Start / Move to validation / Move to review / Restore），都在它所属的项目里打开该任务，不留点了没反应的按钮 |

taskId 只在项目内唯一，所以「读浏览器里的 board」的判据必须同时比对 `projectIdOwningHydratedBoard`，只比 `currentProjectId` 会在过渡窗口里把另一个项目的同号卡当成条目。

快照模式的移列（`web-ui/src/state/post-deploy-verification-panel-completion-move-into-done-for-workspace-board-not-hydrated-in-browser.ts`）先在服务端用 `taskCardAction.readTaskCardWithBoardColumn` 复检卡片所在列：快照最多旧 30 秒，而 token 按发放时的列算确认项，卡已漂移就不能用旧确认项推进 Done。复检通过后调用的仍是同一个 `taskCardAction.moveTaskCardIntoDone…` 门禁主路径。
