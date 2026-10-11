# Task Relation Modeling Overhaul：完成成果覆盖与旧任务收敛规范

状态：**规范已批准；2026-09-30 按 dd2db 设计修订（Q5、§R3）；运行时机制待 overhaul 实现**。

> **来源说明**：原稿出自 task `8d597`（2026-09-24，未提交，原件留在 `~/.cline/worktrees/8d597/cline-kanban/.plan/docs/` 下，本次没有改动原件）。本版由 task `ac29f` 于 2026-09-30 复制到 dd2db 的实现 worktree，按 dd2db 计划修订，对应阶段 0 ①（Y-PHASE-6 ①）。
> 修订依据（优先级 §R3 > §R4 > §R2 > 分支文件）：
> - 计划：`~/.claude/plans/task-relationship-modeling-bright-kitten.md` 的 Q5、§R2.4、§R3；
> - 仲裁补遗：同目录 `-grill-round-2-design-branches/r3-arbitration-addendum-final.md`（Y-PHASE-3、X6、Y-OBLIG-1/2/5/6/7/8、Y-GATE-2/7/8、Y-EVENT-1/12、R3.4）；
> - 分支文件：d-obligation §5.3、§5.17#1–4；d-confirm §2.4、§3.2、§13「同步修订」#1–3；r-intention §4.4–4.5。
>
> 修订后**用户要求才提交**（Y-PHASE-6 ①）。下文的 kind 名、动词名以 d-vocab 与 R3.4 为准；阶段编号见计划 R3.3。

本文件是 task relation modeling overhaul 的必要能力合同，正文只维护这一份。
本次交付规范、验收要求和任务交接，不批量处置既有任务，不代表自动收敛或消息携带已经可用。

## 归属与当前约束

| 任务 | 与本规范的关系 |
| --- | --- |
| `dd2db` | 任务关系建模、可视化及 agent 工具的承接任务；实现 overhaul 时必须覆盖本规范。覆盖核对（reconciler）、覆盖动词与完整度闸接入落在阶段 4a，携带实体落在阶段 2，共享落地判据在 1a 保全数据、1c 求值。 |
| `9cc01` | 跨 harness 工作单元全局 Recap，作为上下文端口 L1 的提供方，并承担 Claude `away_summary` 的读取（§R4、Y-PHASE-4）。Recap 只是核对的情境材料，本身不是完成证据；agent 末次汇报只作情境，不取信为「做到哪」的事实。 |
| `ac08e` | 意图系统（my-ai-setup）新增的「单工作单元意图卷宗」投影，作为上下文端口 L2 的适配器。**跨库覆盖自动结案的硬依赖**（§R4、X6）。 |
| `024c5` | 服务端 Move-to-Done 安全检查与统一 Done 命令的承接任务；资源清理必须遵守其保护规则。统一 Done 命令需接受 `initiator` 与一元结局（d-obligation §5.16），该记录须在 024c5 开工前追加。 |
| `8d597` | 本规范及已确认产品选择的来源，不另起一套任务关系存储或批量清理系统。 |

当前本地 base `2a718aeae7272ff36555a755e3557240e6bc9809` 的代码约束：

- [`runtimeBoardDependencySchema`](../../src/core/api-contract.ts) 只有任务端点和创建时间，不能表达覆盖范围、证据或确认状态。dd2db 阶段 1a 退役旧 link 机制（`task link` / `task unlink`、依赖箭头、完成后自动启动、有损 GC）；覆盖关系一律进全局关系库，不复用该 schema。
- [`task-board-mutations.ts`](../../src/core/task-board-mutations.ts) 会按任务列归属裁剪 dependency；覆盖关系必须独立于该模型，任何移列都不删除关系。
- [`trashTaskById`](../../src/commands/task.ts) 的 Done 路径会停止会话、启动就绪关联任务并删除 worktree；不能直接用于“旧需求已被覆盖”的自动收敛。因此需要一个**不走 Done 的结案动作**：义务状态由事件与关系推导（C′），列不变（X11、Y-OBLIG-11）。
- [`task-commit-integration-provenance.ts`](../../src/workspace/task-commit-integration-provenance.ts) 已持久化 `headCommit`，但没有「最后已知 HEAD 可达的非 merge 自有提交」集合；删卡或清空 Done 时，`removeTaskCommitIntegrationProvenanceAfterWorktreeDeletion` 会删掉 provenance。共享落地判据要求 1a 起在每次探测时保全这份数据，并且删卡不再删除 provenance（Y-PHASE-3）。
- [`task-message-injection-ledger.ts`](../../src/core/task-message-injection-ledger.ts) 已区分真实送达与等待提交确认，可复用投递回执语义；尚未发起的“等待下一次用户消息”不得伪装成在途投递。

