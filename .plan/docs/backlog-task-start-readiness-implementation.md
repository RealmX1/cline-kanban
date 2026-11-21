# Backlog 开启复核实施合同

批准来源：用户要求实施附件 `30abc8a1-88ae-4366-8440-38e79a9806b1/approved-plan.md`，状态 `PLAN-READY`。

- 能力：声明开启条件；按创建基线、任务年龄和当前工作复核漂移；在原授权内修订并开启。
- 范围：共享创建／编辑器、草稿、批量及跨项目、CLI、独立评估、统一启动、持久证据与有界恢复。
- 范围外：主动扫描并启动所有 Backlog、执行条件中的命令、改变目标或权限、自动结案、部署及提交。
- 验收：全部启动入口一致；覆盖无漂移、历史缺证、相关／无关变化、部分／全部完成、条件不满足；覆盖并发、Stop、重启及回执丢失。
- 风险：旧任务没有创建基线；模型不能把不完整证据解释成无漂移；提交前必须重验任务及仓库身份。
- 变更面：核心契约与 board 漏斗、卡片动作、辅助 AI 路由、运行时恢复、CLI、编辑器与卡片双宿主、相关测试和文档。

## 实施切片

1. 开启条件与创建基线：先验证字段及三态更新，再接入服务端建卡、共享表单、草稿和 CLI。
2. 独立评估：先验证轻量判断、历史覆盖及模型结论，再实现受限只读补证与持久报告。
3. 统一开启：先验证未通过不移列、并发失效及启动去重，再接入所有入口和跨重启恢复。
4. 端到端验收：guarded 测试、根／Web 类型检查、lint、隔离构建与浏览器；注册真实实例 PDV。

原始 Prompt 保留；修订说明与来源独立保存。已授权的启动意图才可恢复，机器缺证不得变成人工批准。

## 并行任务核对

采集证据：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/e1690/implementation-sibling-task-survey.json`。

```text
SIBLING_TASK_SURVEY=VERIFIED
TASK_INVENTORY_SOURCE=KANBAN_CLI
SIBLING_TASK_COUNT=643
SOFT_OVERLAP_TASK_IDS=e8542,80116
HARD_COLLISION_TASK_IDS=bfaed,faac4
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
```

软重叠：e8542（Backlog）的创建基线与漂移分析，80116（Review）的就绪信号。文件交叉：bfaed（In Progress）的 API 契约／卡片动作；faac4（In Progress）的 API 契约／路由。仅在本任务 worktree 新增独立领域模块并修改必要共享接线，未吸收其他工作。
