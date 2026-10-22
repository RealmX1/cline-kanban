# 共享任务 Context、无状态 Agent 与新工作项关系分诊

本功能属于 task `a0401`。共享索引可以直接成为后续 Live Agent 的 Context；持久多轮查询会话、集中查卡入口和 Search 接口由 `3346b` 承接（包含 `7a1dd` 的需求）。本模块不保存模型对话，不使用 resume/fork。

## 对外接口

所有命令的 `--project-path` 都指已注册项目的主仓路径。业务写入经 runtime procedure，运行实例不支持该接口或不可达时明确失败。

```sh
kanban support get-task-indexing-context --project-path /path/to/main-repository
kanban support get-executor-settings --project-path /path/to/main-repository
kanban support configure-executor --project-path /path/to/main-repository --agent-id claude --model-id <model>
kanban support triage-incoming-work-item --project-path /path/to/main-repository --work-item-file /persistent/path/finding.json
kanban task append-comment --project-path /path/to/main-repository --task-id abc12 --comment-file /persistent/path/comment.txt --comment-id finding-reference-123
kanban support backfill-untriaged-rvf-findings --project-path /path/to/main-repository
kanban support get-backfill-status --project-path /path/to/main-repository
```

执行器支持 `codex`、`claude`，未配置时默认 `codex`；显式保存的执行器选择保持不变，省略 model 时使用该 harness 的默认。执行器设置独立保存，和新卡将来运行的 agent 无关。CLI 等待大 Context 完整刷入 stdout 后才返回，避免管道截断。

`get-task-indexing-context` 不调用模型、不修改任务或关系。它维护可丢弃的 Context 缓存，返回 `levelOneBoardTaskIndexText`、`levelTwoProjectTaskRecapsText`、`levelThreeAppendedChangesText`、`snapshotFingerprint`、`contextCompleteness`、`asOf` 和可空的 `rebuildReason`。L0 指令由消费者决定，不能把分诊专用指令当成通用查卡指令。

共享执行器 `executeStatelessTaskIndexingAgent` 接受独立的指令、共享 Context、查询、Zod 输出 schema，以及执行器设置。关系分诊与关系编辑器建议共用 `analyzeIncomingWorkItemRelations`，后续职责替换 L0/L4 即可。`9cc01` 后续可替换 recap 生产方，无需另造索引或执行器。

## RVF 工作项 schema v1

权威 schema：`src/core/task-indexing-support-contract.ts`。RVF 架构文档 §5 规定行为与输出字段，没有完整 wire JSON schema；此处固定第一版传输形状。

```json
{
  "schema_version": 1,
  "work_item_key": "rvf-finding-fingerprint-sha256",
  "title": "[RVF 发现]某项可复现的问题",
  "prompt": "KANBAN_TASK_ORIGIN=rvf_validated_out_of_scope_finding\nKANBAN_SUPPORT_AGENT_RELATION_TRIAGE_STATUS=not_triaged\n\n完整问题、证据、验证状态与来源。",
  "origin": "rvf_validated_out_of_scope_finding",
  "evidence": ["src/example.ts:42"],
  "creation_settings": { "agent_id": "codex", "base_ref": "main" }
}
```

- 必填：`schema_version`、`work_item_key`、`title`、`prompt`。
- 可选：`origin`（默认 `other`）、`evidence`、`source_task`、`existing_finding_task`、`creation_settings`。
- task 引用必须含 `workUnitType: "kanban_board_card"`、`workspaceId`、`taskId`、`taskIncarnationCreatedAtEpochMs`。发现本身不伪造为 work unit。
- `(workspaceId, work_item_key)` 是幂等键；同键不同工作项拒绝覆盖。来源字段不代替正文中的真实验证状态。
- RVF 新卡只建 backlog，Plan 起步、关闭 auto-review、不启动会话、不 fork 父会话。通用工作项的 Plan 起步按项目默认或显式设置。

