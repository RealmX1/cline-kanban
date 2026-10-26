# 同任务的协作会话

Sessions 的 Create session 提供「协作会话」与 By the way。协作会话使用与「创建任务」相同的可启动 agent 目录和安装状态；可以选不同于主会话的 agent，也可以再开一条相同 agent 的会话。

## 角色与归属

| 角色 | 上下文 | 文件与命令 | 卡片生命周期 |
| --- | --- | --- | --- |
| `main`（旧记录可以省略 metadata） | 既有主会话规则 | 遵循卡片权限 | 主责任入口 |
| `by_the_way` | 保留既有 fresh / fork 限制 | 保留只读限制 | 不自动转审或收尾 |
| `task_collaborator` | 全新上下文，或同 Agent 时复刻当前主会话；用户填写首条消息 | 共用宿主工作目录，遵循创建时权限快照 | 不自动转审或收尾 |

`workspaceTaskId` 标识宿主卡片与工作目录；`taskId` 标识当前会话。协作会话拥有独立的 `task-conversation-session-<uuid>`，不创建第二张卡片。`KANBAN_TASK_ID` 仍指宿主，`KANBAN_TASK_CONVERSATION_SESSION_ID` 指当前会话。原生会话身份、hook 与转录以当前会话寻址。

写权限与生命周期权限分开判断：只读仍由 By the way 角色决定；非主会话统一经 `isTaskConversationSessionWithoutTaskLifecycleAuthority` 排除主卡 checkpoint、转审通知和自动收尾入口。协作提示明确责任边界；它不建立文件写入隔离，也不建立新的 CLI 权限系统。

## 启动与恢复

创建时将有效权限、Plan 起步设置、实际 transport 与会话专属模型配置保存在 metadata 的 `taskConversationSessionLaunchSettings` 中。从全新上下文创建时使用所选 Agent 的默认模型。Claude、Codex、OMP 在选择相同 Agent 且主会话已有可靠原生 ID 时默认复刻当前主会话，也可手动选择全新上下文；已有协作会话或 By the way 不阻止再次创建协作 fork。不同 Agent、身份未就绪或不支持 fork 时禁用复刻并显示原因。

协作 fork 按当前主责任绑定及精确原生 ID 寻址，不使用 cwd-latest；提交期间主绑定或原生身份变化时拒绝陈旧请求。模型跟随源原生会话当前持久化状态，不用卡片旧模型或新会话默认模型覆盖；Claude 复用按 ID 的模型探针，Codex/OMP 沿用原生 fork 继承。OMP 默认沿用主会话的 TUI/ACP 通道。

OMP TUI 的 `plan.defaultOnStartup` 只对空白历史生效，ACP `set_mode` 也只改内存。TUI fork 使用 `--fork <source-id>`；需要 Plan 起步时加载会话专属的托管扩展，在原生模式恢复之前为独立子身份追加 `mode_change` 并 `flush`。扩展使用已核对的原生 `SessionManager` 方法；若后续 OMP 的只读上下文不再暴露这些方法，则明确退出，避免静默投递可写首条消息。ACP fork 核对握手能力，再以返回的新 ID 重播历史并设置本次连接的 Plan 状态；重播沿用恢复守卫，不推进本轮产出时间戳。

本能力复刻的是创建时 harness 可读取的已持久化上下文，不提供任意历史 turn 锚定，也不保证包含仍在生成且尚未落盘的内容。By the way 的既有首次 fork 规则保持。

PTY、ACP 和既有 SDK 通路均保留宿主与当前会话两个 ID。启动返回前持久化 summary；恢复按自身原生 ID 与启动快照寻址。续跑不重投首条消息，也不重新执行 Plan 起步。OMP 协作会话切换 transport 时更新自身快照，不改宿主卡片的通道。

首次 PTY fork 进程崩溃后，自动重启只恢复已观测到的独立子会话原生 ID，不再次 fork 主会话。尚未记录可靠子身份时停止自动重启并显示原因，不按共享目录猜测会话，也不重投首条消息。

单独停止或重启协作会话只影响该会话。停止宿主任务时，运行时枚举全部 transport，停止所有归属于该任务的会话。资源统计归属宿主；关系投影明确识别主会话，投影表版本提升到 2。

RVF 的编辑归属仍按各会话记录；共享 worktree 的全部改动不会自动归入主会话。本功能不迁移跨 agent 历史，不聚合平级会话状态，也不实现完整 Task Force。

## 跨 harness 主会话交接

Sessions 提供「交接主会话」，支持 Claude、Codex、Cursor、Droid、Kiro、Kimi、OMP 之间创建新接任会话。目标选择显示安装状态；Cline 与禁用的 harness 不参与。原主保留为可继续对话的辅线，不交换身份。默认全新上下文＋材料；同任务已有 Claude、Codex、Cursor、Kimi、OMP 可写 peer（包括前主会话）也可接任；当前主会话、By the way、shell 与其他任务不参与。

