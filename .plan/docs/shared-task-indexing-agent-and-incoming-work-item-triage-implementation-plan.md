# 共享任务索引、Agent 内核与关系分诊实施计划

状态：PLAN-READY。用户在本任务对话中先批准完整替换计划，再明确要求「Implement the plan」「任务名已改，请开始工作」。本文保存实施合同与恢复入口，不替代原始需求。

## 实施合同

- 能力：持久共享任务 Context、Claude/Codex 无状态执行内核、新工作项关系分诊，以及已有关系编辑器的按需建议。
- 范围：`kanban support get-task-indexing-context`、`triage-incoming-work-item`、执行器配置、独立备注追加、可恢复幂等处置、未分诊 RVF 卡补查。
- 不包含：持久多轮查询会话与 Search 聊天入口（由 `3346b` 承接，合入 `7a1dd` 的需求）；RVF Python 调用接入（另一仓任务）；Task Force fork；自动关闭、改写已有任务。
- 来源：原始 task prompt 与 RVF 接口文档 §5；后续用户要求共享索引可直接作为 Live Agent Context，统一后续查卡内核，并在本卡实现可用后更新承接卡且仅启动 `3346b`。
- 分工：`049a5` 负责分诊流程与 UX；`dd2db` 提供关系词汇和账本；`9cc01` 后续替换 recap 材料生产方；`d36f4` 提供关系编辑器和建议接口。
- 验收：字节稳定前缀、两组重建规则、三种处置、跨项目仅候选、备注不丢失、重试不重复、补查复用已有卡、后台未核验断言不扩大全局权限、两类 headless 执行器及真实 token/cache 证据。
- 接口结果：`relation_candidates[]`、`decision`、可选 `created_task_id` / `linked_task_id`、`as_of`；失败必须明确报错，不能冒充无候选。
- 风险：模型不确定性、上下文/argv 上限、跨文件与 SQLite 的可恢复步骤、已有关系确认来源、CLI 隔离能力差异。
- 验证：guarded 单元/集成测试、根与 Web typecheck、相关 Web 测试及自动化浏览器；隔离 HOME 的假执行器端到端测试；真实 Claude/Codex 最小权限与缓存量测。

## 分片

1. 共享 Context：材料采集、稳定序列化、持久快照与追加增量、TTL/阈值重建、完整度和限额检查；以行为测试起步。
2. 执行内核：独立执行器设置、一次 headless 调用、结构化结果校验、工具/错误拒绝、用量记录。
3. 分诊处置：完整要求候选、三种决策、限定关系映射、备注追加、持久回执与重启恢复；每个写入单独幂等。
4. runtime/CLI 接线与补查：业务写入只经 runtime，自动串行补查与显式命令，已有卡不建第二张。
5. 关系建议接线：用户按需调用，候选选择才入草稿，经现有保存权限边界落盘。
6. 自动化验收、真实模型量测、PDV 登记、持久交接；共享实现可供后续任务使用后更新 `3346b`/`7a1dd` 并启动前者。

## 设计约束

- L0 用途指令 → L1 全板目录 → L2 项目 recap → L3 快照后增量 → L4 查询。Context API 返回 L1–L3，不固定分诊 L0。
- L0–L2 按真实发送字节持久，排序稳定，运行时间、session id、绝对 worktree 路径不得进入稳定前缀。缺失/裁剪必须标记。
- 重建：初次/损坏/版本变化；适用缓存实测下限过期；L3 UTF-8 字节超过 L2 的 25%；快照后完成/丢弃条目超过快照条目数 25%。Codex 同进程缓存下限不能用于宣称新进程缓存仍热。
- 只在同项目、高置信且读取了当前完整要求、有效任务逐项承担工作时压制新卡；跨项目/不完整/不确定均不得压制。
- 关系采用 `reference_concerns_behavior_or_state_of` + `checks_scope_overlap_with`，或一般关联；不新增 duplicate、不写成果覆盖义务。
- 后台身份仅在 support 专用授权分支允许立即写入未核验参照声称；不放开全局 M2，不继承已有用户确认，不绕过否定墓碑。
- 无卡发现不是 work unit：保存完整备注及处置事件，来源能解析为 task 时再写参照关系。
- 幂等键 `(workspaceId, work_item_key)`，预分配新卡身份，持久保存执行步骤；写前核对任务 incarnation/要求指纹。原提示词不改、不自动关闭卡片。
- RVF 新卡只建 backlog、Plan 起步、关闭 auto-review、无父会话 fork；补查排除自身、复用旧卡，凭完成回执排除已处理项。

## 2026-10-20 开工复核