## 1. 触发与证据

完成任务的验收要求已满足，且成果经 base branch sync 确认进入**本地 base** 后，核对相关的未完成任务。两个条件缺一不可，不要求远端 push。**核对范围不限于同一 project**（Q5）：reconciler 的候选发现首版先限同 project，显式覆盖动词（`claim-coverage-of-requirements`、`declare-own-requirements-covered-by`）可以跨库（R3.3 4a 行）。

「进入本地 base」统一用**共享落地判据**（d-gate 条件 3，Y-PHASE-3）：取完成任务最新一世（incarnation）中、从最后已知 task HEAD 可达的非 merge 自有提交，集合非空，且每个提交都按 exact SHA → patch-id 一对一进了本地 base。不读拓扑 ahead；被 rebase 丢掉的旧 SHA 与吸收 base 产生的 merge 不计。1a 起每次探测都持久化 `lastKnownTaskHeadCommit` 与 `taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead{sha, stablePatchId}`；1c 求值并产出 `task_commits_integrated_into_local_base_observed` 观测事件。squash 或手工 cherry-pick 导致 patch-id 对不上时，机器判不出落地，只能交用户裁决，不得推定已落地。

必要的部署后验证未通过时，成果尚不满足该完成条件。**PDV 通过只是必要条件，不等于自身落地**：自身完成还需要共享落地判据成立（d-obligation §5.17#3）。agent 回合结束、卡片所在列、同步命令退出成功或 Git ahead 为零，均不能单独证明工作彻底完成。

**非代码交付**（回答、报告等）不套用「进入本地 base」条件，但系统无法核验，**必须由用户确认**（矩阵 M18，只能 S6）；它不能作为覆盖他卡的「已落地成果」。

核对依据是旧任务的具体用户要求与验收项，而非标题或文本相似度。候选检索应包含未事先建立关系的旧任务；相似度只能帮助发现候选，不能直接关闭任务。核对基线是「用户撰写的需求史」减去已生效的剔除与边界排除；agent 自己编辑 prompt 删掉的用户要求项仍计入基线（Y-OBLIG-2 防绕过）。

每次核对保留：

- 完成任务与目标旧任务的限定引用 `{workUnitType, workspaceId, taskId, taskIncarnationCreatedAtEpochMs}`（Y-EVENT-12）；
- 完成成果、实现及验证证据、本地 base ref 与对应提交（含上述落地快照）；
- 目标旧任务被核对时的需求指纹 `requirementObligationBaselineFingerprint`（prompt、images、prepFilePath、taskCommentEntries、已生效剔除与排除集合的哈希，**不含标题**；Y-OBLIG-7）；
- 核对所用上下文材料的层级与出处 `coverageReconciliationWorkUnitContextMaterialProvenance`（L0–L3，以及提供方可用性；Y-OBLIG-8）；
- 已覆盖要求、仍未覆盖要求、判定理由及核对时间。

这份核对记录就是对应可确认变更的 S3 核验记录，不另存一份。

历史信息缺失就标为待核对，不能把“未找到剩余工作”当作“证明全部完成”。

## 2. 关系与处置

关系模型区分 **完全覆盖 / 部分覆盖 / 仅相关**，分别对应 `obligation_fully_covers_requirements_of`、`obligation_partially_covers_requirements_of`、参照轴 `reference_is_generally_related_with`（Y-OBLIG-10）。候选与已确认状态走可确认变更的生命周期：完全覆盖是矩阵 M8，部分覆盖是 M9，均只允许 S3 或 S6，默认 S3；S3 不确定时，M8 升级为用户决策，M9 回退为「仅留建议并随下一条用户消息携带」（d-confirm §2.4）。覆盖方向为“完成成果覆盖旧任务要求”（S = 覆盖方，A = 被覆盖方）。

**覆盖结案只有一条路径**（X12、Y-OBLIG-1）：完全覆盖关系在事件族 4 的确认迁移本身就是「由覆盖满足」这一结局的真相，不另写结案事件；完全覆盖生效**没有任何写入型副作用**（不改卡、不停会话、不删 worktree）。义务状态由推导得出，推导变化时发布 `requirement_obligation_phase_projection_changed_notification`（可重放，不是真相）。