成功结果包含 `relation_candidates[]`、`decision`、`as_of`、`operation_id`，以及相应的 `created_task_id` / `linked_task_id`：

| decision | 业务动作 |
| --- | --- |
| `linked_to_existing_task` | 同项目、高置信、当前完整要求明确承担全部新工作时，向已有任务追加完整关联发现，不建新卡 |
| `created_task_with_possible_relations` | 部分重叠或不确定时建卡，并追加带候选和理由的备注 |
| `created_task_without_relations` | 没有候选时正常建卡 |

候选包含限定任务引用、两种允许的参照关系 kind、`confidence`、`coverage`、`rationale`、`evidence`、`cross_project`。跨项目始终仅为候选，不用于抑制建卡或自动写关系。标题相似、Done 列和 agent 自称完成都不能构成完全覆盖证明。L4 提供 fuzzy 排序前十个同项目有效候选的当前完整要求；模型发现的其他候选缺少完整要求时不能抑制建卡。

失败以非零 CLI 退出码和结构化 `error` 返回。模型错误不映射为空候选；部分业务写入失败会报告可追踪的 `operation_id` 和已完成步骤。

## 分层、持久化与缓存

- L0：版本化用途指令。
- L1：全看板极简目录，含 project/id/title/column。
- L2：本项目标题、有效 prompt 首段、已有通知摘要、hook finalMessage、可读取的 Claude away summary。
- L3：快照后所有相关字段变化，按稳定顺序追加；最新字段覆盖快照。持久记录最近材料，重启比对后补齐变化。
- L4：本次查询、证据、当前限定身份和候选完整要求。

L0–L2 不加入运行时间、session id 或绝对 worktree 路径，源材料中的这类文本转换为稳定引用并标明完整度；完整要求留在 L4。每个 recap 来源最多 12000 字符，裁剪显式标记。缺失材料不能冒充完整证据。

Context 按 project / agent / model 字面值 / 用途指令版本分桶，真实发送的前缀文本和 hash 持久保存。以下任一成立时重建：

1. 初次、缓存损坏、指令/设置变化。
2. 距前次模型请求超过适用的实测保持下限。复用现有 TTL 表；Codex 的下限只适用于同进程，独立 headless 调用不据此宣称缓存仍热。
3. L3 UTF-8 字节超过 L2 的 25%。
4. 快照后完成或删除的本项目条目超过快照条目数 25%；已经处于 Done 的历史条目不重复计入陈旧变化。

超过实测下限是重建策略，不是服务端缓存已经消失的证明。读取 Context 不计为模型请求。输入预算当前为 1200000 UTF-8 字节，超限明确失败；Claude 大前缀通过 `--system-prompt-file` 传入相同字节，避免 OS 单个 argv 限额。特定模型仍可能有更小的 context 上限，provider 拒绝会如实返回。

缓存、执行器设置、操作回执和补查结果位于对应 workspace 的 `task-indexing-support/` 目录。模型用量复用 `model-provider-usage` journal，记录 input/output、cache read/write、前缀 hash、模型（CLI 未提供已解析模型时为 null）、耗时和结论。

## 最小上下文执行与关系权限

Claude 使用 safe mode、替换系统指令、空工具、严格空 MCP、禁 skills/commands、无会话持久化；不用 `--bare`，保留订阅 OAuth。Codex 使用 ephemeral、忽略用户配置/规则、替换模型指令、隔离工作目录、只读 sandbox，并关闭可配置的 shell、MCP、hooks、skills、插件、apps、code-mode 和多 agent 能力。两者保留原认证位置，清除宿主任务身份。Codex 没有通用的零工具 schema 保证，不能据此声称没有任何原生协议开销。

