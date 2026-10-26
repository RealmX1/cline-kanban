# Task 上下文生成系统审查与改进方向

审查任务：`cline-kanban/0c114`。日期：2026-10-25。覆盖 Sidebar、Task Agent、独立任务草稿、任务初始正文与 RVF 自动收尾的生成和注入入口；不将渲染测试当成模型已经正确理解语义的证明。

## 结论与本次修改

当前系统没有单一的“所有上下文生成器”。原有共享起草指导覆盖 Sidebar 和 Task，后来加入的独立任务生成服务使用另一份提示词，遗漏了完整的来源、阶段和实际设置指导。现有格式又要求人从 XML 详情开始阅读。两者都是本次源码可直接确认的缺口。

本次统一这些入口的起草指导，要求 Initial Prompt 先写分段 Markdown TLDR，再保留 XML 详情。共享规则、角色说明、独立任务来源记录和 RVF 收尾正文按职责分段；独立任务生成输入先呈现当前范围和已知缺口。标题兜底和任务索引的需求首段提取均跳过开头的 `## TLDR`，避免产生同名卡片或空泛摘要。

本次同时说明 RVF、提交、base 同步的任务与阶段归属，避免把父会话的收尾要求扩成新任务政策。改动不新增授权状态机、语义硬门禁、API 字段或存储迁移，不把全部任务统一改成必须审查或禁止审查。

独立 RVF 进一步确认了模板升级的一个真实恢复入口遗漏：服务会以旧 key 重建新版收尾正文，触发幂等冲突并暂停正常待确认记录。本轮修复服务重入队入口，使其复用原有真实回执；缺账本时只恢复能够证明尚未发送、且正文与不可变证据绑定的旧队列。可能已经发送的条目保持对原 key 的观察，证据恢复后自动接续，不改写失败、不制造新 key 或重复发送。

## 上下文来源与责任

| 生成层 | 源码入口 | 输出及边界 |
| --- | --- | --- |
| 共享起草指导 | `src/core/task-initial-prompt-authoring-and-startup-settings-guidance.ts` | TLDR、原话来源、阶段、实际设置、审查与收尾范围；供各建卡入口复用 |
| 命名与阶段目标 | `src/core/task-naming-conventions.ts` | 稳定标题及当前阶段目标；阶段目标不是授权状态 |
| Sidebar / Task 根上下文 | `src/prompts/append-system-prompt.ts` | 当前角色、共用指导、工作区与 CLI 参考；角色限制不能越界继承 |
| PTY / ACP 注入 | `src/terminal/agent-session-adapters.ts`、`src/acp-client-session/acp-task-session-service.ts` | 按 transport 注入既有指导；续跑与 fork 是否刷新受原生恢复和启动快照约束 |
| 独立任务草稿 | `src/independent-task-creation/independent-task-creation-service.ts` | 外层仍输出 `suggestedTaskDescription`、`title`、`initialPrompt` JSON；两种生成来源使用同一指导 |
| 独立任务来源材料 | `src/independent-task-creation/conversation-context.ts` | 来源角色、引用及正文；持久化旧段落原样兼容，工具结果仅引用，不伪装已读 |
| 共享任务索引 | `src/task-indexing-support/shared-task-indexing-context.ts` | 将需求首段投影到 L2 摘要；固定 TLDR 标题不能被当作需求内容 |
| RVF 自动收尾 | `src/rvf-automatic-closeout/rvf-automatic-closeout-prompt.ts`、`src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service.ts` | 正文只针对绑定的 task/token/run/handoff；服务重入复用原回执与冻结正文，避免模板变化重放旧 key |
| 仓库、技能与原生历史 | `AGENTS.md`、所用 skill、原生 transcript/启动参数快照 | 各有作用范围；不是通过 user-role 传递就全部变成人类逐字指令 |

生成与存储仍是不同职责：CLI/API 接收 `prompt:string`，不负责证明文本忠实于用户意图。引用、标签与哈希可以验证结构或身份，不能证明人类批准了 Agent 新增的限制。

## 历史 RVF 误导：已证实与未证实的部分

既有任务 `7c11a` 已针对该问题调查并实现共享指导，对应提交 `12f743e565b4b4e4e13f8efe642f09f4b0928623`。本次重新读取其任务定义、调查报告和可见证据索引，并直接核对仍保留的决策 token。