新建目标有两种上下文方式：默认「全新上下文＋交接材料」，用于重新聚焦；「完整复刻原对话」仅在 Claude/Codex/OMP 同 harness 且可靠原生身份就绪时开放，保留已有 compaction 和偏题内容；跨 harness 只交接材料。OMP fork 保留原 PTY/ACP 通道。旧请求未声明方式时仍为全新上下文。既有 peer 接任始终沿用自身历史、模型、权限与 transport，选择后隐藏新建与 fork 的上下文选项；完整复刻缺少可靠身份时显示原因，不静默降级。

`RuntimeBoardCard.mainTaskConversationSessionId` 是当前主责任的持久权威，缺省回落到卡片 ID。当前角色由绑定派生，创建角色不变；`taskConversationSessionHasHeldMainResponsibility` 持久记录接任历史，因此 A → B → C 后 A、B 都显示「前主会话」。默认消息、生命周期、通知、移列和 checkpoint 跟随当前主绑定；显式选择前主仍可操作它。迟到 hook 只更新自己的 session，旧整板保存不能夺回主责任。Done 工作台保留只读门禁。

双方的原生身份、存储归属及独立启动设置与主绑定一起保存。`startTaskSession` 省略 `workspaceTaskId` 时按 Task 默认入口跟随当前主绑定；显式传入时按 session 寻址。已有 peer 和已准备的 fork 按精确原生 ID 冷恢复，不使用 cwd-latest，也不通过「fork 当前主会话」再次分支。全新目标尚未建立原生对话时安全地全新启动；fork 保留原生模型，不被卡片旧 override 覆盖。

全新目标在首条输入前可能尚无原生 ID。运行时先持久固定目标 Agent、进程代际、工作目录及适用的存储归属；可信原生 hook 带回同代际身份后固定只读接受查询的目标。迟到的旧代际 hook 不得覆盖绑定。Droid/Kiro 没有可靠原生 ID 读取器时，必须同时具备完整正文输入 hook 和同代际后续处理 hook；前置输入、Enter 或活进程均不证明接受。新输入会使旧候选失效，避免跨回合串证。

材料契约在 `src/core/task-main-session-handover-contract.ts`。Claude 采集器保留 ExitPlanMode 成功回执与计划逐字匹配的批准判据。通用采集器复用各 harness 可信历史分页、分段祖先及消息去重，保留内嵌 `<proposed_plan>`、明确计划路径、最后连续非工具正文、需求、阶段目标、git 状态和用户补充；普通历史文本不推断为批准。读取、fork 和补证均跟随 `codexConversationStorageHomeDirectoryPath` 及迁移记录，不能按默认目录猜选。

`task-main-session-handover-material-provider.ts` 提供可替换的 `readUserIntentContext` 端口，返回值绑定 workspace、task incarnation、会话身份、asOf、来源与缺口。默认只组装原始材料；提供方缺失、失败或两秒预算耗尽时明确标注不完整并继续，不增加 LLM 采集。My AI Setup/ac08e 的工作单元意图卷宗尚未发布 CLI＋JSON，本实现预留接入，不调用交互式约束提炼，也不把 L1 Recap 冒充完整意图。

Cursor 使用绑定原生 ID 及工作目录对应的 JSONL 导出，先核对 chat 归属，不打开原始 SQLite；Kimi 复用已核验的 session index、state 与主 agent wire 协议头。缺少导出时保持未知，导出出现或改变后自动补查；Cursor 等待真人的读取也跨重启恢复，机器报告不能自行解除等待。

新建请求为 `new_agent_session`＋`agentId`，既有目标为 `existing_agent_session`＋真实 `agentId`＋`taskConversationSessionId`；`new_codex_session`、`existing_codex_session`、旧记录和旧恢复 API 保持兼容。Claude 通过官方 SDK 固定末消息 fork；OMP 使用原生 `--fork` 冻结副本，并复制、核对原生工具附件。已知子身份先持久化再验证，恢复沿原冻结历史，不夹带失败交接报告。

正文与快照持久保存在运行时 HOME 的 `cross-task-handoff-artifacts/<workspaceId>/task-<taskId>-main-session-handover/<handoverId>/`，包括 `HANDOVER.md`、结构化材料、计划与 transcript 分段快照。原生准备凭据独立保存固定来源、完整回合 ID、每次未知尝试及已知子身份；准备失败后保留原材料，不用新读取结果覆盖固定快照。材料与关键凭据完成持久写入后才推进绑定。

