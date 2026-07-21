# Sync / PR Scheduler Agent backlog

> 状态：**Backlog，暂不进入进一步设计或实现**。
>
> 本文只保存需求与已确认的工作流方向，供后续 rewind 回到本议题时重新规划。它不表示当前已批准具体调度算法、数据模型、自动化权限或落地仓库。

## 背景

多个 task worktree 可以并行 implementation、RVF 和验证，但它们最终都需要把工作带回同一个 local base branch（通常为 local `main`）。对同一 base ref 的最终更新必须串行；在一个任务进行 RVF 或等待 handback 期间，其他 Agent 可能已经推进 base，导致前者需要再次吸收 base、处理语义交互、重复验证，甚至重新进入 RVF。

已经形成的短锁方向只能减少 base-ref lock 的持有时间，不能减少所有任务之间因落地顺序不佳产生的总体返工。不同变更之间的顺序具有方向性：基础设施、安全修复、共享 API/schema 或高扇出重构若较晚落地，可能迫使多个下游任务重复迁移和复验；互不相关的任务则不应因此被阻塞。

## 需求概述

需要探索一个跨任务的 **Sync / PR Scheduler Agent**：它不只观察已经完成 RVF、等待 handback 到 base branch 的任务，也可以观察正在 implementation、准备进入 RVF 或具有明确上游依赖的任务，并建议或协调更低总体成本的同步与落地顺序。

目标不是让同一个 base ref 真正并行更新，而是：

- implementation、review、RVF 和候选验证尽可能并行；
- 最终 base-ref mutation 仍以短事务、freshness check 和 compare-and-swap 方式串行；
- 通过调整落地顺序和选择合适的同步 checkpoint，减少冲突解决、重复测试、RVF 失效与 Agent 上下文切换的总量。

## 必须覆盖的任务范围

Scheduler 后续设计至少应能区分并考虑：

1. 已完成实现并等待 RVF 的任务；
2. 正在 RVF 或已经取得 clean RVF 结果、等待 handback 的任务；
3. 正在 implementation、但与即将落地的基础变更存在高耦合的任务；
4. 具有显式 task dependency / stacked-work 关系的任务；
5. 与当前变更簇独立、可以继续并行而不应被阻塞的任务。

## 调度需要考虑的变化性质

后续规划应评估，而不是仅按 FIFO 或看板列顺序处理：

- 硬依赖方向：下游任务是否消费上游任务将引入的契约；
- 共享 API、schema、registry、migration、依赖或测试基础设施变化；
- 文件、symbol、执行流和验证面的交集；
- 变更属于安全基础、共享 foundation、unblocker、leaf feature 还是基本独立的改动；
- task 当前成熟度、预计完成时间和落地置信度；
- 现在打断 implementation 的成本，与未来吸收变化、解决冲突及重开 RVF 的预计成本；
- 验证耗时、RVF 重跑成本、任务等待时间和 starvation/fairness；
- 多个任务是否形成无法通过简单排序消除的循环依赖，从而需要显式 stack 或 integration batch。

## 面向进行中 Agent 的候选建议语义

后续设计可以评估提供明确、可审计的建议状态，例如：

- `CONTINUE_ON_CURRENT_BASE`：与近期候选变化交互面低，继续当前实现；
- `ABSORB_CURRENT_BASE_BEFORE_RVF`：高相关基础变化已经落地，应在进入 RVF 前吸收；
- `WAIT_FOR_DECLARED_UPSTREAM_TASK`：存在明确且即将满足的硬依赖；
- `STACK_ON_STABLE_UPSTREAM_CANDIDATE`：任务明确依赖尚未进入 canonical base 的稳定上游候选；
- `TEST_AGAINST_SPECULATIVE_INTEGRATION_CANDIDATE`：仅针对预测组合做兼容性验证，不把未落地变化静默写入 durable task worktree。

这些名称只是 backlog 中的需求表达，不锁定最终 API 或状态枚举。

## 与现有能力的边界

- `sync-local-base-into-task-worktree-only` 仍负责旧 worktree 在 test、commit、RVF 前取得安全 base revision；其 Git/Hook/WIP 安全能力仍然需要，不被 Scheduler 取代。
- `base-branch-sync` 应继续作为固定 OID absorption、短锁、freshness check、CAS landing 和 handback 的机械执行器；它不应自行承担全局任务排序。
- RVF 仍负责审查确定的 task/candidate；Scheduler 只决定何时需要普通验证、增量 integration review 或 RVF reopen，不伪造 clean 结论。
- Cline Kanban 可能是任务状态、Agent 生命周期和调度建议的观察面；跨仓通用协议或 skill 可能属于 `my-ai-setup`。最终职责归属留待后续架构规划。

## 安全与权限边界

- Scheduler 的第一阶段应优先考虑 advisory，而不是自动暂停、重写或合并 Agent 工作。
- 不得因为预测中的上游候选而静默修改 active task worktree。
- 对同一个 local base ref 的最终 landing 仍必须 freshness-checked 且可线性化；排序优化不能绕过短锁/CAS。
- 无法可靠判断依赖方向、所有权或语义交互时应 fail closed，或降级为人工确认/普通增量复核。
- 调度结果必须说明证据、被考虑的 task/base OID、推荐顺序原因和使建议失效的条件。
- 应保留 aging/fairness，避免大范围 foundation 工作或持续变化的高优先级任务使普通任务永久饥饿。

## 期望优化目标

后续方案不应只追求单个任务最快落地；应综合降低：

- conflict resolution 工作量；
- 重复 base absorption；
- 重复 typecheck/test/integration validation；
- 已完成 RVF 的失效与 reopen；
- Agent 被迫中断 implementation 的上下文切换成本；
- base-ref lock 等待；
- 总体 lead time，同时维持合理公平性。

## 后续规划时需要决定的问题

1. Scheduler 是独立 Agent、Kanban runtime capability、跨仓 skill，还是三者分层组合；
2. task 应发布哪些 machine-readable integration intent / change manifest；
3. 如何构建 hard-dependency DAG、冲突图和具有方向性的返工成本关系；
4. 哪些建议可确定性自动执行，哪些必须保持 advisory；
5. 如何把 RVF reviewed base、reviewed task tip、candidate tree hash 和 validation evidence 绑定起来；
6. 何时只做浅层 delta validation，何时需要 integration-delta RVF 或完整 reopen；
7. 是否以及何时引入 speculative merge train、integration batch 或 landing intent queue；
8. 如何用实际冲突次数、重复验证时间、RVF reopen 和 Agent 中断数据校准调度策略；
9. 如何让 active Agent 接收建议而不造成频繁 base churn 或反向返工；
10. 高并发下发生持续 freshness mismatch 时的 retry、fairness 和人工升级策略。

## 非目标

- 本 backlog 不批准具体排序公式或自动调度算法；
- 不在此阶段修改 `base-branch-sync`、RVF、Cline Kanban runtime 或任何 Agent；
- 不把多个任务未审查的改动自动批量合入 base；
- 不以 Scheduler 取代 Git 隔离、mutation canary、测试门禁或 RVF；
- 不在本阶段决定是否建立独立仓库或新增长期运行服务。

## 未来恢复本议题时的建议入口

从以下顺序重新开始，而不是把本文件直接当作 implementation plan：

1. 盘点等待 handback 与 active implementation 的可观测元数据；
2. 以真实历史任务重放不同 landing order，估算可避免的返工；
3. 定义最小 advisory capability contract；
4. 再决定职责归属、状态模型、算法与自动化权限；
5. 最后形成独立实施计划，并与 one-way bootstrap、短锁 CAS 和 RVF 生命周期对齐。
