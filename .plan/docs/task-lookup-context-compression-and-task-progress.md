# 查卡 Context 压缩与任务元信息实现合同

状态：已按用户批准范围实施；未提交、未同步、未部署。部署后真实实例断言独立待验。

## 目标与验收

- 查卡先按 scope 构建全范围轻索引，全局选择 0–10 个候选后只读取 Session Intent；不发送完整 Initial Prompt、任务正文、全局 recap、追加变化和完整身份名单。
- 轻索引默认以 256 KiB 为材料预算分批；已知上下文拒绝有界收缩，失败批次和覆盖范围可观察、可持久核对。
- 独立 `taskDescription` 与 Task Name 并列，描述需求、范围与当前方案，保留 Initial Prompt。
- 将阶段目标展示升级为 Task Progress：增量完成或放弃上一条，再追加当前进展。原生 To-do 继续作为执行计划，不新增第二套 To-do。
- 计划完成、开始实施时必须核对名称并更新简介；后续更新 Progress 时提示按目标、范围或方案变化同步元信息。
- 保留旧卡、旧阶段目标、命令和限定任务身份兼容；原始材料及查询历史继续持久保存。
- 查卡自身的历史回读进入回答；候选会话意图分片累计保留修正和排除证据。短任务编号可直接搜索，补读和会话读取失败保留真实缺口。

## 已确认边界

- Description 沿用 cline-kanban/97136 的独立字段定义；所有实现留在本任务工作树。
- 不提交、不同步 base、不部署；实施授权不包括这些操作。
- 用户补充：检索缺口按内容而非会话角色划分，也包括主 Session 中与 Task Description 无关、但与查询相关的讨论；不只指 Peer Session / By the way。未来结合会话转录的直接搜索与 Embedding + RAG，定位到原文片段；明确不属于本次 scope。
- Task Force 启发式触发、分身汇报和自动 Rewind 仅记录后续接点，对应 Linear REA-29、REA-28，不作为本次依赖。

## 实施切片与验证

1. 轻索引、范围过滤、候选引用映射、0–10 个候选的 Session Intent 来源、预算分批及历史压缩；先写纯函数和服务行为测试。
2. Description 的契约、状态、CLI 与共用创建／编辑窗口；覆盖保留原文和并发字段合并。
3. Progress 的会话归属、增量接口、幂等与持久化、旧目标回退和展示；覆盖跨重启与身份变化。
4. 根与 Web 类型检查、定向 guarded 测试、隔离构建与自动化浏览器验证；注册真实部署实例的待验断言。

## 已证实的基线

2026-11-06 的失败轮输入为 1,291,034 字节，超过本地 1,200,000 字节门禁；无历史。L1 225,776 字节，L2 722,693 字节，L3 142,399 字节，重复身份名单 197,992 字节。原始记录在 runtime home 的 `task-lookup-conversations/9d663996-6b2b-4fc1-9a46-4d1cf0fa79e2/369eb80f-4668-4229-be04-4f79ff72e888-recall-input.json`，调查没有修改原记录。

## 实施结果与证据入口

- Context 结构树与分级读取合同：`docs/architecture/task-lookup-conversations-and-workbench.md`。
- Description / Progress 的字段、Agent 维护协议、并发与旧数据语义：`docs/task-description-and-work-progress.md`；Task Status 仍指看板列。
- 同一冻结记录的离线预算回放覆盖 1,482 张卡：已知首段组最大文本输入 264,539 字节；775 张卡的未知首段按 120 个中文字符补足后最大 264,180 字节。未调用真实模型，不证明召回率；原始冻结文件哈希未变。
- 全部持久验证日志和预算数据位于 `/Users/bominzhang/.cline/kanban/task-validation-artifacts/122de/`；交接报告位于 `/Users/bominzhang/.cline/kanban/task-cross-task-handoff-artifacts/122de/implementation-and-validation-report.md`。
- Task Force / 启发式分身汇报已追加到 Linear REA-29；未来自动 Rewind 的持久确认与授权边界已追加到 REA-28。本次不实现这些编排或 Embedding / RAG。
- 部署后注册 3 项自动脚本、0 项人工项；旧实例 dry-run 均明确未通过，原因是新功能未部署或自然样本缺失，无崩溃、超时或测试任务残留。注册不等于正式验证通过。

## 用户修正（2026-11-07，当前有效）

用户明确要求：「第一阶段选最多10个，最少不限(可以为0); 然后阅读 session intent」，并限定材料为用户输入、AskUserQuestion 问答和每轮最后一次 Agent 答复。候选完整 Initial Prompt／任务正文补读已从本次合同中删除，旧版三层方案和旧源码验证只作为历史。

- 第一阶段覆盖范围内所有轻索引，归并后最多 10 个；第二阶段仅从可信持久主会话提取允许的消息，没有简介或会话来源时保留未知，不回退全文。
- 未来 Intent System 可以替换当前来源；内容查询单独委派 agentic search with script（grep）+ Embedding/RAG，本次不实现。
- 返回前的身份／范围／概况版本核对是服务端一致性门禁，不是第三阶段检索。
- 新验收覆盖：0 与 10 上界、只对所选候选读取、模型输入不含任务全文／recap、跨页问题与答案／末次答复、缺口与自动重读、取消和历史兼容。