接单时持久固定既有 peer 的归属、原生 ID、工作目录、transport、会话模式与完整独立启动设置，并在材料准备、切主、原生启动与投递前重验。运行时实际持有的空闲活体直接复用，不停止或重启；冷恢复只按该 peer 的原生 ID，并保留自身 exploratory / operational 模式，之前 fork 出的 peer 不再 fork。旧绑定缺少模式快照时沿用 peer 当前记录；旧会话未声明模式时按 operational 兼容，不批量迁移。

来源或目标仍在生成、等待问答、权限或计划审批时，可暂不交接或等待双方可接任；等待跨浏览器关闭和运行时重启保留。完整复刻先固定完成回合、创建独立子身份并持久保存，再校验完整历史与工作目录，最后原子切主。准备过程不启动模型；已知子身份只复验，不重复创建。来源身份或固定边界变化则停止陈旧交接。

首条汇报在 Codex 使用 TUI 原生 `/plan` 命令，其余目标使用各自 Plan 起步设置；共用长粘贴处理，要求只读汇报「计划总览、已经实现、有待进行」，随后等待真人消息。交接及等待期间暂停自动继续、排队投递和自动 RVF/收尾；只有真人输入的实际接受证明解除 hold。Plan 与权限轴独立。

请求 ID、预留目标、投递 attempt 和账本保证幂等。报告提交前固定原生身份、目录和存储归属；接受未知时只读查询原生历史，控制端点不可用则读取可信持久记录，并保存分页进度。完整正文必须逐字一致，兼容原生 `/plan` 消费前缀；只有标记或截断正文不算接受。迟到证明独立于原失败账本保留，复核当前主绑定和原生身份后自动转入等用户，不自动重发模型回合。

`automaticRecovery` 区分机器待证据、执行禁止与人类取舍。同一证据最多三次、至少间隔 15 秒，预算跨重启保留；预算耗尽等待历史、迁移绑定、端点或准备凭据变化。准备阶段确认未启动模型时，可从固定边界有界另建尝试，未知旧尝试继续保留，只有一个目标能取得主绑定。用户 Stop、归属不符或主绑定改变停止对应执行；Stop 不被后台恢复撤销。

仍可显式选择「新建目标 Agent 并重新交接」，确认可能重复汇报后走通用恢复 API。旧 Codex 恢复 API 继续兼容 Codex 记录，不能改变非 Codex 目标。恢复凭据保存原控制记录及预留目标，重复确认复用同一目标；完整复刻恢复沿原固定历史边界创建独立子会话，不改成空白上下文。既有 peer 的显式新建恢复会转换为同一 Agent 的 `new_agent_session`，清除旧 peer 绑定，并明确说明改为全新上下文读取材料。绑定切换后的失败不静默回退到前主。

## 从侧会话分出独立任务

Sessions 的 By the way 与协作会话行提供「分出独立任务」。来源会话继续保留，同一来源可以分出多张卡；前主会话不提供此入口。新卡与来源会话双向链接，关系账本从建卡事件投影 `provenance_split_from_side_conversation_of`，不自动建立子任务关系。投影表版本为 4，固定历史种子不作为匿名来源展示。

上下文与工作树是两项独立选择。默认完整继承来源的原生历史，使用独立的原生 ID、工作目录、hook 与任务生命周期；目前 Codex 使用带完整回合边界的 `thread/fork`，Claude 使用 SDK 的无模型 `forkSession` 固定种子，新任务再从种子 fork。不支持可靠原生分支时明确禁用完整继承，仍可选全新上下文，只提供 Initial Prompt。完整继承保留已有 compaction 和上下文，界面明确提示该取舍。

工作树有三种来源：立即从 local main 新建（默认）；先建 Backlog，等来源任务完成且成果进入 local main 后手动启动，启动时才建树；立即复制来源 Git 工作状态。复制包括 HEAD 与尚未合入的提交、staged、unstaged、非 ignored 的 untracked，保留 index 区分、二进制、重命名、删除、执行位和符号链接。ignored 路径仍使用普通建树规则。快照归档 HEAD 历史与暂存 blob，避免来源清理或 GC 后丢失；不提交、stash、reset 或修改来源工作目录。冲突、子模块或无法安全复制的路径明确拒绝，复制期间发生变化则失败，不使用不完整快照启动。

Backlog 的门禁在服务端，卡片启动、直接 runtime 启动及首次建树都核验。来源需在 Done，工作树及保留补丁没有未落地修改，并通过既有 exact SHA / stable patch-id 共享落地判据；Done、ahead=0 或未观测到自有提交都不能单独证明落地。成功首次授权后持久保存结果，后续恢复不重新依赖来源状态。不新增自动调度或恢复已退役的依赖自动启动。