允许多个已完成成果共同覆盖同一个旧任务；不能仅凭传递关系推定所有要求已满足。多个部分覆盖合起来结案的唯一写法是**累积路径**（Y-OBLIG-5）：A 新增一条已生效的部分覆盖，或 A 的剩余要求因剔除、排除而清空时，reconciler 提议一条 M8，S 取确认序号最大的那条贡献覆盖的覆盖方，`priorPartialCoverageRelationIdsCompletedByThisCoverage[]` 列出其余贡献，并带 `fullCoverageEstablishmentRoute`。任一前序部分覆盖被撤回时，推导回到 open（`closure_support_set_partially_retracted_pending_recheck`），并提议撤回或刷新这条完全覆盖。

**与相近结局的区别**（d-obligation §5.17#4、§7；X2、Y-OBLIG-4/6）：

| 关系 | 含义 | 是否主张「需求已满足」 | 证据 |
| --- | --- | --- | --- |
| 覆盖（完全 / 部分） | 覆盖方已落地的成果满足了旧要求 | 是 | 落地证据 + 逐项要求核对 |
| 接手 `obligation_takes_over_all_remaining_obligations_of` | 后继承担前任的全部剩余义务，后继仍须完成 | 是（剩余义务已移交） | 剩余义务都有去向；每个前任最多一条已确认接手，多后继写成「若干边界排除 + 恰好一条接手」 |
| 使过时 `obligation_renders_obsolete_requirements_of` | 旧要求本身被新方向替换，不需要再满足 | 否 | 没有落地证据可核验；A 在提议方纯委派子树内走 M5，否则走 M7（只能 S6）。「supersede」一词今后只指记录的代际更替 |

| 核对结果 | 应执行的处置 |
| --- | --- |
| 已确认完全覆盖 | 推导出结局 `requirement_obligation_outcome_fulfilled_by_covering_work_units`，旧任务退出未完成工作，标注“由任务 X 的已完成成果覆盖”；保留原需求、会话历史及覆盖证据。 |
| 已确认部分覆盖，剩余目标连贯 | 默认在原卡内归档旧计划版本，将当前计划收敛为仍有价值的剩余工作，保留任务与会话身份。 |
| 已确认部分覆盖，剩余目标适合独立承接 | 建立只包含剩余工作的新任务，记录来源和承接关系；全部剩余义务有去向后才归档原规划。 |
| 覆盖范围或剩余价值不明确 | 保持原计划，仅保存相关实现信息与建议修订，等待后续上下文。 |
| 仅相关 | 保留相关性信息，不自动结束或删减任务要求。 |

部分覆盖的重整与承接卡由 `system_relation_side_effect_executor` 分步执行（Y-GATE-7）：建卡步骤用由 changeId 派生的确定性 `clientRequestKey`，执行前先查全局 task 身份登记簿，重放不重复建卡；承接卡确认建成之后才归档原计划。

“原卡重整”是默认倾向，**视具体情况分析**，不是固定算法。考量剩余目标能否独立成立、验收边界是否已变化、是否需要独立执行上下文；不得仅为整理卡片而拆出新任务，也不得自动舍弃尚未满足的用户要求。

实现时，在实际选择“原卡重整 / 新任务承接 / 仅建议”的决策代码处加入下面这一行，作为未来实验节点；目前此处是待落实的代码注释要求：

```ts
// EXPERIMENT_NODE: 部分覆盖后视具体情况选择原卡重整、新任务承接或仅建议，未来实验比较这些选择。
```

全局 coding agent 指令已约定 `EXPERIMENT_NODE:` 为可检索标记；用 `rg 'EXPERIMENT_NODE:'` 查找。无需另建实验注册表、编号体系或配置框架。

自动修订只能移除已证实满足的义务并重述既有剩余目标，不能扩展新需求。归档意味着保留旧计划版本，不是删除历史或伪称旧任务自行完成了实现。

## 3. 需求收敛与资源清理分离

旧需求退出未完成集合，并不授权停止活动会话、删除 worktree、丢弃未提交修改或未进入 base 的独有提交。上述资源有未处理工作时继续保留，并记录仍需处理的资源事项；这些事项不是把已覆盖需求重新变成待办。

**首版有意比原稿更严**（d-confirm §13 同步修订 #1）：任何关系的生效都**不以资源清理为副作用**。资源清理仍只走 `024c5` 的服务端安全检查与 Move-to-Done 路径（手动，或阶段 4b 对「已结案且资源干净」的卡批量生成清理提议）；Git/base 探测不明时不得自动删除。不绕过检查直接调用现有 Done 副作用链。