输出必须满足 schema、完整成功回合和已知身份；真实工具条目拒绝采用。Codex 会把主动禁用 code-mode host 的明确 fail-closed 提示编码成 error 条目，该已知诊断保留为 `diagnosticWarnings`，其余错误拒绝采用。配置形状依据[官方 Codex config schema](https://developers.openai.com/codex/config-schema.json)及本机 CLI 解析验证。

关系采用 `reference_concerns_behavior_or_state_of` + `checks_scope_overlap_with`，或 `reference_is_generally_related_with`；不新增 duplicate 或义务覆盖关系。runtime 内部 support 专用策略使用 `M2_TASK_INDEXING_SUPPORT_UNVERIFIED_REFERENCE_ONLY`，policy version 2；通用 M2 仍不开放。关系立即可见但只表示未核验声称，没有义务副作用，不伪造用户手势或端点 agent 身份。

已有关系的确认属于原声称：新 support 发现不合并进去继承确认，而保存于自己的备注/处置事件。用户全局拒绝墓碑和 agent 的建议方抑制范围都继续生效。

## 幂等、补查与权限边界

分诊在持久操作锁内预分配新卡身份，先保存步骤意图，再执行各自幂等的建卡、备注、关系与处置事件。board JSON 和账本 SQLite 不是单事务；回执保留已开始、已完成步骤以供崩溃恢复。候选 incarnation、要求或所在列变化时拒绝过时写入；尚无步骤开始时清除旧分析，下一次调用重新分析。

备注在 board 锁内追加到最新卡片，显式/确定性 id 防止重复；原 prompt 不改，不关闭、停止或删除已有任务。即使不建卡，完整发现也留在备注及幂等的账本处置事件中；来源 task 可解析时再写参照关系。

runtime 上线后异步串行扫描既有 `[RVF 发现]` 卡，要求 prompt 前两行精确匹配 origin 与 `not_triaged`。补查排除自身，复用原卡，完全覆盖时原发现卡也保留；不改 marker，按卡的限定身份查找完成回执，连已由新接口建出的卡也不会再次分诊。回执保存原始工作项，补查可恢复已经建卡但后续步骤未完成的原操作。命令可显式重试，状态文件报告每卡结果。

关系编辑器只在用户点击「获取关系建议」时调用模型。加载、不可用、零候选与失败分开显示；选择候选才加入草稿，最终写入仍经过原有用户确认保存流程。RVF Python 侧的 `INTEGRATION-POINT(kanban dedicated support agent finding-relation triage)` 调用接入仍由另一仓任务完成。

## 2026-10-20 实测状态

隔离 HOME、真实 board/账本和 headless 桩已覆盖三种处置、重启重试、旧卡补查、单方未确认、确认来源不继承和否定墓碑。相关 Web 测试覆盖按需建议与选择后入草稿。

真实样本：1126 张卡，本项目 468 张；约 711 KB 的稳定前缀。Codex 两次独立调用均成功，input 各 192204 tokens、output 各 15 tokens、cache read 均为 0，前缀 hash 相同。因此不宣称 Codex 无状态调用具备热缓存复用。

Claude 初次请求返回 OAuth session expired；用户随后确认 Claude Account 被封禁，并要求相关工作标记为「暂时无法正式验收」。本轮不再请求重新登录或重试真实 Claude 调用，尚未取得 Claude input/cache 验收证据。持久测量入口为 `.plan/scripts/measure-shared-task-indexing-headless-context.mts`，证据目录位于本任务 cross-task handoff artifacts。实现、测试、合入、部署与真实可用分别记录，以上不代表已部署。

## 本轮 RVF 修复

已有卡的关系建议会跳过自身候选，保留其它合法候选；分诊/补查仍严格拒绝自身。证据先 trim 并过滤空白，完全覆盖选择器也检查有效证据，空字符串或空数组不能抑制建卡。

headless stdout 使用流式 UTF-8 解码，并按原始字节计算输出预算，避免跨 chunk 的中文理由或证据损坏。

关系写入沿操作回执、effect、runtime 传递分析时的端点要求指纹；最终 support 写入口在与 board mutation 共用的锁内复查两端 incarnation/要求，并保持锁直到 ledger commit。共用锁的只读 board 回调位于 `src/state/workspace-state.ts`；正常用户关系写入权限不改变。
