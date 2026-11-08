# 独立任务简介与会话进展

Task Name 表达任务整体目标；`taskDescription` 简述问题或需求、范围及当前方案；Task Progress 记录实际推进过程。三者可以随已批准需求演变，Initial Prompt 继续保留原始需求与来源。

对外名称采用 Task Progress（任务进展）；Task Status 继续表示看板列，避免把执行轨迹与看板阶段混在一起。

## 创建、编辑与 Agent 更新

共用创建／编辑窗口提供「任务简介」，创建请求、冻结提交、编辑草稿、后台保留及跨项目入口携带同一字段。CLI 的 `task create` / `task update` 支持 `--description`；显式空字符串清除简介，不修改 prompt。独立任务草稿已有范围描述不超过 4000 字时复用为初始简介；较长范围继续保留在原始草稿与要求中，由实施阶段核对简述。

连续创建成功后，正文、名称、简介及附件一起复位，设置继续保留，避免上一张卡的简介进入下一张卡。

计划完成、获准开始实施时，Agent 必须核对 Task Name 并更新简介；后续更新进展时按已批准目标、范围或方案变化按需同步。新会话共享指导给出该要求，现有会话调用旧阶段目标入口时也会获得新入口提示。指导和 `implementationStarted` 声明不证明人类批准，更不改变权限档、Plan Mode、看板列或执行资格。

```sh
kanban task get --task-id <自己的任务ID> --project-path <主仓库路径>
kanban task record-current-task-progress \
  --progress-entry-id implementation-started \
  --implementation-started \
  --title '[FEAT,AGENT]压缩查卡上下文' \
  --description '全范围轻索引选择 0–10 个候选，仅阅读所选主会话的用户输入、问题作答与末次答复。' \
  --expected-task-updated-at <上次读取的task.updatedAt> \
  --text '开始实现分级上下文'
kanban task record-current-task-progress \
  --progress-entry-id verification-started \
  --previous-entry-id implementation-started --previous-outcome completed \
  --text '实现完成，验证分批与持久化'
```

`task get` 返回独立简介和 `task.session.agentWorkProgressEntries`，可读取上一条 ID。更新任务概况必须带读取时的 `task.updatedAt`；并发变化返回 CONFLICT，先读取最新概况，保留后来改动再提交。进展更新以预期上一条 ID 检查并发，条目 ID 是幂等键；同 ID 同内容不重复写，同 ID 不同内容拒绝。需要修正方案时，同一次调用可带 title / description 与相应版本。`--outcome completed` 可以记录最后一条已完成结果，不必制造新的待办。

## 进展与 To-do 的区别

原生 To-do 是可以调整的执行计划；Progress 是低频的实际阶段轨迹，不要求预先列出整个任务。更新时标记上一条 completed / abandoned，必要时写原因，再追加当前进展。失败、放弃路径与成功保留不同结果，不用换阶段自动推断成功。

轨迹保存在所属逻辑会话的 `agentWorkProgressEntries`，携带原生会话和 runtime incarnation 来源。Task 查卡与卡片只读取当前主会话的投影；旁支可以更新自己的进展，不能通过该入口改主任务概况。任务概况与进展在同一次 workspace 快照提交中持久化，然后通过现有 summary 漏斗推流。延迟到达的旧快照不能删除已记录轨迹，也不能把终态恢复为进行中。已有卡的简介只经显式字段操作修改，整板保存保留其最新值，既不能删除新字段，也不能复活已清空的简介。

新输入使旧活动显示为历史，同一原生会话仍可明确完成或放弃上一项；换原生身份不能把旧目标复活成当前进展。旧阶段目标继续兼容读取，导入时标为「结果未记录」。旧 set / clear 命令在已有轨迹上更新时，不能把被替换或清除的条目自动打勾。

ACP 冷恢复在首次 summary 广播前恢复同一逻辑会话的持久进展、旧目标及失效水位，再合并已有活体记录；其他会话的摘要不能导入。重建运行时不会给旧进展改写来源或自动宣告完成。

卡片默认只显示最新进展；会话详情可展开历史。进展打勾只证明 Agent 声明该阶段完成，不代替实现、提交、合入、部署或 PDV 证据。旧 `taskDescriptionLastUpdatedAt` 仍表示历史正文及附图的内容更新时间，本次没有重定义其排序语义。

## 后续接点

Task Force 的启发式触发、独立分身汇报见 Linear REA-29；自动 Rewind 见 REA-28。分身将来需要明确委托和真实来源，不能伪装成主会话或绕过版本检查。本次不实现这些编排，也不额外注入主会话催报回合。