**不因新增覆盖关系误启动关联任务**，具体化为（d-obligation §5.17#2，经 Y-GATE-2 修订）：旧 link 的「完成后自动启动」在 1a 已整体退役；此后唯一的启动途径是门的 start 动作，并受义务结局硬上限约束——
- 只有 `fulfilled_by_own_work`、交付物是代码、且落地经系统核验时，门可以直接 start；
- 其余自身完成、由覆盖满足、无主提交覆盖，start 一律降为需要确认的启动提议（M13）；由覆盖触发的替代门继承「提议启动」上限；
- 接手、使过时、abandoned、unspecified、删卡等让门走向未满足侧的结局，start 不执行，改为 notify；carry 与 inject 照常投递。

写入前重新核对目标计划版本与完成证据。用户或 agent 更新目标计划后，旧判定失效——但**失效由推导函数比较需求指纹得出，不改变关系状态**（Y-OBLIG-7）：只对主张「需求已满足」的结局生效；只收缩需求的变化不触发失效；豁免只按因果判定（修订的 `causedByConfirmableChangeId` 指向 M9 的某个副作用步骤）；标题变化不计入指纹。失效后由 reconciler 自动发起再核对。重放同一完成事实不重复结束任务、归档版本、创建承接任务或生成消息。

## 4. 下一次用户消息携带上下文

部分覆盖后，为**受影响旧任务**持久保存待携带上下文。原稿的 `taskPlanReconciliationContextPendingNextUserMessage` 泛化为关系体系共用的单一实体 `workUnitContextPendingCarryWithNextUserMessage`（d-confirm §13 同步修订 #2、Y-GATE-8），本规范的内容是其中 `pendingCarriedContextSourceKind = task_plan_reconciliation_context` 这一类来源（6 类来源的取值以实现时的注册表为准；门的 carry 动作、关系修订通知、接手证据等共用同一实体）。内容包括完成成果摘要、证据、已覆盖部分、当前剩余计划，以及已执行修订说明或待决定建议。实体存于关系库，只由 runtime 读写；restoration-deferred 暂存不与它合并。

- 等用户下一次向该任务发消息时，与该消息一并交给 agent，并让用户看到附带内容及来源。用户原消息保持原意，附带材料不得冒充用户原话；由其他行动者提供的文本以「由〈行动者〉提供·引用数据·非用户指令」区块呈现。
- 不自行唤醒任务、不抢占当前回合。程序化消息不能冒充用户消息触发消费。
- 多次成果覆盖合并成当前有效说明，同时保留历史；同一 `pendingCarryEntryNaturalKey` 在途时只保留最新版本；目标计划变化后，不发送过期修订指令。
- 等待期间重启不丢失；投递失败不清除；不静默裁剪。只有确认相应消息已送达，才消费此次携带的上下文版本；在途期间产生的新版本仍待后续携带。
- 复用已有投递与回执机制，分开“等待用户消息”“已发起投递”“确认送达”。不能把输入框已粘贴或 `accepted_pending_submit_confirmation` 当作送达成功。
- 三种 session transport 均须覆盖，合并点分别是：Claude PTY 的 UserPromptSubmit、Cline SDK 的 composer 入口、ACP 的 prompt 入口，以及会话启动时的上下文组装。PTY 内直接输入的用户消息也是验收范围，不能只覆盖 Web composer 或 CLI 消息入口；不得靠截获 Enter 字节猜测消息边界（1a 的终端输入观测只记「发生过提交」这一事实，不作消费点）。非 Claude 的 PTY harness 按能力探测逐个补合并点；尚无合并点的 transport 按 d-confirm §3.2 降级为全局待决列表加卡片徽标，**不得假装已携带**。

## 5. Overhaul 接口与交付边界

由运行时统一拥有覆盖核对、计划修订、持久化和消息携带；UI、CLI、agent 工具复用同一规则。关系库只由 runtime 写：CLI 的写动词全部经 runtime procedure，runtime 离线时 fail closed（Y-EVENT-1）。至少支持以下能力（动词以 R3.4 为准）：