| 事实 | 证据 | 判断 |
| --- | --- | --- |
| `e9e12` 的起草稿新增“RVF 在此指被分析的系统，不是授权你新开一次产品实现 RVF review” | 既有证据索引 A01、A03、A10、A11 对照来源请求、起草参数和实际投递 | 原始需求与 Agent 展开没有清晰区分，禁令缺少明确阶段范围 |
| 用户后续批准实施，执行者仍把上述措辞延续到收尾 | A04—A09；token `73f47a7a215e40d9` 当前保留 `state=declined`、`decline_kind=structural_not_needed`，理由仍引用该限制 | 至少这个案例确有阶段解释偏差；不能归咎于 start/checkpoint 技术门禁 |
| 用户同时质疑未审查就先提交 | A09 的可见纠正消息；既有报告区分了提前 commit 与后来 decline 的时间 | 提交问题发生更早，不能把后来谢绝审查当作它的唯一原因 |
| 父会话此前正在执行 rvf-land 与 base-branch-sync | A02；正常对照 C01—C06 | 父阶段的局部要求存在，但“它直接导致新增禁令”在原调查中仍是未证实假设 |
| “直接提交并同步 base、没有 RVF”是否是同一个案例的完整执行结果 | 本次没有找到同等强度的该组合事件证据 | 保持未证实；不把用户记忆、文本中提及同步或已提交的事实拼接成同步成功 |

历史证据入口（均为持久路径）：

- `/Users/bominzhang/.cline/kanban/task-handoff-artifacts/7c11a/task-prompt-intent-drift-investigation/investigation-report.md`
- 同目录 `visible-causal-chain-evidence.json`：只摘录必要可见消息与工具事实，含原始路径、时间和行号。
- `/Users/bominzhang/.rvf/agentic-initiation-decision-tokens/73f47a7a215e40d9.json`
- 本次读取的任务快照及同仓改动快照：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-0c114-task-context-generation-review/`。

历史研究阶段报告中的“未实施”只描述当时状态；不能覆盖随后提交 `12f743e5` 的实施事实。类似地，本次修改共享指导不等于能改写旧原生历史、旧 handoff 或旧 token。

## 后续更新方向

| 优先级 | 具体增量 | 验收与权衡 |
| --- | --- | --- |
| 高 | 增加只读的“实际生成输入预览”，展示各片段的来源、角色、目标任务、实际 transport、内容哈希和取得时间；复用已有启动快照及持久草稿，不另建全文存储 | 人能核对真正发送的文本；旧会话取不到快照就标 unknown，不能拿当前 renderer 冒充历史输入。注意只导出必要正文、不输出凭证 |
| 高 | 将历史案例整理为固定语义评测集，覆盖父会话 land→新任务、研究→获准实施、明确禁止 RVF 的对照、用户仅说 continue、fork/resume/compaction、来源缺失 | 自动化驱动模型并只检查可见输出和实际动作；记录模型、指导版本与样本结果。当前渲染与桩测试只能证明接线，不能给出模型误报率 |
| 中 | 对原始请求、草稿和当前设置做只提示的差异检查，指出新增禁止、义务、阶段词丢失和设置覆盖；从 shadow 观察起步 | 按正文和设置哈希失效缓存，覆盖 create→update→start。模型不可用时保留“未检查”，自主补证，不统一阻塞或强制人工确认 |
| 中 | 为来源、阶段及审查覆盖提供独立可查视图；补证时分别查询历史完成、当前候选覆盖和执行资格 | 复用关系账本与 RVF 历史接口；状态缺失保持 unknown，并持久保存恢复条件、有界重试和进度。避免把阶段目标字符串升级为授权凭据 |
| 中 | 继续扩大模板升级与旧正文恢复的原生实证矩阵，优先复用首次入队文本、摘要及身份绑定 | 本轮已覆盖压缩确认接管和服务重入队的回归；仍应扩大真实原生实例矩阵，不能让新版模板否定旧接受事实或触发重复发送 |
| 低 | 继续精简长英文 CLI 参考与重复说明，按用途提供中文摘要和详细引用 | 降低常驻上下文长度；须先确认各 harness 的工具发现能力，避免删掉唯一可用命令说明 |

这些方向是本次审查建议，不代表已获准实现新的模型调用、授权存储或产品门禁。本次优先修复可直接证实的入口缺口与阅读、作用范围问题。

## 验证与并行工作边界

定向验证覆盖两个生成来源实际收到的共享指导、旧来源段落兼容、当前范围优先展示、原话引用保留、TLDR 标题兜底和 L2 需求摘要，以及原有 PTY/ACP、原始 Prompt 展示和 RVF 收尾生命周期回归。真实模型是否持续遵守来源与阶段语义仍须单独观察。

只读快照识别到 `1586d` 在修改同一个独立任务服务文件，实际改动位于会话交接资格判断，与本次生成提示词和上下文组装不在同一处。`9674c`、`e2dfc` 为非活跃文件重叠；没有把它们的分支或 WIP 合入本任务。

```text
SIBLING_TASK_SURVEY=VERIFIED
TASK_INVENTORY_SOURCE=KANBAN_CLI
SIBLING_TASK_COUNT=452
SOFT_OVERLAP_TASK_IDS=9674c,e2dfc
HARD_COLLISION_TASK_IDS=1586d
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
```