- 草稿位置：本任务上一轮完整替换计划；本文为其实施合同。`MUTATION_ALLOWED=1`。
- 已从 `41ded980` 单向快进吸收本地 `main` `e5b34a4c`，无 WIP、无独有提交；bootstrap receipt 位于 task git-dir，锁已释放。没有 handback/push。
- base 新增 `123e4` 的任务工作台和并发备注合并，接线直接复用；吸收期间 base 未继续推进。
- sibling survey：KANBAN_CLI，367 项，无降级；没有修改或合并其他 worktree。
- 软重叠：`049a5,dd2db,9cc01,ac29f,d36f4,123e4,3346b,7a1dd`。遵守上述分工，不复制其内核。
- `714a4` 活跃 WIP 包含 `src/core/api-contract.ts`、`src/server/workspace-registry.ts` 等共享文件。按用户「执行顺序自行决定」的明确规则，先实现独立模块，暂缓这些文件的接线；接线前再次复核，不合并 sibling 分支。
- 已确认任务名为 `[FEAT,AGENT]看板共享任务索引、Agent 内核与关系分诊`，不再改名。

实现、测试、合入基线、部署、真实可用分别记录；本文的计划状态不代表能力已实现。

## 实施进展与恢复入口（2026-10-20）

- 共享 Context、持久快照/L3、Claude/Codex 执行器、三种分诊处置、原子备注追加、操作回执、后台未核验参照写入、补查与已有编辑器的按需建议已实现于当前工作树；没有提交、推送或部署。
- 相关验证已通过：56 项根单测、29 项 Web 测试、2 项集成测试、1 项真实浏览器测试，以及根/Web typecheck、Biome 和隔离构建。新增补查用例已红测证明「已由新接口建出的卡再次分诊」，随后实现按卡身份读取完成回执及恢复原操作。
- 真实 Codex 大样本：1126 张卡、本项目 468 张，约 711 KB 稳定前缀；两次各 192204 input tokens、cache read 均 0。真实完整关系 schema 验收返回一个正确的完全覆盖候选（5935 input / 200 output）。保持 Codex 独立进程缓存未保证的口径。
- Claude 初次 headless 返回 OAuth session expired；用户随后确认账号封禁，要求标记为暂时无法正式验收。本轮不再请求重新登录或重试真实调用；第二次 cache read 覆盖 L0–L2 的验收不能标成通过。
- 持久证据目录：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-a0401-shared-task-indexing-agent/`。真实模型测量、浏览器截图和独立构建均在其中。
- 已登记 PDV：`f1dae1d2-83f9-4366-81a5-e4a9dd6668b1`（只读 CLI/运行实例契约）、`840fe0e7-cc6f-494e-990e-e1a519b6f939`（真实 UI 按需关系建议）。旧实例 dry-run 正常退出 1，原因是尚无 support 命令，无残留。
- 在线 dist 软链接未被写入。任务自己的 `web-ui/dist` 已改为独立构建目录，运行时产物通过 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY` 写入交接目录。
- `3346b` / `7a1dd` 的原始任务快照已保存为交接目录内 `*-before-handoff.json`；两者仍为 backlog、Plan 起步、默认 agent 未覆盖。完成最终补查回归与源码补丁冻结后，按用户授权更新承接说明并仅启动 `3346b`。

## 最终自动化验证与承接入口

最终 22 项索引/处置单测、增强后的真实 runtime 集成测试、根/Web typecheck、38 文件 Biome 均通过；隔离 runtime bundle 和打包 CLI help 也通过。增强用例验证补查恢复已建卡的原始失败操作，不重新建卡或分析。Web/浏览器在前一轮已经通过，之后未修改 Web 生产行为。

本工作树源码冻结为持久交接目录中的 `source.patch` 与 `source-manifest.json`。`shared-kernel-followup-handoff.md` 保存复用接口与承接职责；`verification-and-pdv-report.md` 保存验收/PDV 状态；后续卡更新和启动的实际结果另存交接回执，不把授权计划写成已发生事实。Claude input/cache 正式验收因用户确认的账号封禁暂不可执行，当前不能宣称该项通过。

## RVF 阶段更新

已再次单向吸收 local main `48e97add`，WIP 无冲突恢复、stash 精确删除、锁 AVAILABLE，没有 handback/push。run `rvf-20261020T200137Z-agentic-initiation-start-bb75e23d` 按 strict 派发，正式覆盖47/47候选，实际有效双评审成立。

四项发现已通过独立 validate/fix 与正式 apply：建议排除自身、UTF-8 流式解码、空白证据不能抑制建卡、最终关系写入绑定分析指纹并持 board 锁至 commit。最后一项第一次 apply 的测试冲突已由新 attempt 在最新内容上协调、重新验证并正式合回；普通 scope 扩展仅 `src/state/workspace-state.ts`。主工作树最终 suites 与隔离构建的结果以当前 run 的 validation cache/handoff 为准，本文不提前宣称通过。

范围外 CLI 异常退出问题已按 RVF 通道提交 backlog `270f0`，由主会话验证、未经独立 validator，本轮不修。3346b 已更新并启动；7a1dd 保留 backlog，需求已交由3346b统一承接。原 `source.patch` 为 RVF 前的历史冻结，审后源码及增量补丁将单独保存，不覆盖原指纹。