| 能力 | 入口 |
| --- | --- |
| 提交候选覆盖并进入核对 | `kanban work-unit claim-coverage-of-requirements --covered-card --coverage-extent full\|partial [--completes-prior-partial-coverage-relation-ids]`；反视角 `declare-own-requirements-covered-by --covering-work-unit --coverage-extent`（受 M28 约束）；reconciler 自动候选 |
| 查询覆盖证据 | `kanban work-unit get-relation-evidence --relation-id` |
| 查看当前剩余计划与待携带上下文 | Web UI 详情面板；`kanban work-unit get-relation-neighborhood-summary` |
| 读取被覆盖方的意图上下文 | `kanban work-unit get-work-unit-context --work-unit --context-level global-recap\|full-intent-dossier\|transcript-excerpt` |
| 确认、拒绝、否决 | 只在 Web UI 提供，没有 CLI |

关系、计划版本和消息上下文使用 overhaul 自身的持久化模型（全局 SQLite 关系库），不另建平行真相源。UI 展示任务因何结束、由谁覆盖、原计划和剩余计划；关闭后仍可沿关系追溯。

**跨 project**（Q5；替换原稿「首版自动收敛限同一 project」）：全部关系轴跨 project，跨库覆盖**也自动结案**，但要在被覆盖方一侧做更严格的意图上下文收集：

- 所有任务引用携带限定引用（含 incarnation 戳），避免同号 task 混淆。
- 跨 project 时，M6、M8、M9 的 S3 核验材料下限提到 L2 完整意图卷宗（R-crossproject）；M4（挂接既有卡为子任务）用 L0 材料，跨库照常 S3，不受下述降级影响。
- 跨库自动结案必须通过完整度闸 `crossRepositoryAutomaticClosureIntentContextCompletenessGate`，三条同时满足：L2 提供方 `providerAvailability=available`；`conversationSessionsWithMissingTranscript` 为空；被覆盖方每条 active 意图项都有逐条的「已覆盖」判定和证据。任一不满足即降级为待核对 / 仅建议。在「是否允许非核心 harness 的 transcript 缺失」处标 `EXPERIMENT_NODE:`。
- cline-kanban 内的 L2 兜底（当前 prompt + prompt 改写史 + transcript 中的原始用户消息，全部标为「未分类」）标记 `providerAvailability=provider_not_installed`，**永远过不了完整度闸**。
- **ac08e 的 L2 卷宗适配器就绪之前**，跨库的 M6、M8、M9 一律按 S6 由用户决定，跨库 S3 开关不打开（X6、Y-OBLIG-8；用户 2026-09-30 选 U-OBLIG-1 = (1) 继续等）。回问点：阶段 4a 交付时 L2 仍不可用，附跨库队列实测长度再问一次。

本规范不修改 global `base-branch-sync` skill，也不把 Git 同步工具变成需求完成判定器。未来运行时在获得完成事实与本地落地证据后触发核对；仅 one-way sync 不等于完成并 handback。

## 6. 必须自动化验证的场景

以下为机制实现后的验收要求，当前文档交付不宣称这些行为已通过运行测试。

