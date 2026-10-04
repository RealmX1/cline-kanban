# 工程文档

本目录是 Kanban 本身开发者的上手起点。

目录划分沿用小型工程团队的常见做法：

- `README.md` 介绍产品、本地搭建与日常使用。
- `docs/` 存放面向人类的稳定上手与架构参考。
- `.plan/docs/` 存放活跃计划、交接记录，以及大型重构的深层变更历史背景。

新接触代码库时，按以下顺序阅读：

1. [`../README.md`](../README.md)——产品概览与本地搭建。
2. [`architecture.md`](./architecture.md)——系统图、运行时模型与关键文件导读。
3. [`cli-environment.md`](./cli-environment.md)——CLI/hook 环境变量（超时、运行时 host/port、hook 上下文）。

## 机制深挖

仅凭代码难以还原的子系统，详细参考如下：

- [`session-facet-model.md`](./session-facet-model.md)——双轴会话状态 facet 模型（turnOwner / liveness / userTurnKind）及其三条铁律。
- [`agent-output-timestamps.md`](./agent-output-timestamps.md)——卡片时长药丸的字段模型与 `lastSubstantiveOutputAt` 写路径。
- [`terminal-io.md`](./terminal-io.md)——output-reaction 框架、持久终端 visibility 协议，以及 PTY/argv 特殊字符安全。
- [`agent-harness-kimi.md`](./agent-harness-kimi.md)——Kimi Code 终端 harness 接入（延迟 prompt 注入、TOML hooks、预置 home）。
- [`agent-harness-omp-acp.md`](./agent-harness-omp-acp.md)——oh-my-pi（omp）ACP 传输层及其协议坑。
- [`agent-context-management.md`](./agent-context-management.md)——如何编写、分诊与维护 agent 上下文文件（AGENTS.md / CLAUDE.md / rules / skills）。

## Runbook

- [`runbooks/agent-cli-capability-probing.md`](./runbooks/agent-cli-capability-probing.md)——外部 agent CLI 的低成本能力探测。
- [`runbooks/runtime-summary-field-and-toggle.md`](./runbooks/runtime-summary-field-and-toggle.md)——新增 `RuntimeTaskSessionSummary` 字段或持久化全局设置开关的全栈链路。

## 决策记录与事故复盘

- [`adr/0001-stage-first-overview-uses-raw-column-membership.md`](./adr/0001-stage-first-overview-uses-raw-column-membership.md)——stage-first overview 按 raw 列归属判定 stage 成员。
- [`adr/0002-plan-mode-permission-mode-orthogonal.md`](./adr/0002-plan-mode-permission-mode-orthogonal.md)——plan 起步与权限档位是两条正交轴。
- [`post-mortems/event-loop-stall-lock-crash.md`](./post-mortems/event-loop-stall-lock-crash.md)——事件循环停摆被文件锁 compromise 处理放大，导致整个多项目服务器进程退出。

## 功能术语表

- [`context-stage-first-overview.md`](./context-stage-first-overview.md)——跨仓库 stage-first overview 的领域语言（从仓库根 `CONTEXT.md` 迁入）。
- [`context-inter-work-unit-relation-modeling-overhaul.md`](./context-inter-work-unit-relation-modeling-overhaul.md)——dd2db 工作单元间关系建模重构的领域语言：工作单元、行动者、关系账本事件、记录型与断言型关系等（从仓库根 `CONTEXT.md` 迁入）。

说明：`docs/architecture.md`、`DEVELOPMENT.md`、`web-ui/README.md` 等上游继承的人类向文档仍为英文（属既定策略）；新增 agent 向文档以中文为主。

日常上手所需的内容在本 `docs/` 目录内自足。活跃计划与交接记录可能仍留在 `.plan/docs`，但新工程师理解当前架构不需要读它们。

新增工程文档时，优先把稳定的解释放在这里，并从本索引链接。