用户可填写本次分出说明；自动建议同时生成描述建议、标题与必填 Initial Prompt。默认使用 Kanban 模型 API，未绑定用途时选择 DeepSeek 的既有 Flash 浮动模型标识；用途绑定、凭据、用量日志复用现有机制。失败后可显式换 provider、手动填写，或在具备固定种子和启动参数快照的 Claude 来源上选择另开无工具 Agent 分身。分身选项明确提示历史计费成本，不自动回退或重试付费请求。

自动建议使用起点前全部真人输入与最后一轮 Agent 正文，加所选侧会话起点后的全部用户和 Agent 正文，以及本次分出说明；普通工具仅保留原文引用，真人问答答案从工具结果中单独保留。起点前整理接口将来可由 Intention System 替换。缺失材料与 1.5 MB 生成输入上限明确显示，不静默截断。来源回答期间先持久等待，不中断；若已进入后续回合而错过原停止边沿，则要求显式重新固定，不混入后续聊天。

草稿、来源转录快照、原生种子、生成版本及创建记录保存在运行时 HOME 的 `cross-task-handoff-artifacts/independent-task-creation/<workspace-hash>/<requestId>/`，独立于来源 worktree。编辑自动保存，更新草稿与创建才触发描述变更后的模型生成；手改标题和 Initial Prompt 保留，迟到结果不能覆盖新版本。请求 ID 幂等；重启不重放未完成的付费请求或不确定的首次启动，已创建卡保留可恢复入口。

`test/integration/independent-task-creation-real-browser.integration.test.ts` 用隔离 HOME、fixture Git、模拟模型 API、真实 PTY 与桌面/手机浏览器覆盖固定材料、真人答案、手改恢复、三种建树、门禁、多卡与重复创建、运行时重启。设置 `KANBAN_INDEPENDENT_TASK_CREATION_PACKAGED_CLI_PATH`，可用 `KANBAN_INDEPENDENT_TASK_CREATION_BROWSER_EVIDENCE_DIRECTORY` 指定持久证据；浏览器缓存位置经 `PLAYWRIGHT_BROWSERS_PATH` 指定。原生历史分支另有真实 Claude SDK 文件测试与 Codex 协议测试，不调用真实模型。

## 自动化验证

定向运行时测试覆盖角色契约、完整终端 agent 候选、ACP 启动归属和冷恢复、独立权限、混合通道停止、OMP 通道切换、通知与关系归属。前端测试覆盖候选来源、未安装禁用、创建失败保留输入和 By the way 回归。

`test/integration/task-collaboration-sessions-real-browser.integration.test.ts` 使用隔离 HOME、fixture Git 仓库、随机端口、真实浏览器与真实 PTY。测试替身只模拟 agent CLI，不请求模型；矩阵覆盖 Claude → Codex、Codex → Claude，以及 Claude、Codex、OMP 的同 Agent fork（OMP 含 TUI/ACP），验证上下文与模型继承、共享目录写入、独立刷新、浏览器重载、运行时重启与整任务停止。默认跳过，设置 `KANBAN_COLLABORATION_SESSION_PACKAGED_CLI_PATH` 后经 `npm run test:guarded -- --project runtime-integration <测试文件>` 执行；可用 `KANBAN_COLLABORATION_SESSION_BROWSER_EVIDENCE_DIRECTORY` 指定持久证据目录。

真实 agent 的配置与原生身份采集由部署后自然使用验证补充。该验证只读观察现有会话，不启动模型或创建生产测试任务；尚未产生跨 agent 协作会话时如实返回未通过。

`test/integration/task-main-session-handover-coordinator.integration.test.ts` 覆盖持久等待、取消、重启恢复、已有 peer、并发互斥、材料缺失、启动重试与不确定回执。`test/integration/task-main-session-handover-real-browser.integration.test.ts` 验证打包态真实浏览器和 PTY 的新建/已有 Codex 接任、迟到 Claude hook 隔离及精确冷恢复。后者需设置 `KANBAN_MAIN_SESSION_HANDOVER_PACKAGED_CLI_PATH`，可用 `KANBAN_MAIN_SESSION_HANDOVER_BROWSER_EVIDENCE_DIRECTORY` 保存持久截图；隔离 HOME 下可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定已安装的浏览器缓存。构建前须检查 `dist` 和 `web-ui/dist` 是否为共享符号链接；本任务测试使用独立构建目录。


`test/integration/task-main-session-handover-native-codex.integration.test.ts` 使用真实 Codex 和隔离本地模型，验证两种上下文、Plan 首轮、完整原生接受证据、冷恢复及真人继续；设置 `KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY` 与上述打包 CLI 路径启用，可用 `KANBAN_MAIN_SESSION_HANDOVER_NATIVE_EVIDENCE_DIRECTORY` 保存原生分段与结果。不会访问外部模型或用户凭据。