| 场景 | 预期 |
| --- | --- |
| 验收通过且成果进入本地 base；旧要求确认全部覆盖 | 自动收敛旧任务，保留覆盖来源和历史；完全覆盖生效没有写入型副作用。 |
| 仅同步成功、仅语义相似、验收缺失、必要部署验证未完成 | 不自动关闭旧任务。 |
| PDV 已通过，但共享落地判据不成立（提交未进 base、零自有提交） | 不记为自身完成，不能作为覆盖证据。 |
| 成果经 squash 或手工 cherry-pick 落地，patch-id 对不上 | 不推定已落地；发关注通知，交用户裁决。 |
| 完成任务的 worktree 在核对前已被删除 | 最后已知 HEAD 与可达自有提交集合已保全，落地判据仍可求值；provenance 不随删卡消失。 |
| 非代码交付声明自身完成 | 只能由用户确认（S6），不能作为覆盖他卡的已落地成果。 |
| 完全覆盖但旧任务含活动会话、脏 worktree 或独有提交 | 需求可以收敛，资源及未处理工作保留；不停会话、不删 worktree、不误启动关联任务。 |
| 覆盖结局触发了等待旧任务的门 | 门的 start 降为需确认的启动提议；接手、使过时等未满足侧结局只 notify；carry 照常投递。 |
| 部分覆盖且剩余目标连贯 | 原卡保留剩余要求，旧计划版本可查；不产生无必要的新卡。 |
| 剩余目标需要独立承接 | 新任务只承接剩余义务，来源可追溯；创建失败不得提前归档原规划；重放不重复建卡。 |
| 多个部分覆盖累积满足全部要求 | reconciler 提议累积路径的完全覆盖；撤回任一前序部分覆盖后推导回到 open 并提议刷新。 |
| 覆盖不明或旧任务已并发修改 | 保持原计划或重新核对，不应用过期判定。 |
| 覆盖生效后旧任务需求被扩充 | 推导判定失效、关系状态不变，reconciler 自动再核对；只收缩需求、只改标题、或修订由 M9 副作用步骤引起时不失效。 |
| agent 自己改 prompt 删掉未满足的用户要求项 | 该项仍计入核对基线，不因删改而视为已满足。 |
| 下一条是真实用户消息 / 程序化消息 | 前者携带最新实现说明与计划信息；后者不消费待携带上下文。 |
| 三种 transport，含 PTY 原生输入 | 同一携带语义成立；上下文不抢跑，用户消息不丢失或重复；尚无合并点的 transport 降级为待决列表加徽标，不假装已携带。 |
| 重启、投递失败、重复触发、在途时出现新版本 | 持久恢复与可重试；无重复收敛、承接任务或已确认消息；新版本不被旧回执误清。 |
| 两个 project 存在同号任务 | 限定引用不混淆来源和目标。 |
| 跨 project 完全 / 部分覆盖，ac08e L2 适配器尚不可用 | 按 S6 等用户决定，不自动结案；L2 兜底标 `provider_not_installed`，完整度闸不通过。 |
| 跨 project 覆盖，L2 可用但 transcript 缺失或有 active 意图项无逐条判定 | 完整度闸不通过，降级为待核对 / 仅建议。 |
| 跨 project 覆盖，L2 可用且完整度闸通过（跨库 S3 开关打开后） | S3 核验通过后自动结案，材料出处记录为 L2。 |
| 跨 project 挂接既有卡为子任务（M4） | 照常 S3，不受跨库降级影响。 |

实现时先用自动化工具验证上述场景，再按 `cline-kanban-post-deploy-verification-authoring` 注册真正只有部署后实例才能验证的差额；不要现在为尚不存在的机制注册虚假验证。

## 修订记录（ac29f，2026-09-30）

- 按 dd2db 阶段 0 ① 修订，产物位于 ac29f worktree 的 `.plan/docs/`；**未提交**，须用户要求才提交。8d597 worktree 中的原件未改动。
- 原稿交付记录中「正文已通过 `docs/README.md` 索引」指 8d597 worktree 内的索引改动；本 worktree 的 `docs/README.md` 尚无该索引，随提交一并补上。
- 实际运行时代码尚不存在；上表场景均未运行测试。

## 原稿交付记录（8d597，2026-09-24，保留原文）

- 正文已通过 `docs/README.md` 索引；已给 `dd2db` 的原始任务说明追加本规范入口与必要要求，回读确认原始要求、列、设置、会话、工作树和 dependency 均保留。
- 全局标记约定各一行，写入 `~/.codex/AGENTS.md` 与 `~/.claude/CLAUDE.md`；已核对一致且没有重复。实际决策代码尚不存在，代码标记随 overhaul 实现加入。
- 文档链接与空白检查通过。没有新增运行时代码，因此未运行运行时测试，也不将上表未来验收项标为已通过。
- 已调用部署后验证 authoring 流程：本次文档和全局指令变更可直接回读，不依赖部署；新增 automated/guided 验证均为 0，无验证资产需要清理。
- 本次只完成开工前 one-way bootstrap，task HEAD 与 local main 均为 `24591cd67c0494232f675e1a79350633594eb5d4`；未提交、未 handback、未 push、未部署、未批量关闭任务。

```text
DRAFTED_PLAN_LOCATION=task 8d597 已批准对话计划
MUTATION_ALLOWED=1
LOCAL_BASE_DELTA_INSPECTED=VERIFIED
LOCAL_BASE_ABSORPTION=COMPLETED
SIBLING_TASK_SURVEY=VERIFIED
TASK_INVENTORY_SOURCE=KANBAN_CLI
SIBLING_TASK_COUNT=230
SOFT_OVERLAP_TASK_IDS=dd2db,9cc01,024c5
HARD_COLLISION_TASK_IDS=NONE
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
BASE_REF_LOCK_STATUS=AVAILABLE
```

软重叠按上文归属处理，本次仅交接规范；没有需要双方同时编辑的文件。收敛规则与全局实验标记已纳入批准计划，未引入平行运行时实现。
